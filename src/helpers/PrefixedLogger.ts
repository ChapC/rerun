const colors = require('colors');

export default class PrefixedLogger {
    private prefix: string;
    constructor (private loggerName: string) {
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
            console.warn(colors.yellow(this.prefix + message), object);
        } else {
            console.warn(colors.yellow(this.prefix + message));
        }
    }

    error(message: string) : void;
    error(object: any) : void;
    error(message: string, object: any) : void; 

    error(message?: string, object?: any) {
        if (object) {
            console.error(colors.red(this.prefix + message), object);
        } else {
            console.error(colors.red(this.prefix + message));
        }
    }

    debug(message: string) : void;
    debug(object: any) : void;
    debug(message: string, object: any) : void; 

    debug(message?: string, object?: any) {
        if (object) {
            console.debug(colors.grey(this.prefix + message), object);
        } else {
            console.debug(colors.grey(this.prefix + message));
        }
    }

    withSuffix(addedSuffix: string) : PrefixedLogger {
        return new PrefixedLogger(`${this.loggerName}-${addedSuffix}`);
    }
}