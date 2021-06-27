import { ImmutableSaveableObjectWithConstructor } from "../persistence/SaveableObject";

export default abstract class RuleAction extends ImmutableSaveableObjectWithConstructor {
    abstract readonly actionId: string;
    abstract run() : void;
    
    /*
    In future, I'm considering allowing actions to accept variable parameters when triggered by conditions.
    For example, a ShowMessage action might accept a string parameter that could be produced by a NewSubscriber condition.
    That might be needlessly complex for this project though. We'll see.
    abstract getParametersContract() : Map<string (parameter name), string (ValidatedProperty type)>
    */
}