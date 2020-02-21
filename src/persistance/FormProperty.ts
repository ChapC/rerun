import { SingleListenable } from "../helpers/SingleListenable";

//Used to send form properties to the client and validate their return values
export abstract class FormProperty<T> extends SingleListenable<T> {
    protected type: string;
    protected value: T;

    constructor(protected name: string, defaultValue?: T) {
        super();
        this.value = defaultValue;
    }

    getType() : string {
        return this.type;
    }

    getValue() : T {
        return this.value;
    }

    trySetValue(value: any) : boolean {
        let v = value;
        if (value.type && value.value) {
            //This is a serialized FormProperty. Use the value from inside it
            v = value.value
        }

        const acceptedValue = this.acceptAny(v);
        if (acceptedValue != null) {
            this.triggerListeners(acceptedValue);
            return true;
        }
        return false;
    }

    protected abstract acceptAny(value: any) : T 

    toJSON() : any {
        return {name: this.name, type: this.type, value: this.value};
    }
}

//Property types
export class StringFormProperty extends FormProperty<string> {
    type = 'string';

    acceptAny(value: any) : string {
        if ((typeof value) === 'string') {
            this.value = value;
            return value;
        } else {
            return null;
        }
    }
}

export class NumberFormProperty extends FormProperty<number> {
    type = 'number';

    acceptAny(value: any) : number {
        if (!isNaN(value)) {
            this.value = value;
            return this.value;
        } else {
            return null;
        }
    }    
}

export class URLFormProperty extends FormProperty<string> {
    private urlRegex = new RegExp(/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/);
    type = 'url';

    acceptAny(value: any) : string {
        if (this.urlRegex.test(value)) {
            this.value = value;
            return value;            
        } else {
            return null;
        }
    }    
}

export class IPAddressFormProperty extends FormProperty<string> {
    type = 'ip';

    acceptAny(value: any) : string {
        if ((typeof value) === 'string' && this.isIP(value)) {
            this.value = value;
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
