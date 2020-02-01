import {MediaObject} from './MediaObject';

//A MediaObject scheduled for playback
export class ContentBlock {
    id:string;
    colour:string = '#282482';
    media:MediaObject;
    mediaStatus: MediaObject.Status = MediaObject.Status.UNTRACKED;
    playbackConfig = new ContentPlaybackConfig();

    constructor(id:string, media:MediaObject) {
        this.id = id;
        this.media = media;
    }
}

export class ContentPlaybackConfig {
    trimStartSec = 0;
    trimEndSec = 0;
    startWithoutGraphics = false;
}