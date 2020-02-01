import {UserEvent} from './UserEvent';

//Manages the active UserEvents
export class UserEventManager {
    private events : {[id: number] : ToggleableUserEvent} = {};

    private eventIdCounter = 0;
    addEvent(newEvent: UserEvent) : number {
        const eventId = this.eventIdCounter++;
        let tEvent = new ToggleableUserEvent(eventId, newEvent);
        this.events[eventId] = tEvent;
        newEvent.enable();
        return eventId;
    }

    removeEvent(eventId: number) {
        let tEvent = this.events[eventId];
        if (tEvent == null) {
            return;
        }
        tEvent.event.disable();
        delete this.events[eventId];
    }

    updateEvent(eventId: number, newEvent: UserEvent) {
        let targetEvent: ToggleableUserEvent = this.events[eventId];
        
        if (targetEvent != null) {
            targetEvent.event.disable();
            targetEvent.event = newEvent;
            targetEvent.event.enable();
        }
    }

    getEvents() : ToggleableUserEvent[] {
        let allEvents = [];
        for (let id in this.events) {
            allEvents.push(this.events[id]);
        }
        return allEvents;
    }

    setEventEnabled(eventId: number, enabled: boolean) {
        let tEvent = this.events[eventId];
        if (tEvent == null) {
            return;
        }

        if (tEvent.enabled != enabled) {
            if (tEvent.enabled) {
                tEvent.event.disable();
            } else {
                tEvent.event.enable();
            }
            tEvent.enabled = enabled;
        }
    }
}

class ToggleableUserEvent {
    enabled: boolean = true;
    constructor(public id: number, public event: UserEvent) {}
}