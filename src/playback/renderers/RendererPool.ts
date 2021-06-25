import { ContentRenderer } from "./ContentRenderer";
import { MediaObject } from "../MediaObject";
import PrefixedLogger from "../../helpers/PrefixedLogger";
import { PlaybackOffset } from "../Player";
import { type } from "os";

type RendererFactory = (id: number) => ContentRenderer;
/**
 * A dynamically-allocated pool of ContentRenderers.
 */
export default class RendererPool {
    private l = new PrefixedLogger("RendererPool");
    private rendererIdCounter = 0;
    private availableRenderers: Map<MediaObject.ContentType, ContentRenderer[]> = new Map();
    private leasedRenderers: Map<number, { renderer: ContentRenderer, proxy: ContentRenderer, revoke: () => void }> = new Map();

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

    getRenderer(forContentType: MediaObject.ContentType) : LeasedContentRenderer {
        let capableRenderers = this.availableRenderers.get(forContentType);
        if (capableRenderers == null) {
            capableRenderers = [];
            this.availableRenderers.set(forContentType, capableRenderers);
        }

        let selectedRenderer: ContentRenderer;
        if (capableRenderers.length == 0) {
            //No renderers are pooled for this content type. Create one
            selectedRenderer = this.createNewRenderer(forContentType);
            this.logStateChanges(selectedRenderer);
        } else {
            selectedRenderer = capableRenderers.pop();
        }

        let proxyHandler: ProxyHandler<ContentRenderer> = {
            get: (target, property, receiver) => {
                if (property === 'release') {
                    return () => this.returnRenderer(selectedRenderer.id);
                } else {
                    let value = Reflect.get(target, property, receiver);
                    if (typeof value === 'function') {
                        return value.bind(target);
                    } else {
                        return value;
                    }
                }
            }
        }

        let leaseProxy = Proxy.revocable<ContentRenderer>(selectedRenderer, proxyHandler);
        this.leasedRenderers.set(selectedRenderer.id, { renderer: selectedRenderer, proxy: leaseProxy.proxy, revoke: leaseProxy.revoke });

        return leaseProxy.proxy as LeasedContentRenderer;
    }

    returnRenderer(rendererId: number) {
        if (this.leasedRenderers.has(rendererId)) {
            let lease = this.leasedRenderers.get(rendererId);
            //Revoke outside access to the renderer through LeasedContentRenderer
            lease.revoke();
            //Disable the renderer
            lease.renderer.cancelAllListeners();
            lease.renderer.stopAndUnload();
            lease.renderer.getOBSSource().setEnabled(false);
            //Return it to the available list
            this.leasedRenderers.delete(rendererId);
            if (this.availableRenderers.get(lease.renderer.supportedContentType) == null) this.availableRenderers.set(lease.renderer.supportedContentType, []);
            this.availableRenderers.get(lease.renderer.supportedContentType).push(lease.renderer);

            this.logStateChanges(lease.renderer);
        } else {
            this.l.warn(`Tried to return ContentRenderer ${rendererId}, but that renderer was not acquired from this pool.`);
        }
    }

    private logStateChanges(renderer: ContentRenderer) {
        renderer.onStatusUpdated((s) => this.l.debug(`Renderer ${renderer.supportedContentType}-${renderer.id} updated status from ${s.oldStatus} -> ${s.newStatus}`));
    }
}

/**
 * A ContentRenderer that has been leased from a RendererPool.
 * 
 * Once you're finished with it, return it to the pool by calling
 * release().
 */
export interface LeasedContentRenderer extends ContentRenderer {
    /**
     * Return the renderer back to the pool.
     * 
     * After calling this method the lease becomes invalid. Subsequent accesses on this object will throw TypeError.
     */
    release() : void;
}