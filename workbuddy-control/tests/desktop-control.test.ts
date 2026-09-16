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

  it('projects status directly from the Desktop Session without retaining local task state', async () => {
    const desktop = bridge([{
      sessionId: 'session-3',
      status: 'working',
      isProcessing: true,
      pendingInputKind: undefined,
      hasActiveToolCalls: true,
      lastActivityAt: 1_000,
      lastBackendActivityAt: 2_000,
      eventHistory: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-task-output',
            title: 'TaskOutput',
            status: 'in_progress',
          },
        },
      ],
    }])
    const control = new DesktopControl(desktop)
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000 + 5 * 60 * 1_000)

    await expect(control.status('session-3')).resolves.toEqual({
      taskId: 'session-3',
      sessionId: 'session-3',
      status: 'working',
      settled: false,
      isProcessing: true,
      hasActiveToolCalls: true,
      lastActivityAt: 1_000,
      lastBackendActivityAt: 2_000,
      currentTool: 'TaskOutput',
      currentToolCallId: 'tool-task-output',
      waitingTaskOutput: true,
      stalled: true,
      stalledForMs: 5 * 60 * 1_000,
    })
    expect(desktop.invoke).toHaveBeenCalledWith('session:get', ['session-3'])
    now.mockRestore()
  })

  it('does not report a processing Session as stalled while it is waiting for input', async () => {
    const desktop = bridge([{
      sessionId: 'session-input',
      status: 'working',
      isProcessing: true,
      pendingInputKind: 'question',
      hasActiveToolCalls: false,
      lastActivityAt: 1_000,
      lastBackendActivityAt: 2_000,
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
      lastActivityAt: 1_000,
      lastBackendActivityAt: 2_000,
      waitingTaskOutput: false,
    })
    now.mockRestore()
  })

  it('uses hasActiveToolCalls false to reject stale active-tool history', async () => {
    const desktop = bridge([{
      sessionId: 'session-stale-tool',
      status: 'completed',
      isProcessing: false,
      hasActiveToolCalls: false,
      eventHistory: [
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'old-task-output',
            title: 'TaskOutput',
            status: 'in_progress',
          },
        },
      ],
    }])
    const control = new DesktopControl(desktop)

    await expect(control.status('session-stale-tool')).resolves.toEqual({
      taskId: 'session-stale-tool',
      sessionId: 'session-stale-tool',
      status: 'completed',
      settled: true,
      isProcessing: false,
      hasActiveToolCalls: false,
      waitingTaskOutput: false,
    })
  })

  it('returns only the latest turn Assistant text from the real event history', async () => {
    const desktop = bridge([{
      sessionId: 'session-4',
      status: 'completed',
      eventHistory: [
        { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old result' } } },
        { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'latest' } } },
        { update: { sessionUpdate: 'tool_call', title: 'Edit' } },
        { update: { sessionUpdate: 'tool_call_update', rawOutput: 'secret detail' } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final ' } } },
        { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } },
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

  it('waits for an inactive Desktop Session request history before reading its final Assistant text', async () => {
    const desktop = bridge([
      { sessionId: 'session-5', status: 'completed', cwd: 'E:/safe' },
      { historyReady: false, requests: [] },
      {
        historyReady: true,
        requests: [
          {
            id: 'request-1',
            assistantMessage: { content: [{ type: 'text', text: 'old result' }] },
          },
          {
            id: 'request-2',
            assistantMessage: {
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
    const desktop = bridge([{ sessionId: 'session-6', status: 'completed', cwd: 'E:/safe' }, { sessionId: 'session-6' }])
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

  it('rejects resume before loading or sending when the real Session is still processing', async () => {
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

  it('checks the loaded Session again and rejects resume if it became processing', async () => {
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
