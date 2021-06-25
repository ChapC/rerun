import { MediaObject } from '../MediaObject';
import { OBSSource } from '../../../obs/RerunOBSBinding'
import { ControllableSingleListenable } from '../../helpers/SingleListenable';
import { PlaybackOffset } from '../Player';
import { ListenerGroup, MultiListenable } from '../../helpers/MultiListenable';

//Describes a renderer that can display certain content types
export abstract class ContentRenderer extends MultiListenable<RendererStatus, null> {
    readonly id: number;
    readonly supportedContentType: MediaObject.ContentType;

    // Public playback-related functions
    /**
     * Prepare content for playback by loading it into the renderer.
     * @param media The MediaObject to load
     */
    abstract loadMedia(media:MediaObject) : void; //Prepare the renderer for playback
    /**
     * Get the current media loaded in the renderer.
     * @returns A MediaObject or null if nothing is loaded
     */
    abstract getLoadedMedia() : MediaObject | null; //Return the media object that's currently loaded

    /**
     * Begin playback of the media currently loaded in the renderer.
     * 
     * If the media has an in transition, this method will start it.
     */
    abstract play() : void;
    /**
     * Stop playback and unload media.
     * 
     * If the media has an out transition, this method will start it.
     */
    abstract stopAndUnload() : void;
    /**
     * Restart playback.
     */
    abstract restart() : void;
    /**
     * Get the playback progress in milliseconds.
     */
    //abstract getPlaybackProgressMs() : Promise<number>;
    
    // Observers
    private status: RendererStatus = RendererStatus.Idle;
    private statusLastUpdatedAt = Date.now();
    private statusListenable = new ControllableSingleListenable<RendererStatusChange>();
    /**
     * Get the current status of the renderer.
     */
    public getStatus() { return this.status; }

    /**
     * Get the time that the renderer last updated its status.
     */
    public getStatusUpdatedTimestamp() { return this.statusLastUpdatedAt };

    /**
     * Register a callback that fires whenever RendererPlaybackStatus updates.
     */
    public onStatusUpdated(callback: (s: RendererStatusChange) => void) : number {
        return this.statusListenable.addChangeListener(callback);
    }

    public offStatusUpdated(listenerId: number) {
        this.statusListenable.removeChangeListener(listenerId);
    }

    protected updateStatus(newStatus: RendererStatus) {
        let oldStatus = this.status;
        this.status = newStatus;
        this.statusListenable.trigger({ oldStatus: oldStatus, newStatus: newStatus });
        this.statusLastUpdatedAt = Date.now();
        this.fireEventNow(newStatus, null);
    }

    /**
     * Register a callback that fires once when playback progress reaches a certain point.
     * @param progress When during playback the callback should be fired
     */
    public abstract onceProgress(progress: PlaybackOffset, callback: () => void) : number;
    public abstract offProgress(listenerId: number) : void;

    //Override of createListenerGroup that returns an extended ListenerGroup which supports the onceProgress and offProgress methods
    public createListenerGroup() : ContentRendererListenerGroup {
        return new ContentRendererListenerGroup(this);
    }

    public cancelAllListeners() : void {
        super.cancelAllListeners();
        this.statusListenable.cancelAllListeners();
    }

    abstract getOBSSource(): OBSSource; //I wanted the content system (at the abstract level) to be separated from OBS but that seems way too complicated :/
}

export type RendererStatusChange = { oldStatus: RendererStatus, newStatus: RendererStatus };

export enum RendererStatus { 
    /**
     * Nothing is loaded and the renderer isn't doing anything
     */
    Idle = "idle",
    /**
     * Media is being loaded into the renderer
     */
    Loading = 'loading',
    /**
     * Media is loaded and the renderer is ready to start playing it
     */
    Ready = 'ready',
    /**
     * Media is playing
     */ 
    Playing = "playing",
    /**
     * The renderer is attempting to play but is loading/buffering
     */
    Stalled = "stalled",
    /**
     * Playback has finished and the media is still loaded
     */
    Finished = "finished",
    /**
     * An error occurred that renderer could not recover from
     */
    Error = "error"
};

//ListenerGroup extension
export class ContentRendererListenerGroup extends ListenerGroup<RendererStatus, null> {
    private progressListeners: Set<number> = new Set();

    constructor(private parentRenderer: ContentRenderer) {
        super(parentRenderer);
    }

    /**
     * Register a callback that fires once when playback progress reaches a certain point.
     * @param progress When during playback the callback should be fired
    */
    public onceProgress(progress: PlaybackOffset, callback: () => void) : number {
        const modifiedCallback = () => {
            this.progressListeners.delete(listenerId);
            callback();
        };
        
        let listenerId =  this.parentRenderer.onceProgress(progress, modifiedCallback);
        this.progressListeners.add(listenerId);
        return listenerId;
    }

    public offProgress(listenerId: number) : void {
        this.parentRenderer.offProgress(listenerId);
        this.progressListeners.delete(listenerId);
    }

    public cancelAll() : void {
        super.cancelAll();
        for (let progressL of this.progressListeners) {
            this.parentRenderer.offProgress(progressL);
        }
        this.progressListeners.clear();
    }
}