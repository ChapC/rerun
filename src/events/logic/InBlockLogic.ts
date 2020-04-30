import { UserEvent } from './../UserEvent';
import { Player } from '../../playback/Player';
import { StringSelectProperty, IntegerProperty, NumberProperty } from '../../persistance/ValidatedProperty';

//An event that triggers at a certain point during a block playback (eg. 5 seconds after start, 30 seconds before end)
export class InBlockLogic extends UserEvent.Logic {
    //The player event this user event will be triggered by
    readonly fromPosition = new StringSelectProperty("Position", InBlockLogic.FromPoint, InBlockLogic.FromPoint.PlaybackStart); 
    //Used to offset from the start or end (eg. 5 seconds after start or 3 seconds before end)
    readonly eventOffsetSecs = new NumberProperty("Event offset", 0);
    readonly frequency = new IntegerProperty("Frequency", 1); //Trigger this event every n times targetEvent is fired

    private frequencyCounter = 0;
    //Player listener Ids stored to cancel them when disable() is called
    private listenerIds: number[] = [];

    private triggerEvent : () => void;
    constructor(private player: Player) {
        super("Player");
    }

    enable() {
        const _this = this;

        if (this.fromPosition.getValue() === InBlockLogic.FromPoint.PlaybackStart) {
            //Run action when playback is [eventOffset] seconds into playback
            this.listenerIds.push(this.player.on('relTime:start-' + Math.round(this.eventOffsetSecs.getValue()), (ev: any) => {
                _this.frequencyCounter++;
                if (_this.frequencyCounter >= _this.frequency.getValue()) {
                    _this.triggerEvent();
                    _this.frequencyCounter = 0;
                }
            }));
        } else if (this.fromPosition.getValue() === InBlockLogic.FromPoint.PlaybackStart) {
            //Run action when playback is [eventOffset] seconds before end of playback
            this.listenerIds.push(this.player.on('relTime:end-' + Math.round(this.eventOffsetSecs.getValue()), (ev: any) => {
                _this.frequencyCounter++;
                if (_this.frequencyCounter >= _this.frequency.getValue()) {
                    _this.triggerEvent();
                    _this.frequencyCounter = 0;
                }
            }));
        }
    }

    disable() {
        for (let listenerId of this.listenerIds) {
            this.player.off(listenerId);
        }
        this.listenerIds = [];
    }

    setTriggerCallback(callback: () => void) {
        this.triggerEvent = callback;
    }

    toJSON() : any {
        return {
            ...super.toJSON(),
            fromPosition: this.fromPosition,
            eventOffsetSecs: this.eventOffsetSecs, frequency: this.frequency
        };
    }
}

export namespace InBlockLogic {
    export enum FromPoint {
        PlaybackStart = 'Start of block', PlaybackEnd = 'End of block'
    }
}