export abstract class SingleListenable<EventType> {
    private listeners: {[id : number] : (changed : EventType) => void} = {};
    private listenerIdCounter = 0;

    addChangeListener(listener : (value : EventType) => void) : number {
        const id = this.listenerIdCounter++;
        this.listeners[id] = listener;
        return id;
    }

    removeChangeListener(listenerId : number) {
        delete this.listeners[listenerId];
    }

    cancelAllListeners() {
        this.listeners = {};
    }

    protected triggerListeners(changed: EventType) {
        Object.values(this.listeners).forEach(listener => listener(changed));
    }
}