import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot, AgentConversationScope, ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentGroupMemoryCleanupGuard, AgentGroupMemoryCleanupReceipt, AgentGroupMemoryPurgeSubject, GroupMemoryEntry, GroupMemoryMessage, GroupMemoryState } from '../../../contracts/groupMemory.js'
import { agentConversationKey, agentPersonaScopeId, conversationAddressKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { groupCleanupCurrent, groupCleanupMatchesScope, groupCleanupSelector, groupCleanupToken, ensureGroupCleanup, filterGroupMemoryState, groupMemoryContent, groupMemoryRetained, parseGroupCleanup, GROUP_CLEANUP_MAX_BYTES, GROUP_CLEANUP_MAX_SELECTORS, type GroupCleanupFences } from './groupMemoryCleanup.js'

interface GroupMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

interface GroupMemoryStaging {
  /** Returns staged values and registers each original value for the caller's atomic comparison. */
  get(key: string): Promise<string | null>
  stage(key: string, value: string | null): void
}

type GroupMemoryChange = (state: GroupMemoryState | undefined) => GroupMemoryState | undefined

const PREFIX = 'agent:group-memory:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const CLEANUP_KEY = `${PREFIX}:cleanup`
const MAX_STATES = 200
const MAX_ATTEMPTS = 20
const FAILURE = '群记忆存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const ENTRY_KINDS = new Set(['fact', 'alias', 'member_definition', 'member_set', 'group_file', 'workflow'])
const stateKey = (id: string) => `${PREFIX}:state:${id}`

// Catalog and document are read and compared together. Every accessed key is
// explicit so the host's key prefix and storage lease cover the whole operation.
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
function ids(value: unknown, maximum = 1000): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(messageId) && new Set(value).size === value.length
}
function raw(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') fail()
  return value
}
function expected(value: string | null): [string, string] { return [value === null ? '0' : '1', value ?? ''] }
function current(guard?: () => boolean): boolean {
  try { return guard?.() !== false } catch { return false }
}
function validTarget(value: unknown): value is ConversationAddress {
  return object(value) && keys(value, ['account', 'kind', 'id']) && object(value.account) &&
    keys(value.account, ['platform', 'namespace', 'id']) && isConversationAddress(value as unknown as ConversationAddress)
}
function validBinding(value: unknown, target: ConversationAddress, agentId: string): value is AgentBindingSnapshot {
  if (!object(value) || !keys(value, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']) ||
      value.source !== 'configured' || value.agentId !== agentId || !nonempty(value.revision, 4096) ||
      !isPlatformIdentifier(value.personaId) || typeof value.connectionId !== 'string' || !INTERNAL_ID_PATTERN.test(value.connectionId) ||
      !validTarget(value.target) || conversationAddressKey(value.target) !== conversationAddressKey(target)) return false
  return value.id === conversationAddressKey(target) && decodeAgentConversationKey(agentConversationKey({ agentId, target })) !== null
}
function validFile(value: unknown): boolean {
  if (!object(value) || !keys(value, ['name', 'reference']) || !nonempty(value.name, 180)) return false
  if (value.reference === undefined) return true
  // References are stable platform identifiers, never a transport URL or a path
  // on the host. Slashes inside an otherwise opaque identifier remain valid.
  return nonempty(value.reference, 240) && !/^(?:[a-z][a-z\d+.-]*:\/\/|https?:|file:|data:|blob:|\/|\\|~[\/\\]|\.{1,2}[\/\\]|[a-z]:[\/\\])/iu.test(value.reference)
}
function validMessage(value: unknown): value is GroupMemoryMessage {
  return object(value) && keys(value, ['messageId', 'authorId', 'name', 'text', 'at', 'mentions', 'files']) &&
    messageId(value.messageId) && isPlatformIdentifier(value.authorId) && typeof value.name === 'string' && value.name.length <= 24 &&
    typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 4000 && integer(value.at) && value.at > 0 &&
    ids(value.mentions, 50) && Array.isArray(value.files) && value.files.length <= 20 && value.files.every(validFile)
}
function sameMessage(left: GroupMemoryMessage, right: GroupMemoryMessage): boolean {
  return left.messageId === right.messageId && left.authorId === right.authorId && left.name === right.name &&
    left.text === right.text && left.at === right.at && JSON.stringify(left.mentions) === JSON.stringify(right.mentions) &&
    left.files.length === right.files.length && left.files.every((file, index) =>
      file.name === right.files[index]?.name && file.reference === right.files[index]?.reference)
}
function validPersona(value: unknown, target: ConversationAddress, personaIds: Set<string>, fact: boolean): boolean {
  if (!object(value) || value.botId !== personMemoryAddress(target).botId ||
      typeof value.personaId !== 'string' || !personaIds.has(value.personaId)) return false
  if (value.kind === 'legacy-qq-observation') {
    return !fact && target.account.platform === 'qq' && target.account.namespace === 'global' && target.kind === 'group' &&
      keys(value, ['kind', 'botId', 'personaId', 'sourceKey', 'recordId', 'fingerprint']) &&
      ['knowledge', 'workflows', 'alias'].some(part => value.sourceKey === `ytbot:mem:g:${target.id}:${part}`) &&
      messageId(value.recordId) && typeof value.fingerprint === 'string' && ID_PATTERN.test(value.fingerprint)
  }
  return keys(value, ['botId', 'personaId', 'personaVersion', 'personaName']) &&
    nonempty(value.personaVersion, 4096) && nonempty(value.personaName, 4096)
}
function validEntry(value: unknown, target: ConversationAddress, personaIds: Set<string>, fact: boolean): value is GroupMemoryEntry {
  if (!object(value) || !keys(value, ['id', 'kind', 'key', 'source', 'excerpt', 'persona', 'createdBy', 'createdAt', 'updatedAt',
    'text', 'subject', 'condition', 'targetUserIds', 'relatedUserIds', 'ownerId', 'file', 'tags', 'cleanupToken']) ||
      !messageId(value.id) || typeof value.kind !== 'string' || !ENTRY_KINDS.has(value.kind) || (value.kind === 'fact') !== fact ||
      !nonempty(value.key, 4096) || !validMessage(value.source) || typeof value.excerpt !== 'string' || !value.excerpt.trim() ||
      !value.source.text.includes(value.excerpt) || value.createdBy !== value.source.authorId ||
      !integer(value.createdAt) || value.createdAt === 0 || !integer(value.updatedAt) || value.updatedAt === 0 ||
      !ids(value.targetUserIds, 50) || !ids(value.relatedUserIds, 50) ||
      (value.cleanupToken !== undefined && (typeof value.cleanupToken !== 'string' || !ID_PATTERN.test(value.cleanupToken))) ||
      (value.ownerId !== undefined && !isPlatformIdentifier(value.ownerId)) ||
      (value.text !== undefined && !nonempty(value.text, 4000)) || (value.subject !== undefined && !nonempty(value.subject, 4000)) ||
      (value.condition !== undefined && !nonempty(value.condition, 4000)) || (value.file !== undefined && !validFile(value.file)) ||
      !Array.isArray(value.tags) || value.tags.length > 50 || !value.tags.every(tag => nonempty(tag, 128)) ||
      !validPersona(value.persona, target, personaIds, fact)) return false
  if (fact) return nonempty(value.text, 4000)
  if (value.kind === 'workflow') return nonempty(value.condition, 4000) && value.targetUserIds.length > 0
  if (!nonempty(value.subject, 4000)) return false
  if (value.kind === 'group_file') return validFile(value.file)
  return value.targetUserIds.length > 0 && (value.kind !== 'alias' || value.targetUserIds.length === 1)
}

export function groupMemoryId(target: ConversationAddress): string {
  return createHash('sha256').update(conversationAddressKey(target)).digest('hex')
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
function sources(state: GroupMemoryState): GroupMemoryMessage[] {
  return [...state.entries.map(entry => entry.source), ...state.agents.flatMap(agent =>
    [...agent.records, ...agent.jobs.flatMap(job => job.messages), ...agent.entries.map(entry => entry.source)])]
}
function parseState(value: string | null, id: string): GroupMemoryState | undefined {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'target', 'agents', 'entries', 'deletedSources', 'teachingDeletedSources', 'teachingClearedAt']) ||
      parsed.version !== 1 || parsed.id !== id || !validTarget(parsed.target) || groupMemoryId(parsed.target) !== id ||
      !ids(parsed.deletedSources) || parsed.teachingDeletedSources !== undefined && !ids(parsed.teachingDeletedSources) ||
      parsed.teachingClearedAt !== undefined && !integer(parsed.teachingClearedAt) || !Array.isArray(parsed.agents) || parsed.agents.length > 20 ||
      !Array.isArray(parsed.entries) || parsed.entries.length > 400) fail()
  const { target } = parsed
  const personaIds = new Set<string>()
  const agentIds = new Set<string>()
  for (const agent of parsed.agents) {
    if (!object(agent) || !keys(agent, ['agentId', 'binding', 'token', 'records', 'jobs', 'entries', 'seen', 'consensusDone', 'teachingDone', 'deletedSources', 'clearedAt', 'nextConsensusAt']) ||
        typeof agent.agentId !== 'string' || !INTERNAL_ID_PATTERN.test(agent.agentId) || agentIds.has(agent.agentId) ||
        !validBinding(agent.binding, target, agent.agentId) || !nonempty(agent.token, 4096) || !integer(agent.nextConsensusAt) ||
        !ids(agent.seen) || !ids(agent.consensusDone) || !ids(agent.teachingDone) || !ids(agent.deletedSources) ||
        agent.clearedAt !== undefined && !integer(agent.clearedAt) ||
        !Array.isArray(agent.records) || agent.records.length > 60 || !agent.records.every(validMessage) ||
        new Set(agent.records.map(record => record.messageId)).size !== agent.records.length ||
        !Array.isArray(agent.jobs) || agent.jobs.length > 60 || !Array.isArray(agent.entries) || agent.entries.length > 50) fail()
    agentIds.add(agent.agentId)
    const personaId = agentPersonaScopeId(agent.agentId)
    personaIds.add(personaId)
    for (const job of agent.jobs) {
      if (!object(job) || !keys(job, ['id', 'mode', 'messages', 'attempts', 'retryAt', 'invalidatedAt', 'cleanupToken']) || !messageId(job.id) ||
          !['consensus', 'teaching'].includes(String(job.mode)) || !integer(job.attempts) || job.attempts > 3 ||
          !integer(job.retryAt) || !integer(job.invalidatedAt) ||
          (job.cleanupToken !== undefined && (typeof job.cleanupToken !== 'string' || !ID_PATTERN.test(job.cleanupToken))) || !Array.isArray(job.messages) || !job.messages.length ||
          job.messages.length > 40 || !job.messages.every(validMessage) ||
          new Set(job.messages.map(message => message.messageId)).size !== job.messages.length) fail()
    }
    if (new Set(agent.jobs.map(job => job.id)).size !== agent.jobs.length ||
        !agent.entries.every(entry => validEntry(entry, target, new Set([personaId]), true)) ||
        new Set(agent.entries.map(entry => entry.id)).size !== agent.entries.length) fail()
  }
  if (!parsed.entries.every(entry => validEntry(entry, target, personaIds, false)) ||
      new Set(parsed.entries.map(entry => entry.id)).size !== parsed.entries.length) fail()
  const state = parsed as unknown as GroupMemoryState
  const known = new Map<string, GroupMemoryMessage>()
  for (const source of sources(state)) {
    const original = known.get(source.messageId)
    if (original && !sameMessage(original, source)) fail()
    known.set(source.messageId, source)
  }
  return state
}

function parseSnapshot(catalogRaw: string | null, stateRaw: string | null, cleanupRaw: string | null, id: string) {
  const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
  if (catalog.includes(id) !== Boolean(state)) fail()
  return { catalogRaw, stateRaw, cleanupRaw, cleanup: parseGroupCleanup(cleanupRaw), catalog, state }
}

function projectUpdate(snapshot: ReturnType<typeof parseSnapshot>, id: string, change: GroupMemoryChange) {
  const { catalog, state, cleanup } = snapshot
  const projected = state && filterGroupMemoryState(state, cleanup)
  const candidate = change(projected === undefined ? undefined : structuredClone(projected))
  const validated = parseState(candidate === undefined ? null : JSON.stringify(candidate), id)
  const filtered = validated && filterGroupMemoryState(validated, cleanup)
  const removedByCleanup = validated && filtered && groupMemoryContent(validated) > groupMemoryContent(filtered) ||
    state && projected && groupMemoryContent(state) > groupMemoryContent(projected)
  const next = filtered && !groupMemoryRetained(filtered) && removedByCleanup ? undefined : filtered
  const nextRaw = next === undefined ? null : JSON.stringify(next)
  if (state && validated) {
    if (conversationAddressKey(state.target) !== conversationAddressKey(validated.target) ||
        state.agents.some(agent => !validated.agents.some(value => value.agentId === agent.agentId))) fail()
    const previous = new Map(sources(state).map(source => [source.messageId, source]))
    for (const source of sources(validated)) {
      const original = previous.get(source.messageId)
      if (original && !sameMessage(original, source)) fail()
    }
  }
  const nextCatalog = next ? catalog.includes(id) ? catalog : [...catalog, id] : catalog.filter(value => value !== id)
  if (nextCatalog.length > MAX_STATES) fail()
  return { next, nextRaw, nextCatalogRaw: JSON.stringify({ version: 1, ids: nextCatalog }) }
}

/** Validates a proposed update without writing Redis; the caller commits all registered comparisons and staged writes together. */
export async function stageGroupMemoryUpdate(storage: GroupMemoryStaging, target: ConversationAddress, change: GroupMemoryChange): Promise<GroupMemoryState | undefined> {
  try {
    if (!validTarget(target)) fail()
    const id = groupMemoryId(target)
    const [catalogRaw, stateRaw, cleanupRaw] = await Promise.all([storage.get(CATALOG_KEY), storage.get(stateKey(id)), storage.get(CLEANUP_KEY)])
    const snapshot = parseSnapshot(raw(catalogRaw), raw(stateRaw), raw(cleanupRaw), id)
    const { next, nextRaw, nextCatalogRaw } = projectUpdate(snapshot, id, change)
    if (next && conversationAddressKey(next.target) !== conversationAddressKey(target)) fail()
    if (nextRaw !== snapshot.stateRaw) {
      storage.stage(CATALOG_KEY, nextCatalogRaw)
      storage.stage(stateKey(id), nextRaw)
    }
    return next
  } catch { return fail() }
}

export function createGroupMemoryStore(redis: GroupMemoryRedis) {
  async function read(id: string) {
    const snapshot = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: [] })
    if (!Array.isArray(snapshot) || snapshot.length !== 3) fail()
    return parseSnapshot(raw(snapshot[0]), raw(snapshot[1]), raw(snapshot[2]), id)
  }
  function visible(state: GroupMemoryState | undefined, cleanup: GroupCleanupFences) {
    if (!state) return undefined
    const projected = filterGroupMemoryState(state, cleanup)
    return groupMemoryContent(state) && !groupMemoryRetained(projected) ? undefined : projected
  }
  async function rawList() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const catalogRaw = raw(await redis.get(CATALOG_KEY)), catalog = parseCatalog(catalogRaw)
      const snapshot = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, CLEANUP_KEY, ...catalog.map(stateKey)], arguments: expected(catalogRaw) })
      if (snapshot === null) continue
      if (!Array.isArray(snapshot) || snapshot.length !== catalog.length + 1) fail()
      const cleanup = parseGroupCleanup(raw(snapshot[0]))
      const states = catalog.map((id, index) => {
        const state = parseState(raw(snapshot[index + 1]), id)
        if (!state) fail()
        return state
      })
      return { states, cleanup }
    }
    return fail()
  }
  async function commit(saved: Awaited<ReturnType<typeof read>>, id: string, next: GroupMemoryState | undefined) {
    const ids = next ? saved.catalog.includes(id) ? saved.catalog : [...saved.catalog, id] : saved.catalog.filter(value => value !== id)
    if (ids.length > MAX_STATES) fail()
    const result = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: [
      ...expected(saved.catalogRaw), ...expected(saved.stateRaw), ...expected(saved.cleanupRaw),
      JSON.stringify({ version: 1, ids }), ...expected(next === undefined ? null : JSON.stringify(next)),
    ] })
    if (result !== 0 && result !== 1) fail()
    return result === 1
  }
  return {
    async list(): Promise<GroupMemoryState[]> {
      try {
        const { states, cleanup } = await rawList()
        return states.flatMap(state => { const projected = visible(state, cleanup); return projected ? [projected] : [] })
      } catch { return fail() }
    },
    async cleanupToken(scope: AgentConversationScope): Promise<string | undefined> {
      try {
        if (!validTarget(scope.target) || decodeAgentConversationKey(agentConversationKey(scope)) === null) fail()
        return groupCleanupToken(scope, parseGroupCleanup(raw(await redis.get(CLEANUP_KEY))))
      } catch { return fail() }
    },
    async filterState(state: GroupMemoryState): Promise<GroupMemoryState> {
      try {
        const validated = parseState(JSON.stringify(state), state.id)
        if (!validated) fail()
        return filterGroupMemoryState(validated, parseGroupCleanup(raw(await redis.get(CLEANUP_KEY))))
      } catch { return fail() }
    },
    async load(id: string): Promise<GroupMemoryState | undefined> {
      try {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail()
        const saved = await read(id)
        return visible(saved.state, saved.cleanup)
      } catch { return fail() }
    },
    async update(id: string, change: GroupMemoryChange, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          const saved = await read(id)
          if (!current(isCurrent)) return false
          const { next, nextRaw } = projectUpdate(saved, id, change)
          if (!current(isCurrent)) return false
          if (nextRaw === saved.stateRaw || !saved.state && !next) return true
          if (!current(isCurrent)) return false
          if (await commit(saved, id, next)) return true
        }
      } catch { fail() }
      return fail()
    },
    async purgeSubject(input: AgentGroupMemoryPurgeSubject, guard: AgentGroupMemoryCleanupGuard): Promise<AgentGroupMemoryCleanupReceipt> {
      const selector = groupCleanupSelector(input)
      await ensureGroupCleanup(guard)
      let published = false, authorizationFailed = false
      let removedRecords = 0, removedJobs = 0, removedEntries = 0, removedPartitions = 0
      const authorize = async () => {
        try { await ensureGroupCleanup(guard) }
        catch (error) { authorizationFailed = true; throw error }
      }
      const receipt = (cleanup: 'completed' | 'unknown'): AgentGroupMemoryCleanupReceipt => ({ usage: 'blocked', cleanup, removedRecords, removedJobs, removedEntries, removedPartitions })
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const previousRaw = raw(await redis.get(CLEANUP_KEY)), previous = parseGroupCleanup(previousRaw)
          const existing = previous.entries.find(entry => entry.id === selector.id)
          if (!existing && previous.entries.length >= GROUP_CLEANUP_MAX_SELECTORS) fail()
          const entries = existing
            ? previous.entries.map(entry => entry.id === selector.id ? { ...entry, through: Math.max(entry.through, selector.through) } : entry)
            : [...previous.entries, selector]
          const nextRaw = existing && existing.through >= selector.through ? previousRaw! : JSON.stringify({ version: 1, entries })
          if (nextRaw.length > GROUP_CLEANUP_MAX_BYTES) fail()
          await authorize()
          const result = await redis.eval(PUBLISH_CLEANUP, { keys: [CLEANUP_KEY], arguments: [...expected(previousRaw), nextRaw] })
          if (result === 1) { published = true; break }
          if (result !== 0) fail()
        }
        if (!published) fail()
        await authorize()
        for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
          const ids = parseCatalog(raw(await redis.get(CATALOG_KEY)))
          await authorize()
          for (const id of ids) {
            let settled = false
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
              const saved = await read(id)
              await authorize()
              const state = saved.state
              if (!state || !state.agents.some(agent => groupCleanupMatchesScope({ agentId: agent.agentId, target: state.target }, selector))) { settled = true; break }
              const next = filterGroupMemoryState(state, saved.cleanup)
              const recordCount = state.agents.reduce((count, agent, index) => count + agent.records.length - next.agents[index]!.records.length, 0)
              const jobCount = state.agents.reduce((count, agent, index) => count + agent.jobs.length - next.agents[index]!.jobs.length, 0)
              const entryCount = state.entries.length - next.entries.length + state.agents.reduce((count, agent, index) => count + agent.entries.length - next.agents[index]!.entries.length, 0)
              if (!recordCount && !jobCount && !entryCount) { settled = true; break }
              await authorize()
              if (!await commit(saved, id, groupMemoryRetained(next) ? next : undefined)) continue
              removedRecords += recordCount; removedJobs += jobCount; removedEntries += entryCount
              if (!groupMemoryRetained(next)) removedPartitions++
              await authorize()
              settled = true; break
            }
            if (!settled) fail()
          }
          const verified = await rawList()
          await authorize()
          if (!verified.cleanup.entries.some(entry => entry.id === selector.id && entry.through >= selector.through)) fail()
          if (verified.states.every(state => !state.agents.some(agent => groupCleanupMatchesScope({ agentId: agent.agentId, target: state.target }, selector)) ||
              groupMemoryContent(filterGroupMemoryState(state, verified.cleanup)) === groupMemoryContent(state))) return receipt('completed')
        }
        fail()
      } catch {
        if (authorizationFailed || !groupCleanupCurrent(guard) || !published) fail()
        await authorize()
        return receipt('unknown')
      }
    },
  }
}
