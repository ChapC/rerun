//This function will be stringified and injected into the graphics JS files
const initRerunReference = () => {
    window.rerun = { version: 0.1 }

    console.info("[node-rerun] Version " + window.rerun.version);

    let ws = new WebSocket('ws://' + localIP + ":8080/graphicEvents");

    let reconnectTimeout = null;
    function attemptReconnect() {
        if (ws.readyState === 2 || ws.readyState === 3) {
            //CLOSING or CLOSED
            openSocket();
            reconnectTimeout = setTimeout(attemptReconnect, 5000);
        }
    }
    function onConnectionLost(event) {
        console.error("[node-rerun] Lost connection to rerun server: ", event)
        
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(attemptReconnect, 5000);
    }
    function openSocket() {
        ws = new WebSocket('ws://' + localIP + ":8080/graphicEvents");

        ws.addEventListener('open', () => {
            console.info("[node-rerun] Connected to node-rerun server at " + localIP);
            ws.addEventListener('error', onConnectionLost);
            ws.addEventListener('close', onConnectionLost);      
        });

        ws.addEventListener('message', (event) => {
            let message = event.data;
            let serverEvent = JSON.parse(message);
            console.info('[node-rerun] Event from server: ' + serverEvent.name);
            dispatchEvent(serverEvent);
        });
    }

    openSocket();

    window.rerun.eventCallbacks = {};
    window.rerun.setTimings = setTimings;
    window.rerun.on = attachEventCallback;

    const pendingEvents = {};
    function dispatchEvent(event) {
        if (event.name in window.rerun.eventCallbacks) {
            window.rerun.eventCallbacks[event.name].forEach((callback) => callback(event));
        } else {
            //There is no callback registered for this event yet - hold onto it
            pendingEvents[event.name] = event;
        }
    }

    function setTimings(timingsMap) {
        let timingsObj = {
            sourceGraphic: myGraphicsLayerName, type: 'timings', timingsMap: timingsMap
        };
        ws.send(JSON.stringify(timingsObj));
    }

    function attachEventCallback(event, callback) {
        if (event in window.rerun.eventCallbacks) {
            window.rerun.eventCallbacks[event].append(callback);
        } else {
            window.rerun.eventCallbacks[event] = [callback];
        }

        //Check if there are any pending events that this callback consumes
        if (event in pendingEvents) {
            callback(pendingEvents[event]);
            delete pendingEvents[event];
        }
    }
}
//TODO: It'd be cool if we could use wss://, but I think the graphics webpages would complain about self-signed certs

module.exports = {
    script: initRerunReference
}