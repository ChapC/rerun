export class ScheduleChange {
    readonly queueIdToMove: number; //The ID of the item to be moved
    readonly queueIdTarget: number; //The ID of the item the moved one should be placed next to
    readonly placeBefore: boolean; //Where to place the moved item relative to the target. true for before, false for after.

    static isInstance(obj: any) : obj is ScheduleChange {
        return (typeof obj.queueIdToMove) === 'number' 
            && (typeof obj.queueIdTarget) === 'number'
            && (typeof obj.placeBefore) === 'boolean';
    }
}