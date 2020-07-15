import { MediaObject } from '../MediaObject';
import { ContentRenderer } from './ContentRenderer';
import { OBSSource, OBSBool, OBSString, OBSArray, OBSDataObject, OBSDataValue } from '../../../obs/RerunOBSBinding';

//Controls an OBS VLC source
export class OBSVideoRenderer implements ContentRenderer {
    supportsBackgroundLoad = false;
    
    private vlcSource: OBSSource;
    constructor(source: OBSSource) {
        this.vlcSource = source;
    }

    private currentMedia: MediaObject = null;

    loadMedia(media:MediaObject) : Promise<void> {
        /* OBS needs to always reload the block so that if the same video is playing it'll restart
        if (this.currentMedia != null && media.location.path === this.currentMedia.location.path) {
            return Promise.resolve(); //This media is already loaded
        }
        */

        let playlistItem = new VLCPlaylistItem(media.location.getPath());

        return new Promise((resolve, reject) => {
            //Set the source as invisible (stops playback)
            this.vlcSource.setEnabled(false);
            //Add the file to the playlist
            this.vlcSource.updateSettings(new VLCSettings([playlistItem]));
            this.currentMedia = media;
            resolve(); //TODO: The OBS binding should probably expose the above functions as promises, so we don't have to fake them here
        });
    }

    stop() : Promise<void> {
        return new Promise((resolve, reject) => {
            //Set the source as invisible (stops playback)
            this.vlcSource.setEnabled(false);
            resolve();
        });
    }

    getLoadedMedia() : MediaObject {
        return this.currentMedia;
    }

    play() : Promise<void> {
        if (this.currentMedia == null) {
            return Promise.reject('Cannot play - no media loaded');
        }

        return new Promise((resolve, reject) => {
            //Make the source visible, starting playback
            this.vlcSource.setEnabled(true);
            resolve();
        });
    }

    restartMedia() : Promise<void> {
        //Make the source invisible then visible, which restarts playback
        return new Promise((resolve, reject) => {
            this.vlcSource.restartMedia();
            resolve();
        });
    }
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
