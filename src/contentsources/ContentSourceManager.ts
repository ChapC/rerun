import { ContentSource } from './ContentSource';

const uuidv4 = require('uuid/v4');

//... it manages content sources
export class ContentSourceManager {
    private loadedSources : {[id: string] : ContentSource} = {};
    
    addSource(source : ContentSource) : string {
        source.id = uuidv4();
        this.loadedSources[source.id] = source;
        return source.id;
    }

    removeSource(source : ContentSource) {
        delete this.loadedSources[source.id];
    }

    getSources() : ContentSource[] {
        return Object.values(this.loadedSources);
    }
}