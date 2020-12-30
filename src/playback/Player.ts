import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {PublicRerunComponents} from '../index';
import {ListenerGroup, MultiListenable} from '../helpers/MultiListenable';
import PrefixedLogger from '../helpers/PrefixedLogger';
import { WSPendingResponse, WSSuccessResponse, WSErrorResponse, AcceptAny } from '../networking/WebsocketConnection';
import { ControlPanelRequest, ControlPanelListener } from '../networking/ControlPanelHandler';
import { mediaObjectFromVideoFile } from "../contentsources/LocalDirectorySource";
import fs from 'fs';
import { mediaObjectFromYoutube } from "../contentsources/YoutubeChannelSource";
import { ScheduleChange as QueueChange } from './QueueChange';
import PlaybackNode, { NodePlaybackStatus, PlaybackNodeEvent } from './PlaybackNode';
import RendererPool, { LeasedContentRenderer } from './renderers/RendererPool';
import RenderHierarchy from './renderers/RenderHierarchy';
import { ContentRenderer, RendererStatus } from './renderers/ContentRenderer';

export enum PlayerEvent { ActiveBlocksChanged, PlayQueueChanged };
@ControlPanelListener
export class Player extends MultiListenable<PlayerEvent, any> {
    private readonly maxPreloadedBlocks = 6; //The maximum number of blocks that will be preloaded into renderers in advance

    private log: PrefixedLogger = new PrefixedLogger("Player");
    private nodeIdCounter = 0;
    private defaultBlock: ContentBlock;
    private rendererPool: RendererPool;
    private renderHierarchy: RenderHierarchy;

    constructor(rendererPool: RendererPool, renderHierarchy: RenderHierarchy, private rerunComponents: PublicRerunComponents, defaultBlock: ContentBlock) { //TODO: Remove rerunComponents parameters in favour of specific dependencies
        super();
        this.rendererPool = rendererPool;
        this.renderHierarchy = renderHierarchy;
        this.defaultBlock = defaultBlock;

        //Start playback of the default block
        let starterNode = new PlaybackNode(this.nodeIdCounter++, defaultBlock, RelativeStartType.Sequenced);
        this.nodeTreeMap.set(starterNode.id, starterNode);
        this.startPlayingNode(starterNode, 0);
    }

    shutdown() {
        for (let i = this.playbackFront.length - 1; i > 0; i--) {
            this.stopPlayingNode(this.playbackFront[i]);
        }
    }

    /*
        Playback tree notes:
        - "active node" means a node that is in the "queued", "transitioning" or "playing" state. An inactive node is one in the "finished" state.
        - the playback tree is mostly abstracted from the user. They only have direct access to the tree starting at the first node in the playback front.
          This is presented to the user as a queue that is obtained by traversing the first node's tree by the 0th child until the end of the tree.
    */

    /**
     * The playback front is a list of the shallowest active nodes in each branch of the playback tree.
     * 
     * This is the variable that would typically hold a reference to the root of the tree, but since
     * we don't care about past nodes we only keep references to the currently active ones.
     */
    private playbackFront: PlaybackNode[] = [];
    /**
     * Maps a PlaybackNode's ID to the ContentRenderer that has been preloaded with that node.
     */
    private preloadedRenderers: Map<number, LeasedContentRenderer> = new Map();
    /**
     * Maps a PlaybackNode's ID to the actual PlaybackNode in the playback tree.
     * 
     * If a node has an ID that isn't in this map, it's no longer in the playback tree.
     */
    private nodeTreeMap: Map<number, PlaybackNode> = new Map();
    /**
     * Maps a PlaybackNode's ID to a the ListenerGroups holding all of its listeners.
     * These listeners will all be cancelled when the node is removed from the tree.
     */
    private nodeListenersMap: Map<number, {renderer: ListenerGroup<RendererStatus, null>, node: ListenerGroup<PlaybackNodeEvent, PlaybackNode>}> = new Map();

    // -- Private playback tree control methods --

    /**
     * Push a node onto the playback front, allocate a renderer to it and begin playback.
     * @param node The node to start
     * @param renderIndex The index the node's renderer should be inserted at (0 is the bottom)
     */
    private startPlayingNode(node: PlaybackNode, renderIndex: number) {
        if (node.playbackStatus !== NodePlaybackStatus.Queued) throw Error("Tried to start a node that was not queued");

        this.playbackFront.push(node);

        //Allocate a renderer
        if (this.preloadedRenderers.has(node.id)) {
            node.renderer = this.preloadedRenderers.get(node.id);
            this.preloadedRenderers.delete(node.id);
        } else {
            node.renderer = this.rendererPool.getRenderer(node.block.media.location.getType());
        }

        //Setup renderer/node status listeners
        let nodeListener = node.createListenerGroup();
        let rendererListener = node.renderer.createListenerGroup();
        this.nodeListenersMap.set(node.id, {renderer: rendererListener, node: nodeListener});

        rendererListener.on(RendererStatus.Finished, () => this.handleNodeFinished(node));
        rendererListener.on(RendererStatus.Stalled, () => this.handleNodeStalled(node));
        rendererListener.on(RendererStatus.Error, () => this.handleNodeError(node));

        //Start concurrent children when their PlaybackOffset is reached
        let createStarterForConcurrentChild = (child: PlaybackNode) => {
            if (child.startType === RelativeStartType.Concurrent) {
                let childStarter = rendererListener.onceProgress(child.offset, () => this.startPlayingNode(child, renderIndex + 1));
                node.concurrentChildStartMap.set(child.id, childStarter);
            }
        }

        let removeStarterForConcurrentChild = (child: PlaybackNode) => {
            let starterId = node.concurrentChildStartMap.get(child.id);
            if (starterId) {
                rendererListener.offProgress(starterId);
                node.concurrentChildStartMap.delete(child.id);
            }
        }

        for (let child of node.children) {
            createStarterForConcurrentChild(child);
        }

        nodeListener.on(PlaybackNodeEvent.ChildAdded, createStarterForConcurrentChild);
        nodeListener.on(PlaybackNodeEvent.ChildRemoved, removeStarterForConcurrentChild);
        
        //Insert into render hierarchy and begin playback
        let addToHierarchyAndPlay = () => {
            this.renderHierarchy.insertRenderer(node.renderer, renderIndex);

            rendererListener.onceWithTimeout(RendererStatus.Playing, () => {
                if (node.block.transitionInMs > 0) {
                    node.setPlaybackStatus(NodePlaybackStatus.TransitioningIn);
                    rendererListener.onceProgress(new PlaybackOffset(PlaybackOffset.Type.MsAfterStart, node.block.transitionInMs), () => node.setPlaybackStatus(NodePlaybackStatus.Playing));
                } else {
                    node.setPlaybackStatus(NodePlaybackStatus.Playing);
                }
            },
            3000, () => {
                this.log.warn(`${this.nodeLogID(node)} is taking a long time to start playing`);
            });
            node.renderer.play();
        }

        if (node.renderer.getLoadedMedia() !== node.block.media) {
            //The renderer has to load the media first. Usually this would've happened earlier through preloading, but not always.
            rendererListener.onceWithTimeout(RendererStatus.Ready, addToHierarchyAndPlay, 5000, () => this.log.warn(`${this.nodeLogID(node)} is taking a long time to load`));
            node.renderer.loadMedia(node.block.media);
        } else {
            addToHierarchyAndPlay();
        }

        this.fireEvent(PlayerEvent.ActiveBlocksChanged, this.getPlayingBlocks())
    }

    /**
     * Immediately stop playback of a node, remove it from the playback front and release its renderer.
     * @param PlaybackNode The node on the playback front to stop
     */
    private stopPlayingNode(node: PlaybackNode) {
        let frontIndex = this.playbackFront.indexOf(node);
        if (!frontIndex) return; //Either index is incorrect or this node has already finished playing

        node.renderer.stopAndUnload();
        this.playbackFront.splice(frontIndex, 1);
        this.renderHierarchy.removeRenderer(node.renderer);
        node.renderer.release();

        this.cleanupRemovedNode(node);
        this.fireEvent(PlayerEvent.ActiveBlocksChanged, this.getPlayingBlocks())
    }
    
    /**
     * Cleans up any references to a node that was previously in the tree.
     * 
     * Call this function after you remove a node from the tree.
     */
    private cleanupRemovedNode(removedNode: PlaybackNode) {
        this.log.info(`${this.nodeLogID(removedNode)} was removed from tree`);
        //Remove the node from the tree map
        this.nodeTreeMap.delete(removedNode.id);
        //Cancel any listeners registered for this node
        let listenerGroups = this.nodeListenersMap.get(removedNode.id);
        if (listenerGroups) {
            listenerGroups.node.cancelAll();
            //listenerGroups.renderer.cancelAll(); -- Called when the renderer is returned
            this.nodeListenersMap.delete(removedNode.id);
        }
        //Unload any media this node may have preloaded
        if (this.preloadedRenderers.has(removedNode.id)) {
            let loadedRenderer = this.preloadedRenderers.get(removedNode.id);
            loadedRenderer.release();
            this.preloadedRenderers.delete(removedNode.id);
        }
        //TempNode cleanup
        if (this.tempNodes.has(removedNode.id)) {
            this.tempNodeProviderChildMap.get(this.tempNodeProvidedByMap.get(removedNode.id)).delete(removedNode.id);
            this.tempNodes.delete(removedNode.id);
            this.tempNodeProvidedByMap.delete(removedNode.id);
        }
    }

    /**
     * Load the media for this node into a ContentRenderer ahead of time, so that it'll be
     * hot and ready later.
     * @param node The node to preload
     * @param recursivelyLoadChildren Also preload the descendants of this node (default true)
     */
    private preload(node: PlaybackNode, recursivelyLoadChildren = true) {
        //TODO: Preloading
        this.log.warn('Track preloading not yet implemented');
    }

    // -- Node status handlers --
    private handleNodeFinished(node: PlaybackNode) : void {
        this.log.info(`${this.nodeLogID(node)} finished playback`);
        let nodeRenderIndex = this.renderHierarchy.getLayerIndex(node.renderer);

        //Find the children of this node that are queued to start after it
        let queuedChildren = node.children.filter(c => c.playbackStatus === NodePlaybackStatus.Queued);
        for (let i = queuedChildren.length - 1; i > -1; i--) {
            let child = queuedChildren[i];
            if (child.startType === RelativeStartType.Concurrent) {
                this.log.warn(`${this.nodeLogID(child)} was queued with an offset ${child.offset.type}-${child.offset.value} that was never reached`);
                queuedChildren.pop();
                node.removeChild(child);
            }
        }

        if (node.block.transitionOutMs <= 0) {
            //This node has no out transition - stop it now
            this.stopPlayingNode(node);
            node.setPlaybackStatus(NodePlaybackStatus.Finished);
        } else {
            //Start the node's out transition
            node.setPlaybackStatus(NodePlaybackStatus.TransitioningOut);
            let listeners = this.nodeListenersMap.get(node.id);

            let stop = () => { 
                this.stopPlayingNode(node);
                node.setPlaybackStatus(NodePlaybackStatus.Finished);
            };

            listeners.renderer.onceWithTimeout(RendererStatus.Idle, stop, 
                node.block.transitionOutMs + 1000, 
                () => {
                        this.log.warn(`The out transition for ${this.nodeLogID(node)} hasn't completed in time. Stopping the node now.`);
                        stop();
                    }
            );
            node.renderer.stopAndUnload();
        }

        queuedChildren.forEach((child) => this.startPlayingNode(child, nodeRenderIndex));
    }

    private handleNodeStalled(node: PlaybackNode) : void {
        this.log.info(`${this.nodeLogID(node)} is stalled`);
    }

    private handleNodeError(node: PlaybackNode) : void {
        this.log.warn(`${this.nodeLogID(node)} encountered an error`);
    }

    // -- Public player tree modifiers --

    /**
     * Add a ContentBlock to be played sequentially at the end of the player queue.
     * @param block The block to enqueue.
     * @returns A node ID representing the block's position in the queue.
     */
    public enqueueBlock(block: ContentBlock) : number {
        //Find the end of the primary path
        let queueEndNode = this.playbackFront[0];
        while (queueEndNode.children.length > 0) {
            queueEndNode = queueEndNode.children[0];
        }
        //Add this block to it
        let newNode = new PlaybackNode(this.nodeIdCounter++, block, RelativeStartType.Sequenced);
        queueEndNode.addChild(newNode);
        this.nodeTreeMap.set(newNode.id, newNode);
        this.preload(newNode);
        this.reevaluateTempNodes();
        this.fireEvent(PlayerEvent.PlayQueueChanged, this.getQueue());
        return newNode.id;
    }

    /**
     * Enqueue a block to start playing before, after or during a block already in the tree.
     * @param block The block to enqueue
     * @param relativeTarget Enqueue the new block relative to this one
     * @param startType Should the new block start playing after or during the target block
     * @param offset (Optional) Describes when the new block should start playing relative to the target. Defaults to playing sequentially, at the end of the target block
     */
    public enqueueBlockRelative(block: ContentBlock, relativeTarget: EnqueuedContentBlock, startType: RelativeStartType, offset?: PlaybackOffset) : EnqueuedContentBlock {
        let createdNode = new PlaybackNode(this.nodeIdCounter++, block, startType, offset);
        let targetNode = this.nodeTreeMap.get(relativeTarget.queueId);

        if (targetNode == null) {
            return null;
        }

        if (startType === RelativeStartType.Sequenced) {
            this.primarySpliceNodeIn(targetNode, createdNode);
        } else if (startType === RelativeStartType.Concurrent) {
            targetNode.addChild(createdNode);
        }

        this.nodeTreeMap.set(createdNode.id, createdNode);
        this.preload(createdNode);
        this.fireEvent(PlayerEvent.PlayQueueChanged, this.getQueue());
        return new EnqueuedContentBlock(createdNode);
    }

    /**
     * Remove a ContentBlock from the player queue.
     * @param queuedNodeId Node ID of the block to remove
     */
    public dequeueNode(queuedNodeId: number) {
        //Find this node in the tree
        let targetNode = this.nodeTreeMap.get(queuedNodeId);
        if (!targetNode) return;

        if (targetNode.playbackStatus !== NodePlaybackStatus.Queued) {
            return; //Cannot remove a node that's currently playing (the UI shouldn't allow this anyway)
        }

        //Splice this node out of the queue
        this.primarySpliceNodeOut(targetNode);
        this.cleanupRemovedNode(targetNode);

        this.reevaluateTempNodes();
        this.fireEvent(PlayerEvent.PlayQueueChanged, this.getQueue());
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
        if (!targetNode || targetNode.playbackStatus !== NodePlaybackStatus.Queued) return false;

        //Unload if preloaded
        if (this.preloadedRenderers.has(targetNode.id)) {
            let preloadedRenderer = this.preloadedRenderers.get(targetNode.id);
            preloadedRenderer.release();
            this.preloadedRenderers.delete(targetNode.id);
        }

        targetNode.block = newBlock;
        this.preload(targetNode);
        this.fireEvent(PlayerEvent.PlayQueueChanged, this.getQueue());
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
        if (!nodeToMove || !targetNode || !nodeToMove.parent) return false;
        if (nodeToMove.playbackStatus === NodePlaybackStatus.Playing) return false;

        //Splice nodeToMove out of the queue -- [A] -> [B] -> [C]
        this.primarySpliceNodeOut(nodeToMove);

        if (placeBefore) {
            //Splice nodeToMove into the queue between targetNode and targetNode's parent
            this.primarySpliceNodeIn(targetNode.parent, nodeToMove);
        } else {
            //Splice nodeToMove into the queue between targetNode and targetNode's first child
            this.primarySpliceNodeIn(targetNode, nodeToMove);
        }

        this.reevaluateTempNodes();
        this.fireEvent(PlayerEvent.PlayQueueChanged, this.getQueue());
        return true;
    }

    //The queue starts at the 0th child of the playback front and goes to the end of the tree
    public getQueue() : EnqueuedContentBlock[] { //OPT - cache this
        let queue: EnqueuedContentBlock[] = [];
        let queueStart = this.playbackFront[0];

        if (queueStart == null) return queue;

        if (queueStart.playbackStatus != NodePlaybackStatus.Queued) {
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

    // -- Queue modification helpers --

    //Walk backwards up a path of single-children nodes, culling them until a branch (node with multiple children) is reached.
    //Returns the branch node at the top of the path or null if the entire tree is a single-child path.
    private cullBackToBranch(pathEndNode: PlaybackNode) : PlaybackNode | null {
        let node = pathEndNode;
        while (node.parent != null) {
            let parent = node.parent;
            if (parent.children.length == 1) {
                //Parent is a single-child node, the path continues upwards
                this.cleanupRemovedNode(parent.children[0]);
                parent.removeChildAtIndex(0);
                node = parent;
            } else {
                //Parent is a branch node with multiple children - the path ends here
                //Remove the current node (part of the single-child path) from the parent
                parent.removeChild(node);
                this.cleanupRemovedNode(node);
                //Return the parent node
                return parent;
            }
        }

        //No branching parent could be found; the whole tree is single-child
        return null;
    }

    /**
     * Remove a node from the tree and attach its primary child to its parent. Like an array splice but only for the primary child.
     * @param targetNode The node to remove from the tree
     */
    private primarySpliceNodeOut(targetNode: PlaybackNode) {
        //Remove [targetNode] from [A] -> [targetNode] -> [B]
        let targetNodeParent = targetNode.parent;
        targetNode.parent.removeChild(targetNode); // [A]
        if (targetNode.children.length > 0) {
            let primaryChild = targetNode.children[0]; // [targetNode] -> [B]
            targetNode.removeChild(primaryChild); // [targetNode]
            targetNodeParent.insertChild(primaryChild, 0); // [A] -> [B]
        }
    }
    
    /**
     * Insert a node into the tree between a parent node and its primary child.
     * @param parentNode The parent node already in the tree
     * @param inNode The node to add to the tree
     */
    private primarySpliceNodeIn(parentNode: PlaybackNode, inNode: PlaybackNode) {
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

    // -- TempNodeProvider handling --
    /*
        TempNodeProviders are functions that accept the player queue and return a list of 'temperamental' nodes to be inserted.
        The primary use of TempNodeProviders is in user-defined rules that enqueue certain ContentBlocks every time 
        a condition is met, like "play this stinger graphic every 3rd block".
        The nodes they provide are called temperamental because, although they are added into the tree like normal
        nodes, they are removed whenever the tree is modified by an external source. For example, a user adding/removing
        a ContentBlock would require the "every 3rd block" rule to be reevaluated.
    */

    private tempNodes: Map<number, PlaybackNode> = new Map(); //Maps node ID to a TempNode somewhere in the tree. Can be used to test if a node is temperamental
    private tempNodeProvidedByMap: Map<number, number> = new Map(); //Maps a TempNode's ID to the ID of the TempNodeProvider it came from
    private tempNodeProviderChildMap: Map<number, Map<number, PlaybackNode>> = new Map(); //Maps TempNodeProvider ID to a map of all the TempNodes it's responsible for
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
            if (tempNode.parent.children.indexOf(tempNode) === 0) {
                //This is a primary node in the queue, so splice it out
                this.primarySpliceNodeOut(tempNode)
            } else {
                //This is a secondary node springing off from the queue, so just cut it from the tree
                tempNode.parent.removeChild(tempNode);
            }
            this.cleanupRemovedNode(tempNode);
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

        this.playbackFront.forEach((node) => {
            activeBlocks[this.renderHierarchy.getLayerIndex(node.renderer)] = new ContentBlockWithProgress(node, Date.now() - node.playbackStatusTimestamp);
        })
        
        return activeBlocks;
    }

    /**
     * Pretty-print a node for logging.
     */
    private nodeLogID(node: PlaybackNode) : string {
        return `${node.id}-${node.block.id}(${node.block.media.name})`;
    }

    //Control panel requests

    @ControlPanelRequest('getPlayingBlocks')
    private getPlayingRequest() : WSPendingResponse {
        return new WSSuccessResponse(this.getPlayingBlocks()); //TODO: Update ContentBlocksWithProgress to include the node's playback status - the client side should be able to display this
    }

    @ControlPanelRequest('getQueue')
    private getQueueRequest() : WSPendingResponse {
        return new WSSuccessResponse(this.getQueue());
    }

    @ControlPanelRequest('skipForward')
    private skipForward() : WSPendingResponse { //Skip to the next node on the primary path
        if (this.playbackFront[0].children.length == 0) {
            return new WSErrorResponse('QueueEmpty', 'Nothing to skip to - the queue is empty');
        }

        let currentNode = this.playbackFront[0];
        this.log.info(`Skipping node ${this.nodeLogID(currentNode)}`);
        this.handleNodeFinished(currentNode); //Fire the finished handler for this node right now
        return new WSSuccessResponse("Skipped");
    }

    @ControlPanelRequest('stopToTitle')
    private stopToTitleRequest() : WSPendingResponse {
        let primaryNode = this.playbackFront[0];

        if (primaryNode.block.id == this.defaultBlock.id) {
            return new WSErrorResponse('AlreadyStopped', 'The default title block is already playing');
        }
        this.log.info('Stopping to default block');

        //Stop playback of all branches except the primary one
        for (let i = this.playbackFront.length - 1; i > 0; i--) {
            this.stopPlayingNode(this.playbackFront[i]);
        }

        //Set up a default node with the existing play queue attached to it
        let defaultNode = new PlaybackNode(this.nodeIdCounter++, this.defaultBlock, RelativeStartType.Sequenced);
        this.nodeTreeMap.set(defaultNode.id, defaultNode);

        if (primaryNode.children.length > 0) {
            //Pull the current queue off the primary node
            let nextInPrimaryQueue = primaryNode.children[0];
            //Remove all children from the primary node
            for (let i = primaryNode.children.length - 1; i > 0; i--) {
                primaryNode.removeChildAtIndex(i);
            }

            //Patch the queue on to the end of the default node
            defaultNode.addChild(nextInPrimaryQueue);
        }

        this.startPlayingNode(defaultNode, 0);

        if (defaultNode.block.transitionInMs > 0) {
            /*
             The default block has an in transition (eg. 1s fade).
             We will set the out transition time of the primaryNode to match
             this, so that it will keep playing until the default block's transition is finished.
            */
           primaryNode.block.transitionOutMs = defaultNode.block.transitionInMs;
        }

        this.handleNodeFinished(primaryNode);

        this.fireEvent(PlayerEvent.ActiveBlocksChanged, this.getPlayingBlocks())

        return new WSSuccessResponse('Stopped');
    }

    @ControlPanelRequest('restartBlock')
    private restartPlaybackRequest() : WSPendingResponse {
        //Restart the current primary node
        let currentNode = this.playbackFront[0];
        let nListener = this.nodeListenersMap.get(currentNode.id);

        this.log.info('Restarting current block')
        currentNode.renderer.restart();
        this.fireEvent(PlayerEvent.ActiveBlocksChanged, this.getPlayingBlocks());

        return new WSSuccessResponse('Restarted');
    }

    @ControlPanelRequest('queueChange', QueueChange.isInstance)
    private scheduleChangeRequest(requestedChange: QueueChange) : WSPendingResponse {
        if (requestedChange.queueIdTarget === -1) {
            //This is a delete request
            this.dequeueNode(requestedChange.queueIdToMove);
            return new WSSuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} removed`);
        } else {
            //This is a reorder request
            let success = this.reorderQueuedNode(requestedChange.queueIdToMove, requestedChange.queueIdTarget, requestedChange.placeBefore);
            if (success) {
                return new WSSuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} moved`);
            } else {
                return new WSErrorResponse('Invalid queue IDs');
            }
        }
    }

    @ControlPanelRequest('updateContentBlock', AcceptAny)
    private updateBlockRequest(data: any): WSPendingResponse {
        return new Promise((resolve, reject) => {
            //Try to create a new content block from the provided one
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                contentBlock.id = data.block.id; //Replace the generated id with the target id
                if (this.updateQueuedNode(data.block.queuedId, contentBlock)) {
                    resolve(new WSSuccessResponse(`Updated block with id ${contentBlock.id}`));
                } else {
                    reject(new WSErrorResponse('Invalid target block'));
                };
            }).catch(error => {
                console.error('Failed to create content block from request:', error);
                reject(error);
            });
        });
    }

    @ControlPanelRequest('addContentBlock', AcceptAny)
    private addContentBlockRequest(data: any) : WSPendingResponse {
        return new WSErrorResponse('NotImplemented');

/*         return new Promise((resolve, reject) => {
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                this.rerunState.player.enqueueBlock(contentBlock);
                resolve(new SuccessResponse(`Enqueued content block ${data.block.id}`));
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

/**
 * A point in time during the playback of some media.
 */
export class PlaybackOffset {
    constructor(
        readonly type: PlaybackOffset.Type,
        readonly value: number
    ) {
        if (type === PlaybackOffset.Type.Percentage && (value < 0 || value > 1)) throw new RangeError("Percentage offsets must be between 0 and 1");
    };

    public evaluate(durationMs: number) {
        if (this.type === PlaybackOffset.Type.MsAfterStart) {
            return this.value;
        } else if (this.type === PlaybackOffset.Type.MsBeforeEnd) {
            return durationMs - this.value;
        } else if (this.type === PlaybackOffset.Type.Percentage) {
            return durationMs * (this.value / 100);
        } else {
            throw new Error("Unsupported PlaybackOffset type");
        }
    }
}

export namespace PlaybackOffset {
    export enum Type { MsAfterStart = 'After start', MsBeforeEnd = 'Before end', Percentage = 'Percentage' }
}

//Accepts the current queue of blocks and returns a list of blocks to add
export type TempNodeProvider = (queue: EnqueuedContentBlock[]) => {
    block: ContentBlock; 
    relativeTarget: EnqueuedContentBlock;
    startRelationship: RelativeStartType;
    offset?: PlaybackOffset;
}[];

/**
 * Specifies how a child block should play relative to its parent block.
 */
export enum RelativeStartType {
    /**
     * The child should play after the parent.
     */
    Sequenced,
    /**
     * The child should play at some point during the parent's playback.
     */
    Concurrent,
}

//A ContentBlock linked to a node in the PlaybackTree (by node id). Allows users to enqueue a block relative to an existing one
export class EnqueuedContentBlock extends ContentBlock {
    readonly queueId: number;
    constructor(node: PlaybackNode) {
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
    constructor(node: PlaybackNode, playbackProgressMs: number) {
        super(node);
        this.progressMs = playbackProgressMs;
    }

    toJSON() {
        let j = super.toJSON();
        j.progressMs = this.progressMs;
        return j;
    }
}