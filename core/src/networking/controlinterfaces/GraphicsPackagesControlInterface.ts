import { GraphicPackageLoader } from "../../graphicspackages/GraphicPackageLoader";
import ControlPanelSockets, { ControlPanelInterface } from "../ControlPanelSockets";
import { WSSuccessResponse } from "@rerun/common/src/networking/WebsocketConnection";

export default class GraphicsPackagesControlInterface extends ControlPanelInterface {
    constructor(controlPanel: ControlPanelSockets, private loader: GraphicPackageLoader) {
        super(controlPanel);

        controlPanel.registerEmptyHandler('getGraphicsPackages', this.getGraphicsPackagesRequest);
    }

    private getGraphicsPackagesRequest() {
        return new WSSuccessResponse(this.loader.getAvailablePackages());
    }
}