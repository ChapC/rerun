import WebSocket = require("ws");
import fs from "fs";
import { ClientRequest } from "http";
import { MediaObject } from "./playback/MediaObject";
import { Player, EnqueuedContentBlock, PlaybackStartRelationship } from "./playback/Player";
import { ContentRenderer } from './playback/renderers/ContentRenderer';
import { OBSVideoRenderer } from './playback/renderers/OBSVideoRenderer';
import { RerunGraphicRenderer } from './playback/renderers/RerunGraphicRenderer';
import { ContentBlock } from "./playback/ContentBlock";
import { WebsocketHeartbeat } from './helpers/WebsocketHeartbeat';
import { GraphicManager, GraphicLayerReference } from "./graphiclayers/GraphicManager";
import { ContentSourceManager } from "./contentsources/ContentSourceManager";
import { PathLike } from "fs";
import { WebVideoDownloader } from './WebVideoDownloader';
import ControlPanelHandler from './ControlPanelHandler';
import { GraphicsLayerLocation, WebBufferLocation, LocalFileLocation } from './playback/MediaLocations';
import RerunUserSettings from "./RerunUserSettings";
import { AlertContainer } from "./helpers/AlertContainer";
import StartupSteps from "./StartupSteps";
import { JSONSavable } from "./persistance/JSONSavable";
import { WSConnection } from "./helpers/WebsocketConnection";
import OBS, { GraphicsModule, SpeakerLayout, EncoderConfig, VideoEncoderType, AudioEncoderType, OBSString, OBSInt, OBSClient, OBSOrder, OBSBool } from '../obs/RerunOBSBinding'; 
import RendererPool from "./playback/renderers/RendererPool";
import RenderHierarchy, { OBSRenderHierarchy } from "./playback/renderers/RenderHierarchy";
import { PlaybackOffset } from "./playback/PlaybackContentNode";
import { SaveableUtils } from "./persistance/SaveableUtils";

const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const path = require('path');
const os = require('os');
const colors = require('colors');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const supportedVideoExtensions = ['.mp4', '.mkv', '.flv', '.avi', '.m4v', '.mov'];
const saveFolder = path.join(__dirname, 'userdata');

//State type definition
export type ContentTypeRendererMap = {[contentType in MediaObject.ContentType] : {renderer: ContentRenderer, focus: Function}};
export class RerunStateObject {
    startup: StartupSteps;
    localIP: string;
    server: any; //ExpressJS server
    alerts: AlertContainer;
    obs: OBSClient;
    rendererPool: RendererPool;
    renderHierarchy: RenderHierarchy;
    userSettings: RerunUserSettings;
    graphicsManager: GraphicManager;
    downloadBuffer: WebVideoDownloader;
    contentSourceManager: ContentSourceManager;
    player: Player;
};
const rerunState = new RerunStateObject();
ControlPanelHandler.setRerunState(rerunState);

console.info(colors.magenta.bold('-- Rerun v0.1 --'));

//Find my local IP
for (var device in os.networkInterfaces()) {

    var iface = os.networkInterfaces()[device].filter(
        (details:any) => details.family === 'IPv4' && details.internal === false
    );

    if(iface.length > 0) {
        rerunState.localIP = iface[0].address;
    } 
}

if (rerunState.localIP == null) {
    console.warn("Failed to determine local IP address; graphics will only work locally on the server machine");
    rerunState.localIP = "127.0.0.1";
}

//Alerts listener
rerunState.alerts = new AlertContainer();
rerunState.alerts.addChangeListener((alerts) => ControlPanelHandler.getInstance().sendAlert('setAlerts', alerts));
ControlPanelHandler.getInstance().registerEmptyHandler('getAlerts', () => new WSConnection.SuccessResponse('alerts', rerunState.alerts.getAlerts()));

//Startup chain
rerunState.startup = new StartupSteps(rerunState);
/*A series of promises called in sequence. If one is failed, 
* then startup is cancelled and subsequent promises will not be called
* until the process is restarted.
*/

rerunState.startup.appendStep("Save data", (rerunState, l) => {
    //Create the userdata folder if it doesn't already exist
    return new Promise((resolve, reject) => {
        fs.mkdir(saveFolder, { recursive: true }, (error) => {
            if (!error) {
                rerunState.userSettings = new RerunUserSettings();
                let savePath = path.join(saveFolder, 'settings.json');
                SaveableUtils.updateMutableFromFile(rerunState.userSettings, savePath).then(resolve).catch(reject);
                rerunState.userSettings.onPropertiesUpdated(() => SaveableUtils.writeSaveableToFile(rerunState.userSettings, savePath));
            } else {
                l.error(error);
                reject("Couldn't access user data folder");
            }
        });
    });
}, function cleanup() {
    rerunState.userSettings.cancelAllPropertiesUpdatedListeners();
    rerunState.userSettings = null;
});

rerunState.startup.appendStep("Web server", (rerunState, l) => {
    l.info('Launching control panel app...');
    app.ws('/controlWS', function(ws:WebSocket, req:ClientRequest) {
        new WebsocketHeartbeat(ws);
        ControlPanelHandler.getInstance().acceptWebsocket(ws);
    });

    return new Promise((resolve) => {
        rerunState.server = app.listen(8080, () => {
            l.info('Started listening on port 8080');
            l.info(colors.bold.green('View the control panel at ' + colors.underline('http://' + rerunState.localIP + ':8080') + ' on your local network'));
            resolve();
        });
    });
}, function cleanup() {
    if (rerunState.server) {
        rerunState.server.close();
    }
    rerunState.server = null;
});

rerunState.startup.appendStep("OBS", (rerunState, l) => {
    let moduleBinPath = path.resolve(process.cwd(), 'obs/bin/x64')
    let moduleDataPath = path.resolve(process.cwd(), 'obs/data/plugins')
    let moduleConfigDir = path.resolve(process.cwd(), 'obs/data/plugin-config');

    //Launch OBS
    l.info('Starting OBS...');
    const actualWorkingDir = process.cwd();
    process.chdir(moduleBinPath);
    let initialized = OBS.init(
        //Video settings
        {
            module: GraphicsModule.Direct3D,
            fps: 30,
            width: 1920, height: 1080
        },
        //Audio settings
        {
            samples: 48000,
            speakerLayout: SpeakerLayout.Stereo
        },
        moduleConfigDir
    );

    if (!initialized) {
        return Promise.reject('Failed to initialize OBS');
    }

    //Import required modules
    obsLoadAllModules(moduleBinPath, moduleDataPath, [
        'obs-x264', 'obs-ffmpeg', 'obs-outputs', 'rtmp-services', 'obs-browser', 'vlc-video'
    ]);

    //Configure A/V encoders
    const videoEncoder: EncoderConfig = {
        encoder: VideoEncoderType.x264,
        encoderSettings: {
            rate_control: new OBSString('CBR'),
            bitrate: new OBSInt(2500),
            keyint_sec: new OBSInt(2),
            preset: new OBSString('veryfast')
        }
    };
    
    const audioEncoder: EncoderConfig = {
        encoder: AudioEncoderType.AAC,
        encoderSettings: {
            bitrate: new OBSInt(160)
        }
    };
    
    l.info('Setting up encoders...');
    OBS.setupEncoders(videoEncoder, audioEncoder);

    l.info('Setup complete');
    process.chdir(actualWorkingDir);

    OBS.openPreviewWindow();
    rerunState.obs = OBS;
    return Promise.resolve();
}, function cleanup() {
    OBS.shutdown();
});

rerunState.startup.appendStep("Graphics packages", (rerunState, l) => {
    l.info('Importing packages...')
    const packagePath = './graphics';

    //TODO: Create /graphics if it doesn't exist
    rerunState.graphicsManager = new GraphicManager(packagePath, rerunState.localIP, () => rerunState.player.getPlayingBlocks(), app);
    
    //Serve up all the static files in the graphics package path (JS, images)
    app.use('/graphics', express.static(packagePath));

    return new Promise((resolve, reject) => {
        //Scan for GraphicsPackage definitions
        rerunState.graphicsManager.importPackages().then((packages) => {
            l.info('Imported (' + packages.length + ') graphics packages');
            resolve();
        }).catch(err => reject('Failed to import graphics packages: ' + err.toString()));
    });
}, function cleanup() {
    rerunState.graphicsManager = null;
});

rerunState.startup.appendStep("Content renderers", (rerunState, l) => {
    l.info('Preparing content renderers...');

    rerunState.renderHierarchy = new OBSRenderHierarchy(rerunState.obs.getMainScene());
    rerunState.rendererPool = new RendererPool();
    //Add a factory to the renderer pool for each supported content type

    //Local video renderer
    let createLocalVideoRenderer = (id: number) => {
        let vlcSource = rerunState.obs.createSource('localvideo' + id, 'vlc_source', { loop: new OBSBool(false) });
        return new OBSVideoRenderer(id, vlcSource);
    }
    rerunState.rendererPool.addRendererFactory(MediaObject.ContentType.LocalFile, createLocalVideoRenderer);

    //Graphic title renderer
    let createGraphicRenderer = (id: number) => {
        let browserSource = rerunState.obs.createSource('graphic' + id, 'browser_source', {
            width: new OBSInt(1920), height: new OBSInt(1080), reroute_audio: new OBSBool(true), fps_custom: new OBSInt(30) //TODO: Match OBS video settings
        });
        return new RerunGraphicRenderer(id, browserSource, rerunState.graphicsManager.sendGraphicEvent);
    }
    rerunState.rendererPool.addRendererFactory(MediaObject.ContentType.GraphicsLayer, createGraphicRenderer);

    //TODO: Change the socket behaviour so that individual VJS clients connect to specific renderers.
    //This could probably be accomplished by having the OBS source connect to /vjs?=rendererId and updating rerunconnector.js to do dat
/* 
    //Web video renderer
    let createWebVideoRenderer = (id: number) => {
        let webSource = rerunState.obs.createSource('webvideo', 'browser_source', {
            width: new OBSInt(1920), height: new OBSInt(1080), reroute_audio: new OBSBool(true), shutdown: new OBSBool(true)
        });


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

        return new VideoJSRenderer(id, webSource);
    }
    rerunState.rendererPool.addRendererFactory(MediaObject.ContentType.WebStream, createWebVideoRenderer);

    //Serve the VideoJS webpage + static bits
    const pathToWebpage = path.join(__dirname, '/playback/renderers/videojs/webpage/videojs.html');
    const vjsPageWithIP = injectIPIntoHTML(pathToWebpage, rerunState.localIP + ':8080');

    app.use('/vjs', express.static(path.join(__dirname, '/playback/renderers/videojs/webpage'))); 
    app.get('/vjs', function(req:Request, res:Response) {
        res.send(vjsPageWithIP);
    }); */

    return Promise.resolve();
}, function cleanup() {
    //rerunState.renderers = null; TODO Add a destroy method to each factory (NOT the ContentRenderer - I still want to try to keep that separate from OBS)
});

rerunState.startup.appendStep("Download buffer", (rerunState, l) => {
    l.info('Creating download buffer...');

    return new Promise((resolve, reject) => {
        try {
            rerunState.downloadBuffer = new WebVideoDownloader(path.join(__dirname + '/../temp'));
    
            rerunState.downloadBuffer.cleanBuffer().then((n) => {
                if (n > 0) {
                    l.info('Cleaned ' + n + ' files from download buffer');
                }
                resolve();
            }).catch((error) => reject(error));

        } catch (error) {
            l.error("Failed to initialize download buffer", error);
            reject();
        }
    });

}, function cleanup() {
    rerunState.downloadBuffer = null;
});

rerunState.startup.appendStep("Player", (rerunState, l) => {
    l.info('Configuring player instance...');

    //Use the title screen graphic as the default block (when nothing else is available)
    const titleScreenGraphicName = 'Title slate';
    const titleScreenGraphicLocation = new GraphicsLayerLocation(new GraphicLayerReference('Clean', 'Title slate'));
    const titleBlock = new ContentBlock('titleBlock', new MediaObject(MediaObject.MediaType.RerunGraphic, titleScreenGraphicName, titleScreenGraphicLocation, Number.POSITIVE_INFINITY));
    titleBlock.transitionInMs = 1000;
    titleBlock.transitionOutMs = 800;
    
    rerunState.player = new Player(rerunState.rendererPool, rerunState.renderHierarchy, rerunState, titleBlock);

    rerunState.player.on('activePlaybackChanged', (newState) => {
        ControlPanelHandler.getInstance().sendAlert('playerStateChanged', newState);
    });

    rerunState.player.on('queueChanged', (newState) => {
        ControlPanelHandler.getInstance().sendAlert('playerQueueChanged', newState);
    });

    return Promise.resolve();
}, function cleanup() {
    rerunState.player.cancelAllListeners();
    rerunState.player = null;
});

//The top {itemsToPreload} items in the queue should be downloaded into the buffer
rerunState.startup.appendStep("Download buffer hook", (rerunState, l) => {
    const itemsToPreload = 3;
    
    rerunState.player.on('queueChange', (newQueue : ContentBlock[]) => {
        for (let i = 0; i < Math.min(itemsToPreload, newQueue.length); i++) {
            let block = newQueue[i];
            if (block.media.location instanceof WebBufferLocation) {
                rerunState.downloadBuffer.getJobFromLocation(block.media.location).start();
            }
        }
    });

    return Promise.resolve();
}, function cleanup() {});

rerunState.startup.appendStep("Graphics layer socket", (rerunState, l) => {
    return new Promise((resolve, reject) => {
        l.info('Opening websocket...');

        try {
            app.ws('/graphicEvents', function(ws:WebSocket, req:any) {
                console.info('Graphic client [' + req.query.layer + '@' + req.connection.remoteAddress +'] connected');
                new WebsocketHeartbeat(ws);

                let layerPath = req.query.layer.split('/');
                let layerRef = new GraphicLayerReference(layerPath[0], layerPath[1]);

                ws.on('close', () => {
                    console.info('Graphic client [' + req.query.layer + '@' + req.connection.remoteAddress +'] disconnected');
                    let layerPath = req.query.layer.split('/');
                    rerunState.graphicsManager.removeWebsocket(ws, layerRef);
                });
        
                rerunState.graphicsManager.addWebsocket(ws, layerRef);
            });
            resolve();
        } catch (error) {
            reject(error);
        }

    });
}, function cleanup() {});

// rerunState.startup.appendStep("User events", (rerunState, l) => {
//     return new Promise((resolve, reject) => {
//         l.info('Fetching events...');
//         try {
//             rerunState.userEventManager = new UserEventManager(path.join(saveFolder, 'events.json'), rerunState);
        
//             //Built-in event logic types
//             rerunState.userEventManager.eventLogicTypes.registerSubtype("During a block", (r) => new InBlockLogic(r.player));
//             //rerunState.userEventManager.eventLogicTypes.registerSubtype("In-between blocks", (r) => new BetweenBlockLogic(r.player));
//             //Built-in event action types
//             rerunState.userEventManager.eventActionTypes.registerSubtype("Show a graphic", (r) => new ShowGraphicAction(r.graphicsManager));

//             //TODO: Plugins should be able to define their own event logic and action types

//             //Listeners
//             rerunState.userEventManager.addChangeListener((events) => ControlPanelHandler.getInstance().sendAlert('setEventList', events));
//             rerunState.userEventManager.addChangeListener((events) => JSONSavable.serializeJSON(rerunState.userEventManager.toJSON(), rerunState.userEventManager.savePath))
            
//             //Try load from saved events
//             JSONSavable.updateSavable(rerunState.userEventManager).then(resolve).catch(reject);
//         } catch (error) {
//             reject(error);
//         }
//     });
// }, function cleanup() {
//     rerunState.userEventManager = null;
//     rerunState.userEventManager.cancelAllListeners();
// });
 
rerunState.startup.appendStep("Content sources", (rerunState, l) => {
    l.info('Loading content sources...');

    return new Promise((resolve, reject) => {
        try {
            rerunState.contentSourceManager = new ContentSourceManager(path.join(saveFolder, 'contentsources.json'), rerunState.player);
            JSONSavable.updateSavable(rerunState.contentSourceManager, rerunState.contentSourceManager.savePath).then(() => {
                rerunState.contentSourceManager.addChangeListener((sources) => {
                    ControlPanelHandler.getInstance().sendAlert('setContentSources', sources);
                });
        
                rerunState.contentSourceManager.updateAutoPoolNow();
                resolve();
            }).catch(error => reject(error));
    
        } catch (error) {
            reject(error);
        }
    });

}, function cleanup() {
    if (rerunState.contentSourceManager) {
        rerunState.contentSourceManager.cancelAllListeners();
    }
    rerunState.contentSourceManager = null;
});

rerunState.startup.appendStep('Rules', (rerunState, l) => {

    const titleScreenGraphicName = 'Title slate';
    const titleScreenGraphicLocation = new GraphicsLayerLocation(new GraphicLayerReference('Clean', 'Title slate'));
    const titleBlock = new ContentBlock('stingerBlockTitle', new MediaObject(MediaObject.MediaType.RerunGraphic, titleScreenGraphicName, titleScreenGraphicLocation, 5000));
    titleBlock.transitionInMs = 1000;
    titleBlock.transitionOutMs = 800;

    let everySecondProvider = (queue: EnqueuedContentBlock[]) => {
        let blocks = [];
        for (let i = 0; i < queue.length; i++) {
            if (i % 2 === 0) {
                blocks.push({
                    block: titleBlock,
                    relativeTarget: queue[i],
                    startRelationship: PlaybackStartRelationship.Sequenced,
                    offset: new PlaybackOffset(PlaybackOffset.Type.MsBeforeEnd, titleBlock.transitionInMs)
                });
            }
        }
        return blocks;
    }

    rerunState.player.addTempNodeProvider(everySecondProvider);

    return Promise.resolve();
}, function cleanup() {

});

rerunState.startup.start();

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

function obsLoadAllModules(binDirectory: string, dataDirectory: string, moduleNames: string[]) {
    for (let moduleName of moduleNames) {
        try {
            let fullBinarypath = path.join(binDirectory, moduleName + '.dll');
            let fullDataPath = path.join(dataDirectory, moduleName);
            OBS.loadModule(fullBinarypath, fullDataPath);
        } catch (ex) {
            console.error('Failed to load module ' + moduleName);
        }
    }
}