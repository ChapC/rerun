import { UserEvent } from '../UserEvent';
import { TreePathProperty, NumberProperty } from '../../persistance/ValidatedProperty';
import { GraphicManager, GraphicLayer } from '../../graphiclayers/GraphicManager';

export class ShowGraphicAction extends UserEvent.Action {
    readonly targetLayerName = new TreePathProperty("Target layer", this.graphicsManager.graphicsTree);
    readonly onScreenDurationSecs = new NumberProperty('Duration', 1);
    private targetLayer : GraphicLayer = null;
    constructor(private graphicsManager: GraphicManager) {
        super("Show a graphic");
        
        const _this = this;
        //Whenever targetLayerName changes, update our targetLayer reference
        this.targetLayerName.addChangeListener((newLayerPath) => {
            _this.targetLayer = _this.graphicsManager.graphicsTree.getNodeAtPath(newLayerPath.split('/').filter((str: string) => str != "")).value as GraphicLayer;
        });
    }

    getTargetLayer() {
        return this.targetLayer;
    }

    execute() {
        if (this.targetLayer != null) {
            this.graphicsManager.sendGraphicEvent('in', this.targetLayer.asReference);
        } else {
            console.warn('[ShowGraphicAction] - The target layer is not assigned');
        }
    }

    executeOut() {
        if (this.targetLayer != null) {
            this.graphicsManager.sendGraphicEvent('out', this.targetLayer.asReference);
        }
    }
}