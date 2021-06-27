import { WSConnection, WSEvent, WSPendingResponse, WSReqHandler } from '@rerun/common/src/networking/WebsocketConnection';
import WebSocket from 'ws';
import WSPublishRepeater from './WSPublishRepeater';

/**
 * A singleton storing all active control panel websockets. 
 * Components can send data to control panels and register request handlers through this class.
 */
export default class ControlPanelSockets {
    private constructor() { }

    private static instance: ControlPanelSockets = new ControlPanelSockets();

    static getInstance() : ControlPanelSockets {
        return this.instance;
    }

    private connectedControlPanels : WSConnection[] = [];

    /**
     * Mark a websocket as a control panel socket, allowing it to send and receive control panel messages.
     * @param ws The websocket to add
     */
    acceptWebsocket(ws: WebSocket) {
        let wsConn = new WSConnection(ws);
        this.connectedControlPanels.push(wsConn);

        wsConn.on(WSEvent.Close, () => this.connectedControlPanels.splice(this.connectedControlPanels.indexOf(wsConn), 1));

        //Attach all the stored request handlers onto this socket
        Object.keys(this.requestHandlers).forEach(requestName => this.requestHandlers[requestName](wsConn));
        //Add this socket to the publish group
        this.publishRepeater.addWebsocket(wsConn);
    }

    private publishRepeater = new WSPublishRepeater();
    private requestHandlers : {[requestName: string] : (ws: WSConnection) => void} = {};
    /**
     * Register a handler for a control panel request. 
     * TRequestData is the type that the request body is expected to conform to. The request will be dropped if the body fails the provided type guard.
     * @param requestName Request to handle
     * @param typeGuard A type guard function to test incoming requests against
     * @param handler Callback to trigger when the request is received
     */
    registerHandler<TRequestData>(requestName: string, typeGuard: (reqData: any) => reqData is TRequestData, handler: WSReqHandler) {
        if (this.requestHandlers[requestName]) {
            console.warn(`There are multiple request handlers registered for the ${requestName} endpoint`);
            return;
        }
        //Attach the handler to all active control panels
        let attachFunction = (ws: WSConnection) => ws.setGuardedRequestHandler<TRequestData>(requestName, typeGuard, handler);
        this.connectedControlPanels.map((ws) => attachFunction(ws));
        //Store the request attach function for future control panel sockets
        this.requestHandlers[requestName] = attachFunction;
    }

    /**
     * Register a handler for a control panel request with no body data.
     * @param requestName Request to handle
     * @param handler Callback to trigger when the request is received
     */
    registerEmptyHandler(requestName: string, handler: () => WSPendingResponse) {
        if (this.requestHandlers[requestName]) {
            console.warn(`There are multiple request handlers registered for the ${requestName} endpoint`);
            return;
        }
        let attachFunction = (ws: WSConnection) => ws.setRequestHandler(requestName, handler);
        this.connectedControlPanels.map(ws => attachFunction(ws));
        this.requestHandlers[requestName] = attachFunction;
    }

    /**
     * Publish a message to all connected control panel clients.
     * @param channel Channel to publish on
     * @param message Data to publish
     */
    publish(channel: string, message: any) {
        this.publishRepeater.publish(channel, message);
    }
}

export abstract class ControlPanelInterface {
    constructor(controlPanel: ControlPanelSockets) {};
}