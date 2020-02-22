import { RerunStateObject } from ".";

const colors = require('colors');
const OBSWebSocket = require('obs-websocket-js');

const NoConnectionAlert = 'NoOBSConnection';
const rerunGroupName = 'Rerun playback layer';
export class OBSConnection {
    obs: any;
    canvasDimensions: CanvasDimensions;
    private onConnectCallbacks: Function[] = [];
    private onDisconnectCallbacks: Function[] =[]

    constructor(public obsAddress: string, private rerunState : RerunStateObject) {
        this.obs = new OBSWebSocket();

        this.obs.on('ConnectionOpened', (data:any) => {
            this.info('Connected to OBS at ' + this.obsAddress);
            rerunState.alerts.clearAlert(NoConnectionAlert);

            //Find canvas dimensions
            this.obs.send('GetVideoInfo').then((videoInfo:any) => {
                this.canvasDimensions = new CanvasDimensions(videoInfo.baseWidth, videoInfo.baseHeight);

                //Alert listeners
                for (let c of this.onConnectCallbacks) {
                    c();
                }
            }).catch((error:Error) => this.error('Failed to fetch canvas dimensions:', error));

            //Check that all the required sources are loaded in OBS
            this.verifySources();
        });

        this.obs.on('ConnectionClosed', (data:any) => {
            rerunState.alerts.error(NoConnectionAlert, "No OBS connection", "Could not connect to OBS at " + this.obsAddress);
            for (let c of this.onDisconnectCallbacks) {
                c();
            }
        });
    }

    connect(ipAddress?: string) : Promise<void> {
        if (ipAddress) {
            this.obsAddress = ipAddress;
        }
        this.obs.disconnect();
        return this.obs.connect({address: this.obsAddress});
    }

    disconnect() {
        this.obs.disconnect();
    }

    onConnect(callback: Function) {
        this.onConnectCallbacks.push(callback);
    }

    onDisconnect(callback: Function) {
        this.onDisconnectCallbacks.push(callback);
    }

    //Verify that rerun sources are active in OBS
    verifySources() {
        this.getSourceInterface('rerun_localvideo', 'vlc_source').then((sourceInterface) => {
            if (sourceInterface == null) {
                this.error("Couldn't find OBS source for local video playback (should be VLC source called 'rerun_localvideo')");
                return;
            }
            this.rerunState.obs.sources.localVideo = sourceInterface;
        });

        this.getSourceInterface('rerun_webvideo', 'browser_source').then((sourceInterface) => {
            if (sourceInterface == null) {
                this.error("Couldn't find OBS source for web video playback (should be browser source called 'rerun_webvideo')");
                return;
            }
            this.rerunState.obs.sources.webVideo = sourceInterface;
        });
        this.getSourceInterface('rerun_rtmp', 'ffmpeg_source').then((sourceInterface) => {
            if (sourceInterface == null) {
                this.error("Couldn't find OBS source for RTMP stream playback (should be media source called 'rerun_rtmp')");
                return;
            }
            this.rerunState.obs.sources.rtmp = sourceInterface;
        });
    }

    //TODO: subscribe to source destroy and rename events to ensure the source is always available

    getSourceInterface(sourceName: string, sourceType: string) : Promise<OBSConnection.SourceInterface> {
        return new Promise((resolve, reject) => {
            //Verify a source with this name and type exists
            let sInterface : OBSConnection.SourceInterface = null;
            this.obs.send('GetSourcesList').then((response:any) => {
                const sourceList = response.sources;
                for (let source of sourceList) {
                    if (source.name === sourceName && source.typeId === sourceType) {
                        sInterface = new OBSConnection.SourceInterface(this, source.name, source.typeId);
                        break;
                    }
                }
                resolve(sInterface);
            });
        });
    }

    //Move the target source to the top of the rerun playback group
    moveSourceToTop(targetSource:OBSConnection.SourceInterface) {
        //Get the current order of the group
        this.obs.send('GetSourceSettings', {sourceName: rerunGroupName, sourceType: 'group'}).then((response:any) => {
            let originalSourceSettings = response.sourceSettings;
            let sceneItemList: any[] = Array.from(response.sourceSettings.items);
            //Find the scene item of the target source
            let targetSceneItem, targetIndex;
            for (let i = 0; i < sceneItemList.length; i++) {
                let sceneItem = sceneItemList[i];
                if (sceneItem.name == targetSource.sourceName) {
                    targetSceneItem = sceneItem;
                    targetIndex = i;
                    break;
                }
            }

            if (targetSceneItem == null) {
                this.error('Failed to reorder source: Could not find target source in playback group');
                return;
            }

            //Move the target scene item to the front
            sceneItemList.splice(targetIndex, 1);
            sceneItemList.splice(0, 0, targetSceneItem);

            //Apply the new order
            originalSourceSettings.items = sceneItemList;
            const reqOpts = {sourceName: rerunGroupName, sourceType: 'group', sourceSettings: originalSourceSettings};
            this.obs.send('SetSourceSettings', reqOpts).catch((error:Error) => this.error('Failed to reorder source, error while apply new settings:  ', error));

        }).catch((error:Error) => this.error('Failed to reorder source, error while fetching settings: ', error));   
    }

    info(message:string) {
        console.info('[OBSConnection] ' + message);
    }
    error(message:string, obj?:Error) {
        if (obj) {
            console.error(colors.red('[OBSConnection] ERROR - ' + message), obj);
        } else {
            console.error(colors.red('[OBSConnection] ERROR - ' + message));
        }
    }
}

export namespace OBSConnection {
    export class SourceInterface {
        private connection: OBSConnection;
        sourceName: string;
        sourceType: string;

        constructor(connection: OBSConnection, sourceName: string, sourceType:string) {
            this.connection = connection;
            this.sourceName = sourceName;
            this.sourceType = sourceType;
        }

        getSettings() : Promise<any> {
            const requestOpts = {sourceName: this.sourceName, sourceType: this.sourceType};
            return new Promise((resolve, reject) => {
                this.connection.obs.send('GetSourceSettings', requestOpts).then((response:any) => {
                    resolve(response.sourceSettings);
                }).catch((error:Error) => reject(error));    
            });
        }

        setSettings(newSettings:any) : Promise<void> {
            const requestOpts = {sourceName: this.sourceName, sourceType: this.sourceType, sourceSettings: newSettings};
            return new Promise((resolve, reject) => {
                this.connection.obs.send('SetSourceSettings', requestOpts).then((response:any) => {
                    resolve();
                }).catch((error:Error) => reject(error));
            });
        }

        centerAndFillScreen() : Promise<void> {
            let canvas = this.connection.canvasDimensions;
            const requestOpts = {
                item: this.sourceName, position: {
                    alignment: 0, x: canvas.width / 2, y: canvas.height / 2
                }, bounds: {y: canvas.height, x: canvas.width, type: 'OBS_BOUNDS_STRETCH'}
            };
            
            return new Promise((resolve, reject) => {
                this.connection.obs.send('SetSceneItemProperties', requestOpts).then((response:any) => {
                    resolve();
                }).catch((error:Error) => reject(error));
            });
        }

        setVisible(isVisible:boolean) : Promise<void> {
            const requestOpts = {item: this.sourceName, visible: isVisible};
            return new Promise((resolve, reject) => {
                this.connection.obs.send('SetSceneItemProperties', requestOpts).then((response:any) => {
                    resolve();
                }).catch((error:Error) => reject(error));
            });
        }
    }
}

class CanvasDimensions {
    width: number; 
    height: number; 
    constructor(width:number, height:number) {
        this.width = width;
        this.height = height;
    }
};
