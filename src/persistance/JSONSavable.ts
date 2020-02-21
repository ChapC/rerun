import fs from 'fs';

export default abstract class JSONSavable {
    constructor(protected savePath: string) {}

    readFromSaved() : Promise<void> {
        return new Promise((resolve, reject) => {
            //Read in the JSON file if it exists
            fs.exists(this.savePath, (exists) => {
                if (exists) { //There is an existing save file for this object
                    fs.readFile(this.savePath, (error, data) => {
                        if (!error) {
                            try {
                                if (!this.deserialize(JSON.parse(data.toString()))) {
                                    console.warn("One or more properties from the save file (" + this.savePath + ") wasn't accepted. The file may be corrupted.");
                                }
                                resolve();
                            } catch (error) {
                                console.error("Couldn't read save data at " + this.savePath, error);
                                reject(error);
                            }
                        } else {
                            console.error("Failed access save data at " + this.savePath, error);
                            reject(error);
                        }
                    });
                } else {
                    resolve(); //The file doesn't exist yet, which is fine
                }
            })
        });
    }

    protected serializeJSON(object: any) : Promise<void> {
        return new Promise((resolve, reject) => {
            const jsonString = JSON.stringify(object);

            fs.writeFile(this.savePath, jsonString, (error) => {
                if (!error) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    abstract deserialize(object: any) : boolean //Loads the values from the JSON object into the current class
}