import { MediaObject } from './MediaObject';
import { WebVideoDownloader } from '../WebVideoDownloader';
import { GraphicLayerReference } from '../graphiclayers/GraphicManager';

export class LocalFileLocation extends MediaObject.Location {
    getType() {return MediaObject.ContentType.LocalFile};

    constructor(private filePath: string) {
        super();
    }
    
    getPath(): string {
        return this.filePath;
    }

    getStatus(): MediaObject.Status {
        return MediaObject.Status.UNTRACKED;
    }    
}

export class GraphicsLayerLocation extends MediaObject.Location {
    getType() {return MediaObject.ContentType.GraphicsLayer};

    constructor(private layer: GraphicLayerReference) {
        super();
    }

    getLayerRef() {
        return this.layer;
    }

    getPath(): string {
        return this.layer.toString();
    }

    getStatus(): MediaObject.Status {
        return MediaObject.Status.UNTRACKED;
    }    
}

export class WebStreamLocation extends MediaObject.Location {
    getType() {return MediaObject.ContentType.WebStream};

    constructor(private url: string) {
        super();
    }

    getPath(): string {
        return this.url;
    }

    getStatus(): MediaObject.Status {
        return MediaObject.Status.UNTRACKED;
    }    
}

//Starts as a web stream, tries to download it, and turns into a local file on completion
export class WebBufferLocation extends MediaObject.Location {
    getType() {
        if (this.download.getProgress() === 100) {
            return MediaObject.ContentType.LocalFile;
        } else {
            return MediaObject.ContentType.WebStream;
        }
    };

    constructor(private url: string, private download: WebVideoDownloader.DownloadJob) {
        super();
    }

    getPath(): string {
        if (this.download.getProgress() === 100) {
            return this.download.getLocalPath();
        } else {
            return this.url;
        }
    }

    getLocalPath() : string {
        return this.download.getLocalPath();
    }

    getStatus(): MediaObject.Status {
        const currentProgress = this.download.getProgress();
        if (currentProgress === 100) {
            return MediaObject.Status.READY;
        } else if (currentProgress === -1) {
            return MediaObject.Status.OFFLINE;
        } else if (currentProgress === 0) {
            return MediaObject.Status.UNTRACKED;
        } else {
            return MediaObject.Status.PENDING;
        }
    }        
}