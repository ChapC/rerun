export abstract class MultiListenable {
    private listenerIdCounter = 0;
    private listenerIdEventMap : {[id: number] : string} = {}; //Maps listenerID to the event it's listening for
    private eventListeners: {[event: string] : MultiListenable.EventCallback[]} = {}; //Maps eventName to a list of registered callbacks

    /**
     * Register a listener for an event on this object.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    on(eventName:string, callback:(ev: any) => void) : number {
        let listenerId = this.listenerIdCounter++;
        this.listenerIdEventMap[listenerId] = eventName;

        if (!(eventName in this.eventListeners)) {
            this.eventListeners[eventName] = [];
        }
        this.eventListeners[eventName].push(new MultiListenable.EventCallback(listenerId, callback));

        return listenerId;
    }

    /**
     * Register a listener for an event on this object that will only be triggered once.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    one(eventName:string, callback:(ev: any) => void) : number {
        //Modify the callback to unregister the event
        const modifiedCallback = (ev: any) => {
            this.off(listenerId);
            callback(ev);
        };

        const listenerId = this.on(eventName, modifiedCallback);

        return listenerId;
    }

    /**
     * Unregister a listener on this object. The listener will no longer receive events.
     * @param listenerId The ID of the listener to deactivate
     */
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

    cancelAllListeners() {
        this.eventListeners = {};
    }

    isListenerFor(eventName: string) : boolean {
        return this.eventListeners[eventName] != null;
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