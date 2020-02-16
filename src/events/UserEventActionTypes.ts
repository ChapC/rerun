import { UserEvent } from './UserEvent';

export class ShowGraphicAction extends UserEvent.Action {
    type = UserEvent.Action.Type.GraphicEvent;

    execute() {
        this.sendGraphicEvent('in', this.targetLayer);
    }

    executeOut() {
        this.sendGraphicEvent('out', this.targetLayer);
    }

    constructor(public targetLayer: string, public sendGraphicEvent: (event: string, layer: string) => void, public animInTime?: number) {
        super();
        if (!animInTime) {
            this.animInTime = 0;
        }
    }
}