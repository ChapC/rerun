type EventCallback<TEventObj> = { id: number, callback: (e: TEventObj) => void};

export abstract class MultiListenable<TEventKey, TEventData> {
    private listenerIdCounter = 0;
    private listenerIdEventMap : Map<number, TEventKey> = new Map(); //Maps listenerID to the event it's listening for
    private eventListeners: Map<TEventKey, EventCallback<TEventData>[]> = new Map(); //Maps eventName to a list of registered callbacks

    /**
     * Register a listener for an event on this object.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    on(eventName:TEventKey, callback:(ev: TEventData) => void) : number {
        let listenerId = this.listenerIdCounter++;
        this.listenerIdEventMap.set(listenerId, eventName);

        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push({ id: listenerId, callback: callback });

        return listenerId;
    }

    /**
     * Register a listener for an event on this object that will only be triggered once.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    once(eventName:TEventKey, callback:(ev: TEventData) => void) : number {
        //Modify the callback to unregister the event
        const modifiedCallback = (ev: TEventData) => {
            this.off(listenerId);
            callback(ev);
        };

        const listenerId = this.on(eventName, modifiedCallback);

        return listenerId;
    }

    private timeoutIds: Map<number, NodeJS.Timeout> = new Map(); //Maps listenerID to timeout objects

    /**
     * Register a listener for an event on this object that will only be triggered once.
     * 
     * If the event does not occur within the specified timeout, then the listener will be cancelled
     * and an alternate callback will be fired.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @param timeoutMs The number of milliseconds the event has to fire within
     * @param onTimeout The callback to trigger if the timeout is reached
     * @returns A ID that can be used to deactivate this listener
     */
    onceWithTimeout(eventName:TEventKey, callback:(ev: TEventData) => void, timeoutMs: number, onTimeout: () => void) : number {
        //Modify the callback to cancel the timeout
        let modifiedCallback = (ev: TEventData) => {
            let t = this.timeoutIds.get(listenerId);
            if (t) {
                clearTimeout(t);
                this.timeoutIds.delete(listenerId);
            }
            callback(ev);
        }

        const listenerId = this.once(eventName, modifiedCallback);

        let timeout = setTimeout(() => {
            this.off(listenerId);
            onTimeout();
        }, timeoutMs);
        this.timeoutIds.set(listenerId, timeout);

        return listenerId;
    }

    /**
     * Unregister a listener on this object. The listener will no longer receive events.
     * @param listenerId The ID of the listener to deactivate
     */
    off(listenerId: number) {
        //Find the event that this listener is subscribed to
        let eventName = this.listenerIdEventMap.get(listenerId);
        if (eventName == null) {
            return; //This listener has probably already been cancelled
        }
        const eventListenerList = this.eventListeners.get(eventName);
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

        this.listenerIdEventMap.delete(listenerId);

        //If the listener has a timeout registered, cancel it
        if (this.timeoutIds.has(listenerId)) {
            clearTimeout(this.timeoutIds.get(listenerId));
            this.timeoutIds.delete(listenerId);
        }
    }

    /**
     * Create a ListenerGroup object for this listenable. You can use it to cancel a group of listeners all together.
     */
    createListenerGroup() : ListenerGroup<TEventKey, TEventData> {
        return new ListenerGroup(this);
    }

    cancelAllListeners() {
        this.eventListeners.clear();
        this.listenerIdEventMap.clear();
        for (let t of this.timeoutIds) {
            clearTimeout(t[1])
        }
        this.timeoutIds.clear();
    }

    protected fireEvent(eventName:TEventKey, eventData:TEventData) {
        let callbackList = this.eventListeners.get(eventName);
        if (callbackList != null) {
            for (let i = 0; i < callbackList.length; i++) {
                callbackList[i].callback(eventData);
            }
        }
    }
}

export class ListenerGroup<TEventKey, TEventData> {
    constructor(readonly parentListenable: MultiListenable<TEventKey, TEventData>) {}

    private listeners: Set<number> = new Set();

    /**
     * Register a listener for an event on this object.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    on(eventName:TEventKey, callback:(ev: TEventData) => void) : number {
        let listenerId = this.parentListenable.on(eventName, callback);
        this.listeners.add(listenerId);
        return listenerId;
    }

    /**
     * Register a listener for an event on this object that will only be triggered once.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    once(eventName:TEventKey, callback:(ev: TEventData) => void) : number {
        const modifiedCallback = (ev: TEventData) => {
            this.listeners.delete(listenerId);
            callback(ev);
        };        
        
        let listenerId =  this.parentListenable.once(eventName, modifiedCallback);
        this.listeners.add(listenerId);
        return listenerId;
    }

    /**
     * Register a listener for an event on this object that will only be triggered once.
     * 
     * If the event does not occur within the specified timeout, then the listener will be cancelled
     * and an alternate callback will be fired.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @param timeoutMs The number of milliseconds the event has to fire within
     * @param onTimeout The callback to trigger if the timeout is reached
     * @returns A ID that can be used to deactivate this listener
     */
    onceWithTimeout(eventName:TEventKey, callback:(ev: TEventData) => void, timeoutMs: number, onTimeout: () => void) : number {
        const modifiedCallback = (ev: TEventData) => {
            this.listeners.delete(listenerId);
            callback(ev);
        };     

        let listenerId =  this.parentListenable.onceWithTimeout(eventName, modifiedCallback, timeoutMs, onTimeout);
        this.listeners.add(listenerId);
        return listenerId;
    }

    /**
     * Unregister a listener on this object. The listener will no longer receive events.
     * @param listenerId The ID of the listener to deactivate
     */
    off(listenerId: number) {
        this.parentListenable.off(listenerId);
        this.listeners.delete(listenerId);
    }

    /**
     * Cancel all listeners registered through this group.
     */
    cancelAll() {
        for (let l of this.listeners) {
            this.parentListenable.off(l);
        }
    }
}

export class ControllableMultiListenable<TEventKey, TEventData> extends MultiListenable<TEventKey, TEventData> {
    public fireEvent(eventName:TEventKey, eventData:TEventData) {
        super.fireEvent(eventName, eventData);
    }
}