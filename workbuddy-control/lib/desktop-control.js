const terminalStatuses = new Set([
    'completed', 'failed', 'error', 'terminated', 'archived',
]);
const historyPageByteLength = 5 * 1024 * 1024;
const historyReadyTimeoutMs = 30_000;
const stalledThresholdMs = 5 * 60 * 1_000;
const activeToolStatuses = new Set(['pending', 'in_progress']);
const taskOutputToolName = 'TaskOutput';
export class DesktopControl {
    bridge;
    constructor(bridge) {
        this.bridge = bridge;
    }
    async run(options) {
        const session = await this.bridge.invoke('session:create', [{
                cwd: options.cwd,
                model: options.model ?? 'deepseek-v4.1-flash',
                mode: options.mode ?? 'craft',
                permissionMode: options.permissionMode ?? 'default',
            }]);
        await this.bridge.invokeDetached('session:sendMessage', [session.sessionId, options.prompt]);
        return { taskId: session.sessionId, sessionId: session.sessionId };
    }
    async status(taskId) {
        const session = await this.getSession(taskId);
        const currentTool = session.hasActiveToolCalls !== false && Array.isArray(session.eventHistory)
            ? currentActiveTool(session.eventHistory)
            : undefined;
        const latestActivityAt = latestValidTimestamp(session.lastActivityAt, session.lastBackendActivityAt);
        const stalledForMs = session.isProcessing === true
            && session.pendingInputKind === undefined
            && latestActivityAt !== undefined
            ? Date.now() - latestActivityAt
            : undefined;
        const stalled = stalledForMs !== undefined && stalledForMs >= stalledThresholdMs;
        const waitingTaskOutput = currentTool?.name === taskOutputToolName
            ? true
            : currentTool !== undefined || session.hasActiveToolCalls === false
                ? false
                : undefined;
        return {
            taskId,
            sessionId: session.sessionId,
            status: session.status,
            settled: terminalStatuses.has(session.status),
            ...(session.isProcessing === undefined ? {} : { isProcessing: session.isProcessing }),
            ...(session.pendingInputKind === undefined ? {} : { pendingInputKind: session.pendingInputKind }),
            ...(session.hasActiveToolCalls === undefined ? {} : { hasActiveToolCalls: session.hasActiveToolCalls }),
            ...(session.lastActivityAt === undefined ? {} : { lastActivityAt: session.lastActivityAt }),
            ...(session.lastBackendActivityAt === undefined ? {} : { lastBackendActivityAt: session.lastBackendActivityAt }),
            ...(currentTool?.name === undefined ? {} : { currentTool: currentTool.name }),
            ...(currentTool === undefined ? {} : { currentToolCallId: currentTool.toolCallId }),
            ...(waitingTaskOutput === undefined ? {} : { waitingTaskOutput }),
            ...(stalled ? { stalled: true, stalledForMs } : {}),
        };
    }
    async result(taskId) {
        const session = await this.getSession(taskId);
        const settled = terminalStatuses.has(session.status);
        const base = {
            taskId,
            sessionId: session.sessionId,
            status: session.status,
            settled,
        };
        if (!settled)
            return { ready: false, ...base };
        const result = Array.isArray(session.eventHistory)
            ? latestAssistantText(session.eventHistory)
            : latestPersistedAssistantText(await this.loadPersistedRequests(session.sessionId));
        return { ready: true, ...base, ...(result === undefined ? {} : { result }) };
    }
    async resume(taskId, prompt) {
        const current = await this.getSession(taskId);
        this.assertNotProcessing(current);
        const session = await this.ensureLoaded(current);
        this.assertNotProcessing(session);
        await this.bridge.invokeDetached('session:sendMessage', [session.sessionId, prompt]);
        return { taskId, sessionId: session.sessionId, delivered: true };
    }
    async cancel(taskId) {
        await this.bridge.invoke('session:cancel', [taskId]);
        return { taskId, sessionId: taskId, cancelRequested: true };
    }
    async getSession(taskId) {
        const session = await this.bridge.invoke('session:get', [taskId]);
        if (session === null)
            throw new Error(`WorkBuddy Desktop Session was not found: ${taskId}`);
        return session;
    }
    async ensureLoaded(session) {
        if (Array.isArray(session.eventHistory))
            return session;
        if (session.cwd === undefined)
            throw new Error(`WorkBuddy Desktop Session has no cwd: ${session.sessionId}`);
        return this.bridge.invoke('session:load', [session.sessionId, { cwd: session.cwd }]);
    }
    assertNotProcessing(session) {
        if (session.isProcessing === true) {
            throw new Error('Session is still processing. Wait for completion or cancel before resume.');
        }
    }
    async loadPersistedRequests(sessionId) {
        const deadline = Date.now() + historyReadyTimeoutMs;
        while (true) {
            const page = await this.bridge.invoke('wb:conversations:requestEntries', [sessionId, { byteLength: historyPageByteLength }]);
            if (page.historyReady)
                return page;
            if (Date.now() >= deadline)
                throw new Error(`WorkBuddy Desktop Session history did not become ready: ${sessionId}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
}
function currentActiveTool(events) {
    const tools = new Map();
    events.forEach((event, index) => {
        const update = event.update;
        if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update')
            return;
        if (typeof update.toolCallId !== 'string')
            return;
        const previous = tools.get(update.toolCallId);
        const metaToolName = update._meta?.['codebuddy.ai/toolName'];
        const name = typeof metaToolName === 'string'
            ? metaToolName
            : update.toolName ?? update.title ?? previous?.name;
        tools.set(update.toolCallId, {
            toolCallId: update.toolCallId,
            ...(name === undefined ? {} : { name }),
            status: update.status ?? previous?.status,
            index,
        });
    });
    return [...tools.values()]
        .filter(tool => tool.status !== undefined && activeToolStatuses.has(tool.status))
        .sort((left, right) => right.index - left.index)[0];
}
function latestValidTimestamp(...values) {
    const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
    return valid.length === 0 ? undefined : Math.max(...valid);
}
function latestAssistantText(events) {
    const lastUserIndex = events.findLastIndex(event => event.update?.sessionUpdate === 'user_message_chunk');
    const chunks = events.slice(lastUserIndex + 1).flatMap(event => {
        if (event.update?.sessionUpdate !== 'agent_message_chunk')
            return [];
        const contents = Array.isArray(event.update.content) ? event.update.content : [event.update.content];
        return contents.flatMap(content => content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []);
    });
    return chunks.length === 0 ? undefined : chunks.join('');
}
function latestPersistedAssistantText(page) {
    const chunks = page.requests.at(-1)?.assistantMessage?.content.flatMap(content => content.type === 'text' && typeof content.text === 'string' ? [content.text] : []) ?? [];
    return chunks.length === 0 ? undefined : chunks.join('');
}
