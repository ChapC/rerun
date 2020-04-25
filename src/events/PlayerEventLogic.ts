import { UserEvent } from './UserEvent';
import { Player } from '../playback/Player';
import { StringSelectProperty, IntegerProperty, NumberProperty } from '../persistance/ValidatedProperty';

//An event that triggers when something playback-related happens (eg. content block starts, finishes)
export class PlayerEventLogic extends UserEvent.Logic {
    //The player event this user event will be triggered by
    readonly targetPlayerEvent = new StringSelectProperty("Position", PlayerEventLogic.TargetEvent, PlayerEventLogic.TargetEvent.PlaybackStart); 
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

        if (this.targetPlayerEvent.getValue() === PlayerEventLogic.TargetEvent.PlaybackStart) {
            //Run action when playback is [eventOffset] seconds into playback
            this.listenerIds.push(this.player.on('relTime:start-' + Math.round(this.eventOffsetSecs.getValue()), (ev: any) => {
                _this.frequencyCounter++;
                if (_this.frequencyCounter >= _this.frequency.getValue()) {
                    _this.triggerEvent();
                    _this.frequencyCounter = 0;
                }
            }));
        } else if (this.targetPlayerEvent.getValue() === PlayerEventLogic.TargetEvent.PlaybackEnd) {
            //Run action when playback is [eventOffset] seconds before end of playback
            this.listenerIds.push(this.player.on('relTime:end-' + Math.round(this.eventOffsetSecs.getValue()), (ev: any) => {
                _this.frequencyCounter++;
                if (_this.frequencyCounter >= _this.frequency.getValue()) {
                    _this.triggerEvent();
                    _this.frequencyCounter = 0;
                }
            }));
        } else if (this.targetPlayerEvent.getValue() === PlayerEventLogic.TargetEvent.InBetweenPlayback) {
            //Run this action in-between content blocks

            console.warn('Inbetween block events not yet implemented');
            
            /*
            A pretty big change to the Player will be required to get this to work.

            The concept of "Inbetween pauses" kind of suck, so they should be removed entirely.
            Instead of creating pauses, a ShowGraphic event should insert a MediaObject that displays a graphic. That way an event's logic knows nothing about it's action.
            As for how to get graphics to appear before the current block has finished playing (for a transition overlay), I'm not 100% sure on the best solution.
            Maybe MediaObjects should be able to be queued with a "preroll" property that causes them to start X seconds before the end of the current block (?).
             
            if (this.action.type.getValue() === UserEvent.Action.Type.GraphicEvent) {
                //The action is a graphic event - since graphic animations can have 'in' durations, we want to start playing it before the player pauses
                const graphicAction = this.action as ShowGraphicAction;
                //Register a listener that will fire [animation in duration] before the end of each video
                this.listenerIds.push(this.player.on('relTime:end-' + graphicAction.animInTime / 1000, (ev: any) => {
                    if (this.pauseNow) { //If we're pausing at the end of this video...
                        //Bring the graphic in
                        graphicAction.execute();
                        //Register a listener for when the pause is finished (the next block starts)
                        this.listenerIds.push(this.player.one('relTime:start-0', (ev:any) => {
                            graphicAction.executeOut();
                        }));
                        this.pauseNow = false;
                    }
                }));
            } else {
                //This is a generic action - run it after the player has paused
                
            }*/
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
            targetPlayerEvent: this.targetPlayerEvent,
            eventOffsetSecs: this.eventOffsetSecs, frequency: this.frequency
        };
    }
}

export namespace PlayerEventLogic {
    export enum TargetEvent {
        PlaybackStart = 'Start of block', PlaybackEnd = 'End of block', InBetweenPlayback = 'Inbetween blocks'
    }
}