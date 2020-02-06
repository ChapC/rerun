import { MediaObject } from '../MediaObject';
import { OBSConnection } from '../../OBSConnection';
import { ContentRenderer } from './ContentRenderer';

class VLCPlaylistItem {
    hidden: boolean = false; selected: boolean = false; 
    value: string;
    constructor(filePath:string) {
        this.value = filePath;
    }
};
class VLCSettings {
    loop: boolean = false;
    playlist: VLCPlaylistItem[] = [];

    constructor(playlist:VLCPlaylistItem[]) {
        this.playlist = playlist;
    }
}

//Controls an OBS VLC source
export class OBSVideoRenderer implements ContentRenderer {
    private obsVideoPlayer: OBSConnection.SourceInterface;
    constructor(obsVideoPlayer:OBSConnection.SourceInterface) {
        this.obsVideoPlayer = obsVideoPlayer;
    }

    private currentMedia: MediaObject = null;

    loadMedia(media:MediaObject, useAltPath:boolean) : Promise<void> {
        /* OBS needs to always reload the block so that if the same video is playing it'll restart
        if (this.currentMedia != null && media.location.path === this.currentMedia.location.path) {
            return Promise.resolve(); //This media is already loaded
        }
        */

        let playlistItem = new VLCPlaylistItem(media.location.path);

        if (useAltPath) {
            playlistItem = new VLCPlaylistItem(media.location.altPath);
        }

        return new Promise((resolve, reject) => {
            //Set the source as invisible (stops playback)
            this.obsVideoPlayer.setVisible(false).then(() => {
                //Add the file to the playlist
                this.obsVideoPlayer.setSettings(new VLCSettings([playlistItem])).then(() => {
                    this.currentMedia = media;
                    //Ensure the source fills the whole screen (OBS automatically resizes it to match the video resolution)
                    this.obsVideoPlayer.centerAndFillScreen().then(resolve).catch(reject);
                }).catch(reject);
            }).catch(reject);
        });
    }

    unloadMedia() : Promise<void> {
        return new Promise((resolve, reject) => {
            //Set the source as invisible (stops playback)
            this.obsVideoPlayer.setVisible(false).then(() => {
                //Clear the playlist
                this.obsVideoPlayer.setSettings(new VLCSettings([])).then(() => {
                    this.currentMedia = null;
                    resolve();
                }).catch(reject);
            }).catch(reject);
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
            this.obsVideoPlayer.setVisible(true).then(resolve).catch(reject);
        });
    }

    restartMedia() : Promise<void> {
        //Make the source invisible then visible, which restarts playback
        return new Promise((resolve, reject) => {
            this.obsVideoPlayer.setVisible(false).then(() => {
                setTimeout(() => this.obsVideoPlayer.setVisible(true).then(resolve).catch(reject), 100); //OBS won't do it without a delay          
            });
        });
    }
}