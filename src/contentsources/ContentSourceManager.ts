import { ContentSource } from './ContentSource';
import { SingleListenable } from '../helpers/SingleListenable';

const uuidv4 = require('uuid/v4');

//... it manages content sources
export class ContentSourceManager extends SingleListenable<ContentSource[]> {
    private loadedSources : {[id: string] : ContentSource} = {};
    
    addSource(source : ContentSource) : string {
        source.id = uuidv4();
        this.loadedSources[source.id] = source;

        //Listen for alerts from this source so they can be propagated to listeners here
        source.alerts.addChangeListener(this.sourceListChanged);

        this.sourceListChanged();
        return source.id;
    }

    updateSource(sourceId: string, source: ContentSource) {
        this.loadedSources[sourceId] = source;
        source.alerts.addChangeListener(this.sourceListChanged);
        this.sourceListChanged();
    }

    removeSource(source : ContentSource) {
        delete this.loadedSources[source.id];
        this.sourceListChanged();
    }

    getSources() : ContentSource[] {
        return Object.values(this.loadedSources);
    }

    private sourceListChanged = () => {
        this.triggerListeners(Object.values(this.loadedSources));
    }
}