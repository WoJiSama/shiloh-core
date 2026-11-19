import { createHash } from 'node:crypto'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { AgentSemanticMemoryCleanupGuard, AgentSemanticMemoryCleanupReceipt, AgentSemanticMemoryPurgeSubject } from '../../../contracts/semanticMemory.js'
import { agentConversationKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { ensureSemanticCleanup, filterSemanticCleanupRows, parseSemanticCleanup, semanticCleanupCurrent, semanticCleanupMatchesScope, semanticCleanupSelector, SEMANTIC_CLEANUP_MAX_BYTES, SEMANTIC_CLEANUP_MAX_SELECTORS, type SemanticCleanupFences } from './agentSemanticMemoryCleanup.js'

export interface AgentSemanticMemoryRow {
  messageId: string
  authorId: string
  name: string
  text: string
  at: number
  peerId?: string
  vector?: number[]
  providerId?: string
}

export interface AgentSemanticMemoryState {
  version: 1
  id: string
  scope: AgentConversationScope
  rows: AgentSemanticMemoryRow[]
}

export interface AgentSemanticMemoryScope {
  id: string
  scope: AgentConversationScope
}

interface AgentSemanticMemoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:semantic-memory:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const CLEANUP_KEY = `${PREFIX}:cleanup`
const MAX_STATES = 200
const MAX_ROWS = 2000
const MAX_ATTEMPTS = 20
const FAILURE = '语义记忆存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const stateKey = (id: string) => `${PREFIX}:state:${id}`

// Declare every Redis key so the standalone host applies its prefix and lease
// to the same atomic catalog/state snapshot and compare-and-set operation.
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
function sourceId(value: unknown): value is string { return isPlatformIdentifier(value) && value !== '0' }
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

export function agentSemanticMemoryId(scope: AgentConversationScope): string {
  return createHash('sha256').update(agentConversationKey(scope)).digest('hex')
}

function parseCatalog(value: string | null): AgentSemanticMemoryScope[] {
  if (value === null) return []
  if (value.length > 400_000) fail()
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'entries']) || parsed.version !== 1 || !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_STATES) fail()
  const ids = new Set<string>()
  for (const entry of parsed.entries) {
    if (!object(entry) || !keys(entry, ['id', 'scope']) || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) ||
        ids.has(entry.id) || !validScope(entry.scope) || agentSemanticMemoryId(entry.scope) !== entry.id) fail()
    ids.add(entry.id)
  }
  return parsed.entries as AgentSemanticMemoryScope[]
}

function parseState(value: string | null, id: string): AgentSemanticMemoryState | undefined {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'scope', 'rows']) || parsed.version !== 1 || parsed.id !== id ||
      !validScope(parsed.scope) || agentSemanticMemoryId(parsed.scope) !== id || !Array.isArray(parsed.rows) || parsed.rows.length > MAX_ROWS) fail()
  const { target } = parsed.scope
  for (const row of parsed.rows) {
    if (!object(row) || !keys(row, ['messageId', 'authorId', 'name', 'text', 'at', 'peerId', 'vector', 'providerId']) ||
        !sourceId(row.messageId) || !sourceId(row.authorId) || typeof row.name !== 'string' || row.name.length > 24 ||
        typeof row.text !== 'string' || !row.text.trim() || row.text.length > 1600 ||
        typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at <= 0 ||
        (row.peerId !== undefined && !sourceId(row.peerId))) fail()
    if (target.kind === 'private' ? row.authorId !== (row.peerId ?? target.id) : row.peerId !== undefined) fail()
    if (row.vector !== undefined || row.providerId !== undefined) {
      if (!Array.isArray(row.vector) || row.vector.length < 2 || row.vector.length > 4096 ||
          !row.vector.every(value => typeof value === 'number' && Number.isFinite(value)) || !row.vector.some(value => value !== 0) ||
          typeof row.providerId !== 'string' || !ID_PATTERN.test(row.providerId)) fail()
    }
  }
  if (new Set(parsed.rows.map(row => row.messageId)).size !== parsed.rows.length) fail()
  return parsed as unknown as AgentSemanticMemoryState
}

function sameSource(left: AgentSemanticMemoryRow, right: AgentSemanticMemoryRow): boolean {
  return left.authorId === right.authorId && left.name === right.name && left.text === right.text &&
    left.at === right.at && left.peerId === right.peerId
}

export function createAgentSemanticMemoryStore(redis: AgentSemanticMemoryRedis) {
  async function snapshot(id: string) {
    const values = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: [] })
    if (!Array.isArray(values) || values.length !== 3) fail()
    const catalogRaw = raw(values[0]), stateRaw = raw(values[1]), cleanupRaw = raw(values[2])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    const cleanup = parseSemanticCleanup(cleanupRaw)
    const entry = catalog.find(entry => entry.id === id)
    if (Boolean(entry) !== Boolean(state) || entry && state && agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
    return { catalogRaw, stateRaw, cleanupRaw, catalog, state, cleanup }
  }

  // The read projection may hide a blocked partition. Physical cleanup below
  // deliberately keeps the unfiltered snapshot for evidence and counts.
  function visible(state: AgentSemanticMemoryState | undefined, cleanup: SemanticCleanupFences): AgentSemanticMemoryState | undefined {
    if (!state) return undefined
    const rows = filterSemanticCleanupRows(state.scope, state.rows, cleanup)
    return state.rows.length && !rows.length ? undefined : { ...state, rows }
  }
  async function rawList() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const catalogRaw = raw(await redis.get(CATALOG_KEY))
      const catalog = parseCatalog(catalogRaw)
      const values = await redis.eval(READ_LIST, { keys: [CATALOG_KEY, CLEANUP_KEY, ...catalog.map(entry => stateKey(entry.id))], arguments: expected(catalogRaw) })
      if (values === null) continue
      if (!Array.isArray(values) || values.length !== catalog.length + 1) fail()
      const cleanup = parseSemanticCleanup(raw(values[0]))
      const states = catalog.map((entry, index) => {
        const state = parseState(raw(values[index + 1]), entry.id)
        if (!state || agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
        return state
      })
      return { states, cleanup }
    }
    return fail()
  }
  async function commit(saved: Awaited<ReturnType<typeof snapshot>>, id: string, next: AgentSemanticMemoryState | undefined) {
    const entry = next && { id, scope: next.scope }
    const entries = entry
      ? saved.catalog.some(item => item.id === id) ? saved.catalog.map(item => item.id === id ? entry : item) : [...saved.catalog, entry]
      : saved.catalog.filter(item => item.id !== id)
    if (entries.length > MAX_STATES) fail()
    const arguments_ = [...expected(saved.catalogRaw), ...expected(saved.stateRaw), ...expected(saved.cleanupRaw),
      JSON.stringify({ version: 1, entries }), ...expected(next ? JSON.stringify(next) : null)]
    const result = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: arguments_ })
    if (result !== 0 && result !== 1) fail()
    return result === 1
  }

  return {
    async listScopes(): Promise<AgentSemanticMemoryScope[]> {
      try { return parseCatalog(raw(await redis.get(CATALOG_KEY))) } catch { return fail() }
    },
    async list(): Promise<AgentSemanticMemoryState[]> {
      try {
        const { states, cleanup } = await rawList()
        return states.flatMap(state => { const projected = visible(state, cleanup); return projected ? [projected] : [] })
      } catch { fail() }
      return fail()
    },
    async filterRows(scope: AgentConversationScope, rows: readonly AgentSemanticMemoryRow[]): Promise<AgentSemanticMemoryRow[]> {
      try {
        if (!validScope({ agentId: scope.agentId, target: scope.target })) fail()
        return filterSemanticCleanupRows(scope, rows, parseSemanticCleanup(raw(await redis.get(CLEANUP_KEY))))
      } catch { return fail() }
    },
    async read(id: string): Promise<AgentSemanticMemoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        const saved = await snapshot(id)
        return visible(saved.state, saved.cleanup)
      } catch { return fail() }
    },
    async update(id: string, mutate: (state: AgentSemanticMemoryState | undefined) => AgentSemanticMemoryState | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          const saved = await snapshot(id)
          const { stateRaw, state, cleanup } = saved
          if (!current(isCurrent)) return false
          const projected = visible(state, cleanup)
          const candidate = mutate(projected === undefined ? undefined : structuredClone(projected))
          const validated = parseState(candidate === undefined ? null : JSON.stringify(candidate), id)
          if (state && validated) {
            if (agentConversationKey(state.scope) !== agentConversationKey(validated.scope)) fail()
            const previous = new Map(state.rows.map(row => [row.messageId, row]))
            for (const row of validated.rows) {
              const original = previous.get(row.messageId)
              if (original && !sameSource(original, row)) fail()
            }
          }
          const filtered = visible(validated, cleanup)
          const next = filtered && !filtered.rows.length && state?.rows.length && !projected ? undefined : filtered
          const nextRaw = next === undefined ? null : JSON.stringify(next)
          if (!current(isCurrent)) return false
          if (nextRaw === stateRaw || !state && !next) return true
          if (!current(isCurrent)) return false
          if (await commit(saved, id, next)) return true
        }
      } catch { fail() }
      return fail()
    },
    async purgeSubject(input: AgentSemanticMemoryPurgeSubject, guard: AgentSemanticMemoryCleanupGuard): Promise<AgentSemanticMemoryCleanupReceipt> {
      const selector = semanticCleanupSelector(input)
      await ensureSemanticCleanup(guard)
      let published = false
      let authorizationFailed = false
      let removedRows = 0, removedVectors = 0, removedPartitions = 0
      const authorize = async () => {
        try { await ensureSemanticCleanup(guard) }
        catch (error) { authorizationFailed = true; throw error }
      }
      const receipt = (cleanup: 'completed' | 'unknown'): AgentSemanticMemoryCleanupReceipt => ({ usage: 'blocked', cleanup, removedRows, removedVectors, removedPartitions })
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const previousRaw = raw(await redis.get(CLEANUP_KEY))
          const previous = parseSemanticCleanup(previousRaw)
          const existing = previous.entries.find(entry => entry.id === selector.id)
          if (!existing && previous.entries.length >= SEMANTIC_CLEANUP_MAX_SELECTORS) fail()
          const entries = existing
            ? previous.entries.map(entry => entry.id === selector.id ? { ...entry, through: Math.max(entry.through, selector.through) } : entry)
            : [...previous.entries, selector]
          // Keep replay bytes exact: old/equal requests never advance a cutoff.
          const nextRaw = existing && existing.through >= selector.through ? previousRaw! : JSON.stringify({ version: 1, entries })
          if (nextRaw.length > SEMANTIC_CLEANUP_MAX_BYTES) fail()
          await authorize()
          const result = await redis.eval(PUBLISH_CLEANUP, { keys: [CLEANUP_KEY], arguments: [...expected(previousRaw), nextRaw] })
          if (result === 1) { published = true; break }
          if (result !== 0) fail()
        }
        if (!published) fail()
        await authorize()
        const selectors = { version: 1 as const, entries: [selector] }
        for (let pass = 0; pass < MAX_ATTEMPTS; pass++) {
          const catalog = parseCatalog(raw(await redis.get(CATALOG_KEY)))
          await authorize()
          for (const entry of catalog) {
            if (!semanticCleanupMatchesScope(entry.scope, selector)) continue
            let settled = false
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
              const saved = await snapshot(entry.id)
              await authorize()
              const state = saved.state
              if (!state) { settled = true; break }
              const rows = filterSemanticCleanupRows(state.scope, state.rows, selectors)
              const removed = state.rows.length - rows.length
              if (!removed) { settled = true; break }
              const kept = new Set(rows.map(row => row.messageId))
              const vectors = state.rows.filter(row => !kept.has(row.messageId) && row.vector !== undefined).length
              await authorize()
              if (!await commit(saved, entry.id, rows.length ? { ...state, rows } : undefined)) continue
              removedRows += removed; removedVectors += vectors
              if (!rows.length) removedPartitions++
              await authorize()
              settled = true; break
            }
            if (!settled) fail()
          }
          // Completion proves physical state, including catalog retirement; it
          // never infers deletion from the blocked read projection.
          const verified = await rawList()
          await authorize()
          if (!verified.cleanup.entries.some(entry => entry.id === selector.id && entry.through >= selector.through)) fail()
          if (verified.states.every(state => !semanticCleanupMatchesScope(state.scope, selector) ||
            filterSemanticCleanupRows(state.scope, state.rows, selectors).length === state.rows.length)) return receipt('completed')
        }
        fail()
      } catch {
        if (authorizationFailed || !semanticCleanupCurrent(guard)) fail()
        // A blocked acknowledgement is only valid after an acknowledged Redis
        // fence CAS. A failed/ambiguous publication must reject outright.
        if (!published) fail()
        await authorize()
        return receipt('unknown')
      }
    },
  }
}
