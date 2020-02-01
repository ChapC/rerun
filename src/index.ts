import { WebsocketRequestHandler, WebsocketMethod } from "express-ws";
import WebSocket = require("ws");
import { ClientRequest } from "http";
import { Stats } from "fs";
import { Request, Response, request } from "express";
import { BufferedWebVideo } from "./playback/BufferedWebVideo";
import { MediaObject } from "./playback/MediaObject";
import { Player } from "./playback/Player";
import { ContentRenderer, OBSVideoRenderer, RerunGraphicRenderer } from './playback/ContentRenderers';
import { ContentBlock } from "./playback/ContentBlock";
import { ScheduleChange } from './playback/ScheduleChange';
import { WebsocketHeartbeat } from './WebsocketHeartbeat';
import { OBSConnection } from './OBSConnection';
import { UserEvent } from './events/UserEvent';
import { PlayerBasedEvent } from './events/UserEventTypes';
import { ShowGraphicAction } from './events/UserEventActionTypes';
import { UserEventManager } from "./events/UserEventManager";
import { GraphicManager } from "./graphiclayers/GraphicManager";

const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const path = require('path');
const fs = require('fs');
const os = require('os');
const colors = require('colors');
const ffprobe = require('ffprobe'), ffprobeStatic = require('ffprobe-static');


//Find my local IP
let localIP:string = null;
for (var device in os.networkInterfaces()) {

    var iface = os.networkInterfaces()[device].filter(
        (details:any) => details.family === 'IPv4' && details.internal === false
    );

    if(iface.length > 0) {
        localIP = iface[0].address;
    } 
}

if (localIP == null) {
    console.warn("Failed to determine local IP address; graphics will only work locally on the server machine");
    localIP = "127.0.0.1";
}

//Addressses and stuff (should eventually move to a user-accessible preferences section)
const obsSocketAddress = 'localhost:4444';
const supportedVideoExtensions = ['.mp4', '.mkv', '.flv', '.avi', '.m4v', '.mov'];

console.info(colors.magenta.bold('-- Rerun v0.1 --\n'));

//State type definition
type OBSSourceMap = {
    localVideo: OBSConnection.SourceInterface, webVideo: OBSConnection.SourceInterface,
    rtmp: OBSConnection.SourceInterface
};
class OBSStateObject {
    connection: OBSConnection; 
    sources: OBSSourceMap = {} as OBSSourceMap;
};
export type MediaTypeRendererMap = {[mediaType in MediaObject.Type] : {renderer: ContentRenderer, focus: Function}};
class RerunStateObject {
    obs: OBSStateObject; renderers: MediaTypeRendererMap = {} as MediaTypeRendererMap;
    graphicsManager: GraphicManager;
    connectedControlPanels: WebSocket[] = [];
    player: Player;
    userEventManager: UserEventManager;
};
let rerunState = new RerunStateObject();

const startUpPromise = Promise.resolve().then(() => {

    //-- OBS connection --
    console.info('[Startup] Connecting to OBS...');
    let obsState : OBSStateObject = new OBSStateObject();
    rerunState.obs = obsState;
    
    //Verify that rerun sources are active in OBS
    obsState.connection = new OBSConnection();
    return obsState.connection.connect(obsSocketAddress).catch(() => Promise.reject('Could not connect to OBS at ' + obsSocketAddress )).then(() => {
        return obsState.connection.getSourceInterface('rerun_localvideo', 'vlc_source').then((sourceInterface) => {
            if (sourceInterface == null) {
                return Promise.reject("Couldn't find OBS source for local video playback (should be VLC source called 'rerun_localvideo'");
            }
            rerunState.obs.sources.localVideo = sourceInterface;
            return Promise.resolve();
        }).then(() => obsState.connection.getSourceInterface('rerun_webvideo', 'browser_source'))
        .then((sourceInterface) => {
            if (sourceInterface == null) {
                return Promise.reject("Couldn't find OBS source for web video playback (should be browser source called 'rerun_webvideo'");
            }
            rerunState.obs.sources.webVideo = sourceInterface;
            return Promise.resolve();
        }).then(() => obsState.connection.getSourceInterface('rerun_rtmp', 'ffmpeg_source'))
        .then((sourceInterface) => {
            if (sourceInterface == null) {
                return Promise.reject("Couldn't find OBS source for RTMP stream playback (should be media source called 'rerun_rtmp'");
            }
            rerunState.obs.sources.rtmp = sourceInterface;
            return Promise.resolve();
        });
    });

}).then(() => {

    console.info('[Startup] Importing graphics packages...')
    const packagePath = './graphics';

    //TODO: Create /graphics if it doesn't exist
    rerunState.graphicsManager = new GraphicManager(packagePath, localIP, () => rerunState.player.getState(), app);
    
    //Serve up all the static files in the graphics package path (JS, images)
    app.use(express.static(packagePath)); //TODO: Only serve the static files of the active package

    return new Promise((resolve, reject) => {
        //Scan for GraphicsPackage definitions
        rerunState.graphicsManager.importPackages().then((packages) => {
            console.info('Imported (' + packages.length + ') graphics packages');

            rerunState.graphicsManager.setActivePackage('FHTV graphics');

            resolve();
        }).catch(err => reject('Failed to import graphics packages: ' + err.toString()));
    });
    
}).then(() => {

    console.info('[Startup] Preparing content renderers...');

    //Local video renderer
    const localVidRenderer = new OBSVideoRenderer(rerunState.obs.sources.localVideo);
    //Ensure the OBS source is disactivated to start with
    localVidRenderer.unloadMedia();
    rerunState.renderers[MediaObject.Type.LocalVideoFile] = {
        renderer: localVidRenderer, focus: () => rerunState.obs.connection.moveSourceToTop(rerunState.obs.sources.localVideo)
    };

    //Graphic title renderer
    const graphicTitleRenderer = new RerunGraphicRenderer(rerunState.graphicsManager.sendGraphicEvent);
    rerunState.renderers[MediaObject.Type.RerunTitle] = {
        renderer: graphicTitleRenderer, focus: () => {} //Noop - the graphic renderer is on a user-defined OBS source, we don't control it
    };

}).then(() => {

    console.info('[Startup] Creating player instance...');

    const openWebVideoBuffers: {[sourceUrl: string] : BufferedWebVideo} = {};

    //Use the title screen graphic as the default block (when nothing else is available)
    const titleScreenGraphicName = 'Title screen';
    const titleScreenGraphicLocation = new MediaObject.Location(MediaObject.Location.Type.LocalURL, 'FHTV title slate');
    const titleBlock = new ContentBlock('titleBlock', new MediaObject(MediaObject.Type.RerunTitle, titleScreenGraphicName, titleScreenGraphicLocation, Number.POSITIVE_INFINITY));

    rerunState.player = new Player(rerunState.renderers, titleBlock);

    rerunState.player.on('newCurrentBlock', (newCurrentBlock) => {
        sendControlPanelAlert('setPlayerState', rerunState.player.getState());
    });

    rerunState.player.on('queueChange', (newQueue) => {
        sendControlPanelAlert('setPlayerState', rerunState.player.getState());
    });

    rerunState.player.on('paused', (pauseReason) => sendControlPanelAlert('setPlayerState', rerunState.player.getState()));

}).then(() => {

    console.info('[Startup] Opening graphic layer websocket...');

    app.ws('/graphicEvents', function(ws:WebSocket, req:any) {
        console.info('Graphic client [' + req.query.layer + '@' + req.connection.remoteAddress +'] connected');
        new WebsocketHeartbeat(ws);
        ws.on('close', () => {
            console.info('Graphic client [' + req.query.layer + '@' + req.connection.remoteAddress +'] disconnected');
            rerunState.graphicsManager.removeWebsocket(ws, req.query.layer);
        });

        rerunState.graphicsManager.addWebsocket(ws, req.query.layer);
    });

}).then(() => {

    console.info('[Startup] Fetching UserEvents...');
    //TODO Import events from a json file
    rerunState.userEventManager = new UserEventManager();    

    let titleEvent = new PlayerBasedEvent('Inbetween title screen', 
        rerunState.player, PlayerBasedEvent.TargetEvent.InBetweenPlayback, 3, 
        new ShowGraphicAction('FHTV title slate', rerunState.graphicsManager.sendGraphicEvent, 2000), 1000
    );
    rerunState.userEventManager.addEvent(titleEvent);

    let lowerBarEvent = new PlayerBasedEvent('Up next bar', 
        rerunState.player, PlayerBasedEvent.TargetEvent.PlaybackStart, 1, 
        new ShowGraphicAction('Up next bar', rerunState.graphicsManager.sendGraphicEvent), 3000
    );
    rerunState.userEventManager.addEvent(lowerBarEvent);    


}).then(() => {

    console.info('[Startup] Starting control panel app...');

    app.ws('/controlWS', function(ws:WebSocket, req:ClientRequest) {
        console.info('Control panel ['+ req.connection.remoteAddress +'] connected');
        new WebsocketHeartbeat(ws);
        rerunState.connectedControlPanels.push(ws);

        //Send the current status to the control panel
        ws.send(JSON.stringify({
            reqId: getReqID(), eventName: 'setPlayerState', data: rerunState.player.getState()
        }));

        ws.on('message', (message) => {
            if (message === 'pong') {
                return;
            }
            let cpRequest = JSON.parse(message.toString());

            if (cpRequest != null) {
                const responseHandler = (responseObject:any, isError: boolean) => {
                    if (isError) {
                        responseObject.status = 'error';
                    } else {
                        if (responseObject.status == null) {
                            responseObject.status = 'ok'; //If the request handler didn't set a status, default to ok
                        }
                    }

                    ws.send(JSON.stringify({ //Send an event back with a matching reqId
                        reqId: cpRequest.reqId, eventName: 'res', data: responseObject
                    }));
                };

                handleControlPanelRequest(cpRequest.req, cpRequest.data, 
                    (resData) => responseHandler(resData, false), (errData) => responseHandler(errData, true));
            }
        });

        ws.on('close', () => {
            console.info('Control panel ['+ req.connection.remoteAddress +'] disconnected');
            rerunState.connectedControlPanels.splice(rerunState.connectedControlPanels.indexOf(ws), 1);
        });

    });

    return new Promise((resolve) => {
        app.listen(8080, () => {
            console.info('[Startup] Web server started - listening on port 8080');
            resolve();
        }); 
    });

}).then(() => {

    console.info(colors.bold.green('Rerun ready! View the control panel at ' + colors.underline('http://' + localIP + ':8080')));

}).catch((error) => console.error(colors.red('Failed to start Rerun:'), error)).then(() => {
    //Startup finished


    //Load sample videos
    const sampleDirectory = "C:/Users/pangp/Videos/YT Testing videos";
    const sampleVideoPaths: string[] = [];

    fs.readdir(sampleDirectory, (err:Error, files:string[]) => {
        if (!err) {
            for (let filePath of files) {
                if (supportedVideoExtensions.includes(path.extname(filePath))) {
                    sampleVideoPaths.push(path.join(sampleDirectory, filePath));
                }
            }
            pushSampleVideos(6);
        } else {
            console.error('Failed to scan sample video folder', err);
        }
    });

    function pushSampleVideos(videoCount: number) {
        const availableVideos = Array.from(sampleVideoPaths);
        const openPromises = [];
        for (let i = 0; i < Math.min(videoCount, availableVideos.length); i++) {
            let randomIndex = Math.round(Math.random() * (availableVideos.length - 1));
            let videoPath = availableVideos[randomIndex];

            availableVideos.splice(randomIndex, 1);

            openPromises.push(mediaObjectFromVideoFile(videoPath).then((mediaObject) => {
                let cb = new ContentBlock('sampleVid-' + i, mediaObject);
                rerunState.player.enqueueBlock(cb);
            }).catch((error) => console.error('Error while reading video file (' + videoPath +'): ', error)));
        }
    }

});

function mediaObjectFromVideoFile(filePath: string) : Promise<MediaObject> {
    const location = new MediaObject.Location(MediaObject.Location.Type.LocalURL, filePath);

    //Use ffProbe to find the video's duration
    return new Promise((resolve, reject) => {
        ffprobe(filePath, { path: ffprobeStatic.path }, (err:Error, info:any) => {
            if (!err) {
                let durationMs = null;
                //Get the duration of the first video stream
                for (let stream of info.streams) {
                    if (stream.codec_type === 'video') {
                        durationMs = stream.duration * 1000;
                        break;
                    }
                }

                if (durationMs == null) {
                    reject('No video stream in file (' + filePath + ')');
                    return;
                }

                let title = path.basename(filePath);
                
                resolve(new MediaObject(MediaObject.Type.LocalVideoFile, title, location, durationMs));
            } else {
                reject(err);
            }
        });
    });
}

let cpRequestIDCounter = 0;
function getReqID() : number {
    cpRequestIDCounter++;
    return cpRequestIDCounter;
}

const invalidTypeError = {code: 'InvalidType', message: 'Invalid type for request'};
const invalidArgumentsError = {code: 'InvalidArguments', message: 'The provided arguments are invalid'};

function handleControlPanelRequest(requestName: string, data: any, respondWith: (obj:any) => void, respondWithError: (obj:any) => void) {
    switch (requestName) {
        //Player requests
        case 'nextBlock': //Skip to the next scheduled ContentBlock
            if (rerunState.player.getQueueLength() === 0) {
                respondWithError({code: 'NoNextBlock', message: 'There is no scheduled ContentBlock to play.'});
                break;
            }

            rerunState.player.progressQueue();
            respondWith({message: 'Moved to next ContentBlock'});
            break;
        case 'playerRefresh': //The control panel requested an update on the player state
            respondWith(rerunState.player.getState());
            break;
        case 'stopToTitle':
            rerunState.player.goToDefaultBlock(2000);
            respondWith({message: 'Stopped to title block.'});
            break;
        case 'restartPlayback':
            rerunState.player.restartCurrentBlock();
            respondWith({message: 'Restarted current block.'});
            break;
        case 'scheduleChange': //A reorder or delete of a scheduled ContentBlock
            const requestedScheduleChange = ScheduleChange.makeNew(data);
            if (requestedScheduleChange != null) {
                const targetContentBlock = rerunState.player.getBlockInQueue(requestedScheduleChange.fromIndex);

                if (requestedScheduleChange.fromIndex == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                //Verify that the request ContentBlockID and the targetContentBlock's ID are the same 
                if (requestedScheduleChange.contentBlockId !== targetContentBlock.id) {
                    //The control panel's schedule is wrong, probably outdated
                    respondWithError({code:'IdMismatch', message: "The provided ContentBlock id did not match the target index's id."});
                    break;
                }

                //Check that fromIndex is within the queue's range
                if (requestedScheduleChange.fromIndex < 0 || requestedScheduleChange.fromIndex >= rerunState.player.getQueueLength()) {
                    respondWithError({code:'OutOfBounds', message: "The provided fromIndex is outside of the queue's range"});
                    break;
                }

                if (requestedScheduleChange.toIndex == -1) {
                    //This is a delete request
                    rerunState.player.removeBlockAt(requestedScheduleChange.fromIndex);
                    respondWith({message: 'ContentBlock ' + requestedScheduleChange.contentBlockId + ' removed'});
                } else {
                    //This is a reorder request
                    rerunState.player.reorderBlock(requestedScheduleChange.fromIndex, requestedScheduleChange.toIndex);
                    respondWith({message: 'ContentBlock ' + requestedScheduleChange.contentBlockId + ' moved'});
                }
            } else {
                respondWithError(invalidTypeError);
            }
            break;
        //Event requests
        case 'getEvents': //Requested a list of UserEvents
            respondWith(rerunState.userEventManager.getEvents());
            break;
        case 'updateEvent': //Request to update an existing userEvent
            if (data.eventId == null || data.newEvent == null) {
                respondWith(invalidArgumentsError);
                break;
            }

            let newEvent = createUserEventFromRequest(data.newEvent);

            rerunState.userEventManager.updateEvent(data.eventId, newEvent);
            respondWith({message: 'Updated event id=' + data.eventId});
            sendControlPanelAlert('setEventList', rerunState.userEventManager.getEvents());
            break;
        case 'setEventEnabled': //Setting the enabled property of a UserEvent
            if (data.eventId == null || data.enabled == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            rerunState.userEventManager.setEventEnabled(data.eventId, data.enabled);
            respondWith({message: (data.enabled ? 'Enabled' : 'Disabled') + ' event ID ' + data.eventId});
            sendControlPanelAlert('setEventList', rerunState.userEventManager.getEvents());
            break;
        //Graphics events
        case 'getGraphicsPackages': //Requeted a list of available graphics packages
            respondWith(rerunState.graphicsManager.getAvailablePackages());
            break;
        default:
            console.info('Unknown control panel request "' + requestName + '"');
            respondWithError({message: 'Unknown request "' + requestName + '"'})
    }
}

function sendControlPanelAlert(event:string, data?:object) {
    let eventObj = {eventName: event, data: data}
    for (let socketIP in rerunState.connectedControlPanels) {
        rerunState.connectedControlPanels[socketIP].send(JSON.stringify(eventObj));
    }
}

function createUserEventFromRequest(requestedEvent: any) : UserEvent {
    if (requestedEvent.type === 'Player') {
        let action = createActionFromRequest(requestedEvent.action);
        try {
            let playerEvent = new PlayerBasedEvent (
                requestedEvent.name, rerunState.player, requestedEvent.targetPlayerEvent,
                requestedEvent.frequency, action, requestedEvent.eventOffset
            );
            return playerEvent;
        } catch (err) {
            console.error('Failed to create PlayerBasedEvent from request:', err);
        }
    } else {
        console.warn('Could not create UserEvent for unsupported event type "' + requestedEvent.type + '"');
        return requestedEvent;
    }
}

function createActionFromRequest(requestedAction: any) : UserEvent.Action {
    if (requestedAction.type === 'GraphicEvent') {
        try {
            return new ShowGraphicAction(requestedAction.targetLayer, 
                                         rerunState.graphicsManager.sendGraphicEvent, requestedAction.animInTime);
        } catch (err) {
            console.error('Failed to create GraphicEvent from request:', err);
        }
    } else {
        console.warn('Could not create UserEvent action for unsupported action type "' + requestedAction.type + '"');
        return requestedAction;
    }
}