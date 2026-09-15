import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
export class HarnessControl {
    createRuntime;
    runtimes = new Map();
    records = new Map();
    constructor(createRuntime = cwd => new DeepSeekHarness({ cwd })) {
        this.createRuntime = createRuntime;
    }
    async run(cwd, prompt) {
        const runtime = this.runtime(cwd);
        const session = runtime.session();
        const record = { session, activity: 'running' };
        this.records.set(session.id, record);
        this.start(record, prompt);
        return { taskId: session.id };
    }
    status(taskId) {
        const record = this.record(taskId);
        return {
            activity: record.activity,
            resultReady: record.output !== undefined || record.error !== undefined,
            ...(record.error === undefined ? {} : { error: record.error }),
        };
    }
    result(taskId) {
        const record = this.record(taskId);
        if (record.output !== undefined)
            return { ready: true, ...record.output };
        if (record.error !== undefined)
            return { ready: true, error: record.error };
        return { ready: false };
    }
    async cancel(taskId) {
        await this.record(taskId).session.cancel();
        return { accepted: true };
    }
    async resume(taskId, prompt) {
        const record = this.record(taskId);
        if (record.activity === 'running')
            throw new Error(`task "${taskId}" is still running`);
        record.activity = 'running';
        record.output = undefined;
        record.error = undefined;
        this.start(record, prompt);
        return { taskId };
    }
    async close() {
        await Promise.all([...this.runtimes.values()].map(runtime => runtime.close()));
    }
    runtime(cwd) {
        let runtime = this.runtimes.get(cwd);
        if (runtime === undefined) {
            runtime = this.createRuntime(cwd);
            this.runtimes.set(cwd, runtime);
        }
        return runtime;
    }
    record(taskId) {
        const record = this.records.get(taskId);
        if (record === undefined)
            throw new Error(`unknown taskId: ${taskId}`);
        return record;
    }
    start(record, prompt) {
        void record.session.run(prompt).then(result => {
            const turnEnd = result.events.findLast(event => event.type === 'turn/end');
            record.output = {
                finalResponse: result.finalResponse,
                ...(turnEnd === undefined ? {} : { turnEndReason: turnEnd.data.reason }),
            };
            record.activity = 'idle';
        }, error => {
            record.error = error instanceof Error ? error.message : String(error);
            record.activity = 'idle';
        });
    }
}
