//References a piece of media that can be shown on-screen (eg. mp4, downloaded YT video, RMTP stream).
export class MediaObject {
    name:string;
    location:MediaObject.Location
    type: MediaObject.MediaType;
    durationMs: number; //A value of -1 indicates an infinite duration, like a graphic or live stream

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
            other != null && this.name === other.name && this.type === other.type && this.durationMs === other.durationMs && this.location.getPath() === other.location.getPath() 
            && this.location.getType() === other.location.getType()
        );
    }

    thumbnail:string = null;}

export namespace MediaObject {
    export enum Status { READY = 'Ready', PENDING = 'Pending', OFFLINE = 'Offline', UNTRACKED = 'Untracked' };

    export enum MediaType {
        LocalVideoFile = 'Local video file',
        YouTubeVideo = 'Youtube video',
        RTMPStream = 'RTMP stream',
        RerunGraphic = 'Rerun graphic'
    }
    //TODO: This MediaType/ContentType thing is lUDiCrOUs! There has to be an easier way!
    //It's a bit tricky because the Location (and therefore ContentType) of a MediaObject can change because of how Youtube videos
    //are downloaded. Maybe that should be handled differently so that a MediaObject is immutable and the ContentBlock gets updated? 
    //Or perhaps MediaType should simply be renamed MediaSource and only be responsible for indicating where it originated from (eg. MT.LocalVideoFile becomes LocalFile and CT.LocalFile becomes LocalVideo/AudioFile)?
    //Probably the first one.
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