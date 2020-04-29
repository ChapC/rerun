import { ContentSource } from './ContentSource';
import { SingleListenable } from '../helpers/SingleListenable';
import { Player } from '../playback/Player'; 
import { IJSONSavable, JSONSavable } from '../persistance/JSONSavable';
import { LocalDirectorySource } from './LocalDirectorySource';
import ControlPanelHandler, { ControlPanelListener, ControlPanelRequest } from '../ControlPanelHandler';
import { WSConnection } from '../helpers/WebsocketConnection';

const uuidv4 = require('uuid/v4');

//... it manages content sources
@ControlPanelListener
export class ContentSourceManager extends SingleListenable<ContentSource[]> implements IJSONSavable {
    constructor(public savePath: string, private player : Player) {
        super();
        player.on('queueChange', (newQueue) => this.onQueueChanged());
    };

    private loadedSources : {[id: string] : ContentSource} = {};
    
    addSource(source : ContentSource, useId?: string) : string {
        if (!useId) {
            source.id = uuidv4();
        } else {
            source.id = useId;
        }
        this.loadedSources[source.id] = source;

        //Listen for alerts from this source so they can be propagated to listeners here
        source.alerts.addChangeListener(this.sourceListChanged);

        //Sources are included in the auto pool by default
        this.autoEnabledSources[source.id] = true;

        this.sourceListChanged();
        return source.id;
    }

    updateSource(sourceId: string, source: ContentSource) {
        this.loadedSources[sourceId] = source;
        source.alerts.addChangeListener(this.sourceListChanged);
        this.sourceListChanged();
    }

    removeSource(sourceId : string) {
        delete this.loadedSources[sourceId];
        delete this.autoEnabledSources[sourceId];
        this.sourceListChanged();
    }

    getSource(id: string) {
        return this.loadedSources[id];
    }

    getSources() : ContentSource[] {
        return Object.values(this.loadedSources);
    }

    private sourceListChanged = () => {
        this.triggerListeners(Object.values(this.loadedSources));
        JSONSavable.serializeJSON(this, this.savePath);
    }

    //Automatic content pool
    private autoPoolOptions : ContentSourceManager.AutoPoolOptions = new ContentSourceManager.AutoPoolOptions(); 
    private autoEnabledSources : {[sourceId: string] : boolean} = {};
    
    //Block pool updates until the current one has finished (indeterminate due to promises)
    private pullInProgress = false;
    private currentPullTotal = 0;
    private currentPullProgress = 0;

    updateAutoPoolNow() {
        this.onQueueChanged();
    }

    private partialPoll() {
        this.currentPullProgress++;
        if (this.currentPullProgress >= this.currentPullTotal) {
            this.pullInProgress = false;
        }
    }

    private onQueueChanged() {
        if (this.autoPoolOptions.enabled && !this.pullInProgress && this.player.getQueueLength() < this.autoPoolOptions.targetQueueSize) {
            const sourcePool = this.getAutoSourcePool();

            if (sourcePool.length === 0) {
                return;
            }

            this.pullInProgress = true;
            this.currentPullProgress = 0;
            this.currentPullTotal = (this.autoPoolOptions.targetQueueSize - this.player.getQueueLength());

            for (let i = 0; i < this.currentPullTotal; i++) {
                let targetSource : ContentSource;
                if (this.autoPoolOptions.pullOrder === ContentSourceManager.AutoPullOrder.Random) {
                    //Pull randomly from each content source in the pool
                    targetSource = sourcePool[Math.floor(Math.random() * sourcePool.length)];
                } else if (this.autoPoolOptions.pullOrder === ContentSourceManager.AutoPullOrder.OneEach) {
                    //Pull one block from each source in order
                    targetSource = sourcePool[i % sourcePool.length];
                }
                 
                targetSource.poll().then((block) => {
                    this.player.enqueueBlock(block);
                    this.partialPoll();
                }).catch(error => {
                    console.error('Failed to poll content source "' + targetSource.name + '"', error);
                    this.partialPoll();
                });
            }            
        }
    }

    setAutoPoolOptions(newOptions: ContentSourceManager.AutoPoolOptions) {
        if (!this.autoPoolOptions.enabled && newOptions.enabled) {
            //Switched auto pool on
            this.updateAutoPoolNow();
        }
        this.autoPoolOptions = newOptions;
        JSONSavable.serializeJSON(this, this.savePath);
        ControlPanelHandler.getInstance().sendAlert('setAutoPoolOptions', newOptions);
    }

    getAutoPoolOptions() {
        return this.autoPoolOptions;
    }

    setUseSourceForAuto(sourceId: string, useSource: boolean) {
        this.autoEnabledSources[sourceId] = useSource;
        JSONSavable.serializeJSON(this, this.savePath);
        ControlPanelHandler.getInstance().sendAlert('setAutoPoolList', this.getAutoSourcePool());
    }

    //Return all sources that are enabled in the auto pool
    getAutoSourcePool() : ContentSource[] {
        const enabledSources : ContentSource[] = [];
        Object.keys(this.autoEnabledSources).forEach(sourceId => {
            if (this.autoEnabledSources[sourceId]) {
                enabledSources.push(this.loadedSources[sourceId]);
            }
        });
        return enabledSources;
    }

    toJSON() : any {
        return {
            loadedSources: this.loadedSources, autoPoolOptions: this.autoPoolOptions,
            autoEnabledSources: this.autoEnabledSources
        };
    }

    deserialize(object: any, triggerChangeEvent = true): boolean {
        if (object.loadedSources && object.autoPoolOptions && object.autoEnabledSources) {
            this.autoPoolOptions = object.autoPoolOptions;

            //Clean up the autoEnabledSources list (if a source was deleted but not removed from this list, don't include it)
            let cleanedAutoEnabledSources : {[id: string] : boolean} = {};
            Object.keys(object.autoEnabledSources).forEach(sourceId => {
                if (object.loadedSources[sourceId]) {
                    cleanedAutoEnabledSources[sourceId] = object.autoEnabledSources[sourceId];
                }
            });
            this.autoEnabledSources = cleanedAutoEnabledSources;

            //Initialize a ContentSource class for each source
            for (let sourceId in object.loadedSources) {
                const sourceFromObj = object.loadedSources[sourceId];

                let source : ContentSource;
                switch (sourceFromObj.type) {
                    case 'LocalDirectory':
                        source = LocalDirectorySource.fromAny(sourceFromObj);
                        break;
                    default:
                        return false; //Unknown ContentSource type
                }

                if (source != null) {
                    this.addSource(source, sourceFromObj.id);
                } else {
                    return false; //Creating the ContentSource failed
                }
            }

            return true;
        } else {
            return false;
        }
    }

    //Control panel requests
    @ControlPanelRequest('pullFromContentSource', WSConnection.AcceptAny)
    private pullFromContentSourceRequest(data: any) { //Pull the next media object from a content source and queue it for playback
        if (data.sourceId == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No content source ID provided');
        }

        const targetSource = this.getSource(data.sourceId);
        if (targetSource == null) {
            return new WSConnection.ErrorResponse('InvalidID', 'No content source with the target ID');
        }

        return new Promise((resolve, reject) => {
            targetSource.poll().then((block) => {
                this.player.enqueueBlock(block);
                resolve(new WSConnection.SuccessResponse('Queued item from source ' + targetSource.name));
            }).catch((error) => {
                console.error('Pull from content source failed ', error);
                reject(new WSConnection.ErrorResponse('PullFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('newContentSource', WSConnection.AcceptAny)
    private newContentSourceRequest(data: any) {
        if (data.newSource == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No content source provided');
        }

        return new Promise((resolve, reject) => {
            this.createContentSourceFromRequest(data.newSource).then((source) => {
                this.addSource(source);
                resolve(new WSConnection.SuccessResponse('Created content source with ID ' + source.id));
            }).catch((error) => {
                reject(new WSConnection.ErrorResponse('CreateFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('deleteContentSource', WSConnection.AcceptAny)
    private deleteContentSourceRequest(data: any) {
        if (data.sourceId == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No source ID provided');
        }

        this.removeSource(data.sourceId);
        return new WSConnection.SuccessResponse('Removed source with ID ' + data.sourceId);
    }

    @ControlPanelRequest('updateContentSource', WSConnection.AcceptAny)
    private updateContentSourceRequest(data: any) {
        if (data.sourceId == null || data.newSource == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No source ID and source data provided');
        }

        return new Promise((resolve, reject) => {
            this.createContentSourceFromRequest(data.newSource).then((source) => {
                this.updateSource(data.sourceId, source);
                resolve(new WSConnection.SuccessResponse('Updated source with ID ' + data.sourceId));
            }).catch((error) => {
                reject(new WSConnection.ErrorResponse('UpdateFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('getContentSources')
    private getContentSourcesRequest() {
        return new WSConnection.SuccessResponse('Sources', this.getSources());
    }

    @ControlPanelRequest('getAutoPool')
    private getAutoPoolRequest() {
        return new WSConnection.SuccessResponse('AutoPool', {
            pool: this.getAutoSourcePool(),
            options: this.getAutoPoolOptions()
        });
    }

    @ControlPanelRequest('setAutoPoolOptions', ContentSourceManager.isAutoPoolOptions)
    private setAutoPoolRequest(newOptions: ContentSourceManager.AutoPoolOptions) {
        this.setAutoPoolOptions(newOptions);
        return new WSConnection.SuccessResponse('Set options');
    }

    private static isAutoPoolOptions(obj: any) : obj is ContentSourceManager.AutoPoolOptions {
        return (obj.enabled != null && obj.targetQueueSize != null && obj.pullOrder != null);
    }

    @ControlPanelRequest('setUseSourceInPool', WSConnection.AcceptAny)
    private useSourceInPoolRequest(data: any) {
        if (data.sourceId == null || data.enabled == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No source ID and enabled status provided');                         
        }

        this.setUseSourceForAuto(data.sourceId, data.enabled);
        return new WSConnection.SuccessResponse(`Set source to ${data.sourceId} to ${data.enabled}`);
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
                case 'YTChannel':
                    reject('Not yet implemented');
                    break;
                default:
                    reject("Unknown source type '" + requestedSource.type + "'");
            }
        });
    }
}

export namespace ContentSourceManager {
    export enum AutoPullOrder {
        Random = 'Random', OneEach = 'OneEach'
    }

    export class AutoPoolOptions {
        enabled: boolean = true;
        targetQueueSize: number = 10; //The auto pool will pull content blocks until the queue is at this size
        pullOrder : ContentSourceManager.AutoPullOrder = ContentSourceManager.AutoPullOrder.Random;
    }
}