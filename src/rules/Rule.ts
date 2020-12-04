import DynamicFactory from "../helpers/DynamicFactory";
import { ImmutableSaveableObjectWithConstructor, SaveableProperty } from "../persistence/SaveableObject";
import { SaveableFromFactorySelect } from "../persistence/ValidatedProperty";
import RuleAction from "./RuleAction";
import RuleCondition from "./RuleCondition";

export default class Rule extends ImmutableSaveableObjectWithConstructor {
    @SaveableProperty()
    readonly condition = new SaveableFromFactorySelect('Condition', this.conditionsFactory);
    @SaveableProperty()
    readonly action = new SaveableFromFactorySelect('Action', this.actionsFactory);

    constructor(private conditionsFactory: DynamicFactory<RuleCondition>, private actionsFactory: DynamicFactory<RuleAction>) { super(); };
}