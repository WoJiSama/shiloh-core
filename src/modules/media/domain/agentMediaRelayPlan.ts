import type { AgentMediaArtifact, AgentMediaRelayItem, AgentMediaRelayPart, AgentMediaRelayPlan } from '../../../contracts/agentMediaRelay.js'

const imageMimes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const videoMimes = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'])
const maxImageBytes = 32 * 1024 * 1024
const maxVideoBytes = 512 * 1024 * 1024
const maxArtifactBytes = 16 * 1024 * 1024 * 1024
const invalid = () => new Error('媒体转发资源或计划无效，或超过数量、文字、资源预算')

/** Read own data descriptors only; native event fields and behavior never cross the contract. */
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid()
    result[key] = descriptor.value
  }
  return result
}

function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw invalid()
  const size = Object.getOwnPropertyDescriptor(input, 'length')?.value as unknown
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > maximum) throw invalid()
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= size)) throw invalid()
  }
  const result: unknown[] = []
  for (let index = 0; index < size; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid()
    result.push(descriptor.value)
  }
  return result
}

/** A descriptor carries identity and bounded metadata, never bytes, paths or download references. */
export function validateAgentMediaArtifact(input: unknown): Readonly<AgentMediaArtifact> {
  try {
    const value = record(input, ['id', 'kind', 'mime', 'sizeBytes', 'sha256'])
    if (typeof value.id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.id) ||
        typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
        value.kind !== 'image' && value.kind !== 'video' || typeof value.mime !== 'string' ||
        !(value.kind === 'image' ? imageMimes : videoMimes).has(value.mime) ||
        typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0 ||
        value.sizeBytes > (value.kind === 'image' ? maxImageBytes : maxVideoBytes)) throw invalid()
    return Object.freeze({ id: value.id, kind: value.kind, mime: value.mime, sizeBytes: value.sizeBytes, sha256: value.sha256 })
  } catch { throw invalid() }
}

/** Preserve every node and part in order; oversized plans are rejected rather than truncated. */
export function validateAgentMediaRelayPlan(input: unknown, options: { allowsText?(text: string): boolean } = {}): Readonly<AgentMediaRelayPlan> {
  try {
    const value = record(input, ['version', 'items'])
    if (value.version !== 1 || options.allowsText !== undefined && typeof options.allowsText !== 'function') throw invalid()
    let partCount = 0, textCount = 0, artifactBytes = 0
    const identities = new Map<string, Readonly<AgentMediaArtifact>>()
    const artifact = (input: unknown, kind: AgentMediaArtifact['kind']) => {
      const owned = validateAgentMediaArtifact(input)
      if (owned.kind !== kind) throw invalid()
      const prior = identities.get(owned.id)
      if (prior) {
        if (prior.kind !== owned.kind || prior.mime !== owned.mime || prior.sizeBytes !== owned.sizeBytes || prior.sha256 !== owned.sha256) throw invalid()
      } else {
        artifactBytes += owned.sizeBytes
        if (artifactBytes > maxArtifactBytes) throw invalid()
        identities.set(owned.id, owned)
      }
      return owned
    }
    const items: AgentMediaRelayItem[] = []
    for (const node of array(value.items, 128)) {
      const item = record(node, ['parts']), parts: AgentMediaRelayPart[] = []
      for (const raw of array(item.parts, 128)) {
        if (++partCount > 512) throw invalid()
        const part = record(raw, ['kind', 'text', 'artifact', 'thumbnail'])
        if (part.kind === 'text') {
          if (Object.keys(part).some(key => !['kind', 'text'].includes(key)) || typeof part.text !== 'string' || part.text.length > 128_000) throw invalid()
          const count = Array.from(part.text).length
          textCount += count
          if (count > 64_000 || textCount > 256_000 || options.allowsText && options.allowsText(part.text) !== true) throw invalid()
          parts.push(Object.freeze({ kind: 'text', text: part.text }))
        } else if (part.kind === 'image') {
          if (Object.keys(part).some(key => !['kind', 'artifact'].includes(key))) throw invalid()
          parts.push(Object.freeze({ kind: 'image', artifact: artifact(part.artifact, 'image') }))
        } else if (part.kind === 'video') {
          if (Object.keys(part).some(key => !['kind', 'artifact', 'thumbnail'].includes(key))) throw invalid()
          parts.push(Object.freeze({ kind: 'video', artifact: artifact(part.artifact, 'video'),
            ...(Object.hasOwn(part, 'thumbnail') ? { thumbnail: artifact(part.thumbnail, 'image') } : {}),
          }))
        } else throw invalid()
      }
      items.push(Object.freeze({ parts: Object.freeze(parts) }))
    }
    return Object.freeze({ version: 1, items: Object.freeze(items) })
  } catch { throw invalid() }
}
