import { describe, expect, it, vi } from 'vitest'
import { DesktopControl, type DesktopBridge } from '../src/desktop-control.js'

function bridge(
  responses: unknown[],
): DesktopBridge & {
  invoke: ReturnType<typeof vi.fn>
  invokeDetached: ReturnType<typeof vi.fn>
} {
  return {
    invoke: vi.fn(async () => responses.shift()),
    invokeDetached: vi.fn(async () => undefined),
  }
}

/** 用户消息事件：用于划定「本轮」的起点。 */
function userChunk(text: string) {
  return { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } }
}

/** Assistant 文本块；`meta` 用于模拟 WorkBuddy 写入的内部内容标记。 */
function agentChunk(text: string, meta?: Record<string, unknown>) {
  return {
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text, ...(meta === undefined ? {} : { _meta: meta }) },
    },
  }
}

/** 工具调用事件：`title` 决定控制层能否识别 TaskOutput。 */
function toolCall(toolCallId: string, title: string, status: string) {
  return { update: { sessionUpdate: 'tool_call', toolCallId, title, status } }
}

describe('DesktopControl', () => {
  it('creates a real Desktop Session and starts its first prompt asynchronously', async () => {
    const desktop = bridge([{ sessionId: 'session-1', cwd: 'E:/safe', status: 'pending' }])
    const control = new DesktopControl(desktop)

    await expect(control.run({ cwd: 'E:/safe', prompt: 'implement it' })).resolves.toEqual({
      taskId: 'session-1',
      sessionId: 'session-1',
    })
    expect(desktop.invoke).toHaveBeenCalledWith('session:create', [{
      cwd: 'E:/safe',
      model: 'deepseek-v4.1-flash',
      mode: 'craft',
      permissionMode: 'default',
    }])
    expect(desktop.invokeDetached).toHaveBeenCalledWith('session:sendMessage', ['session-1', 'implement it'])
  })

  it('passes explicit Desktop model, mode, and permission mode to session:create', async () => {
    const desktop = bridge([{ sessionId: 'session-2' }])
    const control = new DesktopControl(desktop)

    await control.run({
      cwd: 'E:/safe',
      prompt: 'plan it',
      model: 'custom-model',
      mode: 'plan',
      permissionMode: 'plan',
    })

    expect(desktop.invoke).toHaveBeenCalledWith('session:create', [{
      cwd: 'E:/safe',
      model: 'custom-model',
      mode: 'plan',
      permissionMode: 'plan',
    }])
  })

  it('reports model-generating from a single session:get when the model is working', async () => {
    const desktop = bridge([{
      sessionId: 'session-gen',
      status: 'working',
      isProcessing: true,
      hasActiveToolCalls: false,
      eventHistory: [],
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    await expect(control.status('session-gen')).resolves.toEqual({
      taskId: 'session-gen',
      sessionId: 'session-gen',
      status: 'working',
      settled: false,
      isProcessing: true,
      hasActiveToolCalls: false,
      waitingTaskOutput: false,
      activity: 'model-generating',
      polledAt: 1_000,
      lastProgressAt: 1_000,
      stalledForMs: 0,
      stalled: false,
    })
    // 控制层只依赖 session:get，不额外猜测其他通道。
    expect(desktop.invoke.mock.calls).toEqual([['session:get', ['session-gen']]])
    now.mockRestore()
  })

  it('reports tool-executing with the current tool while a real tool is running', async () => {
    const desktop = bridge([{
      sessionId: 'session-tool',
      status: 'working',
      isProcessing: true,
      hasActiveToolCalls: true,
      eventHistory: [toolCall('tool-1', 'Edit', 'in_progress')],
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000)

    await expect(control.status('session-tool')).resolves.toEqual({
      taskId: 'session-tool',
      sessionId: 'session-tool',
      status: 'working',
      settled: false,
      isProcessing: true,
      hasActiveToolCalls: true,
      currentTool: 'Edit',
      currentToolCallId: 'tool-1',
      waitingTaskOutput: false,
      activity: 'tool-executing',
      polledAt: 2_000,
      lastProgressAt: 2_000,
      stalledForMs: 0,
      stalled: false,
    })
    now.mockRestore()
  })

  it('reports waiting-task-output only when the active tool is TaskOutput', async () => {
    const desktop = bridge([{
      sessionId: 'session-task-output',
      status: 'working',
      isProcessing: true,
      hasActiveToolCalls: true,
      eventHistory: [toolCall('tool-task-output', 'TaskOutput', 'in_progress')],
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)

    await expect(control.status('session-task-output')).resolves.toEqual({
      taskId: 'session-task-output',
      sessionId: 'session-task-output',
      status: 'working',
      settled: false,
      isProcessing: true,
      hasActiveToolCalls: true,
      currentTool: 'TaskOutput',
      currentToolCallId: 'tool-task-output',
      waitingTaskOutput: true,
      activity: 'waiting-task-output',
      polledAt: 3_000,
      lastProgressAt: 3_000,
      stalledForMs: 0,
      stalled: false,
    })
    now.mockRestore()
  })

  it('never reports awaiting-input as stalled even after a long wait', async () => {
    const desktop = bridge([{
      sessionId: 'session-input',
      status: 'working',
      isProcessing: true,
      pendingInputKind: 'question',
      hasActiveToolCalls: false,
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000 + 10 * 60 * 1_000)

    await expect(control.status('session-input')).resolves.toEqual({
      taskId: 'session-input',
      sessionId: 'session-input',
      status: 'working',
      settled: false,
      isProcessing: true,
      pendingInputKind: 'question',
      hasActiveToolCalls: false,
      waitingTaskOutput: false,
      activity: 'awaiting-input',
      polledAt: 2_000 + 10 * 60 * 1_000,
      lastProgressAt: 2_000 + 10 * 60 * 1_000,
      stalled: false,
    })
    now.mockRestore()
  })

  it('reports stalled only after the semantic fingerprint stops changing', async () => {
    const frozen = {
      sessionId: 'session-stalled',
      status: 'working',
      isProcessing: true,
      hasActiveToolCalls: false,
      eventHistory: [],
    }
    const desktop = bridge([frozen, frozen])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000 + 6 * 60 * 1_000)

    const first = await control.status('session-stalled')
    const second = await control.status('session-stalled')

    // 首次观察即建立基线，且不允许 status 查询本身刷新进度时间。
    expect(first.lastProgressAt).toBe(1_000)
    expect(first.stalled).toBe(false)
    expect(second.lastProgressAt).toBe(1_000)
    expect(second.stalledForMs).toBe(6 * 60 * 1_000)
    expect(second.stalled).toBe(true)
    expect(second.stalledReason).toBe('no-assistant-or-tool-progress')
    now.mockRestore()
  })

  it('resets the stalled window as soon as the fingerprint shows real progress', async () => {
    const desktop = bridge([
      {
        sessionId: 'session-progress',
        status: 'working',
        isProcessing: true,
        hasActiveToolCalls: false,
        eventHistory: [],
      },
      {
        sessionId: 'session-progress',
        status: 'working',
        isProcessing: true,
        hasActiveToolCalls: false,
        eventHistory: [toolCall('tool-2', 'Edit', 'in_progress')],
      },
    ])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000 + 6 * 60 * 1_000)

    await control.status('session-progress')
    const resumed = await control.status('session-progress')

    // 指纹变化代表真实进展，窗口从本次观察重新计时。
    expect(resumed.lastProgressAt).toBe(1_000 + 6 * 60 * 1_000)
    expect(resumed.stalled).toBe(false)
    now.mockRestore()
  })

  it('uses hasActiveToolCalls false to reject stale active-tool history', async () => {
    const desktop = bridge([{
      sessionId: 'session-stale-tool',
      status: 'completed',
      isProcessing: false,
      hasActiveToolCalls: false,
      eventHistory: [toolCall('old-task-output', 'TaskOutput', 'in_progress')],
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000)

    await expect(control.status('session-stale-tool')).resolves.toEqual({
      taskId: 'session-stale-tool',
      sessionId: 'session-stale-tool',
      status: 'completed',
      settled: true,
      isProcessing: false,
      hasActiveToolCalls: false,
      waitingTaskOutput: false,
      activity: 'idle',
      polledAt: 4_000,
      stalled: false,
    })
    now.mockRestore()
  })

  it('reports a cancelled Session as settled idle without a stalled window', async () => {
    const desktop = bridge([{
      sessionId: 'session-cancelled',
      status: 'terminated',
      isProcessing: false,
      hasActiveToolCalls: false,
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)

    await expect(control.status('session-cancelled')).resolves.toEqual({
      taskId: 'session-cancelled',
      sessionId: 'session-cancelled',
      status: 'terminated',
      settled: true,
      isProcessing: false,
      hasActiveToolCalls: false,
      waitingTaskOutput: false,
      activity: 'idle',
      polledAt: 5_000,
      stalled: false,
    })
    now.mockRestore()
  })

  it('returns only the latest turn Assistant text from the real event history', async () => {
    const desktop = bridge([{
      sessionId: 'session-4',
      status: 'completed',
      eventHistory: [
        userChunk('old'),
        agentChunk('old result'),
        userChunk('latest'),
        { update: { sessionUpdate: 'tool_call', title: 'Edit' } },
        { update: { sessionUpdate: 'tool_call_update', rawOutput: 'secret detail' } },
        agentChunk('final '),
        agentChunk('answer'),
      ],
    }])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-4')).resolves.toEqual({
      ready: true,
      taskId: 'session-4',
      sessionId: 'session-4',
      status: 'completed',
      settled: true,
      result: 'final answer',
    })
  })

  it('filters internal summary markers and keeps the user-visible final text', async () => {
    const desktop = bridge([{
      sessionId: 'session-internal',
      status: 'completed',
      eventHistory: [
        userChunk('go'),
        // 嵌套形态的内部标记。
        agentChunk('<conversation_history_summary>\nsummary\n</conversation_history_summary>', {
          'codebuddy.ai': { syntheticOwnerHistory: true },
        }),
        // 扁平命名空间的内部标记。
        agentChunk('internal compact body', { 'codebuddy.ai/isCompactInternal': true }),
        // 旧版没有 _meta，只能按正文特征识别。
        agentChunk('<cb_summary>legacy internal</cb_summary>'),
        agentChunk('real answer'),
      ],
    }])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-internal')).resolves.toEqual({
      ready: true,
      taskId: 'session-internal',
      sessionId: 'session-internal',
      status: 'completed',
      settled: true,
      result: 'real answer',
    })
  })

  it('does not report a result while the turn is still processing', async () => {
    const desktop = bridge([{
      sessionId: 'session-running',
      status: 'working',
      isProcessing: true,
      eventHistory: [userChunk('go'), agentChunk('partial narration')],
    }])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-running')).resolves.toEqual({
      ready: false,
      taskId: 'session-running',
      sessionId: 'session-running',
      status: 'working',
      settled: false,
    })
  })

  it('returns an explicit unavailable state instead of intermediate narration after cancel', async () => {
    const desktop = bridge([{
      sessionId: 'session-cancelled-result',
      status: 'terminated',
      isProcessing: false,
      eventHistory: [userChunk('go'), agentChunk('half-finished narration')],
    }])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-cancelled-result')).resolves.toEqual({
      ready: true,
      taskId: 'session-cancelled-result',
      sessionId: 'session-cancelled-result',
      status: 'terminated',
      settled: true,
      resultAvailable: false,
      resultReason: 'turn-not-finalized',
    })
    // 取消后的会话只读一次 session:get，不触碰持久化投影，也不返回中间叙述。
    expect(desktop.invoke.mock.calls).toEqual([['session:get', ['session-cancelled-result']]])
  })

  it('falls back to the finalized persisted projection for an archived Session', async () => {
    const desktop = bridge([
      { sessionId: 'session-archived', status: 'archived', cwd: 'E:/safe' },
      {
        historyReady: true,
        requests: [
          { id: 'request-1', assistantMessage: { state: 'completed', content: [{ type: 'text', text: 'old result' }] } },
          {
            id: 'request-2',
            assistantMessage: {
              state: 'completed',
              content: [
                { type: 'text', text: 'loaded ' },
                { type: 'tool', toolCallId: 'tool-1' },
                { type: 'text', text: 'result' },
              ],
            },
          },
        ],
      },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-archived')).resolves.toEqual({
      ready: true,
      taskId: 'session-archived',
      sessionId: 'session-archived',
      status: 'archived',
      settled: true,
      result: 'loaded result',
    })
  })

  it('reports turn-not-finalized when the persisted message is still streaming', async () => {
    const desktop = bridge([
      { sessionId: 'session-archived-streaming', status: 'archived', cwd: 'E:/safe' },
      {
        historyReady: true,
        requests: [{
          id: 'request-1',
          assistantMessage: { state: 'streaming', content: [{ type: 'text', text: 'partial' }] },
        }],
      },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-archived-streaming')).resolves.toEqual({
      ready: true,
      taskId: 'session-archived-streaming',
      sessionId: 'session-archived-streaming',
      status: 'archived',
      settled: true,
      resultAvailable: false,
      resultReason: 'turn-not-finalized',
    })
  })

  it('reports no-visible-assistant-text when the finalized message carries only internal content', async () => {
    const desktop = bridge([
      { sessionId: 'session-archived-internal', status: 'archived', cwd: 'E:/safe' },
      {
        historyReady: true,
        requests: [{
          id: 'request-1',
          assistantMessage: {
            state: 'completed',
            content: [{
              type: 'text',
              text: '<conversation_history_summary>\nsummary\n</conversation_history_summary>',
              _meta: { 'codebuddy.ai': { isCompactInternal: true } },
            }],
          },
        }],
      },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-archived-internal')).resolves.toEqual({
      ready: true,
      taskId: 'session-archived-internal',
      sessionId: 'session-archived-internal',
      status: 'archived',
      settled: true,
      resultAvailable: false,
      resultReason: 'no-visible-assistant-text',
    })
  })

  it('waits for an inactive Desktop Session request history before reading its final Assistant text', async () => {
    const desktop = bridge([
      { sessionId: 'session-5', status: 'archived', cwd: 'E:/safe' },
      { historyReady: false, requests: [] },
      {
        historyReady: true,
        requests: [
          { id: 'request-1', assistantMessage: { state: 'completed', content: [{ type: 'text', text: 'old result' }] } },
          {
            id: 'request-2',
            assistantMessage: {
              state: 'completed',
              content: [
                { type: 'text', text: 'loaded ' },
                { type: 'tool', toolCallId: 'tool-1' },
                { type: 'text', text: 'result' },
              ],
            },
          },
        ],
      },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.result('session-5')).resolves.toMatchObject({ ready: true, result: 'loaded result' })
    expect(desktop.invoke.mock.calls).toEqual([
      ['session:get', ['session-5']],
      ['wb:conversations:requestEntries', ['session-5', { byteLength: 5 * 1024 * 1024 }]],
      ['wb:conversations:requestEntries', ['session-5', { byteLength: 5 * 1024 * 1024 }]],
    ])
  })

  it('resumes the same Desktop Session and never creates another Session', async () => {
    const desktop = bridge([
      { sessionId: 'session-6', status: 'completed', cwd: 'E:/safe', isProcessing: false },
      { sessionId: 'session-6' },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.resume('session-6', 'continue')).resolves.toEqual({
      taskId: 'session-6',
      sessionId: 'session-6',
      delivered: true,
    })
    expect(desktop.invoke.mock.calls).toEqual([
      ['session:get', ['session-6']],
      ['session:load', ['session-6', { cwd: 'E:/safe' }]],
    ])
    expect(desktop.invokeDetached).toHaveBeenCalledWith('session:sendMessage', ['session-6', 'continue'])
    expect(desktop.invoke).not.toHaveBeenCalledWith('session:create', expect.anything())
  })

  it('rejects resume before loading or sending when the fixture reports the Session is processing', async () => {
    // 可控 fixture：直接声明 isProcessing，不依赖真实时序猜测。
    const desktop = bridge([{
      sessionId: 'session-processing',
      status: 'working',
      cwd: 'E:/safe',
      isProcessing: true,
    }])
    const control = new DesktopControl(desktop)

    await expect(control.resume('session-processing', 'continue')).rejects.toThrow(
      'Session is still processing. Wait for completion or cancel before resume.',
    )
    expect(desktop.invoke.mock.calls).toEqual([['session:get', ['session-processing']]])
    expect(desktop.invokeDetached).not.toHaveBeenCalled()
    expect(desktop.invoke).not.toHaveBeenCalledWith('session:create', expect.anything())
    expect(desktop.invoke).not.toHaveBeenCalledWith('session:cancel', expect.anything())
  })

  it('checks the loaded Session again and rejects resume if the fixture reports it became processing', async () => {
    const desktop = bridge([
      { sessionId: 'session-loaded-processing', status: 'completed', cwd: 'E:/safe', isProcessing: false },
      { sessionId: 'session-loaded-processing', status: 'working', cwd: 'E:/safe', isProcessing: true },
    ])
    const control = new DesktopControl(desktop)

    await expect(control.resume('session-loaded-processing', 'continue')).rejects.toThrow(
      'Session is still processing. Wait for completion or cancel before resume.',
    )
    expect(desktop.invoke.mock.calls).toEqual([
      ['session:get', ['session-loaded-processing']],
      ['session:load', ['session-loaded-processing', { cwd: 'E:/safe' }]],
    ])
    expect(desktop.invokeDetached).not.toHaveBeenCalled()
  })

  it('cancels the real Desktop Session and leaves final status to status()', async () => {
    const desktop = bridge([undefined])
    const control = new DesktopControl(desktop)

    await expect(control.cancel('session-7')).resolves.toEqual({
      taskId: 'session-7',
      sessionId: 'session-7',
      cancelRequested: true,
    })
    expect(desktop.invoke).toHaveBeenCalledWith('session:cancel', ['session-7'])
  })
})
