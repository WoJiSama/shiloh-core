import type { AgentAudioAttachment } from '../../../contracts/agentMusicExtraction.js'
import { validateAgentAudioBytes } from './agentMediaBytes.js'

const extensions: Readonly<Record<string, readonly string[]>> = {
  'audio/mpeg': ['mp3'], 'audio/wav': ['wav'], 'audio/ogg': ['ogg', 'opus'], 'audio/flac': ['flac'],
  'audio/amr': ['amr'], 'audio/amr-wb': ['amr', 'awb'], 'audio/silk': ['silk'],
}

/** Complete owned audio bytes; no paths, references, remote URLs or native upload options. */
export function validateAgentAudioAttachment(input: unknown): Readonly<AgentAudioAttachment> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['name', 'mime', 'base64'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw new Error('音频文件必须为闭合普通数据')
  const value = input as Record<string, unknown>, name = value.name
  if (typeof name !== 'string' || !name || name.length > 255 || name.trim() !== name ||
      /[\u0000-\u001f\u007f/\\:*?"<>|]/u.test(name) || /[. ]$/u.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error('音频文件名无效')
  const audio = validateAgentAudioBytes({ mime: value.mime, base64: value.base64 })
  if (!extensions[audio.mime]?.includes(name.slice(name.lastIndexOf('.') + 1).toLowerCase()) || !name.includes('.')) throw new Error('音频文件名与真实格式不匹配')
  return Object.freeze({ name, mime: audio.mime, base64: audio.base64 })
}
