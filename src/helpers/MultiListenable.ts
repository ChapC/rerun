export abstract class MultiListenable {
    private listenerIdCounter = 0;
    private listenerIdEventMap : {[id: number] : string} = {}; //Maps listenerID to the event it's listening for
    private eventListeners: {[event: string] : MultiListenable.EventCallback[]} = {}; //Maps eventName to a list of registered callbacks

    //Register an event listener
    on(eventName:string, callback:(ev: any) => void) : number {
        let listenerId = this.listenerIdCounter++;
        this.listenerIdEventMap[listenerId] = eventName;

        if (!(eventName in this.eventListeners)) {
            this.eventListeners[eventName] = [];
        }
        this.eventListeners[eventName].push(new MultiListenable.EventCallback(listenerId, callback));

        return listenerId;
    }

    //Register an event listener that will be fired only once
    one(eventName:string, callback:(ev: any) => void) : number {
        //Modify the callback to unregister the event
        const modifiedCallback = (ev: any) => {
            this.off(listenerId);
            callback(ev);
        };

        const listenerId = this.on(eventName, modifiedCallback);

        return listenerId;
    }

    //Unregister an event listener
    off(listenerId: number) {
        //Find the event that this listener is subscribed to
        let eventName = this.listenerIdEventMap[listenerId];
        if (eventName == null) {
            return; //This listener has probably already been cancelled
        }
        const eventListenerList = this.eventListeners[eventName];
        if (eventListenerList == null) {
            return; //No listeners have been registered for this event
        }
        //Remove the callback from eventListeners
        for (let i = 0; i < eventListenerList.length; i++) {
            let event = eventListenerList[i];
            if (event.id === listenerId) {
                eventListenerList.splice(i, 1);
                break;
            }
        }

        delete this.listenerIdEventMap[listenerId];
    }

    protected fireEvent(eventName:string, eventData:any) {
        let callbackList = this.eventListeners[eventName];
        if (callbackList != null) {
            for (let i = 0; i < callbackList.length; i++) {
                let callback: (ev: object) => void = callbackList[i].callback;
                callback(eventData);
            }
        }
    }
}

export namespace MultiListenable {
    export class EventCallback {constructor(public id:number, public callback:((ev: object) => void)){}};
}