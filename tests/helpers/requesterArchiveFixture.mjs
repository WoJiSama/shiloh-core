import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
/** One complete stored ZIP entry, including CRC and central directory. */
export function zip(size = 128) {
  const name = Buffer.from('data.bin'), overhead = 30 + name.length + 46 + name.length + 22
  if (size < overhead) throw Error('ZIP fixture too small')
  const payload = Buffer.alloc(size - overhead, 0x61)
  let crc = 0xffffffff
  for (const byte of payload) crc = table[(crc ^ byte) & 255] ^ crc >>> 8
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(name.length, 28)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + payload.length, 16)
  return Buffer.concat([local, name, payload, central, name, end])
}
export function archive(bytes = zip()) { return { name: '下载结果.zip', mime: 'application/zip', base64: bytes.toString('base64') } }
export async function waitFor(probe, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(5) }
  throw Error('Timed out waiting for requester archive fixture')
}
export function download(url, options = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); let size = 0
    const req = request(url, { agent: false, method: options.method ?? 'GET', headers: options.headers ?? {}, ...(options.path ? { path: options.path } : {}) }, response => {
      response.on('error', reject); response.on('aborted', () => reject(Error('Aborted ZIP download')))
      response.on('data', chunk => { size += chunk.length; hash.update(chunk); options.onData?.(chunk, response) })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, size, sha256: hash.digest('hex') }))
    })
    req.on('error', reject); req.end()
  })
}
