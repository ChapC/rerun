//An array that stays at a fixed size by removing the oldest elements
export class Stack<ElementType> {
    private array : ElementType[] = [];
    private stackSize : number;

    constructor(stackSize: number) {
        this.stackSize = stackSize;
    }

    push(element: ElementType) {
        this.array.push(element);
        this.popToSize();
    }

    getTop() : ElementType {
        if (this.array.length === 0) {
            return null;
        }
        return this.array[this.array.length - 1];
    }

    resizeTo(newSize: number) {
        this.stackSize = newSize;
        this.popToSize();
    }

    getStackSize() {
        return this.stackSize;
    }

    clear() {
        this.array = [];
    }

    getElements() : ElementType[] {
        return Array.from(this.array);
    }

    private popToSize() {
        if (this.stackSize <= 0) {
            this.array = [];
            return;
        }

        while (this.array.length > this.stackSize) {
            this.array.shift();
        }

        console.info('done popping');
    }
}