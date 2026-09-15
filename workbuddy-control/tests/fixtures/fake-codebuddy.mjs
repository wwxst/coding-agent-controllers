import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const child = process.env.FAKE_RUNNING_CHILD === '1'
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  : undefined

const server = createServer((request, response) => {
  if (request.url === '/child-pid') response.end(String(child?.pid ?? 0))
  else if (request.url === '/auth') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      authenticated: request.headers.authorization === `Bearer ${process.env.CODEBUDDY_GATEWAY_PASSWORD}`
        && request.headers['x-codebuddy-request'] === '1',
    }))
  }
  else if (request.url === '/args') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(process.argv.slice(2)))
  }
  else response.end('{}')
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') process.exit(1)
  process.stdout.write(`decoy http://127.0.0.1:1\n\n  CodeBuddy Code HTTP Server\n\n  Endpoint    http://127.0.0.1:${address.port}\n`)
})

process.stdin.resume()
