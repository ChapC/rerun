import {MediaObject} from './MediaObject';
const uuidv4 = require('uuid/v4');

//TODO: Migrate to ImmutableSaveableObject
//A MediaObject with additional playback-related information, ready to be added to the play queue
export class ContentBlock {
    id:string;
    colour:string = '#282482';
    media:MediaObject;
    mediaStatus: MediaObject.Status = MediaObject.Status.UNTRACKED;
    //TODO: Add playback modifiers here (start/end trimming, transformations)

    //ContentBlocks can have in and out transition times for fades/animations
    transitionInMs = 0;
    transitionOutMs = 0;

    /**
     * @param media The MediaObject this block will play
     * @param id (Optional) The ID to give this ContentBlock. By default a random unique ID will be generated.
     */
    constructor(media:MediaObject, id?:string) {
        if (id) {
            this.id = id;
        } else {
            this.id = uuidv4();
        }
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
            c = new ContentBlock(source.media, source.id);
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