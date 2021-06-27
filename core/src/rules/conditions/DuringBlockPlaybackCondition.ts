import { SaveableProperty } from "../../persistence/SaveableObject";
import { IntegerProperty, NumberProperty, StringSelect } from "../../persistence/ValidatedProperty";
import { PlaybackOffset } from "../../playback/Player";
import { RelativeStartType, Player, TempNodeProvider } from "../../playback/Player";
import PlayBlockAction from "../actions/PlayBlockAction";
import ShowGraphicAction from "../actions/ShowGraphicAction";
import RuleAction from "../RuleAction";
import RuleCondition from "../RuleCondition";

/**
 * Trigger the event during a certain point in every nth block.
 */
export default class DuringBlockPlaybackCondition extends RuleCondition {
    @SaveableProperty()
    readonly frequency = new IntegerProperty('Frequency', 1);
    @SaveableProperty()
    readonly playbackOffsetType = new StringSelect('Playback offset type', PlaybackOffset.Type, PlaybackOffset.Type.MsAfterStart);
    @SaveableProperty()
    readonly playbackOffsetSeconds = new NumberProperty('Start offset (secs)', 5);

    constructor(private player: Player) { super(); };

    private tempProviderId : number;
    private recurringListenerId: number;
    private recurringProgressCounter = 0;

    enable(linkedAction: RuleAction): void {
        let selectedOffset = new PlaybackOffset(this.playbackOffsetType.getValue() as PlaybackOffset.Type, this.playbackOffsetSeconds.getValue() * 1000);

        if (ShowGraphicAction.isInstance(linkedAction) || PlayBlockAction.isInstance(linkedAction)) {
            /* For most actions, this condition will just register a RecurringProgressListener with the player and run linkedAction when it fires.
            If we're linked with a ShowGraphic or PlayBlock action, however, we can instead pass the blocks to the Player ahead of time via the 
            TempNodeProvider interface. */

            let contentBlockToPlay = linkedAction.getContentBlock();
            
            let nodeProvider: TempNodeProvider = (queue) => {
                let nodes = [];
                
                for (let i = 0; i < queue.length; i++) {
                    if (i + 1 % this.frequency.getValue() === 0) {
                        nodes.push({
                            block: contentBlockToPlay, relativeTarget: queue[i],
                            startRelationship: RelativeStartType.Concurrent,
                            offset: selectedOffset
                        });
                    }
                }

                return nodes;
            };

            //So for these two action types we never actually trigger linkedAction, instead just pulling the ContentBlock out of it
            this.tempProviderId = this.player.addTempNodeProvider(nodeProvider); 
        } else {
            //The action attached to this condition is just some generic one, so all we have to do is trigger it at the right time
            this.recurringProgressCounter = 0;

            this.recurringListenerId = this.player.onRecurringProgress(selectedOffset, (duringBlock) => {
                this.recurringProgressCounter++;
                if (this.recurringProgressCounter >= this.frequency.getValue()) {
                    this.recurringProgressCounter = 0;
                    linkedAction.run();
                }
            });
        }
    }

    disable(): void {
        if (this.tempProviderId) {
            this.player.removeTempNodeProvider(this.tempProviderId);
            this.tempProviderId = null;
        }
        if (this.recurringListenerId) {
            this.player.offRecurringProgress(this.recurringListenerId);
            this.recurringListenerId = null;
        }
    }
    
}