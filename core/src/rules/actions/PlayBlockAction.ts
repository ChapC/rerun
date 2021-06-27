import { ContentBlock } from "../../playback/ContentBlock";
import { Player } from "../../playback/Player";
import RuleAction from "../RuleAction";

// A generic 'Play a block' action. Would be cool, but MediaObjects will need to be upgraded to use SaveableObject first I think
export default class PlayBlockAction extends RuleAction {
    readonly actionId = 'playblock';
    constructor(private player: Player) { super(); }

    run(): void {
        throw new Error("Method not implemented.");
    }

    getContentBlock() : ContentBlock {
        return this.graphicContentBlock;
    }

    static isInstance(obj: any) : obj is PlayBlockAction {
        return obj.actionId === 'playblock';
    }
}