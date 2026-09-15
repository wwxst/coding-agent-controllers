import type { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type WorkBuddyState } from './control.js';
export interface WorkBuddyControlApi {
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
    result(jobId: string): Promise<object>;
    cancel(jobId: string): Promise<{
        jobId: string;
        stopped: boolean;
    }>;
    resume(jobId: string, prompt: string): Promise<{
        jobId: string;
        sessionId?: string;
        delivered: boolean;
    }>;
    close(): Promise<void>;
}
export declare function createWorkBuddyMcpServer(control: WorkBuddyControlApi, input?: Readable): McpServer;
