import PrefixedLogger from "./helpers/PrefixedLogger";
import { PublicRerunComponents } from ".";

const colors = require('colors');

type StepFunctionPromise = ((rerunState: PublicRerunComponents, logger: PrefixedLogger) => Promise<void>);
type StepFunctionVoid = ((rerunState: PublicRerunComponents, logger: PrefixedLogger) => void);

export default class StartupSteps {
    private steps : StoredStep[] = [];
    private logger = new PrefixedLogger("Startup");

    constructor(private rerunState: PublicRerunComponents) {}

    private succeededStepsCount = 0;
    
    start() {
        this.succeededStepsCount = 0;

        const asyncSequence = async () => {
            for (let step of this.steps) {
                try {
                    this.logger.info(`Running startup for '${step.key}'`);
                    await step.run(this.rerunState, this.logger.withSuffix(step.key));
                    this.logger.info(`'${step.key}' completed startup`);
                    this.succeededStepsCount++;
                } catch (err) {
                    //A step has failed - abort startup
                    this.logger.error(`Error in '${step.key}'`, err);
                    try {
                        this.cleanupSucceededSteps(); //Run cleanup to gracefully shutdown anything that was set up in previous steps
                    } finally {
                        this.logger.error('An error prevented Rerun from starting properly. Relaunch the app to try again.');
                        process.exit(1);
                    }
                }
            }
        }

        asyncSequence();
    }

    //Clean up all startup steps that have completed successfully
    private cleanupSucceededSteps() {
        for (let i = 0; i < this.succeededStepsCount; i++) {
            this.steps[i].cleanUp();
        }
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

}

class StoredStep {
    constructor(public key: string, public run: StepFunctionPromise, public cleanUp: () => void) {}
}