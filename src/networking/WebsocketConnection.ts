import WebSocket from "isomorphic-ws";
import { MultiListenable } from "../helpers/MultiListenable";
/**
 * Simple websocket protocol that allows two message types - requests and subscriptions.
 * 
 * Requests work like a typical web request. You send a request and the remote endpoint will return a response.
 * 
 * Subscriptions are a way to synchronize state with the remote endpoint. 
 * One end of the socket publishes messages on a certain channel, and the other end listens for messages on that channel.
*/

export class WSConnection extends MultiListenable<WSEvent, any> {
    private queuedForSend: string[] = []; //Messages sent before the socket is opened will be queued

    constructor(private ws: WebSocket) {
        super();

        if (this.isConnected()) {
            this.receivedHeartbeat(); //Start expecting heartbeats
            this.heartbeatSendInterval = setInterval(() => this.sendHeartbeat(), this.heartbeatFrequency); //Start sending heartbeats
        } else {
            ws.addEventListener('open', () => {
                //Send any queued messages
                this.queuedForSend.forEach((message) => this.ws.send(message));
                this.queuedForSend = [];
    
                this.fireEvent(WSEvent.Open, null);
                this.receivedHeartbeat(); //Start expecting heartbeats
                this.heartbeatSendInterval = setInterval(() => this.sendHeartbeat(), this.heartbeatFrequency); //Start sending heartbeats
            });
        }

        ws.addEventListener('message', (event) => {
            let rawMessage = event.data;
            this.receivedHeartbeat();
            if (rawMessage === 'p') return; //Heartbeat ping

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

                    if (this.requestHandlers.has(message.requestName)) {
                        //Pass the message to this handler
                        let response : WSPendingResponse;
                        try {
                            response = this.requestHandlers.get(message.requestName)(message.data);
                        } catch (error) {
                            console.error(`Error inside request handler for ${message.requestName}`, error);
                            //Return a default error object to the client
                            response = new WSErrorResponse('ServerError', 'An unexpected error occurred while processing this request.');
                        }

                        //Response is either a SuccessResponse, an ErrorResponse or a promise resolving to either

                        const processResponse = (response: WSSuccessResponse | WSErrorResponse) => {
                            if (WSSuccessResponse.isInstance(response)) {
                                let status = 'okay';
                                if (response.status) { //If a custom status was defined by the request handler
                                    status = response.status;
                                }

                                ws.send(JSON.stringify(
                                    new Response(message.reqId, status, response.data)
                                ));
                            } else {
                                //It's an error
                                ws.send(JSON.stringify(
                                    new Response(message.reqId, 'error', response.message, response.errorCode)
                                ));
                            }
                        }

                        //The handler returned a promise - process/send the response later
                        if (isPromise(response)) {
                            response.then(processResponse).catch((error) => {
                                console.error(`Error inside request handler promise for ${message.requestName}`, error);
                                //Return a default error object to the client
                                processResponse(new WSErrorResponse('ServerError', 'An unexpected error occurred while processing this request.'));
                            });
                        } else { //The handler returned immediately - process/send the response now
                            processResponse(response);
                        }
                    } else {
                        //There is no handler for this request type
                        ws.send(JSON.stringify(
                            new Response(message.reqId, 'error', `Unknown request ${message.requestName} `, 'UnknownRequest')
                        ));
                    }

                } else if (SubscriptionMessage.isInstance(message)) { //A message related to the subscription system
                    if (message.message === 'u') {
                        //Remote is requesting a repeat of the latest outgoing message we sent on a channel
                        if (this.outChannelMessageCache.has(message.channel)) {
                            ws.send(JSON.stringify(new SubscriptionMessage(message.channel, this.outChannelMessageCache.get(message.channel))));
                        }
                    } else {
                        //We've received a channel update from remote
                        if (this.subChannels.has(message.channel)) {
                            //We're subscribed to this channel, so trigger listeners and cache this message
                            let content = message.message;
                            this.inChannelMessageCache.set(message.channel, content);
                            this.subChannels.get(message.channel).forEach((subscription) => subscription.callback(content));
                        }
                    }
                } else if (Response.isInstance(message)) { //A response to an earlier request
                    //Find the callback for this request
                    let callback = this.pendingRequests.get(message.reqId);
                    if (callback == null) {
                        console.warn('Received response for unknown request with ID ' + message.reqId);
                        return;
                    }
                    this.pendingRequests.delete(message.reqId);

                    if (WSErrorResponse.isInstance(message)) {
                        callback.reject(message);
                    } else if (WSSuccessResponse.isInstance(message)) {
                        callback.resolve(message);
                    }
                }
                
            }
        });

        ws.addEventListener('error', (error) => {
            this.fireEvent(WSEvent.Error, error);
            clearInterval(this.heartbeatSendInterval);
        });
        ws.addEventListener('close', (event) => {
            this.fireEvent(WSEvent.Close, {code: event.code, reason: event.reason});
            clearInterval(this.heartbeatSendInterval);
        });
    }

    // -- Heartbeat --
    private readonly heartbeatFrequency = 5000;
    private heartbeatSendInterval: Timeout;
    private heartbeatRecvTimeout: Timeout;

    private receivedHeartbeat() {
        clearTimeout(this.heartbeatRecvTimeout);
        this.heartbeatRecvTimeout = setTimeout(() => {this.close(4101, 'Missed heartbeat')}, this.heartbeatFrequency + 1500);
    }

    private sendHeartbeat() {
        if (this.isConnected()) {
            this.ws.send('p');
        }
    }

    // -- Requests --

    private requestIDCounter = 0;
    private requestHandlers : Map<string, WSReqHandler> = new Map(); //Maps request name to its handler
    private pendingRequests : Map<number, {resolve: (res: WSSuccessResponse) => void, reject: (err: WSErrorResponse) => void}> = new Map(); //Maps outgoing request IDs to their response promises

    /**
     * Send a request to the other end of the socket.
     * @param requestName The name of the request
     * @param data (Optional) Data to send as the body of the request
     * @returns A promise resolving to a SuccessResponse or rejecting with an ErrorResponse.
     */
    sendRequest(requestName: string, data?:any) : Promise<WSSuccessResponse> {
        let resPromiseResolver;
        //Pull the resolve and reject callbacks out of the promise
        let resPromise = new Promise<WSSuccessResponse>((resolve, reject) => resPromiseResolver = {resolve: resolve, reject: reject});

        //Store the resolver in pendingRequests
        let requestId = this.requestIDCounter++;
        this.pendingRequests.set(requestId, resPromiseResolver);

        const request = JSON.stringify(new Request(requestId, requestName, data));

        if (this.isConnected()) {
            this.ws.send(request);
        } else {
            //Socket not yet connected, queue this message
            this.queuedForSend.push(request);
        } 

        return resPromise;
    }

    /**
     * Register a handler for incoming requests.
     * @param requestName The request this handler will listen for
     * @param handler A function accepting the request data and returning a response
     */
    setRequestHandler(requestName: string, handler: WSReqHandler) {
        this.requestHandlers.set(requestName, handler);
    }

    /**
     * Deregister the handler for a certain request.
     * @param requestName The request handler to clear
     */
    clearRequestHandler(requestName: string) {
        this.requestHandlers.delete(requestName);
    }

    /**
     * Register a handler for incoming requests and enforce a type guard. 
     *
     * If an incoming request's data doesn't pass the type guard, it will be automatically rejected with an ErrorResponse. 
     */
    setGuardedRequestHandler<T>(requestName: string, typeGuard: (something: any) => something is T, handler: (data: T) => WSPendingResponse) {
        //Wrap the handler in a type guard check
        let wrappedHandler : WSReqHandler = (data) => {
            if (typeGuard(data)) {
                return handler(data);
            } else {
                return new WSErrorResponse('InvalidType', 'Invalid data type for request');
            }
        }

        this.requestHandlers.set(requestName, wrappedHandler);
    }

    // -- Subscriptions --
    /*
     * This isn't *really* a Pub/Sub system, because
     * A) You're only ever publishing to one client, and
     * B) Publish messages are sent to the remote endpoint regardless of whether they've subbed to that channel.
     * But it's kind of like a Pub/Sub system, and it's definitely still useful for syncing objects over WS.
     */
    //Incoming
    private subIDCounter = 0;
    private subChannels: Map<string, WSSubscription[]> = new Map(); //Maps channel name to subscriptions for that channel
    private inChannelMessageCache: Map<string, any> = new Map(); //Maps channel name to the last received message on that channel
    //Outgoing
    private outChannelMessageCache: Map<string, any> = new Map(); //Maps channel name to the last published message on that channel

    /**
     * Send a message over a certain channel to the remote endpoint.
     * @param channel The name of the channel to publish to
     * @param message The message to publish to the channel's subscribers
     */
    publish(channel: string, message: any) : void {
        let subUpdate = new SubscriptionMessage(channel, message);
        this.outChannelMessageCache.set(channel, message);

        if (this.isConnected()) {
            this.ws.send(JSON.stringify(subUpdate));
        } else {
            this.queuedForSend.push(JSON.stringify(subUpdate));
        }
    }

    /**
     * Listen for incoming messages on a certain channel.
     * 
     * If a cached version of the latest message from this channel is available,
     * onMessage will be called immediately with that. Otherwise, the latest message
     * will be fetched from remote and onMessage will be called when it's received.
     * @param channel The channel to listen on
     * @param onMessage Function accepting incoming messages on this channel
     */
    subscribe(channel: string, onMessage: (message: any) => void) : WSSubscription {
        let id = this.subIDCounter++;
        let cancel = () => {
            let subChannelsList = this.subChannels.get(channel);
            if (subChannelsList) {
                let index = subChannelsList.findIndex((s) => s.id === id);
                if (index !== -1) {
                    subChannelsList.splice(index, 1);
                }
                if (subChannelsList.length === 0) {//No other listeners
                    this.subChannels.delete(channel);
                    this.inChannelMessageCache.delete(channel);
                }
            }
        }
 
        let sub = new WSSubscription(id, channel, cancel, onMessage);

        if (!this.subChannels.has(channel)) {
            this.subChannels.set(channel, [ sub ]);
        } else {
            this.subChannels.get(channel).push(sub);
        }

        //Get last channel message from the cache or request it
        if (this.inChannelMessageCache.has(channel)) {
            onMessage(this.inChannelMessageCache.get(channel));
        } else {
            //Request that remote sends us the latest channel state
            let subUpdateReq = JSON.stringify(new SubscriptionMessage(channel, 'u'));
            if (this.isConnected()) {
                this.ws.send(subUpdateReq); 
            } else {
                this.queuedForSend.push(subUpdateReq);
            }
        }

        return sub;
    }

    isConnected() : boolean {
        return this.ws.readyState === 1;
    }

    close(code?: number, message?: string) : void {
        this.ws.close(code, message);
    }
}

export enum WSEvent { Open, Error, Close }

//Used internally
class Response {
    constructor(readonly reqId: number, readonly status: string, readonly data?: any, readonly errorCode?: string) {}

    static isInstance(something: any) : something is Response {
        return (something.reqId != null && something.status != null);
    }
}

class Request {
    constructor(readonly reqId: number, readonly requestName: string, public data?: any) {}

    static isInstance(something: any) : something is Request {
        return (something.reqId != null && something.requestName != null);
    }
}

class SubscriptionMessage {
    constructor(readonly channel: string, readonly message: any) {}

    static isInstance(something: any) : something is SubscriptionMessage {
        return (typeof something.channel) == 'string' && (typeof something.message) != 'undefined';
    }
}

function isPromise(something: any) : something is Promise<any> {
    return (something.then != null && (typeof something.then) === 'function');
}

type Timeout = ReturnType<typeof setTimeout>;

//Used by request handlers - they can return whichever one they need
export class WSSuccessResponse {
    constructor(readonly data?: any, readonly status?: string) {}

    static isInstance(something: any) : something is WSSuccessResponse {
        return ((typeof something.status) === 'string' && something.status !== 'error');
    }
}

export class WSErrorResponse {
    status: string = 'error';
    constructor(readonly errorCode: string, readonly message?: string) { }

    static isInstance(something: any) : something is WSErrorResponse {
        return (something.errorCode != null && something.reqId != null);
    }
}

export class WSSubscription {
    constructor(
        readonly id: number, readonly forChannel: string, 
        private readonly cancelFunc: () => void,
        readonly callback: (obj: any) => void
        ) {}

    /**
     * Cancel this subscription. 
     * The subscription's onMessage callback will no longer receive updates.
     */
    public cancel() : void {
        this.cancelFunc();
    }
}

export type WSPendingResponse = WSSuccessResponse | WSErrorResponse | Promise<WSSuccessResponse | WSErrorResponse>;
export type WSReqHandler = (data: any) => WSPendingResponse;

export function AcceptAny(obj: any) : obj is any {
    return true;
}