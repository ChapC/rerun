import { GraphicLayer, GraphicManager } from "../../graphiclayers/GraphicManager";
import { SaveableProperty } from "../../persistence/SaveableObject";
import { NumberProperty, TreePath } from "../../persistence/ValidatedProperty";
import { ContentBlock } from "../../playback/ContentBlock";
import { GraphicsLayerLocation } from "../../playback/MediaLocations";
import { MediaObject } from "../../playback/MediaObject";
import { PlaybackOffset } from "../../playback/PlaybackContentNode";
import { PlaybackStartRelationship, Player } from "../../playback/Player";
import RuleAction from "../RuleAction";

export default class ShowGraphicAction extends RuleAction {
    readonly actionId = 'showgraphic';

    @SaveableProperty()
    readonly targetLayerPath = new TreePath('Graphic layer', this.graphicManager.graphicsTree);
    @SaveableProperty()
    readonly onScreenDurationSeconds = new NumberProperty('Duration (secs)', 5);

    private graphicContentBlock: ContentBlock;

    constructor (private graphicManager: GraphicManager, private player: Player) { 
        super();        
        //Create a ContentBlock with the target layer and time
        let targetLayer = graphicManager.graphicsTree.getNodeAtPath(this.targetLayerPath.getValueAsPathArray()).value as GraphicLayer;
        let mediaObj = new MediaObject(MediaObject.MediaType.RerunGraphic, targetLayer.name, new GraphicsLayerLocation(targetLayer.asReference), this.onScreenDurationSeconds.getValue() * 1000);
        this.graphicContentBlock = new ContentBlock(mediaObj);
    };

    run(): void {
        //Start playing the graphic block now. We do this by enqueuing it relative to current block
        let currentlyPlayingBlock = this.player.getPlayingBlocks()[0];
        let startNowOffset = new PlaybackOffset(PlaybackOffset.Type.MsAfterStart, currentlyPlayingBlock.progressMs);
        this.player.enqueueBlockRelative(this.graphicContentBlock, currentlyPlayingBlock, PlaybackStartRelationship.Concurrent, startNowOffset);
    }

    getContentBlock() : ContentBlock {
        return this.graphicContentBlock;
    }

    static isInstance(obj: any) : obj is ShowGraphicAction {
        return obj.actionId === 'showgraphic';
    }

}