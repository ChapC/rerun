import { ContentBlock } from "./ContentBlock";

//A node in the Player's playback tree
export default class PlaybackContentNode {
    private playbackStatus: NodePlaybackStatus;
    playbackStatusTimestamp: number; //Timestamp of the last time playbackStatus was modified
    parentNode: PlaybackContentNode = null;
    children: PlaybackContentNode[] = [];

    constructor(public block: ContentBlock,
                readonly id: number,
                readonly offset: PlaybackOffset = null //Indicates when the node should start relative to the parent. Null means no offset - play sequentially
    ) {
        this.setPlaybackStatus(NodePlaybackStatus.Queued);
    }

    pendingOffsetChildren: PlaybackContentNode[] = []; 
    //Maintains a list of children with playback offsets that haven't been started yet
    //The player will remove children from here when they're started

    addChild(child: PlaybackContentNode) {
        this.children.push(child);
        child.parentNode = this;

        if (child.hasOffset() && child.getPlaybackStatus() === NodePlaybackStatus.Queued) {
            this.pendingOffsetChildren.push(child);
        }
    }

    removeChild(child: PlaybackContentNode) {
        let childIndex = this.children.findIndex(c => c.id == child.id);
        if (childIndex != -1) {
            this.children.splice(childIndex, 1);
            child.parentNode = null;
        }

        if (child.hasOffset()) {
            this.pendingOffsetChildren.splice(this.pendingOffsetChildren.findIndex(c => c.id == child.id));
        }
    }

    insertChild(child: PlaybackContentNode, index: number) {
        this.children.splice(index, 0, child);
        child.parentNode = this;

        if (child.hasOffset() && child.getPlaybackStatus() === NodePlaybackStatus.Queued) {
            this.pendingOffsetChildren.push(child);
        }
    }

    getPlaybackStatus() {
        return this.playbackStatus;
    }
    getPlaybackStatusTimestamp() {
        return this.playbackStatusTimestamp;
    }
    setPlaybackStatus(newStatus: NodePlaybackStatus) {
        this.playbackStatus = newStatus;
        this.playbackStatusTimestamp = Date.now();
    }

    hasOffset() : boolean {
        return this.offset != null;
    }

    //The effective duration is the length of the underlying MediaObject plus any transition time
    getEffectiveDuration() : number { 
        return this.block.transitionInMs + this.block.media.durationMs + this.block.transitionOutMs; //TODO: When playback modifiers are added, this will need to be updated
    }
}

export class PlaybackOffset {
    constructor(
        readonly type: PlaybackOffset.Type,
        readonly value: number
    ) {
        if (type === PlaybackOffset.Type.Percentage && (value < 0 || value > 1)) throw new RangeError("Percentage offsets must be between 0 and 1");
    };
}

export namespace PlaybackOffset {
    export enum Type { MsAfterStart, MsBeforeEnd, Percentage }
}

export enum NodePlaybackStatus { Queued = 'Queued', TransitioningIn = 'TransitionIn', Playing = 'Playing', TransitioningOut = 'TransitionOut', Finished = 'Finished' };