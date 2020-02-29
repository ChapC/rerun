import { IJSONSavable, JSONSavable } from "./JSONSavable";
import { FormProperty } from "./FormProperty";

export default abstract class JSONSavableForm implements IJSONSavable {
    constructor(public savePath: string) {}

    protected saveOnChange() : void {
        //Add a change listener for every FormProperty on the object
        this.scanForProperties().forEach(f => {
            f.prop.addChangeListener(() => JSONSavable.serializeJSON(this, this.savePath).catch(error => console.error('Error saving form to JSON', error)));
        });
    }

    setFormProperty(propertyName: string, value: any) : void {
        if (this[propertyName] instanceof FormProperty) {
            const property = this[propertyName] as FormProperty<any>;
            if (!property.trySetValue(value)) {
                throw new Error("Invalid value");
            }
        } else {
            throw new Error("No form property '" + propertyName + "'");
        }
    };

    deserialize(object: any, suppressChangeEvent = false) : boolean {
        const allValuesCopied : boolean[] = [];

        //Try to find a value for each FormProperty on the object
        this.scanForProperties().forEach(keyPropPair => {
            //Look for the key on the serialized object
            const serializedValue = this.getValueFor(keyPropPair.key, object); 
            //Nested FormProperty objects returned from scanForProperties are stored with keys like "nestedForm.nestedValue1",
            //but the actual serialized object stores them normally, as {nestedForm: {nestedValue1: theProperty}}. 
            //getValueFor() accepts the former and returns the latter (if it exists).
            if (serializedValue) {
                allValuesCopied.push(keyPropPair.prop.trySetValue(serializedValue, suppressChangeEvent));
            } else {
                allValuesCopied.push(false);
            }
        });
        
        return allValuesCopied.every((accepted) => accepted);
    }

    //Recursively scans this object for FormProperty objects
    private scanForProperties() : KeyFormProperty[] {
        const formProps : KeyFormProperty[] = [];
        for (const key of Object.keys(this)) {
            if (this[key] instanceof FormProperty) {
                const property = this[key] as FormProperty<any>;
                formProps.push(new KeyFormProperty(key, property));
            } else if (this[key] instanceof JSONSavableForm) {
                //Grab all the properties from the nested form
                const subForm = this[key] as JSONSavableForm;
                subForm.scanForProperties().forEach(nestedKeyPropPair => {
                    //Nested form keys have the key of their form prefixed to them (eg. "myNestedForm.propertyKey")
                    formProps.push(new KeyFormProperty(key + nestedKeyPropPair.key, nestedKeyPropPair.prop));
                });
            }
        }
        return formProps;
    }

    //Like object["key"] but supports nested objects (eg. object["key.this.that"])
    private getValueFor(keyString: string, obj: any) : any {
        let targetValue = obj;
      
        try {
            keyString.split(".").forEach(subKey => {
              targetValue = targetValue[subKey];
            });
        } catch {
            return undefined;
        }

        return targetValue;
      }
      

    //Makes Typescript allow us to index the object
    [string : string] : any;

    toJSON() : any {
        let obj = Object.assign({}, this);
        delete obj['savePath'];
        return obj;
    }
}

class KeyFormProperty {
    constructor(public key: string, public prop: FormProperty<any>) {};
}
