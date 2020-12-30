/*
A JS version of this file will be injected into the HTML files of graphics as they're imported and run in the browser.
This handles the websocket connection of the graphic to Rerun and exposes some of Rerun's functions to
the graphic's code.
*/
import WebSocket from "isomorphic-ws";
import { WSConnection, WSEvent, WSPendingResponse, WSErrorResponse, WSSuccessResponse } from "../networking/WebsocketConnection";
// -- Type-only imports (won't be bundled into the browser JS) --
import type { ContentBlock } from "../playback/ContentBlock";
// ----

// -- Filled in by Rerun server at runtime --
const rAppVersion = "@rerunprop.rAppVersion";
const rLayerName = "@rerunprop.rLayerName";
//----

let wsConnectQuery = `layer=${encodeURIComponent(rLayerName)}`;
//@ts-ignore
const queryString = new URLSearchParams(window.location.search);
if (queryString.has('renderer')) {
    wsConnectQuery += `&renderer=${encodeURIComponent(queryString.get('renderer'))}`;
}

const wsAddress = `ws://127.0.0.1:8080/graphicsWS?${wsConnectQuery}`;
const PlayerQueueChannel = 'player-queue';
const info = (msg: any, obj?: any) => obj ? console.info(`[rerun] ${msg}`, obj) : console.info(`[rerun] ${msg}`);
const error = (msg: any, obj?: any) => obj ? console.error(`[rerun] ${msg}`, obj) : console.error(`[rerun] ${msg}`);

info(`Rerun graphic client - Version ${rAppVersion}`);

const GraphicStateChannel = 'state';
export enum GraphicState { TransitioningIn, In, TransitioningOut, Finished, Out, Error };
class GraphicsBrowserClient {   
    public get version() {
        return rAppVersion;
    }

    public get layer() {
        return rLayerName;
    }

    constructor() {
        this.openRerunSocket();
    }

    private currentState: GraphicState = GraphicState.Out;
    private stateUpdatedTimestamp: number = Date.now();
    private ws: WSConnection;

    private openRerunSocket() {
        info(`Connecting to Rerun server at ${wsAddress}...`);
        let socket = new WebSocket(wsAddress);
        this.ws = new WSConnection(socket);

        socket.addEventListener('message', (event) => console.debug(event.data));
    
        this.ws.on(WSEvent.Open, () => {
            info("Connected to Rerun server");
        });
    
        this.ws.on(WSEvent.Close, (event: {code: number, reason: string}) => {
            error(`Websocket connection closed ${event.code} - ${event.reason}`);
            setTimeout(this.openRerunSocket, 3000);
        });
    
        this.ws.on(WSEvent.Error, (err) => {
            error(`Websocket connection error ${err}`);
            setTimeout(this.openRerunSocket, 3000);
        });

        //@ts-ignore
        let d = document;
        //@ts-ignore
        let w = window;
    
        this.ws.subscribe(PlayerQueueChannel, (newQueue) => { this.playerInfo.queue = newQueue; });
        this.ws.publish(GraphicStateChannel, this.currentState);
        this.ws.setRequestHandler('progress', () => new WSSuccessResponse(this.currentState === GraphicState.In ? Date.now() - this.stateUpdatedTimestamp : 0));

        //Requests sent to graphics code should be delayed until the page is finished loading
        this.ws.setRequestHandler('in', () => {
            if (d.readyState === 'complete') {
                return this.handleInRequest();
            } else {
                return new Promise((resolve) => {
                    w.addEventListener('load', () => resolve(this.handleInRequest()))
                });
            }
        });

        this.ws.setRequestHandler('out', () => {
            if (d.readyState === 'complete') {
                return this.handleOutRequest();
            } else {
                return new Promise((resolve) => {
                    w.addEventListener('load', () => resolve(this.handleOutRequest()))
                });
            }
        });
    }

    private updateState(newState: GraphicState) {
        info(`State update from ${this.currentState} -> ${newState}`);
        this.currentState = newState;
        this.stateUpdatedTimestamp = Date.now();
        this.ws.publish(GraphicStateChannel, newState);
    }

    //Called when the server wants the graphic to appear
    private handleInRequest() : WSPendingResponse {
        if (this.transitionIn != null) {
            info('Transitioning in...');

            let transition: Promise<void>;
            try {
                transition = this.transitionIn();
            } catch (err) {
                this.updateState(GraphicState.Error);
                error('Error running in transition', err);
                return new WSErrorResponse('InError', "An error occurred while running the graphic's in transition");
            }
            
            this.updateState(GraphicState.TransitioningIn);

            transition.then(() => {
                this.updateState(GraphicState.In);
                info('Finished transitioning in');
            }).catch((err) => {
                this.updateState(GraphicState.Error);
                error('In transition promise rejected', err);
            });

            return new WSSuccessResponse();
        } else {
            return new WSErrorResponse('NoIn', 'Graphic has not registered an in transition');
        }
    }

    //Called when the server wants the graphic to disappear
    private handleOutRequest() : WSPendingResponse {
        if (this.transitionOut != null) {
            info('Transitioning out...');

            let transition: Promise<void>;
            try {
                transition = this.transitionOut();
            } catch (err) {
                this.updateState(GraphicState.Error);
                error('Error running out transition', err);
                return new WSErrorResponse('OutError', "An error occurred while running the graphic's out transition");
            }
            
            this.updateState(GraphicState.TransitioningOut);
            transition.then(() => {
                this.updateState(GraphicState.Out);
                info('Finished transitioning out');
            }).catch((err) => {
                this.updateState(GraphicState.Error);
                error('Out transition promise rejected', err);
            });

            return new WSSuccessResponse();
        } else {
            return new WSErrorResponse('NoOut', 'Graphic has not registered an out transition');
        }
    }
    
    private transitionIn: () => Promise<void> = null;
    private transitionOut: () => Promise<void> = null;

    /**
     * Set the function that will be called to trigger this
     * graphic's in transition.
     * 
     * This function should return a promise that resolves when
     * the transition is finished.
     */
    public setIn(inFunc: () => Promise<void>) {
        this.transitionIn = inFunc;
    }

    /**
     * Set the function that will be called to trigger this
     * graphic's out transition.
     * 
     * This function should return a promise that resolves when
     * the transition is finished.
     */
    public setOut(outFunc: () => Promise<void>) {
        this.transitionOut = outFunc;
    }

    /**
     * Tell the player that the graphic is finished and ready to be transitioned out.
     * 
     * This method is only for graphics with a dynamic duration.
     */
    public signalFinished() {
        this.updateState(GraphicState.Finished);
    }

    private playerInfo = new BrowserPlayerInfo();

    public get player() {
        return this.playerInfo;
    }
}

class BrowserPlayerInfo {
    queue: ContentBlock[];
}

//@ts-ignore
(<any> window).rerun = new GraphicsBrowserClient();