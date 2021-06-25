import { GraphicLayer, GraphicPackageLoader } from "../../graphicspackages/GraphicPackageLoader";
import { AfterDeserialize, SaveableProperty } from "../../persistence/SaveableObject";
import { NumberProperty, TreePath } from "../../persistence/ValidatedProperty";
import { ContentBlock } from "../../playback/ContentBlock";
import { NodePlaybackStatus as PlaybackNodeStatus } from "../../playback/PlaybackNode";
import { PlaybackOffset } from "../../playback/Player";
import { RelativeStartType, Player } from "../../playback/Player";
import RuleAction from "../RuleAction";

export default class ShowGraphicAction extends RuleAction {
    readonly actionId = 'showgraphic';

    @SaveableProperty()
    readonly targetLayerPath = new TreePath('Graphic layer', this.graphicManager.graphicsTree);
    @SaveableProperty()
    readonly onScreenDurationSecs = new NumberProperty('Duration (secs)', 5);

    private graphicContentBlock: ContentBlock = null;

    constructor (private graphicManager: GraphicPackageLoader, private player: Player) { super(); };

    @AfterDeserialize()
    private init() {
        //Create a ContentBlock with the target layer and time
        let targetLayer = this.graphicManager.graphicsTree.getNodeAtPath(this.targetLayerPath.getValueAsPathArray()).value as GraphicLayer;
        this.graphicContentBlock = this.graphicManager.createContentBlockWith(targetLayer, this.onScreenDurationSecs.getValue() * 1000)
    }

    run(): void {
        //Start playing the graphic block now. We do this by enqueuing it relative to current block
        let current = this.player.getTreeSnapshot()[0];
        //TODO: Create a playImmediate player method for this use case
        let startNowOffset = new PlaybackOffset(PlaybackOffset.Type.MsAfterStart, current.status === PlaybackNodeStatus.Playing ? Date.now() - current.timestamp : 0);
        this.player.enqueueBlockRelative(this.graphicContentBlock, current, RelativeStartType.Concurrent, startNowOffset);
    }

    getContentBlock() : ContentBlock {
        return this.graphicContentBlock;
    }

    static isInstance(obj: any) : obj is ShowGraphicAction {
        return obj.actionId === 'showgraphic';
    }

}