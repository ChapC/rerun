import { ContentRenderer } from "./ContentRenderer";
import { MediaObject } from "../MediaObject";
import PrefixedLogger from "../../helpers/PrefixedLogger";

/*
    A pool of offscreen ContentRenderers. 
*/
type RendererFactory = (id: number) => ContentRenderer;
export default class RendererPool {
    private l = new PrefixedLogger("RendererPool");
    private rendererIdCounter = 0;
    private availableRenderers: Map<MediaObject.ContentType, ContentRenderer[]> = new Map();
    private leasedRenderers: Map<number, ContentRenderer> = new Map();

    private rendererFactories: Map<MediaObject.ContentType, RendererFactory> = new Map();

    addRendererFactory(forContentType: MediaObject.ContentType, factory: RendererFactory) {
        this.rendererFactories.set(forContentType, factory);
    }

    private createNewRenderer(forContentType: MediaObject.ContentType) : ContentRenderer {
        this.l.info(`Creating new ${forContentType} renderer - pool size increased to ${this.availableRenderers.size + this.leasedRenderers.size}`);
        if (this.rendererFactories.has(forContentType)) {
            return this.rendererFactories.get(forContentType)(this.rendererIdCounter++);
        } else {
            throw new Error(`Unsupported content type '${forContentType}'`);
        }
    }

    getRenderer(forContentType: MediaObject.ContentType) : PooledContentRenderer {
        let capableRenderers = this.availableRenderers.get(forContentType);
        if (capableRenderers == null) {
            capableRenderers = [];
            this.availableRenderers.set(forContentType, capableRenderers);
        }

        let selectedRenderer: ContentRenderer;
        if (capableRenderers.length == 0) {
            //No renderers are pooled for this content type. Create one
            selectedRenderer = this.createNewRenderer(forContentType);
        } else {
            selectedRenderer = capableRenderers.pop();
        }

        this.leasedRenderers.set(selectedRenderer.id, selectedRenderer);
        return new PooledContentRenderer(selectedRenderer, this);
    }

    returnRenderer(pooledLease: PooledContentRenderer) {
        if (this.leasedRenderers.has(pooledLease.id)) {
            let renderer = this.leasedRenderers.get(pooledLease.id);
            //Disable the renderer
            renderer.stop();
            renderer.getOBSSource().setEnabled(false);
            //Return it to the available list
            this.leasedRenderers.delete(pooledLease.id);
            if (this.availableRenderers.get(renderer.supportedContentType) == null) this.availableRenderers.set(renderer.supportedContentType, []);
            this.availableRenderers.get(renderer.supportedContentType).push(renderer);
        } else {
            this.l.warn(`Tried to return ContentRenderer ${pooledLease.id}, but that renderer was not acquired from this pool.`);
        }
    }
}

export class PooledContentRenderer implements ContentRenderer {
    readonly id: number;
    readonly supportedContentType: MediaObject.ContentType;
    constructor(private renderer: ContentRenderer, private parentPool: RendererPool) {
        this.id = renderer.id;
        this.supportedContentType = renderer.supportedContentType;
    }
    
    //Return the renderer back to the pool
    release() {
        this.renderer = null; //Prevent further changes to this renderer
        this.parentPool.returnRenderer(this);
    }

    loadMedia(media: MediaObject): Promise<void> { return this.renderer.loadMedia(media); }
    getLoadedMedia(): MediaObject { return this.renderer.getLoadedMedia(); }
    play(): Promise<void> { return this.renderer.play(); }
    stop(): Promise<void> { return this.renderer.stop(); }
    restartMedia(): Promise<void> { return this.renderer.restartMedia(); }
    getOBSSource() { return this.renderer.getOBSSource(); }
}