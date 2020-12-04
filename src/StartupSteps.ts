import PrefixedLogger from "./helpers/PrefixedLogger";
import { PublicRerunComponents } from ".";
import process from 'process';

const keypress = require('keypress');
const colors = require('colors');

type StepFunctionPromise = ((rerunState: PublicRerunComponents, logger: PrefixedLogger) => Promise<void>);
type StepFunctionVoid = ((rerunState: PublicRerunComponents, logger: PrefixedLogger) => void);
export default class StartupSteps {
    private steps : StoredStep[] = [];
    private logger = new PrefixedLogger("Startup");

    constructor(private rerunState: PublicRerunComponents) {
        keypress(process.stdin);
    }

    appendStep(stepKey: string, step: StepFunctionPromise, cleanUp: () => void) {
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

    insertStepBefore(beforeKey: string, stepKey: string, step: StepFunctionPromise, cleanUp: () => void) {
        this.steps.splice(this.getIndexOrDefault(beforeKey, this.steps.length), 0, new StoredStep(stepKey, step, cleanUp));
    }

    insertStepAfter(afterKey: string, stepKey: string, step: StepFunctionPromise, cleanUp: () => void) {
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
        process.stdin.off('keypress', this.restartOrCancel);
        this.startupFailed = false;
        this.succeededStepsCount = 0;
        const startPromises = this.steps.reduce((promiseChain: any, currentStep: StoredStep, currentIndex, array) => {
            return promiseChain.then(() => {
                if (!this.startupFailed) {
                    return currentStep.run(this.rerunState, new PrefixedLogger("Startup-" + currentStep.key)).then(() => this.succeededStepsCount++);
                } else {
                    return Promise.reject();
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
                console.info("An error prevented Rerun from starting properly. Press enter to try again or Ctrl+C to exit.");
                process.stdin.on('keypress', this.restartOrCancel);          
            }
        });
    }

    //Clean up all the completed steps
    private cleanupSucceededSteps() {
        for (let i = 0; i < this.succeededStepsCount; i++) {
            this.steps[i].cleanUp();
        }
    }
    
    private restartOrCancel = (chunk: any, key: any) => {
        if (key) {
            if (key.name === "c" && key.ctrl) {
                process.stdin.off('keypress', this.restartOrCancel);

                //Quit
                console.info('Shutdown');
                this.cleanupSucceededSteps();
                process.exit();
            } else if (key.name === "return" || key.name === "enter" || key.name === 'm') {//Keypress returns the 'm' key instead of enter on my system?
                console.info('Restarting...\n');
                this.cleanupSucceededSteps();
                this.start();
            }
        }
    }
}

class StoredStep {
    constructor(public key: string, public run: StepFunctionPromise, public cleanUp: () => void) {}
}