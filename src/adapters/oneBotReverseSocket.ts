import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { qqId } from './qqIdentity.js'
import { ONEBOT_MAX_PAYLOAD_BYTES } from './oneBotLimits.js'

export async function listenOneBotReverseSocket(options: {
  url: URL
  accountId: string
  accessToken: string
  available(): boolean
  accept(client: WebSocket): void
  onError(): void
}): Promise<{ close(): void }> {
  const { url } = options
  const expected = createHash('sha256').update(`Bearer ${options.accessToken}`).digest()
  const server = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Length': '0', Connection: 'close' }).end()
  })
  server.maxConnections = 32
  server.headersTimeout = 5_000
  server.requestTimeout = 5_000
  const sockets = new WebSocketServer({ noServer: true, maxPayload: ONEBOT_MAX_PAYLOAD_BYTES })
  const connections = new Set<Socket>()
  let closed = false
  let listening = false

  server.on('connection', socket => {
    connections.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => connections.delete(socket))
  })

  function close(): void {
    if (closed) return
    closed = true
    for (const client of sockets.clients) client.terminate()
    for (const socket of connections) socket.destroy()
    sockets.close()
    server.close()
    server.closeAllConnections()
  }

  server.on('upgrade', (request, socket, head) => {
    if (closed || request.url !== url.pathname) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const authorization = request.headers.authorization
    const received = createHash('sha256').update(typeof authorization === 'string' ? authorization : '').digest()
    if (!timingSafeEqual(received, expected) || qqId(request.headers['x-self-id']) !== options.accountId ||
        request.headers['x-client-role'] !== 'Universal') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (!options.available()) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    try {
      sockets.handleUpgrade(request, socket, head, client => {
        client.on('error', () => {})
        if (closed || !options.available()) { client.terminate(); return }
        try { options.accept(client) }
        catch { client.terminate(); options.onError() }
      })
    } catch { socket.destroy() }
  })

  await new Promise<void>((resolve, reject) => {
    server.on('error', () => {
      if (!listening) {
        close()
        reject(new Error('OneBot 反向 WebSocket 无法监听配置地址'))
      } else if (!closed) options.onError()
    })
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
    try {
      server.listen(Number(url.port || 80), hostname, () => {
        listening = true
        resolve()
      })
    } catch {
      close()
      reject(new Error('OneBot 反向 WebSocket 无法监听配置地址'))
    }
  })
  return { close }
}
