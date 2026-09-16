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

/**
 * WorkBuddy 的 `_meta`：同一个键可能以扁平命名空间 `codebuddy.ai/<key>` 出现，
 * 也可能嵌在 `codebuddy.ai` 对象里，因此读取时必须同时覆盖两种形态。
 */
type SessionMeta = Record<string, unknown>

interface SessionContentBlock {
  type?: string
  text?: string
  _meta?: SessionMeta
}

interface SessionEvent {
  update?: {
    sessionUpdate?: string
    content?: SessionContentBlock | SessionContentBlock[]
    toolCallId?: string
    toolName?: string
    title?: string
    status?: string
    _meta?: SessionMeta
  }
  _meta?: SessionMeta
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

/**
 * 当前 Turn 的真实活动类别。它由控制层从语义信号推导，不依赖 WorkBuddy 的传输层时间戳，
 * 因此调用方可以区分「模型在生成」「真实工具在执行」「等待 TaskOutput」和「空转」。
 */
export type DesktopActivity =
  | 'model-generating'
  | 'tool-executing'
  | 'waiting-task-output'
  | 'awaiting-input'
  | 'idle'
  | 'unknown'

export interface DesktopStatusResult {
  taskId: string
  sessionId: string
  status: DesktopSessionStatus
  settled: boolean
  isProcessing?: boolean
  pendingInputKind?: string
  hasActiveToolCalls?: boolean
  /** WorkBuddy 导出的会话活动时间（已持久化的语义活动，长时间不变属于正常）。 */
  lastActivityAt?: number
  /**
   * WorkBuddy 导出的后端传输活动时间。它由 prompt 传输帧（含心跳）刷新，
   * 只代表传输层有数据，不代表模型或工具真实进展；本层不把它用于 stalled 判定。
   */
  lastBackendActivityAt?: number
  currentTool?: string
  currentToolCallId?: string
  /**
   * 与 `activity` 同源推导：`activity === 'waiting-task-output'` 时为 true，
   * 已明确没有活动工具时为 false，无法判定时省略（不猜测）。
   */
  waitingTaskOutput?: boolean
  /** 当前活动类别；每次 status 都会返回。 */
  activity: DesktopActivity
  /** 本次 status 读取时刻，供调用方计算自身观察窗口。 */
  polledAt: number
  /** 控制层最近一次观察到语义进展的时间，不会被 status 查询自身刷新。 */
  lastProgressAt?: number
  /** 处理中且距最近一次语义进展的时长；未处理时为 undefined。 */
  stalledForMs?: number
  /** 是否已达到 stalled 阈值；每次 status 都会返回，不再只在为真时出现。 */
  stalled: boolean
  stalledReason?: 'no-assistant-or-tool-progress'
}

/**
 * 取不到最终 Assistant 文本时的明确原因。调用方据此可以区分
 * 「本轮根本没正常完结（例如被取消）」和「本轮完结了但没有任何用户可见正文」，
 * 不需要也不允许拿中间叙述冒充最终结果。
 */
export type DesktopResultUnavailableReason = 'turn-not-finalized' | 'no-visible-assistant-text'

export type DesktopResult =
  | {
    ready: false
    taskId: string
    sessionId: string
    status: DesktopSessionStatus
    settled: false
  }
  | {
    ready: true
    taskId: string
    sessionId: string
    status: DesktopSessionStatus
    settled: true
    result: string
  }
  | {
    ready: true
    taskId: string
    sessionId: string
    status: DesktopSessionStatus
    settled: true
    resultAvailable: false
    resultReason: DesktopResultUnavailableReason
  }

interface ConversationRequestEntriesPage {
  historyReady: boolean
  requests: Array<{
    assistantMessage?: {
      /** `streaming` 表示消息级流未结束（例如中途被取消），`completed` 表示已定稿。 */
      state?: string
      content: SessionContentBlock[]
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

/**
 * WorkBuddy 会把内部内容写进与用户内容相同的事件流：上下文压缩摘要、子 Agent / 团队成员消息、
 * 历史重放控制帧、合成（synthetic）终态消息等。它们的 `_meta` 一定带有下列任一标记。
 * 该列表对齐 WorkBuddy 自身 conversation-frame-classifier 的 `extractConversationFrameMeta`，
 * 只保留与「用户可见正文」判定直接相关的键。
 */
const internalMetaKeys = [
  'syntheticOwnerHistory',
  'syntheticTeammateMessage',
  'isCompactInternal',
  'compactType',
  'compact-cancelled',
  'compactCancelled',
  'compact-limit-reached',
  'compactLimitReached',
  'isSubAgent',
  'parentSessionId',
  'memberEvent',
  'parentToolCallId',
  'teamUpdate',
  'rendererHistoryReplay',
  'ownerSnapshotHistoryReplay',
  'historyReplay',
  'isSessionSeparator',
] as const

/**
 * 早期版本没有 `_meta` 标记，只能按正文特征识别内部内容。
 * 这些正则对齐 WorkBuddy 自身的 legacy-marker filters，避免把
 * `<conversation_history_summary>` / `<cb_summary>` 这类内部摘要当成最终答复返回。
 */
const legacyInternalContentPatterns = [
  /^\s*<conversation_history_summary\b/i,
  /^\s*<cb_summary\b/i,
  /^\s*<compact-request\b/i,
  /^\s*<system-reminder[^>]*data-role=["']compact-summary["']/i,
  /^\s*<teammate-message\b[^>]*>[\s\S]*<\/teammate-message>\s*$/i,
]

/** 控制层为每个 taskId 记住的语义进度观察结果。 */
interface ProgressObservation {
  fingerprint: string
  lastProgressAt: number
}

/**
 * 只使用真实语义信号构造进度指纹：Task 状态、处理标记、输入等待、活动工具、
 * 事件数量与最后一个事件类型。传输层时间戳（lastBackendActivityAt）刻意不参与，
 * 避免心跳刷新掩盖空转。
 *
 * `events === undefined` 只会在宿主返回 SessionRecord（会话不在内存）时出现：
 * 该形态既没有 eventHistory，也没有 isProcessing / hasActiveToolCalls，
 * 因此退化为「只看会话级状态与输入等待」。控制层不对此做任何补偿性猜测，
 * 也不假设自己能在不付 `session:get` 代价的前提下读到处理态。
 */
function progressFingerprint(session: DesktopSession, events: SessionEvent[] | undefined): string {
  if (events === undefined) {
    return JSON.stringify([
      session.status,
      session.isProcessing === true,
      session.pendingInputKind ?? null,
      session.hasActiveToolCalls ?? null,
    ])
  }
  const last = events.at(-1)?.update
  return JSON.stringify([
    session.status,
    session.isProcessing === true,
    session.pendingInputKind ?? null,
    session.hasActiveToolCalls ?? null,
    events.length,
    last?.sessionUpdate ?? null,
    last?.toolCallId ?? null,
    last?.status ?? null,
  ])
}

/**
 * 把当前 Turn 归类到唯一活动类别，供调用方区分生成、工具执行、等待与空转。
 * 判定顺序即优先级：正在执行的具体工具最具体，其次是需要用户介入的等待，再退到处理标记。
 */
function classifyActivity(
  session: DesktopSession,
  currentTool: { toolCallId: string; name?: string } | undefined,
): DesktopActivity {
  if (currentTool?.name === taskOutputToolName) return 'waiting-task-output'
  if (session.pendingInputKind !== undefined) return 'awaiting-input'
  if (session.hasActiveToolCalls === true) return 'tool-executing'
  if (session.isProcessing === true) return 'model-generating'
  if (session.isProcessing === false) return 'idle'
  return 'unknown'
}

export class DesktopControl {
  private readonly progress = new Map<string, ProgressObservation>()

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
    const events = Array.isArray(session.eventHistory) ? session.eventHistory : undefined
    const currentTool = session.hasActiveToolCalls !== false && events !== undefined
      ? currentActiveTool(events)
      : undefined
    const polledAt = Date.now()
    const fingerprint = progressFingerprint(session, events)
    const previous = this.progress.get(taskId)
    // 指纹变化才算一次真实进展；status 查询本身不产生任何语义信号，因此不会推迟 stalled。
    const lastProgressAt = previous?.fingerprint === fingerprint
      ? previous.lastProgressAt
      : polledAt
    const isProcessing = session.isProcessing === true
    // 只在处理期间保留观察记录，避免已结束任务的进度表无限增长。
    if (isProcessing) this.progress.set(taskId, { fingerprint, lastProgressAt })
    else this.progress.delete(taskId)

    const stalledForMs = isProcessing && session.pendingInputKind === undefined
      ? polledAt - lastProgressAt
      : undefined
    const stalled = stalledForMs !== undefined && stalledForMs >= stalledThresholdMs
    const activity = classifyActivity(session, currentTool)
    // waitingTaskOutput 与 activity 同源：只有 activity 明确时才给确定值，否则保持未知。
    const waitingTaskOutput = activity === 'waiting-task-output'
      ? true
      : activity === 'tool-executing'
        || activity === 'model-generating'
        || activity === 'idle'
        || session.hasActiveToolCalls === false
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
      activity,
      polledAt,
      ...(isProcessing ? { lastProgressAt } : {}),
      ...(stalledForMs === undefined ? {} : { stalledForMs }),
      stalled,
      ...(stalled ? { stalledReason: 'no-assistant-or-tool-progress' as const } : {}),
    }
  }

  async result(taskId: string): Promise<DesktopResult> {
    const session = await this.getSession(taskId)
    const settled = terminalStatuses.has(session.status)
    const base = { taskId, sessionId: session.sessionId, status: session.status }
    if (!settled) return { ready: false, ...base, settled: false }

    // terminated / failed / error 表示本轮没有正常完结（terminated 即用户取消或外部终止），
    // 此时事件流里的正文只是中间叙述，绝不能当成最终答复返回。
    if (session.status === 'terminated' || session.status === 'failed' || session.status === 'error') {
      return { ready: true, ...base, settled: true, resultAvailable: false, resultReason: 'turn-not-finalized' }
    }

    // completed 明确表示本轮正常完结，可以直接采用事件流里过滤后的用户可见正文。
    // archived 只是会话级归档标记、不携带本轮结果，因此不走这条捷径。
    if (session.status === 'completed') {
      const visible = visibleAssistantText(Array.isArray(session.eventHistory) ? session.eventHistory : [])
      if (visible !== undefined) return { ready: true, ...base, settled: true, result: visible }
    }

    // 事件流没有可见正文，或会话级状态无法判断本轮是否完结：退回只读持久化投影，
    // 用消息级 state（streaming / completed）加同一套过滤规则再判定一次。
    const page = await this.loadPersistedRequests(session.sessionId)
    const persisted = finalizedPersistedAssistantText(page)
    if (persisted !== undefined) return { ready: true, ...base, settled: true, result: persisted }
    return {
      ready: true,
      ...base,
      settled: true,
      resultAvailable: false,
      resultReason: latestPersistedAssistantMessage(page)?.state === 'streaming'
        ? 'turn-not-finalized'
        : 'no-visible-assistant-text',
    }
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
    if (session === null || session === undefined) {
      throw new Error(`WorkBuddy Desktop Session was not found: ${taskId}`)
    }
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
    const metaToolName = metaValue(update._meta, 'toolName')
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

/** 读取 `_meta` 的同一个键，同时覆盖扁平 `codebuddy.ai/<key>` 与嵌套 `codebuddy.ai.<key>` 两种形态。 */
function metaValue(meta: SessionMeta | undefined, key: string): unknown {
  if (meta === undefined) return undefined
  const flat = meta[`codebuddy.ai/${key}`]
  if (flat !== undefined) return flat
  const nested = meta['codebuddy.ai']
  if (typeof nested === 'object' && nested !== null) return (nested as SessionMeta)[key]
  return undefined
}

/** 标记存在且不是显式的 false / 空串，才算「命中内部标记」。 */
function isInternalMetaValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') return value.length > 0
  return true
}

function isInternalMeta(meta: SessionMeta | undefined): boolean {
  return internalMetaKeys.some(key => isInternalMetaValue(metaValue(meta, key)))
}

/**
 * 判断一个文本块是否属于「用户可见正文」。
 * 两道过滤：`_meta` 内部标记优先（新版 WorkBuddy），其次正文 legacy 特征（旧版没有标记）。
 */
function isVisibleAssistantBlock(block: SessionContentBlock): boolean {
  if (block.type !== 'text' || typeof block.text !== 'string') return false
  if (isInternalMeta(block._meta)) return false
  return !legacyInternalContentPatterns.some(pattern => pattern.test(block.text as string))
}

function blockText(block: SessionContentBlock): string | undefined {
  return isVisibleAssistantBlock(block) ? block.text : undefined
}

function contentBlocks(content: SessionContentBlock | SessionContentBlock[] | undefined): SessionContentBlock[] {
  if (content === undefined) return []
  return Array.isArray(content) ? content : [content]
}

/**
 * 取最后一个用户消息之后、过滤掉内部内容后剩下的用户可见 Assistant 正文。
 * 返回 undefined 表示这一段没有任何可展示正文，调用方必须按「无最终文本」处理。
 */
function visibleAssistantText(events: SessionEvent[]): string | undefined {
  const lastUserIndex = events.findLastIndex(event => event.update?.sessionUpdate === 'user_message_chunk')
  const chunks = events.slice(lastUserIndex + 1).flatMap(event => {
    if (event.update?.sessionUpdate !== 'agent_message_chunk') return []
    return contentBlocks(event.update.content).flatMap(block => {
      const text = blockText(block)
      return text === undefined ? [] : [text]
    })
  })
  return chunks.length === 0 ? undefined : chunks.join('')
}

function latestPersistedAssistantMessage(
  page: ConversationRequestEntriesPage,
): ConversationRequestEntriesPage['requests'][number]['assistantMessage'] {
  return page.requests.at(-1)?.assistantMessage
}

/** 只接受消息级已定稿（state === 'completed'）的投影，未定稿的消息一律不当作最终结果。 */
function finalizedPersistedAssistantText(page: ConversationRequestEntriesPage): string | undefined {
  const message = latestPersistedAssistantMessage(page)
  if (message === undefined || message.state !== 'completed') return undefined
  const chunks = message.content.flatMap(block => {
    const text = blockText(block)
    return text === undefined ? [] : [text]
  })
  return chunks.length === 0 ? undefined : chunks.join('')
}
