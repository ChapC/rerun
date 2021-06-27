import WebSocket = require("ws");
import express from 'express';
import expressWs from 'express-ws';
import fs from "fs";
import { MediaObject } from "./playback/MediaObject";
import { Player, PlaybackOffset, PlayerEvent, PlaybackNodeSnapshot } from "./playback/Player";
import { ContentRenderer, ContentRendererListenerGroup } from './playback/renderers/ContentRenderer';
import { OBSVideoRenderer } from './playback/renderers/OBSVideoRenderer';
import { RerunGraphicRenderer } from './playback/renderers/RerunGraphicRenderer';
import { ContentBlock } from "./playback/ContentBlock";
import { GraphicPackageLoader, GraphicLayerReference } from "./graphicspackages/GraphicPackageLoader";
import { ContentSourceManager } from "./contentsources/ContentSourceManager";
import { PathLike } from "fs";
import { WebVideoDownloader } from './WebVideoDownloader';
import ControlPanelSockets from './networking/ControlPanelSockets';
import { GraphicsLayerLocation, WebBufferLocation, LocalFileLocation } from './playback/MediaLocations';
import RerunUserSettings from "./RerunUserSettings";
import { AlertContainer } from "./helpers/AlertContainer";
import StartupSteps from "./StartupSteps";
import { JSONSavable } from "./persistence/JSONSavable";
import { WSConnection, WSSuccessResponse } from "@rerun/common/src/networking/WebsocketConnection";
import OBS, { GraphicsModule, SpeakerLayout, EncoderConfig, VideoEncoderType, AudioEncoderType, OBSString, OBSInt, OBSClient, OBSOrder, OBSBool } from '../obs/RerunOBSBinding'; 
import RendererPool from "./playback/renderers/RendererPool";
import RenderHierarchy, { OBSRenderHierarchy } from "./playback/renderers/RenderHierarchy";
import { SaveableFileUtils } from "./persistence/SaveableFileUtils";
import Rule from "./rules/Rule";
import DynamicFactory from "./helpers/DynamicFactory";
import RuleCondition from "./rules/RuleCondition";
import RuleAction from "./rules/RuleAction";
import DuringBlockPlaybackCondition from "./rules/conditions/DuringBlockPlaybackCondition";
import InBetweenBlocksCondition from "./rules/conditions/InBetweenBlocksCondition";
import ShowGraphicAction from "./rules/actions/ShowGraphicAction";
import WebsocketLobby from "./networking/WebsocketLobby";
import WSPublishRepeater from "./networking/WSPublishRepeater";
import { NodePlaybackStatus } from "./playback/PlaybackNode";

const app = expressWs(express()).app;
const path = require('path');
const os = require('os');
const colors = require('colors');

const RERUN_VERSION: number = 0.1;
const environment = process.env["NODE_ENV"] || 'dev';

const saveFolder = path.join(environment === 'dev' ? process.cwd() : path.dirname(process.execPath), 'userdata');

/**
 * A container class holding a bunch of components making up Rerun.
 */
export class PublicRerunComponents {
    version = RERUN_VERSION;
    localIP: string;
    alerts: AlertContainer;
    obs: OBSClient;
    rendererPool: RendererPool;
    renderHierarchy: RenderHierarchy;
    player: Player;

    browserGraphicSockets: WebsocketLobby;
    graphicsLoader: GraphicPackageLoader;
    graphicsPublishGroup: WSPublishRepeater;

    userSettings: RerunUserSettings;
    downloadBuffer: WebVideoDownloader;
    contentSourceManager: ContentSourceManager;
    controlPanelHandler: ControlPanelSockets = ControlPanelSockets.getInstance();
};

export type ContentTypeRendererMap = {[contentType in MediaObject.ContentType] : {renderer: ContentRenderer, focus: Function}};
const rerunState = new PublicRerunComponents();

console.info(colors.magenta.bold(`-- Rerun v${RERUN_VERSION} --`));

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
    rerunState.localIP = "127.0.0.1";
}

//Alerts listener
const ControlPanelAlertsChannel = 'alerts';
rerunState.alerts = new AlertContainer();
rerunState.alerts.addChangeListener((alerts) => ControlPanelSockets.getInstance().publish(ControlPanelAlertsChannel, alerts));
ControlPanelSockets.getInstance().registerEmptyHandler('getAlerts', () => new WSSuccessResponse(rerunState.alerts.getAlerts()));

//Startup chain
let startup = new StartupSteps(rerunState);
/*A series of promises called in sequence. If one is failed, 
* then startup is cancelled and subsequent promises will not be called
* until the process is restarted.
*/

startup.appendStep("Save data", (rerunState, l) => {
    //Create the userdata folder if it doesn't already exist
    return new Promise((resolve, reject) => {
        fs.mkdir(saveFolder, { recursive: true }, (error) => {
            if (!error) {
                rerunState.userSettings = new RerunUserSettings();
                let savePath = path.join(saveFolder, 'settings.json');

                if (fs.existsSync(savePath)) {
                    l.info(`Reading settings from ${savePath}`);
                    SaveableFileUtils.updateMutableFromFile(rerunState.userSettings, savePath).then(resolve).catch(reject);
                } else {
                    l.info(`Writing default settings to ${savePath}`);
                    SaveableFileUtils.writeSaveableToFile(rerunState.userSettings, savePath).then(resolve).catch(reject); //Write the default settings to the file
                }

                rerunState.userSettings.onPropertiesUpdated(() => SaveableFileUtils.writeSaveableToFile(rerunState.userSettings, savePath));
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

let expressServer: any;
startup.appendStep("Web server", (rerunState, l) => {
    l.info('Launching control panel app...');
    app.ws('/controlWS', function(ws:WebSocket, req) {
        ControlPanelSockets.getInstance().acceptWebsocket(ws);
    });

    return new Promise((resolve) => {
        expressServer = app.listen(8080, () => {
            l.info('Started listening on port 8080');
            l.info(colors.bold.green('View the control panel at ' + colors.underline('http://' + rerunState.localIP + ':8080') + ' on your local network'));
            resolve();
        });
    });
}, function cleanup() {
    if (expressServer) {
        expressServer.close();
    }
});

startup.appendStep("OBS", (rerunState, l) => {
    let moduleBinPath = path.resolve(process.cwd(), 'obs/bin/x64');
    let moduleDataPath = path.resolve(process.cwd(), 'obs/data/plugins');
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

const graphicsWebSocketPath = '/graphicsWS';
startup.appendStep("Graphics web browser socket", (rerunState, l) => {
    return new Promise((resolve, reject) => {
        rerunState.browserGraphicSockets = new WebsocketLobby(graphicsWebSocketPath);
        rerunState.graphicsPublishGroup = new WSPublishRepeater();
        l.info('Opening websocket...');

        try {
            app.ws(graphicsWebSocketPath, (ws, req) => {
                let wsConn = new WSConnection(ws);
                rerunState.graphicsPublishGroup.addWebsocket(wsConn);
                rerunState.browserGraphicSockets.acceptWebsocket(wsConn, req);
            });
            resolve();
        } catch (error) {
            reject(error);
        }

    });
}, function cleanup() {
    if (rerunState.browserGraphicSockets) {
        rerunState.browserGraphicSockets.closeAllWaiting();
    }
});

startup.appendStep("Graphics packages", (rerunState, l) => {
    l.info('Importing packages...')
    const packagePath = './graphics';

    //TODO: Create /graphics if it doesn't exist
    let browserClientPath = environment === 'dev' ? path.join(process.cwd(), '../webgraphics/build/browserclient.min.js') : path.join(process.execPath, 'browserclient.min.js');
    rerunState.graphicsLoader = new GraphicPackageLoader(packagePath, app, browserClientPath, RERUN_VERSION);
    
    //Serve up all the static files in the graphics package path (JS, images)
    app.use('/graphics', express.static(packagePath));

    return new Promise((resolve, reject) => {
        //Scan for GraphicsPackage definitions
        rerunState.graphicsLoader.importPackages().then((packages) => {
            l.info('Imported (' + packages.length + ') graphics packages');
            resolve();
        }).catch(err => reject('Failed to import graphics packages: ' + err.toString()));
    });
}, function cleanup() {
    rerunState.graphicsLoader = null;
});

startup.appendStep("Content renderers", (rerunState, l) => {
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
            width: new OBSInt(1920), height: new OBSInt(1080), reroute_audio: new OBSBool(true), //fps_custom: new OBSInt(60) //TODO: Match OBS video settings
        });
        return new RerunGraphicRenderer(id, browserSource, rerunState.browserGraphicSockets, rerunState.graphicsLoader.getLongLayerURL);
    }
    rerunState.rendererPool.addRendererFactory(MediaObject.ContentType.GraphicsLayer, createGraphicRenderer);

    //TODO BEFORE BELOW - Fix up MediaObjects so that they're immutable (YT downloads should affect ContentBlocks, not MediaObjects - will have to allow preloads to swap out)
    //TODO: Change the socket behavior so that individual VJS clients connect to specific renderers.
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

startup.appendStep("Download buffer", (rerunState, l) => {
    l.info('Creating download buffer...');

    return new Promise((resolve, reject) => {
        try {
            let bufferPath = path.join(__dirname, '/../temp');
            if (!fs.existsSync(bufferPath)) {
                fs.mkdirSync(bufferPath);
            }

            rerunState.downloadBuffer = new WebVideoDownloader(bufferPath);
    
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

startup.appendStep("Player", (rerunState, l) => {
    l.info('Configuring player instance...');

    //Use the title screen graphic as the default block (when nothing else is available)
    let titleBlock = rerunState.graphicsLoader.createContentBlockWith(new GraphicLayerReference('Clean', 'Title slate'));
    
    rerunState.player = new Player(rerunState.rendererPool, rerunState.renderHierarchy, rerunState, titleBlock);

    //Send player events over websockets (for control panels and graphic clients)
    const PlayerTreeChannel = 'player-tree';

    rerunState.player.on(PlayerEvent.TreeChanged, (newTree: PlaybackNodeSnapshot[]) => {
        ControlPanelSockets.getInstance().publish(PlayerTreeChannel, newTree);
        rerunState.graphicsPublishGroup.publish(PlayerTreeChannel, newTree);
    });

    let initialTree = rerunState.player.getTreeSnapshot();
    ControlPanelSockets.getInstance().publish(PlayerTreeChannel, initialTree);
    rerunState.graphicsPublishGroup.publish(PlayerTreeChannel, initialTree);

    return Promise.resolve();
}, function cleanup() {
    rerunState.player.cancelAllListeners();
    rerunState.player = null;
});

startup.appendStep("Download buffer hook", (rerunState, l) => {
    const itemsToPreload = 3;
    
    //Depth-first search for preload-able items
    // rerunState.player.on(PlayerEvent.TreeChanged, (newTree : PlaybackNodeSnapshot[]) => {
    //     for (let i = 0; i < newTree.length; i++) {
    //         let root = newTree[i];
    //         if (block.media.location instanceof WebBufferLocation) {
    //             rerunState.downloadBuffer.getJobFromLocation(block.media.location).start();
    //         }
    //     }
    // });

    return Promise.resolve();
}, function cleanup() {});

startup.appendStep("Content sources", (rerunState, l) => {
    l.info('Loading content sources...');

    return new Promise((resolve, reject) => {
        try {
            rerunState.contentSourceManager = new ContentSourceManager(path.join(saveFolder, 'contentsources.json'), rerunState.player);
            JSONSavable.updateSavable(rerunState.contentSourceManager, rerunState.contentSourceManager.savePath).then(() => {
                rerunState.contentSourceManager.addChangeListener((sources) => {
                    ControlPanelSockets.getInstance().publish('cs-list', sources);
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

startup.appendStep('Rules', (rerunState, l) => {
    //The conditions and actions added to these factories will be available to the user when creating rules
    let ruleConditions = new DynamicFactory<RuleCondition>(rerunState);
    ruleConditions.registerConstructor('During a block', (r: PublicRerunComponents) => new DuringBlockPlaybackCondition(r.player));
    //ruleConditions.registerConstructor('Inbetween blocks', (r: PublicRerunComponents) => new InBetweenBlocksCondition())

    let ruleActions = new DynamicFactory<RuleAction>(rerunState);
    ruleActions.registerConstructor('Show a graphic', (r: PublicRerunComponents) => new ShowGraphicAction(r.graphicsLoader, r.player));

    let slateAfterEach = new Rule(ruleConditions, ruleActions);
    let cError = slateAfterEach.condition.trySetValue({
        alias: 'During a block',
        obj: { frequency:  1, playbackOffsetType: PlaybackOffset.Type.MsAfterStart, playbackOffsetSeconds: 5 }
    });

    let aError = slateAfterEach.action.trySetValue({
        alias: 'Show a graphic',
        obj: { targetLayerPath: 'Clean/Up next bar', onScreenDurationSecs: 12 }
    });

    slateAfterEach.condition.getValue().enable(slateAfterEach.action.getValue());

    return Promise.resolve();
}, function cleanup() {

});

startup.start();

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