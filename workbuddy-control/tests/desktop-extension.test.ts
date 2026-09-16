import { randomUUID } from 'node:crypto'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopPipeClient } from '../src/desktop-transport.js'

const extensionRoot = resolve(import.meta.dirname, '../desktop-extension')
const extensionEntry = resolve(extensionRoot, 'server/index.cjs')
const children: ChildProcess[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
    child.once('exit', () => resolvePromise())
    child.kill('SIGTERM')
  })))
})

function startExtension(onInvoke: (message: Record<string, unknown>, child: ChildProcess) => void) {
  const pipePath = `\\\\.\\pipe\\workbuddy-control-extension-test-${randomUUID()}`
  const child = fork(extensionEntry, [], {
    env: {
      ...process.env,
      WB_EXTENSION_ID: 'workbuddy-control-desktop',
      WORKBUDDY_DESKTOP_PIPE_PATH: pipePath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.push(child)
  const ready = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject)
    child.on('message', message => {
      if (typeof message !== 'object' || message === null) return
      const record = message as Record<string, unknown>
      if (record.type === 'wb-extension-ready') resolvePromise()
      if (record.type === 'invoke:request') onInvoke(record, child)
    })
  })
  return { child, client: new DesktopPipeClient(pipePath), pipePath, ready }
}

describe('WorkBuddy Desktop Extension', () => {
  it('declares five Session permissions plus the exact request-history projection permission', async () => {
    const extension = JSON.parse(await readFile(resolve(extensionRoot, 'extension.json'), 'utf8'))
    const distribution = JSON.parse(await readFile(resolve(extensionRoot, 'distribution.json'), 'utf8'))
    const serverSource = await readFile(extensionEntry, 'utf8')
    const pipeServerSource = await readFile(resolve(extensionRoot, 'server/pipe-server.ps1'), 'utf8')

    expect(extension.permissions).toEqual([
      'session.create', 'session.get', 'session.load', 'session.sendMessage', 'session.cancel',
      'conversations.requestEntries',
    ])
    expect(extension.service).toEqual({
      entry: './server/index.cjs',
      process: 'fork',
      activationEvents: ['onStartup'],
    })
    expect(distribution).toMatchObject({
      extensionId: 'workbuddy-control-desktop',
      status: 'active',
      resident: true,
      grantedPermissions: extension.permissions,
      processPolicy: { server: 'fork' },
    })
    expect(serverSource).toContain('pipe-server.ps1')
    expect(serverSource).not.toContain('createServer')
    expect(pipeServerSource).toContain('SetAccessRuleProtection(true, false)')
    expect(pipeServerSource).toContain('NamedPipeServerStream')
  })

  it('bridges an allowed Pipe invoke to daemon process IPC and returns the daemon result', async () => {
    const requests: Record<string, unknown>[] = []
    const extension = startExtension((message, child) => {
      requests.push(message)
      child.send?.({
        type: 'invoke:response',
        requestId: message.requestId,
        result: { sessionId: 'session-real-1', status: 'working', title: '读取并追加文件内容' },
      })
    })
    await extension.ready

    await expect(extension.client.ping()).resolves.toEqual({ extensionVersion: '0.1.0' })
    await expect(extension.client.invoke('session:get', ['session-real-1'])).resolves.toEqual({
      sessionId: 'session-real-1',
      status: 'working',
      title: '读取并追加文件内容',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      type: 'invoke:request',
      channel: 'session:get',
      args: [{}, 'session-real-1'],
    })
  })

  it('grants the Desktop Named Pipe only to the current Windows user SID', async () => {
    const extension = startExtension(() => undefined)
    await extension.ready

    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve(extensionRoot, 'server/pipe-security.ps1'),
      '-PipePath', extension.pipePath,
      '-ReadOnly',
    ])
    const security = JSON.parse(stdout.trim()) as { currentSid: string; sddl: string; aceSids: string[] }

    expect(security.sddl).toMatch(/^D:P/)
    expect(security.aceSids).toEqual([security.currentSid])
  })

  it('acknowledges detached sendMessage after IPC dispatch without waiting for the turn', async () => {
    let detachedRequest: Record<string, unknown> | undefined
    const extension = startExtension(message => { detachedRequest = message })
    await extension.ready

    await expect(extension.client.invokeDetached('session:sendMessage', ['session-real-2', 'continue'])).resolves.toBeUndefined()
    expect(detachedRequest).toMatchObject({
      type: 'invoke:request',
      channel: 'session:sendMessage',
      args: [{}, 'session-real-2', 'continue'],
    })
  })

  it('rejects daemon channels outside the Desktop Session and request-history RPCs', async () => {
    const extension = startExtension(() => { throw new Error('unsupported channel reached daemon IPC') })
    await extension.ready

    await expect(extension.client.invoke('account:getToken', [])).rejects.toThrow('not allowed')
  })

  it('returns WorkBuddy projected request entries through the exact conversations.requestEntries permission', async () => {
    const extension = startExtension((message, child) => {
      child.send?.({
        type: 'invoke:response',
        requestId: message.requestId,
        result: {
          historyReady: true,
          requests: [{ id: 'request-1', assistantMessage: { content: [{ type: 'text', text: 'persisted result' }] } }],
        },
      })
    })
    await extension.ready

    await expect(extension.client.invoke('wb:conversations:requestEntries', [
      'session-replay-1', { byteLength: 5 * 1024 * 1024 },
    ])).resolves.toMatchObject({ historyReady: true, requests: [{ id: 'request-1' }] })
  })

  it('rejects an in-flight daemon request when the Extension host disconnects', async () => {
    let requestReachedHost: (() => void) | undefined
    const reachedHost = new Promise<void>(resolvePromise => { requestReachedHost = resolvePromise })
    const extension = startExtension(() => requestReachedHost?.())
    await extension.ready

    const request = extension.client.invoke('session:get', ['session-pending'])
    await reachedHost
    extension.child.disconnect()

    await expect(request).rejects.toThrow('host IPC')
  })

  it('keeps the secure Pipe host alive when a client disconnects before the daemon responds', async () => {
    let requestReachedHost: (() => void) | undefined
    const reachedHost = new Promise<void>(resolvePromise => { requestReachedHost = resolvePromise })
    const extension = startExtension((message, child) => {
      requestReachedHost?.()
      setTimeout(() => child.send?.({
        type: 'invoke:response',
        requestId: message.requestId,
        result: { sessionId: 'abandoned-session' },
      }), 100)
    })
    await extension.ready

    await new Promise<void>((resolvePromise, reject) => {
      const socket = connect(extension.pipePath)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({
          id: randomUUID(),
          method: 'invoke',
          params: { channel: 'session:get', args: ['abandoned-session'] },
        })}\n`)
        socket.destroy()
        resolvePromise()
      })
    })
    await reachedHost
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))

    expect(extension.child.exitCode).toBeNull()
    await expect(extension.client.ping()).resolves.toEqual({ extensionVersion: '0.1.0' })
  })
})
