"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __values = (this && this.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControllableMultiListenable = exports.ListenerGroup = exports.MultiListenable = void 0;
var MultiListenable = /** @class */ (function () {
    function MultiListenable() {
        this.listenerIdCounter = 0;
        this.listenerIdEventMap = new Map(); //Maps listenerID to the event it's listening for
        this.eventListeners = new Map(); //Maps eventName to a list of registered callbacks
        this.timeoutIds = new Map(); //Maps listenerID to timeout objects
        this.asyncPendingTimeouts = new Map();
    }
    /**
     * Register a listener for an event on this object.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    MultiListenable.prototype.on = function (eventName, callback) {
        var listenerId = this.listenerIdCounter++;
        this.listenerIdEventMap.set(listenerId, eventName);
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push({ id: listenerId, callback: callback });
        return listenerId;
    };
    /**
     * Register a listener for an event on this object that will only be triggered once.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    MultiListenable.prototype.once = function (eventName, callback) {
        var _this = this;
        //Modify the callback to unregister the event
        var modifiedCallback = function (ev) {
            _this.off(listenerId);
            callback(ev);
        };
        var listenerId = this.on(eventName, modifiedCallback);
        return listenerId;
    };
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
    MultiListenable.prototype.onceWithTimeout = function (eventName, callback, timeoutMs, onTimeout) {
        var _this = this;
        //Modify the callback to cancel the timeout
        var modifiedCallback = function (ev) {
            var t = _this.timeoutIds.get(listenerId);
            if (t) {
                clearTimeout(t);
                _this.timeoutIds.delete(listenerId);
            }
            callback(ev);
        };
        var listenerId = this.once(eventName, modifiedCallback);
        var timeout = setTimeout(function () {
            _this.off(listenerId);
            onTimeout();
        }, timeoutMs);
        this.timeoutIds.set(listenerId, timeout);
        return listenerId;
    };
    /**
     * Unregister a listener on this object. The listener will no longer receive events.
     * @param listenerId The ID of the listener to deactivate
     */
    MultiListenable.prototype.off = function (listenerId) {
        //Find the event that this listener is subscribed to
        var eventName = this.listenerIdEventMap.get(listenerId);
        if (eventName == null) {
            return; //This listener has probably already been cancelled
        }
        var eventListenerList = this.eventListeners.get(eventName);
        if (eventListenerList == null) {
            return; //No listeners have been registered for this event
        }
        //Remove the callback from eventListeners
        for (var i = 0; i < eventListenerList.length; i++) {
            var event_1 = eventListenerList[i];
            if (event_1.id === listenerId) {
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
    };
    /**
     * Create a ListenerGroup object for this listenable. You can use it to cancel a group of listeners all together.
     */
    MultiListenable.prototype.createListenerGroup = function () {
        return new ListenerGroup(this);
    };
    MultiListenable.prototype.cancelAllListeners = function () {
        var e_1, _a;
        this.eventListeners.clear();
        this.listenerIdEventMap.clear();
        try {
            for (var _b = __values(this.timeoutIds), _c = _b.next(); !_c.done; _c = _b.next()) {
                var t = _c.value;
                clearTimeout(t[1]);
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
            }
            finally { if (e_1) throw e_1.error; }
        }
        this.timeoutIds.clear();
    };
    /**
     * Fire an event immediately. This method will block until all callbacks are finished.
     */
    MultiListenable.prototype.fireEventNow = function (eventName, eventData) {
        var callbackList = this.eventListeners.get(eventName);
        if (callbackList != null) {
            for (var i = 0; i < callbackList.length; i++) {
                callbackList[i].callback(eventData);
            }
        }
    };
    /**
     * Fire an event at the end of the event loop (setTimeout 0).
     *
     * Multiple calls to this method within the same event loop are debounced, so
     * the event will only be called once with the latest eventData.
     */
    MultiListenable.prototype.fireEventAsync = function (eventName, eventData) {
        var _this = this;
        if (this.asyncPendingTimeouts.has(eventName)) {
            clearTimeout(this.asyncPendingTimeouts.get(eventName));
        }
        this.asyncPendingTimeouts.set(eventName, setTimeout(function () {
            _this.asyncPendingTimeouts.delete(eventName);
            _this.fireEventNow(eventName, eventData);
        }, 0));
    };
    return MultiListenable;
}());
exports.MultiListenable = MultiListenable;
var ListenerGroup = /** @class */ (function () {
    function ListenerGroup(parentListenable) {
        this.parentListenable = parentListenable;
        this.listeners = new Set();
    }
    /**
     * Register a listener for an event on this object.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    ListenerGroup.prototype.on = function (eventName, callback) {
        var listenerId = this.parentListenable.on(eventName, callback);
        this.listeners.add(listenerId);
        return listenerId;
    };
    /**
     * Register a listener for an event on this object that will only be triggered once.
     * @param eventName The event to listen for
     * @param callback The callback to trigger when the event is raised
     * @returns A ID that can be used to deactivate this listener
     */
    ListenerGroup.prototype.once = function (eventName, callback) {
        var _this = this;
        var modifiedCallback = function (ev) {
            _this.listeners.delete(listenerId);
            callback(ev);
        };
        var listenerId = this.parentListenable.once(eventName, modifiedCallback);
        this.listeners.add(listenerId);
        return listenerId;
    };
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
    ListenerGroup.prototype.onceWithTimeout = function (eventName, callback, timeoutMs, onTimeout) {
        var _this = this;
        var modifiedCallback = function (ev) {
            _this.listeners.delete(listenerId);
            callback(ev);
        };
        var listenerId = this.parentListenable.onceWithTimeout(eventName, modifiedCallback, timeoutMs, onTimeout);
        this.listeners.add(listenerId);
        return listenerId;
    };
    /**
     * Unregister a listener on this object. The listener will no longer receive events.
     * @param listenerId The ID of the listener to deactivate
     */
    ListenerGroup.prototype.off = function (listenerId) {
        this.parentListenable.off(listenerId);
        this.listeners.delete(listenerId);
    };
    /**
     * Cancel all listeners registered through this group.
     */
    ListenerGroup.prototype.cancelAll = function () {
        var e_2, _a;
        try {
            for (var _b = __values(this.listeners), _c = _b.next(); !_c.done; _c = _b.next()) {
                var l = _c.value;
                this.parentListenable.off(l);
            }
        }
        catch (e_2_1) { e_2 = { error: e_2_1 }; }
        finally {
            try {
                if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
            }
            finally { if (e_2) throw e_2.error; }
        }
    };
    return ListenerGroup;
}());
exports.ListenerGroup = ListenerGroup;
var ControllableMultiListenable = /** @class */ (function (_super) {
    __extends(ControllableMultiListenable, _super);
    function ControllableMultiListenable() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    ControllableMultiListenable.prototype.fireEventNow = function (eventName, eventData) {
        _super.prototype.fireEventNow.call(this, eventName, eventData);
    };
    return ControllableMultiListenable;
}(MultiListenable));
exports.ControllableMultiListenable = ControllableMultiListenable;
