import { ControlPanelInterface } from "../ControlPanelSockets";

//TODO: This.
export default class ContentSourcesControlInterface extends ControlPanelInterface {
        // //Control panel requests
        // @ControlPanelRequest('pullFromContentSource', AcceptAny)
        // private pullFromContentSourceRequest(data: any) { //Pull the next media object from a content source and queue it for playback
        //     if (data.sourceId == null) {
        //         return new WSErrorResponse('No content source ID provided');
        //     }
    
        //     const targetSource = this.getSource(data.sourceId);
        //     if (targetSource == null) {
        //         return new WSErrorResponse('No content source with the target ID');
        //     }
    
        //     return new Promise((resolve, reject) => {
        //         targetSource.poll().then((block) => {
        //             this.player.enqueueBlock(block);
        //             resolve(new WSSuccessResponse('Queued item from source ' + targetSource.name));
        //         }).catch((error) => {
        //             console.error('Pull from content source failed ', error);
        //             reject(new WSErrorResponse(JSON.stringify(error)));
        //         });
        //     });
        // }
    
        // @ControlPanelRequest('newContentSource', AcceptAny)
        // private newContentSourceRequest(data: any) {
        //     if (data.newSource == null) {
        //         return new WSErrorResponse('No content source provided');
        //     }
    
        //     return new Promise((resolve, reject) => {
        //         this.createContentSourceFromRequest(data.newSource).then((source) => {
        //             this.addSource(source);
        //             resolve(new WSSuccessResponse('Created content source with ID ' + source.id));
        //         }).catch((error) => {
        //             reject(new WSErrorResponse(JSON.stringify(error)));
        //         });
        //     });
        // }
    
        // @ControlPanelRequest('deleteContentSource', AcceptAny)
        // private deleteContentSourceRequest(data: any) {
        //     if (data.sourceId == null) {
        //         return new WSErrorResponse('No source ID provided');
        //     }
    
        //     this.removeSource(data.sourceId);
        //     return new WSSuccessResponse('Removed source with ID ' + data.sourceId);
        // }
    
        // @ControlPanelRequest('updateContentSource', AcceptAny)
        // private updateContentSourceRequest(data: any) {
        //     if (data.sourceId == null || data.newSource == null) {
        //         return new WSErrorResponse('No source ID and source data provided');
        //     }
    
        //     return new Promise((resolve, reject) => {
        //         this.createContentSourceFromRequest(data.newSource).then((source) => {
        //             this.updateSource(data.sourceId, source);
        //             resolve(new WSSuccessResponse('Updated source with ID ' + data.sourceId));
        //         }).catch((error) => {
        //             reject(new WSErrorResponse(JSON.stringify(error)));
        //         });
        //     });
        // }
    
        // @ControlPanelRequest('getContentSources')
        // private getContentSourcesRequest() {
        //     return new WSSuccessResponse(this.getSources());
        // }
    
        // @ControlPanelRequest('getAutoPool')
        // private getAutoPoolRequest() {
        //     return new WSSuccessResponse({
        //         pool: this.getAutoSourcePool(),
        //         options: this.getAutoPoolOptions()
        //     });
        // }
    
        // @ControlPanelRequest('setAutoPoolOptions', ContentSourceManager.isAutoPoolOptions)
        // private setAutoPoolRequest(newOptions: ContentSourceManager.AutoPoolOptions) {
        //     this.setAutoPoolOptions(newOptions);
        //     return new WSSuccessResponse('Set options');
        // }
    
        // private static isAutoPoolOptions(obj: any) : obj is ContentSourceManager.AutoPoolOptions {
        //     return (obj.enabled != null && obj.targetQueueSize != null && obj.pullOrder != null);
        // }
    
        // @ControlPanelRequest('setUseSourceInPool', AcceptAny)
        // private useSourceInPoolRequest(data: any) {
        //     if (data.sourceId == null || data.enabled == null) {
        //         return new WSErrorResponse('No source ID and enabled status provided');                         
        //     }
    
        //     this.setUseSourceForAuto(data.sourceId, data.enabled);
        //     return new WSSuccessResponse(`Set source to ${data.sourceId} to ${data.enabled}`);
        // }
    
        // private createContentSourceFromRequest(requestedSource : any) : Promise<ContentSource> {
        //     return new Promise((resolve, reject) => {
        //         switch (requestedSource.type) {
        //             case 'LocalDirectory':
        //                 let ldirSource = new LocalDirectorySource(requestedSource.name, requestedSource.directory);
        //                 ldirSource.id = requestedSource.id;
        //                 ldirSource.setShuffle(requestedSource.shuffle);
        //                 resolve(ldirSource);
        //                 break;
        //             case 'YTChannel':
        //                 reject('Not yet implemented');
        //                 break;
        //             default:
        //                 reject("Unknown source type '" + requestedSource.type + "'");
        //         }
        //     });
        // }
}