import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {ContentRenderer} from './ContentRenderers';
import {MediaTypeRendererMap} from './index';
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

    updateBlockAt(index:number, newBlock:ContentBlock) {
        this.queue[index] = newBlock;
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
                
                if (this.queue.length > 0) {
                    this.attemptNextBlockPreload();
                }
            }).catch(error => this.error('Error while starting playback: ', error));
        }).catch(error => this.error('Error while loading media: ', error));

        this.focusRenderer(targetRenderer);
    }

    //Immediately set and play the current content block. Does not affect the queue.
    setCurrentBlockNow(newBlock:ContentBlock, unloadDelayMs: number = 0) {
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
                if (this.progressMs >= newBlock.media.durationMs) {
                    clearInterval(this.currentBlockInterval);
                    this.progressQueue();
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
    private attemptNextBlockPreload() {
        let nextBlock = this.queue[0];
        if (nextBlock.media.type === this.currentBlock.media.type) {
            //Can't preload the next block; its renderer is already in use
            return;
        }
        console.info('Preloading the next block');
        let targetRenderer = this.rendererMap[nextBlock.media.type].renderer;

        targetRenderer.loadMedia(nextBlock.media).catch(error => error('Failed to load next block into renderer: ', error));
    }

    getState() : PlayerState {
        return new PlayerState(this.currentBlock, this.progressMs, this.queue);
    }

    /* Events
    *   - newCurrentBlock: The current block changed . EventData contains the new ContentBlock.
    *   - queueChange: The queue was updated. EventData contains the new queue.
    */
    private eventListeners: {[event: string] : ((ev: object) => void)[]} = {};
    on(eventName:string, callback:(ev: object) => void) {
        if (!(eventName in this.eventListeners)) {
            this.eventListeners[eventName] = [];
        }
        this.eventListeners[eventName].push(callback);
    }

    private fireEvent(eventName:string, eventData:object) {
        let callbackList = this.eventListeners[eventName];
        if (callbackList != null) {
            for (let i = 0; i < callbackList.length; i++) {
                let callback: (ev: object) => void = callbackList[i];
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

export class PlayerState {
    constructor(public currentBlock: ContentBlock, public progressMs: number, public queue:ContentBlock[]) {}
}