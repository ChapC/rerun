import { ContentSource } from './ContentSource';
import { SingleListenable } from '../helpers/SingleListenable';
import { Player } from '../playback/Player'; 
import { ContentBlock } from '../playback/ContentBlock';

const uuidv4 = require('uuid/v4');

//... it manages content sources
export class ContentSourceManager extends SingleListenable<ContentSource[]> {
    constructor(private player : Player) {
        super();
        player.on('queueChange', (newQueue) => this.onQueueChanged());
    };

    private loadedSources : {[id: string] : ContentSource} = {};
    
    addSource(source : ContentSource) : string {
        source.id = uuidv4();
        this.loadedSources[source.id] = source;

        //Listen for alerts from this source so they can be propagated to listeners here
        source.alerts.addChangeListener(this.sourceListChanged);

        //Sources are included in the auto pool by default
        this.autoSourceEnabled[source.id] = true;

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
    }

    //Automatic content pool
    private autoPoolOptions : ContentSourceManager.AutoPoolOptions = new ContentSourceManager.AutoPoolOptions(); 
    private autoSourceEnabled : {[sourceId: string] : boolean} = {};
    
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
    }

    getAutoPoolOptions() {
        return this.autoPoolOptions;
    }

    setUseSourceForAuto(sourceId: string, useSource: boolean) {
        this.autoSourceEnabled[sourceId] = useSource;
    }

    //Return all sources that are enabled in the auto pool
    getAutoSourcePool() : ContentSource[] {
        const enabledSources : ContentSource[] = [];
        Object.keys(this.autoSourceEnabled).forEach(sourceId => {
            if (this.autoSourceEnabled[sourceId]) {
                enabledSources.push(this.loadedSources[sourceId]);
            }
        });
        return enabledSources;
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