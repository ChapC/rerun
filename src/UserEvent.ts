//A user-defined event
export abstract class UserEvent {
    abstract type : UserEvent.Type;
    abstract action : UserEvent.Action;

    constructor(public name: string) {}

    //Called when the user switches the event on or off
    abstract enable() : void;
    abstract disable() : void;
}

export namespace UserEvent {
    export enum Type { 
        Player = 'player' //An event that triggers when something player-related happens (eg. content block starts, finishes, deleted)
    };

    export abstract class Action {
        abstract type: Action.Type;
        abstract execute() : void;
    }

    export namespace Action {
        export enum Type {
            GraphicEvent = 'GraphicEvent', GenericCallback = 'GenericCallback'
        }
    }
}