const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const extensionVersion = '0.1.0'
const allowedChannels = new Set([
  'session:create',
  'session:get',
  'session:load',
  'session:sendMessage',
  'session:cancel',
  'wb:conversations:requestEntries',
])
const pending = new Map()

function defaultPipePath() {
  const userKey = createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\workbuddy-control-desktop-v1-${userKey}`
}

function sendToHost(channel, args, detached) {
  if (!allowedChannels.has(channel)) {
    throw Object.assign(new Error(`Desktop daemon channel is not allowed: ${channel}`), {
      code: 'WORKBUDDY_DESKTOP_CHANNEL_NOT_ALLOWED',
    })
  }
  if (typeof process.send !== 'function') {
    throw Object.assign(new Error('WorkBuddy Desktop Extension host IPC is unavailable.'), {
      code: 'WORKBUDDY_DESKTOP_UNAVAILABLE',
    })
  }

  const requestId = `workbuddy_control_${randomUUID()}`
  process.send({ type: 'invoke:request', requestId, channel, args: [{}, ...args] })
  if (detached) return Promise.resolve()
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }))
}

process.on('message', message => {
  if (message === null || typeof message !== 'object') return
  if (message.type !== 'invoke:response') return
  const request = pending.get(message.requestId)
  if (request === undefined) return
  pending.delete(message.requestId)
  if (message.error !== undefined) {
    const error = new Error(message.error.message ?? String(message.error))
    if (message.error.code !== undefined) error.code = message.error.code
    request.reject(error)
    return
  }
  request.resolve(message.result)
})

async function handlePipeRequest(line) {
  let request
  try {
    request = JSON.parse(line)
    let result
    if (request.method === 'ping') {
      result = { extensionVersion }
    } else if (request.method === 'invoke' || request.method === 'invokeDetached') {
      const { channel, args } = request.params
      result = await sendToHost(channel, args, request.method === 'invokeDetached')
    } else {
      throw Object.assign(new Error(`Desktop bridge method is not supported: ${request.method}`), {
        code: 'WORKBUDDY_DESKTOP_METHOD_NOT_SUPPORTED',
      })
    }
    return { id: request.id, ok: true, result }
  } catch (error) {
    return {
      id: request?.id,
      ok: false,
      error: {
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

const pipePath = process.env.WORKBUDDY_DESKTOP_PIPE_PATH ?? defaultPipePath()
const pipePrefix = '\\\\.\\pipe\\'
if (!pipePath.startsWith(pipePrefix)) throw new Error(`Desktop pipe path is invalid: ${pipePath}`)
const pipeHost = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', join(__dirname, 'pipe-server.ps1'),
  '-PipeName', pipePath.slice(pipePrefix.length),
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const pipeLines = createInterface({ input: pipeHost.stdout })
let shuttingDown = false
let ready = false

pipeLines.on('line', line => {
  if (line === 'READY') {
    ready = true
    process.send?.({
      type: 'wb-extension-ready',
      extensionId: process.env.WB_EXTENSION_ID ?? 'workbuddy-control-desktop',
      pid: process.pid,
    })
    return
  }
  const separator = line.indexOf('\t')
  if (separator <= 0) return
  const relayId = line.slice(0, separator)
  void handlePipeRequest(line.slice(separator + 1)).then(response => {
    if (pipeHost.stdin.writable) pipeHost.stdin.write(`${relayId}\t${JSON.stringify(response)}\n`)
  })
})

pipeHost.stderr.on('data', chunk => process.stderr.write(chunk))
pipeHost.once('error', error => failPipeHost(error))
pipeHost.once('exit', code => {
  if (!shuttingDown) failPipeHost(new Error(`Secure Named Pipe host exited with code ${code}.`))
})

function rejectPending(error) {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function failPipeHost(error) {
  const unavailable = new Error(`WorkBuddy Desktop secure pipe host failed: ${error.message}`)
  unavailable.code = 'WORKBUDDY_DESKTOP_UNAVAILABLE'
  rejectPending(unavailable)
  if (!ready) process.stderr.write(`${unavailable.message}\n`)
  process.exit(1)
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const error = new Error('WorkBuddy Desktop Extension host IPC disconnected.')
  error.code = 'WORKBUDDY_DESKTOP_UNAVAILABLE'
  rejectPending(error)
  setImmediate(() => {
    pipeHost.stdin.end()
    if (pipeHost.exitCode === null) pipeHost.kill()
    process.exit(0)
  })
}

process.once('SIGTERM', shutdown)
process.once('disconnect', shutdown)
