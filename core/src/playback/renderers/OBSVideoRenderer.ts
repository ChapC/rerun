import { MediaObject } from '../MediaObject';
import { ContentRenderer, RendererStatus } from './ContentRenderer';
import { OBSSource, OBSBool, OBSString, OBSArray, OBSDataObject, OBSDataValue } from '../../../obs/RerunOBSBinding';
import { PlaybackOffset } from '../Player';

//Controls an OBS VLC source
export class OBSVideoRenderer extends ContentRenderer {
    readonly supportedContentType = MediaObject.ContentType.LocalFile; 
    private vlcSource: OBSSource;
    constructor(readonly id: number, source: OBSSource) {
        super();
        this.vlcSource = source;

        this.vlcSource.on('media_ended', () => {
            console.info('OBSVIDEO - media_ended');
            this.updateStatus(RendererStatus.Finished);
        });
    }

    private currentMedia: MediaObject = null;

    loadMedia(media:MediaObject) : void {
        /* OBS needs to always reload the block so that if the same video is playing it'll restart
        if (this.currentMedia != null && media.location.path === this.currentMedia.location.path) {
            return Promise.resolve(); //This media is already loaded
        }
        */

        this.vlcSource.setEnabled(false); //Stop the file from playing right away
        //Add the file to the playlist
        this.vlcSource.updateSettings(new VLCSettings([ new VLCPlaylistItem(media.location.getPath()) ]));
        this.currentMedia = media;

        this.updateStatus(RendererStatus.Ready); //TODO: Should go Loading -> Ready, but not sure how to get that info from OBS yet
    }

    stopAndUnload() : void {
        this.vlcSource.stopMedia();
        this.vlcSource.setEnabled(false);
        this.vlcSource.updateSettings(new VLCSettings([ ]));
        this.currentMedia = null;
        this.updateStatus(RendererStatus.Idle);
    }

    getLoadedMedia() : MediaObject {
        return this.currentMedia;
    }

    getPlaybackProgressMs() : number {
        return this.vlcSource.getMediaTime();
    }

    onceProgress(progress: PlaybackOffset, callback: () => void) : number {
        return this.vlcSource.onceMediaTime(progress.evaluate(this.currentMedia.durationMs), callback);
    }

    offProgress(listenerId: number) {
        this.vlcSource.offMediaTime(listenerId);
    }

    play() : void {
        if (this.currentMedia == null) {
            throw new Error('Cannot play - no media loaded');
        }

        this.vlcSource.setEnabled(true);
        this.vlcSource.playMedia();
        this.vlcSource.once('media_started', () => this.updateStatus(RendererStatus.Playing));
    }

    restart() : void {
        this.vlcSource.restartMedia();
        //this.vlcSource.once('media_restart', () => this.updateStatus(RendererStatus.Playing)); //Doesn't appear to be called
    }

    getOBSSource() { return this.vlcSource; }
}

class VLCPlaylistItem implements OBSDataObject {
    hidden = new OBSBool(false); 
    selected = new OBSBool(false); 
    value: OBSString;
    constructor(filePath: string) {
        this.value = new OBSString(filePath);
    }
    [key: string] : OBSDataValue;
};
class VLCSettings {
    loop = new OBSBool(false);
    playlist: OBSArray;

    constructor(playlist: VLCPlaylistItem[]) {
        this.playlist = new OBSArray(playlist);
    }
    [key: string] : OBSDataValue;
}
