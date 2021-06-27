"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcceptAny = exports.WSSubscription = exports.WSErrorResponse = exports.WSSuccessResponse = exports.WSEvent = exports.WSConnection = void 0;
var MultiListenable_1 = require("../helpers/MultiListenable");
/**
 * Simple websocket protocol that allows two message types - requests and subscriptions.
 *
 * Requests work like a typical web request. You send a request and the remote endpoint will return a response.
 *
 * Subscriptions are a way to synchronize state with the remote endpoint.
 * One end of the socket publishes messages on a certain channel, and the other end listens for messages on that channel.
*/
var WSConnection = /** @class */ (function (_super) {
    __extends(WSConnection, _super);
    function WSConnection(ws) {
        var _this = _super.call(this) || this;
        _this.ws = ws;
        _this.queuedForSend = []; //Messages sent before the socket is opened will be queued
        // -- Heartbeat --
        _this.heartbeatFrequency = 5000;
        // -- Requests --
        _this.requestIDCounter = 0;
        _this.requestHandlers = new Map(); //Maps request name to its handler
        _this.pendingRequests = new Map(); //Maps outgoing request IDs to their response promises
        // -- Subscriptions --
        /*
         * This isn't *really* a Pub/Sub system, because
         * A) You're only ever publishing to one client, and
         * B) Publish messages are sent to the remote endpoint regardless of whether they've subbed to that channel.
         * But it's kind of like a Pub/Sub system, and it's definitely still useful for syncing objects over WS.
         */
        //Incoming
        _this.subIDCounter = 0;
        _this.subChannels = new Map(); //Maps channel name to subscriptions for that channel
        _this.inChannelMessageCache = new Map(); //Maps channel name to the last received message on that channel
        //Outgoing
        _this.outChannelMessageCache = new Map(); //Maps channel name to the last published message on that channel
        if (_this.isConnected()) {
            _this.receivedHeartbeat(); //Start expecting heartbeats
            _this.heartbeatSendInterval = setInterval(function () { return _this.sendHeartbeat(); }, _this.heartbeatFrequency); //Start sending heartbeats
        }
        else {
            ws.addEventListener('open', function () {
                //Send any queued messages
                _this.queuedForSend.forEach(function (message) { return _this.ws.send(message); });
                _this.queuedForSend = [];
                _this.fireEventNow(WSEvent.Open, null);
                _this.receivedHeartbeat(); //Start expecting heartbeats
                _this.heartbeatSendInterval = setInterval(function () { return _this.sendHeartbeat(); }, _this.heartbeatFrequency); //Start sending heartbeats
            });
        }
        ws.addEventListener('message', function (event) {
            var rawMessage = event.data;
            _this.receivedHeartbeat();
            if (rawMessage === 'p')
                return; //Heartbeat ping
            //Deserialize the message
            var message;
            try {
                message = JSON.parse(rawMessage.toString());
            }
            catch (e) {
                console.warn('Failed to parse Websocket message: ', message);
                return;
            }
            if (message != null) {
                if (Request.isInstance(message)) {
                    //Check if there is a handler for this request type
                    if (_this.requestHandlers.has(message.requestName)) {
                        //Pass the message to this handler
                        var response = void 0;
                        try {
                            response = _this.requestHandlers.get(message.requestName)(message.data);
                        }
                        catch (error) {
                            console.error("Error inside request handler for " + message.requestName, error);
                            //Return a default error object to the client
                            response = new WSErrorResponse('An unexpected error occurred while processing this request.');
                        }
                        //Response is either a SuccessResponse, an ErrorResponse or a promise resolving to either
                        var processResponse_1 = function (response) {
                            if (WSSuccessResponse.isInstance(response)) {
                                var status_1 = 'ok';
                                if (response.status) { //If a custom status was defined by the request handler
                                    status_1 = response.status;
                                }
                                ws.send(JSON.stringify(new Response(message.reqId, status_1, response.data)));
                            }
                            else {
                                //It's an error
                                ws.send(JSON.stringify(new Response(message.reqId, 'error', response.message)));
                            }
                        };
                        //The handler returned a promise - process/send the response later
                        if (isPromise(response)) {
                            response.then(processResponse_1).catch(function (error) {
                                console.error("Error inside request handler promise for " + message.requestName, error);
                                processResponse_1(new WSErrorResponse('An unexpected error occurred while processing this request.'));
                            });
                        }
                        else { //The handler returned immediately - process/send the response now
                            processResponse_1(response);
                        }
                    }
                    else {
                        //There is no handler for this request type
                        ws.send(JSON.stringify(new Response(message.reqId, 'error', "Unknown request " + message.requestName + " ")));
                    }
                }
                else if (SubscriptionMessage.isInstance(message)) { //A message related to the subscription system
                    if (message.message === 'u') {
                        //Remote is requesting a repeat of the latest outgoing message we sent on a channel
                        if (_this.outChannelMessageCache.has(message.channel)) {
                            ws.send(JSON.stringify(new SubscriptionMessage(message.channel, _this.outChannelMessageCache.get(message.channel))));
                        }
                    }
                    else {
                        //We've received a channel update from remote
                        if (_this.subChannels.has(message.channel)) {
                            //We're subscribed to this channel, so trigger listeners and cache this message
                            var content_1 = message.message;
                            _this.inChannelMessageCache.set(message.channel, content_1);
                            _this.subChannels.get(message.channel).forEach(function (subscription) { return subscription.callback(content_1); });
                        }
                    }
                }
                else if (Response.isInstance(message)) { //A response to an earlier request
                    //Find the callback for this request
                    var callback = _this.pendingRequests.get(message.reqId);
                    if (callback == null) {
                        console.warn('Received response for unknown request with ID ' + message.reqId);
                        return;
                    }
                    _this.pendingRequests.delete(message.reqId);
                    if (WSErrorResponse.isInstance(message)) {
                        callback.reject(message);
                    }
                    else if (WSSuccessResponse.isInstance(message)) {
                        callback.resolve(message);
                    }
                }
            }
        });
        ws.addEventListener('error', function (error) {
            _this.fireEventNow(WSEvent.Error, error);
            clearInterval(_this.heartbeatSendInterval);
        });
        ws.addEventListener('close', function (event) {
            _this.fireEventNow(WSEvent.Close, { code: event.code, reason: event.reason });
            clearInterval(_this.heartbeatSendInterval);
        });
        return _this;
    }
    WSConnection.prototype.receivedHeartbeat = function () {
        var _this = this;
        clearTimeout(this.heartbeatRecvTimeout);
        this.heartbeatRecvTimeout = setTimeout(function () { _this.close(4101, 'Missed heartbeat'); }, this.heartbeatFrequency + 1500);
    };
    WSConnection.prototype.sendHeartbeat = function () {
        if (this.isConnected()) {
            this.ws.send('p');
        }
    };
    /**
     * Send a request to the other end of the socket.
     * @param requestName The name of the request
     * @param data (Optional) Data to send as the body of the request
     * @returns A promise resolving to a SuccessResponse or rejecting with an ErrorResponse.
     */
    WSConnection.prototype.sendRequest = function (requestName, data) {
        var resPromiseResolver;
        //Pull the resolve and reject callbacks out of the promise
        var resPromise = new Promise(function (resolve, reject) { return resPromiseResolver = { resolve: resolve, reject: reject }; });
        //Store the resolver in pendingRequests
        var requestId = this.requestIDCounter++;
        this.pendingRequests.set(requestId, resPromiseResolver);
        var request = JSON.stringify(new Request(requestId, requestName, data));
        if (this.isConnected()) {
            this.ws.send(request);
        }
        else {
            //Socket not yet connected, queue this message
            this.queuedForSend.push(request);
        }
        return resPromise;
    };
    /**
     * Register a handler for incoming requests.
     * @param requestName The request this handler will listen for
     * @param handler A function accepting the request data and returning a response
     */
    WSConnection.prototype.setRequestHandler = function (requestName, handler) {
        this.requestHandlers.set(requestName, handler);
    };
    /**
     * Deregister the handler for a certain request.
     * @param requestName The request handler to clear
     */
    WSConnection.prototype.clearRequestHandler = function (requestName) {
        this.requestHandlers.delete(requestName);
    };
    /**
     * Register a handler for incoming requests and enforce a type guard.
     *
     * If an incoming request's data doesn't pass the type guard, it will be automatically rejected with an ErrorResponse.
     */
    WSConnection.prototype.setGuardedRequestHandler = function (requestName, typeGuard, handler) {
        //Wrap the handler in a type guard check
        var wrappedHandler = function (data) {
            if (typeGuard(data)) {
                return handler(data);
            }
            else {
                return new WSErrorResponse('Invalid data type for request');
            }
        };
        this.requestHandlers.set(requestName, wrappedHandler);
    };
    /**
     * Send a message over a certain channel to the remote endpoint.
     * @param channel The name of the channel to publish to
     * @param message The message to publish to the channel's subscribers
     */
    WSConnection.prototype.publish = function (channel, message) {
        var subUpdate = new SubscriptionMessage(channel, message);
        this.outChannelMessageCache.set(channel, message);
        if (this.isConnected()) {
            this.ws.send(JSON.stringify(subUpdate));
        }
        else {
            this.queuedForSend.push(JSON.stringify(subUpdate));
        }
    };
    /**
     * Listen for incoming messages on a certain channel.
     *
     * If a cached version of the latest message from this channel is available,
     * onMessage will be called immediately with that. Otherwise, the latest message
     * will be fetched from remote and onMessage will be called when it's received.
     * @param channel The channel to listen on
     * @param onMessage Function accepting incoming messages on this channel
     */
    WSConnection.prototype.subscribe = function (channel, onMessage) {
        var _this = this;
        var id = this.subIDCounter++;
        var cancel = function () {
            var subChannelsList = _this.subChannels.get(channel);
            if (subChannelsList) {
                var index = subChannelsList.findIndex(function (s) { return s.id === id; });
                if (index !== -1) {
                    subChannelsList.splice(index, 1);
                }
                if (subChannelsList.length === 0) { //No other listeners
                    _this.subChannels.delete(channel);
                    _this.inChannelMessageCache.delete(channel);
                }
            }
        };
        var sub = new WSSubscription(id, channel, cancel, onMessage);
        if (!this.subChannels.has(channel)) {
            this.subChannels.set(channel, [sub]);
        }
        else {
            this.subChannels.get(channel).push(sub);
        }
        //Get last channel message from the cache or request it
        if (this.inChannelMessageCache.has(channel)) {
            onMessage(this.inChannelMessageCache.get(channel));
        }
        else {
            //Request that remote sends us the latest channel state
            var subUpdateReq = JSON.stringify(new SubscriptionMessage(channel, 'u'));
            if (this.isConnected()) {
                this.ws.send(subUpdateReq);
            }
            else {
                this.queuedForSend.push(subUpdateReq);
            }
        }
        return sub;
    };
    WSConnection.prototype.isConnected = function () {
        return this.ws.readyState === 1;
    };
    WSConnection.prototype.close = function (code, message) {
        this.ws.close(code, message);
    };
    return WSConnection;
}(MultiListenable_1.MultiListenable));
exports.WSConnection = WSConnection;
var WSEvent;
(function (WSEvent) {
    WSEvent[WSEvent["Open"] = 0] = "Open";
    WSEvent[WSEvent["Error"] = 1] = "Error";
    WSEvent[WSEvent["Close"] = 2] = "Close";
})(WSEvent = exports.WSEvent || (exports.WSEvent = {}));
//Used internally
var Response = /** @class */ (function () {
    function Response(reqId, status, data) {
        this.reqId = reqId;
        this.status = status;
        this.data = data;
    }
    Response.isInstance = function (something) {
        return (something.reqId != null && something.status != null);
    };
    return Response;
}());
var Request = /** @class */ (function () {
    function Request(reqId, requestName, data) {
        this.reqId = reqId;
        this.requestName = requestName;
        this.data = data;
    }
    Request.isInstance = function (something) {
        return (something.reqId != null && something.requestName != null);
    };
    return Request;
}());
var SubscriptionMessage = /** @class */ (function () {
    function SubscriptionMessage(channel, message) {
        this.channel = channel;
        this.message = message;
    }
    SubscriptionMessage.isInstance = function (something) {
        return (typeof something.channel) == 'string' && (typeof something.message) != 'undefined';
    };
    return SubscriptionMessage;
}());
function isPromise(something) {
    return (something.then != null && (typeof something.then) === 'function');
}
//Used by request handlers - they can return whichever one they need
var WSSuccessResponse = /** @class */ (function () {
    function WSSuccessResponse(data, status) {
        this.data = data;
        this.status = status;
        if (!status) {
            this.status = 'ok';
        }
    }
    WSSuccessResponse.isInstance = function (something) {
        return ((typeof something.status) === 'string' && something.status !== 'error');
    };
    return WSSuccessResponse;
}());
exports.WSSuccessResponse = WSSuccessResponse;
var WSErrorResponse = /** @class */ (function () {
    function WSErrorResponse(message) {
        this.message = message;
        this.status = 'error';
    }
    WSErrorResponse.isInstance = function (something) {
        return (something.status === 'error' && something.reqId != null);
    };
    return WSErrorResponse;
}());
exports.WSErrorResponse = WSErrorResponse;
var WSSubscription = /** @class */ (function () {
    function WSSubscription(id, forChannel, cancelFunc, callback) {
        this.id = id;
        this.forChannel = forChannel;
        this.cancelFunc = cancelFunc;
        this.callback = callback;
    }
    /**
     * Cancel this subscription.
     * The subscription's onMessage callback will no longer receive updates.
     */
    WSSubscription.prototype.cancel = function () {
        this.cancelFunc();
    };
    return WSSubscription;
}());
exports.WSSubscription = WSSubscription;
function AcceptAny(obj) {
    return true;
}
exports.AcceptAny = AcceptAny;
