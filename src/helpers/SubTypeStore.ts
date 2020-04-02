import { RerunStateObject } from "..";

/**
 * A dynamic factory that maps strings to T constructors.
 * If a constructor matching a provided string is found, then that constructor is executed and the resulting instance of T returned.
 * @remarks Allows plugins to register their own subclasses at runtime.
 */

type Constructor<T> = (rerunState: RerunStateObject) => T;
export default class SubTypeStore<T> { 
    private constructorMap : {[typeAlias: string] : Constructor<T>} = {};

    constructor(private rerunState : RerunStateObject) {};

    registerSubtype(alias: string, constructor: Constructor<T>) {
        this.constructorMap[alias] = constructor;
    }

    getInstanceOf(alias: string) : T {
        let targetConstructor = this.constructorMap[alias];
        if (targetConstructor) {
            return targetConstructor(this.rerunState);
        } else {
            return null;
        }
    }

    allKnownTypes() : string[] {
        return Object.keys(this.constructorMap);
    }

    isKnownType(alias: string) : boolean {
        return this.constructorMap[alias] != null;
    }
}