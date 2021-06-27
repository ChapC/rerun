import { isNumber } from "../../helpers/TypeGuards";
import { ModifyingActiveNodeError, Player, UnknownNodeIdError } from "../../playback/Player";
import ControlPanelSockets, { ControlPanelInterface } from "../ControlPanelSockets";
import { WSErrorResponse, WSPendingResponse, WSSuccessResponse } from "@rerun/common/src/networking/WebsocketConnection";

/**
 * Interface for player control via the control panel.
 */
export default class PlayerControlInterface extends ControlPanelInterface {
    constructor(controlPanel: ControlPanelSockets, private player: Player) {
        super(controlPanel);

        controlPanel.registerEmptyHandler('getTree', this.getQueueRequest);
        controlPanel.registerHandler<Number>('skip', isNumber, this.skip);
        controlPanel.registerHandler<Number>('restart', isNumber, this.restart);
        controlPanel.registerEmptyHandler('stopAll', this.stopAll);
    }

    private getQueueRequest() : WSPendingResponse {
        return new WSSuccessResponse(this.player.getTreeSnapshot());
    }

    private skip(nodeId: number) : WSPendingResponse {
        try {
            this.player.skip(nodeId);
            return new WSSuccessResponse();
        } catch (ex) {
            if (UnknownNodeIdError.isInstance(ex)) {
                return new WSErrorResponse(`No skippable node with the id ${ex.unknownNodeId}`);
            } else throw ex;
        }
    }

    private restart(nodeId: number) : WSPendingResponse {
        try {
            this.player.restart(nodeId);
            return new WSSuccessResponse();
        } catch (ex) {
            if (UnknownNodeIdError.isInstance(ex)) {
                return new WSErrorResponse(`No restartable node with the id ${ex.unknownNodeId}`);
            } else throw ex;
        }
    }

    private stopAll() : WSPendingResponse {
        this.player.stopAll();
        return new WSSuccessResponse();
    }

    // private queueChange(requestedChange: NodeQueueChange) : WSPendingResponse {
    //     if (requestedChange.queueIdTarget === -1) {
    //         //This is a delete request
    //         try {
    //             this.player.dequeueNode(requestedChange.queueIdToMove);
    //             return new WSSuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} removed`);
    //         } catch (ex) {
    //             if (ModifyingActiveNodeError.isInstance(ex)) {
    //                 return new WSErrorResponse(`Cannot delete a node while it is ${ex.targetNodeStatus}`);
    //             } else throw ex;
    //         }
    //     } else {
    //         //This is a reorder request
    //         let success = this.reorderQueuedNode(requestedChange.queueIdToMove, requestedChange.queueIdTarget, requestedChange.placeBefore);
    //         if (success) {
    //             return new WSSuccessResponse(`ContentBlock ${requestedChange.queueIdToMove} moved`);
    //         } else {
    //             return new WSErrorResponse('Invalid queue IDs');
    //         }
    //     }
    // }

//     @ControlPanelRequest('updateContentBlock', AcceptAny)
//     private updateBlockRequest(data: any): WSPendingResponse {
//         return new Promise((resolve, reject) => {
//             //Try to create a new content block from the provided one
//             this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
//                 contentBlock.id = data.block.id; //Replace the generated id with the target id
//                 if (this.updateQueuedNode(data.block.queuedId, contentBlock)) {
//                     resolve(new WSSuccessResponse(`Updated block with id ${contentBlock.id}`));
//                 } else {
//                     reject(new WSErrorResponse('Invalid target block'));
//                 };
//             }).catch(error => {
//                 console.error('Failed to create content block from request:', error);
//                 reject(error);
//             });
//         });
//     }

//     @ControlPanelRequest('addContentBlock', AcceptAny)
//     private addContentBlockRequest(data: any) : WSPendingResponse {
//         return new WSErrorResponse('NotImplemented');

// /*         return new Promise((resolve, reject) => {
//             this.createContentBlockFromRequest(data.block).then((contentBlock: ContentBlock) => {
//                 this.rerunState.player.enqueueBlock(contentBlock);
//                 resolve(new SuccessResponse(`Enqueued content block ${data.block.id}`));
//             }).catch(error => {
//                 console.error('Failed to enqueue new content block:', error);
//                 resolve(error);
//             });
//         }); */
//     }

//     private createContentBlockFromRequest(requestedBlock: any) : Promise<ContentBlock> {
//         return new Promise((resolve, reject) => {
//             //Try to create the MediaObject
//             this.createMediaObjectFromRequest(requestedBlock.media, this.rerunComponents).then((mediaObject: MediaObject) => {
//                 let block = new ContentBlock(mediaObject);
//                 block.colour = requestedBlock.colour;
//                 resolve(block);
//             }).catch(error => reject(error));
//         });
//     }
    
//     private createMediaObjectFromRequest(requestedMedia: any, rerunState: PublicRerunComponents): Promise<MediaObject> {
//         return new Promise((resolve, reject) => {
//             let newMedia = MediaObject.CreateEmpty(requestedMedia.type);
//             newMedia.name = requestedMedia.name;

//             switch (requestedMedia.type) {
//                 case 'Local video file':
//                     //Check that the file exists
//                     if (fs.existsSync(requestedMedia.location.path)) {
//                         if (!fs.lstatSync(requestedMedia.location.path).isDirectory()) {
//                             //Get file metadata for this media object
//                             mediaObjectFromVideoFile(requestedMedia.location.path).then((generatedMedia: MediaObject) => {
//                                 generatedMedia.name = requestedMedia.name; //Set the requested name rather than the generated one
//                                 resolve(generatedMedia);
//                             }).catch(error => reject(error));
//                         } else {
//                             reject('Provided path is a directory, not a file');
//                         }
//                     } else {
//                         reject('File not found');
//                     }
//                     break;
//                 case 'Youtube video':
//                     mediaObjectFromYoutube(requestedMedia.location.path, rerunState.downloadBuffer).then((media: MediaObject) => {
//                         resolve(media);
//                     }).catch(error => reject(error));
//                     break;
//                 case 'RTMP stream':
//                     reject('RTMP not yet implemented');
//                     break;
//                 case 'Rerun title graphic':
//                     reject('Rerun graphic not yet implemented');
//                     break;
//                 default:
//                     reject('Unknown media type "' + requestedMedia.type + '"');
//             }
//         });
//     }
}

class NodeQueueChange {
    readonly queueIdToMove: number; //The ID of the item to be moved
    readonly queueIdTarget: number; //The ID of the item the moved one should be placed next to
    readonly placeBefore: boolean; //Where to place the moved item relative to the target. true for before, false for after.

    static isInstance(obj: any) : obj is NodeQueueChange {
        return (typeof obj.queueIdToMove) === 'number' 
            && (typeof obj.queueIdTarget) === 'number'
            && (typeof obj.placeBefore) === 'boolean';
    }
}