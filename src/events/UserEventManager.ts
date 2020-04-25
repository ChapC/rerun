import { UserEvent } from './UserEvent';
import { IJSONSavable } from '../persistance/JSONSavable';
import { PlayerEventLogic } from './PlayerEventLogic';
import SubTypeStore from '../helpers/SubTypeStore';
import { RerunStateObject } from '..';
import { SingleListenable } from '../helpers/SingleListenable';
import { isArray } from 'util';

const uuidv4 : () => string = require('uuid/v4');

/**
 * Manages active UserEvents.
 */
export class UserEventManager extends SingleListenable<ToggleableUserEvent[]> implements IJSONSavable {
    private events : {[id: string] : ToggleableUserEvent} = {};

    readonly eventLogicTypes = new SubTypeStore<UserEvent.Logic>(this.rerunState);
    readonly eventActionTypes = new SubTypeStore<UserEvent.Action>(this.rerunState);

    constructor(public savePath: string, private rerunState: RerunStateObject) {
        super();
    }

    getNewEvent() : UserEvent {
        return new UserEvent(this.eventLogicTypes, this.eventActionTypes);
    }

    addEvent(newEvent: UserEvent) : string {
        const eventId : string = uuidv4();
        let tEvent = new ToggleableUserEvent(eventId, newEvent);
        this.events[eventId] = tEvent;
        newEvent.logic.getValue().enable();

        this.triggerListeners(this.getEvents());
        return eventId;
    }

    removeEvent(eventId: string) {
        let tEvent = this.events[eventId];
        if (tEvent == null) {
            return;
        }
        tEvent.event.logic.getValue().disable();
        delete this.events[eventId];

        this.triggerListeners(this.getEvents());
    }

    updateEvent(eventId: string, newEvent: UserEvent) {
        let targetEvent: ToggleableUserEvent = this.events[eventId];
        
        if (targetEvent != null) {
            targetEvent.event.logic.getValue().disable();
            targetEvent.event = newEvent;
            targetEvent.event.logic.getValue().enable();
        }

        this.triggerListeners(this.getEvents());
    }

    getEvents() : ToggleableUserEvent[] {
        let allEvents = [];
        for (let id in this.events) {
            allEvents.push(this.events[id]);
        }
        return allEvents;
    }

    setEventEnabled(eventId: string, enabled: boolean) {
        let tEvent = this.events[eventId];
        if (tEvent == null) {
            return;
        }

        if (tEvent.enabled != enabled) {
            if (tEvent.enabled) {
                tEvent.event.logic.getValue().disable();
            } else {
                tEvent.event.logic.getValue().enable();
            }
            tEvent.enabled = enabled;
        }

        this.triggerListeners(this.getEvents());
    }

    deserialize(object: any, triggerChangeEvent = true) : any {
        if (object.events) {
            //object.events should be an object in the same form as this.events

            for (let eventId in object.events) {
                let serializedToggleEvent = object.events[eventId];
                if (serializedToggleEvent.enabled != null && serializedToggleEvent.id && serializedToggleEvent.event) {
                    //Attempt to deserialize the UserEvent within the toggle
                    let userEvent = new UserEvent(this.eventLogicTypes, this.eventActionTypes);
                    if (userEvent.deserialize(serializedToggleEvent.event)) {
                        //Wrap the userEvent in a new toggle
                        let toggleEvent = new ToggleableUserEvent(serializedToggleEvent.id, userEvent);
                        toggleEvent.enabled = serializedToggleEvent.enabled;
                        //Manually add the event
                        this.events[toggleEvent.id] = toggleEvent;
                        if (toggleEvent.enabled) {
                            toggleEvent.event.logic.getValue().enable();
                        }
                    } else {
                        return false; //The event is invalid, stop looking through the rest of the file
                    }
                }
            }

            return true;
            
        } else {
            return false;
        }
    }

    toJSON() : any {
        return { events: this.events };
    }
}

class ToggleableUserEvent {
    enabled: boolean = true;
    constructor(public id: string, public event: UserEvent) {}
}