import { ContentBlock } from "../playback/ContentBlock";
import { AlertContainer } from "../helpers/AlertContainer";

//A source that can be polled for content blocks on demand
export abstract class ContentSource {
    abstract type : string;
    id : string;
    readonly alerts: AlertContainer = new AlertContainer();
    constructor(public name: string) {}

    abstract poll() : Promise<ContentBlock>;
    abstract refresh() : Promise<void>; //Reset the source's pool of ContentBlocks (if it has a pool)
    abstract asJSON() : any;
    abstract fromAny(object: any) : ContentSource; //This should be an effectively static method -_-

    static superFromAny(object: any, child: ContentSource) : boolean {
        if (object.type && object.id && object.name) {
            child.type = object.type;
            child.id = object.id;
            child.name = object.name;
            return true;
        } else {
            return false;
        }
    }

    toJSON() : any {
        return {
            id: this.id, type: this.type, name: this.name, alerts: this.alerts,
            ...this.asJSON()
        }
    }
}