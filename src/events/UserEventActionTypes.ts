import { UserEvent } from './UserEvent';

export class ShowGraphicAction extends UserEvent.Action {
    type = UserEvent.Action.Type.GraphicEvent;

    execute() {
        this.sendGraphicEvent('in', this.targetLayer);
    }

    executeInThenOut(outDelay: number) {
        this.sendGraphicEvent('in', this.targetLayer);
        setTimeout(() => this.sendGraphicEvent('out', this.targetLayer), outDelay + this.animInTime);
    }

    constructor(public targetLayer: string, public sendGraphicEvent: (event: string, layer: string) => void, public animInTime?: number) {
        super();
        if (!animInTime) {
            this.animInTime = 0;
        }
    }
}