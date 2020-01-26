export class ScheduleChange {
    contentBlockId: string
    fromIndex: number
    toIndex: number

    static makeNew(sourceObject: any) : ScheduleChange {
        let change = new ScheduleChange();
        change.contentBlockId = sourceObject.contentBlockId;
        change.fromIndex = sourceObject.fromIndex;
        change.toIndex = sourceObject.toIndex;

        if (change.contentBlockId == null || change.fromIndex == null || change.toIndex == null) {
            return null;
        }

        return change;
    }
}