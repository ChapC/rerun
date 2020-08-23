import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {ContentRenderer} from './renderers/ContentRenderer';
import {ContentTypeRendererMap, RerunStateObject} from '../index';
import {IntervalMillisCounter} from '../helpers/IntervalMillisCounter';
import {MultiListenable} from '../helpers/MultiListenable';
import PrefixedLogger from '../helpers/PrefixedLogger';
import { WSConnection } from '../helpers/WebsocketConnection';
import ControlPanelHandler, { ControlPanelRequest, ControlPanelListener } from '../ControlPanelHandler';
import { mediaObjectFromVideoFile } from "../contentsources/LocalDirectorySource";
import fs from 'fs';
import { mediaObjectFromYoutube } from "../contentsources/YoutubeChannelSource";
import { ScheduleChange as QueueChange } from './QueueChange';
import PlaybackContentNode, { NodePlaybackStatus } from './PlaybackContentNode';
import ContentRenderTrack from './renderers/ContentRenderTrack';
import RendererPool, { PooledContentRenderer } from './renderers/RendererPool';
import RenderHierarchy from './renderers/RenderHierarchy';
const colors = require('colors');
const uuidv4 = require('uuid/v4');

/* Events
*   - "activePlaybackChanged": The list of active ContentBlocks changed.
*   - "queueChanged": The queue was updated. EventData contains the new queue.
*/
@ControlPanelListener
export class Player extends MultiListenable {
    private readonly maxPreloadedBlocks = 6; //The maximum number of blocks that will be preloaded into renderers in advance
    private readonly playerTickRateMs = 100;

    private log: PrefixedLogger = new PrefixedLogger("Player");
    private readonly playerTickInterval: NodeJS.Timeout;
    private nodeIdCounter = 0;
    private defaultBlock: ContentBlock;
    private rendererPool: RendererPool;
    private renderHierarchy: RenderHierarchy;

    constructor(rendererPool: RendererPool, renderHierarchy: RenderHierarchy, private rerunState: RerunStateObject, defaultBlock: ContentBlock) { //TODO: Remove rerunState parameters in favour of specific dependencies
        super();
        this.rendererPool = rendererPool;
        this.renderHierarchy = renderHierarchy;
        this.defaultBlock = defaultBlock;

        //Use the default block to jump start the playback tree
        this.jumpStartWithDefault();

        //Start the player evaluation loop
        this.playerTickInterval = setInterval(() => this.evaluatePlaybackFront(), this.playerTickRateMs);
    }

    shutdown() {
        clearInterval(this.playerTickInterval);
        this.playbackFront.forEach((node, index) => this.stopAndClosePlayingBranch(index));
    }

    /*
        Playback tree notes:
        - "active node" means a node that is in the "queued", "transitioning" or "playing" state. An inactive node is one in the "finished" state.
        - the playback tree is mostly abstracted from the user. They only have direct access to the tree starting at the first node in the playback front.
          This is presented to the user as a queue that is obtained by traversing the first node's tree by the 0th child until the end of the tree.
    */

    private playbackFront: PlaybackContentNode[] = []; //List of the 'front' of active nodes. These are the shallowest active nodes in each branch
    private activeTracks: Map<number, ContentRenderTrack> = new Map(); //Maps a node on the playbackFront (by ID) to the track it's being played on
    private preloadedNodes: Map<number, PooledContentRenderer> = new Map(); //Maps a queued node (by ID) to a renderer that it's been preemptively loaded into before playback
    private nodeTreeMap: Map<number, PlaybackContentNode> = new Map(); //Maps a node (by ID) to a node in the tree

    private queuedTickActions: Map<string, (() => void)> = new Map(); //Actions queued to run at the start of the next tick

    //Called every player tick, monitoring the playbackFront and maintaining the playback tree
    private evaluatePlaybackFront() {
        //Process any queued actions
        this.queuedTickActions.forEach(action => action());
        this.queuedTickActions.clear();

        //Check on the status of each node on the playback front
        for (let i = this.playbackFront.length - 1; i > -1; i--) {
            let activeNode = this.playbackFront[i];
            if (activeNode.getPlaybackStatus() == NodePlaybackStatus.Playing) {
                //Check if this node has finished yet
                let currentPlaybackTimeMs = Date.now() - activeNode.getPlaybackStatusTimestamp();
                if (currentPlaybackTimeMs >= activeNode.block.media.durationMs) {
                    //The node has finished playback
                    this.log.info(`"${activeNode.block.media.name}" finished playback`);
                    
                    let activeNodeTrack = this.activeTracks.get(activeNode.id);
                    if (activeNode.block.transitionOutMs == 0) {
                        //This node has no out transition, it can be ended right away
                        activeNode.setPlaybackStatus(NodePlaybackStatus.Finished);

                        //Remove this node from the renderer hierarchy
                        let currentRenderLayer = this.renderHierarchy.getLayerIndex(activeNodeTrack.activeRenderer);
                        this.renderHierarchy.removeRenderer(activeNodeTrack.activeRenderer);
                        //Stop the renderer
                        activeNodeTrack.activeRenderer.stop().then(() => {
                            //Check if there's anything queued for playback after this node
                            if (activeNode.children.length > 0) {
                                //The first child of this node will inherit the parent's resources (same track, same renderer if compatible)
                                let firstChild = activeNode.children[0];
                                this.playbackFront[i] = firstChild; //Inherit playbackFront position
                                activeNodeTrack.activeBlock = firstChild.block; //Inherit track
                                //Update the track map to have firstChild as the key
                                this.activeTracks.delete(activeNode.id);
                                this.activeTracks.set(firstChild.id, activeNodeTrack);

                                //Check if this node has been preloaded
                                if (this.preloadedNodes.has(firstChild.id)) {
                                    //Yay, it has! Chuck the old renderer and use the preloaded one
                                    activeNodeTrack.activeRenderer.release();
                                    let preloadedRenderer = this.preloadedNodes.get(firstChild.id);
                                    this.preloadedNodes.delete(firstChild.id);
                                    activeNodeTrack.activeRenderer = preloadedRenderer;
                                } else {
                                    //Not preloaded :(
                                    //If the old renderer supports this content type, we'll load it into that one in a sec.
                                    //Otherwise, we'll need to grab a new one
                                    if (activeNodeTrack.activeRenderer.supportedContentType !== firstChild.block.media.location.getType()) {
                                        activeNodeTrack.activeRenderer.release();
                                        activeNodeTrack.activeRenderer = this.rendererPool.getRenderer(firstChild.block.media.location.getType());
                                    }
                                }

                                this.startTrackPlayback(activeNodeTrack, firstChild, currentRenderLayer);
                                //Try preloading descendants of this node
                                this.preloadTrackChildren(activeNodeTrack, this.maxPreloadedBlocks);

                                //Any other children will be started on new tracks on top of the activeNodeTrack
                                this.launchNewTracksForNodes(activeNode.children.slice(1), activeNodeTrack, true);
                            } else {
                                //There's nothing queued after this node
                                this.stopAndClosePlayingBranch(i);
                            }

                            if (this.playbackFront.length == 0) {
                                this.log.info(`Nothing queued - defaulting to "${this.defaultBlock.media.name}"`);
                                this.jumpStartWithDefault();
                            }
                        });
                    } else {
                        //This node will now start an out transition (eg. fade out), so its track needs to keep playing for a bit.
                        let activeRenderer = this.activeTracks.get(activeNode.id).activeRenderer;
                        activeRenderer.stop().then(() => activeNode.setPlaybackStatus(NodePlaybackStatus.TransitioningOut)); //Starts the out transition
                        //While that happens, we'll start any child nodes on new tracks underneath it
                        if (activeNode.children.length > 0) {
                            this.launchNewTracksForNodes(activeNode.children, this.activeTracks.get(activeNode.id), false);
                        }

                        if (this.playbackFront.length == 0) {
                            this.log.info(`Nothing queued - defaulting to "${this.defaultBlock.media.name}"`);
                            this.jumpStartWithDefault();
                        }
                    }

                    this.queuedTickActions.set('activePlaybackEvent', () => this.fireEvent('activePlaybackChanged', this.getPlayingBlocks()));
                    this.queuedTickActions.set('queueChangedEvent', () => this.fireEvent('queueChanged', this.getQueue()));
                } else {
                    //TODO: Process any children with relative events - this can be optimized by having the node cache these events AND ensuring we only do one lookup per SECOND (can also be managed by the node?)
                }
            } else if (activeNode.getPlaybackStatus() == NodePlaybackStatus.TransitioningIn) {
                //Check if the node has finished transitioning in
                let transitionProgressMs = Date.now() - activeNode.getPlaybackStatusTimestamp();
                if (transitionProgressMs > activeNode.block.transitionInMs) {
                    this.log.info(`"${activeNode.block.media.name}" finished transitioning in`);
                    //Switch to playing
                    activeNode.setPlaybackStatus(NodePlaybackStatus.Playing);
                }
            } else if (activeNode.getPlaybackStatus() == NodePlaybackStatus.TransitioningOut) {
                //Check if the node has finished transitioning out
                let transitionProgressMs = Date.now() - activeNode.getPlaybackStatusTimestamp();
                if (transitionProgressMs > activeNode.block.transitionOutMs + 100) { //I'm giving out transitions 100ms extra time to get off screen. It'd be cooler if the player was more accurate, but I'm not that talented
                    //|._.| it is done.
                    this.log.info(`"${activeNode.block.media.name}" finished transitioning out`);
                    activeNode.setPlaybackStatus(NodePlaybackStatus.Finished);
                    this.stopAndClosePlayingBranch(i);
                    this.queuedTickActions.set('activePlaybackEvent', () => this.fireEvent('activePlaybackChanged', this.getPlayingBlocks()));
                    this.queuedTickActions.set('queueChangedEvent', () => this.fireEvent('queueChanged', this.getQueue()));
                }
            } else { //activeNode isn't actually active (it's finished or queued)
                this.log.warn('A node on the playback front is in a bad state', activeNode);
                //Remove that node, I guess? This really shouldn't happen
            }
        }
    }

    //Starts playing a track's current playback block and adds it to the render hierarchy
    private startTrackPlayback(track: ContentRenderTrack, playingNode: PlaybackContentNode, renderIndex: number) : void {
        let addToHierarchyAndPlay = () => {
            this.renderHierarchy.insertRenderer(track.activeRenderer, renderIndex);
            track.activeRenderer.play().then(() => {
                if (track.activeBlock.transitionInMs > 0) {
                    playingNode.setPlaybackStatus(NodePlaybackStatus.TransitioningIn);
                } else {
                    playingNode.setPlaybackStatus(NodePlaybackStatus.Playing);
                }
            });
        }

        if (track.activeRenderer.getLoadedMedia() != track.activeBlock.media) {
            track.activeRenderer.loadMedia(track.activeBlock.media).then(addToHierarchyAndPlay);
        } else {
            addToHierarchyAndPlay();
        }
    }

    //Create a new track for a list of nodes and start playback for each
    private launchNewTracksForNodes(nodes: PlaybackContentNode[], relativeToTrack?: ContentRenderTrack, insertAbove = true) {
        nodes.forEach(node => {
            //Push onto the playback front
            this.playbackFront.push(node);
            //Push a new track onto the activeTracks stack (creating a new 'layer', if you like)
            let newTrack = new ContentRenderTrack();
            newTrack.activeBlock = node.block;
            newTrack.activeRenderer = this.rendererPool.getRenderer(node.block.media.location.getType());
            this.activeTracks.set(node.id, newTrack);

            //Find the index this track should be inserted at
            let targetIndex = 0;
            if (relativeToTrack) {
                let relativeTrackIndex = this.renderHierarchy.getLayerIndex(relativeToTrack.activeRenderer);
                targetIndex = insertAbove ? relativeTrackIndex + 1 : relativeTrackIndex;
            }

            //Start 'er up
            this.startTrackPlayback(newTrack, node, targetIndex);
            this.preloadTrackChildren(newTrack, this.maxPreloadedBlocks);
        });
    } 

    //Attempt to preload a number of blocks onto a track
    private preloadTrackChildren(track: ContentRenderTrack, maxPreloads: number) {
        //TODO: Preloading. Remember that nodes
        this.log.warn('Track preloading not yet implemented');
    }

    //Insert the default block to the front of the primary queue. Used when nothing else is playing
    private jumpStartWithDefault() {
        let starterNode = new PlaybackContentNode(this.defaultBlock, this.nodeIdCounter++, PlaybackRelationship.Sequenced);
        this.nodeTreeMap.set(starterNode.id, starterNode);
        this.launchNewTracksForNodes([ starterNode ]);
    }

    //Stop the node on the a branch and release all resources
    private stopAndClosePlayingBranch(playbackFrontIndex: number) {
        let node = this.playbackFront[playbackFrontIndex];
        if (!node) return; //Either index is incorrect or this node has already finished playing
        let track = this.activeTracks.get(node.id);
        //Remove from active tracks and release renderer
        this.activeTracks.delete(node.id);
        track.activeRenderer.stop().then(() => track.activeRenderer.release());
        this.renderHierarchy.removeRenderer(track.activeRenderer);
        this.playbackFront.splice(playbackFrontIndex, 1);
        this.cullBackToBranch(node); //The branch is finished, so remove it from the tree
    }

    //Walk backwards up a path of single-children nodes, culling them until a branch (node with multiple children) is reached.
    //Returns the branch node at the top of the path or null if the entire tree is a single-child path.
    private cullBackToBranch(pathEndNode: PlaybackContentNode) : PlaybackContentNode | null {
        let node = pathEndNode;
        while (node.parentNode != null) {
            let parent = node.parentNode;
            if (parent.children.length == 1) {
                //Parent is a single-child node, the path continues upwards
                this.notifyNodeRemovedFromTree(parent.children[0]);
                parent.children = null;
                node = parent;
            } else {
                //Parent is a branch node with multiple children - the path ends here
                //Remove the current node (part of the single-child path) from the parent
                parent.removeChild(node);
                this.notifyNodeRemovedFromTree(node);
                //Return the parent node
                return parent;
            }
        }

        //No branching parent could be found; the whole tree is single-child
        return null;
    }

    //Cleanup any external references when a node is removed from the player tree
    private notifyNodeRemovedFromTree(removedNode: PlaybackContentNode) {
        //Remove the node from the tree map
        this.nodeTreeMap.delete(removedNode.id);
        //Unload any media this node may have preloaded
        if (this.preloadedNodes.has(removedNode.id)) {
            let loadedRenderer = this.preloadedNodes.get(removedNode.id);
            loadedRenderer.release();
            this.preloadedNodes.delete(removedNode.id);
        }
    }
    
    private destructiveCollapseTree(rootNode: PlaybackContentNode) {
        //TODO: Collapse old nodes when the tree reaches a certain size
        //After this operation, the tree remains traversable but not historically accurate
    }

    //TODO: Recurring rule-based nodes will be applied in these enqueue methods

    // --- User-facing queue accessors ---
    /*  
        Users only have direct access to the active nodes on the lowest level of the playback front, presented to them as the "Queue" in the UI. 
        Accessors outside this section are intended for internal use by other application components or plugins.
    */

    //Add a block to the end of the queue
    public enqueueBlock(block: ContentBlock) {
        //Find the end of the primary path
        let node = this.playbackFront[0];
        while (node.children.length > 0) {
            node = node.children[0];
        }
        //Add this block to it
        let newNode = new PlaybackContentNode(block, this.nodeIdCounter++, PlaybackRelationship.Sequenced);
        node.addChild(newNode);
        this.nodeTreeMap.set(newNode.id, newNode);
        this.fireEvent('queueChanged', this.getQueue());
    }

    //Remove a block from the queue
    public dequeueNode(queuedId: number) {
        //Find this node in the queue
        let targetNode = this.nodeTreeMap.get(queuedId);
        if (!targetNode) return;

        if (targetNode.getPlaybackStatus() == NodePlaybackStatus.Playing) {
            return; //Cannot remove a node that's currently playing (the UI shouldn't allow this anyway)
        }

        //Splice this node out of the queue
        let targetNodeParent = targetNode.parentNode;
        targetNode.parentNode.removeChild(targetNode);
        if (targetNode.children.length > 0) {
            let primaryChild = targetNode.children[0];
            targetNode.removeChild(primaryChild);
            targetNodeParent.insertChild(primaryChild, 0);
        }
        this.notifyNodeRemovedFromTree(targetNode);

        this.fireEvent('queueChanged', this.getQueue());
    }

    //Modify a node in the queue
    public updateQueuedNode(queuedNodeId: number, newBlock: ContentBlock) : boolean {
        let targetNode = this.nodeTreeMap.get(queuedNodeId);
        if (!targetNode || targetNode.getPlaybackStatus() === NodePlaybackStatus.Playing) return false;

        //Unload if preloaded anywhere
        if (this.preloadedNodes.has(targetNode.id)) {
            let preloadedRenderer = this.preloadedNodes.get(targetNode.id);
            preloadedRenderer.release();
            this.preloadedNodes.delete(targetNode.id);
        }

        targetNode.block = newBlock;
        this.fireEvent('queueChanged', this.getQueue());
        return true;
    }

    //Move a block to another position in the queue
    public reorderQueuedNode(queuedIdToMove: number, queuedIdTarget: number, placeBefore: boolean) : boolean {
        let nodeToMove = this.nodeTreeMap.get(queuedIdToMove);
        let targetNode = this.nodeTreeMap.get(queuedIdTarget);
        if (!nodeToMove || !targetNode || !nodeToMove.parentNode) return false;

        //Splice nodeToMove out of the queue -- [A] -> [B] -> [C]
        let nodeToMoveOldParent = nodeToMove.parentNode;
        nodeToMove.parentNode.removeChild(nodeToMove); // [B] -> [C]
        if (nodeToMove.children.length > 0) {
            let primaryChild = nodeToMove.children[0];
            nodeToMove.removeChild(primaryChild); // [B]
            nodeToMoveOldParent.insertChild(primaryChild, 0); // [A] -> [C]
        }

        if (placeBefore) {
            //Splice nodeToMove into the queue between targetNode and targetNode's parent
            let targetNodeParent = targetNode.parentNode;
            targetNode.parentNode.removeChild(targetNode);
            targetNodeParent.insertChild(nodeToMove, 0);
            nodeToMove.insertChild(targetNode, 0);
        } else {
            //Splice nodeToMove into the queue between targetNode and targetNode's first child
            if (targetNode.children.length === 0) {
                targetNode.addChild(nodeToMove);
                return true;
            }

            let targetNodePrimaryChild = targetNode.children[0];
            targetNode.removeChild(targetNodePrimaryChild);
            nodeToMove.insertChild(targetNodePrimaryChild, 0);
            targetNode.insertChild(nodeToMove, 0);
        }

        this.fireEvent('queueChanged', this.getQueue());
        return true;
    }

    //The queue starts at the 0th child of the playback front and goes to the end of the tree
    public getQueue() : EnqueuedContentBlock[] { //OPT - cache this
        let queue: EnqueuedContentBlock[] = [];
        let queueStart = this.playbackFront[0];

        if (queueStart.getPlaybackStatus() == NodePlaybackStatus.Playing) {
            //The node is currently playing and therefore shouldn't be part of the queue
            if (queueStart.children.length > 0) {
                //Start the queue from the next node
                queueStart = queueStart.children[0];
            } else {
                //Nothing is queued
                return queue;
            }
        }

        //Follow the primary path from this point until we reach the end of the tree
        let nextNode = queueStart;
        while (nextNode) {
            queue.push(new EnqueuedContentBlock(nextNode));
            nextNode.children.length > 0 ? nextNode = nextNode.children[0] : nextNode = null;
        }

        return queue;
    }

    // ------

    //Add a block to the playback tree relative to another enqueued block.
    public enqueueBlockRelative(block: ContentBlock, relativeTarget: EnqueuedContentBlock, playbackRelationship: PlaybackRelationship, offsetMs?: number) {
        
    }

    getDefaultBlock() {
        return this.defaultBlock;
    }

    //Return the active blocks based on what's currently in the renderer. Also, preserve the render hierarchy ordering
    getPlayingBlocks() : ContentBlockWithProgress[] {
        let activeBlocks: ContentBlockWithProgress[] = [];
        
        this.activeTracks.forEach((track, nodeId) => {
            activeBlocks[this.renderHierarchy.getLayerIndex(track.activeRenderer)] = new ContentBlockWithProgress(track.activeBlock, Date.now() - this.nodeTreeMap.get(nodeId).getPlaybackStatusTimestamp());
        });
        return activeBlocks;
    }

    //Control panel requests

    @ControlPanelRequest('getPlayingBlocks')
    private getPlayingRequest() : WSConnection.WSPendingResponse {
        return new WSConnection.SuccessResponse('PlayingBlocks', this.getPlayingBlocks()); //TODO: Update ContentBlocksWithProgress to include the node's playback status - the client side should be able to display this
    }

    @ControlPanelRequest('getQueue')
    private getQueueRequest() : WSConnection.WSPendingResponse {
        return new WSConnection.SuccessResponse('Queue', this.getQueue());
    }

    @ControlPanelRequest('skipForward')
    private skipForward() : WSConnection.WSPendingResponse { //Skip to the next node on the primary path
        if (this.playbackFront[0].children.length == 0) {
            return new WSConnection.ErrorResponse('QueueEmpty', 'Nothing to skip to - the queue is empty');
        }

        //Reset the current node's playbackStatusTimestamp so that playback is finished
        let currentNode = this.playbackFront[0];
        this.log.info('Skipping block "' + currentNode.block.media.name + '"');
        currentNode.playbackStatusTimestamp = -Number.POSITIVE_INFINITY; //Tricks the currentNode to end on the next tick
        return new WSConnection.SuccessResponse('SkipQueued');
    }

    @ControlPanelRequest('stopToTitle')
    private stopToTitleRequest() : WSConnection.WSPendingResponse {
        let primaryNode = this.playbackFront[0];

        if (primaryNode.block.id == this.defaultBlock.id) {
            return new WSConnection.ErrorResponse('AlreadyStopped', 'The default title block is already playing');
        }

        this.log.info('Stopping to default block');
        //Stop playback of all branches except the primary one
        for (let i = this.playbackFront.length - 1; i > 0; i++) {
            this.stopAndClosePlayingBranch(i);
        }

        //Pull the current queue off the primary node
        let primaryPathHead = primaryNode.children[0];
        //Remove all children from the node
        primaryNode.children = [];

        let defaultNode = new PlaybackContentNode(this.defaultBlock, this.nodeIdCounter++, PlaybackRelationship.Sequenced);
        this.nodeTreeMap.set(defaultNode.id, defaultNode);
        //Patch the queue on to the end of the default node
        defaultNode.addChild(primaryPathHead);

        //Create a new track for the default block to live on
        this.launchNewTracksForNodes([defaultNode], this.activeTracks.get(primaryNode.id), true);

        if (defaultNode.block.transitionInMs > 0) {
            //The default block has an in transition, ensure the underlying track stays alive until it's completed
            //We can accomplish this by setting the primary node to the TransitioningOut state with an out duration equal to the default block's in duration
            primaryNode.block.transitionOutMs = defaultNode.block.transitionInMs;
            primaryNode.setPlaybackStatus(NodePlaybackStatus.TransitioningOut);
        } else {
            //No transition, end the old track immediately
            this.stopAndClosePlayingBranch(0);
        }

        this.queuedTickActions.set('activePlaybackEvent', () => this.fireEvent('activePlaybackChanged', this.getPlayingBlocks()));

        return new WSConnection.SuccessResponse('Stopped');
    }

    @ControlPanelRequest('restartBlock')
    private restartPlaybackRequest() : WSConnection.WSPendingResponse {
        //Restart the current primary node
        let currentNode = this.playbackFront[0];
        let renderer = this.activeTracks.get(currentNode.id).activeRenderer;
        this.log.info('Restarting current block')
        return new Promise((resolve, reject) => {
            renderer.restartMedia().then(() => {
                currentNode.setPlaybackStatus(NodePlaybackStatus.Playing);
                resolve(new WSConnection.SuccessResponse('Restarted'));
                this.fireEvent('activePlaybackChanged', this.getPlayingBlocks());
            }).catch(err => reject(new WSConnection.ErrorResponse('Generic', err)));
        });
    }

    @ControlPanelRequest('queueChange', QueueChange.isInstance)
    private scheduleChangeRequest(requestedChange: QueueChange) : WSConnection.WSPendingResponse {
        if (requestedChange.queueIdTarget === -1) {
            //This is a delete request
            this.dequeueNode(requestedChange.queueIdToMove);
            return new WSConnection.SuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} removed`);
        } else {
            //This is a reorder request
            let success = this.reorderQueuedNode(requestedChange.queueIdToMove, requestedChange.queueIdTarget, requestedChange.placeBefore);
            if (success) {
                return new WSConnection.SuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} moved`);
            } else {
                return new WSConnection.ErrorResponse('Invalid queue IDs');
            }
        }
    }

    @ControlPanelRequest('updateContentBlock', WSConnection.AcceptAny)
    private updateBlockRequest(data: any): WSConnection.WSPendingResponse {
        return new Promise((resolve, reject) => {
            //Try to create a new content block from the provided one
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                contentBlock.id = data.block.id; //Replace the generated id with the target id
                if (this.updateQueuedNode(data.block.queuedId, contentBlock)) {
                    resolve(new WSConnection.SuccessResponse(`Updated block with id ${contentBlock.id}`));
                } else {
                    reject(new WSConnection.ErrorResponse('Invalid target block'));
                };
            }).catch(error => {
                console.error('Failed to create content block from request:', error);
                reject(error);
            });
        });
    }

    @ControlPanelRequest('addContentBlock', WSConnection.AcceptAny)
    private addContentBlockRequest(data: any) : WSConnection.WSPendingResponse {
        return new WSConnection.ErrorResponse('NotImplemented');

/*         return new Promise((resolve, reject) => {
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                this.rerunState.player.enqueueBlock(contentBlock);
                resolve(new WSConnection.SuccessResponse(`Enqueued content block ${data.block.id}`));
            }).catch(error => {
                console.error('Failed to enqueue new content block:', error);
                resolve(error);
            });
        }); */
    }

    private createContentBlockFromRequest(requestedBlock: any) : Promise<ContentBlock> {
        return new Promise((resolve, reject) => {
            //Try to create the MediaObject
            this.createMediaObjectFromRequest(requestedBlock.media, this.rerunState).then((mediaObject: MediaObject) => {
                let block = new ContentBlock(uuidv4(), mediaObject);
                block.colour = requestedBlock.colour;
                resolve(block);
            }).catch(error => reject(error));
        });
    }
    
    private createMediaObjectFromRequest(requestedMedia: any, rerunState: RerunStateObject): Promise<MediaObject> {
        return new Promise((resolve, reject) => {
            let newMedia = MediaObject.CreateEmpty(requestedMedia.type);
            newMedia.name = requestedMedia.name;

            switch (requestedMedia.type) {
                case 'Local video file':
                    //Check that the file exists
                    if (fs.existsSync(requestedMedia.location.path)) {
                        if (!fs.lstatSync(requestedMedia.location.path).isDirectory()) {
                            //Get file metadata for this media object
                            mediaObjectFromVideoFile(requestedMedia.location.path).then((generatedMedia: MediaObject) => {
                                generatedMedia.name = requestedMedia.name; //Set the requested name rather than the generated one
                                resolve(generatedMedia);
                            }).catch(error => reject(error));
                        } else {
                            reject('Provided path is a directory, not a file');
                        }
                    } else {
                        reject('File not found');
                    }
                    break;
                case 'Youtube video':
                    mediaObjectFromYoutube(requestedMedia.location.path, rerunState.downloadBuffer).then((media: MediaObject) => {
                        resolve(media);
                    }).catch(error => reject(error));
                    break;
                case 'RTMP stream':
                    reject('RTMP not yet implemented');
                    break;
                case 'Rerun title graphic':
                    reject('Rerun graphic not yet implemented');
                    break;
                default:
                    reject('Unknown media type "' + requestedMedia.type + '"');
            }
        });
}
}

export enum PlaybackRelationship {
    //Specifies when a ContentBlock should play
    Sequenced, //This node should play once its parent is finished
    Relative //This node should play at a certain time relative to its parent (eg. 3 seconds after the start)
}

//A ContentBlock linked to a node in the PlaybackTree (by node id). Allows users to enqueue a block relative to an existing one
class EnqueuedContentBlock extends ContentBlock {
    readonly queuedId: number;
    constructor(node: PlaybackContentNode) {
        super(node.block.id, node.block.media);
        ContentBlock.clone(node.block, this);
        this.queuedId = node.id;
    }

    toJSON() {
        let j = super.toJSON();
        j.queuedId = this.queuedId;
        return j;
    }
}

class ContentBlockWithProgress extends ContentBlock {
    progressMs: number;
    constructor(block: ContentBlock, playbackProgressMs: number) {
        super(block.id, block.media);
        ContentBlock.clone(block, this);
        this.progressMs = playbackProgressMs;
    }

    toJSON() {
        let j = super.toJSON();
        j.progressMs = this.progressMs;
        return j;
    }
}