import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { TextPersonMemoryBatch } from '../../../contracts/textPersonMemory.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

interface TextPersonMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:person-memory:text:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const MAX_BATCHES = 200
const MAX_MESSAGES = 60
const MAX_BATCH_CHARS = 2_000_000
const MAX_ATTEMPTS = 20
const FAILURE = '文字人物记忆队列不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const batchKey = (id: string) => `${PREFIX}:batch:${id}`

// Every Redis key is supplied through KEYS so the Agent storage can namespace
// and fence both reads and commits with its host lease.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false}`
const READ_LIST = `
local catalog = redis.call('GET', KEYS[1])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return false end
local result = {}
for i = 2, #KEYS do result[i - 1] = redis.call('GET', KEYS[i]) or false end
return result`
const COMPARE_AND_SET = `
local catalog = redis.call('GET', KEYS[1])
local batch = redis.call('GET', KEYS[2])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false)
  or (batch or false) ~= (ARGV[3] == '1' and ARGV[4] or false) then return 0 end
redis.call('SET', KEYS[1], ARGV[5])
if ARGV[6] == '1' then redis.call('SET', KEYS[2], ARGV[7]) else redis.call('DEL', KEYS[2]) end
return 1`

function fail(): never { throw new Error(FAILURE) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}
function messageId(value: unknown): value is string { return isPlatformIdentifier(value) && value !== '0' }
function ids(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(messageId) && new Set(value).size === value.length
}
function raw(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') fail()
  return value
}
function expected(value: string | null): [string, string] { return [value === null ? '0' : '1', value ?? ''] }

function validBinding(value: unknown): value is AgentBindingSnapshot {
  if (!object(value) || !keys(value, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']) ||
      value.source !== 'configured' || !text(value.id, 4096) || !text(value.revision, 4096) ||
      !isPlatformIdentifier(value.personaId) || !isPlatformIdentifier(value.connectionId) ||
      !object(value.target) || !keys(value.target, ['account', 'kind', 'id']) ||
      !object(value.target.account) || !keys(value.target.account, ['platform', 'namespace', 'id'])) return false
  const binding = value as unknown as AgentBindingSnapshot
  return isConversationAddress(binding.target) && ['private', 'group'].includes(binding.target.kind) &&
    value.id === conversationAddressKey(binding.target) && decodeAgentConversationKey(agentConversationKey(binding)) !== null
}

export function textPersonMemoryBatchId(binding: AgentBindingSnapshot, token: string, subjectId: string, peerId?: string): string {
  return createHash('sha256').update(JSON.stringify([agentConversationKey(binding), token, subjectId, peerId ?? null])).digest('hex')
}

function identity(batch: TextPersonMemoryBatch): string {
  return JSON.stringify([agentConversationKey(batch.binding), agentBindingToken(batch.binding), batch.token, batch.subjectId, batch.peerId ?? null])
}

function parseCatalog(value: string | null): string[] {
  if (value === null) return []
  if (value.length > 20_000) fail()
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'ids']) || parsed.version !== 1 || !Array.isArray(parsed.ids) ||
      parsed.ids.length > MAX_BATCHES || !parsed.ids.every(id => typeof id === 'string' && ID_PATTERN.test(id)) ||
      new Set(parsed.ids).size !== parsed.ids.length) fail()
  return parsed.ids as string[]
}

function parseBatch(value: string | null, id: string): TextPersonMemoryBatch | undefined {
  if (value === null) return undefined
  if (value.length > MAX_BATCH_CHARS) fail()
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'binding', 'token', 'subjectId', 'peerId', 'messages', 'dueAt', 'attempts', 'retryAt', 'completedMessageIds', 'result']) ||
      parsed.version !== 1 || parsed.id !== id || !validBinding(parsed.binding) || !text(parsed.token, 4096) ||
      !isPlatformIdentifier(parsed.subjectId) || !integer(parsed.dueAt) || !integer(parsed.attempts) || !integer(parsed.retryAt) ||
      !Array.isArray(parsed.messages) || parsed.messages.length > MAX_MESSAGES) fail()
  if (parsed.peerId !== undefined && !isPlatformIdentifier(parsed.peerId)) fail()
  if (parsed.binding.target.kind === 'private' ? (parsed.peerId ?? parsed.binding.target.id) !== parsed.subjectId : parsed.peerId !== undefined) fail()
  if (textPersonMemoryBatchId(parsed.binding, parsed.token, parsed.subjectId, parsed.peerId as string | undefined) !== id) fail()
  const messages = parsed.messages
  if (!messages.every(message => object(message) && keys(message, ['messageId', 'at', 'name', 'text']) &&
      messageId(message.messageId) && integer(message.at) && message.at > 0 && typeof message.name === 'string' && message.name.length <= 20 &&
      typeof message.text === 'string' && !!message.text.trim() && message.text.length <= 4000) ||
      new Set(messages.map(message => message.messageId)).size !== messages.length) fail()
  if (parsed.completedMessageIds !== undefined && !ids(parsed.completedMessageIds, MAX_MESSAGES)) fail()
  if (parsed.result !== undefined) {
    if (!object(parsed.result) || !keys(parsed.result, ['raw', 'messageIds']) || typeof parsed.result.raw !== 'string' ||
        parsed.result.raw.length > 64_000 || !ids(parsed.result.messageIds, MAX_MESSAGES) ||
        !parsed.result.messageIds.every(id => messages.some(message => message.messageId === id)) ||
        !Array.isArray(JSON.parse(parsed.result.raw))) fail()
  }
  return parsed as unknown as TextPersonMemoryBatch
}

export function createTextPersonMemoryStore(redis: TextPersonMemoryRedis) {
  return {
    async list(): Promise<TextPersonMemoryBatch[]> {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const catalog = raw(await redis.get(CATALOG_KEY))
          const ids = parseCatalog(catalog)
          const snapshot = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, ...ids.map(batchKey)], arguments: expected(catalog) })
          if (snapshot === null) continue
          if (!Array.isArray(snapshot) || snapshot.length !== ids.length) fail()
          return ids.map((id, index) => {
            const batch = parseBatch(raw(snapshot[index]), id)
            if (!batch) fail()
            return batch
          })
        }
      } catch { fail() }
      return fail()
    },
    async update(id: string, change: (current: TextPersonMemoryBatch | undefined) => TextPersonMemoryBatch | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (isCurrent?.() === false) return false
          const snapshot = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, batchKey(id)], arguments: [] })
          if (!Array.isArray(snapshot) || snapshot.length !== 2) fail()
          const catalogRaw = raw(snapshot[0]), batchRaw = raw(snapshot[1])
          const catalog = parseCatalog(catalogRaw), current = parseBatch(batchRaw, id)
          if (catalog.includes(id) !== Boolean(current)) fail()
          if (isCurrent?.() === false) return false
          const candidate = change(current === undefined ? undefined : structuredClone(current))
          const nextRaw = candidate === undefined ? null : JSON.stringify(candidate)
          const next = parseBatch(nextRaw, id)
          if (current && next && identity(current) !== identity(next)) fail()
          if (current && next && next.messages.some(message => {
            const previous = current.messages.find(value => value.messageId === message.messageId)
            return previous && (previous.at !== message.at || previous.name !== message.name || previous.text !== message.text)
          })) fail()
          if (isCurrent?.() === false) return false
          if (nextRaw === batchRaw || !current && !next) return true
          const nextCatalog = next ? catalog.includes(id) ? catalog : [...catalog, id] : catalog.filter(value => value !== id)
          if (nextCatalog.length > MAX_BATCHES) fail()
          const arguments_ = [...expected(catalogRaw), ...expected(batchRaw), JSON.stringify({ version: 1, ids: nextCatalog }), ...expected(nextRaw)]
          // No await may separate the final scope check from the atomic commit.
          if (isCurrent?.() === false) return false
          const committed = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, batchKey(id)], arguments: arguments_ })
          if (committed === 1) return true
          if (committed !== 0) fail()
        }
      } catch { fail() }
      return fail()
    },
  }
}
