import { DeepSeekHarness, type RunResult } from '@deepseek-ai/dsh-sdk-client'

export interface HarnessSessionHandle {
  readonly id: string
  run(prompt: string): Promise<RunResult>
  cancel(): Promise<void>
}

export interface HarnessRuntime {
  session(sessionId?: string): HarnessSessionHandle
  close(): Promise<void>
}

interface RunRecord {
  readonly session: HarnessSessionHandle
  activity: 'running' | 'idle'
  output?: { finalResponse?: string; turnEndReason?: unknown }
  error?: string
}

export class HarnessControl {
  private readonly runtimes = new Map<string, HarnessRuntime>()
  private readonly records = new Map<string, RunRecord>()

  constructor(
    private readonly createRuntime: (cwd: string) => HarnessRuntime = cwd => new DeepSeekHarness({ cwd }),
  ) {}

  async run(cwd: string, prompt: string): Promise<{ taskId: string }> {
    const runtime = this.runtime(cwd)
    const session = runtime.session()
    const record: RunRecord = { session, activity: 'running' }
    this.records.set(session.id, record)
    this.start(record, prompt)
    return { taskId: session.id }
  }

  status(taskId: string): { activity: 'running' | 'idle'; resultReady: boolean; error?: string } {
    const record = this.record(taskId)
    return {
      activity: record.activity,
      resultReady: record.output !== undefined || record.error !== undefined,
      ...(record.error === undefined ? {} : { error: record.error }),
    }
  }

  result(taskId: string):
    | { ready: false }
    | { ready: true; finalResponse?: string; turnEndReason?: unknown; error?: string } {
    const record = this.record(taskId)
    if (record.output !== undefined) return { ready: true, ...record.output }
    if (record.error !== undefined) return { ready: true, error: record.error }
    return { ready: false }
  }

  async cancel(taskId: string): Promise<{ accepted: true }> {
    await this.record(taskId).session.cancel()
    return { accepted: true }
  }

  async resume(taskId: string, prompt: string): Promise<{ taskId: string }> {
    const record = this.record(taskId)
    if (record.activity === 'running') throw new Error(`task "${taskId}" is still running`)
    record.activity = 'running'
    record.output = undefined
    record.error = undefined
    this.start(record, prompt)
    return { taskId }
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.close()))
  }

  private runtime(cwd: string): HarnessRuntime {
    let runtime = this.runtimes.get(cwd)
    if (runtime === undefined) {
      runtime = this.createRuntime(cwd)
      this.runtimes.set(cwd, runtime)
    }
    return runtime
  }

  private record(taskId: string): RunRecord {
    const record = this.records.get(taskId)
    if (record === undefined) throw new Error(`unknown taskId: ${taskId}`)
    return record
  }

  private start(record: RunRecord, prompt: string): void {
    void record.session.run(prompt).then(
      result => {
        const turnEnd = result.events.findLast(event => event.type === 'turn/end')
        record.output = {
          finalResponse: result.finalResponse,
          ...(turnEnd === undefined ? {} : { turnEndReason: turnEnd.data.reason }),
        }
        record.activity = 'idle'
      },
      error => {
        record.error = error instanceof Error ? error.message : String(error)
        record.activity = 'idle'
      },
    )
  }
}
