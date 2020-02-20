import WebSocket = require("ws");
import { ClientRequest } from "http";
import { MediaObject } from "./playback/MediaObject";
import { Player } from "./playback/Player";
import { ContentRenderer } from './playback/renderers/ContentRenderer';
import { OBSVideoRenderer } from './playback/renderers/OBSVideoRenderer';
import { RerunGraphicRenderer } from './playback/renderers/RerunGraphicRenderer';
import { ContentBlock } from "./playback/ContentBlock";
import { WebsocketHeartbeat } from './helpers/WebsocketHeartbeat';
import { OBSConnection } from './OBSConnection';
import { PlayerBasedEvent } from './events/UserEventTypes';
import { ShowGraphicAction } from './events/UserEventActionTypes';
import { UserEventManager } from "./events/UserEventManager";
import { GraphicManager } from "./graphiclayers/GraphicManager";
import { LocalDirectorySource } from './contentsources/LocalDirectorySource';
import { ContentSourceManager } from "./contentsources/ContentSourceManager";
import { VideoJSRenderer } from "./playback/renderers/videojs/VideoJSRenderer";
import { Request, Response } from "express";
import { PathLike } from "fs";
import { WebVideoDownloader } from './WebVideoDownloader';
import ControlPanelHandler from './ControlPanelHandler';
import { GraphicsLayerLocation, WebBufferLocation } from './playback/MediaLocations';

const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const path = require('path');
const fs = require('fs');
const os = require('os');
const colors = require('colors');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

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

export type ContentTypeRendererMap = {[contentType in MediaObject.ContentType] : {renderer: ContentRenderer, focus: Function}};
export class RerunStateObject {
    obs: OBSStateObject; renderers: ContentTypeRendererMap = {} as ContentTypeRendererMap;
    graphicsManager: GraphicManager;
    downloadBuffer: WebVideoDownloader;
    controlPanelHandler : ControlPanelHandler;
    contentSourceManager: ContentSourceManager;
    player: Player;
    userEventManager: UserEventManager;
};
const rerunState = new RerunStateObject();
rerunState.controlPanelHandler = new ControlPanelHandler(rerunState);

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
    localVidRenderer.stop();
    rerunState.renderers[MediaObject.ContentType.LocalFile] = {
        renderer: localVidRenderer, focus: () => rerunState.obs.connection.moveSourceToTop(rerunState.obs.sources.localVideo)
    };

    //Graphic title renderer
    const graphicTitleRenderer = new RerunGraphicRenderer(rerunState.graphicsManager.sendGraphicEvent);
    rerunState.renderers[MediaObject.ContentType.GraphicsLayer] = {
        renderer: graphicTitleRenderer, focus: () => {} //Noop - the graphic renderer is on a user-defined OBS source, we don't control it
    };

    //Web video renderer
    const webVidRenderer = new VideoJSRenderer(rerunState.obs.sources.webVideo, );
    rerunState.renderers[MediaObject.ContentType.WebStream] = {
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

    //Use the title screen graphic as the default block (when nothing else is available)
    const titleScreenGraphicName = 'Title screen';
    const titleScreenGraphicLocation = new GraphicsLayerLocation('FHTV title slate');
    const titleBlock = new ContentBlock('titleBlock', new MediaObject(MediaObject.MediaType.RerunGraphic, titleScreenGraphicName, titleScreenGraphicLocation, Number.POSITIVE_INFINITY));

    rerunState.player = new Player(rerunState.renderers, titleBlock);

    rerunState.player.on('newCurrentBlock', (newCurrentBlock) => {
        rerunState.controlPanelHandler.sendAlert('setPlayerState', rerunState.player.getState());
    });

    rerunState.player.on('queueChange', (newQueue) => {
        rerunState.controlPanelHandler.sendAlert('setPlayerState', rerunState.player.getState());
    });

    rerunState.player.on('playbackStateChange', (newPlaybackState) => {
        rerunState.controlPanelHandler.sendAlert('setPlayerState', rerunState.player.getState());
    });

    rerunState.player.on('paused', (pauseReason) => rerunState.controlPanelHandler.sendAlert('setPlayerState', rerunState.player.getState()));

}).then(() => {

    console.info('[Startup] Creating download buffer...');
    rerunState.downloadBuffer = new WebVideoDownloader(path.join(__dirname + '/../temp'));
    rerunState.downloadBuffer.cleanBuffer().then((n) => {
        if (n > 0) {
            console.info('Cleaned ' + n + ' files from download buffer');
        }
    }).catch((error) => console.error('Failed to clean download buffer', error));

    const itemsToPreload = 3;

    rerunState.player.on('queueChange', (newQueue : ContentBlock[]) => {
        for (let i = 0; i < Math.min(itemsToPreload, newQueue.length); i++) {
            let block = newQueue[i];
            if (block.media.location instanceof WebBufferLocation) {
                rerunState.downloadBuffer.getJobFromLocation(block.media.location).start();
            }
        }
    });

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
        new ShowGraphicAction('FHTV title slate', rerunState.graphicsManager.sendGraphicEvent, 2000), 1500
    );
    rerunState.userEventManager.addEvent(titleEvent);

    let lowerBarEvent = new PlayerBasedEvent('Up next bar', 
        rerunState.player, PlayerBasedEvent.TargetEvent.PlaybackStart, 1, 
        new ShowGraphicAction('Up next bar', rerunState.graphicsManager.sendGraphicEvent), 3000
    );
    rerunState.userEventManager.addEvent(lowerBarEvent);    

}).then(() => {

    console.info('[Startup] Loading content sources...');
    rerunState.contentSourceManager = new ContentSourceManager(rerunState.player);

    rerunState.contentSourceManager.addChangeListener((sources) => {
        rerunState.controlPanelHandler.sendAlert('setContentSources', sources);
    });

    const sampleDirectory = "C:/Users/pangp/Videos/YT Testing videos";
    let local = new LocalDirectorySource('Sample videos', sampleDirectory);
    local.setShuffle(true);
    rerunState.contentSourceManager.addSource(local);    

    rerunState.contentSourceManager.updateAutoPoolNow();

}).then(() => {

    console.info('[Startup] Starting control panel app...');

    app.ws('/controlWS', function(ws:WebSocket, req:ClientRequest) {
        new WebsocketHeartbeat(ws);
        rerunState.controlPanelHandler.registerWebsocket(ws);
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

    /*
    //Youtube video samples
    const enqueueSamples = () => {
        const url = ytSampleUrls[samplesFetched];
        const videoId = new URLSearchParams(url.split('?')[1]).get('v');
        getVideoMetadata(videoId).then((metadata) => {
            let duration : Duration = moment.duration(metadata.contentDetails.duration); //Duration is in ISO8601 format
            try {
                let media = new MediaObject(
                    MediaObject.MediaType.YouTubeVideo, metadata.snippet.title, 
                    rerunState.downloadBuffer.bufferYoutubeVideo(ytSampleUrls[samplesFetched]),
                    duration.asMilliseconds()
                );
                media.thumbnail = metadata.snippet.thumbnails.default.url;
                rerunState.player.enqueueBlock(new ContentBlock('ytSample' + samplesFetched, media));
            } catch (error) {
                console.error("Couldn't create Youtube MediaObject", error);
            }

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

    //enqueueSamples();
});

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