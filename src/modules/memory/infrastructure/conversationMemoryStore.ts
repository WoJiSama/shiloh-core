import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot, AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { ConversationMemoryRecord, ConversationMemoryState } from '../../../contracts/conversationMemory.js'
import { agentConversationKey, agentPersonaScopeId, conversationAddressKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { personMemoryAddress } from './personMemoryContext.js'

interface ConversationMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:conversation-memory:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const MAX_STATES = 200
const MAX_RECORDS = 1000
const MAX_EPISODES = 1000
const MAX_ATTEMPTS = 20
const FAILURE = '会话记忆存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const stateKey = (id: string) => `${PREFIX}:state:${id}`

// All keys are explicit so host prefixes and execution leases apply to every
// read and commit. Catalog and state are always compared in the same Lua call.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false}`
const READ_LIST = `
local catalog = redis.call('GET', KEYS[1])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return false end
local result = {}
for i = 2, #KEYS do result[i - 1] = redis.call('GET', KEYS[i]) or false end
return result`
const COMPARE_AND_SET = `
local catalog = redis.call('GET', KEYS[1])
local state = redis.call('GET', KEYS[2])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false)
  or (state or false) ~= (ARGV[3] == '1' and ARGV[4] or false) then return 0 end
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
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function nonempty(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}
function messageId(value: unknown): value is string { return isPlatformIdentifier(value) && value !== '0' }
function ids(value: unknown, minimum = 0): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= 1000 &&
    value.every(messageId) && new Set(value).size === value.length
}
function raw(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') fail()
  return value
}
function expected(value: string | null): [string, string] { return [value === null ? '0' : '1', value ?? ''] }
function current(guard?: () => boolean): boolean {
  try { return guard?.() !== false } catch { return false }
}

function validScope(value: unknown): value is AgentConversationScope {
  if (!object(value) || !keys(value, ['agentId', 'target']) || !object(value.target) ||
      !keys(value.target, ['account', 'kind', 'id']) || !object(value.target.account) ||
      !keys(value.target.account, ['platform', 'namespace', 'id'])) return false
  const scope = value as unknown as AgentConversationScope
  return isConversationAddress(scope.target) && decodeAgentConversationKey(agentConversationKey(scope)) !== null
}

function validBinding(value: unknown): value is AgentBindingSnapshot {
  if (!object(value) || !keys(value, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']) ||
      value.source !== 'configured' || !nonempty(value.revision, 4096) || !isPlatformIdentifier(value.personaId) ||
      typeof value.connectionId !== 'string' || !INTERNAL_ID_PATTERN.test(value.connectionId) ||
      !validScope({ agentId: value.agentId, target: value.target })) return false
  return value.id === conversationAddressKey((value as unknown as AgentBindingSnapshot).target)
}

export function conversationMemoryId(scope: AgentConversationScope): string {
  return createHash('sha256').update(agentConversationKey(scope)).digest('hex')
}

function parseCatalog(value: string | null): string[] {
  if (value === null) return []
  if (value.length > 20_000) fail()
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'ids']) || parsed.version !== 1 || !Array.isArray(parsed.ids) ||
      parsed.ids.length > MAX_STATES || !parsed.ids.every(id => typeof id === 'string' && ID_PATTERN.test(id)) ||
      new Set(parsed.ids).size !== parsed.ids.length) fail()
  return parsed.ids as string[]
}

function parseState(value: string | null, id: string): ConversationMemoryState | undefined {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'scope', 'binding', 'token', 'nextSeq', 'records', 'episodes', 'summary', 'dueAt', 'dueInvalidatedAt', 'attempts', 'retryAt']) ||
      parsed.version !== 1 || parsed.id !== id || !validScope(parsed.scope) || !validBinding(parsed.binding) ||
      agentConversationKey(parsed.scope) !== agentConversationKey(parsed.binding) || conversationMemoryId(parsed.scope) !== id ||
      !nonempty(parsed.token, 4096) || !integer(parsed.nextSeq) || parsed.nextSeq < 1 ||
      !integer(parsed.dueAt) || (parsed.dueInvalidatedAt !== undefined && !integer(parsed.dueInvalidatedAt)) ||
      !integer(parsed.attempts) || !integer(parsed.retryAt) ||
      !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS ||
      !Array.isArray(parsed.episodes) || parsed.episodes.length > MAX_EPISODES) fail()
  const { target } = parsed.scope
  let lastSeq = 0
  for (const record of parsed.records) {
    if (!object(record) || !keys(record, ['seq', 'messageId', 'authorId', 'name', 'text', 'at', 'peerId']) ||
        !integer(record.seq) || record.seq <= lastSeq || record.seq >= parsed.nextSeq || !messageId(record.messageId) ||
        !isPlatformIdentifier(record.authorId) || typeof record.name !== 'string' || record.name.length > 24 ||
        typeof record.text !== 'string' || !record.text.trim() || record.text.length > 4000 ||
        !integer(record.at) || record.at === 0 || (record.peerId !== undefined && !isPlatformIdentifier(record.peerId))) fail()
    if (target.kind === 'private' ? record.authorId !== (record.peerId ?? target.id) : record.peerId !== undefined) fail()
    lastSeq = record.seq
  }
  if (new Set(parsed.records.map(record => record.messageId)).size !== parsed.records.length) fail()
  const botId = personMemoryAddress(target).botId
  const personaId = agentPersonaScopeId(parsed.scope.agentId)
  for (const episode of parsed.episodes) {
    if (!object(episode) || !keys(episode, ['id', 'at', 'userId', 'userName', 'summary', 'reply', 'source', 'messageIds', 'replyIds', 'invalidatedAt', 'peerId']) ||
        !messageId(episode.id) || !integer(episode.at) || episode.at === 0 ||
        (episode.userId !== undefined && !isPlatformIdentifier(episode.userId)) ||
        typeof episode.userName !== 'string' || episode.userName.length > 24 ||
        typeof episode.summary !== 'string' || !episode.summary.trim() || episode.summary.length > 240 ||
        typeof episode.reply !== 'string' || episode.reply.length > 240 ||
        !integer(episode.invalidatedAt) || !ids(episode.messageIds) || !ids(episode.replyIds, 1) ||
        (episode.peerId !== undefined && !isPlatformIdentifier(episode.peerId)) ||
        !object(episode.source) || !keys(episode.source, ['botId', 'personaId', 'personaVersion', 'personaName']) ||
        episode.source.botId !== botId || episode.source.personaId !== personaId ||
        !nonempty(episode.source.personaVersion, 4096) || !nonempty(episode.source.personaName, 4096)) fail()
    if (target.kind === 'private' ? episode.userId !== (episode.peerId ?? target.id) : episode.peerId !== undefined) fail()
  }
  if (new Set(parsed.episodes.map(episode => episode.id)).size !== parsed.episodes.length) fail()
  if (parsed.summary !== undefined) {
    const summary = parsed.summary
    if (!object(summary) || !keys(summary, ['text', 'updatedAt', 'coveredSeq', 'invalidatedAt']) ||
        typeof summary.text !== 'string' || Array.from(summary.text).length > 4000 || !integer(summary.updatedAt) ||
        !integer(summary.coveredSeq) || summary.coveredSeq >= parsed.nextSeq || !integer(summary.invalidatedAt)) fail()
  }
  return parsed as unknown as ConversationMemoryState
}

function sameRecord(left: ConversationMemoryRecord, right: ConversationMemoryRecord): boolean {
  return left.seq === right.seq && left.at === right.at && left.authorId === right.authorId &&
    left.name === right.name && left.text === right.text && left.peerId === right.peerId
}

export function createConversationMemoryStore(redis: ConversationMemoryRedis) {
  async function read(id: string) {
    const snapshot = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id)], arguments: [] })
    if (!Array.isArray(snapshot) || snapshot.length !== 2) fail()
    const catalogRaw = raw(snapshot[0]), stateRaw = raw(snapshot[1])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    if (catalog.includes(id) !== Boolean(state)) fail()
    return { catalogRaw, stateRaw, catalog, state }
  }

  return {
    async list(): Promise<ConversationMemoryState[]> {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const catalogRaw = raw(await redis.get(CATALOG_KEY))
          const catalog = parseCatalog(catalogRaw)
          const snapshot = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, ...catalog.map(stateKey)], arguments: expected(catalogRaw) })
          if (snapshot === null) continue
          if (!Array.isArray(snapshot) || snapshot.length !== catalog.length) fail()
          return catalog.map((id, index) => {
            const state = parseState(raw(snapshot[index]), id)
            if (!state) fail()
            return state
          })
        }
      } catch { fail() }
      return fail()
    },
    async load(id: string): Promise<ConversationMemoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        return (await read(id)).state
      } catch { return fail() }
    },
    async update(id: string, change: (state: ConversationMemoryState | undefined) => ConversationMemoryState | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          const { catalogRaw, stateRaw, catalog, state } = await read(id)
          if (!current(isCurrent)) return false
          const candidate = change(state === undefined ? undefined : structuredClone(state))
          const nextRaw = candidate === undefined ? null : JSON.stringify(candidate)
          const next = parseState(nextRaw, id)
          if (state && next) {
            if (agentConversationKey(state.scope) !== agentConversationKey(next.scope) || next.nextSeq < state.nextSeq) fail()
            const previous = new Map(state.records.map(record => [record.messageId, record]))
            for (const record of next.records) {
              const original = previous.get(record.messageId)
              if (original ? !sameRecord(record, original) : record.seq < state.nextSeq) fail()
            }
          }
          if (!current(isCurrent)) return false
          if (nextRaw === stateRaw || !state && !next) return true
          const nextCatalog = next ? catalog.includes(id) ? catalog : [...catalog, id] : catalog.filter(value => value !== id)
          if (nextCatalog.length > MAX_STATES) fail()
          const arguments_ = [...expected(catalogRaw), ...expected(stateRaw), JSON.stringify({ version: 1, ids: nextCatalog }), ...expected(nextRaw)]
          // No await separates the final synchronous scope check from commit.
          if (!current(isCurrent)) return false
          const committed = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, stateKey(id)], arguments: arguments_ })
          if (committed === 1) return true
          if (committed !== 0) fail()
        }
      } catch { fail() }
      return fail()
    },
  }
}
