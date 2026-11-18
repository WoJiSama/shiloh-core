import { types } from 'node:util'
import type { AgentGroupLogArtifact } from '../../../contracts/agentGroupLog.js'

export const MAX_AGENT_GROUP_LOG_BYTES = 100 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_AGENT_GROUP_LOG_BYTES / 3) * 4
const invalid = () => new Error('团录文件无效或超过100MiB上限')

/** Validate owned text bytes only. HTML safety belongs to the fixed-template producer. */
export function validateAgentGroupLogArtifact(input: unknown): Readonly<AgentGroupLogArtifact> {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
    const keys = Reflect.ownKeys(input)
    if (keys.length !== 3 || !keys.every(key => typeof key === 'string' && ['name', 'mime', 'base64'].includes(key))) throw invalid()
    const descriptors = Object.getOwnPropertyDescriptors(input)
    if (!keys.every(key => Object.hasOwn(descriptors[key as string]!, 'value'))) throw invalid()
    const name: unknown = descriptors.name!.value, mime: unknown = descriptors.mime!.value, base64: unknown = descriptors.base64!.value
    if (typeof name !== 'string' || !name || name.length > 255 || name !== name.trim() || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff/\\:<>"|?*]/u.test(name) ||
        name.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw invalid()
    if (mime !== 'text/plain' && mime !== 'text/html' ||
        !(mime === 'text/plain' ? /\.txt$/iu : /\.html?$/iu).test(name)) throw invalid()
    if (typeof base64 !== 'string' || !base64 || base64.length > MAX_BASE64_LENGTH || base64.length % 4) throw invalid()
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const expectedBytes = base64.length / 4 * 3 - padding
    if (expectedBytes < 1 || expectedBytes > MAX_AGENT_GROUP_LOG_BYTES) throw invalid()
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length !== expectedBytes || bytes.toString('base64') !== base64) throw invalid()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw invalid()
    return Object.freeze({ name, mime, base64 })
  } catch { throw invalid() }
}
