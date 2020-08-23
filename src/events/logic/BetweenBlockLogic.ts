import { UserEvent } from "../UserEvent";
import { Player, PlayerState } from "../../playback/Player";
import { IntegerProperty } from "../../persistance/ValidatedProperty";
import { MediaObject } from "../../playback/MediaObject";
import { ContentBlock } from "../../playback/ContentBlock";
import { ShowGraphicAction } from "../actions/ShowGraphicAction";
import { GraphicsLayerLocation } from "../../playback/MediaLocations";
import { GraphicLayerReference } from "../../graphiclayers/GraphicManager";

const uuidv4 : () => string = require('uuid/v4');
/*
export class BetweenBlockLogic extends UserEvent.Logic {
    constructor(private player: Player) {
        super('BetweenBlock');
    }

    readonly frequency = new IntegerProperty('Frequency', 1);
    private frequencyCounter = 0; //Trigger this event every nth ContentBlock

    private listenerCancellers : (() => void)[] = [];

    private queuedBlock : ContentBlock = null;
    private playerStopped = false;

    enable() {
        /*The whole "event logic - event action separation" thing is kind of broken by this class, but it's how the user would expect this event to work so I'm going with it.
        *For a ShowGraphicAction to be triggered between ContentBlocks, a MediaObject pointing to that graphic has to be queued in the player ahead of time.
        *We can't just call triggerEvent() when it's time to show the graphic, as a lot of graphics have a few seconds of "pre-roll" that needs
        *to be played on top of the current media. The player is in charge of all that, so to fit that behaviour into the UserEvent system we cheat a bit.
        /
        if (this.parentEvent.actionType.getValue() === 'Show a graphic') {
            //Peek into the action attached to this UserEvent to grab the details of the target graphic
            let gAction = this.parentEvent.action.getValue() as ShowGraphicAction;
            if (gAction.targetLayerName.hasValue()) {
                if (this.queuedBlock != null) { //Update the queued block if it's already in place
                    this.setupQueuedBlock();
                }
            }

            //Update the queued block whenever the ShowGraphicAction is modified (NOTE: only update. The player callbacks determine whether or not the block should be in the queue)
            let layerListener = gAction.targetLayerName.addChangeListener((newLayer) => {
                if (this.queuedBlock != null) {
                    this.setupQueuedBlock();
                }
            });
            let durationListener = gAction.onScreenDurationSecs.addChangeListener((newDuration) => {
                if (this.queuedBlock != null) {
                    this.setupQueuedBlock();
                }
            });

            //Save these listeners to be unregistered when this event is disabled
            this.listenerCancellers.push(() => gAction.targetLayerName.removeChangeListener(layerListener), () => gAction.onScreenDurationSecs.removeChangeListener(durationListener));

            //Register a player callback to queue our ContentBlock whenever media starts playing (and at the specified frequency)
            let playerBlockListener = this.player.on('newCurrentBlock', (b) => {
                let newBlock = <ContentBlock> b;
                if (this.queuedBlock != null && newBlock.id === this.queuedBlock.id) {
                    //Our queued block is currently playing. Clear this.queuedBlock so we know to add it again next time
                    this.queuedBlock = null;
                    return;
                }

                if (this.playerStopped) { //Last we checked the player was stopped...
                    if (this.player.getDefaultBlock().id === newBlock.id) { //...check that the player is still stopped
                        //The player is currently stopped. Don't do anything.
                        return;
                    } else {
                        this.playerStopped = false; //The player isn't stopped anymore
                    }
                }

                this.frequencyCounter++;
                if (this.frequencyCounter === this.frequency.getValue()) {
                    this.setupQueuedBlock(); //Queue the block
                    this.frequencyCounter = 0; //Reset the frequency counter
                }
            });

            //Remove the queued block if the user stops playback
            let playerStopListener = this.player.on('stopped', () => {
                this.playerStopped = true;
                if (this.queuedBlock != null) {
                    this.player.dequeueBlock(this.queuedBlock);
                    this.queuedBlock = null;
                    this.frequencyCounter = 0; //Reset the frequency counter
                }
            });

            this.listenerCancellers.push(() => this.player.off(playerBlockListener), () => this.player.off(playerStopListener));

            //Those are our listeners, but if we're already in the middle of a block we might need to queue the block now
            let currentState = this.player.getState();
            if (currentState.playbackState === Player.PlaybackState.InBlock) {
                if (this.frequency.getValue() === 1 && this.player.getDefaultBlock().id !== currentState.currentBlock.id) {
                    this.setupQueuedBlock();
                }
            }
        } else {
            //This event's action isn't related to on-screen content. We can trigger it normally when a ContentBlock finishes.
            let blockFinishedCallback = this.player.on('relTime:end-0', () => {
                this.frequencyCounter++;
                if (this.frequencyCounter === this.frequency.getValue()) {
                    //Trigger the event
                    this.triggerEvent();
                    //Reset the counter
                    this.frequencyCounter = 0;
                }
            });
            this.listenerCancellers.push(() => this.player.off(blockFinishedCallback));
        }
    }

    private setupQueuedBlock() {
        let gAction = this.parentEvent.action.getValue() as ShowGraphicAction;
        let layer = GraphicLayerReference.fromString(gAction.targetLayerName.getValue());
        let durationMs = gAction.onScreenDurationSecs.getValue() * 1000;

        let graphicMediaObj = new MediaObject(MediaObject.MediaType.RerunGraphic, this.parentEvent.name.getValue() + ' - BetweenBlockGraphic', new GraphicsLayerLocation(layer), durationMs);

        if (gAction.getTargetLayer().animationTimings['in']) {
            graphicMediaObj.preRollMs = gAction.getTargetLayer().animationTimings['in'];
        }

        if (this.queuedBlock == null) {
            //Create a new block
            let graphicBlock = new ContentBlock(uuidv4(), graphicMediaObj);
            this.player.insertBlockAt(0, graphicBlock); //Insert this block at the front of the queue
            this.queuedBlock = graphicBlock;
        } else {
            //Update the existing block
            let updatedBlock = new ContentBlock(this.queuedBlock.id, graphicMediaObj);
            this.player.updateBlock(this.queuedBlock.id, updatedBlock);
            this.queuedBlock = updatedBlock;
        }
    }

    disable() {
        //Cancel all registered listeners
        this.listenerCancellers.map((cancelFunction) => cancelFunction());
        this.listenerCancellers = [];

        if (this.queuedBlock != null) {
            //Dequeue the scheduled MediaObject
            this.player.dequeueBlock(this.queuedBlock);
            this.queuedBlock = null;
        }
    }

    private triggerEvent : () => void;
    setTriggerCallback(onTrigger: () => void) {
        this.triggerEvent = onTrigger;
    }
}
*/