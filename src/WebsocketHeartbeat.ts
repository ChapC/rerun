import WebSocket = require("ws");

export class WebsocketHeartbeat {
    private ws: WebSocket;
    private interval: NodeJS.Timeout;
    constructor(websocket: WebSocket) {
        this.ws = websocket;

        this.ws.on('close', () => clearTimeout(this.interval));

        this.interval = setInterval(() => this.ws.send('ping'), 10000);
    }
}