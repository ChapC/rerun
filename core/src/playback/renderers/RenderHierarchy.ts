import { ContentRenderer } from "./ContentRenderer";
/*
An ordered set of ContentRenderers, displaying one on top of one another from 0 (bottom) to maxActiveRenderers (top). Maps roughly to a Scene in OBS.
The Player adds and removes ContentRenderers from the hierarchy depending on which media should be playing on screen.
*/
export default interface RenderHierarchy {
    readonly maxActiveRenderers: number;

    insertRenderer(renderer: ContentRenderer, layer: number) : void;

    removeRenderer(renderer: ContentRenderer) : void;

    getLayerIndex(renderer: ContentRenderer) : number;
}

import { OBSScene, OBSSceneItem } from "../../../obs/RerunOBSBinding";
import PrefixedLogger from "../../helpers/PrefixedLogger";

export class OBSRenderHierarchy implements RenderHierarchy {
    private log = new PrefixedLogger('OBSRenderHierarchy');
    maxActiveRenderers = 32; //Arbitrary limit, should probably be customizable (although there also probably shouldn't ever be that many sources active at once)

    private rendererSceneItemMap: Map<number, OBSSceneItem> = new Map();
    private layers: ContentRenderer[] = [];
    //NOTE: Keeping a local copy of the layer stack here is easier than checking OBS each time, but does assume that the scene won't be modified outside of this class

    constructor(private activeScene: OBSScene) {};

    insertRenderer(renderer: ContentRenderer, layerIndex: number): void {
        let sceneItem = this.activeScene.addSource(renderer.getOBSSource());
        sceneItem.setOrderIndex(layerIndex);
        this.rendererSceneItemMap.set(renderer.id, sceneItem);
        this.layers.splice(layerIndex, 0, renderer);
        this.log.info(`Inserted renderer ${renderer.supportedContentType}-${renderer.id} at index ${layerIndex}`)
    }

    removeRenderer(renderer: ContentRenderer): void {
        let rendererSceneItem = this.rendererSceneItemMap.get(renderer.id);
        let rendererLayerIndex = this.layers.findIndex(r => r.id == renderer.id);
        if (!rendererSceneItem) return;
        this.activeScene.removeSceneItem(rendererSceneItem);
        this.rendererSceneItemMap.delete(renderer.id);
        this.layers.splice(rendererLayerIndex, 1);
        this.log.info(`Removed renderer ${renderer.supportedContentType}-${renderer.id} from index ${rendererLayerIndex}`)
    }

    getLayerIndex(renderer: ContentRenderer) : number {
        return this.layers.findIndex(r => r.id == renderer.id);
    }

}