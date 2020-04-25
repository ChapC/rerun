import { IPAddressProperty, StringProperty } from "./persistance/ValidatedProperty";
import SavablePropertyGroup from "./persistance/SavablePropertyGroup";
import { RerunStateObject } from ".";

export default class RerunUserSettings extends SavablePropertyGroup {
    readonly obsAddress : IPAddressProperty = new IPAddressProperty("OBS websocket address", "localhost:4444");

    constructor(savePath:string, rerunState: RerunStateObject) {
        super(savePath);
        this.saveOnChange();

        this.obsAddress.addChangeListener((newAddress) => {
            if (rerunState.startup.didStartSuccessfully()) {
                //The app's running, so change the current OBS connection
                rerunState.obs.connection.connect(newAddress).catch((error) => console.error("Couldn't connect to OBS at " + newAddress));
            } else {
                //The app didn't start because of this error, so restart
                rerunState.startup.start();
            }
        });
    }
}