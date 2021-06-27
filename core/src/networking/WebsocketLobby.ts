import { Request } from 'express';
import { ListenerGroup } from '@rerun/common/src/helpers/MultiListenable';
import { WSConnection, WSEvent } from '@rerun/common/src/networking/WebsocketConnection';
/**
 * Accepts websocket connections and keeps them alive
 * while they wait to be acquired by other components.
 */
export default class WebsocketLobby {
    /**
     * @param wsRoute URL route this lobby is listening on
     * @param acquireTimeoutMs Sockets that connect but aren't acquired before this time will be automatically closed
     */
    constructor(readonly wsRoute: string, readonly acquireTimeoutMs?: number) {}

    /**
     * Sockets that have connected but haven't been acquired yet.
     * They'll be removed from this set when someone acquires them
     * or acquireTimeout is reached.
     */
    private connectedWaiting: Set<ConnectedSocket> = new Set();
    private awaitingCallbackIdCounter = 0;
    private awaitingCallbacks: Map<number, AwaitingCallback> = new Map(); //Maps ID to AwaitingCallback

    /**
     * Wait for a websocket that connects with a certain query parameter
     * in the connection request. If a websocket matching this query is
     * already connected, the promise will resolve immediately.
     * 
     * @param queryKey Name of the query parameter to look for
     * @param queryValue Value that the query parameter should be set to
     * @param timeoutMs (Optional) Number of ms that the socket should connect within
     * 
     * @returns A promise resolving to a WSConnection that matched the query parameter or rejecting if timeoutMs expires.
     */
    public acquireSocketWithQuery(queryKey: string, queryValue: string, timeoutMs?: number) : Promise<WSConnection> {
        return new Promise((resolve, reject) => {
            //Has a socket with this query already connected?
            for (let s of this.connectedWaiting) {
                if (s.connectionReq.query[queryKey] === queryValue) {
                    if (s.acquireTimeout) clearTimeout(s.acquireTimeout);
                    s.closeListeners.cancelAll();
                    this.connectedWaiting.delete(s);

                    resolve(s.ws);
                    return;
                }
            }

            //Nope. Chuck this in awaitingSockets, where it'll be checked against any new connections
            let id = this.awaitingCallbackIdCounter++;
            if (timeoutMs) {
                let connectTimeout = setTimeout(() => { 
                    this.awaitingCallbacks.delete(id);
                    reject('Timeout expired');
                }, timeoutMs);

                let callback = new AwaitingCallback(id, (req) => req.query[queryKey] === queryValue, resolve, connectTimeout);
                this.awaitingCallbacks.set(id, callback);
            } else {
                let callback = new AwaitingCallback(id, (req) => req.query[queryKey] === queryValue, resolve);
                this.awaitingCallbacks.set(id, callback);
            }
        });
    }

    /**
     * Add a websocket into the lobby.
     * @param ws WSConnection object
     * @param connectionReq The connection request made by the Websocket
     */
    public acceptWebsocket(ws: WSConnection, connectionReq: Request) : void {
        for (let awaiting of this.awaitingCallbacks) {
            if (awaiting[1].match(connectionReq)) {
                let callback = awaiting[1];
                if (callback.timeout) clearTimeout(callback.timeout);
                this.awaitingCallbacks.delete(awaiting[0]);

                callback.resolve(ws);
                return;
            }
        }

        let conn: ConnectedSocket = { ws: ws, connectionReq: connectionReq, closeListeners: ws.createListenerGroup() };

        if (this.acquireTimeoutMs) {
            conn.acquireTimeout = setTimeout(() => {
                this.connectedWaiting.delete(conn);
                conn.closeListeners.cancelAll();
                conn.ws.close(4333, 'Connection was not acquired from WebsocketLobby in time');
            }, this.acquireTimeoutMs);
        }

        this.connectedWaiting.add(conn);

        let onSocketClosed = () => {
            this.connectedWaiting.delete(conn);
            conn.closeListeners.cancelAll();
            if (conn.acquireTimeout) clearTimeout(conn.acquireTimeout);
        }
        
        conn.closeListeners.on(WSEvent.Close, onSocketClosed);
        conn.closeListeners.on(WSEvent.Error, onSocketClosed);
    }

    /**
     * Close all connected sockets that haven't been acquired.
     */
    public closeAllWaiting() : void {
        this.connectedWaiting.forEach(c => {
            c.ws.close();
            c.closeListeners.cancelAll();
        });
    }
}
type ConnectedSocket = { ws: WSConnection, connectionReq: Request, closeListeners: ListenerGroup<WSEvent, any>, acquireTimeout?: NodeJS.Timeout };

class AwaitingCallback {
    constructor(
        readonly id: number,
        public match: (connectionReq: Request) => boolean,
        public resolve: (ws: WSConnection) => void, 
        public timeout?: NodeJS.Timeout) {}
}