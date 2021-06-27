import fs, { Stats } from "fs";
import Express from "express";
import { Request, Response } from "express";
import { Tree } from "../helpers/Tree";
import { ContentBlock } from "../playback/ContentBlock";
import { MediaObject } from "../playback/MediaObject";
import { GraphicsLayerLocation } from "../playback/MediaLocations";
const recursive = require("recursive-readdir");
const path = require('path');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

export class GraphicPackageLoader {
    //All graphics packages and layers. The first layer of the tree is packages, the second is layers.
    readonly graphicsTree: Tree<GraphicPackage, GraphicLayer> = new Tree(new Tree.BranchNode('Graphics packages'));

    constructor(
        private graphicsFolder: string, //The root folder to scan for graphics packages
        private expressApp: Express.Application,
        private readonly browserClientPath: string,
        private readonly rAppVersion: number
    ) {}

    /**
     * Scan the graphics folder for packages and load 'em up.
     */
    public importPackages() : Promise<GraphicPackage[]> {
        this.graphicsTree.rootNode.clearChildren(); //Clear the tree

        //Only search for graphic packages (files called "graphicpackage.json")
        const graphicPackagesOnly = (file:string, stats:Stats) => !stats.isDirectory() && path.basename(file) != 'graphicspackage.json';

        return new Promise((resolve, reject) => {
            recursive(this.graphicsFolder, [graphicPackagesOnly], (err:Error, files:string[]) => {
                if (!err) {
                    let readyPackages : GraphicPackage[] = [];
                    let readyLayers : GraphicLayer[] = [];

                    //files is a list of "graphicpackage.json" file paths
                    files.forEach((filePath) => {
                        let fileContents = fs.readFileSync(filePath).toString();

                        let graphicPackage = GraphicPackage.createFromJSON(fileContents, path.dirname(filePath));

                        if (graphicPackage == null) {
                            console.warn('Could not import graphics package at ' + filePath)
                            return;
                        }
        
                        readyPackages.push(graphicPackage);
                        
                        //Import the HTML of the package's layers and inject the rerun connection script into them
                        for (let layer of graphicPackage.layers) {
                            let serverVars = {
                                'rAppVersion': this.rAppVersion,
                                'rLayerName': layer.name
                            };
                            let modifiedHTML = this.importGraphicHTML(path.join(path.dirname(filePath), layer.path), serverVars);
                            layer.html = modifiedHTML;
                            readyLayers.push(layer);
                        }

                    });

                    this.deployLayerRoutes(readyLayers); //Create the URLs for each layer

                    //Build the graphics tree
                    this.graphicsTree.rootNode.setChildProvider(() => readyPackages.map((pkg) => 
                        new Tree.BranchNode(pkg.packageName, pkg, () => pkg.layers.map(
                            (layer) => new Tree.LeafNode(layer.name, layer)))
                    ));

                    resolve(readyPackages);
                } else {
                    reject(err);
                }
            });
        });
    }

    private readonly rerunBrowserScript = fs.readFileSync(this.browserClientPath).toString();
    //Read in a graphic layer HTML file, inject the rerun script and return the resulting html document as a string
    private importGraphicHTML(pathToHTMLFile:string, vars: {[variableKey: string] : any}) : string {
        //Read in the HTML from the target file
        let rawHTML = fs.readFileSync(pathToHTMLFile);

        //Load it into a virtual DOM so that we can modify it
        let graphicDom = new JSDOM(rawHTML);
        //Inject some JS into the DOM that creates the window.rerun link for the graphic can access
        let functionString = this.rerunBrowserScript;

        //Replace any server-side variables with their string value
        for (let varKey of Object.keys(vars)) {
            let r = new RegExp(`"@rerunprop.${varKey}"`, 'g'); //Variables are specified in the client script as strings like "@rerunprop.mVarName"
            functionString = functionString.replace(r, JSON.stringify(vars[varKey]));
        }

        let initRerunScriptTag = graphicDom.window.document.createElement("script");
        initRerunScriptTag.innerHTML = functionString;
        
        //Add this script tag to <head> as the first child
        let headTag = graphicDom.window.document.getElementsByTagName('head')[0];
        headTag.insertBefore(initRerunScriptTag, headTag.firstChild);

        return graphicDom.serialize();
    }

    private activeLayerRoutes: string[] = [];

    private deployLayerRoutes(layers: GraphicLayer[]) {
        //Tear down any existing layer routes
        this.activeLayerRoutes.map((route) => removeRoute(route, this.expressApp));
        this.activeLayerRoutes = [];

        //Create express routes for each layer
        for (let layer of layers) {
            /*
            Two routes are created for each layer - one full URL to the layer's folder, and one shortened URL for convenience.
            eg. The layer "Small explosion" of package "Action effects" is located at "/graphics/Action effects pack/Small explosion/small_explosion.html".
            Full URL is "/graphics/Action%20effects%20pack/Small%20explosion" -
                Note that it doesn't link to the actual HTML file. The response will use the modified HTML instead.
            Short URL is "/g/actioneffectspack/smallexplosion" -
                This request will be redirected to the full url.
            */

            const fullLayerURL = this.getLongLayerURL(layer);
            this.expressApp.get(fullLayerURL, (req: Request, res: Response) => {
                res.send(layer.html);
            });

            const shortLayerURL = getShortLayerURL(layer);
            this.expressApp.get(shortLayerURL, (req : Request, res : Response) => {
                res.redirect(fullLayerURL);                    
            });

            this.activeLayerRoutes.push(fullLayerURL);
            this.activeLayerRoutes.push(shortLayerURL);
            console.info('Served graphic layer "' + layer.name + '" at ' + shortLayerURL);
        }
    }

    getAvailablePackages() : GraphicPackage[] {
        return this.graphicsTree.rootNode.getChildren().map((packageNode) => packageNode.value as GraphicPackage);
    }

    public getLongLayerURL = (layer: GraphicLayer | GraphicLayerReference) => {
        let gLayer;
        if (GraphicLayerReference.isInstance(layer)) {
            gLayer = this.getLayerFromReference(layer);
        } else {
            gLayer = layer;
        }

        return `/${encodeURIComponent(gLayer.parentPackage.rootFolderPath).replace('%5C', '/')}/${encodeURIComponent(path.dirname(gLayer.path))}/`;
    }

    /**
     * Get the GraphicLayer object referred to by a GraphicLayerReference.
     * 
     * @returns The referenced layer or null if none are found that match the reference.
     */
    public getLayerFromReference(layerRef: GraphicLayerReference) : GraphicLayer {
        let layer = this.graphicsTree.getNodeAtPath([ layerRef.packageName, layerRef.layerName ]).value;
        if (layer != null) {
            return <GraphicLayer> layer;
        } else {
            return null;
        }
    }

    /**
     * Create a new ContentBlock that plays the given graphic.
     * @param graphic Graphic to play in the ContentBlock
     * @param durationMs (Optional) Duration of the MediaObject used in the ContentBlock. Defaults to infinite.
     */
    public createContentBlockWith(graphic: GraphicLayer | GraphicLayerReference, durationMs: number = -1) : ContentBlock {
        let l;
        if (GraphicLayerReference.isInstance(graphic)) {
            l = this.getLayerFromReference(graphic);
        } else {
            l = graphic;
        }

        let mediaObj = new MediaObject(MediaObject.MediaType.RerunGraphic, l.name, new GraphicsLayerLocation(l.asReference), durationMs);
        let block = new ContentBlock(mediaObj);

        if (l.animationTimings.in) {
            block.transitionInMs = l.animationTimings.in;
        }

        if (l.animationTimings.out) {
            block.transitionOutMs = l.animationTimings.out;
        }

        return block;
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

export function getShortLayerURL(layer: GraphicLayer | GraphicLayerReference) {
    if (GraphicLayerReference.isInstance(layer)) {
        return `/g/${encodeURIComponent(layer.packageName.toLowerCase().replace(/\s/g, ''))}/${encodeURIComponent(layer.layerName.toLowerCase().replace(/\s/g, ''))}`;
    } else {
        return `/g/${encodeURIComponent(layer.parentPackage.packageName.toLowerCase().replace(/\s/g, ''))}/${encodeURIComponent(layer.name.toLowerCase().replace(/\s/g, ''))}`;
    }
}

class GraphicPackage {
    packageName: string;
    rootFolderPath: string;
    layers: GraphicLayer[];

    static createFromJSON(json:string, rootFolderPath: string) : GraphicPackage {
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
                const gLayer = GraphicLayer.fromObject(layerObj, pkg);
                if (gLayer != null) {
                    pkg.layers.push(gLayer);
                }
            }
        } catch (ex) {
            console.error('Error while importing layers from graphic package "' + pkg.packageName + '":', ex);
            return null;
        }

        pkg.rootFolderPath = rootFolderPath;
        return pkg;
    
    }
}

export class GraphicLayer {
    path: string; //The path to the raw HTML file
    name: string; //Friendly name of the layer
    animationTimings: {[eventName: string] : number}; //Map of [graphic event : animation duration]
    dynamicDuration: boolean; //True if the graphic decides how long it will stay on screen for
    html: string; //Processed html string

    readonly asReference : GraphicLayerReference;
    constructor(path:string, name:string, readonly parentPackage: GraphicPackage) {
        this.path = path;
        this.name = name;
        this.animationTimings = {};
        this.asReference = new GraphicLayerReference(parentPackage.packageName, name);
    }

    static fromObject(object:any, parent: GraphicPackage) : GraphicLayer {
        if (!object.name || !object.path) {
            return null;
        }
        let layer = new GraphicLayer(object.path, object.name, parent);

        //Animation timings are optional
        if (object.timings) {
            for (let eventName in object.timings) {
                layer.animationTimings[eventName] = object.timings[eventName];
            }
        }

        if (object.dynamicDuration) {
            layer.dynamicDuration = object.dynamicDuration;
        } else {
            layer.dynamicDuration = false;
        }

        return layer;
    }

    toJSON() : any {
        return {
            name: this.name, path: this.path, animationTimings: this.animationTimings, dynamicDuration: this.dynamicDuration
        }
    }
}

export class GraphicLayerReference {
    constructor(readonly packageName: string, readonly layerName: string) {};

    static fromString(layerPath: string) {
        let path = layerPath.split('/').filter((str) => str !== '');
        return new GraphicLayerReference(path[0], path[1]);
    }

    toString() : string {
        return this.packageName + '/' + this.layerName;
    }

    isEqual(other: GraphicLayerReference) {
        return other.packageName === this.packageName && other.layerName === this.layerName;
    }

    static isInstance(obj: any) : obj is GraphicLayerReference {
        return obj.packageName && obj.layerName;
    }
}