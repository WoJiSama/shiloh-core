import { createHash } from 'node:crypto'
import type { AgentTorrentMetadata } from '../../../contracts/agentTorrent.js'
import { decodeTorrentTextBytes } from './torrentDownload.js'
import { torrentFailure } from './agentTorrentNative.js'

export const TORRENT_METADATA_BYTES = 2 * 1024 * 1024, TORRENT_BYTES = 50_000_000, TORRENT_FILES = 3
type Value = Buffer | number | Value[] | { [key: string]: Value }
const dictionary = (value: Value | undefined): { [key: string]: Value } => {
  if (!value || Buffer.isBuffer(value) || Array.isArray(value) || typeof value !== 'object') throw torrentFailure()
  return value
}
const integer = (value: Value | undefined) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw torrentFailure(); return value }

/** Parse every byte before hashing; retain the exact original info span, never re-encode it. */
export function parseAgentTorrentMetadata(raw: Buffer, infoHash: string, maxBytes = TORRENT_METADATA_BYTES) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > maxBytes || !/^[A-F\d]{40}$/u.test(infoHash)) throw torrentFailure()
  let at = 0, count = 0, infoStart = -1, infoEnd = -1
  const parse = (depth: number): Value => {
    if (depth > 64 || ++count > 20_000 || at >= raw.length) throw torrentFailure()
    const token = raw[at]
    if (token === 0x69) {
      const end = raw.indexOf(0x65, ++at), text = raw.subarray(at, end).toString('ascii')
      if (end < at || !/^(?:0|[1-9]\d*)$/u.test(text)) throw torrentFailure()
      at = end + 1; const value = Number(text); if (!Number.isSafeInteger(value)) throw torrentFailure(); return value
    }
    if (token === 0x6c) {
      at++; const values: Value[] = []
      while (raw[at] !== 0x65) values.push(parse(depth + 1))
      at++; return values
    }
    if (token === 0x64) {
      at++; const values: { [key: string]: Value } = Object.create(null)
      while (raw[at] !== 0x65) {
        const key = parse(depth + 1)
        if (!Buffer.isBuffer(key) || key.some(byte => byte > 0x7f)) throw torrentFailure()
        const name = key.toString('ascii'), start = at, value = parse(depth + 1)
        // aria2 writes repeated empty-key private metadata; it has no path or network authority.
        if (!name && depth === 0) continue
        if (!name || Object.hasOwn(values, name)) throw torrentFailure()
        values[name] = value
        if (depth === 0 && name === 'info') { infoStart = start; infoEnd = at }
      }
      at++; return values
    }
    if (token !== undefined && token >= 0x30 && token <= 0x39) {
      const end = raw.indexOf(0x3a, at), lengthText = raw.subarray(at, end).toString('ascii')
      if (end < at || !/^(?:0|[1-9]\d*)$/u.test(lengthText)) throw torrentFailure()
      const length = Number(lengthText), start = end + 1
      if (!Number.isSafeInteger(length) || start + length > raw.length) throw torrentFailure()
      at = start + length; return raw.subarray(start, at)
    }
    throw torrentFailure()
  }
  const root = dictionary(parse(0)), info = dictionary(root.info)
  if (at !== raw.length || infoStart < 0 || infoEnd <= infoStart || createHash('sha1').update(raw.subarray(infoStart, infoEnd)).digest('hex').toUpperCase() !== infoHash) throw torrentFailure()
  const infoKeys = new Set(['name', 'length', 'files', 'piece length', 'pieces', 'private', 'md5sum'])
  if (Object.keys(info).some(key => !infoKeys.has(key)) || info.private !== undefined && info.private !== 0 && info.private !== 1) throw torrentFailure()
  const segment = (value: Value | undefined) => {
    if (!Buffer.isBuffer(value)) throw torrentFailure()
    const text = decodeTorrentTextBytes(value).normalize('NFC')
    if (!text || text.includes('\ufffd') || text === '.' || text === '..' || /[/\\:\u0000-\u001f\u007f]/u.test(text) || text.length > 180 || Buffer.byteLength(text) > 255 || /[. ]$/u.test(text) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(text)) throw torrentFailure()
    return text
  }
  const name = segment(info.name), files: AgentTorrentMetadata['files'][number][] = []
  if ((info.length !== undefined) === (info.files !== undefined)) throw torrentFailure()
  if (info.length !== undefined) files.push({ index: 1, relativePath: [name], size: integer(info.length) })
  else {
    if (!Array.isArray(info.files) || !info.files.length) throw torrentFailure()
    for (const item of info.files) {
      const entry = dictionary(item)
      if (Object.keys(entry).some(key => !['length', 'path', 'md5sum'].includes(key)) || !Array.isArray(entry.path) || !entry.path.length || entry.path.length > 31) throw torrentFailure()
      files.push({ index: files.length + 1, relativePath: [name, ...entry.path.map(segment)], size: integer(entry.length) })
    }
  }
  let totalBytes = 0
  const paths = new Set<string>(), filePaths = new Set<string>()
  for (const file of files) {
    totalBytes += file.size
    const key = file.relativePath.join('/').toLowerCase()
    if (!Number.isSafeInteger(totalBytes) || Buffer.byteLength(key) > 4096 || paths.has(key) || file.relativePath.some((_value, index) => filePaths.has(file.relativePath.slice(0, index).join('/').toLowerCase()))) throw torrentFailure()
    paths.add(key); filePaths.add(key)
  }
  // Reject file/directory collisions regardless of source order.
  for (const file of files) for (let index = 1; index < file.relativePath.length; index++) if (filePaths.has(file.relativePath.slice(0, index).join('/').toLowerCase())) throw torrentFailure()
  const pieceLength = integer(info['piece length']), pieces = info.pieces
  if (!Buffer.isBuffer(pieces) || pieces.length !== Math.ceil(totalBytes / pieceLength) * 20 || pieceLength > 64 * 1024 * 1024) throw torrentFailure()
  const metadata: AgentTorrentMetadata = Object.freeze({ infoHash, fingerprint: createHash('sha256').update(raw).digest('hex'), name,
    files: Object.freeze(files.map(file => Object.freeze({ ...file, relativePath: Object.freeze([...file.relativePath]) }))), totalBytes })
  return { metadata, pieceLength, pieces: Buffer.from(pieces),
    // All announce/webseed/nodes/encoding fields are removed, without changing the BTIH.
    nativeMetadata: Buffer.concat([Buffer.from('d4:info'), raw.subarray(infoStart, infoEnd), Buffer.from('e')]) }
}
