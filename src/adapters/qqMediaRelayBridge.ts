import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP, type Socket } from 'node:net'
import type { AgentDiagnostics } from '../modules/runtime/infrastructure/agentDiagnostics.js'
import type { AgentMediaArtifact, AgentMediaArtifactLease, AgentMediaArtifactReader, AgentMediaResourceContext, AgentMediaResourcePort } from '../contracts/agentMediaRelay.js'
import { validateAgentMediaArtifact } from '../modules/media/domain/agentMediaRelayPlan.js'
import { createAgentMediaArtifactStore } from '../modules/media/infrastructure/agentMediaArtifactStore.js'

const BLOCK = 1024 * 1024, TOTAL = 16 * 1024 * 1024 * 1024, COUNT = 128, LIFETIME = 90 * 60 * 1000
const failure = () => new Error('QQ 媒体临时资源不可用或操作已取消')
export interface QqMediaRelayResourceLease {
  /** Capability URL stays within the QQ adapter; never expose it to models or persistence. */
  readonly nativeUrl: string
  release(): Promise<void>
}
export interface QqMediaRelayBridgeOptions {
  readonly directory: string
  readonly resources: AgentMediaResourcePort
  readonly listen: { readonly host: string; readonly port: number }
  readonly advertisedOrigin: string
  readonly allowedPeers: readonly string[]
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  readonly maxTotalBytes?: number
  readonly maxArtifacts?: number
  /** Test/deployment callers may shorten the absolute capability lifetime. */
  readonly timeoutMs?: number
}
export interface QqMediaRelayBridge {
  stage(artifact: AgentMediaArtifact, context: AgentMediaResourceContext, callerMonitorsCurrent?: boolean): Promise<QqMediaRelayResourceLease>
  close(): Promise<void>
}
interface CapturedContext extends AgentMediaResourceContext {}
interface Route {
  readonly token: string
  readonly lease: AgentMediaArtifactLease
  readonly guard: ReturnType<typeof createGuard>
  readonly sockets: Set<Socket>
  readonly tasks: Set<Promise<void>>
  readonly inScope: ReturnType<typeof AsyncLocalStorage.snapshot>
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  requests: number
  reservedBytes: number
  revoked: boolean
  cleanup?: Promise<void>
}
function captureContext(context: AgentMediaResourceContext): CapturedContext {
  try {
    const signal = context.signal, isCurrent = context.isCurrent, ensureCurrent = context.ensureCurrent
    if (!(signal instanceof AbortSignal) || typeof isCurrent !== 'function' || ensureCurrent !== undefined && typeof ensureCurrent !== 'function') throw failure()
    return Object.freeze({ signal, isCurrent: () => isCurrent.call(context),
      ...(ensureCurrent ? { ensureCurrent: () => ensureCurrent.call(context) } : {}) })
  } catch { throw failure() }
}
function constructGuard(context: AgentMediaResourceContext, bridgeSignal: AbortSignal, extra?: AbortSignal, monitorCurrent = true) {
  const captured = captureContext(context), cancel = new AbortController()
  const signal = AbortSignal.any([captured.signal, bridgeSignal, cancel.signal, ...(extra ? [extra] : [])])
  const check = () => {
    try { if (signal.aborted || captured.isCurrent() !== true || signal.aborted) throw failure() } catch { throw failure() }
  }
  const timer = monitorCurrent ? setInterval(() => { try { check() } catch { cancel.abort() } }, 20) : undefined
  timer?.unref()
  const wait = <T>(promise: Promise<T>, late?: (value: T) => Promise<unknown>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(failure()) }
    promise.then(value => {
      signal.removeEventListener('abort', abort)
      try {
        if (settled) throw failure()
        check(); settled = true; resolve(value)
      } catch {
        settled = true
        if (late) void Promise.resolve().then(() => late(value)).catch(() => {})
        reject(failure())
      }
    }, () => { signal.removeEventListener('abort', abort); settled = true; reject(failure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  return { signal, check, wait, context: Object.freeze({ ...captured, signal }), async authorize() {
    check()
    if (captured.ensureCurrent) await wait(Promise.resolve().then(() => captured.ensureCurrent!()))
    check()
  }, dispose() { clearInterval(timer); cancel.abort() } }
}
function createGuard(context: AgentMediaResourceContext, bridgeSignal: AbortSignal, extra?: AbortSignal, monitorCurrent = true) {
  try { return constructGuard(context, bridgeSignal, extra, monitorCurrent) } catch { throw failure() }
}
function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure()
  return value
}
function normalizeIp(value: string): string {
  if (typeof value !== 'string' || value.includes('%')) throw failure()
  const family = isIP(value)
  if (family === 4) return value
  if (family !== 6) throw failure()
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/u.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}
function privateHttpHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const value = normalizeIp(hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)
  if (isIP(value) === 6) return value === '::1' || /^f[cd][a-f\d]{2}:/u.test(value)
  const [first, second] = value.split('.').map(Number)
  return first === 10 || first === 127 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168
}
function origin(input: string): URL {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\?#@%]/u.test(input) || !/^https?:\/\//u.test(input)) throw failure()
  const value = new URL(input)
  const authority = input.slice(input.indexOf('//') + 2).split('/')[0]!
  const literal = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0]!
  if (!value.hostname || value.username || value.password || value.pathname !== '/' || value.search || value.hash ||
      value.protocol !== 'http:' && value.protocol !== 'https:' || value.protocol === 'http:' &&
      (literal.toLowerCase() !== 'localhost' && !isIP(literal) || !privateHttpHost(value.hostname))) throw failure()
  // URL parsing must not erase an input path such as /a/.. .
  if (input.replace(/\/$/u, '') !== `${value.protocol}//${input.slice(input.indexOf('//') + 2).split('/')[0]}`) throw failure()
  return value
}

/** QQ-only, bounded private copy server. It never proxies caller-selected paths or URLs. */
export async function openQqMediaRelayBridge(options: QqMediaRelayBridgeOptions): Promise<QqMediaRelayBridge> {
  let listenHost: string, listenPort: number, advertised: URL, peers: Set<string>, maxTotalBytes: number, maxArtifacts: number, timeoutMs: number
  let resources: AgentMediaResourcePort, readSource: AgentMediaResourcePort['open'], directory: string
  try {
    listenHost = options.listen.host; listenPort = options.listen.port; advertised = origin(options.advertisedOrigin)
    if (!isIP(listenHost) || !Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw failure()
    if (!Array.isArray(options.allowedPeers) || options.allowedPeers.length < 1 || options.allowedPeers.length > 32) throw failure()
    peers = new Set(options.allowedPeers.map(normalizeIp))
    maxTotalBytes = bounded(options.maxTotalBytes, TOTAL); maxArtifacts = bounded(options.maxArtifacts, COUNT); timeoutMs = bounded(options.timeoutMs, LIFETIME)
    resources = options.resources; readSource = resources.open; directory = options.directory
    if (typeof readSource !== 'function') throw failure()
  } catch { throw failure() }
  const store = await createAgentMediaArtifactStore({ directory, maxTotalBytes, maxArtifacts }).catch(() => { throw failure() })
  const stop = new AbortController(), routes = new Map<string, Route>(), sockets = new Set<Socket>()
  const work = new Set<Promise<unknown>>(), cleanups = new Set<Promise<void>>()
  const externalCloses = new WeakMap<object, Promise<void>>()
  let closed = false, closing: Promise<void> | undefined, stagedBytes = 0, stagedCount = 0, listening = false
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise); void promise.then(() => work.delete(promise), () => work.delete(promise)); return promise
  }
  function closeExternal(reader: AgentMediaArtifactReader): Promise<void> {
    try {
      if (!reader || typeof reader !== 'object') return Promise.resolve()
      const prior = externalCloses.get(reader); if (prior) return prior
      const close = reader.close
      const result = typeof close === 'function' ? Promise.resolve().then(() => close.call(reader)).then(() => {}, () => {}) : Promise.resolve()
      externalCloses.set(reader, result); return result
    } catch { return Promise.resolve() }
  }
  function revoke(route: Route): Promise<void> {
    if (route.cleanup) return route.cleanup
    route.revoked = true; routes.delete(route.token); clearTimeout(route.timer)
    route.guard.signal.removeEventListener('abort', route.abort); route.guard.dispose()
    for (const socket of route.sockets) socket.destroy()
    route.cleanup = (async () => {
      await Promise.allSettled([...route.tasks])
      try { await route.lease.release() } finally { stagedBytes -= route.lease.artifact.sizeBytes; stagedCount-- }
    })().catch(() => { throw failure() })
    cleanups.add(route.cleanup); void route.cleanup.then(() => cleanups.delete(route.cleanup!), () => cleanups.delete(route.cleanup!))
    return route.cleanup
  }
  function deny(response: ServerResponse, status: number): void {
    if (response.destroyed || response.headersSent) { response.destroy(); return }
    response.writeHead(status, { 'Content-Length': '0', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }).end()
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.on('error', () => {})
    const task = serve(request, response)
    track(task); void task.catch(() => { response.destroy() })
  })
  server.maxConnections = 64; server.maxHeadersCount = 33; server.maxRequestsPerSocket = 1
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000
  server.setTimeout(15_000, socket => socket.destroy())
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    if (closed) socket.destroy()
  })
  server.on('clientError', (_error, socket) => { socket.destroy() })
  server.on('upgrade', (_request, socket) => { socket.destroy() })
  server.on('connect', (_request, socket) => { socket.destroy() })
  server.on('checkContinue', (_request, response) => { deny(response, 417) })
  server.on('checkExpectation', (_request, response) => { deny(response, 417) })
  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let route: Route | undefined, reader: AgentMediaArtifactReader | undefined, current: ReturnType<typeof createGuard> | undefined
    let registered: Promise<void> | undefined, finish!: () => void
    const cancel = new AbortController(), socket = request.socket, startedAt = performance.now()
    let sent = 0, idleTimeout = false, step = 'bridge_request_authorization'
    const socketTimedOut = () => { idleTimeout = true }
    const disconnected = () => { if (!response.writableFinished) cancel.abort() }
    response.once('close', disconnected); request.on('error', disconnected)
    try {
      if (closed) { deny(response, 503); return }
      let peer: string
      try { peer = normalizeIp(socket.remoteAddress ?? '') } catch { deny(response, 403); return }
      if (!peers.has(peer)) { deny(response, 403); return }
      if (request.rawHeaders.length > 64) { deny(response, 431); return }
      if (request.method !== 'GET' && request.method !== 'HEAD') { deny(response, 405); return }
      if (request.headers['transfer-encoding'] !== undefined || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') { deny(response, 413); return }
      const token = /^\/agent-media-relay\/([a-f\d]{64})$/u.exec(request.url ?? '')?.[1]
      route = token ? routes.get(token) : undefined
      if (!route || route.revoked || Date.now() >= route.expiresAt) { if (route) void revoke(route).catch(() => {}); deny(response, 404); return }
      route.guard.check()
      if (route.requests >= 32) { deny(response, 429); return }
      route.requests++
      if (request.headers.range !== undefined) { deny(response, 416); return }
      const size = route.lease.artifact.sizeBytes
      if (request.method === 'GET') {
        if (route.reservedBytes > size * 8 - size) { deny(response, 429); return }
        route.reservedBytes += size
      }
      registered = new Promise<void>(resolve => { finish = resolve }); route.tasks.add(registered); route.sockets.add(socket)
      socket.once('timeout', socketTimedOut)
      current = createGuard(route.guard.context, stop.signal, cancel.signal, false)
      await current.authorize(); route.guard.check()
      if (request.method === 'GET') {
        step = 'bridge_open_artifact'
        reader = await current.wait(store.openStream(route.lease.artifact, current.context), closeExternal)
      }
      step = 'bridge_request_authorization'
      await current.authorize(); route.guard.check()
      response.writeHead(200, { 'Content-Type': route.lease.artifact.mime, 'Content-Length': String(size),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'none', Connection: 'close' })
      const end = () => current!.wait(new Promise<void>((resolve, reject) => {
        const finish = () => { remove(); resolve() }, close = () => { remove(); reject(failure()) }
        const remove = () => { response.removeListener('finish', finish); response.removeListener('close', close) }
        response.once('finish', finish); response.once('close', close); response.end()
      }))
      step = 'bridge_finish'
      if (request.method === 'HEAD') { await end(); return }
      step = 'bridge_read_artifact'
      for await (const chunk of reader!.chunks) {
        step = 'bridge_request_authorization'
        await current.authorize(); route.guard.check()
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > BLOCK || chunk.byteLength > size - sent) throw failure()
        step = 'bridge_write_socket'
        const ready = response.write(chunk)
        sent += chunk.byteLength
        if (!ready) await current.wait(new Promise<void>((resolve, reject) => {
          const drain = () => { remove(); resolve() }, close = () => { remove(); reject(failure()) }
          const remove = () => { response.removeListener('drain', drain); response.removeListener('close', close) }
          response.once('drain', drain); response.once('close', close)
        }))
        step = 'bridge_read_artifact'
      }
      if (sent !== size) throw failure()
      step = 'bridge_finish'
      await current.authorize(); route.guard.check(); await end()
    } catch (error) {
      if (route && registered && !route.guard.signal.aborted) {
        const code = idleTimeout ? 'media_bridge_socket_timeout' : cancel.signal.aborted ? 'media_bridge_peer_closed' : 'media_bridge_read_failed'
        const bytesExpected = request.method === 'HEAD' ? 0 : route.lease.artifact.sizeBytes
        try {
          route.inScope(() => options.diagnostics?.emit({ stage: 'delivery', operation: 'qq_media_bridge', outcome: 'failed', code,
            durationMs: performance.now() - startedAt, ...(response.headersSent ? { httpStatus: response.statusCode } : {}),
            details: { step, bytesWritten: sent, bytesExpected }, error }))
        } catch { /* Observers cannot change the response. */ }
      }
      if (route && !cancel.signal.aborted) void revoke(route).catch(() => {})
      deny(response, 404)
    } finally {
      if (reader) await closeExternal(reader)
      current?.dispose(); response.removeListener('close', disconnected); request.removeListener('error', disconnected)
      socket.removeListener('timeout', socketTimedOut)
      if (route) { route.sockets.delete(socket); if (registered) route.tasks.delete(registered) }
      finish?.()
    }
  }
  async function stage(input: AgentMediaArtifact, context: AgentMediaResourceContext, callerMonitorsCurrent = false): Promise<QqMediaRelayResourceLease> {
    const current = createGuard(context, stop.signal, undefined, !callerMonitorsCurrent)
    let source: AgentMediaArtifactReader | undefined, lease: AgentMediaArtifactLease | undefined, committed = false, reserved = false
    let expected: Readonly<AgentMediaArtifact> | undefined, route: Route | undefined
    try {
      current.check(); if (closed) throw failure()
      expected = validateAgentMediaArtifact(input)
      if (stagedCount >= maxArtifacts || expected.sizeBytes > maxTotalBytes - stagedBytes) throw failure()
      stagedCount++; stagedBytes += expected.sizeBytes; reserved = true
      await current.authorize()
      source = await current.wait<AgentMediaArtifactReader>(Promise.resolve().then(() => readSource.call(resources, expected!, current.context)), closeExternal)
      const reader = source
      const copy = async function* (): AsyncGenerator<Uint8Array> {
        let iterator: AsyncIterator<Uint8Array> | undefined, size = 0
        try {
          iterator = reader.chunks[Symbol.asyncIterator]()
          while (true) {
            await current.authorize()
            const next = await current.wait(Promise.resolve().then(() => iterator!.next()))
            if (next.done) break
            const chunk = next.value
            if (!(chunk instanceof Uint8Array) || chunk.byteLength > expected!.sizeBytes - size) throw failure()
            size += chunk.byteLength
            if (!chunk.byteLength) { await current.wait(new Promise<void>(resolve => setImmediate(resolve))); continue }
            for (let at = 0; at < chunk.byteLength; at += BLOCK) {
              await current.authorize(); yield Buffer.from(chunk.subarray(at, Math.min(chunk.byteLength, at + BLOCK)))
            }
          }
          if (size !== expected!.sizeBytes) throw failure()
        } finally {
          try { const finish = iterator?.return; if (typeof finish === 'function') void Promise.resolve().then(() => finish.call(iterator)).catch(() => {}) } catch {}
        }
      }
      lease = await current.wait(store.stage({ kind: expected.kind, mime: expected.mime, chunks: copy() }, current.context), async late => late.release())
      const actual = lease.artifact
      if (actual.kind !== expected.kind || actual.mime !== expected.mime || actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) throw failure()
      await current.wait(closeExternal(source)); source = undefined
      await current.authorize(); if (closed) throw failure()
      const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + timeoutMs
      const abort = () => { void revoke(route!).catch(() => {}) }
      const timer = setTimeout(abort, timeoutMs); timer.unref()
      route = { token, lease, guard: current, inScope: AsyncLocalStorage.snapshot(), expiresAt, timer, abort,
        sockets: new Set(), tasks: new Set(), requests: 0, reservedBytes: 0, revoked: false }
      routes.set(token, route); current.signal.addEventListener('abort', abort, { once: true })
      current.check(); committed = true
      const selected = route
      return Object.freeze({ nativeUrl: `${advertised.origin}/agent-media-relay/${token}`, release: () => revoke(selected) })
    } catch { throw failure() }
    finally {
      if (source) { const closingSource = closeExternal(source); try { await current.wait(closingSource) } catch {} }
      if (!committed) {
        if (route) await revoke(route).catch(() => {})
        else { current.dispose(); if (lease) await lease.release().catch(() => {}); if (reserved) { stagedCount--; stagedBytes -= expected!.sizeBytes } }
      }
    }
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true; stop.abort()
    const revoked = [...routes.values()].map(revoke)
    const listener = new Promise<void>(resolve => { if (!listening) { resolve(); return }; server.close(() => resolve()) })
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    closing = (async () => {
      await Promise.allSettled([...work, ...revoked, ...cleanups])
      await store.close(); await listener
    })().catch(() => { throw failure() })
    return closing
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', () => { if (!listening) reject(failure()); else void close().catch(() => {}) })
      server.listen(listenPort, listenHost, () => { listening = true; resolve() })
    })
    const bound = server.address()
    if (!bound || typeof bound !== 'object') throw failure()
    if (advertised.port === '0') advertised.port = String(bound.port)
  } catch { await close().catch(() => {}); throw failure() }
  const bridge: QqMediaRelayBridge = { stage: (artifact, context, callerMonitorsCurrent) => track(stage(artifact, context, callerMonitorsCurrent)), close }
  return Object.freeze(bridge)
}
