export type WorkBuddyState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
export type WorkBuddyRequest = (path: string, init?: RequestInit) => Promise<unknown>;
export declare class WorkBuddyControl {
    private readonly request;
    constructor(request: WorkBuddyRequest);
    run(cwd: string, prompt: string): Promise<{
        jobId: string;
    }>;
    status(jobId: string): Promise<{
        jobId: string;
        state: WorkBuddyState;
        settled: boolean;
        status?: string;
        detail?: string;
    }>;
    result(jobId: string): Promise<{
        ready: false;
        jobId: string;
        state: WorkBuddyState;
        settled: false;
        status?: string;
        detail?: string;
    } | {
        ready: true;
        jobId: string;
        state: WorkBuddyState;
        settled: true;
        result?: string;
        status?: string;
        detail?: string;
    }>;
    cancel(jobId: string): Promise<{
        jobId: string;
        stopped: boolean;
    }>;
    resume(jobId: string, prompt: string): Promise<{
        jobId: string;
        sessionId?: string;
        delivered: boolean;
    }>;
    private job;
    private transcriptResult;
    private data;
}
