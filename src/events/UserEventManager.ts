import { UserEvent } from './UserEvent';
import { IJSONSavable } from '../persistance/JSONSavable';
import { PlayerEventLogic } from './PlayerEventLogic';
import SubTypeStore from '../helpers/SubTypeStore';
import { RerunStateObject } from '..';
import { SingleListenable } from '../helpers/SingleListenable';
import { isArray } from 'util';
import ControlPanelHandler, { ControlPanelListener, ControlPanelRequest } from '../ControlPanelHandler';
import { WSConnection } from '../helpers/WebsocketConnection';

const uuidv4 : () => string = require('uuid/v4');

/**
 * Manages active UserEvents.
 */
@ControlPanelListener
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

    //Control panel requests
    @ControlPanelRequest('getEvents')
    private getEventsRequest() : WSConnection.WSPendingResponse {
        return new WSConnection.SuccessResponse('events', this.getEvents());
    }

    //TODO: These outline getters will need to change so that plug-ins can define their own actions/events
    @ControlPanelRequest('getEventOutline')
    private getEventOutlineRequest() : WSConnection.WSPendingResponse {
        return new WSConnection.SuccessResponse('default outline', this.getNewEvent().getOutline());
    }

    @ControlPanelRequest('getEventLogicOutline', WSConnection.AcceptAny)
    private getEventLogicOutlineRequest(data: any) : WSConnection.WSPendingResponse {
        if (data && data.eventType) {
            let logic = this.rerunState.userEventManager.eventLogicTypes.getInstanceOf(data.eventType);
            if (logic != null) {
                return new WSConnection.SuccessResponse('logicoutline', logic.getOutline());
            } else {
                return new WSConnection.ErrorResponse('UnknownLogicType', `Unknown event logic type '${data.eventType}`);
            }
        } else {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No logic event type provided');
        }
    }

    @ControlPanelRequest('getEventActionOutline', WSConnection.AcceptAny)
    private getEventActionOutlineRequest(data: any) : WSConnection.WSPendingResponse {
        if (data && data.actionType) {
            let action = this.rerunState.userEventManager.eventActionTypes.getInstanceOf(data.actionType);
            if (action != null) {
                return new WSConnection.SuccessResponse('actionoutline', action.getOutline());
            } else {
                return new WSConnection.ErrorResponse('UnknownActionType', `Unknown event action type '${data.actionType}`);
            }
        } else {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No action event type provided');
        }
    }

    @ControlPanelRequest('createEvent', WSConnection.AcceptAny)
    private createEventRequest(data: any) : WSConnection.WSPendingResponse {
        let newEvent = this.rerunState.userEventManager.getNewEvent();

        if (newEvent.deserialize(data)) {
            let eventId = this.rerunState.userEventManager.addEvent(newEvent);
            if (eventId) {
                return new WSConnection.SuccessResponse('Created new event with ID ' + eventId);
            } else {
                return new WSConnection.ErrorResponse('CreateFailed', 'Error while creating event');
            }
        } else {
            return new WSConnection.ErrorResponse('InvalidEvent', 'Failed to parse event');
        }
    }

    @ControlPanelRequest('updateEvent', WSConnection.AcceptAny)
    private updateEventRequest(data: any) : WSConnection.WSPendingResponse {
        if (data.eventId == null || data.newEvent == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'Event ID and new event data not provided');
        }

        let updatedEvent = this.rerunState.userEventManager.getNewEvent();

        if (updatedEvent.deserialize(data.newEvent)) {
            this.rerunState.userEventManager.updateEvent(data.eventId, updatedEvent);
            return new WSConnection.SuccessResponse('Updated event with ID ' + data.eventId);
        } else {
            return new WSConnection.ErrorResponse('InvalidEvent', 'Failed to parse event');
        }
    }

    @ControlPanelRequest('deleteEvent', WSConnection.AcceptAny)
    private deleteEventRequest(data: any) : WSConnection.WSPendingResponse {
        if (data.eventId == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No event id provided');
        }

        this.rerunState.userEventManager.removeEvent(data.eventId);

        return new WSConnection.SuccessResponse('Removed event with ID ' + data.eventId);
    }

    @ControlPanelRequest('setEventEnabled', WSConnection.AcceptAny)
    private setEventEnabledRequest(data: any) : WSConnection.WSPendingResponse {
        if (data.eventId == null || data.enabled == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No event id provided');
        }

        this.rerunState.userEventManager.setEventEnabled(data.eventId, data.enabled);
        return new WSConnection.SuccessResponse(`${data.enabled ? 'Enabled' : 'Disabled'} event ID ${data.eventId}`);
    }
 }

class ToggleableUserEvent {
    enabled: boolean = true;
    constructor(public id: string, public event: UserEvent) {}
}