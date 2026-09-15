import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyControl, type WorkBuddyRequest } from '../src/control.js'

interface RequestRecord {
  method: string
  url: string
  body?: unknown
}

async function fakeJobsApi(responses: Record<string, unknown>): Promise<{
  request: WorkBuddyRequest
  requests: RequestRecord[]
  close(): Promise<void>
}> {
  const requests: RequestRecord[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bodyText = Buffer.concat(chunks).toString('utf8')
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      ...(bodyText === '' ? {} : { body: JSON.parse(bodyText) }),
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(responses[`${request.method} ${request.url}`]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake server did not bind')
  return {
    request: async (path, init) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init)
      return response.json()
    },
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('WorkBuddyControl', () => {
  it('runs with the fixed first-phase defaults and returns the WorkBuddy job id', async () => {
    const api = await fakeJobsApi({
      'POST /api/v1/jobs': { data: { id: 'job-1', state: 'working' } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.run('E:/safe', 'implement it')).resolves.toEqual({ jobId: 'job-1' })
    expect(api.requests).toEqual([{
      method: 'POST',
      url: '/api/v1/jobs',
      body: {
        cwd: 'E:/safe',
        prompt: 'implement it',
        model: 'deepseek-v4.1-flash',
        effort: 'high',
        permissionMode: 'auto',
      },
    }])
  })

  it.each([
    ['working', false],
    ['blocked', false],
    ['done', true],
    ['failed', true],
    ['stopped', true],
  ] as const)(
    'reports %s directly from state and settled without inventing status',
    async (state, settled) => {
      const api = await fakeJobsApi({
        'GET /api/v1/jobs/job-2': { data: { job: { id: 'job-2', state, settled } } },
      })
      cleanups.push(api.close)
      const control = new WorkBuddyControl(api.request)

      await expect(control.status('job-2')).resolves.toEqual({
        jobId: 'job-2',
        state,
        settled,
      })
    },
  )

  it('keeps WorkBuddy status only when the field exists', async () => {
    const api = await fakeJobsApi({
      'GET /api/v1/jobs/job-3': { data: { job: { id: 'job-3', state: 'done', settled: true, status: 'idle' } } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.status('job-3')).resolves.toEqual({
      jobId: 'job-3', state: 'done', settled: true, status: 'idle',
    })
  })

  it('returns ready false while unfinished and the current final result after completion', async () => {
    const api = await fakeJobsApi({
      'GET /api/v1/jobs/job-4': { data: { job: { id: 'job-4', state: 'working', settled: false } } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.result('job-4')).resolves.toEqual({
      ready: false, jobId: 'job-4', state: 'working', settled: false,
    })
  })

  it('reads the settled Job result without retaining an older result after resume', async () => {
    let phase: 'first' | 'resuming' | 'second' = 'first'
    const requests: RequestRecord[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bodyText = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: request.method ?? '', url: request.url ?? '', ...(bodyText ? { body: JSON.parse(bodyText) } : {}) })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/v1/jobs' && request.method === 'POST') {
        response.end(JSON.stringify({ data: { id: 'job-5', state: 'working' } }))
      } else if (request.method === 'POST') {
        phase = 'resuming'
        response.end(JSON.stringify({ data: { delivered: true } }))
      } else {
        const job = phase === 'resuming'
          ? { id: 'job-5', sessionId: 'session-5', state: 'working', settled: false, output: { result: 'first result' } }
          : { id: 'job-5', sessionId: 'session-5', state: 'done', settled: true, output: { result: phase === 'first' ? 'first result' : 'second result' } }
        response.end(JSON.stringify({ data: { job } }))
        if (phase === 'resuming') phase = 'second'
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fake server did not bind')
    const control = new WorkBuddyControl(async (path, init) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init)
      return response.json()
    })

    await expect(control.run('E:/safe', 'first')).resolves.toEqual({ jobId: 'job-5' })
    await expect(control.result('job-5')).resolves.toEqual({
      ready: true, jobId: 'job-5', state: 'done', settled: true, result: 'first result',
    })
    await expect(control.resume('job-5', 'continue')).resolves.toEqual({
      jobId: 'job-5', sessionId: 'session-5', delivered: true,
    })
    await expect(control.result('job-5')).resolves.toEqual({
      ready: false, jobId: 'job-5', state: 'working', settled: false,
    })
    await expect(control.result('job-5')).resolves.toEqual({
      ready: true, jobId: 'job-5', state: 'done', settled: true, result: 'second result',
    })
    expect(requests).toContainEqual({ method: 'POST', url: '/api/v1/jobs/job-5/reply', body: { text: 'continue' } })
  })

  it('falls back to the latest Assistant transcript result for a settled Job', async () => {
    const api = await fakeJobsApi({
      'GET /api/v1/jobs/job-6': { data: { job: { id: 'job-6', state: 'done', settled: true } } },
      'GET /api/v1/jobs/job-6/transcript': { data: { sessionId: 'session-6', updates: [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'prompt' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'latest ' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      ] } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.result('job-6')).resolves.toEqual({
      ready: true, jobId: 'job-6', state: 'done', settled: true, result: 'latest answer',
    })
  })

  it('does not return a previous Assistant result for a stopped Job', async () => {
    const api = await fakeJobsApi({
      'GET /api/v1/jobs/job-stopped': { data: { job: {
        id: 'job-stopped', state: 'stopped', settled: true, output: { result: 'previous turn' },
      } } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.result('job-stopped')).resolves.toEqual({
      ready: true, jobId: 'job-stopped', state: 'stopped', settled: true,
    })
  })

  it('returns only stop request acceptance and leaves final state to status', async () => {
    const api = await fakeJobsApi({
      'POST /api/v1/jobs': { data: { id: 'job-7', state: 'working' } },
      'POST /api/v1/jobs/job-7/stop': { data: { stopped: true } },
      'GET /api/v1/jobs/job-7': { data: { job: { id: 'job-7', state: 'stopped', settled: true } } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.run('E:/safe', 'cancel it')).resolves.toEqual({ jobId: 'job-7' })
    await expect(control.cancel('job-7')).resolves.toEqual({ jobId: 'job-7', stopped: true })
    await expect(control.status('job-7')).resolves.toEqual({ jobId: 'job-7', state: 'stopped', settled: true })
  })

  it('exposes Directory Trust blocked semantics unchanged', async () => {
    const api = await fakeJobsApi({
      'GET /api/v1/jobs/job-8': { data: { job: { id: 'job-8', state: 'blocked', settled: false, detail: 'Directory trust required' } } },
    })
    cleanups.push(api.close)
    const control = new WorkBuddyControl(api.request)

    await expect(control.status('job-8')).resolves.toEqual({
      jobId: 'job-8', state: 'blocked', settled: false, detail: 'Directory trust required',
    })
  })
})
