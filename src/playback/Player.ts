import {ContentBlock} from './ContentBlock';
import {PublicRerunComponents} from '../index';
import {ListenerGroup, MultiListenable} from '../helpers/MultiListenable';
import PrefixedLogger from '../helpers/PrefixedLogger';
import PlaybackNode, { NodePlaybackStatus, PlaybackNodeEvent } from './PlaybackNode';
import RendererPool, { LeasedContentRenderer } from './renderers/RendererPool';
import RenderHierarchy from './renderers/RenderHierarchy';
import { RendererStatus } from './renderers/ContentRenderer';

export enum PlayerEvent { TreeChanged };
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

        node.children.map(createStarterForConcurrentChild)

        nodeListener.on(PlaybackNodeEvent.ChildAdded, createStarterForConcurrentChild);
        nodeListener.on(PlaybackNodeEvent.ChildRemoved, removeStarterForConcurrentChild);
        nodeListener.on(PlaybackNodeEvent.StatusChanged, () => this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot()));
        
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
            this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
        }

        if (node.renderer.getLoadedMedia() !== node.block.media) {
            //The renderer has to load the media first. Usually this would've happened earlier through preloading, but not always.
            rendererListener.onceWithTimeout(RendererStatus.Ready, addToHierarchyAndPlay, 5000, () => this.log.warn(`${this.nodeLogID(node)} is taking a long time to load`));
            node.renderer.loadMedia(node.block.media);
        } else {
            addToHierarchyAndPlay();
        }
    }

    /**
     * Immediately stop playback of a node, remove it from the playback front and release its renderer.
     * @param PlaybackNode The node on the playback front to stop
     */
    private stopPlayingNode(node: PlaybackNode) {
        let frontIndex = this.playbackFront.indexOf(node);
        if (frontIndex == -1) return; //Either index is incorrect or this node has already finished playing

        node.renderer.stopAndUnload();
        this.playbackFront.splice(frontIndex, 1);
        this.renderHierarchy.removeRenderer(node.renderer);
        node.renderer.release();

        this.cleanupRemovedNode(node);
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
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
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
        return newNode.id;
    }

    /**
     * Enqueue a block to start playing before, after or during a block already in the tree.
     * @param block The block to enqueue
     * @param relativeTarget Enqueue the new block relative to this one
     * @param startType Should the new block start playing after or during the target block
     * @param offset (Optional) Describes when the new block should start playing relative to the target. Defaults to playing sequentially, at the end of the target block
     * 
     * @returns A snapshot of the created PlaybackNode
     */
    public enqueueBlockRelative(block: ContentBlock, relativeTarget: PlaybackNodeSnapshot, startType: RelativeStartType, offset?: PlaybackOffset) : PlaybackNodeSnapshot {
        let createdNode = new PlaybackNode(this.nodeIdCounter++, block, startType, offset);
        let targetNode = this.nodeTreeMap.get(relativeTarget.id);

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
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());

        return new PlaybackNodeSnapshot(createdNode);
    }

    /**
     * Remove a queued node from the player tree.
     * @param queuedNodeId Id of the node to remove
     */
    public dequeueNode(queuedNodeId: number) {
        //Find this node in the tree
        let targetNode = this.nodeTreeMap.get(queuedNodeId);
        if (!targetNode) return;

        if (targetNode.playbackStatus !== NodePlaybackStatus.Queued) {
            throw new ModifyingActiveNodeError(targetNode); //Cannot remove a node that's currently playing (the UI shouldn't allow this anyway)
        }

        //Splice this node out of the queue
        this.primarySpliceNodeOut(targetNode);
        this.cleanupRemovedNode(targetNode);

        this.reevaluateTempNodes();
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
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
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
        return true;
    }

    /**
     * Skip to the end of a playing node. If the target node has consecutive children, they will start playing immediately.
     * 
     * Any queued concurrent children will also be skipped.
     * @param targetNodeId Id of node to skip
     */
    public skip(targetNodeId: number) {
        let targetNode = this.playbackFront.find(n => n.id === targetNodeId);
        if (targetNode == null) throw new UnknownNodeIdError(targetNodeId);

        this.log.info(`Skipping node ${this.nodeLogID(targetNode)}`);
        this.handleNodeFinished(targetNode);
    }

    /**
     * Restart playback of a node that's currently playing.
     * @param targetNodeId Id of node to restart
     */
    public restart(targetNodeId: number) {
        let targetNode = this.playbackFront.find(n => n.id === targetNodeId);
        if (targetNode == null) throw new UnknownNodeIdError(targetNodeId);

        this.log.info(`Restarting node ${this.nodeLogID(targetNode)}`)
        targetNode.renderer.restart();
        this.fireEventAsync(PlayerEvent.TreeChanged, this.getTreeSnapshot());
    }

    /**
     * Stop playback of all nodes and display the default title block.
     * 
     * Sequential children of the primary node will be retained, all other queued nodes will be lost.
     */
    public stopAll() {
        let primaryNode = this.playbackFront[0];
        if (primaryNode.block.id === this.defaultBlock.id) return;
        this.log.info('Stopping to default block');

        //Stop playback of all branches except the primary one
        for (let i = this.playbackFront.length - 1; i > 0; i--) {
            this.stopPlayingNode(this.playbackFront[i]);
        }

        //Set up a default title node with the existing play queue attached to it
        let defaultNode = new PlaybackNode(this.nodeIdCounter++, this.defaultBlock, RelativeStartType.Sequenced);
        this.nodeTreeMap.set(defaultNode.id, defaultNode);

        if (primaryNode.children.length > 0) {
            //Pull the current queue off the primary node
            let nextInPrimaryQueue = primaryNode.children[0];
            //Remove all children from the primary node
            for (let i = primaryNode.children.length - 1; i > -1; i--) {
                primaryNode.removeChildAtIndex(i);
            }

            //Patch the queue on to the end of the default node
            defaultNode.addChild(nextInPrimaryQueue);
        }

        this.startPlayingNode(defaultNode, this.renderHierarchy.getLayerIndex(primaryNode.renderer) + 1);

        if (defaultNode.block.transitionInMs > 0) {
            setTimeout(() => {this.stopPlayingNode(primaryNode)}, defaultNode.block.transitionInMs + 100);
        } else {
            this.stopPlayingNode(primaryNode);
        }
    }

    /**
     * Get a snapshot of the player's current tree state.
     * @remarks To observe the tree, listen for the TreeChanged event.
     */
    public getTreeSnapshot() : PlaybackNodeSnapshot[] {
        return this.playbackFront.map(node => new PlaybackNodeSnapshot(node));
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

        let providedBlocks = this.tempNodeProviders.get(providerId)(this.getTreeSnapshot()); //Poll the provider for content

        for (let provided of providedBlocks) {
            //Enqueue the provided block
            let enqueuedProvided = this.enqueueBlockRelative(provided.block, provided.relativeTarget, provided.startRelationship, provided.offset);
            //Mark the node as a TempNode by adding it to our structures
            let tempNode = this.nodeTreeMap.get(enqueuedProvided.id);
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
        this.log.warn('TempNodes disabled');
        return 0;
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
    public onRecurringProgress(progress: PlaybackOffset, callback: (duringBlock: PlaybackNodeSnapshot) => void) : number {
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
     * Pretty-print a node for logging.
     */
    private nodeLogID(node: PlaybackNode) : string {
        return `${node.id}-${node.block.id}(${node.block.media.name})`;
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
export type TempNodeProvider = (queue: PlaybackNodeSnapshot[]) => {
    block: ContentBlock; 
    relativeTarget: PlaybackNodeSnapshot;
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

/**
 * A read-only snapshot of a PlaybackNode taken at a certain time.
 */
export class PlaybackNodeSnapshot {
    readonly id: number;  
    readonly status: NodePlaybackStatus;
    readonly timestamp: number;

    readonly startType: RelativeStartType; 
    readonly offset: PlaybackOffset;

    readonly children: PlaybackNodeSnapshot[];
    readonly block: ContentBlock;

    constructor(node: PlaybackNode) {
        this.id = node.id;
        this.status = node.playbackStatus;
        this.timestamp = node.playbackStatusTimestamp;

        this.startType = node.startType;
        this.offset = node.offset;

        this.children = node.children.map((child: PlaybackNode) => new PlaybackNodeSnapshot(child));

        this.block = node.block;
    }
}

export class UnknownNodeIdError extends Error {
    constructor(readonly unknownNodeId: number) {
        super(`Unknown node id ${unknownNodeId}`);
    }

    static isInstance(something: any) : something is UnknownNodeIdError {
        return typeof something.unknownNodeId === 'number';
    }
}

export class ModifyingActiveNodeError extends Error {
    readonly targetNodeStatus: NodePlaybackStatus;
    constructor(activeNode: PlaybackNode) {
        super(`Cannot modify the target node while it is in the ${activeNode.playbackStatus} state`);
        this.targetNodeStatus = activeNode.playbackStatus;
    }

    static isInstance(something: any) : something is ModifyingActiveNodeError {
        return something.targetNodeStatus != null;
    }
}