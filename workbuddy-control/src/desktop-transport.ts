import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { connect } from 'node:net'

interface PipeResponse<T> {
  id: string
  ok: boolean
  result?: T
  error?: { code?: string; message?: string }
}

export class DesktopUnavailableError extends Error {
  readonly code = 'WORKBUDDY_DESKTOP_UNAVAILABLE'

  constructor(message = 'WorkBuddy Desktop or the workbuddy-control Desktop Extension is unavailable.') {
    super(message)
    this.name = 'DesktopUnavailableError'
  }
}

export function getDesktopPipePath(): string {
  const userKey = createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\workbuddy-control-desktop-v1-${userKey}`
}

export const DEFAULT_DESKTOP_PIPE_PATH = getDesktopPipePath()

export class DesktopPipeClient {
  constructor(private readonly pipePath = DEFAULT_DESKTOP_PIPE_PATH) {}

  invoke<T>(channel: string, args: unknown[]): Promise<T> {
    return this.request<T>('invoke', { channel, args })
  }

  invokeDetached(channel: string, args: unknown[]): Promise<void> {
    return this.request<void>('invokeDetached', { channel, args })
  }

  ping(): Promise<{ extensionVersion: string; appVersion?: string }> {
    return this.request('ping', {})
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const socket = connect(this.pipePath)
      let responseText = ''
      let settled = false

      const finish = (error?: Error, value?: T) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (error !== undefined) reject(error)
        else resolve(value as T)
      }

      socket.setEncoding('utf8')
      socket.setTimeout(30_000)
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
      })
      socket.on('data', chunk => {
        responseText += chunk
        const newline = responseText.indexOf('\n')
        if (newline < 0) return
        try {
          const response = JSON.parse(responseText.slice(0, newline)) as PipeResponse<T>
          if (response.id !== id) throw new Error('Desktop Extension returned a mismatched response id.')
          if (!response.ok) {
            const error = new Error(response.error?.message ?? 'Desktop Extension request failed.')
            if (response.error?.code !== undefined) Object.assign(error, { code: response.error.code })
            finish(error)
            return
          }
          finish(undefined, response.result)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.once('timeout', () => finish(new DesktopUnavailableError('WorkBuddy Desktop Extension pipe timed out.')))
      socket.once('error', error => finish(new DesktopUnavailableError(`WorkBuddy Desktop Extension pipe is unavailable: ${error.message}`)))
      socket.once('end', () => {
        if (!settled) finish(new DesktopUnavailableError('WorkBuddy Desktop Extension pipe closed without a response.'))
      })
    })
  }
}
