import {ContentBlock} from './ContentBlock';
import {MediaObject} from './MediaObject';
import {ContentRenderer} from './renderers/ContentRenderer';
import {ContentTypeRendererMap, RerunStateObject} from '../index';
import {IntervalMillisCounter} from '../helpers/IntervalMillisCounter';
import {MultiListenable} from '../helpers/MultiListenable';
import PrefixedLogger from '../helpers/PrefixedLogger';
import { WSConnection } from '../helpers/WebsocketConnection';
import ControlPanelHandler, { ControlPanelRequest, ControlPanelListener } from '../ControlPanelHandler';
import { mediaObjectFromVideoFile } from "../contentsources/LocalDirectorySource";
import fs from 'fs';
import { mediaObjectFromYoutube } from "../contentsources/YoutubeChannelSource";
import { ScheduleChange } from './ScheduleChange';
const colors = require('colors');
const uuidv4 = require('uuid/v4');

/* Events
*   - "newCurrentBlock": The current block changed. EventData contains the new ContentBlock.
*   - "stopped": Playback stopped to default block.
*   - "queueChange": The queue was updated. EventData contains the new queue.
*   - "relTime:[start/end]-[n]": Fired at (or as close as possible to) [n] seconds after the start/before the end.
*
* TODO: (long term) With the current Player setup, it's really tricky to overlay content on top of other content. 
*       It works okay for graphics-over-video, as these are handled by two different ContentRenderers, but it's not
*       currently possible to, for instance, use a semi-transparent video as a stinger on top of other videos. To facilitate this
*       we might have to look into the concept of video/audio tracks, where multiple instances of ContentRenderers
*       could run on separate tracks simultaneously. That's a whole thing though, probably involving a move from OBS to ffmpeg directly.
*/
@ControlPanelListener
export class Player extends MultiListenable {
    private log: PrefixedLogger = new PrefixedLogger("Player");
    private rendererMap: ContentTypeRendererMap;
    private defaultBlock: ContentBlock;

    constructor(rendererMap: ContentTypeRendererMap, private rerunState: RerunStateObject, defaultBlock: ContentBlock) {
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

    dequeueBlock(block:ContentBlock) {
        let targetIndex = null;
        for (let i = 0; i < this.queue.length; i++) {
            if (this.queue[i].id === block.id) {
                targetIndex = i;
            }
        }

        if (targetIndex != null) {
            this.removeBlockAt(targetIndex);
        }
    }

    insertBlockAt(index:number, newBlock:ContentBlock, suppressEvent:boolean = false) {
        this.queue.splice(index, 0, newBlock);
        if (index === 0) {
            //Preload this block
            this.attemptNextBlockPreload();
        }
        if (!suppressEvent) {
            this.fireEvent('queueChange', this.queue);
        }
    }

    removeBlockAt(index:number, suppressEvent:boolean = false) {
        this.queue.splice(index, 1);
        if (!suppressEvent) {
            this.fireEvent('queueChange', this.queue);
        }
    }

    updateBlock(blockId:string, newBlock:ContentBlock) : boolean {
        let index = null;
        for (let i = 0; i < this.queue.length; i++) {
            let block = this.queue[i];
            if (block.id == blockId) {
                index = i;
                break;
            }
        }

        if (index == null) {
            this.log.warn("Content block update failed: No block with id = " + blockId);
            return false;
        }

        this.queue[index] = newBlock;
        this.log.info('Updated block ' + newBlock.id);

        if (index === 0) {
            //Preload this block
            this.attemptNextBlockPreload();
        }
        this.fireEvent('queueChange', this.queue);
        return true;
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

    getQueueLength() {
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

        this.log.info('Progressing to next queued ContentBlock...');

        let targetRenderer = this.rendererMap[nextBlock.media.location.getType()].renderer;

        //loadMedia will resolve immediately if the renderer already has this media ready
        targetRenderer.loadMedia(nextBlock.media).then(() => {
            this.focusRenderer(targetRenderer);
            targetRenderer.play().then(() => {
                this.startCurrentBlockTimer(nextBlock);
                this.log.info('Started new ContentBlock "' + nextBlock.media.name + '"');                
                this.attemptNextBlockPreload();
            }).catch(error => this.log.error('Error while starting playback: ', error));
        }).catch(error => this.log.error('Error while loading media: ', error));

        this.setCurrentState(Player.PlaybackState.Loading);
    }

    //Immediately set and play the current content block. Does not affect the queue.
    setCurrentBlockNow(newBlock:ContentBlock, unloadDelayMs: number = 0) {
        //Load the new block's media into its renderer
        this.progressCounter.stop();
        let blockRenderer = this.rendererMap[newBlock.media.location.getType()].renderer;

        if (blockRenderer == null) {
            this.log.warn('No compatible renderer for media type ' + newBlock.media.type);
            return;
        }

        blockRenderer.loadMedia(newBlock.media).then(() => {
            blockRenderer.play().then(() => {
                this.startCurrentBlockTimer(newBlock);
                this.log.info('Set current block to "' + newBlock.media.name + '"');
                this.focusRenderer(blockRenderer, unloadDelayMs).then(() => this.attemptNextBlockPreload());
            }).catch(error => this.log.error('Error while starting playback: ', error));
        }).catch(error => this.log.error('Error while loading media: ', error));

        this.setCurrentState(Player.PlaybackState.Loading);
    }

    //TODO: Unload delay needs to be removed, probably at the same time as inbetween pauses
    goToDefaultBlock(unloadDelayMs:number = 0) {
        this.log.info('Jumping to default block');
        this.setCurrentBlockNow(this.defaultBlock, unloadDelayMs);
        this.fireEvent('stopped', this.defaultBlock);
    }

    restartCurrentBlock() {
        this.log.info('Restarting current block');
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
        
        this.log.info('Preloading the next block (' + nextBlock.media.name + ')');

        let loadMedia = () => targetRenderer.loadMedia(nextBlock.media).then(() => {
            //Check if this block has a preload attribute
            if (nextBlock.media.preRollMs && nextBlock.media.preRollMs > 0) {
                //This block should be started preRollMs before the end of the current block
                this.one(`relTime:end-${Math.floor(nextBlock.media.preRollMs / 1000)}`, () => {
                    if (this.queue[0].id === nextBlock.id) { //Check that this block hasn't been deleted from the queue
                        console.info(`Prerolling content block ${nextBlock.media.name} with ${nextBlock.media.preRollMs}ms`);
                        if (!targetRenderer.getLoadedMedia().isSame(nextBlock.media)) {
                            targetRenderer.loadMedia(nextBlock.media).then(targetRenderer.play);
                        }
                        targetRenderer.play();
                    }
                });
            }
        }).catch(error => error('Failed to load next block into renderer: ', error));

        if (targetRenderer.getLoadedMedia() != null) {
            //If the renderer already has media loaded, unload it first
            targetRenderer.stop().then(() => {
                loadMedia();
            }).catch(error => error('Failed to load next block into renderer: Error while stopping current block - ', error));
        } else {
            //Nothing loaded, load the new media immediately
            loadMedia();
        }

    }

    private setCurrentState(newState : Player.PlaybackState, sendEvent: boolean = true) {
        this.state = newState;
        if (sendEvent) {
            this.fireEvent('playbackStateChange', this.state);
        }
    }

    getDefaultBlock() {
        return this.defaultBlock;
    }

    getState() : PlayerState {
        return new PlayerState(this.currentBlock, this.progressMs, this.queue, this.state);
    }

    //Control panel requests

    @ControlPanelRequest('playerRefresh')
    private refreshRequest() : WSConnection.WSPendingResponse {
        return new WSConnection.SuccessResponse('PlayerRefresh', this.getState());
    }

    @ControlPanelRequest('nextBlock')
    private nextBlockRequest() : WSConnection.WSPendingResponse { //Skip to the next scheduled ContentBlock
        if (this.queue.length === 0) {
            return new WSConnection.ErrorResponse('QueueEmpty', 'There is no scheduled content block to play.');
        }

        this.progressQueue();
        return new WSConnection.SuccessResponse('Moved to next content block');
    }

    @ControlPanelRequest('stopToTitle')
    private stopToTitleRequest() : WSConnection.WSPendingResponse {
        this.goToDefaultBlock(2000); //TODO: Fixed unloadDelayMs should be replaced with the animationIn timing from default layer
        return new WSConnection.SuccessResponse('Stopped to title block');
    }

    @ControlPanelRequest('restartPlayback')
    private restartPlaybackRequest() : WSConnection.WSPendingResponse {
        this.restartCurrentBlock();
        return new WSConnection.SuccessResponse('Restarted current block');
    }

    @ControlPanelRequest('scheduleChange', ScheduleChange.isInstance)
    private scheduleChangeRequest(requestedChange: ScheduleChange) : WSConnection.WSPendingResponse {
        const targetContentBlock = this.getBlockInQueue(requestedChange.fromIndex);

        //Verify that the request's ContentBlockID and the targetContentBlock's ID are the same 
        if (requestedChange.contentBlockId !== targetContentBlock.id) {
            //The control panel's schedule is wrong, probably outdated
            return new WSConnection.ErrorResponse('IdMismatch', "The provided ContentBlock id did not match the target index's id.");
        }

        //Check that fromIndex is within the queue's range
        if (requestedChange.fromIndex < 0 || requestedChange.fromIndex >= this.getQueueLength()) {
            return new WSConnection.ErrorResponse('OutOfBounds',"The provided fromIndex is outside of the queue's range");
        }

        if (requestedChange.toIndex == -1) {
            //This is a delete request
            this.removeBlockAt(requestedChange.fromIndex);
            return new WSConnection.SuccessResponse(`ContentBlock ${requestedChange.contentBlockId} removed`);
        } else {
            //This is a reorder request
            this.reorderBlock(requestedChange.fromIndex, requestedChange.toIndex);
            return new WSConnection.SuccessResponse(`ContentBlock ${requestedChange.contentBlockId} moved`);
        }
    }

    @ControlPanelRequest('updateContentBlock', WSConnection.AcceptAny)
    private updateBlockRequest(data: any) : WSConnection.WSPendingResponse {
        return new Promise((resolve, reject) => {
            //Try to create a new content block from the provided one
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                contentBlock.id = data.block.id; //Replace the generated id with the target id
                this.rerunState.player.updateBlock(data.block.id, contentBlock);
                resolve(new WSConnection.SuccessResponse(`Updated block with id ${contentBlock.id}`));
            }).catch(error => {
                console.error('Failed to create content block from request:', error);
                reject(error);
            });
        });
    }

    @ControlPanelRequest('addContentBlock', WSConnection.AcceptAny)
    private addContentBlockRequest(data: any) : WSConnection.WSPendingResponse {
        return new Promise((resolve, reject) => {
            this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                this.rerunState.player.enqueueBlock(contentBlock);
                resolve(new WSConnection.SuccessResponse(`Enqueued content block ${data.block.id}`));
            }).catch(error => {
                console.error('Failed to enqueue new content block:', error);
                resolve(error);
            });
        });
    }

    private createContentBlockFromRequest(requestedBlock: any) : Promise<ContentBlock> {
        return new Promise((resolve, reject) => {
            //Try to create the MediaObject
            this.createMediaObjectFromRequest(requestedBlock.media, this.rerunState).then((mediaObject: MediaObject) => {
                let block = new ContentBlock(uuidv4(), mediaObject);
                block.colour = requestedBlock.colour;
                block.playbackConfig = requestedBlock.playbackConfig;
                resolve(block);
            }).catch(error => reject(error));
        });
    }
    
    private createMediaObjectFromRequest(requestedMedia: any, rerunState: RerunStateObject): Promise<MediaObject> {
        return new Promise((resolve, reject) => {
            let newMedia = MediaObject.CreateEmpty(requestedMedia.type);
            newMedia.name = requestedMedia.name;

            switch (requestedMedia.type) {
                case 'Local video file':
                    //Check that the file exists
                    if (fs.existsSync(requestedMedia.location.path)) {
                        if (!fs.lstatSync(requestedMedia.location.path).isDirectory()) {
                            //Get file metadata for this media object
                            mediaObjectFromVideoFile(requestedMedia.location.path).then((generatedMedia: MediaObject) => {
                                generatedMedia.name = requestedMedia.name; //Set the requested name rather than the generated one
                                resolve(generatedMedia);
                            }).catch(error => reject(error));
                        } else {
                            reject('Failed to create MediaObject from request: Provided path is a directory, not a file');
                        }
                    } else {
                        reject("Failed to create MediaObject from request: File not found");
                    }
                    break;
                case 'Youtube video':
                    mediaObjectFromYoutube(requestedMedia.location.path, rerunState.downloadBuffer).then((media: MediaObject) => {
                        resolve(media);
                    }).catch(error => reject(error));
                    break;
                case 'RTMP stream':
                    reject('RTMP not yet implemented');
                    break;
                case 'Rerun title graphic':
                    reject('Rerun graphic not yet implemented');
                    break;
                default:
                    reject('Unknown media type "' + requestedMedia.type + '"');
            }
        });
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