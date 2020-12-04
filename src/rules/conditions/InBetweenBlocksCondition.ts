import RuleAction from "../RuleAction";
import RuleCondition from "../RuleCondition";

/**
 * Trigger the event after the end of every nth block. 
 * If matched with a ShowGraphic or PlayBlock action, it will play the block as an interstitial.
 */
export default class InBetweenBlocksCondition extends RuleCondition {
    enable(linkedAction: RuleAction): void {
        throw new Error("Method not implemented.");
    }
    disable(): void {
        throw new Error("Method not implemented.");
    }

}