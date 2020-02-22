export default class PrefixedLogger {
    private prefix: string;
    constructor (loggerName: string) {
        this.prefix = "[" + loggerName + "] ";
    }

    info(message: string) : void;
    info(object: any) : void;
    info(message: string, object: any) : void; 

    info(message?: string, object?: any) {
        if (object) {
            console.info(this.prefix + message, object);
        } else {
            console.info(this.prefix + message);
        }
    }

    
    warn(message: string) : void;
    warn(object: any) : void;
    warn(message: string, object: any) : void; 

    warn(message?: string, object?: any) {
        if (object) {
            console.warn(this.prefix + message, object);
        } else {
            console.warn(this.prefix + message);
        }
    }

    error(message: string) : void;
    error(object: any) : void;
    error(message: string, object: any) : void; 

    error(message?: string, object?: any) {
        if (object) {
            console.error(this.prefix + message, object);
        } else {
            console.error(this.prefix + message);
        }
    }
}