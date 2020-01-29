import { WebsocketRequestHandler, WebsocketMethod } from "express-ws";
import WebSocket = require("ws");
import { ClientRequest } from "http";
import { Stats } from "fs";
import { Request, Response, request } from "express";
import { GraphicLayer } from './graphiclayers/GraphicLayer';
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

const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const path = require('path');
const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const os = require('os');
const recursive = require("recursive-readdir");
const colors = require('colors');
const ffprobe = require('ffprobe'), ffprobeStatic = require('ffprobe-static');

const initRerunReference = require('./graphiclayers/graphicLayerInjection').script;

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
    connectedGraphicClients: WebSocket[] = [];
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

    console.info('[Startup] Preparing content renderers...');

    //Local video renderer
    const localVidRenderer = new OBSVideoRenderer(rerunState.obs.sources.localVideo);
    //Ensure the OBS source is disactivated to start with
    localVidRenderer.unloadMedia();
    rerunState.renderers[MediaObject.Type.LocalVideoFile] = {
        renderer: localVidRenderer, focus: () => rerunState.obs.connection.moveSourceToTop(rerunState.obs.sources.localVideo)
    };

    //Graphic title renderer
    const graphicTitleRenderer = new RerunGraphicRenderer(sendGraphicEvent);
    rerunState.renderers[MediaObject.Type.RerunTitle] = {
        renderer: graphicTitleRenderer, focus: () => {} //Noop - the graphic renderer is on a user-controlled OBS source, we don't control it
    };

}).then(() => {

    console.info('[Startup] Importing graphics layers...')

    //The user will select which graphics package (top-level folder) to use
    //Here we'll use fhtv
    const packagePath = path.join(__dirname, '../graphics/fhtv');
    const activeGraphicsLayers: {[layerName: string] : GraphicLayer} = {};
    
    //Serve up all the static files in the graphics package (JS, images)
    app.use(express.static(packagePath));

    console.info('Looking for graphics layers in ' + packagePath + '...');
    //Scan the graphics package (folder) for graphics layers (html files)
    const htmlOnly = (file:string, stats:Stats) => !stats.isDirectory() && path.extname(file) != '.html';

    return new Promise((resolve, reject) => {
        recursive(packagePath, [htmlOnly], (err:Error, files:string[]) => {
            if (!err) {
                //files is a list of .html file paths
                files.forEach((filePath) => {
                    let layerName = path.basename(filePath).substring(0, path.basename(filePath).length - 5);
                    
                    let newLayer = new GraphicLayer(filePath, layerName);
    
                    activeGraphicsLayers[layerName] = newLayer;
                    
                    //Import each graphic layer's HTML and inject the rerun script into it
                    let layerHTML = importGraphicHTML(newLayer.path, newLayer.name);
                    newLayer.html = layerHTML;
                
                    //Create a route to serve this layer
                    app.get('/layer/' + newLayer.name, (req:Request, res:Response) => res.send(newLayer.html));
                    
                    console.info('Serving graphics layer "' + newLayer.name + '" at /layer/' + newLayer.name);
                });
                console.info('Found (' + files.length + ') graphics layers');
                resolve();
            } else {
                console.error('Could not scan package \'' + packagePath + '\' for graphics layers: ', err);
                reject('Failed to import graphics layers');
            }
        });
    });

}).then(() => {

    console.info('[Startup] Creating player instance...');

    const openWebVideoBuffers: {[sourceUrl: string] : BufferedWebVideo} = {};

    //Use the title screen graphic as the default block (when nothing else is available)
    const titleScreenGraphicName = 'Title screen';
    const titleScreenGraphicLocation = new MediaObject.Location(MediaObject.Location.Type.LocalURL, 'show-screen', 'hide-screen');
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
    rerunState.connectedGraphicClients = [];

    app.ws('/graphicEvents', function(ws:WebSocket, req:ClientRequest) {
        console.info('Graphic client ['+ req.connection.remoteAddress +'] connected');
        rerunState.connectedGraphicClients.push(ws);
        new WebsocketHeartbeat(ws);

        ws.on('close', () => {
            console.info('Graphic client ['+ req.connection.remoteAddress +'] disconnected');
            rerunState.connectedGraphicClients.splice(rerunState.connectedGraphicClients.indexOf(ws), 1);
        });

        //Check if a rerun graphic is currently playing and, if so, send the start event now
        const currentBlock = rerunState.player.getState().currentBlock;
        if (currentBlock.media.type === MediaObject.Type.RerunTitle) {
            sendGraphicEvent(currentBlock.media.location.path, ws);
        }
    });

}).then(() => {

    console.info('[Startup] Fetching UserEvents...');
    //TODO Import events from a json file
    rerunState.userEventManager = new UserEventManager();    

    let titleEvent = new PlayerBasedEvent('Inbetween title screen', 
        rerunState.player, PlayerBasedEvent.TargetEvent.InBetweenPlayback, 1, 
        new ShowGraphicAction(sendGraphicEvent, 'show-screen', 2000, 'hide-screen'), 1000
    );
    rerunState.userEventManager.addEvent(titleEvent);

    let lowerBarEvent = new PlayerBasedEvent('Up next bar', 
        rerunState.player, PlayerBasedEvent.TargetEvent.PlaybackStart, 1, 
        new ShowGraphicAction(sendGraphicEvent, 'show-lower'), 3000
    );
    rerunState.userEventManager.addEvent(lowerBarEvent);    


}).then(() => {

    console.info('[Startup] Starting control panel app...');

    app.ws('/controlWS', function(ws:WebSocket, req:ClientRequest) {
        console.info('Control panel ['+ req.connection.remoteAddress +'] connected');
        rerunState.connectedControlPanels.push(ws);
        new WebsocketHeartbeat(ws);

        //Send the current status to the control panel
        ws.send(JSON.stringify({
            reqId: getReqID(), eventName: 'setPlayerState', data: rerunState.player.getState()
        }));

        ws.on('message', (message) => {
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

    console.info(colors.bold.green('Rerun ready! View the control panel at ' + colors.underline('http://localhost:8080')));

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


/*
//Test ContentBlocks
const getEmptyMedia = (name: string) => {
    let m = new MediaObject(MediaObject.Type.LocalVideoFile, name, new MediaObject.Location(MediaObject.Location.Type.LocalURL, 'fake/path/to/video.mp4'), 180000);
    return m; //3mins long
}
const testBlocks = [];
for (let i = 0; i < 10; i++) {
    let block = new ContentBlock('testBlock' + i, getEmptyMedia('testMedia-' + i));
    testBlocks.push(block);
    rerunState.player.enqueueBlock(block);
}
*/

//Read in a graphic layer HTML file, inject the rerun script and return the resulting html document as a string
function importGraphicHTML(pathToHTMLFile:string, graphicLayerName:string) : string {
    //Read in the HTML from the target file
    let rawHTML = fs.readFileSync(pathToHTMLFile);

    //Load it into a virtual DOM so that we can modify it
    let graphicDom = new JSDOM(rawHTML);
    //Inject some JS into the DOM that creates the window.rerun link for the graphic can access
    let initFunctionString = initRerunReference.toString().slice(13, -1); //Remove the "function() {" and "}" from the function string
    //Replace any server-side variables with their string value
    initFunctionString = initFunctionString.replace(/localIP/g, "'" + localIP + "'");
    initFunctionString = initFunctionString.replace(/myGraphicsLayerName/g, "'" + graphicLayerName + "'");
    
    let initRerunScriptTag = graphicDom.window.document.createElement("script");
    initRerunScriptTag.innerHTML = initFunctionString;
    
    //Add this script tag to <head> as the first child
    let headTag = graphicDom.window.document.getElementsByTagName('head')[0];
    headTag.insertBefore(initRerunScriptTag, headTag.firstChild);

    return graphicDom.serialize();
}

function sendGraphicEvent(event:string, toSocket?:WebSocket) {
    //Graphic events contain the event name and the player's current state
    let eventObj = {name: event, playerState: rerunState.player.getState()}

    if (toSocket) {
        //Send the event to this socket only
        toSocket.send(JSON.stringify(eventObj));
    } else {
        //Send the event to all graphic clients
        console.info('[Graphic event-all] ' + event);
        for (let socketIP in rerunState.connectedGraphicClients) {
            rerunState.connectedGraphicClients[socketIP].send(JSON.stringify(eventObj));
        }
    }
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
        case 'setEventEnabled': //Setting the enabled property of a UserEvent
            if (data.eventId == null || data.enabled == null) {
                respondWithError(invalidTypeError);
                break;
            }

            rerunState.userEventManager.setEventEnabled(data.eventId, data.enabled);
            respondWith({message: (data.enabled ? 'Enabled' : 'Disabled') + ' event ID ' + data.eventId});
            sendControlPanelAlert('setEventList', rerunState.userEventManager.getEvents());
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