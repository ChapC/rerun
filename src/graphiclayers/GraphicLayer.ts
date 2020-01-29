export class GraphicLayer {
    path: string; //The path to the raw HTML file
    name: string; //Friendly name of the layer
    animationTimings: {[eventName: string] : Number}; //Map of [graphic event : animation time]
    html: string; //Processed html string

    constructor(path:string, name:string) {
        this.path = path;
        this.name = name;
        this.animationTimings = {};
    }
}