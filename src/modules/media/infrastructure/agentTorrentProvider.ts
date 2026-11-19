import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentTorrentMetadata, AgentTorrentProvider } from '../../../contracts/agentTorrent.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createTorrentHttp, torrentCacheUrls } from './agentTorrentHttp.js'
import type { AgentTorrentLookup, AgentTorrentRequest } from './agentTorrentHttp.js'
import { parseAgentTorrentMetadata, TORRENT_BYTES, TORRENT_FILES, TORRENT_METADATA_BYTES } from './agentTorrentMetadata.js'
import { nativeAgentTorrentCommand, torrentFailure, torrentGuard, torrentTimeout } from './agentTorrentNative.js'
import type { AgentTorrentCommand } from './agentTorrentNative.js'
import { verifyAgentTorrentZip } from './agentTorrentZip.js'
import { parseMagnetUri } from './torrentDownload.js'

export interface AgentTorrentProviderOptions {
  readonly directory?: string
  /** Trusted host HTTP(S) proxy for aria2's tracker traffic; peers and DHT remain native direct connections. */
  readonly proxyUrl?: string
  readonly lookup?: AgentTorrentLookup
  readonly request?: AgentTorrentRequest
  readonly commandRunner?: AgentTorrentCommand
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly maxTotalBytes?: number
  readonly maxSingleFileBytes?: number
  readonly maxArchiveBytes?: number
  readonly maxMetadataBytes?: number
  readonly maxFiles?: number
  readonly minFreeBytes?: number
  readonly maxWorkingBytes?: number
  readonly metadataHttpTimeoutMs?: number
  readonly metadataDhtTimeoutMs?: number
  readonly metadataTrackerTimeoutMs?: number
  readonly downloadTimeoutMs?: number
  readonly archiveTimeoutMs?: number
}
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce',
  'http://tracker.opentrackr.org:1337/announce', 'https://tracker.tamersunion.org/announce', 'http://tracker.dler.org:6969/announce', 'https://tracker.gbitt.info/announce', 'http://open.acgnxtracker.com/announce']
const bounded = (value: number | undefined, maximum: number) => value === undefined ? maximum : Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : (() => { throw torrentFailure() })()
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
// Every private job starts with an empty routing table; aria2 has no default DHT bootstrap.
const COMMON_ARIA = ['--no-conf=true', '--daemon=false', '--enable-rpc=false', '--seed-time=0', '--seed-ratio=0', '--enable-dht=true', '--enable-dht6=false',
  '--dht-entry-point=dht.transmissionbt.com:6881', '--bt-enable-lpd=false', '--enable-peer-exchange=false', '--file-allocation=none', '--summary-interval=0', '--console-log-level=error', '--download-result=hide', '--disk-cache=0']

/** Core-owned native P2P on a trusted host. JS DNS checks apply to HTTPS caches, not aria2 peers/DHT. */
export function createAgentTorrentProvider(options: AgentTorrentProviderOptions = {}): AgentTorrentProvider {
  const totalLimit = bounded(options.maxTotalBytes, TORRENT_BYTES), singleLimit = bounded(options.maxSingleFileBytes, totalLimit), archiveLimit = bounded(options.maxArchiveBytes, TORRENT_BYTES),
    metadataLimit = bounded(options.maxMetadataBytes, TORRENT_METADATA_BYTES), fileLimit = bounded(options.maxFiles, TORRENT_FILES), minFree = bounded(options.minFreeBytes, 512 * 1024 * 1024),
    workingLimit = bounded(options.maxWorkingBytes, 512 * 1024 * 1024)
  const httpTimeout = torrentTimeout(options.metadataHttpTimeoutMs, 8_000), dhtTimeout = torrentTimeout(options.metadataDhtTimeoutMs, 20_000), trackerTimeout = torrentTimeout(options.metadataTrackerTimeoutMs, 45_000),
    downloadTimeout = torrentTimeout(options.downloadTimeoutMs, 900_000), archiveTimeout = torrentTimeout(options.archiveTimeoutMs, 60_000)
  const proxy = options.proxyUrl === undefined || options.proxyUrl === '' ? undefined : new URL(options.proxyUrl)
  if (proxy && (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash || /[\s\\\u0000-\u001f\u007f]/u.test(options.proxyUrl!))) throw torrentFailure()
  const secret = createAgentSecretTextCheck([...(options.secrets ?? []), ...(proxy ? [options.proxyUrl!, proxy.username, proxy.password].filter(Boolean) : [])]), http = createTorrentHttp(options), runner = options.commandRunner ?? nativeAgentTorrentCommand
  const safeText = (text: string) => sanitizeFinalReplyText(text) === text && secret(text) && options.allowsText?.(text) !== false
  const fits = (metadata: AgentTorrentMetadata) => metadata.files.length > 0 && metadata.files.length <= fileLimit && metadata.totalBytes <= totalLimit &&
    metadata.files.every(file => file.size <= singleLimit) && metadata.totalBytes <= archiveLimit - Math.min(1_000_000, Math.floor(archiveLimit / 10))
  let active = false
  return {
    async prepare(magnet, selection, context) {
      if (active) throw torrentFailure()
      const guard = torrentGuard(context, httpTimeout * 2 + dhtTimeout + trackerTimeout + downloadTimeout + archiveTimeout + 30_000)
      active = true
      let job = '', watcher: ReturnType<typeof setInterval> | undefined, watching: Promise<void> | undefined
      try {
        await guard.ensure()
        if (typeof magnet !== 'string' || !magnet || magnet.length > 16_000 || /[\s\u0000-\u001f\u007f]/u.test(magnet)) throw torrentFailure()
        const parsed = parseMagnetUri(magnet), canonical = `magnet:?xt=urn:btih:${parsed.infoHash}`
        if (selection !== undefined && (!selection || ![Object.prototype, null].includes(Object.getPrototypeOf(selection)) ||
          Reflect.ownKeys(selection).some(key => typeof key !== 'string' || !['indexes', 'expectedFingerprint'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(selection, key)!, 'value')) ||
          !/^[a-f\d]{64}$/u.test(selection.expectedFingerprint) || !Array.isArray(selection.indexes) || !selection.indexes.length || selection.indexes.length > fileLimit ||
          selection.indexes.some(index => !Number.isSafeInteger(index) || index < 1) || new Set(selection.indexes).size !== selection.indexes.length)) throw torrentFailure()
        const parent = await guard.wait(realpath(options.directory ?? tmpdir())), parentStat = await guard.wait(lstat(parent))
        if (!parentStat.isDirectory()) throw torrentFailure()
        job = await guard.wait(mkdtemp(path.join(parent, 'agent-torrent-')), late => rm(late, { recursive: true, force: true }))
        await chmod(job, 0o700)
        const metadataDir = path.join(job, 'metadata'), payloadDir = path.join(job, 'payload'), archive = path.join(job, 'archive.zip')
        await mkdir(metadataDir, { mode: 0o700 }); await mkdir(payloadDir, { mode: 0o700 }); await guard.ensure()
        const disk = async () => {
          const free = await statfs(job)
          if (Number(free.bavail) * Number(free.bsize) < minFree) throw torrentFailure()
          let size = 0, count = 0
          const walk = async (directory: string, depth = 0): Promise<void> => {
            if (depth > 36) throw torrentFailure()
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              if (++count > 10_000) throw torrentFailure()
              const file = path.join(directory, entry.name)
              let stat; try { stat = await lstat(file) } catch (error) { if (missing(error)) continue; throw error }
              if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw torrentFailure()
              if (stat.isDirectory()) await walk(file, depth + 1)
              else { size += Math.max(stat.blocks * 512, file.startsWith(metadataDir + path.sep) ? stat.size : 0); if (size > workingLimit || file.endsWith('.torrent') && stat.size > metadataLimit) throw torrentFailure() }
            }
          }
          await walk(job)
        }
        await disk()
        watcher = setInterval(() => { if (!watching) { watching = disk().catch(() => guard.abort()).finally(() => { watching = undefined }) } }, 50); watcher.unref()
        const command = async (name: 'aria2c' | 'zip', args: readonly string[], cwd: string, timeoutMs: number) => {
          await guard.ensure(); await disk()
          const own = torrentGuard(guard.context, timeoutMs), operation = Promise.resolve().then(() => runner(name, args, { cwd, timeoutMs, signal: own.signal }))
          try { await own.wait(operation); await own.ensure() }
          finally { own.close(); await operation.catch(() => {}) }
          await guard.ensure(); await disk()
        }
        const read = async (file: string, maximum: number) => {
          await guard.ensure()
          const before = await lstat(file)
          if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum || await realpath(file) !== file) throw torrentFailure()
          const handle = await guard.wait(open(file, constants.O_RDONLY | constants.O_NOFOLLOW), late => late.close())
          try {
            const stat = await handle.stat()
            if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw torrentFailure()
            const bytes = Buffer.alloc(stat.size); let at = 0
            while (at < bytes.length) { await guard.ensure(); const result = await guard.wait(handle.read(bytes, at, Math.min(1024 * 1024, bytes.length - at), at)); if (!result.bytesRead) throw torrentFailure(); at += result.bytesRead }
            if ((await handle.stat()).size !== stat.size) throw torrentFailure()
            await guard.ensure(); return bytes
          } finally { await handle.close() }
        }
        let verified: ReturnType<typeof parseAgentTorrentMetadata> | undefined
        for (const url of torrentCacheUrls(parsed.infoHash)) {
          const own = torrentGuard(guard.context, httpTimeout)
          try { verified = parseAgentTorrentMetadata(await http(url, parsed.infoHash, own, metadataLimit), parsed.infoHash, metadataLimit); break }
          catch { await guard.ensure() }
          finally { own.close() }
        }
        const aria = (directory: string) => [...COMMON_ARIA, ...(proxy ? [`--all-proxy=${proxy.href}`] : []), `--dir=${directory}`, `--dht-file-path=${path.join(job, 'dht.dat')}`, `--dht-file-path6=${path.join(job, 'dht6.dat')}`]
        if (!verified) for (let attempt = 0; attempt < 2; attempt++) {
          // A previous failed native discovery cannot supply a stale candidate to the next attempt.
          for (const entry of await readdir(metadataDir)) await rm(path.join(metadataDir, entry), { recursive: true, force: true })
          try {
            await command('aria2c', [...aria(metadataDir), '--bt-metadata-only=true', '--bt-save-metadata=true',
              ...(attempt ? [`--bt-tracker=${TRACKERS.join(',')}`] : []), canonical], metadataDir, attempt ? trackerTimeout : dhtTimeout)
            const candidates = (await readdir(metadataDir, { withFileTypes: true })).filter(entry => entry.isFile() && /^[a-f\d]{40}\.torrent$/iu.test(entry.name))
            if (candidates.length !== 1) throw torrentFailure()
            verified = parseAgentTorrentMetadata(await read(path.join(metadataDir, candidates[0]!.name), metadataLimit), parsed.infoHash, metadataLimit); break
          } catch { await guard.ensure() }
        }
        if (!verified) throw torrentFailure()
        const complete = verified.metadata
        if (complete.files.length > 2048 || Buffer.byteLength(JSON.stringify(complete)) > 1_000_000 || !safeText(complete.name) ||
          complete.files.some(file => file.relativePath.some(segment => !safeText(segment)))) throw torrentFailure()
        if (selection && selection.expectedFingerprint !== complete.fingerprint) throw torrentFailure()
        let metadata = complete
        if (selection) {
          const chosen = selection.indexes.map(index => complete.files.find(file => file.index === index))
          if (chosen.some(file => !file)) throw torrentFailure()
          metadata = Object.freeze({ ...complete, files: Object.freeze(chosen as AgentTorrentMetadata['files']), totalBytes: chosen.reduce((total, file) => total + file!.size, 0) })
          if (!fits(metadata)) throw torrentFailure()
        } else if (!fits(complete)) {
          const selectableIndexes = complete.files.filter(file => fits({ ...complete, files: [file], totalBytes: file.size })).map(file => file.index)
          if (!selectableIndexes.length) throw torrentFailure()
          await guard.ensure(); return Object.freeze({ status: 'selection-required' as const, metadata: complete, selectableIndexes: Object.freeze(selectableIndexes) })
        }
        const nativeTorrent = path.join(job, 'verified.torrent'), metadataFile = await open(nativeTorrent, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { await metadataFile.writeFile(verified.nativeMetadata) } finally { await metadataFile.close() }
        await guard.ensure()
        await command('aria2c', [...aria(payloadDir), '--bt-metadata-only=false', '--bt-save-metadata=false', '--check-integrity=true', '--auto-file-renaming=false', '--allow-overwrite=false', '--continue=false',
          '--bt-remove-unselected-file=false', `--bt-tracker=${TRACKERS.join(',')}`, ...complete.files.map(file => `--index-out=${file.index}=./${file.relativePath.join('/')}`),
          ...(selection ? [`--select-file=${metadata.files.map(file => file.index).join(',')}`] : []), nativeTorrent], payloadDir, downloadTimeout)
        const secureFile = async (file: AgentTorrentMetadata['files'][number], exact = true): Promise<FileHandle> => {
          let current = payloadDir
          for (const part of file.relativePath) { current = path.join(current, part); const stat = await lstat(current); if (stat.isSymbolicLink()) throw torrentFailure() }
          const before = await lstat(current)
          if (!before.isFile() || before.nlink !== 1 || exact && before.size !== file.size || before.size > file.size || await realpath(current) !== current) throw torrentFailure()
          const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW), stat = await handle.stat()
          if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) { await handle.close(); throw torrentFailure() }
          return handle
        }
        const hashes = new Map<number, string>(), selectedIndexes = new Set(metadata.files.map(file => file.index))
        const ranges = complete.files.map(file => ({ file, start: 0, end: 0 })); let offset = 0
        for (const range of ranges) { range.start = offset; offset += range.file.size; range.end = offset }
        const selectedPieces = new Set<number>()
        for (const range of ranges) if (selectedIndexes.has(range.file.index)) for (let index = Math.floor(range.start / verified.pieceLength); index <= Math.floor((range.end - 1) / verified.pieceLength); index++) selectedPieces.add(index)
        // Recheck every complete piece touching selected data, including neighbor spill bytes. Missing boundary bytes fail closed.
        for (const index of selectedPieces) {
          const start = index * verified.pieceLength, end = Math.min(complete.totalBytes, start + verified.pieceLength), hash = createHash('sha1')
          for (const range of ranges) if (range.start < end && range.end > start) {
            await guard.ensure(); const handle = await secureFile(range.file, selectedIndexes.has(range.file.index))
            try {
              let at = Math.max(start, range.start) - range.start, until = Math.min(end, range.end) - range.start
              while (at < until) { await guard.ensure(); const bytes = Buffer.alloc(Math.min(1024 * 1024, until - at)), result = await guard.wait(handle.read(bytes, 0, bytes.length, at)); if (!result.bytesRead) throw torrentFailure(); at += result.bytesRead; hash.update(bytes.subarray(0, result.bytesRead)) }
            } finally { await handle.close() }
          }
          if (!hash.digest().equals(verified.pieces.subarray(index * 20, (index + 1) * 20))) throw torrentFailure()
        }
        for (const file of metadata.files) {
          await guard.ensure(); const handle = await secureFile(file), hash = createHash('sha256')
          try {
            let at = 0
            while (at < file.size) { await guard.ensure(); const bytes = Buffer.alloc(Math.min(1024 * 1024, file.size - at)), result = await guard.wait(handle.read(bytes, 0, bytes.length, at)); if (!result.bytesRead) throw torrentFailure(); at += result.bytesRead; hash.update(bytes.subarray(0, result.bytesRead)) }
          } finally { await handle.close() }
          hashes.set(file.index, hash.digest('hex'))
        }
        await command('zip', ['-q', '-X', '-0', '-MM', archive, ...metadata.files.map(file => `./${file.relativePath.join('/')}`)], payloadDir, archiveTimeout)
        const bytes = await read(archive, archiveLimit)
        verifyAgentTorrentZip(bytes, metadata, hashes, archiveLimit)
        await guard.ensure()
        return Object.freeze({ status: 'ready' as const, metadata: complete, archive: Object.freeze({ name: `磁链内容-${parsed.infoHash.slice(0, 12)}.zip`, mime: 'application/zip' as const, base64: bytes.toString('base64') }) })
      } catch { throw torrentFailure() }
      finally { if (watcher) clearInterval(watcher); guard.close(); await watching; if (job) await rm(job, { recursive: true, force: true }).catch(() => {}); active = false }
    },
  }
}
