import type { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { HarnessControl } from './control.js'

export interface HarnessControlApi {
  run(cwd: string, prompt: string): Promise<{ taskId: string }>
  status(taskId: string): object
  result(taskId: string): object
  cancel(taskId: string): Promise<{ accepted: true }>
  resume(taskId: string, prompt: string): Promise<{ taskId: string }>
  close(): Promise<void>
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const actionAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

function toolResult(value: object) {
  const structuredContent = { ...value }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

export function createHarnessMcpServer(control: HarnessControlApi, input?: Readable): McpServer {
  const server = new McpServer(
    { name: 'deepseek-harness-control', version: '0.1.0' },
    { instructions: 'Communicate with DeepSeek Harness through its stdio TypeScript SDK. The taskId is the Harness sessionId.' },
  )

  server.registerTool('run', {
    description: 'Start a DeepSeek Harness turn in a workspace and return its sessionId as taskId.',
    inputSchema: { cwd: z.string().min(1), prompt: z.string().min(1) },
    annotations: actionAnnotations,
  }, async ({ cwd, prompt }) => toolResult(await control.run(cwd, prompt)))

  server.registerTool('status', {
    description: 'Read the in-process running or idle projection for a taskId.',
    inputSchema: { taskId: z.string().min(1) },
    annotations: readOnlyAnnotations,
  }, ({ taskId }) => toolResult(control.status(taskId)))

  server.registerTool('result', {
    description: 'Read the latest in-process finalResponse or error for a taskId.',
    inputSchema: { taskId: z.string().min(1) },
    annotations: readOnlyAnnotations,
  }, ({ taskId }) => toolResult(control.result(taskId)))

  server.registerTool('cancel', {
    description: 'Forward cancellation to the existing DeepSeek Harness SDK session.',
    inputSchema: { taskId: z.string().min(1) },
    annotations: actionAnnotations,
  }, async ({ taskId }) => toolResult(await control.cancel(taskId)))

  server.registerTool('resume', {
    description: 'Run another turn on the same DeepSeek Harness sessionId.',
    inputSchema: { taskId: z.string().min(1), prompt: z.string().min(1) },
    annotations: actionAnnotations,
  }, async ({ taskId, prompt }) => toolResult(await control.resume(taskId, prompt)))

  const closeTransport = server.close.bind(server)
  let closeTask: Promise<void> | undefined
  const close = (): Promise<void> => {
    // MCP SDK 的 onclose 是同步回调；所有关闭入口共享这个可等待任务。
    closeTask ??= (async () => {
      await control.close()
      await closeTransport()
    })()
    return closeTask
  }
  server.close = close
  server.server.onclose = () => { void close() }
  input?.once('end', () => { void close() })
  return server
}

async function main(): Promise<void> {
  const server = createHarnessMcpServer(new HarnessControl(), process.stdin)
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
