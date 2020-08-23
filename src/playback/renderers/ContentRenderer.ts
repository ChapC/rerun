import { MediaObject } from '../MediaObject';
import { OBSSource } from '../../../obs/RerunOBSBinding'

//Describes a renderer that can display certain content types
export interface ContentRenderer {
    readonly id: number;
    readonly supportedContentType: MediaObject.ContentType;
    loadMedia(media:MediaObject) : Promise<void>; //Prepare the renderer for playback
    getLoadedMedia() : MediaObject; //Return the media object that's currently loaded

    play() : Promise<void>;
    stop() : Promise<void>;
    restartMedia() : Promise<void>;

    getOBSSource(): OBSSource; //I wanted the content system (at the abstract level) to be separated from OBS but that seems way too complicated :/
}