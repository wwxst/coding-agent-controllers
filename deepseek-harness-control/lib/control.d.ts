import { type RunResult } from '@deepseek-ai/dsh-sdk-client';
export interface HarnessSessionHandle {
    readonly id: string;
    run(prompt: string): Promise<RunResult>;
    cancel(): Promise<void>;
}
export interface HarnessRuntime {
    session(sessionId?: string): HarnessSessionHandle;
    close(): Promise<void>;
}
export declare class HarnessControl {
    private readonly createRuntime;
    private readonly runtimes;
    private readonly records;
    constructor(createRuntime?: (cwd: string) => HarnessRuntime);
    run(cwd: string, prompt: string): Promise<{
        taskId: string;
    }>;
    status(taskId: string): {
        activity: 'running' | 'idle';
        resultReady: boolean;
        error?: string;
    };
    result(taskId: string): {
        ready: false;
    } | {
        ready: true;
        finalResponse?: string;
        turnEndReason?: unknown;
        error?: string;
    };
    cancel(taskId: string): Promise<{
        accepted: true;
    }>;
    resume(taskId: string, prompt: string): Promise<{
        taskId: string;
    }>;
    close(): Promise<void>;
    private runtime;
    private record;
    private start;
}
