export class ScheduleChange {
    readonly contentBlockId: string
    readonly fromIndex: number
    readonly toIndex: number

    static isInstance(obj: any) : obj is ScheduleChange {
        return (typeof obj.contentBlockId) === 'string' 
            && (typeof obj.fromIndex) === 'number'
            && (typeof obj.toIndex) === 'number';
    }
}