import { SingleListenable } from "../helpers/SingleListenable";
import SavablePropertyGroup from "./SavablePropertyGroup";
import SubTypeStore from "../helpers/SubTypeStore";
import { Tree } from "../helpers/Tree";
import ControlPanelHandler from "../ControlPanelHandler";
import { WSConnection } from "../helpers/WebsocketConnection";
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
            options: this.getOptions(),
            typeAliasFor: (<any>this).typeAliasFor //SavablePropertyGroup may assign the typeAliasFor property if required (see SavablePropertyGroup.scanForProperties())
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
    readonly id: string;
    constructor(name: string, readonly typeAlias: StringProperty, private fromTypeStore: SubTypeStore<T>) {
        super(name);
        this.id = uuidv4();
        ControlPanelHandler.getInstance().registerHandler(`property/subgroup/${this.id}/outline:get`, isString, (a) => this.getOutlineForAlias(a));
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

    //Control panels use this method to fetch the outline for a SubGroup when a different typeAlias is selected by the user.
    //eg. Fetching the event logic outline when the user changes the logicType property of a UserEvent.
    getOutlineForAlias(alias: string): WSConnection.WSPendingResponse {
        let targetType = this.fromTypeStore.getInstanceOf(alias);
        if (targetType != null) {
            return new WSConnection.SuccessResponse('Outline', targetType.getOutline());
        } else {
            return new WSConnection.ErrorResponse('InvalidAlias', `There is no type matching alias '${alias}'`);
        }
    }

    toJSON() {
        return {
            ...super.toJSON(), id: this.id
        }
    }

    static isInstance(obj: any) : obj is SubGroupProperty<any> {
        return (obj.acceptAny && obj.type === 'subgroup');
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
        ControlPanelHandler.getInstance().registerHandler(`property/treepath/${this.id}/node:get`, isString, (n: string) => this.getTreeNodeRequest(n));
    }

    //Control panels working with this property send requests to traverse the tree
    private getTreeNodeRequest(nodePath: string) : WSConnection.WSPendingResponse {
        let pathArray = nodePath.split('/').filter((el: string) => el.length > 0);
                
        let targetNode = this.tree.getNodeAtPath(pathArray);

        if (targetNode != null) {
            return new WSConnection.SuccessResponse('Found node', targetNode);
        } else {
            return new WSConnection.ErrorResponse('InvalidPath');
        }
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

function isString(obj: any) : obj is string {
    return (typeof obj) === 'string';
}