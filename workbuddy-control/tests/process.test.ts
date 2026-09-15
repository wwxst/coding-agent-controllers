import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startWorkBuddy } from '../src/process.js'

const fixture = resolve(import.meta.dirname, 'fixtures/fake-codebuddy.mjs')
const cleanups: Array<() => Promise<void>> = []

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

describe('WorkBuddy service lifecycle', () => {
  it('parses only the official ready output and keeps the gateway password private', async () => {
    const service = await startWorkBuddy({ command: process.execPath, args: [fixture] })
    cleanups.push(service.close)

    expect(service.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(service).not.toHaveProperty('password')
    expect(service).not.toHaveProperty('gatewayPassword')
    await expect((await fetch(`${service.baseUrl}/args`)).json()).resolves.toEqual([
      '--serve', '--port', '0', '--agent', 'cli',
    ])
    await expect(service.request('/auth')).resolves.toEqual({ authenticated: true })
  })

  it('reaps the codebuddy process, its child, and listening port on explicit close during a run', async () => {
    const service = await startWorkBuddy({
      command: process.execPath,
      args: [fixture],
      env: { FAKE_RUNNING_CHILD: '1' },
    })
    cleanups.push(service.close)
    const childPid = Number(await (await fetch(`${service.baseUrl}/child-pid`)).text())
    const port = Number(new URL(service.baseUrl).port)

    await service.close()

    expect(processExists(service.pid)).toBe(false)
    expect(processExists(childPid)).toBe(false)
    await expect(portIsFree(port)).resolves.toBe(true)
  })

  it('uses the same idempotent close task for repeated close calls', async () => {
    const service = await startWorkBuddy({ command: process.execPath, args: [fixture] })
    const first = service.close()
    const second = service.close()

    expect(second).toBe(first)
    await first
    expect(processExists(service.pid)).toBe(false)
  })
})
