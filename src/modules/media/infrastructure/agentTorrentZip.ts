import { createHash } from 'node:crypto'
import type { AgentTorrentMetadata } from '../../../contracts/agentTorrent.js'
import { TORRENT_BYTES } from './agentTorrentMetadata.js'
import { torrentFailure } from './agentTorrentNative.js'

const crcTable = Array.from({ length: 256 }, (_value, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  return crc >>> 0
})
export function torrentZipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** The fixed zip -0 invocation emits stored files. Validate exact membership, bytes, CRC and both directory structures. */
export function verifyAgentTorrentZip(bytes: Buffer, metadata: AgentTorrentMetadata, hashes: ReadonlyMap<number, string>, maxBytes = TORRENT_BYTES): void {
  if (!bytes.length || bytes.length > maxBytes || bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== 0x06054b50) throw torrentFailure()
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count !== metadata.files.length || bytes.readUInt16LE(end + 20) || directory + directorySize !== end) throw torrentFailure()
  const expected = new Map(metadata.files.map(file => [file.relativePath.join('/'), file])), seen = new Set<number>()
  let cursor = directory, dataCursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw torrentFailure()
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > end || flags & ~0x0800 || method !== 0 || compressed !== size || bytes.readUInt16LE(cursor + 34) || mode && (mode & 0xf000) !== 0x8000 || local !== dataCursor || local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) throw torrentFailure()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8'), selected = expected.get(name)
    if (!selected || seen.has(selected.index) || !nameBytes.equals(Buffer.from(name)) || selected.size !== size || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size) throw torrentFailure()
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localNameLength + localExtra
    if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) || data + size > directory) throw torrentFailure()
    const content = bytes.subarray(data, data + size)
    if (torrentZipCrc32(content) !== crc || createHash('sha256').update(content).digest('hex') !== hashes.get(selected.index)) throw torrentFailure()
    seen.add(selected.index); dataCursor = data + size; cursor = next
  }
  if (cursor !== end || dataCursor !== directory || seen.size !== expected.size) throw torrentFailure()
}
