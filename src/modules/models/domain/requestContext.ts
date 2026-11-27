import type { ChatMessage, ChatRequestData } from '../../../contracts/modelGateway.js'
import type { ModelContextLimits } from '../../../contracts/modelExecution.js'
import { sanitizeJsonValue } from './unicodeText.js'

export type ContextPurpose = 'simulation' | 'text' | 'repository' | 'engineering' | 'engineering_summary'
export type ContextSection = 'style' | 'history' | 'recall' | 'evidence'

const defaults: ModelContextLimits = { windowTokens: 65_536, reserveOutputTokens: 4_096, maxRequestBytes: 512 * 1024 }
const requests = new WeakMap<ChatRequestData, { purpose: ContextPurpose; round: number; repeatedReads?: number; savedToolResultBytes?: number }>()
const sections = new WeakMap<ChatMessage, ContextSection>()
const excerpts = new WeakMap<ChatMessage, string>()
const reserveHint = new WeakMap<object, number>()
const priorities: Record<ContextSection, number> = { style: 0, history: 1, recall: 2, evidence: 3 }

export function modelContextRequest<T extends ChatRequestData>(request: T, purpose: ContextPurpose, round = 1, repeatedReads?: number, savedToolResultBytes?: number): T {
  requests.set(request, { purpose, round, ...(repeatedReads === undefined ? {} : { repeatedReads }),
    ...(savedToolResultBytes === undefined ? {} : { savedToolResultBytes }) })
  return request
}

export function modelContextMetadata(request: ChatRequestData) {
  return requests.get(request)
}

export function rememberContextOutputLimit(request: object, limit: unknown) {
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0) reserveHint.set(request, limit)
}

export function optionalContext<T extends ChatMessage>(message: T, section: ContextSection): T {
  sections.set(message, section)
  return message
}

export function excerptContext<T extends ChatMessage>(message: T, content: string): T {
  excerpts.set(message, content)
  return message
}

export function messageContextMetadata(message: ChatMessage) {
  return { section: sections.get(message), excerpt: excerpts.get(message) }
}

export function decodeModelContextLimits(value: unknown): Readonly<Record<string, ModelContextLimits>> {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new Error('modelContext 应为模型名到窗口预算的映射')
  const limits: Record<string, ModelContextLimits> = Object.create(null)
  for (const [name, setting] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/u.test(name) || !setting || typeof setting !== 'object' || Array.isArray(setting) ||
        Object.keys(setting).some(key => !['windowTokens', 'reserveOutputTokens', 'maxRequestBytes'].includes(key))) throw new Error('modelContext 模型或字段无效')
    const windowTokens = setting.windowTokens
    const reserveOutputTokens = setting.reserveOutputTokens ?? Math.min(4_096, Math.floor(Number(windowTokens) / 4))
    const maxRequestBytes = setting.maxRequestBytes ?? defaults.maxRequestBytes
    if (!Number.isSafeInteger(windowTokens) || windowTokens < 2_048 || windowTokens > 4_000_000 ||
        !Number.isSafeInteger(reserveOutputTokens) || reserveOutputTokens < 256 || reserveOutputTokens >= windowTokens - 512 ||
        !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 4_096 || maxRequestBytes > 8 * 1024 * 1024) throw new Error('modelContext 窗口、输出预留或请求体上限无效')
    limits[name] = Object.freeze({ windowTokens, reserveOutputTokens, maxRequestBytes })
  }
  return Object.freeze(limits)
}

export function modelContextLimits(limits: Readonly<Record<string, ModelContextLimits>> | undefined, model: unknown): ModelContextLimits | undefined {
  return typeof model === 'string' && limits && Object.hasOwn(limits, model) ? limits[model] : undefined
}

const encoder = new TextEncoder()
const byteLength = (value: string) => encoder.encode(value).byteLength
const serialize = (data: unknown) => JSON.stringify(sanitizeJsonValue(data))

function removableUnits(messages: readonly ChatMessage[]) {
  const units: { start: number; end: number; priority: number; bytes: number }[] = []
  for (let start = 0; start < messages.length; start++) {
    const message = messages[start]!
    let end = start
    if (message.role === 'assistant' && message.tool_calls?.length) {
      while (messages[end + 1]?.role === 'tool') end++
    }
    const section = sections.get(message)
    if (section === 'history' && message.role === 'user') {
      const reply = messages[end + 1]
      if (reply?.role === 'assistant' && !reply.tool_calls?.length && sections.get(reply) === section) end++
    }
    if (section && message.role !== 'system' && message.role !== 'tool' &&
        messages.slice(start, end + 1).every(row => sections.get(row) === section)) {
      const bytes = messages.slice(start, end + 1).reduce((total, row) => total + byteLength(serialize(row)) + 1, 0)
      units.push({ start, end, priority: priorities[section], bytes })
    }
    start = end
  }
  return units.sort((a, b) => a.priority - b.priority || a.start - b.start)
}

/** The provider sees only the wire object. Omission always operates on explicitly optional messages. */
export function packModelContext(data: unknown, limits: ModelContextLimits = defaults, options: {
  tokensPerByte?: number
  smallerThan?: number
} = {}) {
  const request = data as ChatRequestData
  const messages = request.messages ?? []
  const originalBody = serialize(request), originalBytes = byteLength(originalBody)
  const ratio = Math.max(1 / 3, Math.min(1, options.tokensPerByte ?? 1 / 3))
  const outputReserveTokens = Math.max(limits.reserveOutputTokens, reserveHint.get(request) ?? 0,
    Number(request.max_completion_tokens) || 0, Number(request.max_tokens) || 0)
  const inputLimitTokens = Math.max(0, limits.windowTokens - outputReserveTokens - Math.max(256, Math.ceil(limits.windowTokens * 0.02)))
  const maxBytes = Math.min(limits.maxRequestBytes, Math.floor(inputLimitTokens / ratio))
  const target = options.smallerThan === undefined ? maxBytes : Math.min(maxBytes, Math.floor(options.smallerThan * 0.72))
  const optional = originalBytes > target ? removableUnits(messages) : []
  const removed = new Set<number>()
  let projectedBytes = originalBytes
  for (const unit of optional) {
    if (projectedBytes <= target) break
    for (let index = unit.start; index <= unit.end; index++) removed.add(index)
    projectedBytes -= unit.bytes
  }
  const replacements = new Map<number, ChatMessage>()
  for (let index = 0; projectedBytes > target && index < messages.length; index++) {
    if (removed.has(index)) continue
    const row = messages[index]!, content = excerpts.get(row)
    if (content === undefined) continue
    const replacement = { ...row, content }
    const saved = byteLength(serialize(row)) - byteLength(serialize(replacement))
    if (saved <= 0) continue
    replacements.set(index, replacement)
    projectedBytes -= saved
  }
  const body = removed.size || replacements.size ? serialize({ ...request, messages: messages.flatMap((row, index) =>
    removed.has(index) ? [] : [replacements.get(index) ?? row]) }) : originalBody
  const requestBytes = byteLength(body)
  const estimatedInputTokens = Math.ceil(requestBytes * ratio)
  const blockedBy: ModelContextFailure | undefined = estimatedInputTokens > inputLimitTokens ? 'context_length_exceeded' :
    requestBytes > limits.maxRequestBytes ? 'request_body_too_large' : undefined
  return { body, blockedBy, requestBytes, inputLimitTokens, outputReserveTokens,
    estimatedInputTokens, trimmedContextMessages: removed.size + replacements.size, savedContextBytes: originalBytes - requestBytes,
    systemBytes: byteLength(serialize(messages.filter(row => row.role === 'system'))),
    toolSchemaBytes: byteLength(serialize(request.tools ?? [])) }
}

export type ModelContextFailure = 'context_length_exceeded' | 'request_body_too_large'

function errorObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function modelContextFailure(status: number, detail: unknown): ModelContextFailure | undefined {
  if (status === 413) return 'request_body_too_large'
  const ok = status >= 200 && status < 300
  if (!ok && status !== 400 && status !== 422) return
  let decoded = detail
  if (!ok && typeof detail === 'string') {
    try { decoded = JSON.parse(detail) } catch { /* Some gateways send plain text. */ }
  }
  const envelope = errorObject(Array.isArray(decoded) ? decoded[0] : decoded)
  const error = envelope?.error ?? envelope?.detail ?? (ok ? undefined : envelope ?? decoded)
  if (!error) return
  const fields = errorObject(error)
  const codes = [fields?.code, fields?.type, envelope?.code, typeof error === 'string' ? error : undefined]
    .filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase())
  if (codes.some(code => ['request_body_too_large', 'request_too_large', 'payload_too_large'].includes(code))) return 'request_body_too_large'
  if (codes.some(code => ['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'input_too_long'].includes(code))) return 'context_length_exceeded'
  const message = typeof error === 'string' ? error : fields?.message
  if (typeof message !== 'string') return
  if (/\b(?:request body|request payload|payload) (?:is )?too large\b/iu.test(message)) return 'request_body_too_large'
  if (/maximum context length|(?:prompt|input) (?:is )?too long|context (?:window|length) (?:has been )?exceeded/iu.test(message)) return 'context_length_exceeded'
}
