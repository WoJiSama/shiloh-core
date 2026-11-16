import type { AgentToolMessage } from '../../../contracts/agentTool.js'
import { isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

/** Own text and identity data before asynchronous checks or the shared send queue. */
export function validateAgentToolMessage(value: unknown): AgentToolMessage {
  const invalid = () => new Error('通知内容或成员标识无效')
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid()
  const owned: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['text', 'mentionUserIds'].includes(key)) throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw invalid()
    owned[key] = descriptor.value
  }
  if (typeof owned.text !== 'string' || owned.text.length > 4000) throw invalid()
  const mentions: string[] = []
  if (owned.mentionUserIds !== undefined) {
    const values = owned.mentionUserIds
    if (!Array.isArray(values) || values.length > 20 || Reflect.ownKeys(values).some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= values.length))) throw invalid()
    for (let index = 0; index < values.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (!descriptor || !('value' in descriptor) || !isPlatformIdentifier(descriptor.value)) throw invalid()
      mentions.push(descriptor.value as string)
    }
  }
  if (!owned.text.trim() && !mentions.length) throw invalid()
  return Object.freeze({ text: owned.text, mentionUserIds: Object.freeze([...new Set(mentions)]) })
}
