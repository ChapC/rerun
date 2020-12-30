import { IPAddress } from "./persistence/ValidatedProperty";
import { ControlPanelListener, ControlPanelRequest } from "./networking/ControlPanelHandler";
import { AcceptAny, WSConnection, WSSuccessResponse, WSErrorResponse } from "./networking/WebsocketConnection";
import { MutableSaveableObject, SaveableProperty } from "./persistence/SaveableObject";

@ControlPanelListener
export default class RerunUserSettings extends MutableSaveableObject {
    @SaveableProperty()
    readonly obsAddress : IPAddress = new IPAddress("OBS websocket address", "localhost:4444");

    @ControlPanelRequest('getUserSettings')
    private getUserSettings() {
        return new WSSuccessResponse(this.toJSON());
    }

    @ControlPanelRequest('setUserSetting', AcceptAny)
    private setUserSettingRequest(data: any) {
        if (this.deserializeFrom(data)) {
            return new WSSuccessResponse('Accepted updated');
        } else {
            return new WSErrorResponse('Failed to update');
        }
    }
}