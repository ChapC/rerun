import { ContentRenderer } from '../ContentRenderer';
import { MediaObject } from '../../MediaObject';
import { OBSConnection } from '../../../OBSConnection';
import WebSocket = require('ws');

export class VideoJSRenderer implements ContentRenderer {
    private obsBrowserSource : OBSConnection.SourceInterface;
    private vjsSocket : WebSocket;

    constructor(obsBrowserSource: OBSConnection.SourceInterface) {
        this.obsBrowserSource = obsBrowserSource;
    }

    //This renderer internally maintains a playback state so that if a VJS client connects during playback it will be updated
    private currentMedia : MediaObject;

    loadMedia(media:MediaObject, useAltPath?:boolean) : Promise<void> {
        if (this.currentMedia != null && this.currentMedia.location.path === media.location.path) {
            return Promise.resolve(); //This media is already loaded
        }

        return new Promise((resolve, reject) => {
            this.obsBrowserSource.setVisible(true).then(() => {
                this.sendVJSRequest('load', new VJSSource(media)).then(() => {
                    //Loading done
                    this.currentMedia = media;
                    resolve();
                }).catch(error => reject(error));
            });
        });
    }

    stop() : Promise<void> {
        return new Promise((resolve, reject) => {
            this.sendVJSRequest('pause').then(() => {
                resolve();
            }).catch(error => reject(error));
        });
    }

    getLoadedMedia() : MediaObject {
        return this.currentMedia;
    }

    play() : Promise<void> {
        return new Promise((resolve, reject) => {
            this.sendVJSRequest('play').then(() => {
                resolve();
            }).catch(error => reject(error));
        });
    }

    restartMedia() : Promise<void> {
        return new Promise((resolve, reject) => {
            this.sendVJSRequest('restart').then(() => {
                resolve();
            }).catch(error => reject(error));
        });
    }

    //VideoJS websocket connection
    setVJSSocket(socket: WebSocket) : Boolean {
        if (this.vjsSocket == null) {
            this.vjsSocket = socket;
            this.info('VJS Client connected');
            this.vjsSocket.on('message', this.onVJSMessage);
            return true;
        } else {
            this.warn('Tried to set VJS socket, but this renderer is already connected to one');
            return false;
        }
    }

    clearVJSSocket() {
        this.vjsSocket = null;
        this.info('VJS Client disconnected');
    }

    private requestIDCounter = 0;
    private openRequestMap : {[requestId : number] : { resolve: () => void, reject: (string : string) => void}} = {};

    sendVJSRequest(requestName: string, data?:any) : Promise<string> {
        return new Promise((resolve, reject) => {
            const reqId = this.requestIDCounter++;

            if (this.vjsSocket != null) {
                this.openRequestMap[reqId] = {resolve: resolve, reject: reject};
                if (data) {
                    this.vjsSocket.send(JSON.stringify({request: requestName, data: data, reqId: reqId}));
                } else {
                    this.vjsSocket.send(JSON.stringify({request: requestName, reqId: reqId}));
                }
            } else {
                this.warn('Request "' + requestName + '" delayed: no VJS clients connected');
                //Wait 3 seconds for VJS to connect (OBS might be taking a sec to open the browser source)
                setTimeout(() => {
                    if (this.vjsSocket != null) {
                        this.sendVJSRequest(requestName, data).then(resolve).catch(reject);
                    } else {
                        this.error('Dropped request "' + requestName + ': VJS client still not connected');
                        reject('No VJS client');
                    }
                }, 3000);
            }
        });
    }

    onVJSMessage = (messageString: any) => {
        if (messageString === 'pong') {
            return;
        }

        const message = JSON.parse(messageString);
        //Check which request this message is a response to
        let requestPromise = this.openRequestMap[message.reqId];
        if (requestPromise != null) {
            if (message.type === 'response') {
                requestPromise.resolve();
            } else if (message.type === 'error') {
                requestPromise.reject(message.message);
            }
            delete this.openRequestMap[message.reqId];
        } else {
            this.warn('Recieved response for unknown request (ID=' + message.reqId + '), ignoring it');
        }
    }

    info(message:string) {
        console.info('[VideoJSRenderer] ' + message);
    }

    warn(message:string) {
        console.warn('[VideoJSRenderer] ' + message);
    }

    error(message:string, error?:any) {
        console.error('[VideoJSRenderer] ' + message, error);
    }
}

class VJSSource {
    type: string; 
    src: string;

    constructor(sourceMedia: MediaObject) {
        this.src = sourceMedia.location.path;
        if (sourceMedia.type === MediaObject.Type.YouTubeVideo) {
            this.type = 'video/youtube';
        } else {
            this.type = 'video/mp4';
        }
    }
};
