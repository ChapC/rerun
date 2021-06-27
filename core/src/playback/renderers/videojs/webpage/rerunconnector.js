class RerunConnector {
    videoJS;
    socket;
    tryReconnect = true;

    heartBeatTimeout = null;
    heartbeat = () => { //Websocket heartbeat
        clearTimeout(this.heartBeatTimeout);

        this.heartBeatTimeout = setTimeout(() => {
            console.info('Missed heartbeat');
            this.socket.close();
        }, 5000 + 1500); //Server ping frequency + 1.5s wiggle

        this.socket.send('pong');
    }

    reconnectTimeout = null;
    attemptReconnect = () => {
        if (this.socket == null || this.socket.readyState === 2 || this.socket.readyState === 3) {
            //CLOSING or CLOSED
            this.openSocket();
            this.reconnectTimeout = setTimeout(this.attemptReconnect, 5000);
        }
    }

    openSocket = () => { //Open websocket to Rerun
        this.socket = new WebSocket('ws://' + window.rerunAddress + '/vjssocket');
        this.socket.addEventListener('open', () => {
            console.info('Connected to Rerun server');
            window.hideError();
            this.heartbeat();
        });
        this.socket.addEventListener('message', (event) => {
            let msg = event.data;            
            if (msg === 'ping') {
                this.heartbeat();
                return;
            } else if (msg === 'alreadyconnected') {
                //Stop trying to connect to the server
                this.tryReconnect = false;
                showError('Another renderer is already connected. Refresh to retry.');
                return;
            }

            msg = JSON.parse(msg);

            msg.respond = (succeeded, message) => {
                let res = {type: succeeded ? 'response' : 'error'};
                res.reqId = msg.reqId;
                if (message) {
                    res.message = message;
                }
                this.socket.send(JSON.stringify(res));
            }

            this.handleRerunEvent(msg);
        });
        this.socket.addEventListener('close', () => {
            console.info('Disconnected from Rerun server');
            clearTimeout(this.reconnectTimeout);
            if (this.tryReconnect) {
                window.showError('No server connection');
                this.reconnectTimeout = setTimeout(this.attemptReconnect, 5000);
            }
        });
    }

    constructor(videoJS) {
        this.videoJS = videoJS;
        this.openSocket();
    }

    handleRerunEvent(message) {
        switch (message.request) {
            case 'load':
                window.hidePlayer();
                this.loadVideo(message.data).then(() => {
                    message.respond(true);
                }).catch(error => message.respond(false, error));
                break;
            case 'play':
                window.showPlayer();
                this.videoJS.play().then(() => {
                    message.respond(true);
                }).catch(error => message.respond(false, error));
                break;
            case 'pause':
                this.videoJS.pause();
                window.hidePlayer();
                message.respond(true);
                break;
            case 'restart':
                this.videoJS.currentTime(0);
                message.respond(true);
                break;
            default:
                console.error('Unknown request ' + message.request);
                console.dir(message);
        }
    }

    //Forces the youtube player to load the video by playing then pausing
    loadYoutubeVideo(url) {
        return new Promise((resolve, reject) => {
            this.videoJS.src({type: 'video/youtube', src: url});
            this.videoJS.one('play', () => {
                this.videoJS.pause();
                console.info('Preload finished');
                resolve();
            });
            console.info('Preloading Youtube video');
            this.videoJS.play();
        });
    }

    loadVideo(source) {
        console.info('Loading video ', source);
        if (source.type === 'video/youtube') {
            return this.loadYoutubeVideo(source.src);
        } else {
            return new Promise((resolve, reject) => {
                this.videoJS.src(source).then(resolve).catch(error => reject(error));
            });
        }
    }
}