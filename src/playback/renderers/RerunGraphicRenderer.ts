import { ContentRenderer } from './ContentRenderer';
import { MediaObject } from './../MediaObject';

//Sends graphic events when media starts or stops. Used for title screens.
export class RerunGraphicRenderer implements ContentRenderer {
    private sendGraphicEvent: (event: string, forLayer: string) => void;
    constructor(sendGraphicEvent: (event: string, forLayer: string) => void) {
        this.sendGraphicEvent = sendGraphicEvent;
    }

    /*In this case, the media's location object path is the name of the target graphic layer
    * On play, the renderer sends the 'in' event to the target layer.
    * On unload, the renderer sends the 'out' event to the target layer.
    */
    currentGraphic : MediaObject;

    loadMedia(media:MediaObject) : Promise<void> {
        this.currentGraphic = media;
        return Promise.resolve();
    }

    unloadMedia() : Promise<void> {
        if (this.currentGraphic != null) { //Already unloaded
            this.sendGraphicEvent('out', this.currentGraphic.location.path);
            this.currentGraphic = null;
        }
        return Promise.resolve();
    }

    getLoadedMedia() : MediaObject {
        return this.currentGraphic;
    }

    play() : Promise<void> {
        this.sendGraphicEvent('in', this.currentGraphic.location.path);
        return Promise.resolve();
    }

    restartMedia() : Promise<void> {
        return this.play();
    }
}