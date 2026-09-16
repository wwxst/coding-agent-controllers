import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkBuddyControl } from './control.js';
import { DesktopControl, } from './desktop-control.js';
import { DesktopPipeClient } from './desktop-transport.js';
import { startWorkBuddy } from './process.js';
const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const actionAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};
function toolResult(value) {
    const structuredContent = { ...value };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}
export function createWorkBuddyMcpServer(control, input) {
    const server = new McpServer({ name: 'workbuddy-control', version: '0.1.0' }, { instructions: 'Control the official WorkBuddy Jobs API. A jobId is the WorkBuddy job id.' });
    server.registerTool('workbuddy_run', {
        description: 'Start a WorkBuddy Job with the first-phase model, effort, and permission defaults.',
        inputSchema: { cwd: z.string().min(1), prompt: z.string().min(1) },
        annotations: actionAnnotations,
    }, async ({ cwd, prompt }) => toolResult(await control.run(cwd, prompt)));
    server.registerTool('workbuddy_status', {
        description: 'Read the WorkBuddy Job state and settled flag without inventing status.',
        inputSchema: { jobId: z.string().min(1) },
        annotations: readOnlyAnnotations,
    }, async ({ jobId }) => toolResult(await control.status(jobId)));
    server.registerTool('workbuddy_result', {
        description: 'Read the current final Assistant result when the WorkBuddy Job is settled.',
        inputSchema: { jobId: z.string().min(1) },
        annotations: readOnlyAnnotations,
    }, async ({ jobId }) => toolResult(await control.result(jobId)));
    server.registerTool('workbuddy_cancel', {
        description: 'Send the official stop request; use status for the final Job state.',
        inputSchema: { jobId: z.string().min(1) },
        annotations: actionAnnotations,
    }, async ({ jobId }) => toolResult(await control.cancel(jobId)));
    server.registerTool('workbuddy_resume', {
        description: 'Reply to an existing WorkBuddy Job and retain its jobId and sessionId.',
        inputSchema: { jobId: z.string().min(1), prompt: z.string().min(1) },
        annotations: actionAnnotations,
    }, async ({ jobId, prompt }) => toolResult(await control.resume(jobId, prompt)));
    server.registerTool('workbuddy_run_desktop', {
        description: 'Create a real WorkBuddy Desktop Session and send its first prompt through the Desktop Extension.',
        inputSchema: {
            cwd: z.string().min(1),
            prompt: z.string().min(1),
            model: z.string().min(1).optional(),
            mode: z.enum(['craft', 'ask', 'plan', 'expert']).optional(),
            permissionMode: z.enum([
                'default', 'acceptEdits', 'bypassPermissions', 'fullAccess', 'plan',
            ]).optional(),
        },
        annotations: actionAnnotations,
    }, async (options) => toolResult(await control.runDesktop(options)));
    server.registerTool('workbuddy_status_desktop', {
        description: 'Read status directly from the real WorkBuddy Desktop Session.',
        inputSchema: { taskId: z.string().min(1) },
        annotations: readOnlyAnnotations,
    }, async ({ taskId }) => toolResult(await control.statusDesktop(taskId)));
    server.registerTool('workbuddy_result_desktop', {
        description: 'Read only the latest final Assistant text from the real WorkBuddy Desktop Session.',
        inputSchema: { taskId: z.string().min(1) },
        annotations: readOnlyAnnotations,
    }, async ({ taskId }) => toolResult(await control.resultDesktop(taskId)));
    server.registerTool('workbuddy_cancel_desktop', {
        description: 'Request cancellation of the active turn in the real WorkBuddy Desktop Session.',
        inputSchema: { taskId: z.string().min(1) },
        annotations: actionAnnotations,
    }, async ({ taskId }) => toolResult(await control.cancelDesktop(taskId)));
    server.registerTool('workbuddy_resume_desktop', {
        description: 'Send a follow-up prompt to the same real WorkBuddy Desktop Session.',
        inputSchema: { taskId: z.string().min(1), prompt: z.string().min(1) },
        annotations: actionAnnotations,
    }, async ({ taskId, prompt }) => toolResult(await control.resumeDesktop(taskId, prompt)));
    const closeTransport = server.close.bind(server);
    let shutdown;
    const close = () => {
        shutdown ??= (async () => {
            await control.close();
            await closeTransport();
        })();
        return shutdown;
    };
    server.close = close;
    server.server.onclose = () => { void close(); };
    input?.once('end', () => { void close(); });
    return server;
}
async function main() {
    const service = await startWorkBuddy();
    const control = new WorkBuddyControl(service.request);
    const desktopControl = new DesktopControl(new DesktopPipeClient());
    const api = {
        run: control.run.bind(control),
        status: control.status.bind(control),
        result: control.result.bind(control),
        cancel: control.cancel.bind(control),
        resume: control.resume.bind(control),
        runDesktop: desktopControl.run.bind(desktopControl),
        statusDesktop: desktopControl.status.bind(desktopControl),
        resultDesktop: desktopControl.result.bind(desktopControl),
        cancelDesktop: desktopControl.cancel.bind(desktopControl),
        resumeDesktop: desktopControl.resume.bind(desktopControl),
        close: service.close,
    };
    const server = createWorkBuddyMcpServer(api, process.stdin);
    try {
        await server.connect(new StdioServerTransport());
    }
    catch (error) {
        await service.close();
        throw error;
    }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
