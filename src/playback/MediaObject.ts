//References a piece of media that can be shown on-screen (eg. mp4, downloaded YT video, RMTP stream).
export class MediaObject {
    name:string;
    location:MediaObject.Location
    type: MediaObject.MediaType;
    durationMs: number;

    constructor(type: MediaObject.MediaType, name:string, location:MediaObject.Location, durationMs: number) {
        this.type = type;
        this.name = name;
        this.location = location;
        this.durationMs = durationMs;
    }

    static CreateEmpty(type: MediaObject.MediaType) : MediaObject {
        return new MediaObject(type, 'Unnamed', null, null);
    }

    isSame(other: MediaObject) : boolean {
        return (
            this.name === other.name && this.type === other.type && this.durationMs === other.durationMs 
            && this.preRollMs === other.preRollMs && this.location.getPath() === other.location.getPath() 
            && this.location.getType() === other.location.getType()
        );
    }

    thumbnail:string = null;
    preRollMs: number;
}

export namespace MediaObject {
    export enum Status { READY = 'Ready', PENDING = 'Pending', OFFLINE = 'Offline', UNTRACKED = 'Untracked' };

    export enum MediaType {
        LocalVideoFile = 'Local video file',
        YouTubeVideo = 'Youtube video',
        RTMPStream = 'RTMP stream',
        RerunGraphic = 'Rerun graphic'
    }

    export enum ContentType {
        LocalFile = 'LocalFile',
        WebStream = 'WebStream',
        RTMP = 'RTMP',
        GraphicsLayer = 'GraphicsLayer'
    }

    export abstract class Location {
        abstract getType() : ContentType;
        abstract getPath() : string;
        abstract getStatus() : MediaObject.Status; //Is the MediaObject available right now?

        toJSON() : any {
            return {
                contentType: this.getType(), path: this.getPath()
            };
        }
    }
}