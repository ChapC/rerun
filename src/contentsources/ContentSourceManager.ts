import { ContentSource } from './ContentSource';
import { SingleListenable } from '../helpers/SingleListenable';
import { Player } from '../playback/Player'; 
import { IJSONSavable, JSONSavable } from '../persistance/JSONSavable';
import { LocalDirectorySource } from './LocalDirectorySource';

const uuidv4 = require('uuid/v4');

//... it manages content sources
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
    }

    getAutoPoolOptions() {
        return this.autoPoolOptions;
    }

    setUseSourceForAuto(sourceId: string, useSource: boolean) {
        this.autoEnabledSources[sourceId] = useSource;
        JSONSavable.serializeJSON(this, this.savePath);
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