import { IPAddress } from "./persistence/ValidatedProperty";
import { MutableSaveableObject, SaveableProperty } from "./persistence/SaveableObject";

export default class RerunUserSettings extends MutableSaveableObject {
    @SaveableProperty()
    readonly obsAddress : IPAddress = new IPAddress("OBS websocket address", "localhost:4444");
}