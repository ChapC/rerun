import { ContentRenderer } from './ContentRenderer';
import { MediaObject } from './../MediaObject';
import { GraphicLayerReference, getShortLayerURL } from '../../graphiclayers/GraphicManager';
import { GraphicsLayerLocation } from '../MediaLocations';
import { OBSSource, OBSString } from '../../../obs/RerunOBSBinding';

//Sends graphic events when media starts or stops. Used for title screens.
export class RerunGraphicRenderer implements ContentRenderer {
    supportedContentType = MediaObject.ContentType.GraphicsLayer;
    
    private sendGraphicEvent: (event: string, forLayer: GraphicLayerReference) => void;
    constructor(readonly id: number, private browserSource: OBSSource, sendGraphicEvent: (event: string, forLayer: GraphicLayerReference) => void) {
        this.sendGraphicEvent = sendGraphicEvent;
    }

    /*In this case, the media's location object path is the name of the target graphic layer
    * On play, the renderer sends the 'in' event to the target layer.
    * On unload, the renderer sends the 'out' event to the target layer.
    */
    currentGraphic : MediaObject;
    private graphicIn = false;

    loadMedia(media:MediaObject) : Promise<void> {
        if (!(this.currentGraphic != null && this.currentGraphic.isSame(media))) {
            if (this.currentGraphic != null) {
                //Unload the current graphic now
                this.stop();
            }
            this.currentGraphic = media;
            //Point the browser source to this layer's webpage
            let url = getShortLayerURL((<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
            this.browserSource.updateSettings({
                url: new OBSString('http://127.0.0.1:8080' + url)
            });
        }
        return Promise.resolve();
    }

    stop() : Promise<void> {
        if (this.currentGraphic != null) { //Already stopped
            this.sendGraphicEvent('out', (<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
            this.currentGraphic = null;
            this.graphicIn = false;
        }
        return Promise.resolve();
    }

    getLoadedMedia() : MediaObject {
        return this.currentGraphic;
    }

    play() : Promise<void> {
        if (!this.graphicIn) {
            this.browserSource.setEnabled(true);
            this.sendGraphicEvent('in', (<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
            this.graphicIn = true;
        }
        return Promise.resolve();
    }

    restartMedia() : Promise<void> {
        return this.play();
    }
    
    getOBSSource(): OBSSource {
        return this.browserSource;
    }
}