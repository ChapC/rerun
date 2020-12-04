import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {PublicRerunComponents} from '../index';
import {MultiListenable} from '../helpers/MultiListenable';
import PrefixedLogger from '../helpers/PrefixedLogger';
import { WSConnection } from '../helpers/WebsocketConnection';
import { ControlPanelRequest, ControlPanelListener } from '../ControlPanelHandler';
import { mediaObjectFromVideoFile } from "../contentsources/LocalDirectorySource";
import fs from 'fs';
import { mediaObjectFromYoutube } from "../contentsources/YoutubeChannelSource";
import { ScheduleChange as QueueChange } from './QueueChange';
import PlaybackContentNode, { NodePlaybackStatus, PlaybackOffset } from './PlaybackContentNode';
import ContentRenderTrack from './renderers/ContentRenderTrack';
import RendererPool, { PooledContentRenderer } from './renderers/RendererPool';
import RenderHierarchy from './renderers/RenderHierarchy';

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

    constructor(rendererPool: RendererPool, renderHierarchy: RenderHierarchy, private rerunComponents: PublicRerunComponents, defaultBlock: ContentBlock) { //TODO: Remove rerunComponents parameters in favour of specific dependencies
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
        this.playbackFront.forEach((node, index) => this.releasePlayingNode(index));
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

    // --- Internal tree maintenance methods ---

    //Called every player tick, monitoring the playbackFront and maintaining the playback tree
    private evaluatePlaybackFront() {
        //Process any queued actions
        this.queuedTickActions.forEach(action => action());
        this.queuedTickActions.clear();

        //Check on the status of each node on the playback front
        for (let playbackFrontIndex = this.playbackFront.length - 1; playbackFrontIndex > -1; playbackFrontIndex--) {
            let currentNode = this.playbackFront[playbackFrontIndex];
            if (currentNode.getPlaybackStatus() == NodePlaybackStatus.Playing) {

                //If the primary child has met an offset, start playing it now + add to playback front
                //If activeNode is finished, stop and play any queued sequential ones. If the primary child hasn't started yet, let it inherit. Otherwise release resources

                let currentPlaybackProgressMs = Date.now() - currentNode.getPlaybackStatusTimestamp();
                let currentPlaybackRemainingMs = currentNode.block.media.durationMs - currentPlaybackProgressMs;

                //Run through this node's children to see if any should be triggered now
                for (let i = currentNode.pendingOffsetChildren.length - 1; i > -1; i--) {
                    //pendingOffsetChildren contains a list of children with offsets, meaning they are set to start once the current node reaches a certain time
                    let relChild = currentNode.pendingOffsetChildren[i];

                    if (relChild.offset.type === PlaybackOffset.Type.MsAfterStart) { //The child is set to play n milliseconds into the current node
                        if (currentPlaybackProgressMs >= relChild.offset.value) {
                            this.log.info(`Starting ${this.nodeLogID(relChild)} ${currentPlaybackProgressMs}ms into ${this.nodeLogID(currentNode)} (${currentPlaybackProgressMs - relChild.offset.value}ms off)`);
                            this.launchNewTracksForNodes([relChild], this.activeTracks.get(currentNode.id));
                            currentNode.pendingOffsetChildren.splice(i, 1);
                        }
                    } else if (relChild.offset.type === PlaybackOffset.Type.MsBeforeEnd) { //The child is set to play n milliseconds before the current node ends
                        if (currentPlaybackRemainingMs <= relChild.offset.value) {
                            this.log.info(`Starting ${this.nodeLogID(relChild)} ${currentPlaybackRemainingMs}ms before the end of ${this.nodeLogID(currentNode)} (${currentPlaybackRemainingMs - relChild.offset.value}ms off)`);
                            this.launchNewTracksForNodes([relChild], this.activeTracks.get(currentNode.id));
                            currentNode.pendingOffsetChildren.splice(i, 1);
                        }
                    } else if (relChild.offset.type === PlaybackOffset.Type.Percentage) { //The child is set to play n% of the way through the current node (n is 0-1)
                        let currentPlaybackProgressPercent = currentPlaybackRemainingMs / currentNode.block.media.durationMs;
                        if (currentPlaybackProgressPercent >= relChild.offset.value) {
                            this.log.info(`Starting ${this.nodeLogID(relChild)} ${currentPlaybackProgressPercent}% through ${this.nodeLogID(currentNode)} (${currentPlaybackProgressPercent - relChild.offset.value}% off)`);
                            this.launchNewTracksForNodes([relChild], this.activeTracks.get(currentNode.id));
                            currentNode.pendingOffsetChildren.splice(i, 1);
                        }
                    }
                }

                //Check if the current node has finished playback
                if (currentPlaybackProgressMs >= currentNode.block.media.durationMs) {
                    //The node has finished playback
                    this.log.info(`${this.nodeLogID(currentNode)} finished playback`);                    
                    let currentNodeTrack = this.activeTracks.get(currentNode.id);

                    if (currentNode.block.transitionOutMs > 0) {
                        //This node will now start an out transition (eg. fade out), so its track needs to keep playing for a bit.
                        let currentNodeRenderer = currentNodeTrack.activeRenderer;
                        currentNodeRenderer.stop(); //Starts the out transition
                        currentNode.setPlaybackStatus(NodePlaybackStatus.TransitioningOut);
                        this.log.info(`${this.nodeLogID(currentNode)} started transitioning out`);
                        //While that happens, we'll start any child nodes on new tracks underneath it
                        if (currentNode.children.length > 0) {
                            this.launchNewTracksForNodes(currentNode.children, currentNodeTrack, false);
                        }

                        if (this.playbackFront.length == 0) {
                            this.log.info(`Nothing queued - defaulting to "${this.defaultBlock.media.name}"`);
                            this.jumpStartWithDefault();
                        }
                    } else {
                        //No out transition. The node can be ended right away
                        currentNode.setPlaybackStatus(NodePlaybackStatus.Finished);

                        //Remove this node from the renderer hierarchy
                        let currentRenderLayer = this.renderHierarchy.getLayerIndex(currentNodeTrack.activeRenderer);
                        this.renderHierarchy.removeRenderer(currentNodeTrack.activeRenderer);
                        //Stop the renderer
                        currentNodeTrack.activeRenderer.stop();
                        //Check if there's anything queued for playback after this node
                        let queuedChildren = currentNode.children.filter(child => child.getPlaybackStatus() === NodePlaybackStatus.Queued);
                        //The queued children remaining at this point should not have an offset, meaning they're meant to be played sequentially
                        //If they do have an offset, it was invalid or something went wrong. The branch will never play, so we should close it down now
                        for (let i = queuedChildren.length - 1; i > 0; i--) {
                            let child = queuedChildren[i];
                            if (child.hasOffset()) {
                                this.log.warn(`Block "${child.block.media.name}" was queued with an offset ${child.offset.type}-${child.offset.value} that was never reached. Closing that branch...`);
                                currentNode.removeChild(child);
                                this.notifyNodeRemovedFromTree(child);
                                queuedChildren.splice(i, 1);
                            }
                        }

                        if (queuedChildren.length === 0) {
                            this.releasePlayingNode(playbackFrontIndex);

                            if (this.playbackFront.length === 0) {
                                this.log.info(`Nothing queued - defaulting to "${this.defaultBlock.media.name}"`);
                                this.jumpStartWithDefault();
                            }
                        } else {
                            //Great! So anything queued children we're left with should start playing now
                            //The first queued child gets to inherit the currentNode's resources
                            let inheritingChild = queuedChildren[0];
                            this.playbackFront[playbackFrontIndex] = inheritingChild; //Inherit playbackFront position
                            currentNodeTrack.activeBlock = inheritingChild.block; //Inherit track
                            //Update the track map to have firstChild as the key
                            this.activeTracks.delete(currentNode.id);
                            this.activeTracks.set(inheritingChild.id, currentNodeTrack);

                            //Check if this node has been preloaded
                            if (this.preloadedNodes.has(inheritingChild.id)) {
                                //Yay, it has! Chuck the old renderer and use the preloaded one
                                currentNodeTrack.activeRenderer.release();
                                let preloadedRenderer = this.preloadedNodes.get(inheritingChild.id);
                                this.preloadedNodes.delete(inheritingChild.id);
                                currentNodeTrack.activeRenderer = preloadedRenderer;
                            } else {
                                //Not preloaded :(
                                //If the old renderer supports this content type, we'll load it into that one in a sec.
                                //Otherwise, we'll need to grab a new one
                                if (currentNodeTrack.activeRenderer.supportedContentType !== inheritingChild.block.media.location.getType()) {
                                    currentNodeTrack.activeRenderer.release();
                                    currentNodeTrack.activeRenderer = this.rendererPool.getRenderer(inheritingChild.block.media.location.getType());
                                }
                            }

                            this.startTrackPlayback(currentNodeTrack, inheritingChild, currentRenderLayer);
                            //Try preloading descendants of this node
                            this.preloadNodeChildren(currentNodeTrack, this.maxPreloadedBlocks);

                            //Any other queued children will be started on new tracks on top of the currentNodeTrack
                            this.launchNewTracksForNodes(queuedChildren.slice(1), currentNodeTrack, true);
                        }
                    }

                    this.queuedTickActions.set('activePlaybackEvent', () => this.fireEvent('activePlaybackChanged', this.getPlayingBlocks()));
                    this.queuedTickActions.set('queueChangedEvent', () => this.fireEvent('queueChanged', this.getQueue()));
                }

            } else if (currentNode.getPlaybackStatus() == NodePlaybackStatus.TransitioningIn) {

                //Check if the node has finished transitioning in
                let transitionProgressMs = Date.now() - currentNode.getPlaybackStatusTimestamp();
                if (transitionProgressMs > currentNode.block.transitionInMs) {
                    this.log.info(`${this.nodeLogID(currentNode)} finished transitioning in - starting playback`);
                    //Switch to playing
                    currentNode.setPlaybackStatus(NodePlaybackStatus.Playing);
                }

            } else if (currentNode.getPlaybackStatus() == NodePlaybackStatus.TransitioningOut) {

                //Check if the node has finished transitioning out
                let transitionProgressMs = Date.now() - currentNode.getPlaybackStatusTimestamp();
                if (transitionProgressMs > currentNode.block.transitionOutMs + 150) { //I'm giving out transitions 150ms extra time to get off screen. It'd be cooler if the player was more accurate, but I'm not that talented
                    //|._.| it is done.
                    this.log.info(`${this.nodeLogID(currentNode)} finished transitioning out`);
                    currentNode.setPlaybackStatus(NodePlaybackStatus.Finished);
                    this.releasePlayingNode(playbackFrontIndex);
                    if (this.playbackFront.length === 0) {
                        this.log.info(`Nothing queued - defaulting to "${this.defaultBlock.media.name}"`);
                        this.jumpStartWithDefault();
                    }
                    this.queuedTickActions.set('activePlaybackEvent', () => this.fireEvent('activePlaybackChanged', this.getPlayingBlocks()));
                    this.queuedTickActions.set('queueChangedEvent', () => this.fireEvent('queueChanged', this.getQueue()));
                }

            } else { //activeNode isn't actually active (it's finished or queued)
                this.log.error('A node on the playback front is in a bad state', currentNode);
                this.shutdown();
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
                    this.log.info(`${this.nodeLogID(playingNode)} started transitioning in`);
                } else {
                    playingNode.setPlaybackStatus(NodePlaybackStatus.Playing);
                    this.log.info(`${this.nodeLogID(playingNode)} started playback`);
                }
            });
        }

        playingNode.setPlaybackStatus(track.activeBlock.transitionInMs > 0 ? NodePlaybackStatus.TransitioningIn : NodePlaybackStatus.Playing);
        //NOTE: We set the playback status now to prevent the player loop from jumping on this node again, but the playback status
        //is set again in the actual addToHierarchyAndPlay promise to get a more accurate timestamp.

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
            this.preloadNodeChildren(newTrack, this.maxPreloadedBlocks);
        });
    } 

    //Attempt to preload a number of blocks onto a track <- NOT HOW WE DO IT ANYMORE
    private preloadNodeChildren(track: ContentRenderTrack, maxPreloads: number) {
        //TODO: Preloading. Remember that nodes
        this.log.warn('Track preloading not yet implemented');
    }

    //Insert the default block to the front of the primary queue. Used when nothing else is playing
    private jumpStartWithDefault() {
        let starterNode = new PlaybackContentNode(this.defaultBlock, this.nodeIdCounter++);
        this.nodeTreeMap.set(starterNode.id, starterNode);
        this.launchNewTracksForNodes([ starterNode ]);
    }

    //Stop the node on the a branch and release all resources
    private releasePlayingNode(playbackFrontIndex: number) {
        let node = this.playbackFront[playbackFrontIndex];
        if (!node) return; //Either index is incorrect or this node has already finished playing
        let track = this.activeTracks.get(node.id);
        //Remove from playback front, active tracks and release renderer
        this.playbackFront.splice(playbackFrontIndex, 1);
        this.activeTracks.delete(node.id);
        this.renderHierarchy.removeRenderer(track.activeRenderer);
        track.activeRenderer.release();
        if (node.children.length === 0) {
            //This branch has no more descendants and can be culled
            this.cullBackToBranch(node);
        }
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
                parent.children = [];
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

    //Recursively cleanup any external references when a node is removed from the player tree
    private notifyNodeRemovedFromTree(removedNode: PlaybackContentNode) {
        this.log.info(`${this.nodeLogID(removedNode)} was removed from tree`);
        //Remove the node from the tree map
        this.nodeTreeMap.delete(removedNode.id);
        //Unload any media this node may have preloaded
        if (this.preloadedNodes.has(removedNode.id)) {
            let loadedRenderer = this.preloadedNodes.get(removedNode.id);
            loadedRenderer.release();
            this.preloadedNodes.delete(removedNode.id);
        }
        //TempNode cleanup
        if (this.tempNodes.has(removedNode.id)) {
            this.tempNodeProviderChildMap.get(this.tempNodeProvidedByMap.get(removedNode.id)).delete(removedNode.id);
            this.tempNodes.delete(removedNode.id);
            this.tempNodeProvidedByMap.delete(removedNode.id);
        }

        removedNode.children.forEach(this.notifyNodeRemovedFromTree, this);// <- This is causing a problem. Someone is calling this function with valid children still attached, I guess? Or maybe the playback front idk
    }

    //Remove a node from the tree and attach its primary child to its parent. Like an array splice but only for the primary child.
    private primarySpliceNodeOut(targetNode: PlaybackContentNode) {
        //Remove [targetNode] from [A] -> [targetNode] -> [B]
        let targetNodeParent = targetNode.parentNode;
        targetNode.parentNode.removeChild(targetNode); // [A]
        if (targetNode.children.length > 0) {
            let primaryChild = targetNode.children[0]; // [targetNode] -> [B]
            targetNode.removeChild(primaryChild); // [targetNode]
            targetNodeParent.insertChild(primaryChild, 0); // [A] -> [B]
        }
    }
    
    //Insert a node into the tree between a parent node and its primary child
    private primarySpliceNodeIn(parentNode: PlaybackContentNode, inNode: PlaybackContentNode) {
        if (parentNode.children.length === 0) {
            parentNode.addChild(inNode);
            return;
        }

        // Adding [inNode] between [A] -> [B]
        let oldPrimaryChild = parentNode.children[0]; // [A] -> [B]
        parentNode.removeChild(oldPrimaryChild); // [A]
        parentNode.insertChild(inNode, 0); // [A] -> [inNode]
        inNode.insertChild(oldPrimaryChild, 0); // [A] -> [inNode] -> [B]
    }
    
    private destructiveCollapseTree(rootNode: PlaybackContentNode) {
        //TODO: Collapse old nodes when the tree reaches a certain size
        //After this operation, the tree remains traversable but not historically accurate
    }

    // ------
    // --- User-facing queue accessors ---
    /*  
        Users only have direct access to the active nodes on the lowest level of the playback front, presented to them as the "Queue" in the UI. 
        Accessors outside this section are intended for internal use by other application components or plugins.
    */

    /**
     * Add a ContentBlock to be played sequentially at the end of the player queue.
     * @param block The block to enqueue.
     * @returns A node ID representing the block's position in the queue.
     */
    public enqueueBlock(block: ContentBlock) : number {
        //Find the end of the primary path
        let node = this.playbackFront[0];
        while (node.children.length > 0) {
            node = node.children[0];
        }
        //Add this block to it
        let newNode = new PlaybackContentNode(block, this.nodeIdCounter++);
        node.addChild(newNode);
        this.nodeTreeMap.set(newNode.id, newNode);
        this.reevaluateTempNodes();
        this.fireEvent('queueChanged', this.getQueue());
        return newNode.id;
    }

    /**
     * Remove a ContentBlock from the player queue.
     * @param queuedNodeId Node ID of the block to remove
     */
    public dequeueNode(queuedNodeId: number) {
        //Find this node in the tree
        let targetNode = this.nodeTreeMap.get(queuedNodeId);
        if (!targetNode) return;

        if (targetNode.getPlaybackStatus() !== NodePlaybackStatus.Queued) {
            return; //Cannot remove a node that's currently playing (the UI shouldn't allow this anyway)
        }

        //Splice this node out of the queue
        this.primarySpliceNodeOut(targetNode);
        this.notifyNodeRemovedFromTree(targetNode);

        this.reevaluateTempNodes();
        this.fireEvent('queueChanged', this.getQueue());
    }

    /**
     * Update a queued node with a modified ContentBlock.
     * Nodes that are currently active (playing or transitioning in/out) cannot be updated.
     * @param queuedNodeId Node ID to update
     * @param newBlock The updated block to replace the target node with
     * @returns True if the target node was updated, False if the target node is currently active or is no longer in the queue
     */
    public updateQueuedNode(queuedNodeId: number, newBlock: ContentBlock) : boolean {
        let targetNode = this.nodeTreeMap.get(queuedNodeId);
        if (!targetNode || targetNode.getPlaybackStatus() !== NodePlaybackStatus.Queued) return false;

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

    /**
     * Move a node to another position in the queue relative to some other queued node.
     * @param sourceQueuedId ID of the source node to move
     * @param destinationQueuedId ID of the destination node that source should be moved next to
     * @param placeBefore Whether the source node should be placed before or after the destination node
     * @returns True if the reorder completed, False if the either node could not be found or source node is currently playing
     */
    public reorderQueuedNode(sourceQueuedId: number, destinationQueuedId: number, placeBefore: boolean) : boolean {
        let nodeToMove = this.nodeTreeMap.get(sourceQueuedId);
        let targetNode = this.nodeTreeMap.get(destinationQueuedId);
        if (!nodeToMove || !targetNode || !nodeToMove.parentNode) return false;
        if (nodeToMove.getPlaybackStatus() === NodePlaybackStatus.Playing) return false;

        //Splice nodeToMove out of the queue -- [A] -> [B] -> [C]
        this.primarySpliceNodeOut(nodeToMove);

        if (placeBefore) {
            //Splice nodeToMove into the queue between targetNode and targetNode's parent
            this.primarySpliceNodeIn(targetNode.parentNode, nodeToMove);
        } else {
            //Splice nodeToMove into the queue between targetNode and targetNode's first child
            this.primarySpliceNodeIn(targetNode, nodeToMove);
        }

        this.reevaluateTempNodes();
        this.fireEvent('queueChanged', this.getQueue());
        return true;
    }

    //The queue starts at the 0th child of the playback front and goes to the end of the tree
    public getQueue() : EnqueuedContentBlock[] { //OPT - cache this
        let queue: EnqueuedContentBlock[] = [];
        let queueStart = this.playbackFront[0];

        if (queueStart == null) return queue;

        if (queueStart.getPlaybackStatus() != NodePlaybackStatus.Queued) {
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
    // --- TempNodeProvider handling ---
    /*
        TempNodeProviders are functions that accept the player queue and return a list of 'temperamental' nodes to be inserted.
        The primary use of TempNodeProviders is in user-defined rules that enqueue certain ContentBlocks every time 
        a condition is met, like "play this stinger graphic every 3rd block".
        The nodes they provide are called temperamental because, although they are added into the tree like normal
        nodes, they are removed whenever the tree is modified by an external source. For example, a user adding/removing
        a ContentBlock would require the "every 3rd block" rule to be reevaluated.
    */

    private tempNodes: Map<number, PlaybackContentNode> = new Map(); //Maps node ID to a TempNode somewhere in the tree. Can be used to test if a node is temperamental
    private tempNodeProvidedByMap: Map<number, number> = new Map(); //Maps a TempNode's ID to the ID of the TempNodeProvider it came from
    private tempNodeProviderChildMap: Map<number, Map<number, PlaybackContentNode>> = new Map(); //Maps TempNodeProvider ID to a map of all the TempNodes it's responsible for
    private tempNodeProviders: Map<number, TempNodeProvider> = new Map();
    private tempNodeProviderIdCounter = 0;
    
    //Remove all the TempNodes from the tree and poll the providers for updates
    private reevaluateTempNodes() {
        if (this.tempNodeProviders.size > 0) {
            this.log.info(`Reevaluating ${this.tempNodeProviders.size} temperamental node provider(s)`);
            this.tempNodeProviders.forEach((p, providerId) => this.clearFromTempProvider(providerId));
            this.tempNodeProviders.forEach((p, providerId) => this.insertFromTempProvider(providerId));
        }
    }

    //Ask the temp provider for nodes and enqueue them
    private insertFromTempProvider(providerId: number) {
        //Create a map to contain all the nodes this provider generates
        if (!this.tempNodeProviderChildMap.has(providerId)) {
            this.tempNodeProviderChildMap.set(providerId, new Map());
        }

        let providedBlocks = this.tempNodeProviders.get(providerId)(this.getQueue()); //Poll the provider for content

        for (let provided of providedBlocks) {
            //Enqueue the provided block
            let enqueuedProvided = this.enqueueBlockRelative(provided.block, provided.relativeTarget, provided.startRelationship, provided.offset);
            //Mark the node as a TempNode by adding it to our structures
            let tempNode = this.nodeTreeMap.get(enqueuedProvided.queueId);
            this.tempNodes.set(tempNode.id, tempNode); //Add to map of all enqueued TempNodes
            this.tempNodeProvidedByMap.set(tempNode.id, providerId); //This node was provided by this provider
            this.tempNodeProviderChildMap.get(providerId).set(tempNode.id, tempNode);
        }
    }

    //Remove all TempNodes previously inserted into the tree by a provider
    private clearFromTempProvider(providerId: number) {
        for (let tempNode of this.tempNodeProviderChildMap.get(providerId).values()) {
            //Remove tempNode from the tree
            if (tempNode.parentNode.children.indexOf(tempNode) === 0) {
                //This is a primary node in the queue, so splice it out
                this.primarySpliceNodeOut(tempNode)
            } else {
                //This is a secondary node springing off from the queue, so just cut it from the tree
                tempNode.parentNode.removeChild(tempNode);
            }
            this.notifyNodeRemovedFromTree(tempNode);
        }
    }

    /**
     * Add a TempNodeProvider to the player's pool. The provider will be polled for
     * nodes right away and then repeatedly whenever the player queue changes.
     * 
     * @returns The ID assigned to the provider. Used to remove it later.
     */
    public addTempNodeProvider(provider: TempNodeProvider) : number {
        let id = this.tempNodeProviderIdCounter++;
        this.tempNodeProviders.set(id, provider);
        //Poll this provider
        this.insertFromTempProvider(id);
        return id;
    }

    /**
     * Remove a TempNodeProvider from the player's pool. Any of the provider's
     * nodes that are currently in the tree will be removed.
     * 
     * @param providerId The ID of the provider to remove
     */
    public removeTempNodeProvider(providerId: number) {
        this.clearFromTempProvider(providerId);
        this.tempNodeProviders.delete(providerId);
        this.tempNodeProviderChildMap.delete(providerId);
    }
    // ------

    /**
     * Enqueue a block to start playing before, after or during a block already in the tree.
     * @param block The block to enqueue
     * @param relativeTarget Enqueue the new block relative to this one
     * @param startRelationship Should the new block start playing after or during the target block
     * @param offset (Optional) Describes when the new block should start playing relative to the target. Defaults to playing sequentially, at the end of the target block
     */
    public enqueueBlockRelative(block: ContentBlock, relativeTarget: EnqueuedContentBlock, startRelationship: PlaybackStartRelationship, offset?: PlaybackOffset) : EnqueuedContentBlock {
        let createdNode = new PlaybackContentNode(block, this.nodeIdCounter++, offset);
        let targetNode = this.nodeTreeMap.get(relativeTarget.queueId);

        if (targetNode == null) {
            return null;
        }

        if (startRelationship === PlaybackStartRelationship.Sequenced) {
            this.primarySpliceNodeIn(targetNode, createdNode);
        } else if (startRelationship === PlaybackStartRelationship.Concurrent) {
            targetNode.addChild(createdNode);
        }

        this.nodeTreeMap.set(createdNode.id, createdNode);
        return new EnqueuedContentBlock(createdNode);
    }

    /**
     * Register a listener that is triggered whenever a playing block reaches a certain progress.
     * Only triggers for blocks on the primary queue.
     * 
     * NOTE: Prefer `addTempNodeProvider` if you want to add to the Player queue in the callback.
     * @param progress PlaybackOffset indicating when the listener will be triggered
     * @returns A listener ID used to cancel the listener later.
     */
    public onRecurringProgress(progress: PlaybackOffset, callback: (duringBlock: ContentBlockWithProgress) => void) : number {
        throw new Error("Method not implemented");
    }

    /**
     * Unregister a recurring progress listener.
     * @param listenerId The ID of the listener to cancel
     */
    public offRecurringProgress(listenerId: number) {
        throw new Error("Method not implemented");
    }

    /**
     * Get the block that the player will default to if the queue runs out.
     */
    getDefaultBlock() {
        return this.defaultBlock;
    }

    /**
     * Get a list of all the ContentBlocks currently active (playing or transitioning in/out).
     * ContentBlocks appear in the list in the same order they appear in the render hierarchy.
     */
    getPlayingBlocks() : ContentBlockWithProgress[] {
        let activeBlocks: ContentBlockWithProgress[] = [];
        
        this.activeTracks.forEach((track, nodeId) => {
            activeBlocks[this.renderHierarchy.getLayerIndex(track.activeRenderer)] = new ContentBlockWithProgress(this.nodeTreeMap.get(nodeId), Date.now() - this.nodeTreeMap.get(nodeId).getPlaybackStatusTimestamp());
        });
        return activeBlocks;
    }

    /**
     * Pretty-print a node for logging.
     */
    private nodeLogID(node: PlaybackContentNode) : string {
        return `${node.id}-${node.block.id}(${node.block.media.name})`;
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
        this.log.info(`Skipping node ${this.nodeLogID(currentNode)}`);
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
            this.releasePlayingNode(i);
        }

        let defaultNode = new PlaybackContentNode(this.defaultBlock, this.nodeIdCounter++);
        this.nodeTreeMap.set(defaultNode.id, defaultNode);

        if (primaryNode.children.length > 0) {
            //Pull the current queue off the primary node
            let primaryPathHead = primaryNode.children[0];
            //Remove all children from the node
            primaryNode.children = [];

            //Patch the queue on to the end of the default node
            defaultNode.addChild(primaryPathHead);
        }

        //Create a new track for the default block to live on
        this.launchNewTracksForNodes([defaultNode], this.activeTracks.get(primaryNode.id), true);

        if (defaultNode.block.transitionInMs > 0) {
            //The default block has an in transition, ensure the underlying track stays alive until it's completed
            //We can accomplish this by setting the primary node to the TransitioningOut state with an out duration equal to the default block's in duration
            primaryNode.block.transitionOutMs = defaultNode.block.transitionInMs;
            primaryNode.setPlaybackStatus(NodePlaybackStatus.TransitioningOut);
        } else {
            //No transition, end the old track immediately
            this.releasePlayingNode(0);
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
            this.createMediaObjectFromRequest(requestedBlock.media, this.rerunComponents).then((mediaObject: MediaObject) => {
                let block = new ContentBlock(mediaObject);
                block.colour = requestedBlock.colour;
                resolve(block);
            }).catch(error => reject(error));
        });
    }
    
    private createMediaObjectFromRequest(requestedMedia: any, rerunState: PublicRerunComponents): Promise<MediaObject> {
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

//Accepts the current queue of blocks and returns a list of blocks to add
export type TempNodeProvider = (queue: EnqueuedContentBlock[]) => {
    block: ContentBlock; 
    relativeTarget: EnqueuedContentBlock;
    startRelationship: PlaybackStartRelationship;
    offset?: PlaybackOffset;
}[];

export enum PlaybackStartRelationship {
    //Specifies how a block should play relative to the block before it
    Sequenced, //The blocks should play one after the other (optionally with a little bit of overlap for transitions)
    Concurrent //The blocks should play at the same time
}

//A ContentBlock linked to a node in the PlaybackTree (by node id). Allows users to enqueue a block relative to an existing one
export class EnqueuedContentBlock extends ContentBlock {
    readonly queueId: number;
    constructor(node: PlaybackContentNode) {
        super(node.block.media, node.block.id);
        ContentBlock.clone(node.block, this);
        this.queueId = node.id;
    }

    toJSON() {
        let j = super.toJSON();
        j.queuedId = this.queueId;
        return j;
    }
}

class ContentBlockWithProgress extends EnqueuedContentBlock {
    readonly progressMs: number;
    constructor(node: PlaybackContentNode, playbackProgressMs: number) {
        super(node);
        this.progressMs = playbackProgressMs;
    }

    toJSON() {
        let j = super.toJSON();
        j.progressMs = this.progressMs;
        return j;
    }
}