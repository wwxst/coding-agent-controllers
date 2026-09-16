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
/**
 * 当前 Turn 的真实活动类别。它由控制层从语义信号推导，不依赖 WorkBuddy 的传输层时间戳，
 * 因此调用方可以区分「模型在生成」「真实工具在执行」「等待 TaskOutput」和「空转」。
 */
export type DesktopActivity = 'model-generating' | 'tool-executing' | 'waiting-task-output' | 'awaiting-input' | 'idle' | 'unknown';
export interface DesktopStatusResult {
    taskId: string;
    sessionId: string;
    status: DesktopSessionStatus;
    settled: boolean;
    isProcessing?: boolean;
    pendingInputKind?: string;
    hasActiveToolCalls?: boolean;
    /** WorkBuddy 导出的会话活动时间（已持久化的语义活动，长时间不变属于正常）。 */
    lastActivityAt?: number;
    /**
     * WorkBuddy 导出的后端传输活动时间。它由 prompt 传输帧（含心跳）刷新，
     * 只代表传输层有数据，不代表模型或工具真实进展；本层不把它用于 stalled 判定。
     */
    lastBackendActivityAt?: number;
    currentTool?: string;
    currentToolCallId?: string;
    /**
     * 与 `activity` 同源推导：`activity === 'waiting-task-output'` 时为 true，
     * 已明确没有活动工具时为 false，无法判定时省略（不猜测）。
     */
    waitingTaskOutput?: boolean;
    /** 当前活动类别；每次 status 都会返回。 */
    activity: DesktopActivity;
    /** 本次 status 读取时刻，供调用方计算自身观察窗口。 */
    polledAt: number;
    /** 控制层最近一次观察到语义进展的时间，不会被 status 查询自身刷新。 */
    lastProgressAt?: number;
    /** 处理中且距最近一次语义进展的时长；未处理时为 undefined。 */
    stalledForMs?: number;
    /** 是否已达到 stalled 阈值；每次 status 都会返回，不再只在为真时出现。 */
    stalled: boolean;
    stalledReason?: 'no-assistant-or-tool-progress';
}
/**
 * 取不到最终 Assistant 文本时的明确原因。调用方据此可以区分
 * 「本轮根本没正常完结（例如被取消）」和「本轮完结了但没有任何用户可见正文」，
 * 不需要也不允许拿中间叙述冒充最终结果。
 */
export type DesktopResultUnavailableReason = 'turn-not-finalized' | 'no-visible-assistant-text';
export type DesktopResult = {
    ready: false;
    taskId: string;
    sessionId: string;
    status: DesktopSessionStatus;
    settled: false;
} | {
    ready: true;
    taskId: string;
    sessionId: string;
    status: DesktopSessionStatus;
    settled: true;
    result: string;
} | {
    ready: true;
    taskId: string;
    sessionId: string;
    status: DesktopSessionStatus;
    settled: true;
    resultAvailable: false;
    resultReason: DesktopResultUnavailableReason;
};
export declare class DesktopControl {
    private readonly bridge;
    private readonly progress;
    constructor(bridge: DesktopBridge);
    run(options: DesktopRunOptions): Promise<{
        taskId: string;
        sessionId: string;
    }>;
    status(taskId: string): Promise<DesktopStatusResult>;
    result(taskId: string): Promise<DesktopResult>;
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
    private assertNotProcessing;
    private loadPersistedRequests;
}
