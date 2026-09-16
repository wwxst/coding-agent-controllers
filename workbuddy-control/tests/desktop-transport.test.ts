import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DesktopPipeClient, DesktopUnavailableError } from '../src/desktop-transport.js'

function testPipePath(): string {
  return `\\\\.\\pipe\\workbuddy-control-test-${randomUUID()}`
}

describe('DesktopPipeClient', () => {
  it('exchanges one newline-delimited request with the Desktop Extension pipe', async () => {
    const pipePath = testPipePath()
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', data => {
        const request = JSON.parse(data.trim()) as { id: string; method: string; params: unknown }
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { channel: request.params } })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipePath, resolve)
    })

    try {
      const client = new DesktopPipeClient(pipePath)
      await expect(client.invoke('session:get', ['session-1'])).resolves.toEqual({
        channel: { channel: 'session:get', args: ['session-1'] },
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reports Desktop or Extension absence as unavailable', async () => {
    const client = new DesktopPipeClient(testPipePath())

    await expect(client.invoke('session:get', ['missing'])).rejects.toEqual(expect.objectContaining({
      name: 'DesktopUnavailableError',
      code: 'WORKBUDDY_DESKTOP_UNAVAILABLE',
    } satisfies Partial<DesktopUnavailableError>))
  })
  it('allows Desktop session creation to exceed the short pipe connect window', async () => {
    const pipePath = testPipePath()
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', data => {
        setTimeout(() => {
          const request = JSON.parse(data.trim()) as { id: string }
          socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { sessionId: 'slow-session' } })}\n`)
        }, 3_200)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipePath, resolve)
    })

    try {
      await expect(new DesktopPipeClient(pipePath).invoke('session:create', [{ cwd: 'E:/safe' }])).resolves.toEqual({
        sessionId: 'slow-session',
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
