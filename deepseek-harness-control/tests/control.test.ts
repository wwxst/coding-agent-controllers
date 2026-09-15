import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { HarnessControl, type HarnessRuntime, type HarnessSessionHandle } from '../src/control.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function result(sessionId: string, finalResponse: string): RunResult {
  return {
    sessionId,
    finalResponse,
    events: [{
      type: 'turn/end',
      seq: 1 as RunResult['events'][number]['seq'],
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    }],
    notifications: [],
  }
}

describe('HarnessControl', () => {
  it('runs asynchronously and projects status and result from one session record', async () => {
    const pending = deferred<RunResult>()
    const session: HarnessSessionHandle = { id: 'session-1', run: vi.fn(() => pending.promise), cancel: vi.fn() }
    const runtime: HarnessRuntime = { session: vi.fn(() => session), close: vi.fn() }
    const control = new HarnessControl(() => runtime)

    await expect(control.run('E:/work', 'implement it')).resolves.toEqual({ taskId: 'session-1' })
    expect(control.status('session-1')).toEqual({ activity: 'running', resultReady: false })
    expect(control.result('session-1')).toEqual({ ready: false })

    pending.resolve(result('session-1', 'done'))
    await vi.waitFor(() => expect(control.status('session-1')).toEqual({ activity: 'idle', resultReady: true }))
    expect(control.result('session-1')).toEqual({
      ready: true,
      finalResponse: 'done',
      turnEndReason: { kind: 'completed' },
    })
    const record = (control as unknown as { records: Map<string, object> }).records.get('session-1')
    expect(record).not.toHaveProperty('result')
  })

  it('cancels and resumes the same Harness session id', async () => {
    const first = deferred<RunResult>()
    const second = deferred<RunResult>()
    const run = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const cancel = vi.fn(() => Promise.resolve())
    const session: HarnessSessionHandle = { id: 'session-2', run, cancel }
    const runtime: HarnessRuntime = { session: vi.fn(() => session), close: vi.fn() }
    const control = new HarnessControl(() => runtime)

    const started = await control.run('E:/work', 'first')
    await expect(control.cancel(started.taskId)).resolves.toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledOnce()
    first.resolve(result('session-2', 'first done'))
    await vi.waitFor(() => expect(control.status(started.taskId).activity).toBe('idle'))

    await expect(control.resume(started.taskId, 'fix review findings')).resolves.toEqual({ taskId: 'session-2' })
    expect(run).toHaveBeenLastCalledWith('fix review findings')
    expect(control.result(started.taskId)).toEqual({ ready: false })
    second.resolve(result('session-2', 'fixed'))
  })
})
