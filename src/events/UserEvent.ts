import SavablePropertyGroup from '../persistance/SavablePropertyGroup';
import { StringSelectProperty, StringProperty, SubGroupProperty } from '../persistance/ValidatedProperty';
import SubTypeStore from '../helpers/SubTypeStore';

//A user-defined event
export class UserEvent extends SavablePropertyGroup {
    readonly name = new StringProperty("Name", "New event");

    readonly logicType = new StringSelectProperty("Event type");
    readonly logic = new SubGroupProperty<UserEvent.Logic>("Logic", this.logicType, this.logicTypes);
 
    readonly actionType = new StringSelectProperty("Action");
    readonly action = new SubGroupProperty<UserEvent.Action>("Action", this.actionType, this.actionTypes);

    constructor(private logicTypes: SubTypeStore<UserEvent.Logic>, private actionTypes: SubTypeStore<UserEvent.Action>) {
        super(null); //UserEvents are not saved individually. UserEventManager defines the save path
        this.logicType.setOptions(logicTypes.allKnownTypes());
        this.actionType.setOptions(actionTypes.allKnownTypes());

        //Configure logic to execute action when triggered - note that the logic and action for an event can be added in any order
        this.logic.addChangeListener((newLogic) => {
            if (this.action.hasValue()) {
                newLogic.setTriggerCallback(() => this.action.getValue().execute());
            }
        });
        this.action.addChangeListener((newAction) => {
            if (this.logic.hasValue()) {
                this.logic.getValue().setTriggerCallback(() => newAction.execute());
            }
        });
    }
}

export namespace UserEvent {
    //The actual logic of the UserEvent
    export abstract class Logic extends SavablePropertyGroup {
        //Called when the user switches the event on or off
        abstract enable() : void;
        abstract disable() : void;

        constructor(readonly logicType: string) {
            super(null);
        }

        abstract setTriggerCallback(onTrigger: () => void) : void;
    }

    export abstract class Action extends SavablePropertyGroup {
        abstract execute() : void;

        constructor(readonly actionType: string) {
            super(null);
        }
    }
}