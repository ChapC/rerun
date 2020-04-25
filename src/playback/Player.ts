import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {ContentRenderer} from './renderers/ContentRenderer';
import {ContentTypeRendererMap} from '../index';
import {IntervalMillisCounter} from '../helpers/IntervalMillisCounter';
import {MultiListenable} from '../helpers/MultiListenable';
const colors = require('colors');

/* Events
*   - "newCurrentBlock": The current block changed . EventData contains the new ContentBlock.
*   - "queueChange": The queue was updated. EventData contains the new queue.
*   - "paused": An inbetween pause is active. EventData contains the pause reason.
*   - "relTime:[start/end]-[n]": Fired at (or as close as possible to) [n] seconds after the start/before the end.
*/
export class Player extends MultiListenable {
    private rendererMap: ContentTypeRendererMap;
    private defaultBlock: ContentBlock;

    constructor(rendererMap: ContentTypeRendererMap, defaultBlock: ContentBlock) {
        super();
        this.rendererMap = rendererMap;
        this.defaultBlock = defaultBlock;

        this.setCurrentBlockNow(defaultBlock);
    }

    private state : Player.PlaybackState = Player.PlaybackState.InBlock;
    
    //Called every 100ms whenever playback time changes
    private relTimeAlerted = -1;//Used so that relTime events are only fired once per second
    private progressTimerTick = (newTimeMs:number) => {
        this.progressMs = newTimeMs;

        //Relative time events
        let second = Math.floor(this.progressMs / 1000);
        if (this.relTimeAlerted != second) { //Only fire this event once per second
            this.relTimeAlerted = second;
            this.fireEvent('relTime:start-' + second, null);
            this.fireEvent('relTime:end-' + Math.floor((this.currentBlock.media.durationMs / 1000) - second), null);
        }

        if (this.progressMs >= this.currentBlock.media.durationMs) {
            //The current content block is finished
            this.progressCounter.stop();
            this.progressQueue();
        }
    }

    private currentBlock: ContentBlock = null;
    private progressMs:number = 0;
    private progressCounter: IntervalMillisCounter = new IntervalMillisCounter(100, this.progressTimerTick);

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
        let nextBlock = this.pullNextBlock();
        if (nextBlock == null) {
            //No next block - show the default block
            nextBlock = this.defaultBlock;
        }

        this.info('Progressing to next queued ContentBlock...');

        let targetRenderer = this.rendererMap[nextBlock.media.location.getType()].renderer;

        //loadMedia will resolve immediately if the renderer already has this media ready
        targetRenderer.loadMedia(nextBlock.media).then(() => {
            this.focusRenderer(targetRenderer);
            targetRenderer.play().then(() => {
                this.startCurrentBlockTimer(nextBlock);
                this.info('Started new ContentBlock "' + nextBlock.media.name + '"');                
                this.attemptNextBlockPreload();
            }).catch(error => this.error('Error while starting playback: ', error));
        }).catch(error => this.error('Error while loading media: ', error));

        this.setCurrentState(Player.PlaybackState.Loading);
    }

    //Immediately set and play the current content block. Does not affect the queue.
    setCurrentBlockNow(newBlock:ContentBlock, unloadDelayMs: number = 0) {
        //Load the new block's media into its renderer
        this.progressCounter.stop();
        let blockRenderer = this.rendererMap[newBlock.media.location.getType()].renderer;

        if (blockRenderer == null) {
            this.warn('No compatible renderer for media type ' + newBlock.media.type);
            return;
        }

        blockRenderer.loadMedia(newBlock.media).then(() => {
            blockRenderer.play().then(() => {
                this.startCurrentBlockTimer(newBlock);
                this.info('Set current block to "' + newBlock.media.name + '"');
                this.focusRenderer(blockRenderer, unloadDelayMs).then(() => this.attemptNextBlockPreload());
            }).catch(error => this.error('Error while starting playback: ', error));
        }).catch(error => this.error('Error while loading media: ', error));

        this.setCurrentState(Player.PlaybackState.Loading);
    }

    //TODO: Unload delay needs to be removed, probably at the same time as inbetween pauses
    goToDefaultBlock(unloadDelayMs:number = 0) {
        this.info('Jumping to default block');
        this.setCurrentBlockNow(this.defaultBlock, unloadDelayMs);
    }

    restartCurrentBlock() {
        this.info('Restarting current block');
        let activeRenderer = this.rendererMap[this.currentBlock.media.location.getType()].renderer;
        activeRenderer.restartMedia().then(() => this.startCurrentBlockTimer(this.currentBlock)).catch((error) => error('Error while restarting media: ', error));
    }

    //Update the current block, start the block finished timer and fire event
    private startCurrentBlockTimer(newBlock:ContentBlock) {
        this.currentBlock = newBlock;
        this.progressMs = 0;

        if (newBlock.media.durationMs != Number.POSITIVE_INFINITY) { //Some media types have an unknown duration (live streams, images)
            //TODO: Factor the content block's PlaybackConfig into this
            //Start the currentBlock timer
            this.progressCounter.start();
        }

        this.setCurrentState(Player.PlaybackState.InBlock, false);
        this.fireEvent('newCurrentBlock', this.currentBlock);
    }

    //Bring the target renderer into focus
    private focusRenderer(targetRenderer:ContentRenderer, unloadDelayMs:number = 0) : Promise<void> {
        return new Promise((resolve, reject) => {
            //Focus target, stop all other rendererMap
            for (let r of Object.values(this.rendererMap)) {
                if (r.renderer === targetRenderer) {
                    //Focus this renderer
                    r.focus();
                } else {
                    if (r.renderer.getLoadedMedia() != null) {
                        setTimeout(() => r.renderer.stop(), unloadDelayMs);
                    }
                }
            }

            setTimeout(resolve, unloadDelayMs);
        });
    }

    //Load the next block into its renderer. This will only happen if the next block uses a different renderer than the current.
    private attemptNextBlockPreload(forceLoad: boolean = false) {
        let nextBlock = this.queue[0];

        if (nextBlock == null) {
            return; //No next block
        }

        let targetRenderer = this.rendererMap[nextBlock.media.location.getType()].renderer;

        if (!forceLoad && nextBlock.media.type === this.currentBlock.media.type) {
            //The renderer for the next block is already in use, check if it supports background loading
            if (!targetRenderer.supportsBackgroundLoad) {
                return;
            }
        }
        
        this.info('Preloading the next block (' + nextBlock.media.name + ')');

        if (targetRenderer.getLoadedMedia() != null) {
            //If the renderer already has media loaded, unload it first
            targetRenderer.stop().then(() => {
                targetRenderer.loadMedia(nextBlock.media).catch(error => error('Failed to load next block into renderer: ', error));
            }).catch(error => error('Failed to load next block into renderer: Error while unloading current block - ', error));
        } else {
            //Nothing loaded, load the new media immediately
            targetRenderer.loadMedia(nextBlock.media).catch(error => error('Failed to load next block into renderer: ', error));
        }

    }

    private setCurrentState(newState : Player.PlaybackState, sendEvent: boolean = true) {
        this.state = newState;
        if (sendEvent) {
            this.fireEvent('playbackStateChange', this.state);
        }
    }

    getState() : PlayerState {
        return new PlayerState(this.currentBlock, this.progressMs, this.queue, this.state);
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
    export class Pause {id:number; constructor(public source: string, public remainingMs: number){}};

    export enum PlaybackState {
        InBlock = 'InBlock', Loading = 'Loading', Errored = 'Error'
    }
}

export class PlayerState {
    constructor(public currentBlock: ContentBlock, public progressMs: number, public queue:ContentBlock[], public playbackState:Player.PlaybackState) {}
}