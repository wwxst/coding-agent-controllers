export type DesktopSessionStatus = 'planning' | 'working' | 'pending' | 'completed' | 'failed' | 'error' | 'terminated' | 'archived';
export type DesktopMode = 'craft' | 'ask' | 'plan' | 'expert';
export type DesktopPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'fullAccess' | 'plan';
export interface DesktopBridge {
    invoke<T>(channel: string, args: unknown[]): Promise<T>;
    invokeDetached(channel: string, args: unknown[]): Promise<void>;
}
export interface DesktopRunOptions {
    cwd: string;
    prompt: string;
    model?: string;
    mode?: DesktopMode;
    permissionMode?: DesktopPermissionMode;
}
export declare class DesktopControl {
    private readonly bridge;
    constructor(bridge: DesktopBridge);
    run(options: DesktopRunOptions): Promise<{
        taskId: string;
        sessionId: string;
    }>;
    status(taskId: string): Promise<{
        taskId: string;
        sessionId: string;
        status: DesktopSessionStatus;
        settled: boolean;
        isProcessing?: boolean;
        pendingInputKind?: string;
    }>;
    result(taskId: string): Promise<object>;
    resume(taskId: string, prompt: string): Promise<{
        taskId: string;
        sessionId: string;
        delivered: true;
    }>;
    cancel(taskId: string): Promise<{
        taskId: string;
        sessionId: string;
        cancelRequested: true;
    }>;
    private getSession;
    private ensureLoaded;
    private loadPersistedRequests;
}
