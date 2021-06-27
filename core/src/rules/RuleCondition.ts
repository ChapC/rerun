import { ImmutableSaveableObjectWithConstructor } from "../persistence/SaveableObject";
import RuleAction from "./RuleAction";

export default abstract class RuleCondition extends ImmutableSaveableObjectWithConstructor {
    /**
     * Perform setup and switch on this condition. The linked RuleAction will begin to be triggered.
     * @param linkedAction The RuleAction to run when this condition is triggered
     */
    abstract enable(linkedAction: RuleAction) : void;
    
    /**
     * Switch off this condition. The linked RuleAction will no longer be triggered.
     */
    abstract disable() : void;
}