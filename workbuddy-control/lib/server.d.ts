import type { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type WorkBuddyState } from './control.js';
import { type DesktopRunOptions, type DesktopStatusResult } from './desktop-control.js';
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
    runDesktop(options: DesktopRunOptions): Promise<{
        taskId: string;
        sessionId: string;
    }>;
    statusDesktop(taskId: string): Promise<DesktopStatusResult>;
    resultDesktop(taskId: string): Promise<object>;
    cancelDesktop(taskId: string): Promise<{
        taskId: string;
        sessionId: string;
        cancelRequested: true;
    }>;
    resumeDesktop(taskId: string, prompt: string): Promise<{
        taskId: string;
        sessionId: string;
        delivered: true;
    }>;
    close(): Promise<void>;
}
export declare function createWorkBuddyMcpServer(control: WorkBuddyControlApi, input?: Readable): McpServer;
