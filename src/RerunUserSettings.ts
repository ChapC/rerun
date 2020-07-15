import { IPAddressProperty, StringProperty } from "./persistance/ValidatedProperty";
import SavablePropertyGroup from "./persistance/SavablePropertyGroup";
import { RerunStateObject } from ".";
import { ControlPanelListener, ControlPanelRequest } from "./ControlPanelHandler";
import { WSConnection } from "./helpers/WebsocketConnection";

@ControlPanelListener
export default class RerunUserSettings extends SavablePropertyGroup {
    readonly obsAddress : IPAddressProperty = new IPAddressProperty("OBS websocket address", "localhost:4444");

    constructor(savePath:string, rerunState: RerunStateObject) {
        super(savePath);
        this.saveOnChange();
    }

    @ControlPanelRequest('getUserSettings')
    private getUserSettings() {
        return new WSConnection.SuccessResponse('UserSettings', this);
    }

    @ControlPanelRequest('setUserSetting', WSConnection.AcceptAny)
    private setUserSettingRequest(data: any) {
        if (data.propertyKey == null || data.value == null) {
            return new WSConnection.ErrorResponse('InvalidArguments', 'No property key and value provided');             
        }

        try {
            this.rerunState.userSettings.setFormProperty(data.propertyKey, data.value);
            return new WSConnection.SuccessResponse(`Set user setting '${data.propertyKey}' to '${data.value}'`);
        } catch (error) {
            return new WSConnection.ErrorResponse('SetFailed', JSON.stringify(error));
        }
    }
}