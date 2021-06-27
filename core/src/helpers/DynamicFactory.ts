import { PublicRerunComponents } from "..";

type Constructor<T> = (rerunComponents: PublicRerunComponents) => T;
/**
 * A dynamic factory that maps strings to constructors of type T.
 * If a constructor matching a provided string is found, then that constructor is invoked and the resulting instance of T returned.
 * @remarks Allows plugins to register their own subclasses at runtime.
 */
export default class DynamicFactory<T> { 
    private constructorMap : {[typeAlias: string] : Constructor<T>} = {};

    constructor(private rerunComponents : PublicRerunComponents) {};

    /**
     * Add a new constructor to the factory.
     * @param alias Name the constructor will be referred to with
     * @param constructor Function returning an instance of type T
     */
    registerConstructor(alias: string, constructor: Constructor<T>) {
        this.constructorMap[alias] = constructor;
    }

    /**
     * Invoke the constructor that was registered with the provided alias (if one exists).
     * @param alias Alias for the registered constructor
     * 
     * @returns Instance of T provided by the constructor OR null if no constructor was found with the given alias
     */
    constructInstanceOf(alias: string) : T {
        let targetConstructor = this.constructorMap[alias];
        if (targetConstructor) {
            return targetConstructor(this.rerunComponents);
        } else {
            return null;
        }
    }

    /**
     * @returns List of all registered aliases
     */
    allKnownAliases() : string[] {
        return Object.keys(this.constructorMap);
    }

    /**
     * Check if a constructor is registered for the given alias.
     */
    isKnownAlias(alias: string) : boolean {
        return this.constructorMap[alias] != null;
    }
}