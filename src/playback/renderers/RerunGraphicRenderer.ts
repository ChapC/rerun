import { ContentRenderer } from './ContentRenderer';
import { MediaObject } from './../MediaObject';
import { GraphicLayerReference } from '../../graphiclayers/GraphicManager';
import { GraphicsLayerLocation } from '../MediaLocations';

//Sends graphic events when media starts or stops. Used for title screens.
export class RerunGraphicRenderer implements ContentRenderer {
    supportsBackgroundLoad = false;
    
    private sendGraphicEvent: (event: string, forLayer: GraphicLayerReference) => void;
    constructor(sendGraphicEvent: (event: string, forLayer: GraphicLayerReference) => void) {
        this.sendGraphicEvent = sendGraphicEvent;
    }

    /*In this case, the media's location object path is the name of the target graphic layer
    * On play, the renderer sends the 'in' event to the target layer.
    * On unload, the renderer sends the 'out' event to the target layer.
    */
    currentGraphic : MediaObject;

    loadMedia(media:MediaObject) : Promise<void> {
        if (this.currentGraphic != null) {
            //Unload the current graphic now
            this.stop();
        }
        this.currentGraphic = media;
        return Promise.resolve();
    }

    stop() : Promise<void> {
        if (this.currentGraphic != null) { //Already stopped
            this.sendGraphicEvent('out', (<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
            this.currentGraphic = null;
        }
        return Promise.resolve();
    }

    getLoadedMedia() : MediaObject {
        return this.currentGraphic;
    }

    play() : Promise<void> {
        this.sendGraphicEvent('in', (<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
        return Promise.resolve();
    }

    restartMedia() : Promise<void> {
        return this.play();
    }
}