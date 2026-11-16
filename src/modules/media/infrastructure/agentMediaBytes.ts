import type { AgentAudioBytes, AgentVideoBytes, SendMediaAction } from '../../../contracts/agentMedia.js'

export const MAX_AGENT_AUDIO_BYTES = 20 * 1024 * 1024
export const MAX_AGENT_VIDEO_BYTES = 30 * 1024 * 1024

function data(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new Error('媒体参数必须为闭合普通数据')
}
function bytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0) {
    throw new Error('媒体数据无效或超过大小限制')
  }
  const decoded = Buffer.from(value, 'base64')
  if (!decoded.length || decoded.length > maximum || decoded.toString('base64') !== value) throw new Error('媒体须为规范 base64 字节')
  return decoded
}
function textAt(value: Buffer, offset: number, expected: string): boolean {
  return value.subarray(offset, offset + expected.length).equals(Buffer.from(expected, 'ascii'))
}
function mp3(value: Buffer): boolean {
  let offset = 0
  if (textAt(value, 0, 'ID3')) {
    if (value.length < 10 || value[3] === 0xff || value[4] === 0xff || value.subarray(6, 10).some(part => part > 127)) return false
    offset = 10 + ((value[6]! << 21) | (value[7]! << 14) | (value[8]! << 7) | value[9]!) + (value[5]! & 0x10 ? 10 : 0)
  }
  return value.length >= offset + 4 && value[offset] === 0xff && (value[offset + 1]! & 0xe0) === 0xe0 &&
    (value[offset + 1]! & 0x18) !== 0x08 && (value[offset + 1]! & 0x06) !== 0 &&
    (value[offset + 2]! & 0xf0) !== 0 && (value[offset + 2]! & 0xf0) !== 0xf0 && (value[offset + 2]! & 0x0c) !== 0x0c
}
function wav(value: Buffer): boolean {
  if (value.length < 44 || !textAt(value, 0, 'RIFF') || !textAt(value, 8, 'WAVE') || value.readUInt32LE(4) + 8 > value.length) return false
  let format = false
  for (let offset = 12; offset + 8 <= value.length;) {
    const size = value.readUInt32LE(offset + 4), end = offset + 8 + size
    if (end > value.length) return false
    if (textAt(value, offset, 'fmt ')) format = size >= 16 && value.readUInt16LE(offset + 10) > 0 && value.readUInt32LE(offset + 12) > 0
    if (textAt(value, offset, 'data') && size > 0 && format) return true
    offset = end + size % 2
  }
  return false
}
function ogg(value: Buffer): boolean {
  if (value.length < 35 || !textAt(value, 0, 'OggS') || value[4] !== 0) return false
  const count = value[26]!, packet = 27 + count
  if (!count || packet >= value.length) return false
  return textAt(value, packet, 'OpusHead') || value[packet] === 1 && textAt(value, packet + 1, 'vorbis') || textAt(value, packet, 'Speex   ')
}
function audioHeader(mime: string, value: Buffer): boolean {
  switch (mime) {
    case 'audio/mpeg': return mp3(value)
    case 'audio/wav': return wav(value)
    case 'audio/ogg': return ogg(value)
    case 'audio/flac': return value.length > 42 && textAt(value, 0, 'fLaC') && (value[4]! & 0x7f) === 0 && value.readUIntBE(5, 3) === 34
    case 'audio/amr': return value.length > 6 && textAt(value, 0, '#!AMR\n')
    case 'audio/amr-wb': return value.length > 9 && textAt(value, 0, '#!AMR-WB\n')
    case 'audio/silk': return value.length > 10 && (textAt(value, 0, '#!SILK_V3') || value[0] === 2 && textAt(value, 1, '#!SILK_V3'))
    default: return false
  }
}
function videoHeader(mime: string, value: Buffer): boolean {
  if (mime === 'video/webm') {
    if (value.length < 20 || !value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false
    const prefix = value.subarray(4, Math.min(value.length, 65536))
    return prefix.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])) && prefix.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]))
  }
  if (!['video/mp4', 'video/quicktime'].includes(mime) || value.length < 24 || !textAt(value, 4, 'ftyp')) return false
  const box = value.readUInt32BE(0)
  if (box < 16 || box > value.length || box > 65536 || box % 4 !== 0) return false
  const brands = [value.toString('ascii', 8, 12)]
  for (let offset = 16; offset + 4 <= box; offset += 4) brands.push(value.toString('ascii', offset, offset + 4))
  return mime === 'video/quicktime' ? brands.includes('qt  ') : brands.some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV'].includes(brand))
}

/** Header/container validation bounds transport input; it cannot prove decoding, playback or provider transcoding. */
export function validateAgentAudioBytes(input: unknown): Readonly<AgentAudioBytes> {
  data(input, ['mime', 'base64', 'spokenText'])
  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase() : ''
  const decoded = bytes(input.base64, MAX_AGENT_AUDIO_BYTES)
  if (!audioHeader(mime, decoded)) throw new Error('音频 MIME 与真实文件头不匹配或格式不支持')
  if (input.spokenText !== undefined && (typeof input.spokenText !== 'string' || Array.from(input.spokenText).length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.spokenText))) throw new Error('语音正文无效或超过 300 字符')
  return Object.freeze({ mime, base64: input.base64 as string, ...(typeof input.spokenText === 'string' ? { spokenText: input.spokenText } : {}) })
}
export function validateAgentVideoBytes(input: unknown): Readonly<AgentVideoBytes> {
  data(input, ['mime', 'base64'])
  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase() : ''
  if (!videoHeader(mime, bytes(input.base64, MAX_AGENT_VIDEO_BYTES))) throw new Error('视频 MIME 与真实文件头不匹配或格式不支持')
  return Object.freeze({ mime, base64: input.base64 as string })
}
export function validateAgentMedia(input: unknown): SendMediaAction['media'] {
  data(input, ['kind', 'mime', 'base64', 'spokenText'])
  if (input.kind === 'audio') return Object.freeze({ kind: 'audio', ...validateAgentAudioBytes({ mime: input.mime, base64: input.base64, ...(input.spokenText !== undefined ? { spokenText: input.spokenText } : {}) }) })
  if (input.kind === 'video' && !Object.hasOwn(input, 'spokenText')) return Object.freeze({ kind: 'video', ...validateAgentVideoBytes({ mime: input.mime, base64: input.base64 }) })
  throw new Error('媒体类型或参数无效')
}
