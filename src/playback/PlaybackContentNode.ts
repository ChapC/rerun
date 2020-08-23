import { ContentBlock } from "./ContentBlock";
import { PlaybackRelationship } from "./Player";

//A node in the Player's playback tree
export default class PlaybackContentNode {
    private playbackStatus: NodePlaybackStatus;
    playbackStatusTimestamp: number; //Timestamp of the last time playbackStatus was modified
    parentNode: PlaybackContentNode = null;
    children: PlaybackContentNode[] = [];

    constructor(public block: ContentBlock,
                readonly id: number,
                readonly playbackRelationship: PlaybackRelationship, 
                readonly playbackOffsetMs = 0 //A positive offset indicates playback should begin (n)ms after the start of the parent, a negative offset means (n)ms before the end of the parent
                ) {                           //If playbackRelationship is Sequenced, this value is ignored
        this.setPlaybackStatus(NodePlaybackStatus.Queued);
    }

    addChild(child: PlaybackContentNode) {
        this.children.push(child);
        child.parentNode = this;
    }

    removeChild(child: PlaybackContentNode) {
        let childIndex = this.children.findIndex(c => c.id == child.id);
        if (childIndex != -1) {
            this.children.splice(childIndex, 1);
            child.parentNode = null;
        }
    }

    insertChild(child: PlaybackContentNode, index: number) {
        this.children.splice(index, 0, child);
        child.parentNode = this;
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

    //The effective duration is the length of the underlying MediaObject plus any transition time
    getEffectiveDuration() : number { 
        return this.block.transitionInMs + this.block.media.durationMs + this.block.transitionOutMs; //TODO: When playback modifiers are added, this will need to be updated
    }
}

export enum NodePlaybackStatus { Queued = 'Queued', TransitioningIn = 'TransitionIn', Playing = 'Playing', TransitioningOut = 'TransitionOut', Finished = 'Finished' };