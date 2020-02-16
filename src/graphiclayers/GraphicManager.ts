import fs, { PathLike, Stats } from "fs";
import WebSocket = require("ws");
import { PlayerState } from "../playback/Player";
import { MediaObject } from "../playback/MediaObject";
import { Request, Response } from "express";
const recursive = require("recursive-readdir");
const path = require('path');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const initRerunReference = require('./graphicLayerInjection').script;

export class GraphicManager {
    private graphicsFolder : PathLike; //The root folder to scan for graphics packages
    private availablePackages : GraphicPackage[]; //The list of graphics packages found in graphicsFolder
    private serverAddress : string;
    private connectedWebsockets : {[layerName: string] : WebSocket[]} = {};
    private fetchPlayerState : () => PlayerState;
    private expressApp : any;

    private activePackage : GraphicPackage; //The graphics package currently in use (selected by the user)

    constructor(graphicsFolder: PathLike, serverAddress: string, getPlayerState: () => PlayerState, expressApp: any) {
        this.graphicsFolder = graphicsFolder;
        this.serverAddress = serverAddress;
        this.fetchPlayerState = getPlayerState;
        this.expressApp = expressApp;
    }

    //Sends a graphic event to websockets from the target layer (and optionally the target websocket)
    sendGraphicEvent = (event:string, toLayer:string, toSocket?:WebSocket) => {
        //TODO: Allow the user to load as many 'active' packages as they want    

        //Graphic events contain the event name and the player's current state
        let eventObj = {name: event, playerState: this.fetchPlayerState()}
    
        if (toSocket) { //Send the event to toSocket only
            //We still need to check that toSocket is subscribed to toLayer's events
            let layerSockets = this.connectedWebsockets[toLayer];
            if (layerSockets == null || layerSockets.indexOf(toSocket) === -1) {
                return; //toSocket is not meant to receive this event
            }

            if (toSocket.readyState === 1) {
                toSocket.send(JSON.stringify(eventObj));
            }
        } else { //Send the event to all graphic clients
            console.info('[Graphic event-' + toLayer +'] ' + event);
            let layerSockets = this.connectedWebsockets[toLayer];
            if (layerSockets == null) {
                return; //There are no sockets listening for events on this layer
            }
            for (let socket of layerSockets) {
                if (socket.readyState === 1) {
                    socket.send(JSON.stringify(eventObj));
                }
            }
        }
    }

    setActivePackage = (packageName: string) => {
        if (this.activePackage != null && this.activePackage.packageName === packageName) {
            return; //The requested package is already active
        }

        let targetPackage;

        for (let graphicPackage of this.availablePackages) {
            if (graphicPackage.packageName === packageName) {
                targetPackage = graphicPackage;
                break;
            }
        }

        if (targetPackage != null) {
            if (this.activePackage != null) {
                //Tear down the express routes leading to the active package
                for (let layer of this.activePackage.layers) {
                    const layerUrl = '/layer/' + encodeURI(layer.name);
                    removeRoute(layerUrl, this.expressApp);
                    console.info('Tore down graphic layer "' + layer.name + '" at ' + layerUrl);
                }
            }

            this.activePackage = targetPackage;

            //Create express routes for each layer of this package
            for (let layer of this.activePackage.layers) {
                const layerUrl = '/layer/' + encodeURI(layer.name);
                this.expressApp.get(layerUrl, (req : Request, res : Response) => {
                    res.send(layer.html);
                });
                console.info('Served graphic layer "' + layer.name + '" at ' + layerUrl);
            }

        } else {
            console.error('Could not set active packge - There is no available package called "' + packageName + '"');
        }
    }

    //Registers a websocket to receive graphic events for the target layer
    addWebsocket(socket: WebSocket, forLayerName:string) {
        let socketList = this.connectedWebsockets[forLayerName];
        if (socketList == null) {
            this.connectedWebsockets[forLayerName] = [];
            socketList = this.connectedWebsockets[forLayerName];
        }
        socketList.push(socket);

        //Check if a rerun graphic is currently playing and, if so, send the start event now
        const currentBlock = this.fetchPlayerState().currentBlock;
        if (currentBlock.media.type === MediaObject.MediaType.RerunGraphic) {
            this.sendGraphicEvent('in', currentBlock.media.location.getPath(), socket);
        }
    }

    removeWebsocket(socket: WebSocket, forLayerName:string) {
        let socketList = this.connectedWebsockets[forLayerName];
        if (socketList == null) {
            return;
        }

        for (let i = 0; i < socketList.length; i++) {
            if (socketList[i] === socket) {
                socketList.splice(i, 1);
                break;
            }
        }
    }

    importPackages() : Promise<GraphicPackage[]> {
        //Scan for graphics packages
        this.availablePackages = [];

        //Only search for graphic packages (files called "graphicpackage.json")
        const graphicPackagesOnly = (file:string, stats:Stats) => !stats.isDirectory() && path.basename(file) != 'graphicspackage.json';

        return new Promise((resolve, reject) => {
            recursive(this.graphicsFolder, [graphicPackagesOnly], (err:Error, files:string[]) => {
                if (!err) {
                    //files is a list of "graphicpackage.json" file paths
                    files.forEach((filePath) => {
                        let fileContents = fs.readFileSync(filePath).toString();

                        let graphicPackage = GraphicPackage.createFromJSON(fileContents);

                        if (graphicPackage == null) {
                            console.warn('Could not import graphics package at ' + filePath)
                            return;
                        }
        
                        this.availablePackages.push(graphicPackage);
                        
                        //Import the HTML of the package's layers and inject the rerun connection script into them
                        for (let layer of graphicPackage.layers) {
                            let modifiedHTML = importGraphicHTML(path.join(path.dirname(filePath), layer.path), this.serverAddress, layer.name);
                            layer.html = modifiedHTML;
                        }

                    });
                    resolve(this.availablePackages);
                } else {
                    reject(err);
                }
            });
        });
    }

    getAvailablePackages() : GraphicPackage[] {
        return this.availablePackages;
    }
}

function removeRoute(routePath: string, expressApp: any) {
    //Loop through expressApp's middlewares and remove any with routePath
    for (let i = 0; i < expressApp._router.stack.length; i++) {
        let route = expressApp._router.stack[i].route;
        if (route != null) {
            if (route.path === routePath) {
                expressApp._router.stack.slice(i, 1);
                return;
            }
        }
    }
}

//Read in a graphic layer HTML file, inject the rerun script and return the resulting html document as a string
function importGraphicHTML(pathToHTMLFile:string, localIP:string, layerName:string) : string {
    //Read in the HTML from the target file
    let rawHTML = fs.readFileSync(pathToHTMLFile);

    //Load it into a virtual DOM so that we can modify it
    let graphicDom = new JSDOM(rawHTML);
    //Inject some JS into the DOM that creates the window.rerun link for the graphic can access
    let initFunctionString = initRerunReference.toString().slice(13, -1); //Remove the "function() {" and "}" from the function string
    //Replace any server-side variables with their string value
    initFunctionString = initFunctionString.replace(/localIP/g, "'" + localIP + "'");
    initFunctionString = initFunctionString.replace(/mLayerName/g, "'" + encodeURIComponent(layerName) + "'");
    
    let initRerunScriptTag = graphicDom.window.document.createElement("script");
    initRerunScriptTag.innerHTML = initFunctionString;
    
    //Add this script tag to <head> as the first child
    let headTag = graphicDom.window.document.getElementsByTagName('head')[0];
    headTag.insertBefore(initRerunScriptTag, headTag.firstChild);

    return graphicDom.serialize();
}

class GraphicPackage {
    packageName: string;
    layers: GraphicLayer[];

    static createFromJSON(json:string) : GraphicPackage {
        let parsed = JSON.parse(json);
        if (parsed == null) {
            return null;
        }

        let pkg = new GraphicPackage();

        if (!parsed.name) {
            return null;
        }
        pkg.packageName = parsed.name;

        if (!parsed.layers) {
            return null;
        }

        pkg.layers = [];
        try {
            //Read in the GraphicLayers
            for (let layerObj of parsed.layers) {
                const gLayer = GraphicLayer.fromObject(layerObj);
                if (gLayer != null) {
                    pkg.layers.push(gLayer);
                }
            }
        } catch (ex) {
            console.error('Error while importing layers from graphic package "' + pkg.packageName + '":', ex);
            return null;
        }

        return pkg;
    
    }
}

class GraphicLayer {
    path: string; //The path to the raw HTML file
    name: string; //Friendly name of the layer
    animationTimings: {[eventName: string] : Number}; //Map of [graphic event : animation duration]
    html: string; //Processed html string

    constructor(path:string, name:string) {
        this.path = path;
        this.name = name;
        this.animationTimings = {};
    }

    static fromObject(object:any) : GraphicLayer {
        if (!object.name || !object.path) {
            return null;
        }
        let layer = new GraphicLayer(object.path, object.name);

        //Animation timings are optional
        if (object.timings) {
            for (let eventName in object.timings) {
                layer.animationTimings[eventName] = object.timings[eventName];
            }
        }

        return layer;
    }

    toJSON() : any {
        return {
            name: this.name, path: this.path, animationTimings: this.animationTimings
        }
    }
}

export class GraphicLayerReference {
    constructor(public packageName: string, public layerName:string) {}
}