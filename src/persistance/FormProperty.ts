import { SingleListenable } from "../helpers/SingleListenable";
import JSONSavableForm from "./JSONSavableForm";
import SubTypeStore from "../helpers/SubTypeStore";

//Used to send form properties to the client and validate their return values
export abstract class FormProperty<T> extends SingleListenable<T> {
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
export class StringFormProperty extends FormProperty<string> {
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
export class IntegerFormProperty extends FormProperty<number> {
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
export class NumberFormProperty extends FormProperty<number> {
    type = 'number';

    protected acceptAny(value: any) : number {
        if ((typeof value) === 'number') {
            return value;
        } else {
            return null;
        }
    }   
}

export class URLFormProperty extends FormProperty<string> {
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
export class StringSelectFormProperty extends StringFormProperty {
    static type = 'select-string'
    type = StringSelectFormProperty.type;

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
 * Works with an alias from a StringFormProperty to store one instance of T from a SubTypeStore.
 */
export class SubFormProperty<T extends JSONSavableForm> extends FormProperty<T> {
    type = 'subform';
    constructor(name: string, private typeAlias: StringFormProperty, private fromTypeStore: SubTypeStore<T>) {
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

export class IPAddressFormProperty extends FormProperty<string> {
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