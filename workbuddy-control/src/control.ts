export type WorkBuddyState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped'

interface WorkBuddyJob {
  id: string
  sessionId?: string
  state: WorkBuddyState
  settled: boolean
  status?: string
  detail?: string
  output?: { result?: string }
}

interface TranscriptUpdate {
  sessionUpdate?: string
  content?: { type?: string; text?: string }
}

export type WorkBuddyRequest = (path: string, init?: RequestInit) => Promise<unknown>

export class WorkBuddyControl {
  constructor(private readonly request: WorkBuddyRequest) {}

  async run(cwd: string, prompt: string): Promise<{ jobId: string }> {
    const response = await this.request('/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd,
        prompt,
        model: 'deepseek-v4.1-flash',
        effort: 'high',
        permissionMode: 'auto',
      }),
    })
    return { jobId: this.data<{ id: string }>(response).id }
  }

  async status(jobId: string): Promise<{
    jobId: string
    state: WorkBuddyState
    settled: boolean
    status?: string
    detail?: string
  }> {
    const job = await this.job(jobId)
    return {
      jobId: job.id,
      state: job.state,
      settled: job.settled,
      ...(job.status === undefined ? {} : { status: job.status }),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
    }
  }

  async result(jobId: string): Promise<
    | { ready: false; jobId: string; state: WorkBuddyState; settled: false; status?: string; detail?: string }
    | { ready: true; jobId: string; state: WorkBuddyState; settled: true; result?: string; status?: string; detail?: string }
  > {
    const job = await this.job(jobId)
    const terminal = {
      jobId: job.id,
      state: job.state,
      settled: job.settled,
      ...(job.status === undefined ? {} : { status: job.status }),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
    }
    if (!job.settled) return { ready: false, ...terminal, settled: false }

    const result = job.state === 'done'
      ? job.output?.result ?? await this.transcriptResult(jobId)
      : undefined
    return {
      ready: true,
      ...terminal,
      settled: true,
      ...(result === undefined ? {} : { result }),
    }
  }

  async cancel(jobId: string): Promise<{ jobId: string; stopped: boolean }> {
    const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' })
    return { jobId, stopped: this.data<{ stopped: boolean }>(response).stopped }
  }

  async resume(jobId: string, prompt: string): Promise<{ jobId: string; sessionId?: string; delivered: boolean }> {
    const before = await this.job(jobId)
    const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: prompt }),
    })
    const reply = this.data<{ delivered: boolean }>(response)
    return {
      jobId,
      ...(before.sessionId === undefined ? {} : { sessionId: before.sessionId }),
      delivered: reply.delivered,
    }
  }

  private async job(jobId: string): Promise<WorkBuddyJob> {
    const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
    return this.data<{ job: WorkBuddyJob }>(response).job
  }

  private async transcriptResult(jobId: string): Promise<string | undefined> {
    const response = await this.request(`/api/v1/jobs/${encodeURIComponent(jobId)}/transcript`)
    const updates = this.data<{ updates: TranscriptUpdate[] }>(response).updates
    const lastUserIndex = updates.findLastIndex(update => update.sessionUpdate === 'user_message_chunk')
    const chunks = updates.slice(lastUserIndex + 1)
      .filter(update => update.sessionUpdate === 'agent_message_chunk'
        && update.content?.type === 'text'
        && typeof update.content.text === 'string')
      .map(update => update.content?.text as string)
    return chunks.length === 0 ? undefined : chunks.join('')
  }

  private data<T>(response: unknown): T {
    return (response as { data: T }).data
  }
}
