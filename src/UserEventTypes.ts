import { UserEvent } from './UserEvent';
import { ShowGraphicAction } from './UserEventActionTypes';
import {Player} from './Player';

export class PlayerBasedEvent extends UserEvent {
    type = UserEvent.Type.Player;
    targetPlayerEvent : PlayerBasedEvent.TargetEvent; //The player event this user event will be triggered by
    eventOffsetMs: number; //(seconds) Used to offset from the start or end (eg. 5 seconds after start or 3 seconds before end)
    frequency = 1; //Trigger this event every n times targetEvent is fired
    action: UserEvent.Action;

    private player: Player;
    private frequencyCounter = 0;
    private pauseNow : boolean = false;
    //Player listener Ids and pause id, used to cancel them when disable() is called
    private listenerIds: number[] = []; 
    private pauseId: number;

    constructor(name: string, player: Player, targetPlayerEvent: PlayerBasedEvent.TargetEvent, 
                frequency: number, action: UserEvent.Action, eventOffsetSec:number) 
    {
        super(name);
        this.targetPlayerEvent = targetPlayerEvent;
        this.player = player;
        this.eventOffsetMs = eventOffsetSec;
        this.frequency = frequency;
        this.action = action;
    }

    enable() {
        if (this.targetPlayerEvent === PlayerBasedEvent.TargetEvent.PlaybackStart) {
            //Run action when playback is [eventOffset] seconds into playback
            this.listenerIds.push(this.player.on('relTime:start-' + this.eventOffsetMs / 1000, (ev: any) => {
                this.frequencyCounter++;
                if (this.frequencyCounter >= this.frequency) {
                    this.action.execute();
                    this.frequencyCounter = 0;
                }
            }));
        } else if (this.targetPlayerEvent === PlayerBasedEvent.TargetEvent.PlaybackEnd) {
            //Run action when playback is [eventOffset] seconds before end of playback
            this.listenerIds.push(this.player.on('relTime:end-' + this.eventOffsetMs / 1000, (ev: any) => {
                this.frequencyCounter++;
                if (this.frequencyCounter >= this.frequency) {
                    this.action.execute();
                    this.frequencyCounter = 0;
                }
            }));
        } else if (this.targetPlayerEvent === PlayerBasedEvent.TargetEvent.InBetweenPlayback) {
            //Run this action in-between content blocks

            //Request an inbetween pause [eventOffset] seconds every [frequency] videos
            this.listenerIds.push(this.player.on('relTime:start-0', (ev: any) => {
                this.frequencyCounter +=1;
                if (this.frequencyCounter >= this.frequency) {
                    this.pauseId = this.player.addInbetweenPause(new Player.Pause('Event - ' + this.name, this.eventOffsetMs));
                    this.frequencyCounter = 0;
                    this.pauseNow = true;
                } else {
                    this.pauseNow = false;
                }
            }));
            
            if (this.action.type === UserEvent.Action.Type.GraphicEvent) {
                //The action is a graphic event, so we should run the action before the current media has finished
                const graphicAction = this.action as ShowGraphicAction;
                this.listenerIds.push(this.player.on('relTime:end-' + graphicAction.animInTime / 1000, (ev: any) => {
                    if (this.pauseNow) {
                        graphicAction.executeInThenOut(this.eventOffsetMs);
                        this.pauseNow = false;
                    }
                }));
            } else {
                //Run the action when the player has paused
                this.listenerIds.push(this.player.on('paused', (ev: any) => {
                    this.action.execute();
                }));
            }
        }
    }

    disable() {
        for (let listenerId of this.listenerIds) {
            this.player.cancelListener(listenerId);
        }
        if (this.pauseId != null) {
            this.player.removeInbetweenPause(this.pauseId);
        }
    }

    toJSON() : any {
        return {
            name: this.name, type: this.type, targetPlayerEvent: this.targetPlayerEvent,
            eventOffset: this.eventOffsetMs, frequency: this.frequency, action: this.action
        };
    }
}

export namespace PlayerBasedEvent {
    export enum TargetEvent {
        PlaybackStart = 'start', PlaybackEnd = 'end', InBetweenPlayback = 'inbetween'
    }
}