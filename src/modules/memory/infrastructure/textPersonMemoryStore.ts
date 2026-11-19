import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { TextPersonMemoryBatch } from '../../../contracts/textPersonMemory.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import type { AgentSourceMemoryCleanupGuard, AgentSourceMemoryPurgeSubject } from '../../../contracts/sourceMemoryCleanup.js'
import { conversationCleanupAllows, conversationCleanupMatchesScope, parseConversationCleanup } from './conversationMemoryCleanup.js'
import { createSubjectMemoryCleanup } from './subjectMemoryCleanup.js'

interface TextPersonMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:person-memory:text:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const CLEANUP_KEY = `${PREFIX}:cleanup`
const MAX_BATCHES = 200
const MAX_MESSAGES = 60
const MAX_BATCH_CHARS = 2_000_000
const MAX_ATTEMPTS = 20
const FAILURE = '文字人物记忆队列不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const batchKey = (id: string) => `${PREFIX}:batch:${id}`

// Every Redis key is supplied through KEYS so the Agent storage can namespace
// and fence both reads and commits with its host lease.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false, redis.call('GET', KEYS[3]) or false}`
const READ_LIST = `
local catalog = redis.call('GET', KEYS[1])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return false end
local result = {redis.call('GET', KEYS[2]) or false}
for i = 3, #KEYS do result[i - 1] = redis.call('GET', KEYS[i]) or false end
return result`
const COMPARE_AND_SET = `
local catalog = redis.call('GET', KEYS[1])
local batch = redis.call('GET', KEYS[2])
local cleanup = redis.call('GET', KEYS[3])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false)
  or (batch or false) ~= (ARGV[3] == '1' and ARGV[4] or false)
  or (cleanup or false) ~= (ARGV[5] == '1' and ARGV[6] or false) then return 0 end
redis.call('SET', KEYS[1], ARGV[7])
if ARGV[8] == '1' then redis.call('SET', KEYS[2], ARGV[9]) else redis.call('DEL', KEYS[2]) end
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
  const cleanup = createSubjectMemoryCleanup(redis, CLEANUP_KEY, 'person-extraction-batches')
  function filtered(batch: TextPersonMemoryBatch | undefined, fences: ReturnType<typeof parseConversationCleanup>): TextPersonMemoryBatch | undefined {
    if (!batch) return undefined
    const messages = batch.messages.filter(message => conversationCleanupAllows(batch.binding, { authorId: batch.subjectId, at: message.at }, fences))
    const removed = new Set(batch.messages.filter(message => !messages.includes(message)).map(message => message.messageId))
    const { result, ...rest } = batch
    const next = { ...rest, messages, ...(result && !result.messageIds.some(id => removed.has(id)) ? { result } : {}) }
    if (!messages.length && !next.result && fences.entries.some(entry => conversationCleanupMatchesScope(batch.binding, entry) &&
      !conversationCleanupAllows(batch.binding, { authorId: batch.subjectId, at: 0 }, { version: 1, entries: [entry] }))) return undefined
    return next
  }
  function needsCleanup(batch: TextPersonMemoryBatch, fences: ReturnType<typeof parseConversationCleanup>) {
    const next = filtered(batch, fences)
    return !next || next.messages.length !== batch.messages.length || Boolean(next.result) !== Boolean(batch.result)
  }
  async function snapshot(id: string) {
    const values = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, batchKey(id), CLEANUP_KEY], arguments: [] })
    if (!Array.isArray(values) || values.length !== 3) fail()
    const catalogRaw = raw(values[0]), batchRaw = raw(values[1]), cleanupRaw = raw(values[2])
    const catalog = parseCatalog(catalogRaw), batch = parseBatch(batchRaw, id)
    if (catalog.includes(id) !== Boolean(batch)) fail()
    return { catalogRaw, batchRaw, cleanupRaw, catalog, batch, fences: parseConversationCleanup(cleanupRaw) }
  }
  async function commit(id: string, saved: Awaited<ReturnType<typeof snapshot>>, next: TextPersonMemoryBatch | undefined) {
    const nextCatalog = next ? saved.catalog.includes(id) ? saved.catalog : [...saved.catalog, id] : saved.catalog.filter(value => value !== id)
    if (nextCatalog.length > MAX_BATCHES) fail()
    const result = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, batchKey(id), CLEANUP_KEY],
      arguments: [...expected(saved.catalogRaw), ...expected(saved.batchRaw), ...expected(saved.cleanupRaw), JSON.stringify({ version: 1, ids: nextCatalog }), ...expected(next ? JSON.stringify(next) : null)] })
    if (result !== 0 && result !== 1) fail()
    return result === 1
  }
  async function rawList() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const catalog = raw(await redis.get(CATALOG_KEY)), ids = parseCatalog(catalog)
      const values = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, CLEANUP_KEY, ...ids.map(batchKey)], arguments: expected(catalog) })
      if (values === null) continue
      if (!Array.isArray(values) || values.length !== ids.length + 1) fail()
      const fences = parseConversationCleanup(raw(values[0]))
      const batches = ids.map((id, i) => { const batch = parseBatch(raw(values[i + 1]), id); if (!batch) fail(); return batch })
      return { batches, fences }
    }
    return fail()
  }
  return {
    async filterMessages(batch: TextPersonMemoryBatch, messages: TextPersonMemoryBatch['messages']) {
      const fences = parseConversationCleanup(raw(await redis.get(CLEANUP_KEY)))
      return messages.filter(message => conversationCleanupAllows(batch.binding, { authorId: batch.subjectId, at: message.at }, fences))
    },
    async list(): Promise<TextPersonMemoryBatch[]> {
      try {
        const saved = await rawList()
        return saved.batches.flatMap(batch => { const next = filtered(batch, saved.fences); return next ? [next] : [] })
      } catch { fail() }
      return fail()
    },
    async update(id: string, change: (current: TextPersonMemoryBatch | undefined) => TextPersonMemoryBatch | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (isCurrent?.() === false) return false
          const saved = await snapshot(id), { batch: current, batchRaw } = saved
          if (isCurrent?.() === false) return false
          const candidate = change(structuredClone(filtered(current, saved.fences)))
          const next = filtered(parseBatch(candidate === undefined ? null : JSON.stringify(candidate), id), saved.fences)
          const nextRaw = next === undefined ? null : JSON.stringify(next)
          if (current && next && identity(current) !== identity(next)) fail()
          if (current && next && next.messages.some(message => {
            const previous = current.messages.find(value => value.messageId === message.messageId)
            return previous && (previous.at !== message.at || previous.name !== message.name || previous.text !== message.text)
          })) fail()
          if (isCurrent?.() === false) return false
          if (nextRaw === batchRaw || !current && !next) return true
          // No await may separate the final scope check from the atomic commit.
          if (isCurrent?.() === false) return false
          if (await commit(id, saved, next)) return true
        }
      } catch { fail() }
      return fail()
    },
    purgeSubject(input: AgentSourceMemoryPurgeSubject, guard: AgentSourceMemoryCleanupGuard) {
      return cleanup.purge(input, guard, async (selector, authorize, counts) => {
        const all = await rawList(); await authorize()
        for (const batch of all.batches) {
          if (!conversationCleanupMatchesScope(batch.binding, selector)) continue
          let settled = false
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const saved = await snapshot(batch.id); await authorize()
            const next = filtered(saved.batch, saved.fences)
            if (!saved.batch || !needsCleanup(saved.batch, saved.fences)) { settled = true; break }
            await authorize()
            if (!await commit(batch.id, saved, next)) continue
            counts.removedRecords += (saved.batch?.messages.length ?? 0) - (next?.messages.length ?? 0) + (saved.batch?.result && !next?.result ? 1 : 0)
            if (saved.batch && !next) counts.removedPartitions++
            settled = true; break
          }
          if (!settled) fail()
        }
        const verified = await rawList(); await authorize()
        if (verified.batches.some(batch => conversationCleanupMatchesScope(batch.binding, selector) && needsCleanup(batch, verified.fences))) fail()
      })
    },
  }
}
