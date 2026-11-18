import type { AgentVideoInput } from '../../../contracts/agentVideo.js'

export const MAX_AGENT_VIDEO_INPUT_BYTES = 64 * 1024 * 1024
const HEADER_BYTES = 64 * 1024
const invalid = () => new Error('视频数据无效或超过64MiB上限')

function mp4Header(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString('latin1', 4, 8) !== 'ftyp') return false
  const size = bytes.readUInt32BE(0)
  if (size < 16 || size > HEADER_BYTES || size > bytes.length || size % 4) return false
  const brands = [bytes.toString('latin1', 8, 12)]
  for (let at = 16; at + 4 <= size; at += 4) brands.push(bytes.toString('latin1', at, at + 4))
  if (brands.some(brand => ['qt  ', 'avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(brand))) return false
  return brands.some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV'].includes(brand))
}

function vint(bytes: Buffer, offset: number, id: boolean): { readonly value: number; readonly length: number; readonly unknown: boolean } | undefined {
  const first = bytes[offset]
  if (first === undefined || first === 0) return undefined
  let length = 1, marker = 0x80
  while (!(first & marker)) { length++; marker >>= 1 }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return undefined
  let value = id ? first : first & (marker - 1), unknown = !id && value === marker - 1
  for (let at = 1; at < length; at++) { const next = bytes[offset + at]!; value = value * 256 + next; unknown &&= next === 255 }
  if (!Number.isSafeInteger(value) && !unknown) return undefined
  return { value, length, unknown }
}

function webmHeader(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false
  const header = vint(bytes, 4, false)
  if (!header || header.unknown || header.value > HEADER_BYTES) return false
  const end = 4 + header.length + header.value
  if (end > bytes.length) return false
  let at = 4 + header.length, webm = false
  while (at < end) {
    const id = vint(bytes, at, true); if (!id) return false; at += id.length
    const size = vint(bytes, at, false); if (!size || size.unknown) return false; at += size.length
    if (at + size.value > end) return false
    if (id.value === 0x4282) { if (webm || bytes.toString('latin1', at, at + size.value) !== 'webm') return false; webm = true }
    at += size.value
  }
  if (!webm || at !== end || at + 5 > bytes.length || bytes.readUInt32BE(at) !== 0x18538067) return false
  const segment = vint(bytes, at + 4, false)
  return Boolean(segment && (segment.unknown || segment.value > 0 && at + 4 + segment.length + segment.value <= bytes.length))
}

/** Bounded container-header checks only: these do not establish decoding or playback. */
export function validateAgentVideoInputBytes(input: Uint8Array, expectedMime?: 'video/mp4' | 'video/webm'): Readonly<AgentVideoInput> {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > MAX_AGENT_VIDEO_INPUT_BYTES) throw invalid()
  const bytes = Buffer.from(input)
  const mime = mp4Header(bytes) ? 'video/mp4' : webmHeader(bytes) ? 'video/webm' : undefined
  if (!mime || expectedMime !== undefined && expectedMime !== mime) throw invalid()
  return Object.freeze({ mime, base64: bytes.toString('base64') })
}

/** One owned turn-local snapshot; no getters, paths, URLs or permissive base64 decoding. */
export function validateAgentVideoInput(input: unknown): Readonly<AgentVideoInput> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
    const keys = Reflect.ownKeys(input)
    if (keys.length !== 2 || !keys.every(key => typeof key === 'string' && ['mime', 'base64'].includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw invalid()
    const value = input as Record<string, unknown>, mime = value.mime, base64 = value.base64
    if (!['video/mp4', 'video/webm'].includes(mime as string) || typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_AGENT_VIDEO_INPUT_BYTES / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw invalid()
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw invalid()
    return validateAgentVideoInputBytes(bytes, mime as AgentVideoInput['mime'])
  } catch { throw invalid() }
}
