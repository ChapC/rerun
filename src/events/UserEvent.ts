import JSONSavableForm from '../persistance/JSONSavableForm';
import { StringSelectFormProperty, StringFormProperty, SubFormProperty } from '../persistance/FormProperty';
import SubTypeStore from '../helpers/SubTypeStore';

//A user-defined event
export class UserEvent extends JSONSavableForm {
    readonly name = new StringFormProperty("Name", "New event");

    readonly logicType = new StringSelectFormProperty("Event type");
    readonly logic = new SubFormProperty("Logic", this.logicType, this.logicTypes);

    readonly actionType = new StringSelectFormProperty("Action");
    readonly action = new SubFormProperty("Action", this.actionType, this.actionTypes);

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
    export abstract class Logic extends JSONSavableForm {
        //Called when the user switches the event on or off
        abstract enable() : void;
        abstract disable() : void;

        constructor(readonly logicType: string) {
            super(null);
        }

        abstract setTriggerCallback(onTrigger: () => void) : void;
    }

    export abstract class Action extends JSONSavableForm {
        abstract execute() : void;

        constructor(readonly actionType: string) {
            super(null);
        }
    }
}