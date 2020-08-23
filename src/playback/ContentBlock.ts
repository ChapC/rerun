import {MediaObject} from './MediaObject';

//A MediaObject with additional playback-related information, ready to be added to the play queue
export class ContentBlock {
    id:string;
    colour:string = '#282482';
    media:MediaObject;
    mediaStatus: MediaObject.Status = MediaObject.Status.UNTRACKED;
    //TODO: Add playback modifiers here (start/end trimming)

    //ContentBlocks can have in and out transition times for fades/animations
    transitionInMs = 0;
    transitionOutMs = 0;

    constructor(id:string, media:MediaObject) {
        this.id = id;
        this.media = media;
    }

    toJSON() : any {
        return {
            id: this.id, colour: this.colour, media: this.media, 
            mediaStatus: this.media.location.getStatus()
        }
    }

    static clone(source: ContentBlock, destination?: ContentBlock) : ContentBlock {
        let c = destination;
        if (!destination) {
            c = new ContentBlock(source.id, source.media);
        } else {
            c.id = source.id;
            c.media = source.media;
        }
        c.colour = source.colour;
        c.mediaStatus = source.mediaStatus;
        c.transitionInMs = source.transitionInMs;
        c.transitionOutMs = source.transitionOutMs;
        return c;
    }
}