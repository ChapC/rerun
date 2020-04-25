import { IJSONSavable, JSONSavable } from "./JSONSavable";
import { ValidatedProperty, StringSelectProperty } from "./ValidatedProperty";

export default abstract class SavablePropertyGroup implements IJSONSavable {
    constructor(public savePath: string) { }

    protected saveOnChange(): void {
        //Add a change listener for every FormProperty on the object
        this.scanForProperties().forEach(f => {
            f.prop.addChangeListener(() => JSONSavable.serializeJSON(this, this.savePath).catch(error => console.error('Error saving form to JSON', error)));
        });
    }

    setFormProperty(propertyName: string, value: any): void {
        if (this[propertyName] instanceof ValidatedProperty) {
            const property = this[propertyName] as ValidatedProperty<any>;
            if (!property.trySetValue(value)) {
                throw new Error("Invalid value");
            }
        } else {
            throw new Error("No form property '" + propertyName + "'");
        }
    };

    deserialize(object: any, triggerChangeEvent = true): boolean {
        const allValuesCopied: boolean[] = [];

        //Try to find a value for each FormProperty on the object
        this.scanForProperties().forEach(keyPropPair => {
            //Look for the key on the serialized object
            const serializedValue = this.getValueAt(keyPropPair.key, object);
            //Nested FormProperty objects returned from scanForProperties are stored with keys like "nestedForm.nestedValue1",
            //but the actual serialized object stores them normally, as {nestedForm: {nestedValue1: theProperty}}. 
            //getValueFor() accepts the former and returns the latter (if it exists).
            if (serializedValue) {
                allValuesCopied.push(keyPropPair.prop.trySetValue(serializedValue, triggerChangeEvent));
            } else {
                allValuesCopied.push(false);
            }
        });

        const worked = allValuesCopied.every((accepted) => accepted);
        return worked;
    }


    //Returns a JSON object that contains all the object's keys and the FormProperty type of each of them
    //Used to create an object from scratch.
    getOutline() : any {
        const outline: { [key: string]: string } = {};
        this.scanForProperties().forEach(keyPropPair => {
            let propOutline : any = keyPropPair.prop.toJSON();

            propOutline.propertyType = keyPropPair.prop.getType();
            propOutline.name = keyPropPair.prop.name;
            
            /*
            if (keyPropPair.prop.getType() === 'select-string') {
                //Outlines for select properties should include the available options
                propOutline.options = (<StringSelectProperty>keyPropPair.prop).getOptions();
            }
            */
            this.setValueAt(keyPropPair.key, propOutline, outline);
        });
        return outline;
    }

    //Recursively scans this object for FormProperty objects
    private scanForProperties(): KeyFormProperty[] {
        const formProps: KeyFormProperty[] = [];
        for (const key of Object.keys(this)) {
            if (this[key] instanceof ValidatedProperty) {
                const property = this[key] as ValidatedProperty<any>;
                formProps.push(new KeyFormProperty(key, property));
            } else if (this[key] instanceof SavablePropertyGroup) {
                //Grab all the properties from the nested form
                const subForm = this[key] as SavablePropertyGroup;
                subForm.scanForProperties().forEach(nestedKeyPropPair => {
                    //Nested form keys have the key of their form prefixed to them (eg. "myNestedForm.propertyKey")
                    formProps.push(new KeyFormProperty(key + nestedKeyPropPair.key, nestedKeyPropPair.prop));
                });
            }
        }
        return formProps;
    }

    //Like object["key"] but supports nested objects (eg. object["key.this.that"])
    private getValueAt(keyString: string, targetObject: any): any {
        let targetValue = targetObject;

        try {
            keyString.split(".").forEach(subKey => {
                targetValue = targetValue[subKey];
            });
        } catch {
            return undefined;
        }

        return targetValue;
    }

    //getValueAt() but for setting stuff
    private setValueAt(keyString: string, value: any, targetObject: any) {
        let targetValue = targetObject;
        const keySplit = keyString.split(".");

        //Create all the keys up to the value
        for (let i = 0; i < keySplit.length - 1; i++) {
            let subKey = keySplit[i];
            if (!targetValue[subKey]) {
                //Create this key if it doesn't exist
                targetValue[subKey] = {};
            }
            targetValue = targetValue[subKey];
        }

        //Set the actual value
        targetValue[keySplit[keySplit.length - 1]] = value;
    }


    //Makes Typescript allow us to index the object
    [string: string]: any;

    //Automatically serialize all FormProperties on this object
    toJSON(): any {
        let obj : {[key: string] : any} = {};
        let toSerialize = this.scanForProperties();
        toSerialize.forEach(keyPropPair => obj[keyPropPair.key] = keyPropPair.prop);
        return obj;
    }
}

class KeyFormProperty {
    constructor(public key: string, public prop: ValidatedProperty<any>) { };
}
