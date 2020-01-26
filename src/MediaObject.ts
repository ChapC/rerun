//References a piece of media that can be shown on-screen (eg. mp4, downloaded YT video, RMTP stream).
export class MediaObject {
    name:string;
    location:MediaObject.Location
    type: MediaObject.Type;
    durationMs: number;

    constructor(type: MediaObject.Type, name:string, location:MediaObject.Location, durationMs: number) {
        this.type = type;
        this.name = name;
        this.location = location;
        this.durationMs = durationMs;
    }

    thumbnail:string = null;
}

export namespace MediaObject {
    export enum Status { READY = 'Ready', PENDING = 'Pending', OFFLINE = 'Offline', UNTRACKED = 'Untracked' };

    export enum Type {
        LocalVideoFile = 'Local video file',
        YouTubeVideo = 'Youtube video',
        RTMPStream = 'RTMP stream',
        RerunTitle = 'Rerun title graphic'
    }

    export class Location {
        type: Location.Type;
        constructor(type: Location.Type, public path:string, public altPath?:string) {
            this.type = type;
        }
    }

    export namespace Location {
        export enum Type { //NOTE: I think the download buffer could be implemnented by changing location path to a getPath() function and making Location an interface (BasicLocation, BufferedDownloadLoation)
            WebURL = "Web stream", LocalURL = "On disk", BufferedVideo = "Download buffer"
        }
    }
}