//Increments a millisecond counter at the specified frequency

export class IntervalMillisCounter {
    private frequencyMs:number;
    private callback:(currentMs:number) => void;
    constructor(frequencyMs:number, callback:(currentMs:number) => void) {
        this.frequencyMs = frequencyMs;
        this.callback = callback;
    }

    private currentCount = 0;

    private lastTickTime:number;
    private interval:NodeJS.Timeout = null;

    start(startValue:number = 0) {
        clearInterval(this.interval);        
        this.currentCount = startValue;
        this.lastTickTime = Date.now();
        this.interval = setInterval(this.tickUp, this.frequencyMs);
    }

    countDownFrom(startValue:number) {
        clearInterval(this.interval); 
        this.currentCount = startValue;
        this.lastTickTime = Date.now();
        this.interval = setInterval(this.tickDown, this.frequencyMs)
    }

    stop() {
        clearInterval(this.interval);
    }

    private tickUp = () => {
        //How much time has passed since the last tick?
        this.currentCount += (Date.now() - this.lastTickTime);
        this.lastTickTime = Date.now();
        this.callback(this.currentCount);
    }

    private tickDown = () => {
        this.currentCount -= (Date.now() - this.lastTickTime);
        this.lastTickTime = Date.now();
        this.callback(this.currentCount);
    }

    getFrequencyMs() : number {
        return this.frequencyMs;
    }
}