import type { Readable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export interface HarnessControlApi {
    run(cwd: string, prompt: string): Promise<{
        taskId: string;
    }>;
    status(taskId: string): object;
    result(taskId: string): object;
    cancel(taskId: string): Promise<{
        accepted: true;
    }>;
    resume(taskId: string, prompt: string): Promise<{
        taskId: string;
    }>;
    close(): Promise<void>;
}
export declare function createHarnessMcpServer(control: HarnessControlApi, input?: Readable): McpServer;
