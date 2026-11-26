import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { AgentMediaArtifact, AgentMediaArtifactLease, AgentMediaArtifactReader, AgentMediaResourceContext, AgentMediaResourcePort } from '../../../contracts/agentMediaRelay.js'
import { agentErrorDetails, annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'

export const MAX_AGENT_ARTIFACT_VIDEO_BYTES = 512 * 1024 * 1024
export const MAX_AGENT_ARTIFACT_IMAGE_BYTES = 32 * 1024 * 1024
const BLOCK = 1024 * 1024, HEADER = 65536, TOTAL = 16 * 1024 * 1024 * 1024, COUNT = 128
const failure = (cause?: unknown) => annotateAgentError(new Error('媒体资源不可用或操作已取消'), agentErrorDetails(cause) ?? {})
export interface AgentMediaArtifactStoreOptions {
  readonly directory: string
  readonly maxTotalBytes?: number
  readonly maxArtifacts?: number
}
export interface AgentMediaArtifactStore extends AgentMediaResourcePort {
  stage(input: { readonly kind: 'image' | 'video'; readonly mime: string; readonly chunks: AsyncIterable<Uint8Array> }, context: AgentMediaResourceContext): Promise<AgentMediaArtifactLease>
  openStream(artifact: AgentMediaArtifact, context: AgentMediaResourceContext): Promise<AgentMediaArtifactReader>
  close(): Promise<void>
}
interface Entry {
  readonly artifact: Readonly<AgentMediaArtifact>
  readonly filename: string
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly blocks: readonly string[]
  readonly abort: AbortController
  readonly readers: Set<() => Promise<void>>
  readonly opens: Set<Promise<void>>
  refs: number
  revoked: boolean
  cleanup?: Promise<void>
}
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const videoTypes = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'])
const textAt = (bytes: Buffer, at: number, text: string) => bytes.subarray(at, at + text.length).equals(Buffer.from(text, 'ascii'))
function brands(bytes: Buffer): string[] {
  if (bytes.length < 24 || !textAt(bytes, 4, 'ftyp')) return []
  const size = bytes.readUInt32BE(0)
  if (size < 16 || size > HEADER || size > bytes.length || size % 4) return []
  const result = [bytes.toString('ascii', 8, 12)]
  for (let at = 16; at + 4 <= size; at += 4) result.push(bytes.toString('ascii', at, at + 4))
  return result
}
/** Bounded header/container checks; these do not claim decoding or playback. */
function headerValid(mime: string, bytes: Buffer, size: number): boolean {
  if (mime === 'image/png') return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && textAt(bytes, 12, 'IHDR') && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
  if (mime === 'image/gif') return bytes.length >= 13 && (textAt(bytes, 0, 'GIF87a') || textAt(bytes, 0, 'GIF89a')) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0
  if (mime === 'image/bmp') return bytes.length >= 54 && textAt(bytes, 0, 'BM') && bytes.readUInt32LE(2) === size &&
    bytes.readUInt32LE(10) >= 54 && bytes.readUInt32LE(10) < size && bytes.readUInt32LE(14) >= 40 &&
    bytes.readInt32LE(18) > 0 && bytes.readInt32LE(22) !== 0 && bytes.readUInt16LE(26) === 1 && [1, 4, 8, 16, 24, 32].includes(bytes.readUInt16LE(28))
  if (mime === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) return false
      while (bytes[at] === 0xff) at++
      const marker = bytes[at++]; if (marker === undefined || marker === 0xda || marker === 0xd9) return false
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (at + 2 > bytes.length) return false
      const length = bytes.readUInt16BE(at)
      if (length < 2 || at + length > bytes.length) return false
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return length >= 8 && bytes[at + 2]! > 0 && bytes.readUInt16BE(at + 3) > 0 && bytes.readUInt16BE(at + 5) > 0
      at += length
    }
    return false
  }
  if (mime === 'image/webp') {
    if (bytes.length < 20 || !textAt(bytes, 0, 'RIFF') || !textAt(bytes, 8, 'WEBP') || bytes.readUInt32LE(4) + 8 !== size || bytes.readUInt32LE(16) + 20 > size) return false
    if (textAt(bytes, 12, 'VP8X')) return bytes.length >= 30 && bytes.readUInt32LE(16) >= 10
    if (textAt(bytes, 12, 'VP8L')) return bytes.length >= 25 && bytes[20] === 0x2f && (bytes[24]! & 0xe0) === 0
    return bytes.length >= 30 && textAt(bytes, 12, 'VP8 ') && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])) && (bytes.readUInt16LE(26) & 0x3fff) > 0 && (bytes.readUInt16LE(28) & 0x3fff) > 0
  }
  if (mime === 'image/avif') return brands(bytes).some(brand => ['avif', 'avis'].includes(brand))
  if (mime === 'video/mp4') return brands(bytes).some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV'].includes(brand))
  if (mime === 'video/quicktime') return brands(bytes).includes('qt  ')
  if (mime === 'video/webm') return bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])) && bytes.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]))
  if (mime === 'video/x-flv') {
    if (bytes.length < 13 || !textAt(bytes, 0, 'FLV') || bytes[3] !== 1 || (bytes[4]! & ~5) !== 0) return false
    const offset = bytes.readUInt32BE(5)
    return offset >= 9 && offset + 4 <= bytes.length && offset + 4 <= size && bytes.readUInt32BE(offset) === 0
  }
  return false
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw failure()
  return value
}
function sameArtifact(input: AgentMediaArtifact, expected: AgentMediaArtifact): boolean {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false
    const keys = ['id', 'kind', 'mime', 'sizeBytes', 'sha256'] as const
    return Reflect.ownKeys(input).length === keys.length && Reflect.ownKeys(input).every(key => typeof key === 'string' && keys.includes(key as typeof keys[number]) && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) &&
      keys.every(key => input[key] === expected[key])
  } catch { return false }
}

export async function createAgentMediaArtifactStore(options: AgentMediaArtifactStoreOptions): Promise<AgentMediaArtifactStore> {
  let directory = '', totalLimit: number, artifactLimit: number, owned: Stats
  try {
    totalLimit = limit(options.maxTotalBytes, TOTAL); artifactLimit = limit(options.maxArtifacts, COUNT)
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) throw failure()
    const parent = await realpath(options.directory)
    if (!(await lstat(parent)).isDirectory()) throw failure()
    directory = await mkdtemp(path.join(parent, 'agent-media-'))
    await chmod(directory, 0o700)
    owned = await lstat(directory)
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw failure()
  }
  const stop = new AbortController(), entries = new Map<string, Entry>()
  const work = new Set<Promise<unknown>>(), cleanups = new Set<Promise<void>>()
  let closed = false, closePromise: Promise<void> | undefined, totalBytes = 0, artifacts = 0, readers = 0
  const ownDirectory = async () => {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino || (stat.mode & 0o777) !== 0o700) throw failure()
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    work.add(operation); void operation.then(() => work.delete(operation), () => work.delete(operation)); return operation
  }
  function guard(context: AgentMediaResourceContext, extra?: AbortSignal) {
    try {
      if (!context) throw failure()
      const callerSignal = context.signal, isCurrent = context.isCurrent, ensureCurrent = context.ensureCurrent
      if (!(callerSignal instanceof AbortSignal) || typeof isCurrent !== 'function' || ensureCurrent !== undefined && typeof ensureCurrent !== 'function') throw failure()
      const cancel = new AbortController(), signal = AbortSignal.any([stop.signal, callerSignal, cancel.signal, ...(extra ? [extra] : [])])
      const check = () => {
        try { if (closed || signal.aborted || isCurrent.call(context) !== true) throw failure() } catch { throw failure() }
      }
      const timer = setInterval(() => { try { check() } catch { cancel.abort() } }, 20); timer.unref()
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => reject(failure()), clear = () => signal.removeEventListener('abort', abort)
        promise.then(value => { clear(); try { check(); resolve(value) } catch { reject(failure()) } }, error => { clear(); reject(failure(error)) })
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
      return { signal, check, wait, async authorize() {
        check()
        if (ensureCurrent) await wait(Promise.resolve().then(() => ensureCurrent.call(context)))
        check()
      }, stop() { clearInterval(timer); cancel.abort() } }
    } catch { throw failure() }
  }
  const cleanup = (entry: Entry): Promise<void> => {
    if (entry.cleanup) return entry.cleanup
    entry.revoked = true; entries.delete(entry.artifact.id); entry.abort.abort()
    entry.cleanup = (async () => {
      await Promise.allSettled([...entry.readers].map(close => close()))
      await Promise.allSettled([...entry.opens])
      await ownDirectory(); await unlink(entry.filename)
      totalBytes -= entry.artifact.sizeBytes; artifacts--
    })().catch(() => { throw failure() })
    cleanups.add(entry.cleanup); void entry.cleanup.then(() => cleanups.delete(entry.cleanup!), () => cleanups.delete(entry.cleanup!))
    return entry.cleanup
  }
  function lease(entry: Entry): AgentMediaArtifactLease {
    let released = false
    return Object.freeze({ artifact: entry.artifact,
      async retain() {
        if (released || closed || entry.revoked || entries.get(entry.artifact.id) !== entry || entry.refs >= Number.MAX_SAFE_INTEGER) throw failure()
        entry.refs++; return lease(entry)
      },
      async release() {
        if (released) return
        released = true
        if (entry.revoked) return entry.cleanup
        if (--entry.refs === 0) await cleanup(entry)
      },
    })
  }
  async function stage(input: { readonly kind: 'image' | 'video'; readonly mime: string; readonly chunks: AsyncIterable<Uint8Array> }, context: AgentMediaResourceContext): Promise<AgentMediaArtifactLease> {
    const current = guard(context)
    let handle: FileHandle | undefined, iterator: AsyncIterator<Uint8Array> | undefined, filename: string | undefined
    let allocated = false, committed = false, bytes = 0
    try {
      current.check()
      const kind = input.kind, mime = typeof input.mime === 'string' ? input.mime.toLowerCase() : ''
      if (!(kind === 'video' ? videoTypes : kind === 'image' ? imageTypes : new Set()).has(mime) || !input.chunks || typeof input.chunks[Symbol.asyncIterator] !== 'function' || artifacts >= artifactLimit) throw failure()
      artifacts++; allocated = true
      await current.authorize(); await ownDirectory(); current.check()
      const id = randomBytes(16).toString('hex'); filename = path.join(directory, id)
      handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await handle.chmod(0o600); current.check()
      iterator = input.chunks[Symbol.asyncIterator]()
      const maximum = kind === 'video' ? MAX_AGENT_ARTIFACT_VIDEO_BYTES : MAX_AGENT_ARTIFACT_IMAGE_BYTES
      const hash = createHash('sha256'), headers: Buffer[] = [], blocks: string[] = []
      let headerBytes = 0, blockHash = createHash('sha256'), blockBytes = 0
      while (true) {
        await current.authorize()
        const result = await current.wait(Promise.resolve().then(() => iterator!.next()))
        if (!result || typeof result !== 'object') throw failure()
        if (result.done) break
        const chunk = result.value
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximum - bytes) throw failure()
        if (!chunk.byteLength) { await current.wait(new Promise<void>(resolve => setImmediate(resolve))); continue }
        for (let at = 0; at < chunk.byteLength;) {
          await current.authorize()
          const count = Math.min(BLOCK - blockBytes, chunk.byteLength - at)
          if (count > totalLimit - totalBytes) throw failure()
          totalBytes += count; bytes += count
          const piece = Buffer.from(chunk.subarray(at, at + count)); at += count
          hash.update(piece); blockHash.update(piece); blockBytes += count
          if (headerBytes < HEADER) { const prefix = piece.subarray(0, Math.min(piece.length, HEADER - headerBytes)); headers.push(Buffer.from(prefix)); headerBytes += prefix.length }
          for (let written = 0; written < piece.length;) {
            current.check()
            const result = await handle.write(piece, written, piece.length - written)
            if (!result.bytesWritten) throw failure()
            written += result.bytesWritten; current.check()
          }
          if (blockBytes === BLOCK) { blocks.push(blockHash.digest('hex')); blockHash = createHash('sha256'); blockBytes = 0 }
        }
      }
      if (!bytes || !headerValid(mime, Buffer.concat(headers), bytes)) {
        throw annotateAgentError(failure(), { cause: 'media_container_invalid' })
      }
      if (blockBytes) blocks.push(blockHash.digest('hex'))
      await current.authorize(); await handle.chmod(0o400)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== bytes || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o400) throw failure()
      await handle.close(); handle = undefined
      await current.authorize(); await ownDirectory(); current.check()
      const artifact = Object.freeze({ id, kind, mime, sizeBytes: bytes, sha256: hash.digest('hex') })
      const entry: Entry = { artifact, filename, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        blocks: Object.freeze(blocks), abort: new AbortController(), readers: new Set(), opens: new Set(), refs: 1, revoked: false }
      entries.set(id, entry); committed = true
      return lease(entry)
    } catch (error) { throw failure(error) }
    finally {
      current.stop()
      if (!committed) {
        try {
          const finish = iterator?.return
          if (typeof finish === 'function') void Promise.resolve().then(() => finish.call(iterator)).catch(() => {})
        } catch {}
        await handle?.close().catch(() => {})
        if (filename) { try { await ownDirectory(); await unlink(filename) } catch { closed = true; stop.abort() } }
        if (allocated) { totalBytes -= bytes; artifacts-- }
      }
    }
  }
  async function openReader(artifact: AgentMediaArtifact, context: AgentMediaResourceContext, preflight: boolean): Promise<AgentMediaArtifactReader> {
    let entry: Entry | undefined
    try {
      const descriptor = artifact && typeof artifact === 'object' ? Object.getOwnPropertyDescriptor(artifact, 'id') : undefined
      entry = descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? entries.get(descriptor.value) : undefined
      if (!entry || entry.revoked || !sameArtifact(artifact, entry.artifact) || readers >= COUNT) throw failure()
    } catch { throw failure() }
    const selected = entry, current = guard(context, selected.abort.signal)
    let opened!: () => void
    const opening = new Promise<void>(resolve => { opened = resolve }); selected.opens.add(opening)
    let handle: FileHandle | undefined, transferred = false
    readers++
    let slotReleased = false
    const releaseSlot = () => { if (!slotReleased) { slotReleased = true; readers-- } }
    const matches = async (file: FileHandle) => {
      const stat = await file.stat()
      if (!stat.isFile() || stat.dev !== selected.dev || stat.ino !== selected.ino || stat.nlink !== 1 || stat.size !== selected.artifact.sizeBytes ||
          stat.mtimeMs !== selected.mtimeMs || stat.ctimeMs !== selected.ctimeMs || (stat.mode & 0o777) !== 0o400) throw failure()
    }
    const readBlock = async (file: FileHandle, position: number) => {
      await current.authorize(); await matches(file); current.check()
      const bytes = Buffer.alloc(Math.min(BLOCK, selected.artifact.sizeBytes - position))
      for (let offset = 0; offset < bytes.length;) {
        current.check()
        const result = await file.read(bytes, offset, bytes.length - offset, position + offset)
        if (!result.bytesRead) throw failure()
        offset += result.bytesRead
      }
      await matches(file); await current.authorize()
      if (createHash('sha256').update(bytes).digest('hex') !== selected.blocks[position / BLOCK]) throw failure()
      return bytes
    }
    try {
      await current.authorize(); await ownDirectory(); current.check()
      handle = await open(selected.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      await matches(handle)
      if (preflight) {
        const hash = createHash('sha256')
        for (let position = 0; position < selected.artifact.sizeBytes; position += BLOCK) hash.update(await readBlock(handle, position))
        if (hash.digest('hex') !== selected.artifact.sha256) throw failure()
      }
      await current.authorize()
      const file = handle
      let started = false, readerClosed = false, closing: Promise<void> | undefined
      const onAbort = () => { void close().catch(() => {}) }
      const close = (): Promise<void> => {
        if (closing) return closing
        readerClosed = true; current.signal.removeEventListener('abort', onAbort); current.stop()
        closing = file.close().catch(() => { throw failure() }).finally(() => { selected.readers.delete(close); releaseSlot() })
        return closing
      }
      async function* consume(): AsyncGenerator<Uint8Array> {
        try {
          for (let position = 0; position < selected.artifact.sizeBytes; position += BLOCK) {
            if (readerClosed) throw failure()
            const bytes = await readBlock(file, position)
            current.check(); if (readerClosed) throw failure()
            yield bytes
          }
        } catch { throw failure() }
        finally { await close() }
      }
      const chunks = Object.freeze({ [Symbol.asyncIterator]() {
        if (started || readerClosed) throw failure()
        started = true
        const iterator = consume()
        return {
          async next() {
            try {
              if (readerClosed) throw failure()
              const result = await iterator.next()
              if (!result.done) { current.check(); if (readerClosed) throw failure() }
              return result
            } catch { throw failure() }
          },
          async return() {
            await close()
            void iterator.return(undefined).catch(() => {})
            return { done: true as const, value: undefined }
          },
          async throw() {
            await close()
            void iterator.return(undefined).catch(() => {})
            throw failure()
          },
          [Symbol.asyncIterator]() { return this },
        }
      } })
      selected.readers.add(close); current.signal.addEventListener('abort', onAbort, { once: true })
      transferred = true
      try { current.check() } catch { await close(); throw failure() }
      return Object.freeze({ chunks, close })
    } catch { throw failure() }
    finally {
      if (!transferred) { current.stop(); await handle?.close().catch(() => {}); releaseSlot() }
      selected.opens.delete(opening); opened()
    }
  }
  const store: AgentMediaArtifactStore = {
    stage: (input, context) => track(stage(input, context)),
    open: (artifact, context) => track(openReader(artifact, context, true)),
    // Each block is checked against the digest recorded at staging before it
    // can leave the bridge. Avoid a full second pass before the first byte.
    openStream: (artifact, context) => track(openReader(artifact, context, false)),
    close() {
      if (closePromise) return closePromise
      closed = true; stop.abort()
      const invalidated = [...entries.values()].map(cleanup)
      closePromise = (async () => {
        await Promise.allSettled([...work, ...invalidated, ...cleanups])
        await ownDirectory(); await rm(directory, { recursive: true, force: true })
      })().catch(() => { throw failure() })
      return closePromise
    },
  }
  return Object.freeze(store)
}
