import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyMcpServer, type WorkBuddyControlApi } from '../src/server.js'
import { startWorkBuddy } from '../src/process.js'

const cleanups: Array<() => Promise<void>> = []
const fixture = resolve(import.meta.dirname, 'fixtures/fake-codebuddy.mjs')

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)))
  })
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function control(): WorkBuddyControlApi {
  return {
    run: vi.fn(async () => ({ jobId: 'job-1' })),
    status: vi.fn(async () => ({ jobId: 'job-1', state: 'working' as const, settled: false })),
    result: vi.fn(async () => ({ ready: false as const, jobId: 'job-1', state: 'working' as const, settled: false })),
    cancel: vi.fn(async () => ({ jobId: 'job-1', stopped: true })),
    resume: vi.fn(async () => ({ jobId: 'job-1', sessionId: 'session-1', delivered: true })),
    runDesktop: vi.fn(async () => ({ taskId: 'session-desktop-1', sessionId: 'session-desktop-1' })),
    statusDesktop: vi.fn(async () => ({
      taskId: 'session-desktop-1',
      sessionId: 'session-desktop-1',
      status: 'working' as const,
      settled: false,
      isProcessing: true,
      hasActiveToolCalls: true,
      currentTool: 'TaskOutput',
      currentToolCallId: 'tool-1',
      waitingTaskOutput: true,
    })),
    resultDesktop: vi.fn(async () => ({
      ready: false,
      taskId: 'session-desktop-1',
      sessionId: 'session-desktop-1',
      status: 'working' as const,
      settled: false,
    })),
    cancelDesktop: vi.fn(async () => ({
      taskId: 'session-desktop-1',
      sessionId: 'session-desktop-1',
      cancelRequested: true as const,
    })),
    resumeDesktop: vi.fn(async () => ({
      taskId: 'session-desktop-1',
      sessionId: 'session-desktop-1',
      delivered: true as const,
    })),
    close: vi.fn(async () => undefined),
  }
}

describe('workbuddy-control MCP server', () => {
  it('exposes the five Jobs tools and five Desktop tools and forwards their real arguments', async () => {
    const api = control()
    const server = createWorkBuddyMcpServer(api)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(async () => { await client.close(); await server.close() })

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'workbuddy_run', 'workbuddy_status', 'workbuddy_result', 'workbuddy_cancel', 'workbuddy_resume',
      'workbuddy_run_desktop', 'workbuddy_status_desktop', 'workbuddy_result_desktop',
      'workbuddy_cancel_desktop', 'workbuddy_resume_desktop',
    ])
    await client.callTool({ name: 'workbuddy_run', arguments: { cwd: 'E:/safe', prompt: 'implement' } })
    await client.callTool({ name: 'workbuddy_status', arguments: { jobId: 'job-1' } })
    await client.callTool({ name: 'workbuddy_result', arguments: { jobId: 'job-1' } })
    await client.callTool({ name: 'workbuddy_cancel', arguments: { jobId: 'job-1' } })
    await client.callTool({ name: 'workbuddy_resume', arguments: { jobId: 'job-1', prompt: 'continue' } })
    await client.callTool({
      name: 'workbuddy_run_desktop',
      arguments: {
        cwd: 'E:/desktop-safe',
        prompt: 'implement in Desktop',
        model: 'deepseek-v4.1-flash',
        mode: 'craft',
        permissionMode: 'acceptEdits',
      },
    })
    const desktopStatus = await client.callTool({
      name: 'workbuddy_status_desktop',
      arguments: { taskId: 'session-desktop-1' },
    })
    await client.callTool({ name: 'workbuddy_result_desktop', arguments: { taskId: 'session-desktop-1' } })
    await client.callTool({ name: 'workbuddy_cancel_desktop', arguments: { taskId: 'session-desktop-1' } })
    await client.callTool({
      name: 'workbuddy_resume_desktop',
      arguments: { taskId: 'session-desktop-1', prompt: 'continue in Desktop' },
    })

    expect(api.run).toHaveBeenCalledWith('E:/safe', 'implement')
    expect(api.status).toHaveBeenCalledWith('job-1')
    expect(api.result).toHaveBeenCalledWith('job-1')
    expect(api.cancel).toHaveBeenCalledWith('job-1')
    expect(api.resume).toHaveBeenCalledWith('job-1', 'continue')
    expect(api.runDesktop).toHaveBeenCalledWith({
      cwd: 'E:/desktop-safe',
      prompt: 'implement in Desktop',
      model: 'deepseek-v4.1-flash',
      mode: 'craft',
      permissionMode: 'acceptEdits',
    })
    expect(api.statusDesktop).toHaveBeenCalledWith('session-desktop-1')
    expect(desktopStatus.structuredContent).toMatchObject({
      isProcessing: true,
      hasActiveToolCalls: true,
      currentTool: 'TaskOutput',
      currentToolCallId: 'tool-1',
      waitingTaskOutput: true,
    })
    expect(api.resultDesktop).toHaveBeenCalledWith('session-desktop-1')
    expect(api.cancelDesktop).toHaveBeenCalledWith('session-desktop-1')
    expect(api.resumeDesktop).toHaveBeenCalledWith('session-desktop-1', 'continue in Desktop')
  })

  it('uses one awaited idempotent shutdown for EOF and explicit close', async () => {
    let release!: () => void
    const closing = new Promise<void>(resolve => { release = resolve })
    const api = control()
    vi.mocked(api.close).mockReturnValue(closing)
    const input = new PassThrough()
    const server = createWorkBuddyMcpServer(api, input)
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    input.end()
    const explicitClose = server.close()
    await vi.waitFor(() => expect(api.close).toHaveBeenCalledOnce())
    let settled = false
    void explicitClose.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await explicitClose
    expect(api.close).toHaveBeenCalledOnce()
  })

  it('reaps its codebuddy process and port on MCP stdin EOF', async () => {
    const service = await startWorkBuddy({ command: process.execPath, args: [fixture] })
    cleanups.push(service.close)
    const input = new PassThrough()
    const output = new PassThrough()
    const api = control()
    vi.mocked(api.close).mockImplementation(service.close)
    const server = createWorkBuddyMcpServer(api, input)
    await server.connect(new StdioServerTransport(input, output))
    const port = Number(new URL(service.baseUrl).port)

    input.end()

    await vi.waitFor(() => expect(processExists(service.pid)).toBe(false), { timeout: 5_000 })
    await expect(portIsFree(port)).resolves.toBe(true)
  })

  it('awaits process-tree reaping when explicitly closed during a run', async () => {
    const service = await startWorkBuddy({
      command: process.execPath,
      args: [fixture],
      env: { FAKE_RUNNING_CHILD: '1' },
    })
    cleanups.push(service.close)
    const childPid = Number(await (await fetch(`${service.baseUrl}/child-pid`)).text())
    const port = Number(new URL(service.baseUrl).port)
    const api = control()
    vi.mocked(api.close).mockImplementation(service.close)
    const server = createWorkBuddyMcpServer(api)
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    await server.close()

    expect(processExists(service.pid)).toBe(false)
    expect(processExists(childPid)).toBe(false)
    await expect(portIsFree(port)).resolves.toBe(true)
  })
})
