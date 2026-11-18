import { types } from 'node:util'
import type { AgentVideoCard } from '../../../contracts/agentVideoCard.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/** Own and validate public metadata before handing it to any platform adapter. */
export function validateAgentVideoCard(input: unknown, allowsText?: (text: string) => boolean): Readonly<AgentVideoCard> {
  const invalid = () => new Error('视频卡片内容或来源无效')
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const keys = ['provider', 'id', 'title', 'author', 'durationSeconds', 'pageUrl']
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors[key] ?? {}, 'value'))) throw invalid()
  const value = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value])) as unknown as AgentVideoCard
  if (value.provider !== 'bilibili' || typeof value.id !== 'string' || !/^(?:BV[A-Za-z0-9]{10}|ep[1-9]\d{0,19})$/u.test(value.id) ||
      value.pageUrl !== (value.id.startsWith('ep') ? `https://www.bilibili.com/bangumi/play/${value.id}` : `https://www.bilibili.com/video/${value.id}`) ||
      !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 31_536_000) throw invalid()
  for (const [field, maximum] of [['title', 300], ['author', 120]] as const) {
    const text = value[field]
    if (typeof text !== 'string' || Array.from(text).length > maximum || field === 'title' && !text.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(text) ||
        !wellFormed(text) || sanitizeFinalReplyText(text) !== text) throw invalid()
  }
  const text = [value.id, value.title, value.author, value.pageUrl].filter(Boolean).join('\n')
  if (allowsText && !allowsText(text)) throw invalid()
  return Object.freeze(value)
}
