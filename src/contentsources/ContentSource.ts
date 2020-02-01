import { ContentBlock } from "../playback/ContentBlock";

//A source that can be polled for content blocks on demand
export abstract class ContentSource {
    constructor(public name: string) {}

    abstract poll(shuffle?:boolean) : Promise<ContentBlock>;
    abstract refresh() : Promise<void>; //Reset the source's pool of ContentBlocks (if it has a pool)
}