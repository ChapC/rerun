import {MediaObject} from '../MediaObject';

//Describes a renderer that can display certain content types
export interface ContentRenderer {
    loadMedia(media:MediaObject) : Promise<void>; //Prepare the renderer for playback
    getLoadedMedia() : MediaObject; //Return the media object that's currently loaded

    play() : Promise<void>;
    stop() : Promise<void>;
    restartMedia() : Promise<void>;

    supportsBackgroundLoad: Boolean; //If false, calling loadMedia() while media is playing will stop that media to load the new one
}