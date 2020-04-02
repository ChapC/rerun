import fs from 'fs';

export interface IJSONSavable {
    savePath: string;
    deserialize(object: any, triggerChangeEvent: boolean): boolean; //Loads the values from the JSON object into the current class
    toJSON(): any; //Force the class to implement a custom toJSON method
}

export namespace JSONSavable {
    //Serialize an object into a JSON file
    export function serializeJSON(object: any, savePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const jsonString = JSON.stringify(object);

            fs.writeFile(savePath, jsonString, (error) => {
                if (!error) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    //Deserialize from a JSON file into an object
    export function updateSavable(savable: IJSONSavable): Promise<void> {
        return new Promise((resolve, reject) => {
            const savePath = savable.savePath;
            //Read in the JSON file if it exists
            fs.exists(savePath, (exists) => {
                if (exists) { //There is an existing save file for this object
                    fs.readFile(savePath, (error, data) => {
                        if (!error) {
                            try {
                                if (!savable.deserialize(JSON.parse(data.toString()), false)) { //Don't trigger the form's change listeners
                                    console.warn("One or more properties from the save file (" + savePath + ") wasn't accepted. The file may be corrupted.");
                                }
                                resolve();
                            } catch (error) {
                                console.error("Couldn't read save data at " + savePath, error);
                                reject(error);
                            }
                        } else {
                            console.error("Failed access save data at " + savePath, error);
                            reject(error);
                        }
                    });
                } else {
                    resolve(); //The file doesn't exist yet, which is fine
                }
            })
        });
    }
}