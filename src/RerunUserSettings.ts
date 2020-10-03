import { IPAddressProperty } from "./persistance/ValidatedProperty";
import { ControlPanelListener, ControlPanelRequest } from "./ControlPanelHandler";
import { WSConnection } from "./helpers/WebsocketConnection";
import { MutableSaveableObject, SaveableProperty } from "./persistance/SaveableObject";

@ControlPanelListener
export default class RerunUserSettings extends MutableSaveableObject {
    @SaveableProperty()
    readonly obsAddress : IPAddressProperty = new IPAddressProperty("OBS websocket address", "localhost:4444");

    @ControlPanelRequest('getUserSettings')
    private getUserSettings() {
        return new WSConnection.SuccessResponse('UserSettings', this.toJSON());
    }

    @ControlPanelRequest('setUserSetting', WSConnection.AcceptAny)
    private setUserSettingRequest(data: any) {
        if (this.deserializeFrom(data)) {
            return new WSConnection.SuccessResponse('Accepted updated');
        } else {
            return new WSConnection.ErrorResponse('Failed to update');
        }
    }
}