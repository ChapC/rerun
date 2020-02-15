import { SingleListenable } from "./SingleListenable";

//A list of persistent alerts that can be updated or removed any time
export class AlertContainer extends SingleListenable<Alert[]> {
    private alerts: {[key : string] : Alert} = {};

    info(key: string, title: string, description?:string) {
        this.alerts[key] = new Alert(AlertContainer.Severity.Info, key, title, description);
        this.alertsChanged();
    }

    warn(key: string, title: string, description?:string) {
        this.alerts[key] = new Alert(AlertContainer.Severity.Warning, key, title, description);
        this.alertsChanged();
    }

    error(key: string, title: string, description?:string) {
        this.alerts[key] = new Alert(AlertContainer.Severity.Error, key, title, description);
        this.alertsChanged();
    }

    loading(key: string, title: string, description?:string) {
        this.alerts[key] = new Alert(AlertContainer.Severity.Loading, key, title, description);
        this.alertsChanged();
    }

    clearAlert(key: string) {
        if (this.alerts[key]) {
            delete this.alerts[key];
            this.alertsChanged();
        }
    }

    private alertsChanged() {
        this.triggerListeners(Object.values(this.alerts));
    }

    getAlerts() {
        return Object.values(this.alerts);        
    }

    toJSON() : any {
        return Object.values(this.alerts);
    }
}

export class Alert {
    constructor(public severity: AlertContainer.Severity, public key: string, public title: string, public description?:string) {}
}

export namespace AlertContainer {
    export enum Severity {
        Info = 'Info', Loading = 'Loading', Warning = 'Warning', Error = 'Error' 
    }
}