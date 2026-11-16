import type { AgentPreparedTorrent, AgentTorrentArchive, AgentTorrentConfig, AgentTorrentMetadata } from '../../../contracts/agentTorrent.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { extractValidBtihMagnetUri, parseMagnetUri } from './torrentMagnet.js'

export const MAX_AGENT_TORRENT_ARCHIVE_BYTES = 50_000_000
export const MAX_AGENT_TORRENT_FILES = 3
const failure = () => new Error('磁链参数、资源或文件清单不符合要求')
function closed(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) throw failure()
  const values = []
  for (let i = 0; i < input.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(input, String(i)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure(); values.push(descriptor.value) }
  return values
}
function text(input: unknown, maximum = 180): string {
  if (typeof input !== 'string' || !input || input.length > maximum || /[\u0000-\u001f\u007f]/u.test(input) || sanitizeFinalReplyText(input) !== input) throw failure()
  return input
}
export function validateAgentTorrentConfig(input: unknown): Readonly<Required<AgentTorrentConfig>> {
  if (input === undefined) return Object.freeze({ enabled: false, autoDetect: true, selectionTtlSeconds: 1800 })
  try {
    const row = closed(input, ['enabled', 'autoDetect', 'selectionTtlSeconds'])
    if (typeof row.enabled !== 'boolean' || row.autoDetect !== undefined && typeof row.autoDetect !== 'boolean') throw failure()
    const ttl = row.selectionTtlSeconds ?? 1800
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 1800) throw failure()
    return Object.freeze({ enabled: row.enabled, autoDetect: row.autoDetect !== false, selectionTtlSeconds: ttl })
  } catch { throw failure() }
}
export function parseAgentTorrentMagnet(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 16000) return undefined
  const magnet = extractValidBtihMagnetUri(input)
  if (!magnet || magnet.length > 16000 || /[\u0000-\u0020\u007f]/u.test(magnet)) return undefined
  try { parseMagnetUri(magnet); return magnet } catch { return undefined }
}
/** A structural reply to a pending list, never a semantic download classifier. */
export function parseAgentTorrentSelection(input: string, metadata: AgentTorrentMetadata): readonly number[] | undefined {
  if (typeof input !== 'string' || input.length > 16000) return undefined
  const match = input.trim().match(/^(?:下载|下|选择|选)\s*(.{1,4096})$/u)
  if (!match) return undefined
  const requested = match[1]!.split(/[,，、]/u).map(item => item.trim().replace(/^第\s*/u, '').replace(/(?:个|项|号)$/u, '')).filter(Boolean)
  if (!requested.length || requested.length > MAX_AGENT_TORRENT_FILES) throw failure()
  const indexes = requested.map(value => {
    if (/^[1-9]\d{0,3}$/u.test(value)) return Number(value)
    const matches = metadata.files.filter(file => value === (file.relativePath.slice(1).join('/') || metadata.name) || value === file.relativePath.at(-1))
    if (matches.length !== 1) throw failure()
    return matches[0]!.index
  })
  if (new Set(indexes).size !== indexes.length || indexes.some(index => !metadata.files.some(file => file.index === index))) throw failure()
  return Object.freeze(indexes)
}
export function validateAgentTorrentArchive(input: unknown): Readonly<AgentTorrentArchive> {
  try {
    const row = closed(input, ['name', 'mime', 'base64']), name = text(row.name, 180)
    if (!/\.zip$/iu.test(name) || name === '..' || /[/\\]/u.test(name) || row.mime !== 'application/zip' || typeof row.base64 !== 'string' ||
      !row.base64 || row.base64.length > 4 * Math.ceil(MAX_AGENT_TORRENT_ARCHIVE_BYTES / 3) || row.base64.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(row.base64)) throw failure()
    const bytes = Buffer.from(row.base64, 'base64')
    if (bytes.length < 22 || bytes.length > MAX_AGENT_TORRENT_ARCHIVE_BYTES || bytes.toString('base64') !== row.base64 ||
      bytes.readUInt32LE(0) !== 0x04034b50 && bytes.readUInt32LE(0) !== 0x06054b50) throw failure()
    // Only accept a complete bounded ZIP container, with no trailing polyglot bytes.
    let end = -1
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
      if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) ||
      bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) || !bytes.readUInt16LE(end + 10) || bytes.readUInt16LE(end + 10) > MAX_AGENT_TORRENT_FILES ||
      bytes.readUInt32LE(end + 12) + bytes.readUInt32LE(end + 16) !== end) throw failure()
    return Object.freeze({ name, mime: 'application/zip', base64: row.base64 })
  } catch { throw failure() }
}
export function validateAgentPreparedTorrent(input: unknown): Readonly<AgentPreparedTorrent> {
  try {
    const row = closed(input, ['status', 'metadata', 'archive', 'selectableIndexes']), metadata = validateAgentTorrentMetadata(row.metadata)
    if (row.status === 'ready' && !Object.hasOwn(row, 'selectableIndexes')) {
      return Object.freeze({ status: 'ready', metadata, archive: validateAgentTorrentArchive(row.archive) })
    }
    if (row.status !== 'selection-required' || Object.hasOwn(row, 'archive')) throw failure()
    const indexes = array(row.selectableIndexes, 2048)
    if (!indexes.length || new Set(indexes).size !== indexes.length || indexes.some(index => typeof index !== 'number' ||
      !Number.isSafeInteger(index) || !metadata.files.some(file => file.index === index))) throw failure()
    return Object.freeze({ status: 'selection-required', metadata, selectableIndexes: Object.freeze(indexes as number[]) })
  } catch { throw failure() }
}
export function validateAgentTorrentMetadata(input: unknown): Readonly<AgentTorrentMetadata> {
  try {
    const row = closed(input, ['infoHash', 'fingerprint', 'name', 'files', 'totalBytes']), name = text(row.name)
    if (name === '.' || name === '..' || /[/\\]/u.test(name) || typeof row.infoHash !== 'string' || !/^[A-F\d]{40}$/u.test(row.infoHash) ||
      typeof row.fingerprint !== 'string' || !/^[a-f\d]{64}$/u.test(row.fingerprint)) throw failure()
    let total = 0
    const paths = new Set<string>()
    const files = array(row.files, 2048).map((input, offset) => {
      const file = closed(input, ['index', 'relativePath', 'size'])
      if (file.index !== offset + 1 || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 1) throw failure()
      const relativePath = array(file.relativePath, 32).map(segment => {
        const value = text(segment)
        if (value === '.' || value === '..' || /[/\\]/u.test(value) || value.normalize('NFC') !== value) throw failure()
        return value
      })
      if (!relativePath.length || relativePath[0] !== name) throw failure()
      const key = relativePath.join('/').toLowerCase()
      if (paths.has(key)) throw failure()
      paths.add(key); total += file.size
      if (!Number.isSafeInteger(total)) throw failure()
      return Object.freeze({ index: offset + 1, relativePath: Object.freeze(relativePath), size: file.size })
    })
    if (!files.length || total !== row.totalBytes || Buffer.byteLength(JSON.stringify(row)) > 1_000_000) throw failure()
    return Object.freeze({ name, infoHash: row.infoHash, fingerprint: row.fingerprint, files: Object.freeze(files), totalBytes: total })
  } catch { throw failure() }
}
