import { ContentRenderer, RendererStatus } from './ContentRenderer';
import { MediaObject } from './../MediaObject';
import { GraphicsLayerLocation } from '../MediaLocations';
import { OBSSource, OBSString } from '../../../obs/RerunOBSBinding';
import { PlaybackOffset } from '../Player';
import WebsocketLobby from '../../networking/WebsocketLobby';
import { WSConnection, WSSubscription } from '@rerun/common/src/networking/WebsocketConnection';
import { GraphicLayerReference } from '../../graphicspackages/GraphicPackageLoader';

const GraphicStateChannel = 'state';
//Sends graphic events when media starts or stops. Used for title screens.
export class RerunGraphicRenderer extends ContentRenderer {
    readonly supportedContentType = MediaObject.ContentType.GraphicsLayer;
    
    constructor(
        readonly id: number,
        private browserSource: OBSSource, 
        private socketLobby: WebsocketLobby, 
        private layerURLProvider: (layerRef: GraphicLayerReference) => string
    ) { super(); }

    private currentGraphic: MediaObject;
    private graphicSocket: WSConnection;
    private stateSubscription: WSSubscription;

    private pendingUnload = false;

    private handleGraphicState(newState: GraphicState) {
        if (newState === GraphicState.In) {
            this.updateStatus(RendererStatus.Playing);
            //Begin timeouts for any onceProgress listeners
            for (let l of this.progressTimeouts) {
                let time = l[0];
                let listener = l[1];

                listener.timeout = setTimeout(() => listener.callbacks.forEach(c => c.callback()), time);
            }
        } else if (newState === GraphicState.Out) {
            if (this.pendingUnload) {
                this.browserSource.updateSettings({ url: new OBSString('about:blank') });
                this.currentGraphic = null;
                this.stateSubscription.cancel();
                this.stateSubscription = null;
                this.graphicSocket.cancelAllListeners();
                this.graphicSocket = null;
    
                this.updateStatus(RendererStatus.Idle);
                this.pendingUnload = false;
            }
        } else if (newState === GraphicState.Error) {
            this.updateStatus(RendererStatus.Error);
            this.cancelAllProgressTimeouts();
        } else if (newState === GraphicState.Finished) {
            this.updateStatus(RendererStatus.Finished);
        }
        //Since ContentRenderers don't have any concept of transitions, the states below only matter for debugging
        else if (newState === GraphicState.TransitioningIn) {
            console.debug(`RerunGraphicRenderer-${this.id} transitioning in`);
        } else if (newState === GraphicState.TransitioningOut) {
            console.debug(`RerunGraphicRenderer-${this.id} transitioning out`);
        }
    }

    loadMedia(media:MediaObject) : void {
        if (this.currentGraphic && this.currentGraphic.isSame(media)) return; //Already loaded

        if (this.currentGraphic !== null) {
            //Unload the current graphic now
            this.stopAndUnload();
        }
        this.currentGraphic = media;

        //Point the browser source to this layer's webpage
        let url = this.layerURLProvider((<GraphicsLayerLocation>this.currentGraphic.location).getLayerRef());
        this.browserSource.updateSettings({
            url: new OBSString(`http://127.0.0.1:8080${url}?renderer=${encodeURIComponent(this.id)}`)
        });

        this.socketLobby.acquireSocketWithQuery('renderer', this.id.toString(), 3000)
        .then((socket) => {
            this.graphicSocket = socket;
            this.stateSubscription = socket.subscribe(GraphicStateChannel, (s) => this.handleGraphicState(s));
            this.updateStatus(RendererStatus.Ready);
        })
        .catch((error) => {
            console.error(`GraphicRenderer-${this.id}: Error acquiring client socket`, error);
            this.updateStatus(RendererStatus.Error);
        });
        
        this.updateStatus(RendererStatus.Loading);
    }
    
    getLoadedMedia() : MediaObject {
        return this.currentGraphic;
    }

    stopAndUnload() : void {
        if (this.currentGraphic == null) return; //Already stopped

        this.graphicSocket.sendRequest('out').catch((err) => {
            this.logError(err)
            this.updateStatus(RendererStatus.Error);
        });
        this.pendingUnload = true;

        this.cancelAllProgressTimeouts();
    }

    play() : void {
        if (this.currentGraphic == null) throw Error("Nothing loaded");

        this.browserSource.setEnabled(true);
        this.graphicSocket.sendRequest('in').catch((err) => {
            this.logError(err)
            this.updateStatus(RendererStatus.Error);
        });
    }

    restart() : void {
        this.play();
    }
    
    getOBSSource(): OBSSource {
        return this.browserSource;
    }

    //Since graphics just go in or out, there's no real point setting up a timer on the client side.
    //Instead, we just fake one here using timeouts. The worst it could be off by is the <1ms it takes to send
    //a local websocket message. Plus time isn't real anyway.
    private callbackIdCounter = 0;
    private listenerIdToTime: Map<number, number> = new Map();
    private progressTimeouts: Map<number, { timeout?: NodeJS.Timeout, callbacks: CallbackWithID[] }> = new Map();

    public onceProgress(progress: PlaybackOffset, callback: () => void): number {
        if (this.currentGraphic.durationMs !== -1 || (this.currentGraphic.durationMs === -1 && progress.type === PlaybackOffset.Type.MsAfterStart)) {
            let callbackId = this.callbackIdCounter++;
            let progressMs = progress.evaluate(this.currentGraphic.durationMs);

            let onceCallback = () => {
                this.offProgress(callbackId);
                callback();
            }

            if (!this.progressTimeouts.has(progressMs)) {
                this.progressTimeouts.set(progressMs, { callbacks: [] });
            }
            let l = this.progressTimeouts.get(progressMs);
            let callbacksForThisTime = l.callbacks;

            callbacksForThisTime.push({ callback: onceCallback, id: callbackId});
            this.listenerIdToTime.set(callbackId, progressMs);

            if (this.getStatus() === RendererStatus.Playing && l.timeout == null) {
                //A timeout for this time needs to be started now
                let currentPlayProgress = Date.now() - this.getStatusUpdatedTimestamp();
                if (currentPlayProgress < progressMs) {
                    l.timeout = setTimeout(() => l.callbacks.forEach(c => c.callback()), progressMs - currentPlayProgress);
                }
            }
            
            return callbackId;
        } else {
            //The current graphic has an infinite duration and the requested PlaybackOffset is one that can't be calculated
            return -1;
        }
    }

    public offProgress(listenerId: number): void {
        let time = this.listenerIdToTime.get(listenerId);
        if (!time) return;
        this.listenerIdToTime.delete(listenerId);

        let l = this.progressTimeouts.get(time);
        let listenerIndex = l.callbacks.findIndex((c) => c.id === listenerId);
        if (listenerIndex !== -1) l.callbacks.splice(listenerIndex, 1);

        if (l.callbacks.length === 0) {
            if (l.timeout) clearTimeout(l.timeout);
            this.progressTimeouts.delete(time);
        }
    }

    /**
     * Clears any active progress timeouts. Does not remove the listeners.
     */
    private cancelAllProgressTimeouts() {
        for (let l of this.progressTimeouts) {
            if (l[1].timeout) clearTimeout(l[1].timeout);
        }
    }

    private logError(msg: any) {
        console.warn(`Error in RerunGraphicRenderer(${this.id})`, msg);
    }
}
type CallbackWithID = { callback: () => void, id: number };
enum GraphicState { TransitioningIn, In, TransitioningOut, Finished, Out, Error };
