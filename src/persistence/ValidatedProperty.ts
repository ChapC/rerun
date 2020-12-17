import { SingleListenable } from "../helpers/SingleListenable";
import DynamicFactory from "../helpers/DynamicFactory";
import { Tree } from "../helpers/Tree";
import ControlPanelHandler from "../networking/ControlPanelHandler";
import { WSConnection } from "../networking/WebsocketConnection";
import { ImmutableSaveableObject, ImmutableSaveableObjectWithConstructor, MutableSaveableObject, SaveableObject } from "./SaveableObject";
const uuidv4 = require('uuid/v4');

/**
 * Base class for a getter/setter with built-in value and type validation. 
 * Call trySetValue() with an `any` to attempt to set the property's value and getValue() to access it.
 * Changes are observable via SingleListenable methods.
 * 
 * @remarks Used when creating forms for the client-side (where a control is defined for each type of property) and for type-aware serialization.
 */
export abstract class ValidatedProperty<T> extends SingleListenable<T> {
    protected abstract readonly type: string;
    private value: T;
    private propertyLocked = false;

    constructor(public readonly name: string, defaultValue?: T) {
        super();
        this.value = defaultValue;
    }

    getType() : string {
        return this.type;
    }

    getValue() : T {
        return this.value;
    }

    /**
     * Attempt to set the value of the property.
     * @param triggerChangeEvent Should this change trigger any listeners on this property.
     * @returns Null if the value was accepted or an error string describing why it was rejected.
     */
    trySetValue(value: any, triggerChangeEvent = true) : null | string {
        if (this.propertyLocked) {
            return 'Property is immutable';
        };

        let v = value;
        if (value.name && value.value && value.type) { //TODO: Is this needed anymore?
            //This is a serialized FormProperty. Use the value from inside it
            v = value.value
        }

        try {
            const acceptedValue = this.acceptAny(v);
            this.value = acceptedValue;
            if (triggerChangeEvent) {
                this.triggerListeners(acceptedValue);
            }
            return null;
        } catch (ex) {
            if (ex instanceof Error) {
                if (ex.message) {
                    return 'Value rejected - ' + ex.message;
                } else {
                    return 'Value rejected';
                }
            } else {
                return 'Unknown error - ' + JSON.stringify(ex);
            }
        }
    }

    /**
     * Check if the ValidatedProperty will accept the given value. Does not modify the property. 
     */
    willAcceptValue(value: any) : boolean {
        let v = value;
        if (value.name && value.value && value.type) {
            //This is a serialized FormProperty. Use the value from inside it
            v = value.value
        }

        try {
            this.acceptAny(v);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Lock the property. No future calls to trySetValue will be accepted.
     */
    makeImmutable() : void {
        this.propertyLocked = true;
    }

    /**
     * Implemented by child classes.
     * 
     * Return the value to have it stored in the ValidatedProperty (you can modify it if you like!) or throw an Error() to reject the value.
     */
    protected abstract acceptAny(value: any) : T 

    /**
     * Reset this property's value to null.
     */
    protected clearValue() {
        this.value = null;
    }

    toJSON() : any {
        return { name: this.name, type: this.type, value: this.value };
    }

    static isInstance(obj: any) : obj is ValidatedProperty<any> {
        return ((typeof obj.name) === 'string' && obj.type != null);
    }
}

//Property types

/**
 * Property accepting a string.
 */
export class StringProperty extends ValidatedProperty<string> {
    readonly type: string = 'string';
    static type = 'string';

    protected acceptAny(value: any) : string {
        if ((typeof value) === 'string') {
            return value;
        } else {
            throw new Error('value was not a string');
        }
    }
}

/**
 * Property accepting integers only.
 */
export class IntegerProperty extends ValidatedProperty<number> {
    readonly type: string = 'int';

    protected acceptAny(value: any) : number {
        if ((typeof value) === 'number' && Number.isInteger(value)) {
            return value;
        } else {
            throw new Error('value was not a number');
        }
    }    
}

/**
 * Property accepting any kind of number.
 */
export class NumberProperty extends ValidatedProperty<number> {
    readonly type: string = 'number';

    protected acceptAny(value: any) : number {
        if ((typeof value) === 'number') {
            return value;
        } else {
            throw new Error('value was not a number');
        }
    }   
}

export class URLProperty extends StringProperty {
    private urlRegex = new RegExp(/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/);
    readonly type = 'url';

    protected acceptAny(value: any) : string {
        if (this.urlRegex.test(value)) {
            return value;            
        } else {
            throw new Error('value failed URL regex');
        }
    }    
}

/**
 * A property accepting a string if it is contained in a list of valid options. Like a dropdown menu.
 * 
 * You can use setOptions to set the list of valid strings or construct the property
 * with a string enum to allow any value in the enum.
 */
export class StringSelect extends StringProperty {
    static type = 'select-string'
    readonly type = StringSelect.type;

    private options : string[] = [];
    
    constructor(name: string, usingEnum?: {[enumKey: string] : string}, defaultValue?: string) {
        super(name, defaultValue);
        if (usingEnum) {
            //Check that every value of the enum object is a string and that the enum contains the default value
            let enumHasDefault = false;
            Object.values(usingEnum).forEach((value) => {
                if ((typeof value) === 'string') {
                    this.options.push(value as string);
                } else {
                    throw new Error("usingEnum must only contain string values");
                }

                if (value == defaultValue) {
                    enumHasDefault = true;
                }
            });

            if (defaultValue != null && !enumHasDefault) {
                throw new Error("The provided default string value is not included in the enum");
            }
        } else if (defaultValue != null) {
            //We know that options must at least contain the default value
            this.options.push(defaultValue);
        }
    }

    protected acceptAny(value: any) : string {
        let strValue = super.acceptAny(value);
        if (this.options.includes(strValue)) {
            return strValue;
        } else {
            throw new Error('value was not in the list of options');
        }
    }

    /**
     * Set the string options the user can choose from.
     * 
     * NOTE: If the property already has an option selected and the new set doesn't contain this value,
     * this method will throw an error unless clearCurrentValue is set to true.
     * @param options The list of strings that will be allowed values
     * @param clearCurrentValue Should the property's current value be cleared first? (default false)
     */
    setOptions(options: string[], clearCurrentValue = false) {
        if (clearCurrentValue) {
            this.clearValue();
        } else {
            if (!options.includes(this.getValue())) {
                throw new Error("The new options set does not contain the current value");
            }
        }

        this.options = options;
    }

    /**
     * Get the list of valid options this property will accept.
     */
    getOptions() : string[] {
        return this.options;
    }

    toJSON() : any {
        return {
            ...super.toJSON(),
            options: this.getOptions(),
        }
    }
}

export type SerializedObjWithAlias = { alias: string, obj: any };
/**
 * A property accepting any SaveableObject of a certain type using constructors from a DynamicFactory.
 * 
 * Users call trySetValue with an object of the following type:
 * 
 * {
 *  alias: string,
 *  obj: any
 * }
 * 
 * where `alias` is a type alias registered with the DynamicFactory
 * and `obj` is the data to be deserialized into the object the factory outputs.
 * 
 * Values are rejected if `alias` is unknown to the DynamicFactory or if deserialization of `obj` fails.
 */
export class SaveableFromFactorySelect<T extends SaveableObject> extends ValidatedProperty<T> {
    readonly type = 'select-saveablefromfactory';

    constructor(name: string, private factory: DynamicFactory<T>) {
        super(name);
    }

    /* This overload required because the TS compiler isn't smart enough to narrow generic types like it does with variables. 
    * Without the overload the compiler will complain that T isn't of the right type when we try to return the deserialized instance. 
    * We know that it actually *is* the right type because we run type guards against the instance returned by the factory (which is a T, so transitive property).
    */
    protected acceptAny(value: any) : T
    protected acceptAny(value: any) : any {
        if ((typeof value.alias) === "string" && value.obj != null) {
            
            if (!this.factory.isKnownAlias(value.alias)) return null;
            //Create an object using this alias' constructor
            let fromFactory: T = this.factory.constructInstanceOf(value.alias);

            //Fill newObject with the serialized data provided by the user (method varies depending on type of SaveableObject)
            if (ImmutableSaveableObject.isInstance(fromFactory)) {
                return fromFactory.deserializeToNew<ImmutableSaveableObject>(value.obj);
            } else if (ImmutableSaveableObjectWithConstructor.isInstance(fromFactory)) {
                //please forgive my type-safety transgressions, oh lord TS Compiler, I give my word that it will be okay
                return fromFactory.deserializeToNew<ImmutableSaveableObjectWithConstructor>(() => <any> this.factory.constructInstanceOf(value.alias), value.obj);
            } else if (MutableSaveableObject.isInstance(fromFactory)) {
                if (fromFactory.deserializeFrom(value.obj) === false) throw new Error('deserialization failed');
                return fromFactory;
            } else {
                throw new Error('unknown SaveableObject type');
            }

        } else {
            throw new Error('value was not a SerializedObjWithAlias'); //value wasn't a SerializedObjWithAlias
        }
    }

    /**
     * Returns the alias for and a default instance of every constructor registered with the factory.
     */
    getDefaultOptions() : SerializedObjWithAlias[] {
        let defaults: SerializedObjWithAlias[] = [];
        for (let alias of this.factory.allKnownAliases()) {
            let defaultInstance = this.factory.constructInstanceOf(alias);
            defaults.push({
                alias: alias,
                obj: defaultInstance
            });
        }
        return defaults;
    }

    toJSON() {
        return {
            ...super.toJSON(), options: this.getDefaultOptions()
        }
    }
}

export class IPAddress extends StringProperty {
    readonly type = 'ip';

    protected acceptAny(value: any) : string {
        let strValue = super.acceptAny(value);
        if (this.isIP(strValue)) {
            return strValue;
        } else {
            throw new Error('value is not a valid IP address');
        }
    }
    
    private ipRegex = new RegExp(/^((25[0-5]|(2[0-4]|1[0-9]|[1-9]|)[0-9])(\.(?!$)|$)){4}$/);
    isIP(ipString: any) {
        
        //Check that the string doesn't end with :
        if (ipString[ipString.length - 1] === ":") {
          return false;
        }
      
        let ipAndPort = ipString.split(":");
        //Check that the first half is a valid IP address
        if (!this.ipRegex.test(ipAndPort[0]) && ipAndPort[0] !== 'localhost') {
          return false;
        }
        //If there is a port, check that it's within the valid range
        if (ipAndPort[1]) {
          return ipAndPort[1] < 65535;
        } else {
          return true;
        }
    }
}

/**
 * Accepts a "/" separated path string that points to a node within a Tree.
 * 
 * The property will check whether a value is a valid path within the tree when trySetValue is called, 
 * but keep in mind if the tree is modified after this time the path may become invalid.
 */
export class TreePath extends StringProperty {
    readonly type = 'treepath';
    readonly id : string;

    constructor(name: string, readonly tree: Tree<any, any>) {
        super(name, null);
        this.id = uuidv4();
        ControlPanelHandler.getInstance().registerHandler(`property/treepath/${this.id}/node:get`, isString, (n: string) => this.getTreeNodeRequest(n));
    }

    //Control panels working with this property send requests to traverse the tree
    private getTreeNodeRequest(nodePath: string) : WSConnection.WSPendingResponse {
        let pathArray = nodePath.split('/').filter((el: string) => el.length > 0);
                
        let targetNode = this.tree.getNodeAtPath(pathArray);

        if (targetNode != null) {
            return new WSConnection.SuccessResponse(targetNode);
        } else {
            return new WSConnection.ErrorResponse('InvalidPath');
        }
    }

    getValueAsPathArray() : string[] {
        return this.strToPath(this.getValue());
    }

    private strToPath(value: string) : string[] {
        return value.split('/').filter((str: string) => str != "");
    }

    protected acceptAny(value: any) : string {
        let strValue = super.acceptAny(value);
        let pathArray = this.strToPath(strValue);
        //Verify that the provided path leads to a valid node
        if (this.tree.getNodeAtPath(pathArray) != null) {
            return strValue;
        } else {
            throw new Error('provided tree path was invalid')
        }
    }

    toJSON() {
        return {
            ...super.toJSON(), id: this.id
        }
    }
}

function isString(obj: any) : obj is string {
    return (typeof obj) === 'string';
}