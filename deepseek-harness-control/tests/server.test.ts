import type { ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessControl } from '../src/control.js'
import { createHarnessMcpServer, type HarnessControlApi } from '../src/server.js'

const cleanups: Array<() => Promise<void>> = []

const sdkPackage = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sdk-client/package.json'))
const fakeRuntime = resolve(dirname(sdkPackage), 'tests/fake-runtime.ts')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function childProcess(harness: DeepSeekHarness): ChildProcess {
  const child = (harness.client as unknown as { child?: ChildProcess }).child
  if (child === undefined) throw new Error('Harness runtime child was not started')
  return child
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function runningControl(): Promise<{
  control: HarnessControl
  harness: DeepSeekHarness
  pid: number
}> {
  const harness = new DeepSeekHarness({
    cwd: process.cwd(),
    dshBin: fakeRuntime,
    env: { ...process.env, FAKE_HANG_PROMPT: '1', FAKE_IGNORE_EOF: '1' },
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 100,
    disposeGraceMs: 100,
  })
  const running = harness.client.subscribe(notification => notification.method === 'session.status'
    && notification.params.status === 'running')
  const control = new HarnessControl(() => harness)
  cleanups.push(() => harness.close())
  await control.run(process.cwd(), 'keep the runtime active')
  await running.next()
  running.close()
  const pid = childProcess(harness).pid
  if (pid === undefined) throw new Error('Harness runtime child has no process id')
  return { control, harness, pid }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('DeepSeek Harness control MCP server', () => {
  it('exposes the five communication tools and forwards their arguments', async () => {
    const control: HarnessControlApi = {
      run: vi.fn(async () => ({ taskId: 'session-1' })),
      status: vi.fn(() => ({ activity: 'running' as const, resultReady: false })),
      result: vi.fn(() => ({ ready: false as const })),
      cancel: vi.fn(async () => ({ accepted: true as const })),
      resume: vi.fn(async taskId => ({ taskId })),
      close: vi.fn(async () => undefined),
    }
    const server = createHarnessMcpServer(control)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(async () => {
      await client.close()
      await server.close()
    })

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'run', 'status', 'result', 'cancel', 'resume',
    ])
    await expect(client.callTool({
      name: 'run',
      arguments: { cwd: 'E:/work', prompt: 'implement it' },
    })).resolves.toMatchObject({ structuredContent: { taskId: 'session-1' } })
    expect(control.run).toHaveBeenCalledWith('E:/work', 'implement it')

    await expect(client.callTool({
      name: 'status',
      arguments: { taskId: 'session-1' },
    })).resolves.toMatchObject({ structuredContent: { activity: 'running', resultReady: false } })
    expect(control.status).toHaveBeenCalledWith('session-1')

    await expect(client.callTool({
      name: 'result',
      arguments: { taskId: 'session-1' },
    })).resolves.toMatchObject({ structuredContent: { ready: false } })
    expect(control.result).toHaveBeenCalledWith('session-1')

    await expect(client.callTool({
      name: 'cancel',
      arguments: { taskId: 'session-1' },
    })).resolves.toMatchObject({ structuredContent: { accepted: true } })
    expect(control.cancel).toHaveBeenCalledWith('session-1')

    await expect(client.callTool({
      name: 'resume',
      arguments: { taskId: 'session-1', prompt: 'continue it' },
    })).resolves.toMatchObject({ structuredContent: { taskId: 'session-1' } })
    expect(control.resume).toHaveBeenCalledWith('session-1', 'continue it')
  })

  it('waits for control cleanup before explicit close settles', async () => {
    const pending = deferred()
    const control = {
      run: vi.fn(),
      status: vi.fn(),
      result: vi.fn(),
      cancel: vi.fn(),
      resume: vi.fn(),
      close: vi.fn(() => pending.promise),
    } as unknown as HarnessControlApi
    const server = createHarnessMcpServer(control)
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    let settled = false
    const closing = server.close().then(() => { settled = true })
    await vi.waitFor(() => expect(control.close).toHaveBeenCalledOnce())
    expect(settled).toBe(false)

    pending.resolve()
    await closing
  })

  it('closes a running Harness runtime on stdin EOF without leaving its process', async () => {
    const { control, harness, pid } = await runningControl()
    const close = vi.spyOn(harness, 'close')
    const input = new PassThrough()
    const output = new PassThrough()
    const server = createHarnessMcpServer(control, input)
    await server.connect(new StdioServerTransport(input, output))
    cleanups.push(() => server.close())

    input.end()

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(processExists(pid)).toBe(false))
  })

  it('awaits runtime process reaping when explicitly closed during a run', async () => {
    const { control, pid } = await runningControl()
    const server = createHarnessMcpServer(control)
    const [, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    await server.close()

    expect(processExists(pid)).toBe(false)
  })
})
