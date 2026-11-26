import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot, AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { AgentConversationMemoryCleanupGuard, AgentConversationMemoryCleanupReceipt, AgentConversationMemoryPurgeSubject, ConversationMemoryRecord, ConversationMemoryState } from '../../../contracts/conversationMemory.js'
import { agentConversationKey, agentPersonaScopeId, conversationAddressKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { agentErrorDetails, annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { createMemoryScheduleSnapshot } from './memoryScheduleSnapshot.js'
import { conversationCleanupCurrent, conversationCleanupMatchesScope, conversationCleanupSelector, conversationCleanupToken, ensureConversationCleanup, filterConversationCleanupRows, filterConversationMemoryState, parseConversationCleanup, CONVERSATION_CLEANUP_MAX_BYTES, CONVERSATION_CLEANUP_MAX_SELECTORS, type ConversationCleanupFences } from './conversationMemoryCleanup.js'

interface ConversationMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:conversation-memory:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const CLEANUP_KEY = `${PREFIX}:cleanup`
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
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false, redis.call('GET', KEYS[3]) or false}`
const READ_LIST = `
local catalog = redis.call('GET', KEYS[1])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return false end
local result = {redis.call('GET', KEYS[2]) or false}
for i = 3, #KEYS do result[i - 1] = redis.call('GET', KEYS[i]) or false end
return result`
const COMPARE_AND_SET = `
local catalog = redis.call('GET', KEYS[1])
local state = redis.call('GET', KEYS[2])
local cleanup = redis.call('GET', KEYS[3])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false)
  or (state or false) ~= (ARGV[3] == '1' and ARGV[4] or false)
  or (cleanup or false) ~= (ARGV[5] == '1' and ARGV[6] or false) then return 0 end
redis.call('SET', KEYS[1], ARGV[7])
if ARGV[8] == '1' then redis.call('SET', KEYS[2], ARGV[9]) else redis.call('DEL', KEYS[2]) end
return 1`
const PUBLISH_CLEANUP = `
local cleanup = redis.call('GET', KEYS[1])
if (cleanup or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
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
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'scope', 'binding', 'token', 'nextSeq', 'records', 'episodes', 'summary', 'dueAt', 'dueInvalidatedAt', 'dueCleanupToken', 'attempts', 'retryAt']) ||
      parsed.version !== 1 || parsed.id !== id || !validScope(parsed.scope) || !validBinding(parsed.binding) ||
      agentConversationKey(parsed.scope) !== agentConversationKey(parsed.binding) || conversationMemoryId(parsed.scope) !== id ||
      !nonempty(parsed.token, 4096) || !integer(parsed.nextSeq) || parsed.nextSeq < 1 ||
      !integer(parsed.dueAt) || (parsed.dueInvalidatedAt !== undefined && !integer(parsed.dueInvalidatedAt)) ||
      (parsed.dueCleanupToken !== undefined && (typeof parsed.dueCleanupToken !== 'string' || !ID_PATTERN.test(parsed.dueCleanupToken))) ||
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
    if (!object(episode) || !keys(episode, ['id', 'at', 'userId', 'userName', 'summary', 'reply', 'source', 'messageIds', 'replyIds', 'invalidatedAt', 'peerId', 'cleanupToken']) ||
        !messageId(episode.id) || !integer(episode.at) || episode.at === 0 ||
        (episode.userId !== undefined && !isPlatformIdentifier(episode.userId)) ||
        typeof episode.userName !== 'string' || episode.userName.length > 24 ||
        typeof episode.summary !== 'string' || !episode.summary.trim() || episode.summary.length > 240 ||
        typeof episode.reply !== 'string' || episode.reply.length > 240 ||
        !integer(episode.invalidatedAt) || !ids(episode.messageIds) || !ids(episode.replyIds, 1) ||
        (episode.cleanupToken !== undefined && (typeof episode.cleanupToken !== 'string' || !ID_PATTERN.test(episode.cleanupToken))) ||
        (episode.peerId !== undefined && !isPlatformIdentifier(episode.peerId)) ||
        !object(episode.source) || !keys(episode.source, ['botId', 'personaId', 'personaVersion', 'personaName']) ||
        episode.source.botId !== botId || episode.source.personaId !== personaId ||
        !nonempty(episode.source.personaVersion, 4096) || !nonempty(episode.source.personaName, 4096)) fail()
    if (target.kind === 'private' ? episode.userId !== (episode.peerId ?? target.id) : episode.peerId !== undefined) fail()
  }
  if (new Set(parsed.episodes.map(episode => episode.id)).size !== parsed.episodes.length) fail()
  if (parsed.summary !== undefined) {
    const summary = parsed.summary
    if (!object(summary) || !keys(summary, ['text', 'updatedAt', 'coveredSeq', 'invalidatedAt', 'cleanupToken']) ||
        typeof summary.text !== 'string' || Array.from(summary.text).length > 4000 || !integer(summary.updatedAt) ||
        !integer(summary.coveredSeq) || summary.coveredSeq >= parsed.nextSeq || !integer(summary.invalidatedAt) ||
        (summary.cleanupToken !== undefined && (typeof summary.cleanupToken !== 'string' || !ID_PATTERN.test(summary.cleanupToken)))) fail()
  }
  return parsed as unknown as ConversationMemoryState
}

function sameRecord(left: ConversationMemoryRecord, right: ConversationMemoryRecord): boolean {
  return left.seq === right.seq && left.at === right.at && left.authorId === right.authorId &&
    left.name === right.name && left.text === right.text && left.peerId === right.peerId
}

export function createConversationMemoryStore(redis: ConversationMemoryRedis) {
  async function read(id: string) {
    const snapshot = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: [] })
    if (!Array.isArray(snapshot) || snapshot.length !== 3) fail()
    const catalogRaw = raw(snapshot[0]), stateRaw = raw(snapshot[1]), cleanupRaw = raw(snapshot[2])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    const cleanup = parseConversationCleanup(cleanupRaw)
    if (catalog.includes(id) !== Boolean(state)) fail()
    return { catalogRaw, stateRaw, cleanupRaw, catalog, state, cleanup }
  }
  const content = (state: ConversationMemoryState) => state.records.length + state.episodes.length + (state.summary ? 1 : 0)
  function visible(state: ConversationMemoryState | undefined, cleanup: ConversationCleanupFences) {
    if (!state) return undefined
    const projected = filterConversationMemoryState(state, cleanup)
    return content(state) && !content(projected) ? undefined : projected
  }
  const readSchedule = createMemoryScheduleSnapshot(redis, {
    catalogKey: CATALOG_KEY, cleanupKey: CLEANUP_KEY, stateKey, parseCatalog, parseCleanup: parseConversationCleanup,
    project(value, id, cleanup) {
      const state = visible(parseState(value, id), cleanup)
      if (!state || state.scope.target.kind !== 'group') return
      const { binding, scope, token, summary, dueAt, dueInvalidatedAt, dueCleanupToken, attempts, retryAt } = state
      return {
        id, binding, scope, token, dueAt, attempts, retryAt,
        ...(dueInvalidatedAt === undefined ? {} : { dueInvalidatedAt }),
        ...(dueCleanupToken === undefined ? {} : { dueCleanupToken }),
        records: state.records.map(({ seq, at }) => ({ seq, at })),
        summary: summary && { coveredSeq: summary.coveredSeq, updatedAt: summary.updatedAt,
          invalidatedAt: summary.invalidatedAt, cleanupToken: summary.cleanupToken },
      }
    },
  })
  async function rawList() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const catalogRaw = raw(await redis.get(CATALOG_KEY))
      const catalog = parseCatalog(catalogRaw)
      const snapshot = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, CLEANUP_KEY, ...catalog.map(stateKey)], arguments: expected(catalogRaw) })
      if (snapshot === null) continue
      if (!Array.isArray(snapshot) || snapshot.length !== catalog.length + 1) fail()
      const cleanup = parseConversationCleanup(raw(snapshot[0]))
      const states = catalog.map((id, index) => {
        const state = parseState(raw(snapshot[index + 1]), id)
        if (!state) fail()
        return state
      })
      return { states, cleanup }
    }
    return fail()
  }
  async function commit(saved: Awaited<ReturnType<typeof read>>, id: string, next: ConversationMemoryState | undefined) {
    const ids = next ? saved.catalog.includes(id) ? saved.catalog : [...saved.catalog, id] : saved.catalog.filter(value => value !== id)
    if (ids.length > MAX_STATES) fail()
    const arguments_ = [...expected(saved.catalogRaw), ...expected(saved.stateRaw), ...expected(saved.cleanupRaw),
      JSON.stringify({ version: 1, ids }), ...expected(next ? JSON.stringify(next) : null)]
    const result = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: arguments_ })
    if (result !== 0 && result !== 1) fail()
    return result === 1
  }

  return {
    async observeSchedule() {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const states = await readSchedule()
          if (states) return states
        }
      } catch (cause) { throw annotateAgentError(new Error(FAILURE), agentErrorDetails(cause) ?? {}) }
      return fail()
    },
    async list(): Promise<ConversationMemoryState[]> {
      try {
        const { states, cleanup } = await rawList()
        return states.flatMap(state => { const projected = visible(state, cleanup); return projected ? [projected] : [] })
      } catch { fail() }
      return fail()
    },
    async cleanupToken(scope: AgentConversationScope): Promise<string | undefined> {
      try {
        if (!validScope({ agentId: scope.agentId, target: scope.target })) fail()
        return conversationCleanupToken(scope, parseConversationCleanup(raw(await redis.get(CLEANUP_KEY))))
      } catch (cause) { throw annotateAgentError(new Error(FAILURE), agentErrorDetails(cause) ?? {}) }
    },
    async filterState(state: ConversationMemoryState): Promise<ConversationMemoryState> {
      try {
        const validated = parseState(JSON.stringify(state), state.id)
        if (!validated) fail()
        return filterConversationMemoryState(validated, parseConversationCleanup(raw(await redis.get(CLEANUP_KEY))))
      } catch { return fail() }
    },
    async load(id: string): Promise<ConversationMemoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        const saved = await read(id)
        return visible(saved.state, saved.cleanup)
      } catch { return fail() }
    },
    async update(id: string, change: (state: ConversationMemoryState | undefined) => ConversationMemoryState | undefined, isCurrent?: () => boolean): Promise<boolean> {
      let field = 'conversation_state_build', started = performance.now()
      const advance = (next: string) => { field = next; started = performance.now() }
      let attempt = 0
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          advance('conversation_state_read')
          const saved = await read(id)
          const { stateRaw, state, cleanup } = saved
          if (!current(isCurrent)) return false
          advance('conversation_state_build')
          const projected = state && filterConversationMemoryState(state, cleanup)
          const candidate = change(projected === undefined ? undefined : structuredClone(projected))
          const validated = parseState(candidate === undefined ? null : JSON.stringify(candidate), id)
          if (state && validated) {
            if (agentConversationKey(state.scope) !== agentConversationKey(validated.scope) || validated.nextSeq < state.nextSeq) fail()
            const previous = new Map(state.records.map(record => [record.messageId, record]))
            for (const record of validated.records) {
              const original = previous.get(record.messageId)
              if (original ? !sameRecord(record, original) : record.seq < state.nextSeq) fail()
            }
          }
          const filtered = validated && filterConversationMemoryState(validated, cleanup)
          const removedByCleanup = validated && filtered && content(validated) > content(filtered) || state && projected && content(state) > content(projected)
          const next = filtered && !content(filtered) && removedByCleanup ? undefined : filtered
          const nextRaw = next === undefined ? null : JSON.stringify(next)
          if (!current(isCurrent)) return false
          if (nextRaw === stateRaw || !state && !next) return true
          // No await separates the final synchronous scope check from commit.
          if (!current(isCurrent)) return false
          advance('conversation_state_commit')
          if (await commit(saved, id, next)) return true
        }
      } catch (cause) {
        throw annotateAgentError(new Error(FAILURE), { ...agentErrorDetails(cause), field,
          stepMs: Math.round(performance.now() - started), attempt, maxAttempts: MAX_ATTEMPTS })
      }
      throw annotateAgentError(new Error(FAILURE), { field, cause: 'conversation_state_conflict',
        stepMs: Math.round(performance.now() - started), attempt: MAX_ATTEMPTS, maxAttempts: MAX_ATTEMPTS })
    },
    async purgeSubject(input: AgentConversationMemoryPurgeSubject, guard: AgentConversationMemoryCleanupGuard): Promise<AgentConversationMemoryCleanupReceipt> {
      const selector = conversationCleanupSelector(input)
      await ensureConversationCleanup(guard)
      let published = false, authorizationFailed = false
      let removedRecords = 0, removedSummaries = 0, removedEpisodes = 0, removedPartitions = 0
      const authorize = async () => {
        try { await ensureConversationCleanup(guard) }
        catch (error) { authorizationFailed = true; throw error }
      }
      const receipt = (cleanup: 'completed' | 'unknown'): AgentConversationMemoryCleanupReceipt => ({ usage: 'blocked', cleanup, removedRecords, removedSummaries, removedEpisodes, removedPartitions })
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const previousRaw = raw(await redis.get(CLEANUP_KEY)), previous = parseConversationCleanup(previousRaw)
          const existing = previous.entries.find(entry => entry.id === selector.id)
          if (!existing && previous.entries.length >= CONVERSATION_CLEANUP_MAX_SELECTORS) fail()
          const entries = existing
            ? previous.entries.map(entry => entry.id === selector.id ? { ...entry, through: Math.max(entry.through, selector.through) } : entry)
            : [...previous.entries, selector]
          const nextRaw = existing && existing.through >= selector.through ? previousRaw! : JSON.stringify({ version: 1, entries })
          if (nextRaw.length > CONVERSATION_CLEANUP_MAX_BYTES) fail()
          await authorize()
          const result = await redis.eval(PUBLISH_CLEANUP, { keys: [CLEANUP_KEY], arguments: [...expected(previousRaw), nextRaw] })
          if (result === 1) { published = true; break }
          if (result !== 0) fail()
        }
        if (!published) fail()
        await authorize()
        const selectors = { version: 1 as const, entries: [selector] }
        for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
          const ids = parseCatalog(raw(await redis.get(CATALOG_KEY)))
          await authorize()
          for (const id of ids) {
            let settled = false
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
              const saved = await read(id)
              await authorize()
              const state = saved.state
              if (!state || !conversationCleanupMatchesScope(state.scope, selector)) { settled = true; break }
              // Only the requested inclusive author cutoff deletes originals.
              // Aggregates need the whole scope generation because userId is
              // not evidence that a mixed summary excludes another author.
              const projected = filterConversationMemoryState(state, saved.cleanup)
              const records = filterConversationCleanupRows(state.scope, state.records, selectors)
              const recordCount = state.records.length - records.length
              const summaryCount = state.summary && !projected.summary ? 1 : 0
              const episodeCount = state.episodes.length - projected.episodes.length
              if (!recordCount && !summaryCount && !episodeCount) { settled = true; break }
              const next = { ...projected, records }
              await authorize()
              if (!await commit(saved, id, content(next) ? next : undefined)) continue
              removedRecords += recordCount; removedSummaries += summaryCount; removedEpisodes += episodeCount
              if (!content(next)) removedPartitions++
              await authorize()
              settled = true; break
            }
            if (!settled) fail()
          }
          const verified = await rawList()
          await authorize()
          if (!verified.cleanup.entries.some(entry => entry.id === selector.id && entry.through >= selector.through)) fail()
          if (verified.states.every(state => {
            if (!conversationCleanupMatchesScope(state.scope, selector)) return true
            const projected = filterConversationMemoryState(state, verified.cleanup)
            return filterConversationCleanupRows(state.scope, state.records, selectors).length === state.records.length &&
              projected.episodes.length === state.episodes.length && Boolean(projected.summary) === Boolean(state.summary)
          })) return receipt('completed')
        }
        fail()
      } catch {
        if (authorizationFailed || !conversationCleanupCurrent(guard) || !published) fail()
        await authorize()
        return receipt('unknown')
      }
    },
  }
}
