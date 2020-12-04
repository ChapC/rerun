import 'reflect-metadata';
import { ControllableSingleListenable } from '../helpers/SingleListenable';
import { ValidatedProperty } from './ValidatedProperty';

/**
 * An object with a series of serializable properties grouped together, like a form.
 * SaveableObject provides automatic group serialization/deserialization
 * for all properties decorated with @SaveableProperty.
 * 
 * @remarks You should probably extend either `ImmutableSavableObject` or `MutableSavableObject` instead of this class directly
 */
export abstract class SaveableObject {
    private saveableProperties: KeyValidatedPropertyPair[];

    protected getSaveableProperties(): KeyValidatedPropertyPair[] {
        if (!this.saveableProperties) {
            //Find all the properties tagged with @SaveableProperty and check that they're ValidatedProperty objects
            let taggedPropertyKeys: string[] = Reflect.getMetadata(taggedPropertyMetaKey, this);
            this.saveableProperties = [];

            for (let key of taggedPropertyKeys) {
                let value: any = this[key];
                if (ValidatedProperty.isInstance(value)) {
                    this.saveableProperties.push(new KeyValidatedPropertyPair(key, value));
                } else {
                    console.warn(`SaveableObject found property ${key} tagged with @SaveableProperty, but it is not a ValidatedProperty`);
                }
            }
        }

        return this.saveableProperties;
    }

    toJSON() {
        //Automatically serialize all tagged ValidatedProperties on this object (and don't serialize other any other properties)
        let obj : {[key: string] : any} = {};
        this.getSaveableProperties().forEach(keyPropPair => obj[keyPropPair.key] = keyPropPair.prop);
        return obj;
    }

    [string: string]: any; //Tell Typescript to let us index the damn object
}

class KeyValidatedPropertyPair { constructor(public key: string, public prop: ValidatedProperty<any>) { }; }
//@SaveableProperty decorator function
const taggedPropertyMetaKey = Symbol('savablePropertyTagged');
/**
 * Marks a property on a SaveableObject for inclusion in the serialization/deserialization process.
 * 
 * NOTE: The target property must be a ValidatedProperty.
 */
export function SaveableProperty() : (target: any, propertyKey: string) => void {
    return (target, propertyKey) => {
        //Define a list of decorated properties on the instance (target) and the statically-available constructor (target.constructor)
        let taggedPropertiesInstance: string[] = Reflect.getMetadata(taggedPropertyMetaKey, target);
        let taggedPropertiesStatic: string[] = Reflect.getMetadata(taggedPropertyMetaKey, target.constructor);

        if (taggedPropertiesInstance) {
            taggedPropertiesInstance.push(propertyKey);
            taggedPropertiesStatic.push(propertyKey);
        } else {
            taggedPropertiesInstance = [ propertyKey ];
            taggedPropertiesStatic = [ propertyKey ];
            Reflect.defineMetadata(taggedPropertyMetaKey, taggedPropertiesInstance, target);
            Reflect.defineMetadata(taggedPropertyMetaKey, taggedPropertiesStatic, target.constructor);
        }
    };
}

/** NOTE:
 * The only difference between the ISO and ISOWithConstructor classes 
 * is that ISO automatically grabs this.constructor and calls it
 * with no parameters, whereas ISOWithConstructor requires the caller
 * to pass in a constructor function for the object. ISO is just for the convenience of the caller.
 */

/**
 * A SaveableObject in which the properties are immutable.
 * When deserializing, a new instance of the object is constructed using the values from the provided serialized object.
 * 
 * @remarks Child classes extending ImmutableSaveableObject must not have a custom constructor. If they do, use `ImmutableSaveableObjectWithConstructor` instead.
 */
export abstract class ImmutableSaveableObject extends SaveableObject {
    private readonly iHasConstructor = false;
    public deserializeToNew<T extends ImmutableSaveableObject>(serializedObject: any) : T {
        let taggedPropertyKeys: string[] = Reflect.getMetadata(taggedPropertyMetaKey, this);
        
        let newObj: T = new (<any>this.constructor)(); //Create a new instance of the child class

        /*
        * Attempt to read each taggedProperty from serializedObject into the newObj.
        * The deserialize operation will only succeed if all taggedProperties can be found
        * in serializedObject and they all are accepted by the newObj's ValidatedProperty objects.
        */

        for (let i = taggedPropertyKeys.length - 1; i > -1; i--) {
            let propertyKeyToDeserialize = taggedPropertyKeys[i];
            //Find the property on newObj
            let targetProperty = newObj[propertyKeyToDeserialize];
            if (!ValidatedProperty.isInstance(targetProperty)) throw new Error(`Failed to deserialize: Property ${propertyKeyToDeserialize} is tagged with @SaveableProperty, but it is not a ValidatedProperty`);

            //Find the property on the serializedObject
            let serializedProperty = serializedObject[propertyKeyToDeserialize];
            if (!serializedProperty) throw new Error(`Failed to deserialize: Couldn't find property ${propertyKeyToDeserialize} on serialized object`);

            //Pass the serializedProperty to the targetProperty and see if it's accepted
            if (!targetProperty.trySetValue(serializedProperty, false)) throw new Error(`Failed to deserialize: Value for property ${propertyKeyToDeserialize} was rejected`);

            taggedPropertyKeys.splice(i, 1);
        }

        if (taggedPropertyKeys.length > 0) {
            throw new Error(`Failed to deserialize: The following propert${ taggedPropertyKeys.length === 0 ? 'y was' : 'ies were' } not present on the serialized object ${taggedPropertyKeys}`);
        }

        return newObj;
    }

    public static isInstance(obj: any) : obj is ImmutableSaveableObject {
        return obj.iHasConstructor != null && obj.iHasConstructor === false;
    }
}

/**
 * A SaveableObject in which the properties are immutable.
 * When deserializing, a constructor function must be provided along with the serialized object. 
 * A new object will then be created using the with the constructor function and will be filled with values from the serialized object.
 * 
 * @remarks If the child class extending ImmutableSaveableObjectWithConstructor does not have a custom constructor, consider using `ImmutableSaveableObject` instead.
 */
export abstract class ImmutableSaveableObjectWithConstructor extends SaveableObject {
    private readonly iHasConstructor = true;
    public deserializeToNew<T extends ImmutableSaveableObjectWithConstructor>(constructor: () => T, serializedObject: any) : T {
        let taggedPropertyKeys: string[] = Reflect.getMetadata(taggedPropertyMetaKey, this);
        
        let newObj: T = constructor(); //Create a new instance of the child class using the provided constructor

        if (!newObj) throw new Error('Failed to deserialize: The custom constructor function did not return an object');

        for (let i = taggedPropertyKeys.length - 1; i > -1; i--) {
            let propertyKeyToDeserialize = taggedPropertyKeys[i];
            //Find the property on newObj
            let targetProperty = newObj[propertyKeyToDeserialize];
            if (!targetProperty) throw new Error(`Failed to deserialize: Couldn't find property ${propertyKeyToDeserialize} on the instance returned by the constructor function`);
            if (!ValidatedProperty.isInstance(targetProperty)) throw new Error(`Failed to deserialize: Property ${propertyKeyToDeserialize} is tagged with @SaveableProperty, but it is not a ValidatedProperty`);

            //Find the property on the serializedObject
            let serializedProperty = serializedObject[propertyKeyToDeserialize];
            if (!serializedProperty) throw new Error(`Failed to deserialize: Couldn't find property ${propertyKeyToDeserialize} on serialized object`);

            //Pass the serializedProperty to the targetProperty and see if it's accepted
            if (!targetProperty.trySetValue(serializedProperty, false)) throw new Error(`Failed to deserialize: Value for property ${propertyKeyToDeserialize} was rejected`);

            taggedPropertyKeys.splice(i, 1);
        }

        if (taggedPropertyKeys.length > 0) {
            throw new Error(`Failed to deserialize: The following propert${ taggedPropertyKeys.length === 0 ? 'y was' : 'ies were' } not present on the serialized object ${taggedPropertyKeys}`);
        }

        return newObj;
    }

    public static isInstance(obj: any) : obj is ImmutableSaveableObjectWithConstructor {
        return obj.iHasConstructor != null && obj.iHasConstructor === true;
    }
}

/**
 * A SaveableObject in which the properties are mutable.
 * When deserializing, the properties on the object instance are updated in place.
 * Partial deserialization is supported via the deserializeFrom method, which can be
 * used to update individual properties rather than the whole object at once.
 */
export abstract class MutableSaveableObject extends SaveableObject {
    /**
     * Read values in from a serialized object and use them to update this object.
     * Partial objects are accepted too, so you can optionally pass in a subset of this object's saveable properties and update just those ones.
     * 
     * Updates are an all-or-nothing operation. If one of the provided properties on serializedObject is invalid, none of them will be accepted.
     * 
     * @returns True if all serialized values were accepted, False if any of them were rejected
     */
    public deserializeFrom(serializedObject: any) : boolean {
        let saveableProperties = this.getSaveableProperties();

        let targetedSaveableProperties = new Map<ValidatedProperty<any>, any>();
        //Iterate over keys of the serializedObject
        for (let key in serializedObject) {
            let matchIndex = saveableProperties.findIndex(p => p.key === key);
            if (matchIndex === -1) return false;

            let targetSaveable = saveableProperties[matchIndex];
            if (!targetSaveable.prop.willAcceptValue(serializedObject[key])) return false;
            targetedSaveableProperties.set(targetSaveable.prop, serializedObject[key]);          
        }

        //They were all accepted. Now we can apply them
        targetedSaveableProperties.forEach((value, property) => property.trySetValue(value));
        this.listenable.trigger(Array.from(targetedSaveableProperties.keys()));
        return true;
    }

    private listenable = new ControllableSingleListenable<ValidatedProperty<any>[]>();
    
    public onPropertiesUpdated(callback: (event: ValidatedProperty<any>[]) => {}) : number {
        return this.listenable.addChangeListener(callback);
    }

    public offPropertiesUpdated(listenerId: number) {
        this.listenable.removeChangeListener(listenerId);
    }
    
    public cancelAllPropertiesUpdatedListeners() {
        this.listenable.cancelAllListeners();
    }

    public static isInstance(obj: any) : obj is MutableSaveableObject {
        return (typeof obj.deserializeFrom) === 'function';
    }
}