import fs from "fs";
import { MutableSaveableObject, SaveableObject } from "./SaveableObject";

export namespace SaveableUtils {
    export enum ErrorType { FileAccessError, JSONParseError, ValuesRejectedError };

    /**
     * Read serialized values from a JSON file into a MutableSaveableObject.
     * @param saveable SaveableObject to push values into
     * @param filePath JSON file to read from
     */
    export function updateMutableFromFile(saveable: MutableSaveableObject, filePath: string) : Promise<void> {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, (error, data) => {
                if (!error) {
                    let jsonObj;
                    try {
                        jsonObj = JSON.parse(data.toString());
                    } catch (jsonError) {
                        reject({ type: ErrorType.JSONParseError, error: jsonError });
                        return;
                    }
                    if (saveable.deserializeFrom(jsonObj)) {
                        resolve();
                    } else {
                        reject({ type: ErrorType.ValuesRejectedError });
                    }
                } else {
                    reject({ type: ErrorType.FileAccessError, error: error });
                }
            })
        });
    }

    export function writeSaveableToFile(saveable: SaveableObject, filePath: string) : Promise<void> {
        return new Promise((resolve, reject) => {
            const jsonString = JSON.stringify(saveable);

            fs.writeFile(filePath, jsonString, (error) => {
                if (!error) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }
}