import { IPAddressFormProperty, StringFormProperty } from "./persistance/FormProperty";
import JSONSavableForm from "./persistance/JSONSavableForm";

export default class RerunUserSettings extends JSONSavableForm {
    readonly obsAddress : IPAddressFormProperty = new IPAddressFormProperty("OBS websocket address", "localhost:4444");

    constructor(savePath:string) {
        super(savePath);
        this.saveOnChange();
    }
}