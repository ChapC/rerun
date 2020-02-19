import { RerunStateObject } from './index';
import fs from 'fs';
import { UserEvent } from './events/UserEvent';
import { ScheduleChange } from './playback/ScheduleChange';
import { ContentBlock } from './playback/ContentBlock';
import { MediaObject } from './playback/MediaObject';
import { PlayerBasedEvent } from './events/UserEventTypes';
import { ShowGraphicAction } from './events/UserEventActionTypes';
import { LocalDirectorySource, mediaObjectFromVideoFile } from './contentsources/LocalDirectorySource';
import WebSocket from 'ws';
import { ContentSource } from './contentsources/ContentSource';

const uuidv4 = require('uuid/v4');

const invalidTypeError = { code: 'InvalidType', message: 'Invalid type for request' };
const invalidArgumentsError = { code: 'InvalidArguments', message: 'The provided arguments are invalid' };

export default class ControlPanelHandler {
    constructor(private rerunState: RerunStateObject) { }

    private connectedControlPanels : WebSocket[] = [];
    registerWebsocket(ws: WebSocket) {
        this.connectedControlPanels.push(ws);

        //Send the current status to the control panel
        ws.send(JSON.stringify({
            reqId: this.getReqID(), eventName: 'setPlayerState', data: this.rerunState.player.getState()
        }));

        ws.on('message', (message) => {
            if (message === 'pong') {
                return;
            }
            let cpRequest = JSON.parse(message.toString());

            if (cpRequest != null) {
                const responseHandler = (responseObject:any, isError: boolean) => {
                    if (isError) {
                        responseObject.status = 'error';
                    } else {
                        if (responseObject.status == null) {
                            responseObject.status = 'ok'; //If the request handler didn't set a status, default to ok
                        }
                    }

                    ws.send(JSON.stringify({ //Send an event back with a matching reqId
                        reqId: cpRequest.reqId, eventName: 'res', data: responseObject
                    }));
                };

                this.handleRequest(cpRequest.req, cpRequest.data, 
                    (resData) => responseHandler(resData, false), (errData) => responseHandler(errData, true));
            }
        });

        ws.on('close', () => {
            this.connectedControlPanels.splice(this.connectedControlPanels.indexOf(ws), 1);
        });
    }

    cpRequestIDCounter = 0;
    getReqID(): number {
        this.cpRequestIDCounter++;
        return this.cpRequestIDCounter;
    }

    handleRequest(requestName: string, data: any, respondWith: (obj: any) => void, respondWithError: (obj: any) => void) {
        switch (requestName) {
            //Player requests
            case 'nextBlock': //Skip to the next scheduled ContentBlock
                if (this.rerunState.player.getQueueLength() === 0) {
                    respondWithError({ code: 'NoNextBlock', message: 'There is no scheduled ContentBlock to play.' });
                    break;
                }

                this.rerunState.player.progressQueue();
                respondWith({ message: 'Moved to next ContentBlock' });
                break;
            case 'playerRefresh': //The control panel requested an update on the player state
                respondWith(this.rerunState.player.getState());
                break;
            case 'stopToTitle':
                this.rerunState.player.goToDefaultBlock(2000);
                respondWith({ message: 'Stopped to title block.' });
                break;
            case 'restartPlayback':
                this.rerunState.player.restartCurrentBlock();
                respondWith({ message: 'Restarted current block.' });
                break;
            case 'scheduleChange': //A reorder or delete of a scheduled ContentBlock
                const requestedScheduleChange = ScheduleChange.makeNew(data);
                if (requestedScheduleChange != null) {
                    const targetContentBlock = this.rerunState.player.getBlockInQueue(requestedScheduleChange.fromIndex);

                    if (requestedScheduleChange.fromIndex == null) {
                        respondWithError(invalidArgumentsError);
                        break;
                    }

                    //Verify that the request ContentBlockID and the targetContentBlock's ID are the same 
                    if (requestedScheduleChange.contentBlockId !== targetContentBlock.id) {
                        //The control panel's schedule is wrong, probably outdated
                        respondWithError({ code: 'IdMismatch', message: "The provided ContentBlock id did not match the target index's id." });
                        break;
                    }

                    //Check that fromIndex is within the queue's range
                    if (requestedScheduleChange.fromIndex < 0 || requestedScheduleChange.fromIndex >= this.rerunState.player.getQueueLength()) {
                        respondWithError({ code: 'OutOfBounds', message: "The provided fromIndex is outside of the queue's range" });
                        break;
                    }

                    if (requestedScheduleChange.toIndex == -1) {
                        //This is a delete request
                        this.rerunState.player.removeBlockAt(requestedScheduleChange.fromIndex);
                        respondWith({ message: 'ContentBlock ' + requestedScheduleChange.contentBlockId + ' removed' });
                    } else {
                        //This is a reorder request
                        this.rerunState.player.reorderBlock(requestedScheduleChange.fromIndex, requestedScheduleChange.toIndex);
                        respondWith({ message: 'ContentBlock ' + requestedScheduleChange.contentBlockId + ' moved' });
                    }
                } else {
                    respondWithError(invalidTypeError);
                }
                break;
            //Content block requests
            case 'updateContentBlock': //Requested to change an existing content block
                if (data.block == null || data.block.id == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                //Try to create a new content block from the provided one
                this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                    contentBlock.id = data.block.id; //Replace the generated id with the target id
                    this.rerunState.player.updateBlockAt(data.block.id, contentBlock);
                    respondWith({ message: 'Updated block with id ' + data.block.id })
                }).catch(error => {
                    console.error('Failed to create content block from request:', error);
                    respondWithError({ message: error });
                });
                break;
            case 'addContentBlock': //Requested to add a new content block to the queue
                if (data.block == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
                    this.rerunState.player.enqueueBlock(contentBlock);
                    respondWith({ message: 'Enqueued content block ' + data.block.id })
                }).catch(error => {
                    console.error('Failed to enqueue new content block:', error);
                    respondWithError({ message: error });
                });
                break;
            //Event requests
            case 'getEvents': //Requested a list of UserEvents
                respondWith(this.rerunState.userEventManager.getEvents());
                break;
            case 'createEvent':
                if (data.type == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                let newEvent = this.createUserEventFromRequest(data);
                let newEventId = this.rerunState.userEventManager.addEvent(newEvent);
                respondWith({ message: 'Created new event with id=' + newEventId });
                this.sendAlert('setEventList', this.rerunState.userEventManager.getEvents());

                break;
            case 'updateEvent': //Request to update an existing userEvent
                if (data.eventId == null || data.newEvent == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                let updatedEvent = this.createUserEventFromRequest(data.newEvent);

                this.rerunState.userEventManager.updateEvent(data.eventId, updatedEvent);
                respondWith({ message: 'Updated event id=' + data.eventId });
                this.sendAlert('setEventList', this.rerunState.userEventManager.getEvents());
                break;
            case 'deleteEvent':
                if (data.eventId == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.rerunState.userEventManager.removeEvent(data.eventId);
                respondWith({ message: 'Removed event with id =' + data.eventId });
                this.sendAlert('setEventList', this.rerunState.userEventManager.getEvents());
                break;
            case 'setEventEnabled': //Setting the enabled property of a UserEvent
                if (data.eventId == null || data.enabled == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.rerunState.userEventManager.setEventEnabled(data.eventId, data.enabled);
                respondWith({ message: (data.enabled ? 'Enabled' : 'Disabled') + ' event ID ' + data.eventId });
                this.sendAlert('setEventList', this.rerunState.userEventManager.getEvents());
                break;
            //Graphics events
            case 'getGraphicsPackages': //Requested a list of available graphics packages
                respondWith(this.rerunState.graphicsManager.getAvailablePackages());
                break;
            //Content sources
            case 'pullFromContentSource': //Pull the next media object from a content source and queue it for playback
                if (data.sourceId == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                const targetSource = this.rerunState.contentSourceManager.getSource(data.sourceId);
                if (targetSource == null) {
                    respondWithError({message: 'No source with id ' + data.sourceId});
                    break;
                }

                targetSource.poll().then((block) => {
                    this.rerunState.player.enqueueBlock(block);
                    respondWith({ message: 'Queued item from source ' + targetSource.name});
                }).catch((error) => {
                    console.error('Pull from content source failed ', error);
                    respondWithError({message: error});
                });
                break;
            case 'newContentSource':
                if (data.newSource == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.createContentSourceFromRequest(data.newSource).then((source) => {
                    this.rerunState.contentSourceManager.addSource(source);
                    respondWith({ message: 'Created source with id=' + data.eventId });
                }).catch((error) => {
                    respondWithError({ message: error });
                });
                break;
            case 'deleteContentSource':
                if (data.sourceId == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.rerunState.contentSourceManager.removeSource(data.sourceId);
                respondWith({ message: 'Removed source with id ' + data.sourceId});
                break;
            case 'getContentSources':
                respondWith(this.rerunState.contentSourceManager.getSources());
                break;
            case 'updateContentSource': //Update an existing content source
                if (data.sourceId == null || data.newSource == null) {
                    respondWithError(invalidArgumentsError);
                    break;
                }

                this.createContentSourceFromRequest(data.newSource).then((source) => {
                    this.rerunState.contentSourceManager.updateSource(data.sourceId, source);
                    respondWith({ message: 'Updated source id=' + data.eventId });
                }).catch((error) => {
                    respondWithError({ message: error });
                });
                break;
            case 'getAutoPool':
                respondWith({
                    pool: this.rerunState.contentSourceManager.getAutoSourcePool(),
                    options: this.rerunState.contentSourceManager.getAutoPoolOptions()
                });
                break;
            case 'setAutoPoolOptions':
                if (data.enabled == null || data.targetQueueSize == null || data.pullOrder == null) {
                    respondWithError(invalidArgumentsError);
                    break;                    
                }

                this.rerunState.contentSourceManager.setAutoPoolOptions(data);
                respondWith({ message: 'Set new auto pool options'});
                this.sendAlert('setAutoPoolOptions', this.rerunState.contentSourceManager.getAutoPoolOptions());
                break;
            case 'setUseSourceInPool': //Set whether a content source should be included in the pool
                if (data.sourceId == null || data.enabled == null) {
                    respondWithError(invalidArgumentsError);
                    break;                             
                }

                this.rerunState.contentSourceManager.setUseSourceForAuto(data.sourceId, data.enabled);
                respondWith({ message: 'Set source ' + data.sourceId + ' to ' + data.enabled});
                this.sendAlert('setAutoPoolList', this.rerunState.contentSourceManager.getAutoSourcePool());
                break;

            default:
                console.info('Unknown control panel request "' + requestName + '"');
                respondWithError({ message: 'Unknown request "' + requestName + '"' })
        }
    }

    sendAlert(event: string, data?: object) {
        let eventObj = { eventName: event, data: data }
        for (let socketIP in this.connectedControlPanels) {
            this.connectedControlPanels[socketIP].send(JSON.stringify(eventObj));
        }
    }

    private createContentSourceFromRequest(requestedSource : any) : Promise<ContentSource> {
        return new Promise((resolve, reject) => {
            switch (requestedSource.type) {
                case 'LocalDirectory':
                    let ldirSource = new LocalDirectorySource(requestedSource.name, requestedSource.directory);
                    ldirSource.id = requestedSource.id;
                    ldirSource.setShuffle(requestedSource.shuffle);
                    resolve(ldirSource);
                    break;
                default:
                    reject("Unknown source type '" + requestedSource.type + "'");
            }
        });
    }

    private createContentBlockFromRequest(requestedBlock: any) : Promise<ContentBlock> {
        return new Promise((resolve, reject) => {
            //Try to create the MediaObject
            this.createMediaObjectFromRequest(requestedBlock.media).then((mediaObject: MediaObject) => {
                let block = new ContentBlock(uuidv4(), mediaObject);
                block.colour = requestedBlock.colour;
                block.playbackConfig = requestedBlock.playbackConfig;
                resolve(block);
            }).catch(error => reject(error));
        });
    }

    private createMediaObjectFromRequest(requestedMedia: any): Promise<MediaObject> {
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
                    reject('YT not yet implemented');
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

    private createUserEventFromRequest(requestedEvent: any): UserEvent {
        if (requestedEvent.type === 'Player') {
            let action = this.createActionFromRequest(requestedEvent.action);
            try {
                let playerEvent = new PlayerBasedEvent(
                    requestedEvent.name, this.rerunState.player, requestedEvent.targetPlayerEvent,
                    requestedEvent.frequency, action, requestedEvent.eventOffset
                );
                return playerEvent;
            } catch (err) {
                console.error('Failed to create PlayerBasedEvent from request:', err);
            }
        } else {
            console.warn('Could not create UserEvent for unsupported event type "' + requestedEvent.type + '"');
            return requestedEvent;
        }
    }

    private createActionFromRequest(requestedAction: any): UserEvent.Action {
        if (requestedAction.type === 'GraphicEvent') {
            try {
                return new ShowGraphicAction(requestedAction.targetLayer,
                    this.rerunState.graphicsManager.sendGraphicEvent, requestedAction.animInTime);
            } catch (err) {
                console.error('Failed to create GraphicEvent from request:', err);
            }
        } else {
            console.warn('Could not create UserEvent action for unsupported action type "' + requestedAction.type + '"');
            return requestedAction;
        }
    }
}