import type { MessageBundleItem, MessageBundlePart } from '../../../contracts/platformMessage.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'

const MAX_ITEMS = 12
const MAX_PARTS = 4
const MAX_TEXT_LENGTH = 4_000
const MAX_TOTAL_TEXT_LENGTH = 32_000
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
const invalid = () => new Error('合并消息数据无效或超过数量、文字、图片上限')

function record(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw invalid()
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) throw invalid()
    result[key] = descriptor.value
  }
  return result
}

function array(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit ||
      Reflect.ownKeys(value).some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) throw invalid()
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor)) throw invalid()
    result.push(descriptor.value)
  }
  return result
}

/** Validate at every delivery boundary and detach every node/part from caller-owned arrays. */
export function validateMessageBundle(items: unknown): readonly MessageBundleItem[] {
  let textLength = 0
  let imageBytes = 0
  const validated: MessageBundleItem[] = []
  for (const input of array(items, MAX_ITEMS)) {
    const item = record(input, ['parts'])
    const parts: MessageBundlePart[] = []
    for (const inputPart of array(item.parts, MAX_PARTS)) {
      const part = record(inputPart, ['kind', 'text', 'mime', 'base64', 'presentation'])
      if (part.kind === 'text') {
        if (Reflect.ownKeys(part).some(key => key !== 'kind' && key !== 'text') ||
            typeof part.text !== 'string' || !part.text.trim() || part.text.length > MAX_TEXT_LENGTH) throw invalid()
        textLength += part.text.length
        if (textLength > MAX_TOTAL_TEXT_LENGTH) throw invalid()
        parts.push(Object.freeze({ kind: 'text', text: part.text }))
      } else if (part.kind === 'image') {
        if (Reflect.ownKeys(part).some(key => !['kind', 'mime', 'base64', 'presentation'].includes(String(key))) ||
            typeof part.mime !== 'string' || typeof part.base64 !== 'string' ||
            part.presentation !== undefined && part.presentation !== 'sticker' ||
            part.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw invalid()
        const image = validateAgentToolImage({ mime: part.mime, base64: part.base64, ...(part.presentation === undefined ? {} : { presentation: part.presentation }) })
        const bytes = image.base64.length / 4 * 3 - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0)
        imageBytes += bytes
        if (bytes > MAX_IMAGE_BYTES || imageBytes > MAX_TOTAL_IMAGE_BYTES) throw invalid()
        parts.push(Object.freeze({ kind: 'image', ...image }))
      } else throw invalid()
    }
    validated.push(Object.freeze({ parts: Object.freeze(parts) }))
  }
  return Object.freeze(validated)
}
