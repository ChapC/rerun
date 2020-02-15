import WebSocket = require("ws");

const pingFrequency = 5000;
export class WebsocketHeartbeat {
    private ws: WebSocket;
    private interval: NodeJS.Timeout;
    constructor(websocket: WebSocket) {
        this.ws = websocket;

        this.ws.addEventListener('close', () => {
            clearInterval(this.interval);
            clearTimeout(this.heartBeatTimeout);
        });
        this.ws.addEventListener('message', this.heartbeat);

        this.interval = setInterval(() => {
            if (this.ws.readyState === 1) {
                this.ws.send('ping');
            } else {
                this.ws.close();
            }
        }, pingFrequency);
        this.heartbeat();
    }

    private heartBeatTimeout: NodeJS.Timeout = null;
    heartbeat = () => {
        clearTimeout(this.heartBeatTimeout);

        this.heartBeatTimeout = setTimeout(() => this.ws.close(), pingFrequency + 1500); //Server ping frequency + 1.5s wiggle
    }
}