import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {ContentRenderer} from './ContentRenderers';
import {MediaTypeRendererMap} from '../index';
const colors = require('colors');

export class Player {
    private rendererMap: MediaTypeRendererMap;
    private defaultBlock: ContentBlock;

    constructor(rendererMap: MediaTypeRendererMap, defaultBlock: ContentBlock) {
        this.rendererMap = rendererMap;
        this.defaultBlock = defaultBlock;

        this.setCurrentBlockNow(defaultBlock);
    }

    //Currently-playing block
    private currentBlock: ContentBlock = null;
    private progressMs:number = 0;
    private currentBlockInterval:NodeJS.Timeout = null;

    //Queued content blocks
    private queue: ContentBlock[] = [];

    enqueueBlock(block:ContentBlock) {
        this.queue.push(block);
        this.fireEvent('queueChange', this.queue);
    }

    insertBlockAt(index:number, newBlock:ContentBlock, supressEvent:boolean = false) {
        this.queue.splice(index, 0, newBlock);
        if (index === 0) {
            //Preload this block
            this.attemptNextBlockPreload();
        }
        if (!supressEvent) {
            this.fireEvent('queueChange', this.queue);
        }
    }

    removeBlockAt(index:number, supressEvent:boolean = false) {
        this.queue.splice(index, 1);
        if (!supressEvent) {
            this.fireEvent('queueChange', this.queue);
        }
    }

    updateBlockAt(blockId:string, newBlock:ContentBlock) {
        let index = null;
        for (let i = 0; i < this.queue.length; i++) {
            let block = this.queue[i];
            if (block.id == blockId) {
                index = i;
                break;
            }
        }

        if (index == null) {
            this.warn("Content block update failed: No block with id = " + blockId);
            return;
        }

        this.queue[index] = newBlock;
        this.info('Updated block ' + newBlock.id);

        if (index === 0) {
            //Preload this block
            this.attemptNextBlockPreload();
        }
        this.fireEvent('queueChange', this.queue);
    }

    reorderBlock(oldIndex:number, newIndex:number) {
        let block = this.queue[oldIndex];
        this.removeBlockAt(oldIndex, true);
        this.insertBlockAt(newIndex, block, true);
        this.fireEvent('queueChange', this.queue);
    }

    getBlockInQueue(index: number) : ContentBlock {
        return this.queue[index];
    }

    getQueueLength() : number {
        return this.queue.length;
    }

    private pullNextBlock() : ContentBlock {
        if (this.queue.length === 0) {
            return null;
        }
        let nextBlock = this.queue[0];
        this.queue.splice(0, 1);
        this.fireEvent('queueChange', this.queue);
        return nextBlock;
    }

    //Take the next item out of the queue and play it
    progressQueue() {
        if (this.activePause != null) {
            this.info('Tried to set progress queue while pause active');
            return;
        }

        let nextBlock = this.pullNextBlock();
        if (nextBlock == null) {
            //No next block - show the default block
            nextBlock = this.defaultBlock;
        }

        this.info('Progressing to next queued ContentBlock...');

        let targetRenderer = this.rendererMap[nextBlock.media.type].renderer;

        //loadMedia will resolve immediately if the renderer already has this media ready
        targetRenderer.loadMedia(nextBlock.media).then(() => {
            targetRenderer.play().then(() => {
                this.startCurrentBlockTimer(nextBlock);
                this.info('Started new ContentBlock "' + nextBlock.media.name + '"');                
                this.attemptNextBlockPreload();
            }).catch(error => this.error('Error while starting playback: ', error));
        }).catch(error => this.error('Error while loading media: ', error));

        this.focusRenderer(targetRenderer);
    }

    //Immediately set and play the current content block. Does not affect the queue.
    setCurrentBlockNow(newBlock:ContentBlock, unloadDelayMs: number = 0) {
        if (this.activePause != null) {
            //TODO: This should be allowed, it should just stop the pause early and play newBlock
            this.info('Tried to set current block while pause active');
            return;
        }

        //Load the new block's media into its renderer
        let blockRenderer = this.rendererMap[newBlock.media.type].renderer;
        this.focusRenderer(blockRenderer, unloadDelayMs);

        if (blockRenderer == null) {
            this.warn('No compatible renderer for media type ' + newBlock.media.type);
            return;
        }

        blockRenderer.loadMedia(newBlock.media).then(() => {
            blockRenderer.play().then(() => {
                this.startCurrentBlockTimer(newBlock);
                this.info('Set current block to "' + newBlock.media.name + '"');
            }).catch(error => this.error('Error while starting playback: ', error));
        }).catch(error => this.error('Error while loading media: ', error));
    }

    goToDefaultBlock(unloadDelayMs:number = 0) {
        this.info('Jumping to default block');
        this.setCurrentBlockNow(this.defaultBlock, unloadDelayMs);
    }

    restartCurrentBlock() {
        if (this.activePause != null) {
            this.info('Tried to restart current block while pause active');
            return;
        }

        this.info('Restarting current block');
        let activeRenderer = this.rendererMap[this.currentBlock.media.type].renderer;
        activeRenderer.restartMedia().then(() => this.startCurrentBlockTimer(this.currentBlock)).catch((error) => error('Error while restarting media: ', error));
    }

    timerResolutionMs = 100;

    //Update the current block, start the block finished timer and fire event
    private startCurrentBlockTimer(newBlock:ContentBlock) {
        this.currentBlock = newBlock;
        this.progressMs = 0;

        if (this.currentBlockInterval != null) {
            clearInterval(this.currentBlockInterval);
            this.currentBlockInterval = null;
        }

        if (newBlock.media.durationMs != Number.POSITIVE_INFINITY) { //Some media types have an unknown duration (live streams, images)
            //TODO: Factor the content block's PlaybackConfig into this
            //Start the currentBlock timer
            this.currentBlockInterval = setInterval(() => {

                this.progressMs += this.timerResolutionMs;

                //Relative time events
                let second = this.progressMs - this.timerResolutionMs;
                if (second % 1000 === 0) { //Only fire this event once per second
                    this.fireEvent('relTime:start-' + second / 1000, null);
                    this.fireEvent('relTime:end-' + Math.floor((this.currentBlock.media.durationMs - second) / 1000), null);
                }

                if (this.progressMs >= newBlock.media.durationMs) {
                    //The current content block is finished
                    clearInterval(this.currentBlockInterval);

                    //Check if there are any inbetween pauses set
                    if (Object.keys(this.requestedPauses).length !== 0) {
                        //Find the longest requested pause and use that
                        let longestPause = new Player.Pause('', 0);
                        for (let pause of Object.values(this.requestedPauses)) {
                            if (longestPause.remainingSec < pause.remainingSec) {
                                longestPause = pause;
                            }
                        }

                        //Start the pause countdown
                        this.activePause = longestPause;
                        this.info('Starting inbetween pause (source=' + longestPause.source + ',length=' + longestPause.remainingSec + 's)');
                        this.fireEvent('paused', this.activePause);
                        this.attemptNextBlockPreload(true); //Force preload the next block (we can force b/c we know nothing is playing)
                        this.activePauseInterval = setInterval(() => {

                            if (this.activePause == null) {
                                //The pause has been cancelled
                                this.clearPause();
                                this.info('Inbetween pause cancelled');
                                this.progressQueue();
                                return;
                            }

                            this.activePause.remainingSec -= this.timerResolutionMs;

                            if (this.activePause.remainingSec <= 0) {
                                //The pause has finished
                                this.clearPause();
                                this.progressQueue();
                            }

                        }, this.timerResolutionMs);
                    } else {
                        this.progressQueue(); //No pauses, progress immediately
                    }
                }

            }, this.timerResolutionMs);
        }

        this.fireEvent('newCurrentBlock', this.currentBlock);
    }

    //Bring the target renderer into focus
    private focusRenderer(targetRenderer:ContentRenderer, unloadDelayMs:number = 0) {
        //Focus target, unload all other rendererMap
        for (let r of Object.values(this.rendererMap)) {
            if (r.renderer === targetRenderer) {
                //Focus this renderer
                r.focus();
            } else {
                setTimeout(() => r.renderer.unloadMedia(), unloadDelayMs);
            }
        }
    }

    //Load the next block into its renderer. This will only happen if the next block uses a different renderer than the current.
    private attemptNextBlockPreload(forceLoad: boolean = false) {
        let nextBlock = this.queue[0];

        if (nextBlock == null) {
            return; //No next block
        }

        if (!forceLoad && nextBlock.media.type === this.currentBlock.media.type) {
            //Can't preload the next block; its renderer is already in use
            return;
        }
        this.info('Preloading the next block (' + nextBlock.media.name + ')');
        let targetRenderer = this.rendererMap[nextBlock.media.type].renderer;

        if (targetRenderer.getLoadedMedia() != null) {
            //If the renderer already has media loaded, unload it first
            targetRenderer.unloadMedia().then(() => {
                targetRenderer.loadMedia(nextBlock.media).catch(error => error('Failed to load next block into renderer: ', error));
            }).catch(error => error('Failed to load next block into renderer: Error while unloading current block - ', error));
        } else {
            //Nothing loaded, load the new media immediately
            targetRenderer.loadMedia(nextBlock.media).catch(error => error('Failed to load next block into renderer: ', error));
        }

    }

    getState() : PlayerState {
        return new PlayerState(this.currentBlock, this.progressMs, this.queue, this.activePause);
    }

    //Inbetween pause - A pause can be specified that creates a delay in-between each ContentBlock
    private activePause: Player.Pause = null; //null means no pause active
    private activePauseInterval : NodeJS.Timeout = null;
    private requestedPauses: {[id: number] : Player.Pause} = {}; //If multiple pause requests are active, the longest one is used
    private pauseIdCounter = 0;

    private clearPause() {
        clearInterval(this.activePauseInterval);
        this.activePause = null;
    }

    //Adds the pause and returns its ID
    addInbetweenPause(pause: Player.Pause) : number {
        let pauseId = this.pauseIdCounter++;
        pause.id = pauseId;
        this.requestedPauses[pauseId] = pause;
        return pauseId;
    }

    removeInbetweenPause(pauseId: number) {
        delete this.requestedPauses[pauseId];
        //If this pause is currently active, remove it there too
        if (this.activePause.id === pauseId) {
            this.activePause = null;
        }
    }

    /* Events
    *   - "newCurrentBlock": The current block changed . EventData contains the new ContentBlock.
    *   - "queueChange": The queue was updated. EventData contains the new queue.
    *   - "paused": An inbetween pause is active. EventData contains the pause reason.
    *   - "relTime:[start/end]-[n]": Fired at (or as close as possible to) [n] seconds after the start/before the end.
    */
    private listenerIdCounter = 0;
    private listenerIdEventMap : {[id: number] : string} = {}; //Maps listenerID to the event it's listening for
    private eventListeners: {[event: string] : Player.EventCallback[]} = {}; //Maps eventName to a list of registered callbacks

    on(eventName:string, callback:(ev: object) => void) : number {
        let listenerId = this.listenerIdCounter++;
        this.listenerIdEventMap[listenerId] = eventName;

        if (!(eventName in this.eventListeners)) {
            this.eventListeners[eventName] = [];
        }
        this.eventListeners[eventName].push(new Player.EventCallback(listenerId, callback));

        return listenerId;
    }

    cancelListener(listenerId: number) {
        //Find the event that this listener is subscribed to
        let eventName = this.listenerIdEventMap[listenerId];
        if (eventName == null) {
            return; //This event has probably already been cancelled
        }
        if (this.eventListeners[listenerId] == null) {
            return; //No listeners have been regisered for this event
        }
        //Remove the callback from eventListeners
        for (let i = 0; i < this.eventListeners[listenerId].length; i++) {
            let event = this.eventListeners[listenerId][i];
            if (event.id === listenerId) {
                this.eventListeners[listenerId].splice(i, 1);
                break;
            }
        }

        delete this.listenerIdEventMap[listenerId];
    }

    private fireEvent(eventName:string, eventData:object) {
        let callbackList = this.eventListeners[eventName];
        if (callbackList != null) {
            for (let i = 0; i < callbackList.length; i++) {
                let callback: (ev: object) => void = callbackList[i].callback;
                callback(eventData);
            }
        }
    }

    info(message:string) : void {
        console.info('[Player] ' + message);
    }

    warn(message:string) : void {
        console.warn(colors.yellow('[Player] WARNING - ' + message));
    }
    
    error(message:string, obj:any) : void {
        console.error(colors.red(message), obj);
    }
}

export namespace Player {
    export class EventCallback {constructor(public id:number, public callback:((ev: object) => void)){}};

    export class Pause {id:number; constructor(public source: string, public remainingSec: number){}};
}

export class PlayerState {
    constructor(public currentBlock: ContentBlock, public progressMs: number, public queue:ContentBlock[], public pauseReason:Player.Pause) {}
}