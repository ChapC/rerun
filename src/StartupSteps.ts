import PrefixedLogger from "./helpers/PrefixedLogger";
import { RerunStateObject } from ".";
import readline from 'readline';
import process from 'process';

const colors = require('colors');

type stepFunction = ((rerunState: RerunStateObject, logger: PrefixedLogger) => Promise<void>);
export default class StartupSteps {
    private steps : StoredStep[] = [];
    private logger = new PrefixedLogger("Startup");

    constructor(private rerunState: RerunStateObject) {}

    appendStep(stepKey: string, step: stepFunction, cleanUp: () => void) {
        this.steps.push(new StoredStep(stepKey, step, cleanUp));
    }

    private getIndexOrDefault(targetKey: string, defaultIndex: number) {
        //Find the target step
        let targetIndex = defaultIndex;
        for (let i = 0; i < this.steps.length; i++) {
            if (this.steps[i].key === targetKey) {
                targetIndex = i;
                break;
            }
        }
        return targetIndex;
    }

    insertStepBefore(beforeKey: string, stepKey: string, step: stepFunction, cleanUp: () => void) {
        this.steps.splice(this.getIndexOrDefault(beforeKey, this.steps.length), 0, new StoredStep(stepKey, step, cleanUp));
    }

    insertStepAfter(afterKey: string, stepKey: string, step: stepFunction, cleanUp: () => void) {
        let targetIndex = this.getIndexOrDefault(afterKey, -1);
        if (targetIndex === -1) {
            throw new Error("Couldn't insert step before '" + afterKey + "'. No step with that key is registered.");
        }
        this.steps.splice(targetIndex, 0, new StoredStep(stepKey, step, cleanUp));
    }

    private succeededStepsCount = 0;
    private startupFailed = false;

    didStartSuccessfully() {
        return !this.startupFailed && this.succeededStepsCount == this.steps.length
    }
    
    start() {
        this.cleanupSucceededSteps();
        this.startupFailed = false;
        this.succeededStepsCount = 0;
        const startPromises = this.steps.reduce((promiseChain: any, currentStep: StoredStep, currentIndex, array) => {
            return promiseChain.then(() => {
                if (!this.startupFailed) {
                    return currentStep.run(this.rerunState, new PrefixedLogger("Startup-" + currentStep.key)).then(() => this.succeededStepsCount++);
                }
            }).catch((error: any) => {
                this.logger.error(colors.red("Failed to start Rerun - error in " + currentStep.key, error));
                this.startupFailed = true;
            })
        }, Promise.resolve());

        startPromises.then(() => {
            if (!this.startupFailed) {
                console.info(colors.green('Rerun ready!'));
            } else {
                console.info("An error prevented Rerun from starting properly. Press enter to try again or Ctrl+C to exit...");

                readline.emitKeypressEvents(process.stdin);
                process.stdin.setRawMode(true);
                process.stdin.on('keypress', (chunk, key) => this.restartOrCancel(chunk, key));
            }
        });
    }

    //Clean up all the completed steps
    private cleanupSucceededSteps() {
        for (let i = 0; i < this.succeededStepsCount; i++) {
            this.steps[i].cleanUp();
        }
    }
    
    private restartOrCancel(chunk: any, key: any) {
        if (key) {
            if (key.name === "c" && key.ctrl) {
                process.stdin.off('keypress', (chunk, key) => this.restartOrCancel(chunk, key));
                process.stdin.setRawMode(false);
                
                //Quit
                console.info('Shutdown');
                this.cleanupSucceededSteps();
                process.exit();
            } else if (key.name === "return" || key.name === "enter") {
                process.stdin.off('keypress', (chunk, key) => this.restartOrCancel(chunk, key));
                process.stdin.setRawMode(false);

                console.info('Restarting...');
                this.cleanupSucceededSteps();
                this.start();
            }
        }
    }
}

class StoredStep {
    constructor(public key: string, public run: stepFunction, public cleanUp: () => void) {}
}