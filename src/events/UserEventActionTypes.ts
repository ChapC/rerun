import { UserEvent } from './UserEvent';
import { StringSelectFormProperty } from '../persistance/FormProperty';
import { GraphicManager, GraphicLayer } from '../graphiclayers/GraphicManager';

export class ShowGraphicAction extends UserEvent.Action {
    readonly targetLayerName = new StringSelectFormProperty('Target layer');
    private targetLayer : GraphicLayer = null;
    public animInTime = 0;

    constructor(private graphicsManager: GraphicManager) {
        super("Show a graphic");

        //TargetLayerName should be a selection from the list of layers in the active graphics package
        this.targetLayerName.setOptions(this.graphicsManager.getActivePackage().layers.map((layer) => layer.name));
        
        const _this = this;
        //Whenever targetLayerName changes, update our targetLayer reference
        this.targetLayerName.addChangeListener((newLayerName) => {
            for (let layer of _this.graphicsManager.getActivePackage().layers) {
                if (layer.name === newLayerName) {
                    _this.targetLayer = layer;
                    _this.animInTime = layer.animationTimings['in'] ? layer.animationTimings['in'] : 0;
                    return;
                }
            }
            //Couldn't find a layer with this name
            _this.targetLayer = null;
            _this.animInTime = 0;
        });
    }

    execute() {
        if (this.targetLayer != null) {
            this.graphicsManager.sendGraphicEvent('in', this.targetLayer.name);
        } else {
            console.warn('[ShowGraphicAction] - The target layer is not assigned');
        }
    }

    executeOut() {
        if (this.targetLayer != null) {
            this.graphicsManager.sendGraphicEvent('out', this.targetLayer.name);
        }
    }
}