import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, unlink, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP, type Socket } from 'node:net'
import path from 'node:path'
import { types } from 'node:util'
import type { AgentMediaResourceContext } from '../contracts/agentMediaRelay.js'

const BLOCK = 1024 * 1024
const failure = () => new Error('QQ 临时文件资源不可用或操作已取消')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface QqBoundedFile {
  readonly name: string
  readonly mime: string
  readonly base64: string
}
export interface QqBoundedFileLease {
  /** Private capability; never return to Core, tools, users or persistence. */
  readonly nativeUrl: string
  release(): Promise<void>
}
export interface QqBoundedFileBridgeOptions {
  readonly directory: string
  readonly listen: { readonly host: string; readonly port: number }
  readonly advertisedOrigin: string
  readonly allowedPeers: readonly string[]
  readonly maxTotalBytes?: number
  readonly maxFiles?: number
  readonly timeoutMs?: number
}
export interface QqBoundedFileBridge<File extends QqBoundedFile> {
  stage(file: File, context: AgentMediaResourceContext): Promise<QqBoundedFileLease>
  close(): Promise<void>
}
interface Policy<File extends QqBoundedFile> {
  readonly validate: (input: unknown) => Readonly<File>
  readonly maxTotalBytes: number
  readonly maxFiles: number
  readonly timeoutMs: number
  readonly resourcePath: string
  readonly directoryPrefix: string
}
function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure()
  return value
}
function ip(input: string): string {
  if (typeof input !== 'string' || input.includes('%') || !isIP(input)) throw failure()
  if (isIP(input) === 4) return input
  const value = new URL(`http://[${input}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/u.exec(value)
  if (!mapped) return value
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}
function origin(input: string): URL {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\?#@%]/u.test(input) || !/^https?:\/\//u.test(input)) throw failure()
  const url = new URL(input), authority = input.slice(input.indexOf('//') + 2).split('/')[0]!
  const literal = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0]!
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      input.replace(/\/$/u, '') !== `${url.protocol}//${authority}`) throw failure()
  if (url.protocol === 'http:') {
    const address = literal === 'localhost' ? '127.0.0.1' : ip(literal), [first, second] = address.split('.').map(Number)
    if (!(address === '::1' || /^f[cd][a-f\d]{2}:/u.test(address) || first === 10 || first === 127 ||
      first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168)) throw failure()
  }
  return url
}
function guard(context: AgentMediaResourceContext, stopped: AbortSignal) {
  try {
    const caller = context.signal, isCurrent = context.isCurrent, ensureCurrent = context.ensureCurrent
    if (!(caller instanceof AbortSignal) || types.isProxy(caller) || typeof isCurrent !== 'function' || ensureCurrent !== undefined && typeof ensureCurrent !== 'function') throw failure()
    const cancel = new AbortController(), signal = AbortSignal.any([caller, stopped, cancel.signal])
    const check = () => { try { if (signal.aborted || isCurrent.call(context) !== true || signal.aborted) throw failure() } catch { throw failure() } }
    const timer = setInterval(() => { try { check() } catch { cancel.abort() } }, 20); timer.unref()
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(failure()), clear = () => signal.removeEventListener('abort', abort)
      promise.then(value => { clear(); try { check(); resolve(value) } catch { reject(failure()) } }, () => { clear(); reject(failure()) })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    return { signal, check, async authorize() {
      check(); if (ensureCurrent) await wait(Promise.resolve().then(() => ensureCurrent.call(context))); check()
    }, dispose() { clearInterval(timer); cancel.abort() } }
  } catch { throw failure() }
}
type Guard = ReturnType<typeof guard>
interface Entry {
  readonly token: string
  readonly filename: string
  readonly size: number
  readonly mime: string
  readonly sha256: string
  readonly blocks: readonly string[]
  readonly stat: Stats
  readonly guard: Guard
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  readonly sockets: Set<Socket>
  readonly tasks: Set<Promise<void>>
  requests: number
  sentBudget: number
  cleanup?: Promise<void>
}

/** Internal bounded capability server. Each public wrapper owns its artifact validator and hard limits. */
export async function openQqBoundedFileBridge<File extends QqBoundedFile>(options: QqBoundedFileBridgeOptions, policy: Policy<File>): Promise<QqBoundedFileBridge<File>> {
  let parent: string, host: string, port: number, advertised: URL, peers: Set<string>, maxBytes: number, maxCount: number, ttl: number
  try {
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) throw failure()
    parent = await realpath(options.directory)
    if (!(await lstat(parent)).isDirectory()) throw failure()
    host = options.listen.host; port = options.listen.port; advertised = origin(options.advertisedOrigin)
    if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !Array.isArray(options.allowedPeers) || options.allowedPeers.length < 1 || options.allowedPeers.length > 32) throw failure()
    peers = new Set(options.allowedPeers.map(ip)); maxBytes = bound(options.maxTotalBytes, policy.maxTotalBytes)
    maxCount = bound(options.maxFiles, policy.maxFiles); ttl = bound(options.timeoutMs, policy.timeoutMs)
  } catch { throw failure() }
  const directory = await mkdtemp(path.join(parent, policy.directoryPrefix)).catch(() => { throw failure() })
  let owned: Stats
  try { await chmod(directory, 0o700); owned = await lstat(directory) }
  catch { await rm(directory, { recursive: true, force: true }); throw failure() }
  const entries = new Map<string, Entry>(), sockets = new Set<Socket>(), work = new Set<Promise<unknown>>(), cleanups = new Set<Promise<void>>()
  const resource = new RegExp(`^/${policy.resourcePath}/([a-f\\d]{64})$`, 'u')
  const stopped = new AbortController()
  let closed = false, closing: Promise<void> | undefined, listening = false, bytes = 0, count = 0
  const ownDirectory = async () => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== owned.ino || stat.dev !== owned.dev || (stat.mode & 0o777) !== 0o700) throw failure()
  }
  const same = (actual: Stats, expected: Stats) => actual.isFile() && !actual.isSymbolicLink() && actual.ino === expected.ino &&
    actual.dev === expected.dev && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs && (actual.mode & 0o777) === 0o400
  function track<T>(operation: Promise<T>): Promise<T> {
    work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation
  }
  function revoke(entry: Entry): Promise<void> {
    if (entry.cleanup) return entry.cleanup
    entries.delete(entry.token); clearTimeout(entry.timer); entry.guard.signal.removeEventListener('abort', entry.abort); entry.guard.dispose()
    for (const socket of entry.sockets) socket.destroy()
    entry.cleanup = (async () => {
      await Promise.allSettled([...entry.tasks]); await ownDirectory(); await unlink(entry.filename)
      bytes -= entry.size; count--
    })().catch(() => { throw failure() })
    cleanups.add(entry.cleanup); void entry.cleanup.then(() => cleanups.delete(entry.cleanup!), () => cleanups.delete(entry.cleanup!)); return entry.cleanup
  }
  const deny = (response: ServerResponse, code: number) => {
    if (response.headersSent) { response.destroy(); return }
    response.writeHead(code, { 'Content-Length': '0', 'Cache-Control': 'no-store', Connection: 'close' }); response.end()
  }
  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let entry: Entry | undefined, handle: FileHandle | undefined, task: Promise<void> | undefined, finish: (() => void) | undefined
    const socket = request.socket
    try {
      if (closed) { deny(response, 503); return }
      let remote: string
      try { remote = ip(socket.remoteAddress ?? '') } catch { deny(response, 403); return }
      if (!peers.has(remote)) { deny(response, 403); return }
      if (request.rawHeaders.length > 64) { deny(response, 431); return }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { deny(response, 405); return }
      if (request.headers['transfer-encoding'] !== undefined || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') { deny(response, 413); return }
      const token = resource.exec(request.url ?? '')?.[1]
      entry = token ? entries.get(token) : undefined
      if (!entry || Date.now() >= entry.expiresAt) { if (entry) void revoke(entry).catch(() => {}); deny(response, 404); return }
      entry.guard.check()
      if (entry.requests++ >= 32) { deny(response, 429); return }
      if (request.headers.range !== undefined) { deny(response, 416); return }
      const get = request.method === 'GET'
      if (get && entry.sentBudget >= entry.size * 8) { deny(response, 429); return }
      if (get) entry.sentBudget += entry.size
      task = new Promise<void>(resolve => { finish = resolve }); entry.tasks.add(task); entry.sockets.add(socket)
      await entry.guard.authorize(); await ownDirectory()
      if (!same(await lstat(entry.filename), entry.stat)) throw failure()
      handle = await open(entry.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!same(await handle.stat(), entry.stat)) throw failure()
      await entry.guard.authorize()
      response.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': String(entry.size), 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'none', Connection: 'close' })
      if (get) {
        const hash = createHash('sha256')
        for (let at = 0, block = 0; at < entry.size; block++) {
          await entry.guard.authorize()
          if (socket.destroyed || !same(await handle.stat(), entry.stat)) throw failure()
          const buffer = Buffer.allocUnsafe(Math.min(BLOCK, entry.size - at))
          let filled = 0
          while (filled < buffer.length) { const read = await handle.read(buffer, filled, buffer.length - filled, at + filled); if (!read.bytesRead) throw failure(); filled += read.bytesRead }
          if (sha(buffer) !== entry.blocks[block]) throw failure()
          hash.update(buffer); at += buffer.length; entry.guard.check()
          if (!response.write(buffer)) await new Promise<void>((resolve, reject) => {
            const clear = () => { response.removeListener('drain', drain); response.removeListener('close', close) }
            const drain = () => { clear(); resolve() }, close = () => { clear(); reject(failure()) }
            response.once('drain', drain); response.once('close', close)
          })
        }
        if (hash.digest('hex') !== entry.sha256 || !same(await handle.stat(), entry.stat)) throw failure()
      }
      await entry.guard.authorize()
      await new Promise<void>((resolve, reject) => {
        const clear = () => { response.removeListener('finish', finish); response.removeListener('close', close) }
        const finish = () => { clear(); resolve() }, close = () => { clear(); reject(failure()) }
        response.once('finish', finish); response.once('close', close); response.end()
      })
    } catch { if (entry) void revoke(entry).catch(() => {}); deny(response, 404) }
    finally { await handle?.close().catch(() => {}); if (entry) { entry.sockets.delete(socket); if (task) entry.tasks.delete(task) }; finish?.() }
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1 },
    (request, response) => { void track(serve(request, response)) })
  server.maxConnections = 16
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(ttl, () => socket.destroy()) })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.on('connect', (_request, socket) => socket.destroy())
  server.on('checkContinue', (_request, response) => deny(response, 417))
  server.on('checkExpectation', (_request, response) => deny(response, 417))
  async function stage(input: File, context: AgentMediaResourceContext): Promise<QqBoundedFileLease> {
    const current = guard(context, stopped.signal)
    let filename: string | undefined, handle: FileHandle | undefined, reserved = false, committed = false, size = 0, entry: Entry | undefined
    try {
      current.check(); if (closed) throw failure()
      const archive = policy.validate(input), contents = Buffer.from(archive.base64, 'base64'); size = contents.length
      if (count >= maxCount || size > maxBytes - bytes) throw failure()
      count++; bytes += size; reserved = true
      await current.authorize(); await ownDirectory(); current.check()
      filename = path.join(directory, randomBytes(24).toString('hex'))
      handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const hash = createHash('sha256'), blocks: string[] = []
      for (let at = 0; at < size; at += BLOCK) {
        await current.authorize(); const block = contents.subarray(at, Math.min(size, at + BLOCK)); hash.update(block); blocks.push(sha(block))
        let written = 0
        while (written < block.length) { const result = await handle.write(block, written, block.length - written, at + written); if (!result.bytesWritten) throw failure(); written += result.bytesWritten }
      }
      await handle.sync(); await handle.chmod(0o400); const stat = await handle.stat(); await handle.close(); handle = undefined
      if (stat.size !== size || !same(await lstat(filename), stat)) throw failure()
      await current.authorize(); if (closed) throw failure()
      const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + ttl
      const abort = () => { if (entry) void revoke(entry).catch(() => {}) }, timer = setTimeout(abort, ttl); timer.unref()
      entry = { token, filename, size, mime: archive.mime, sha256: hash.digest('hex'), blocks: Object.freeze(blocks), stat, guard: current,
        expiresAt, timer, abort, sockets: new Set(), tasks: new Set(), requests: 0, sentBudget: 0 }
      entries.set(token, entry); current.signal.addEventListener('abort', abort, { once: true }); current.check(); committed = true
      const selected = entry
      return Object.freeze({ nativeUrl: `${advertised.origin}/${policy.resourcePath}/${token}`, release: () => revoke(selected) })
    } catch { throw failure() }
    finally {
      await handle?.close().catch(() => {})
      if (!committed) {
        if (entry) await revoke(entry).catch(() => {})
        else { current.dispose(); if (filename) { try { await ownDirectory(); await unlink(filename) } catch {} }; if (reserved) { count--; bytes -= size } }
      }
    }
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true; stopped.abort()
    const revoked = [...entries.values()].map(revoke), listener = new Promise<void>(resolve => { if (!listening) { resolve(); return }; server.close(() => resolve()) })
    for (const socket of sockets) socket.destroy(); server.closeAllConnections()
    closing = (async () => {
      await Promise.allSettled([...work, ...revoked, ...cleanups]); await listener
      await ownDirectory(); await rm(directory, { recursive: true, force: true })
    })().catch(() => { throw failure() }); return closing
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', () => { if (!listening) reject(failure()); else void close().catch(() => {}) })
      server.listen(port, host, () => { listening = true; resolve() })
    })
    const address = server.address(); if (!address || typeof address !== 'object') throw failure()
    if (advertised.port === '0') advertised.port = String(address.port)
  } catch { await close().catch(() => {}); throw failure() }
  const bridge: QqBoundedFileBridge<File> = { stage: (archive, context) => track(stage(archive, context)), close }
  return Object.freeze(bridge)
}
