import { WSConnection, WSEvent } from "@rerun/common/src/networking/WebsocketConnection";

/**
 * Repeats outgoing WSConnection.publish messages over a group
 * of WSConnections.
 * 
 * The publish cache is maintained beyond the
 * lifespan of any individual sockets in the group, 
 * so past messages will be published to new sockets as they join.
 */
export default class WSPublishRepeater {
    private publishCache: Map<string, any> = new Map();
    /**
     * Publish a message on a certain channel to all websockets in the group.
     * @param channel Channel to publish on
     * @param message Message to send
     */
    public publish(channel: string, message: any) {
        this.publishCache.set(channel, message);
        for (let ws of this.sockets) {
            if (ws.isConnected()) {
                ws.publish(channel, message);
            } else {
                this.sockets.delete(ws);
            }
        }
    }

    private sockets: Set<WSConnection> = new Set();

    /**
     * Add a websocket to the publish group.
     */
    public addWebsocket(ws: WSConnection) : void {
        this.sockets.add(ws);
        ws.on(WSEvent.Close, () => this.sockets.delete(ws));
        ws.on(WSEvent.Error, () => this.sockets.delete(ws));

        for (let p of this.publishCache) {
            ws.publish(p[0], p[1]);
        }
    }
}