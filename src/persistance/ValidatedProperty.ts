import { SingleListenable } from "../helpers/SingleListenable";
import SavablePropertyGroup from "./SavablePropertyGroup";
import SubTypeStore from "../helpers/SubTypeStore";
import { Tree } from "../helpers/Tree";
const uuidv4 = require('uuid/v4');

/**
 * Base class for a getter/setter with built-in value and type validation. 
 * Call trySetValue() with an any to attempt to set the property's value and getValue() to access it.
 * Changes are observable via the SingleListenable extension.
 * 
 * @remarks Used when creating forms for the client-side (where a control is defined for each type of property) and for type-aware serialization.
 */
export abstract class ValidatedProperty<T> extends SingleListenable<T> {
    protected type: string;
    private value: T;

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

    hasValue() : boolean {
        return this.value != null;
    }

    trySetValue(value: any, triggerChangeEvent = true) : boolean {
        let v = value;
        if (value.name && value.value && value.type) {
            //This is a serialized FormProperty. Use the value from inside it
            v = value.value
        }

        const acceptedValue = this.acceptAny(v);
        if (acceptedValue != null) {
            this.value = acceptedValue;
            if (triggerChangeEvent) {
                this.triggerListeners(acceptedValue);
            }
            return true;
        }
        return false;
    }

    protected abstract acceptAny(value: any) : T 

    toJSON() : any {
        return { name: this.name, type: this.type, value: this.value };
    }
}

//Property types
export class StringProperty extends ValidatedProperty<string> {
    type = 'string';
    static type = 'string';

    protected acceptAny(value: any) : string {
        if ((typeof value) === 'string') {
            return value;
        } else {
            return null;
        }
    }
}

/**
 * Property accepting integers only.
 */
export class IntegerProperty extends ValidatedProperty<number> {
    type = 'int';

    protected acceptAny(value: any) : number {
        if ((typeof value) === 'number' && Number.isInteger(value)) {
            return value;
        } else {
            return null;
        }
    }    
}

/**
 * Property accepting any kind of number.
 */
export class NumberProperty extends ValidatedProperty<number> {
    type = 'number';

    protected acceptAny(value: any) : number {
        if ((typeof value) === 'number') {
            return value;
        } else {
            return null;
        }
    }   
}

export class URLProperty extends ValidatedProperty<string> {
    private urlRegex = new RegExp(/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/);
    type = 'url';

    protected acceptAny(value: any) : string {
        if (this.urlRegex.test(value)) {
            return value;            
        } else {
            return null;
        }
    }    
}

//A string from a list of valid options
export class StringSelectProperty extends StringProperty {
    static type = 'select-string'
    type = StringSelectProperty.type;

    private options : string[] = [];
    
    constructor(name: string, usingEnum?: {[enumKey: string] : string}, defaultValue?: string) {
        super(name, defaultValue);
        if (usingEnum) {
            //Check that every value of the enum object is a string
            Object.values(usingEnum).forEach((value) => {
                if ((typeof value) === 'string') {
                    this.options.push(value as string);
                } else {
                    throw new Error("usingEnum must only contain string values.");
                }
            });
        }
    }

    protected acceptAny(value: any) : string {
        //Check if it's a string
        if ((typeof value) === 'string') {
            if (this.options.includes(value)) {
                return value;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    setOptions(options: string[]) {
        this.options = options;
    }

    getOptions() : string[] {
        return this.options;
    }

    toJSON() : any {
        return {
            ...super.toJSON(),
            options: this.getOptions()
        }
    }
}

/**
 * Stores a SavablePropertyGroup and allows setting of the whole object at once.
 * 
 * @remarks Allows SavablePropertyGroups to be nested within another. See SubTypeStore for details.
 */
export class SubGroupProperty<T extends SavablePropertyGroup> extends ValidatedProperty<T> {
    type = 'subgroup';
    constructor(name: string, private typeAlias: StringProperty, private fromTypeStore: SubTypeStore<T>) {
        super(name);
    }

    acceptAny(value: any) : T {
        let targetType = this.fromTypeStore.getInstanceOf(this.typeAlias.getValue());
        if (targetType != null) {
            if (targetType.deserialize(value)) {
                return targetType;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }
}

export class IPAddressProperty extends ValidatedProperty<string> {
    type = 'ip';

    protected acceptAny(value: any) : string {
        if ((typeof value) === 'string' && this.isIP(value)) {
            return value;
        } else {
            return null;
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
 * Accepts a "/" separated path string that points to a node within a tree.
 */
export class TreePathProperty extends ValidatedProperty<string> {
    type = 'treepath';
    readonly id : string;

    constructor(name: string, readonly tree: Tree<any, any>) {
        super(name, '');
        this.id = uuidv4();
        TreePathStore.registerTreePathProperty(this);
    }

    protected acceptAny(value: any) : string {
        if ((typeof value === 'string')) {
            let pathArray = value.split('/').filter((str: string) => str != "");
            //Verify that the provided path leads to a valid node
            if (this.tree.getNodeAtPath(pathArray) != null) {
                return value;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    toJSON() {
        return {
            ...super.toJSON(), id: this.id
        }
    }
}

//TODO: This must be replaced when ControlPanelHandler is redided in a gooder way
export class TreePathStore {
    private static instance: TreePathStore;

    static getInstance() : TreePathStore {
        if (this.instance == null) {
            this.instance = new TreePathStore();
        }
        return this.instance;
    }
    private constructor() {};

    private static registeredProperties : {[id: string] : TreePathProperty} = {};

    static registerTreePathProperty(p : TreePathProperty) {
        this.registeredProperties[p.id] = p;
    }

    //Handles an incoming request from a client
    static getTreeNodeFor(propertyId: string, nodePath: string[]) {
        let targetProperty = this.registeredProperties[propertyId];
        if (targetProperty != null) {
            return targetProperty.tree.getNodeAtPath(nodePath);
        } else {
            return null;
        }
    }
}