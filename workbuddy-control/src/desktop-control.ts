export type DesktopSessionStatus =
  | 'planning'
  | 'working'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'error'
  | 'terminated'
  | 'archived'

export type DesktopMode = 'craft' | 'ask' | 'plan' | 'expert'
export type DesktopPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'fullAccess' | 'plan'

export interface DesktopBridge {
  invoke<T>(channel: string, args: unknown[]): Promise<T>
  invokeDetached(channel: string, args: unknown[]): Promise<void>
}

export interface DesktopRunOptions {
  cwd: string
  prompt: string
  model?: string
  mode?: DesktopMode
  permissionMode?: DesktopPermissionMode
}

interface SessionEvent {
  update?: {
    sessionUpdate?: string
    content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }>
    toolCallId?: string
    toolName?: string
    title?: string
    status?: string
    _meta?: Record<string, unknown>
  }
}

interface DesktopSession {
  id?: string
  sessionId: string
  cwd?: string
  status: DesktopSessionStatus
  isProcessing?: boolean
  pendingInputKind?: string
  hasActiveToolCalls?: boolean
  lastActivityAt?: number
  lastBackendActivityAt?: number
  eventHistory?: SessionEvent[]
}

export interface DesktopStatusResult {
  taskId: string
  sessionId: string
  status: DesktopSessionStatus
  settled: boolean
  isProcessing?: boolean
  pendingInputKind?: string
  hasActiveToolCalls?: boolean
  lastActivityAt?: number
  lastBackendActivityAt?: number
  currentTool?: string
  currentToolCallId?: string
  waitingTaskOutput?: boolean
  stalled?: true
  stalledForMs?: number
}

interface ConversationRequestEntriesPage {
  historyReady: boolean
  requests: Array<{
    assistantMessage?: {
      content: Array<{ type?: string; text?: string }>
    }
  }>
}

const terminalStatuses = new Set<DesktopSessionStatus>([
  'completed', 'failed', 'error', 'terminated', 'archived',
])
const historyPageByteLength = 5 * 1024 * 1024
const historyReadyTimeoutMs = 30_000
const stalledThresholdMs = 5 * 60 * 1_000
const activeToolStatuses = new Set(['pending', 'in_progress'])
const taskOutputToolName = 'TaskOutput'

export class DesktopControl {
  constructor(private readonly bridge: DesktopBridge) {}

  async run(options: DesktopRunOptions): Promise<{ taskId: string; sessionId: string }> {
    const session = await this.bridge.invoke<DesktopSession>('session:create', [{
      cwd: options.cwd,
      model: options.model ?? 'deepseek-v4.1-flash',
      mode: options.mode ?? 'craft',
      permissionMode: options.permissionMode ?? 'default',
    }])
    await this.bridge.invokeDetached('session:sendMessage', [session.sessionId, options.prompt])
    return { taskId: session.sessionId, sessionId: session.sessionId }
  }

  async status(taskId: string): Promise<DesktopStatusResult> {
    const session = await this.getSession(taskId)
    const currentTool = session.hasActiveToolCalls !== false && Array.isArray(session.eventHistory)
      ? currentActiveTool(session.eventHistory)
      : undefined
    const latestActivityAt = latestValidTimestamp(session.lastActivityAt, session.lastBackendActivityAt)
    const stalledForMs = session.isProcessing === true
      && session.pendingInputKind === undefined
      && latestActivityAt !== undefined
      ? Date.now() - latestActivityAt
      : undefined
    const stalled = stalledForMs !== undefined && stalledForMs >= stalledThresholdMs
    const waitingTaskOutput = currentTool?.name === taskOutputToolName
      ? true
      : currentTool !== undefined || session.hasActiveToolCalls === false
        ? false
        : undefined
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
      ...(stalled ? { stalled: true as const, stalledForMs } : {}),
    }
  }

  async result(taskId: string): Promise<object> {
    const session = await this.getSession(taskId)
    const settled = terminalStatuses.has(session.status)
    const base = {
      taskId,
      sessionId: session.sessionId,
      status: session.status,
      settled,
    }
    if (!settled) return { ready: false, ...base }
    const result = Array.isArray(session.eventHistory)
      ? latestAssistantText(session.eventHistory)
      : latestPersistedAssistantText(await this.loadPersistedRequests(session.sessionId))
    return { ready: true, ...base, ...(result === undefined ? {} : { result }) }
  }

  async resume(taskId: string, prompt: string): Promise<{
    taskId: string
    sessionId: string
    delivered: true
  }> {
    const current = await this.getSession(taskId)
    this.assertNotProcessing(current)
    const session = await this.ensureLoaded(current)
    this.assertNotProcessing(session)
    await this.bridge.invokeDetached('session:sendMessage', [session.sessionId, prompt])
    return { taskId, sessionId: session.sessionId, delivered: true }
  }

  async cancel(taskId: string): Promise<{
    taskId: string
    sessionId: string
    cancelRequested: true
  }> {
    await this.bridge.invoke('session:cancel', [taskId])
    return { taskId, sessionId: taskId, cancelRequested: true }
  }

  private async getSession(taskId: string): Promise<DesktopSession> {
    const session = await this.bridge.invoke<DesktopSession | null>('session:get', [taskId])
    if (session === null) throw new Error(`WorkBuddy Desktop Session was not found: ${taskId}`)
    return session
  }

  private async ensureLoaded(session: DesktopSession): Promise<DesktopSession> {
    if (Array.isArray(session.eventHistory)) return session
    if (session.cwd === undefined) throw new Error(`WorkBuddy Desktop Session has no cwd: ${session.sessionId}`)
    return this.bridge.invoke<DesktopSession>('session:load', [session.sessionId, { cwd: session.cwd }])
  }

  private assertNotProcessing(session: DesktopSession): void {
    if (session.isProcessing === true) {
      throw new Error('Session is still processing. Wait for completion or cancel before resume.')
    }
  }

  private async loadPersistedRequests(sessionId: string): Promise<ConversationRequestEntriesPage> {
    const deadline = Date.now() + historyReadyTimeoutMs
    while (true) {
      const page = await this.bridge.invoke<ConversationRequestEntriesPage>(
        'wb:conversations:requestEntries',
        [sessionId, { byteLength: historyPageByteLength }],
      )
      if (page.historyReady) return page
      if (Date.now() >= deadline) throw new Error(`WorkBuddy Desktop Session history did not become ready: ${sessionId}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

function currentActiveTool(events: SessionEvent[]): { toolCallId: string; name?: string } | undefined {
  const tools = new Map<string, { toolCallId: string; name?: string; status?: string; index: number }>()
  events.forEach((event, index) => {
    const update = event.update
    if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') return
    if (typeof update.toolCallId !== 'string') return
    const previous = tools.get(update.toolCallId)
    const metaToolName = update._meta?.['codebuddy.ai/toolName']
    const name = typeof metaToolName === 'string'
      ? metaToolName
      : update.toolName ?? update.title ?? previous?.name
    tools.set(update.toolCallId, {
      toolCallId: update.toolCallId,
      ...(name === undefined ? {} : { name }),
      status: update.status ?? previous?.status,
      index,
    })
  })
  return [...tools.values()]
    .filter(tool => tool.status !== undefined && activeToolStatuses.has(tool.status))
    .sort((left, right) => right.index - left.index)[0]
}

function latestValidTimestamp(...values: Array<number | undefined>): number | undefined {
  const valid = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0)
  return valid.length === 0 ? undefined : Math.max(...valid)
}

function latestAssistantText(events: SessionEvent[]): string | undefined {
  const lastUserIndex = events.findLastIndex(event => event.update?.sessionUpdate === 'user_message_chunk')
  const chunks = events.slice(lastUserIndex + 1).flatMap(event => {
    if (event.update?.sessionUpdate !== 'agent_message_chunk') return []
    const contents = Array.isArray(event.update.content) ? event.update.content : [event.update.content]
    return contents.flatMap(content => content?.type === 'text' && typeof content.text === 'string' ? [content.text] : [])
  })
  return chunks.length === 0 ? undefined : chunks.join('')
}

function latestPersistedAssistantText(page: ConversationRequestEntriesPage): string | undefined {
  const chunks = page.requests.at(-1)?.assistantMessage?.content.flatMap(content =>
    content.type === 'text' && typeof content.text === 'string' ? [content.text] : [],
  ) ?? []
  return chunks.length === 0 ? undefined : chunks.join('')
}
