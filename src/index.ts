import WebSocket = require("ws");
import { ClientRequest } from "http";
import { BufferedWebVideo } from "./playback/BufferedWebVideo";
import { MediaObject } from "./playback/MediaObject";
import { Player } from "./playback/Player";
import { ContentRenderer } from './playback/renderers/ContentRenderer';
import { OBSVideoRenderer } from './playback/renderers/OBSVideoRenderer';
import { RerunGraphicRenderer } from './playback/renderers/RerunGraphicRenderer';
import { ContentBlock } from "./playback/ContentBlock";
import { ScheduleChange } from './playback/ScheduleChange';
import { WebsocketHeartbeat } from './WebsocketHeartbeat';
import { OBSConnection } from './OBSConnection';
import { UserEvent } from './events/UserEvent';
import { PlayerBasedEvent } from './events/UserEventTypes';
import { ShowGraphicAction } from './events/UserEventActionTypes';
import { UserEventManager } from "./events/UserEventManager";
import { GraphicManager } from "./graphiclayers/GraphicManager";
import { LocalDirectorySource, mediaObjectFromVideoFile } from './contentsources/LocalDirectorySource';
import { ContentSourceManager } from "./contentsources/ContentSourceManager";
import { VideoJSRenderer } from "./playback/renderers/videojs/VideoJSRenderer";
import { Request, Response } from "express";
import { PathLike } from "fs";
import { getVideoMetadata } from './YoutubeAPI';
import { Moment, Duration } from 'moment';
import * as ytdl from 'ytdl-core';

const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const path = require('path');
const fs = require('fs');
const os = require('os');
const colors = require('colors');
const uuidv4 = require('uuid/v4');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const moment = require('moment');

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
    contentSourceManager: ContentSourceManager;
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
                return Promise.reject("Couldn't find OBS source for local video playback (should be VLC source called 'rerun_localvideo')");
            }
            rerunState.obs.sources.localVideo = sourceInterface;
            return Promise.resolve();
        }).then(() => obsState.connection.getSourceInterface('rerun_webvideo', 'browser_source'))
        .then((sourceInterface) => {
            if (sourceInterface == null) {
                return Promise.reject("Couldn't find OBS source for web video playback (should be browser source called 'rerun_webvideo')");
            }
            rerunState.obs.sources.webVideo = sourceInterface;
            return Promise.resolve();
        }).then(() => obsState.connection.getSourceInterface('rerun_rtmp', 'ffmpeg_source'))
        .then((sourceInterface) => {
            if (sourceInterface == null) {
                return Promise.reject("Couldn't find OBS source for RTMP stream playback (should be media source called 'rerun_rtmp')");
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

    //Web video renderer
    const webVidRenderer = new VideoJSRenderer(rerunState.obs.sources.webVideo, );
    rerunState.renderers[MediaObject.Type.YouTubeVideo] = {
        renderer: webVidRenderer, focus: () => rerunState.obs.connection.moveSourceToTop(rerunState.obs.sources.webVideo)
    };

    //Open the websocket endpoint for VideoJS clients
    app.ws('/vjssocket', function(ws:WebSocket, req:any) {
        new WebsocketHeartbeat(ws);
        let accepted = webVidRenderer.setVJSSocket(ws);
        if (accepted) {
            ws.on('close', () => webVidRenderer.clearVJSSocket());
        } else {
            ws.send('alreadyconnected');
            ws.close();
        }
    });
    //Serve the VideoJS webpage + static bits
    const pathToWebpage = path.join(__dirname + '/playback/renderers/videojs/webpage/videojs.html');
    const vjsPageWithIP = injectIPIntoHTML(pathToWebpage, localIP + ':8080');

    app.use('/vjs', express.static(path.join(__dirname + '/playback/renderers/videojs/webpage'))); 
    app.get('/vjs', function(req:Request, res:Response) {
        res.send(vjsPageWithIP);
    });   

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

    rerunState.player.on('playbackStateChange', (newPlaybackState) => {
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

    console.info('[Startup] Loading content sources...');
    rerunState.contentSourceManager = new ContentSourceManager();

    const sampleDirectory = "C:/Users/pangp/Videos/YT Testing videos";
    rerunState.contentSourceManager.addSource(new LocalDirectorySource('Sample videos', sampleDirectory));    

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

    const ytSampleUrls = [
        'https://www.youtube.com/watch?v=ktTurs7leRo', 'https://www.youtube.com/watch?v=4EYWACRQg_Q', 'https://www.youtube.com/watch?v=ML-jS6dmuBY',
        'https://www.youtube.com/watch?v=SG6TPTBBz7g', 'https://www.youtube.com/watch?v=b_Ai0hTW6_M', 'https://www.youtube.com/watch?v=S79GcTt_8pc',
        'https://www.youtube.com/watch?v=1B7hZ2AYyuU', 'https://www.youtube.com/watch?v=SGgMvp0Nm18', 'https://www.youtube.com/watch?v=2sGN3peODwY'
    ];

    //Load sample videos
    const numberOfSamples = 6;
    let samplesFetched = 0;

    const shuffle = (a: any[]) => {
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    shuffle(ytSampleUrls);

    //Youtube video samples
    const enqueueSamples = () => {
        const videoId = ytdl.getURLVideoID(ytSampleUrls[samplesFetched]) as string;
        getVideoMetadata(videoId).then((metadata) => {
            let duration : Duration = moment.duration(metadata.contentDetails.duration); //Duration is in ISO8601 format
            let media = new MediaObject(
                MediaObject.Type.YouTubeVideo, metadata.snippet.title, 
                new MediaObject.Location(MediaObject.Location.Type.WebURL, ytSampleUrls[samplesFetched]),
                duration.asMilliseconds()
            );
            media.thumbnail = metadata.snippet.thumbnails.default.url;
            rerunState.player.enqueueBlock(new ContentBlock('ytSample' + samplesFetched, media));
            samplesFetched += 1;
            if (samplesFetched < numberOfSamples) {
                enqueueSamples();
            }
        });
    }

    /*
    //Local file samples
    const enqueueSamples = () => {
        rerunState.contentSourceManager.getSources()[0].poll(true).then((block) => {
            rerunState.player.enqueueBlock(block);
            samplesFetched = samplesFetched + 1;
            if (samplesFetched < numberOfSamples) {
                enqueueSamples();
            }
        }).catch(error => console.error('Error while polling sample videos source:', error));
    }*/

    enqueueSamples();

});

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
        //Content block requests
        case 'updateContentBlock': //Requested to change an existing content block
            if (data.block == null || data.block.id == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            //Try to create a new content block from the provided one
            createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                contentBlock.id = data.block.id; //Replace the generated id with the target id
                rerunState.player.updateBlockAt(data.block.id, contentBlock);
                respondWith({message: 'Updated block with id ' + data.block.id})
            }).catch(error => {
                console.error('Failed to create content block from request:', error);
                respondWithError({message: error});
            });
            break;
        case 'addContentBlock': //Requested to add a new content block to the queue
            if (data.block == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                rerunState.player.enqueueBlock(contentBlock);
                respondWith({message: 'Enqueued content block ' + data.block.id})
            }).catch(error => {
                console.error('Failed to enqueue new content block:', error);
                respondWithError({message: error});
            });
            break;
        //Event requests
        case 'getEvents': //Requested a list of UserEvents
            respondWith(rerunState.userEventManager.getEvents());
            break;
        case 'createEvent':
            if (data.type == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            let newEvent = createUserEventFromRequest(data);
            let newEventId = rerunState.userEventManager.addEvent(newEvent);
            respondWith({message: 'Created new event with id=' + newEventId});
            sendControlPanelAlert('setEventList', rerunState.userEventManager.getEvents());

            break;
        case 'updateEvent': //Request to update an existing userEvent
            if (data.eventId == null || data.newEvent == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            let updatedEvent = createUserEventFromRequest(data.newEvent);

            rerunState.userEventManager.updateEvent(data.eventId, updatedEvent);
            respondWith({message: 'Updated event id=' + data.eventId});
            sendControlPanelAlert('setEventList', rerunState.userEventManager.getEvents());
            break;
        case 'deleteEvent':
            if (data.eventId == null) {
                respondWithError(invalidArgumentsError);
                break;
            }

            rerunState.userEventManager.removeEvent(data.eventId);
            respondWith({message: 'Removed event with id =' + data.eventId});
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

function createContentBlockFromRequest(requestedBlock: any) : Promise<ContentBlock> {
    return new Promise((resolve, reject) => {
        //Try to create the MediaObject
        createMediaObjectFromRequest(requestedBlock.media).then((mediaObject : MediaObject) => {
            let block = new ContentBlock(uuidv4(), mediaObject);
            block.colour = requestedBlock.colour;
            block.playbackConfig = requestedBlock.playbackConfig;
            resolve(block);
        }).catch(error => reject(error));
    });
}

function createMediaObjectFromRequest(requestedMedia: any) : Promise<MediaObject> {
    return new Promise((resolve, reject) => {
        let newMedia = MediaObject.CreateEmpty(requestedMedia.type);
        newMedia.name = requestedMedia.name;
    
        switch (requestedMedia.type) {
            case 'Local video file':
                //Check that the file exists
                if (fs.existsSync(requestedMedia.location.path)) {
                    if (!fs.lstatSync(requestedMedia.location.path).isDirectory()) {
                        //Get file metadata for this media object
                        mediaObjectFromVideoFile(requestedMedia.location.path).then((generatedMedia: MediaObject) => {
                            generatedMedia.name = requestedMedia.name; //Set the requested name rather than the generated one
                            resolve(generatedMedia);
                        }).catch(error => reject(error));
                    } else {
                        reject('Failed to create MediaObject from request: Provided path is a directory, not a file');
                    }
                } else {
                    reject("Failed to create MediaObject from request: File not found");
                }
                break;
            case 'Youtube video':
                reject('YT not yet implemented');
                break;
            case 'RTMP stream':
                reject('RTMP not yet implemented');
                break;
            case 'Rerun title graphic':
                reject('Rerun graphic not yet implemented');
                break;
            default:
                reject('Unknown media type "' + requestedMedia.type + '"');
        }
    });
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

function injectIPIntoHTML(pathToHTML:PathLike, ipAddress:string) : string {
    let rawHTML = fs.readFileSync(pathToHTML);

    //Load it into a virtual DOM so that we can modify it
    let graphicDom = new JSDOM(rawHTML);
    
    let ipScriptTag = graphicDom.window.document.createElement("script");
    ipScriptTag.innerHTML = "window.rerunAddress = '" + ipAddress + "';";
    
    //Add this script tag to <head> as the first child
    let headTag = graphicDom.window.document.getElementsByTagName('head')[0];
    headTag.insertBefore(ipScriptTag, headTag.firstChild);

    return graphicDom.serialize();
}