import {MediaObject} from '../MediaObject';

//Describes a renderer that can display certain content types
export interface ContentRenderer {
    loadMedia(media:MediaObject, useAltPath?:boolean) : Promise<void>; //Prepare the renderer for playback
    unloadMedia() : Promise<void>; //Unload any loaded media
    getLoadedMedia() : MediaObject; //Return the media object that's currently loaded

    play() : Promise<void>;
    restartMedia() : Promise<void>;
}