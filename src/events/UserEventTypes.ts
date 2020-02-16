import { UserEvent } from './UserEvent';
import { ShowGraphicAction } from './UserEventActionTypes';
import {Player} from '../playback/Player';

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
                frequency: number, action: UserEvent.Action, eventOffsetMs:number) 
    {
        super(name);
        this.targetPlayerEvent = targetPlayerEvent;
        this.player = player;
        this.eventOffsetMs = eventOffsetMs;
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
                this.listenerIds.push(this.player.on('paused', (ev: any) => {
                    this.action.execute();
                }));
            }
        }
    }

    disable() {
        for (let listenerId of this.listenerIds) {
            this.player.off(listenerId);
        }
        this.listenerIds = [];
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