import { UserEvent } from './UserEvent';

export class ShowGraphicAction extends UserEvent.Action {
    type = UserEvent.Action.Type.GraphicEvent;

    execute() {
        this.sendGraphicEvent(this.eventIn);
    }

    executeInThenOut(outDelay: number) {
        this.sendGraphicEvent(this.eventIn);
        setTimeout(() => this.sendGraphicEvent(this.eventOut), outDelay + this.animInTime);
    }

    constructor(public sendGraphicEvent: (s: string) => void, public eventIn: string, public animInTime: number, public eventOut?: string) {
        super();
    }
}