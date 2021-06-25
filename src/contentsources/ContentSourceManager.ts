import { ContentSource } from './ContentSource';
import { SingleListenable } from '../helpers/SingleListenable';
import { PlaybackNodeSnapshot, Player, PlayerEvent } from '../playback/Player'; 
import { IJSONSavable, JSONSavable } from '../persistence/JSONSavable';
import { LocalDirectorySource } from './LocalDirectorySource';
import ControlPanelHandler, { ControlPanelListener, ControlPanelRequest } from '../networking/ControlPanelHandler';
import { AcceptAny, WSConnection, WSErrorResponse, WSSuccessResponse } from '../networking/WebsocketConnection';

const uuidv4 = require('uuid/v4');

//... it manages content sources
@ControlPanelListener
export class ContentSourceManager extends SingleListenable<ContentSource[]> implements IJSONSavable {
    constructor(public savePath: string, private player : Player) {
        super();
        player.on(PlayerEvent.TreeChanged, (newTree) => this.onTreeChanged(newTree));

        ControlPanelHandler.getInstance().publish(this.AutoPoolOptionsChannel, this.autoPoolOptions);
        ControlPanelHandler.getInstance().publish(this.AutoPoolListChannel, this.getAutoSourcePool());
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
        this.onTreeChanged(this.player.getTreeSnapshot());
    }

    private partialPoll() {
        this.currentPullProgress++;
        if (this.currentPullProgress >= this.currentPullTotal) {
            this.pullInProgress = false;
        }
    }

    private depthFirstChildCount(root: PlaybackNodeSnapshot) : number {
        let n = 0;
        let node = root;
        while (node.children.length !== 0) {
            n++;
            node = node.children[0];
        }
        return n;
    }

    private onTreeChanged(newTree: PlaybackNodeSnapshot[]) {
        let newQueueLength = this.depthFirstChildCount(newTree[0]) + 1;
        if (this.autoPoolOptions.enabled && !this.pullInProgress && newQueueLength < this.autoPoolOptions.targetQueueSize) {
            const sourcePool = this.getAutoSourcePool();

            if (sourcePool.length === 0) {
                return;
            }

            this.pullInProgress = true;
            this.currentPullProgress = 0;
            this.currentPullTotal = (this.autoPoolOptions.targetQueueSize - newQueueLength);

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

    public readonly AutoPoolOptionsChannel = 'cs-auto-options';
    public readonly AutoPoolListChannel = 'cs-auto-list';

    setAutoPoolOptions(newOptions: ContentSourceManager.AutoPoolOptions) {
        if (!this.autoPoolOptions.enabled && newOptions.enabled) {
            //Switched auto pool on
            this.updateAutoPoolNow();
        }
        this.autoPoolOptions = newOptions;
        JSONSavable.serializeJSON(this, this.savePath);
        ControlPanelHandler.getInstance().publish(this.AutoPoolOptionsChannel, newOptions);
    }

    getAutoPoolOptions() {
        return this.autoPoolOptions;
    }

    setUseSourceForAuto(sourceId: string, useSource: boolean) {
        this.autoEnabledSources[sourceId] = useSource;
        JSONSavable.serializeJSON(this, this.savePath);
        ControlPanelHandler.getInstance().publish(this.AutoPoolListChannel, this.getAutoSourcePool());
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
    @ControlPanelRequest('pullFromContentSource', AcceptAny)
    private pullFromContentSourceRequest(data: any) { //Pull the next media object from a content source and queue it for playback
        if (data.sourceId == null) {
            return new WSErrorResponse('InvalidArguments', 'No content source ID provided');
        }

        const targetSource = this.getSource(data.sourceId);
        if (targetSource == null) {
            return new WSErrorResponse('InvalidID', 'No content source with the target ID');
        }

        return new Promise((resolve, reject) => {
            targetSource.poll().then((block) => {
                this.player.enqueueBlock(block);
                resolve(new WSSuccessResponse('Queued item from source ' + targetSource.name));
            }).catch((error) => {
                console.error('Pull from content source failed ', error);
                reject(new WSErrorResponse('PullFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('newContentSource', AcceptAny)
    private newContentSourceRequest(data: any) {
        if (data.newSource == null) {
            return new WSErrorResponse('InvalidArguments', 'No content source provided');
        }

        return new Promise((resolve, reject) => {
            this.createContentSourceFromRequest(data.newSource).then((source) => {
                this.addSource(source);
                resolve(new WSSuccessResponse('Created content source with ID ' + source.id));
            }).catch((error) => {
                reject(new WSErrorResponse('CreateFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('deleteContentSource', AcceptAny)
    private deleteContentSourceRequest(data: any) {
        if (data.sourceId == null) {
            return new WSErrorResponse('InvalidArguments', 'No source ID provided');
        }

        this.removeSource(data.sourceId);
        return new WSSuccessResponse('Removed source with ID ' + data.sourceId);
    }

    @ControlPanelRequest('updateContentSource', AcceptAny)
    private updateContentSourceRequest(data: any) {
        if (data.sourceId == null || data.newSource == null) {
            return new WSErrorResponse('InvalidArguments', 'No source ID and source data provided');
        }

        return new Promise((resolve, reject) => {
            this.createContentSourceFromRequest(data.newSource).then((source) => {
                this.updateSource(data.sourceId, source);
                resolve(new WSSuccessResponse('Updated source with ID ' + data.sourceId));
            }).catch((error) => {
                reject(new WSErrorResponse('UpdateFailed', JSON.stringify(error)));
            });
        });
    }

    @ControlPanelRequest('getContentSources')
    private getContentSourcesRequest() {
        return new WSSuccessResponse(this.getSources());
    }

    @ControlPanelRequest('getAutoPool')
    private getAutoPoolRequest() {
        return new WSSuccessResponse({
            pool: this.getAutoSourcePool(),
            options: this.getAutoPoolOptions()
        });
    }

    @ControlPanelRequest('setAutoPoolOptions', ContentSourceManager.isAutoPoolOptions)
    private setAutoPoolRequest(newOptions: ContentSourceManager.AutoPoolOptions) {
        this.setAutoPoolOptions(newOptions);
        return new WSSuccessResponse('Set options');
    }

    private static isAutoPoolOptions(obj: any) : obj is ContentSourceManager.AutoPoolOptions {
        return (obj.enabled != null && obj.targetQueueSize != null && obj.pullOrder != null);
    }

    @ControlPanelRequest('setUseSourceInPool', AcceptAny)
    private useSourceInPoolRequest(data: any) {
        if (data.sourceId == null || data.enabled == null) {
            return new WSErrorResponse('InvalidArguments', 'No source ID and enabled status provided');                         
        }

        this.setUseSourceForAuto(data.sourceId, data.enabled);
        return new WSSuccessResponse(`Set source to ${data.sourceId} to ${data.enabled}`);
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