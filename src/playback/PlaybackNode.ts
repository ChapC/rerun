import { MultiListenable } from "../helpers/MultiListenable";
import { ContentBlock } from "./ContentBlock";
import { PlaybackOffset, RelativeStartType } from "./Player";
import { LeasedContentRenderer } from "./renderers/RendererPool";

//A node in the Player's playback tree
export default class PlaybackNode extends MultiListenable<PlaybackNodeEvent, PlaybackNode> {
    private _playbackStatus: NodePlaybackStatus;
    private _playbackStatusTimestamp: number; //Timestamp of the last time playbackStatus was modified

    public get playbackStatus() : NodePlaybackStatus { return this._playbackStatus; }

    public get playbackStatusTimestamp() : number { return this._playbackStatusTimestamp; }

    private _parent: PlaybackNode = null;
    private _children: PlaybackNode[] = [];

    public get children() : PlaybackNode[] { return [...this._children]; }

    public get parent() : PlaybackNode { return this._parent; }    

    /**
     * The ContentBlock this node will play.
     */
    public block: ContentBlock;
    /**
     * The ContentRenderer this node is currently loaded into. Will be `null` if this node isn't loaded anywhere.
     */
    public renderer: LeasedContentRenderer;

    /**
     * @param id A unique identifier for this node
     * @param block The ContentBlock this node will play
     * @param startType When this node should start playing relative to its parent (Sequential or Concurrent)
     * @param offset (Only for concurrent starts) Time during the parent's playback when this node should start
     */
    constructor(readonly id: number, block: ContentBlock, readonly startType: RelativeStartType, readonly offset: PlaybackOffset = null) {
        super();
        if (startType == RelativeStartType.Concurrent && offset == null) {
            throw new Error("A PlaybackOffset must be specified for nodes with a concurrent start type");
        } 
        this.block = block;
        this.setPlaybackStatus(NodePlaybackStatus.Queued);
    }

    /**
     * Used to store the listener for concurrent children that begins their playback.
     * The player adds and removes listeners from this map as needed.
     */
    readonly concurrentChildStartMap: Map<number, number> = new Map();

    addChild(child: PlaybackNode) {
        this._children.push(child);
        child._parent = this;
        this.fireEvent(PlaybackNodeEvent.ChildAdded, child);
    }

    removeChild(child: PlaybackNode) {
        let childIndex = this._children.findIndex(c => c.id === child.id);
        this.removeChildAtIndex(childIndex);
    }

    removeChildAtIndex(index: number) {
        if (index > -1 && index < this._children.length) {
            let child = this._children.splice(index, 1)[0];
            child._parent = null;
            this.fireEvent(PlaybackNodeEvent.ChildRemoved, child);
        } else {
            throw new RangeError("Child index out of bounds");
        }
    }

    insertChild(child: PlaybackNode, index: number) {
        this._children.splice(index, 0, child);
        child._parent = this;
        this.fireEvent(PlaybackNodeEvent.ChildAdded, child);
    }

    setPlaybackStatus(newStatus: NodePlaybackStatus) {
        this._playbackStatus = newStatus;
        this._playbackStatusTimestamp = Date.now();
    }

    /**
     * Return the duration of this node's underlying MediaObject plus any transition time.
     */
    getEffectiveDuration() : number { 
        return this.block.transitionInMs + this.block.media.durationMs + this.block.transitionOutMs; //TODO: When playback modifiers are added, this will need to be updated
    }
}

export enum NodePlaybackStatus { Queued = 'Queued', TransitioningIn = 'TransitionIn', Playing = 'Playing', TransitioningOut = 'TransitionOut', Finished = 'Finished' }
export enum PlaybackNodeEvent { ChildAdded, ChildRemoved }