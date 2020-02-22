import { IJSONSavable, JSONSavable } from "./JSONSavable";
import { FormProperty } from "./FormProperty";

export default abstract class JSONSavableForm implements IJSONSavable {
    constructor(public savePath: string) {}

    protected saveOnChange() : void {
        //Add a change listener for every FormProperty on the object
        for (const key of Object.keys(this)) {
            if (this[key] instanceof FormProperty) {
                const property = this[key] as FormProperty<any>;
                property.addChangeListener(() => JSONSavable.serializeJSON(this, this.savePath).catch(error => console.error('Error saving form to JSON', error)));
            }
        }
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
        const allValuesCopied = [];

        //Try to find a value for each FormProperty on the object
        for (const key of Object.keys(this)) {
            if (this[key] instanceof FormProperty) {
                const property = this[key] as FormProperty<any>;
                //Look for the key on the serialized object
                if (object[key]) {
                    allValuesCopied.push(property.trySetValue(object[key], suppressChangeEvent));
                } else {
                    allValuesCopied.push(false);
                }
            }
        }
        
        return allValuesCopied.every((accepted) => accepted);
    }

    //Makes Typescript allow us to index the object
    [string : string] : any;

    toJSON() : any {
        let obj = Object.assign({}, this);
        delete obj['savePath'];
        return obj;
    }
}
