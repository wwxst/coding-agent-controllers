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
  }
}

interface DesktopSession {
  id?: string
  sessionId: string
  cwd?: string
  status: DesktopSessionStatus
  isProcessing?: boolean
  pendingInputKind?: string
  eventHistory?: SessionEvent[]
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

  async status(taskId: string): Promise<{
    taskId: string
    sessionId: string
    status: DesktopSessionStatus
    settled: boolean
    isProcessing?: boolean
    pendingInputKind?: string
  }> {
    const session = await this.getSession(taskId)
    return {
      taskId,
      sessionId: session.sessionId,
      status: session.status,
      settled: terminalStatuses.has(session.status),
      ...(session.isProcessing === undefined ? {} : { isProcessing: session.isProcessing }),
      ...(session.pendingInputKind === undefined ? {} : { pendingInputKind: session.pendingInputKind }),
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
    const session = await this.ensureLoaded(await this.getSession(taskId))
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
