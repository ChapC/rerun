import WebSocket from 'ws';
import { MultiListenable } from './MultiListenable';

/**
 * Simple WS protocol that allows two message types - requests and alerts.
 * Alerts are one-way notifications. The remote endpoint will not return a response for an alert.
 * Requests work like a typical web request. The remote endpoint will respond with a success or error response.
 * 
 * Callbacks for alerts can be registered with onAlerts.
 * Handlers for requests are defined with addRequestHandler.
 * Websocket lifecycle callbacks are also provided via MultiListenable.
*/
//TODO: This WS protocol should support a Pub/Sub system. The current onAlert method should be replaced with a subscribe request. Subscription updates should be cached on the receiving end.

export class WSConnection extends MultiListenable<string, any> {
    private queuedForSend: string[] = []; //Messages sent before the socket is opened will be queued

    constructor(private ws: WebSocket) {
        super();

        ws.on('open', () => {
            //Send any queued messages
            this.queuedForSend.forEach((message) => this.ws.send(message));
            this.queuedForSend = [];

            this.fireEvent('open', null);
        });

        ws.on('message', (rawMessage) => {
            if (rawMessage === 'ping') {
                return;
            }

            //Deserialize the message
            let message : any;
            try {
                message = JSON.parse(rawMessage.toString());
            } catch (e) {
                console.warn('Failed to parse Websocket message: ', message);
                return;
            }

            if (message != null) {

                if (Request.isInstance(message)) {
                    //Check if there is a handler for this request type

                    if (this.requestHandlers[message.requestName] != null) {
                        //Pass the message to this handler
                        let response : WSConnection.WSPendingResponse;
                        try {
                            response = this.requestHandlers[message.requestName](message.data);
                        } catch (error) {
                            console.error(`Error inside request handler for ${message.requestName}`, error);
                            //Return a default error object to the client
                            response = new WSConnection.ErrorResponse('ServerError', 'An unexpected error occurred while processing this request.');
                        }

                        //Response is either a SuccessResponse, an ErrorResponse or a promise resolving to either

                        const processResponse = (response: WSConnection.SuccessResponse | WSConnection.ErrorResponse) => {
                            if (WSConnection.SuccessResponse.isInstance(response)) {
                                let status = 'okay';
                                if (response.status) { //If a custom status was defined by the request handler
                                    status = response.status;
                                }

                                ws.send(JSON.stringify(
                                    new Response(message.reqId, status, response.message, response.data)
                                ));
                            } else {
                                //It's an error
                                ws.send(JSON.stringify(
                                    new Response(message.reqId, 'error', response.message, null, response.errorCode)
                                ));
                            }
                        }

                        //The handler returned a promise - process/send the response later
                        if (isPromise(response)) {
                            response.then(processResponse).catch((error) => {
                                console.error(`Error inside request handler promise for ${message.requestName}`, error);
                                //Return a default error object to the client
                                processResponse(new WSConnection.ErrorResponse('ServerError', 'An unexpected error occurred while processing this request.'));
                            });
                        } else { //The handler returned immediately - process/send the response now
                            processResponse(response);
                        }
                    } else {
                        //There is no handler for this request type
                        ws.send(JSON.stringify(
                            new Response(message.reqId, 'error', `Unknown request ${message.requestName} `, null, 'UnknownRequest')
                        ));
                    }

                } else if (Alert.isInstance(message)) {
                    //Trigger any listeners waiting for this alert
                    this.fireEvent('alert' + message.alertName, message.data);                    
                } else if (Response.isInstance(message)) { //A response to an earlier request
                    //Find the callback for this request
                    let callback = this.pendingRequests[message.reqId];
                    if (callback == null) {
                        console.warn('Received response for unknown request with ID ' + message.reqId);
                        return;
                    }
                    delete this.pendingRequests[message.reqId];

                    if (WSConnection.ErrorResponse.isInstance(message)) {
                        callback.reject(message);
                    } else if (WSConnection.SuccessResponse.isInstance(message)) {
                        callback.resolve(message);
                    }
                }
                
            }
        });

        ws.on('error', (error) => this.fireEvent('error', error));
        ws.on('close', (code, reason) => this.fireEvent('close', {code: code, reason: reason}));
    }

    sendAlert(event: string, data?: any) {
        this.ws.send(JSON.stringify(new Alert(event, data)));
    }

    private requestIDCounter = 0;
    private getReqID(): number {
        this.requestIDCounter++;
        return this.requestIDCounter;
    }

    private requestHandlers : {[requestName: string] : WSConnection.WSReqHandler} = {};
    private pendingRequests : {[requestName: string] : {resolve: (res: WSConnection.SuccessResponse) => void, reject: (err: WSConnection.ErrorResponse) => void}} = {};

    sendRequest(requestName: string, data?:any) : Promise<WSConnection.SuccessResponse> {
        let resPromiseResolver;
        //Pull the resolve and reject callbacks out of the promise
        let resPromise = new Promise<WSConnection.SuccessResponse>((resolve, reject) => resPromiseResolver = {resolve: resolve, reject: reject});

        //Store the resolver in pendingRequests
        let requestId = this.getReqID();
        this.pendingRequests[requestId] = resPromiseResolver;

        const request = JSON.stringify(new Request(requestId.toString(), requestName, data));

        if (this.ws.readyState === 1) { //Websocket is ready
            this.ws.send(request); //Send the message
        } else {
            //Socket not yet connected, queue this message
            console.info('Request "' + requestName + '" was queued for sending - the websocket is not yet open');
            this.queuedForSend.push(request);
        } 

        return resPromise;
    }

    //Alert listeners use the normal MultiListenable but have "alert" prepended to the event name

    onAlert(alertName: string, callback: (ev: any) => void) : number {
        return this.on('alert' + alertName, callback);
    }

    offAlert(callbackId: number) {
        this.off(callbackId);
    }

    oneAlert(alertName: string, callback: (ev: any) => void) : number {
        return this.once('alert' + alertName, callback);
    }

    //Interested parties may register handlers for certain request types
    addRequestHandler(requestName: string, handler: WSConnection.WSReqHandler) {
        this.requestHandlers[requestName] = handler;
    }

    /**
     * Adds a request handler with a given type guard. 
     * If a request's data doesn't pass the type guard, the request is automatically declined. 
     */
    addGuardedRequestHandler<T>(requestName: string, typeGuard: (something: any) => something is T, handler: (data: T) => WSConnection.WSPendingResponse) {
        //Wrap the handler in a type guard check
        let wrappedHandler : WSConnection.WSReqHandler = (data) => {
            if (typeGuard(data)) {
                return handler(data);
            } else {
                return new WSConnection.ErrorResponse('InvalidType', 'Invalid data type for request');
            }
        }

        this.requestHandlers[requestName] = wrappedHandler;
    }

    clearRequestHandler(requestName: string) {
        delete this.requestHandlers[requestName];
    }

    isConnected() : boolean {
        return this.ws.readyState === 1;
    }
}

//Used internally
class Response {
    constructor(readonly reqId: string, readonly status: string, readonly message?: string, readonly data?: any, readonly errorCode?: string) {}

    static isInstance(something: any) : something is Response {
        return (something.reqId != null && something.status != null);
    }
}

class Request {
    constructor(readonly reqId: string, readonly requestName: string, public data?: any) {}

    static isInstance(something: any) : something is Request {
        return (something.reqId != null && something.requestName != null);
    }
}

class Alert {
    constructor(readonly alertName: string, public data?: any) {}

    static isInstance(something: any) : something is Alert {
        return (something.alertName != null);
    }
}

function isPromise(something: any) : something is Promise<any> {
    return (something.then != null && (typeof something.then) === 'function');
}

export namespace WSConnection {
    //Used by request handlers - they can return whichever one they need
    export class SuccessResponse {
        constructor(readonly message: string, readonly data?: any, readonly status?: string) {}

        static isInstance(something: any) : something is SuccessResponse {
            return (something.message != null && something.status !== 'error');
        }
    }

    export class ErrorResponse {
        status: string = 'error';
        constructor(readonly errorCode: string, readonly message?: string) { }

        static isInstance(something: any) : something is ErrorResponse {
            return (something.errorCode != null && something.reqId != null);
        }
    }

    export type WSPendingResponse = SuccessResponse | ErrorResponse | Promise<SuccessResponse | ErrorResponse>;
    export type WSReqHandler = (data: any) => WSPendingResponse;
    
    export function AcceptAny(obj: any) : obj is any {
        return true;
    }
}