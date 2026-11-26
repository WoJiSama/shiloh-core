import { createHash, randomBytes } from 'node:crypto'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { AgentSemanticMemoryCleanupGuard, AgentSemanticMemoryCleanupReceipt, AgentSemanticMemoryPurgeSubject } from '../../../contracts/semanticMemory.js'
import { agentConversationKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { ensureSemanticCleanup, filterSemanticCleanupRows, parseSemanticCleanup, semanticCleanupCurrent, semanticCleanupMatchesScope, semanticCleanupSelector, SEMANTIC_CLEANUP_KEY as CLEANUP_KEY, SEMANTIC_CLEANUP_MAX_BYTES, SEMANTIC_CLEANUP_MAX_SELECTORS, type SemanticCleanupFences } from './agentSemanticMemoryCleanup.js'
import { packSemanticVector, semanticVectorSourceDigest, unpackSemanticVector, type StoredSemanticVector } from './agentSemanticVectorStorage.js'

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

export interface AgentSemanticMemoryRedis {
  get(key: string): Promise<string | null>
  getSnapshot?(keys: string[]): Promise<(string | null)[]>
  matchesStringDigests?(keys: string[], digests: string[]): Promise<boolean>
  eval(script: string, options: { keys: string[]; arguments: string[]; isCurrent?: () => boolean }): Promise<unknown>
  /** Standalone intake uses a connection independent of recall and indexing. */
  readonly captureStorage?: AgentSemanticMemoryRedis
}

const PREFIX = 'agent:semantic-memory:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const MAX_STATES = 200
const MAX_ROWS = 2000
const MAX_ATTEMPTS = 20
const VECTOR_PAGE_SIZE = 32
const MAX_OBSERVED_BYTES = 64 * 1024 * 1024
const FAILURE = '语义记忆存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const stateKey = (id: string) => `${PREFIX}:state:${id}`
const vectorKey = (id: string) => `${PREFIX}:vectors:${id}`
const vectorRevisionKey = (id: string) => `${PREFIX}:vector-revision:${id}`
const digestValue = (value: string | null) => value === null ? 'absent' : createHash('sha1').update(value).digest('hex')

// Declare every Redis key so the standalone host applies its prefix and lease
// to the same atomic catalog/state snapshot and compare-and-set operation.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false, redis.call('GET', KEYS[3]) or false, redis.call('GET', KEYS[4]) or false}`
const READ_VECTOR_IDS = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
return redis.call('HKEYS', KEYS[2])`
const READ_VECTOR_PAGE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return false end
return redis.call('HMGET', KEYS[2], unpack(ARGV, 2))`
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
local revision = redis.call('GET', KEYS[4])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false)
  or (state or false) ~= (ARGV[3] == '1' and ARGV[4] or false)
  or (cleanup or false) ~= (ARGV[5] == '1' and ARGV[6] or false)
  or (revision or false) ~= (ARGV[10] == '1' and ARGV[11] or false) then return 0 end
local vectorType = redis.call('TYPE', KEYS[5]).ok
if vectorType ~= (revision and 'hash' or 'none') then return redis.error_reply('invalid semantic vector state') end
if ARGV[8] == '0' then
  redis.call('DEL', KEYS[2], KEYS[4], KEYS[5])
else
  local lastDeletion = 13 + tonumber(ARGV[13])
  local changed = false
  if lastDeletion >= 14 then changed = redis.call('HDEL', KEYS[5], unpack(ARGV, 14, lastDeletion)) > 0 end
  if lastDeletion < #ARGV then
    redis.call('HSET', KEYS[5], unpack(ARGV, lastDeletion + 1))
    changed = true
  end
  if changed then
    if redis.call('HLEN', KEYS[5]) > 0 then redis.call('SET', KEYS[4], ARGV[12])
    else redis.call('DEL', KEYS[4]) end
  end
  if state ~= ARGV[9] then redis.call('SET', KEYS[2], ARGV[9]) end
end
if catalog ~= ARGV[7] then redis.call('SET', KEYS[1], ARGV[7]) end
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

export function sameSemanticMemorySource(left: AgentSemanticMemoryRow, right: AgentSemanticMemoryRow): boolean {
  return left.authorId === right.authorId && left.name === right.name && left.text === right.text &&
    left.at === right.at && left.peerId === right.peerId && left.messageId === right.messageId
}

type SemanticSnapshot = {
  catalogRaw: string | null
  stateRaw: string | null
  cleanupRaw: string | null
  catalog: AgentSemanticMemoryScope[]
  cleanup: SemanticCleanupFences
  state: AgentSemanticMemoryState | undefined
  revision: string | null
  inlineVectors: ReadonlySet<string>
  vectors?: ReadonlyMap<string, StoredSemanticVector>
}

function vectorRevision(value: unknown): string | null {
  const revision = raw(value)
  if (revision !== null && !/^[a-f0-9]{32}$/u.test(revision)) fail()
  return revision
}

function withVectors(state: AgentSemanticMemoryState, vectors: ReadonlyMap<string, StoredSemanticVector>): AgentSemanticMemoryState {
  const rows = state.rows.map(row => {
    const stored = vectors.get(row.messageId)
    if (row.vector || !stored || stored.sourceDigest !== semanticVectorSourceDigest(row)) return row
    return { ...row, vector: stored.vector, providerId: stored.providerId }
  })
  return { ...state, rows }
}

function vectorChanged(left: AgentSemanticMemoryRow | undefined, right: AgentSemanticMemoryRow): boolean {
  return !left || left.providerId !== right.providerId || left.vector?.length !== right.vector?.length ||
    right.vector?.some((value, index) => value !== left.vector?.[index]) === true
}

interface VectorSnapshot {
  readonly revision: string
  readonly values: ReadonlyMap<string, StoredSemanticVector>
  readonly bytes: number
}

export function createAgentSemanticMemoryStore(redis: AgentSemanticMemoryRedis) {
  const captureStorage = redis.captureStorage ?? redis
  type CacheEntry = { observation?: ReturnType<typeof observation>; vectors?: VectorSnapshot; bytes: number }
  const observations = new Map<string, CacheEntry>()
  let observedBytes = 0
  function snapshotKeys(id: string): string[] {
    return [CATALOG_KEY, stateKey(id), CLEANUP_KEY, vectorRevisionKey(id)]
  }
  function observation(id: string, saved: SemanticSnapshot) {
    const state = visible(saved.state, saved.cleanup)
    if (state) {
      for (const row of state.rows) { if (row.vector) Object.freeze(row.vector); Object.freeze(row) }
      Object.freeze(state.rows)
      Object.freeze(state.scope.target.account)
      Object.freeze(state.scope.target)
      Object.freeze(state.scope)
      Object.freeze(state)
    }
    const matches = redis.matchesStringDigests
    const digests = matches ? [saved.catalogRaw, saved.stateRaw, saved.cleanupRaw, saved.revision].map(digestValue) : []
    return {
      state,
      hiddenRows: (saved.state?.rows.length ?? 0) !== (state?.rows.length ?? 0),
      hasInlineVectors: saved.inlineVectors.size > 0,
      bytes: Buffer.byteLength(saved.stateRaw ?? ''),
      isUnchanged: (includeVectors = true) => matches?.call(redis,
        includeVectors ? snapshotKeys(id) : snapshotKeys(id).slice(0, 3),
        includeVectors ? digests : digests.slice(0, 3)) ?? Promise.resolve(false),
    }
  }
  function forgetObservation(id: string) {
    const prior = observations.get(id)
    if (prior) { observedBytes -= prior.bytes; observations.delete(id) }
  }
  function rememberObservation(id: string, observed?: ReturnType<typeof observation>, vectors?: VectorSnapshot) {
    forgetObservation(id)
    const bytes = (observed?.bytes ?? 0) + (vectors?.bytes ?? 0)
    if (!redis.matchesStringDigests || !observed?.state && !vectors || bytes > MAX_OBSERVED_BYTES) return
    observations.set(id, { ...(observed?.state ? { observation: observed } : {}), ...(vectors ? { vectors } : {}), bytes })
    observedBytes += bytes
    while (observedBytes > MAX_OBSERVED_BYTES) forgetObservation(observations.keys().next().value!)
  }
  function vectorSnapshot(revision: string, values: ReadonlyMap<string, StoredSemanticVector>): VectorSnapshot {
    let bytes = 0
    for (const entry of values.values()) {
      Object.freeze(entry.vector)
      bytes += entry.vector.length * Float64Array.BYTES_PER_ELEMENT
    }
    return { revision, values, bytes }
  }
  async function sourceSnapshot(id: string, io: AgentSemanticMemoryRedis): Promise<SemanticSnapshot> {
    const keys = snapshotKeys(id)
    const values = await (io.getSnapshot ? io.getSnapshot(keys) : io.eval(READ_PAIR, { keys, arguments: [] }))
    if (!Array.isArray(values) || values.length !== keys.length) fail()
    const catalogRaw = raw(values[0]), stateRaw = raw(values[1]), cleanupRaw = raw(values[2])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    const cleanup = parseSemanticCleanup(cleanupRaw), revision = vectorRevision(values[3])
    const entry = catalog.find(entry => entry.id === id)
    if (Boolean(entry) !== Boolean(state) || revision && !state ||
        entry && state && agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
    const inlineVectors = new Set(state?.rows.filter(row => row.vector).map(row => row.messageId))
    return { catalogRaw, stateRaw, cleanupRaw, catalog, state, cleanup, revision, inlineVectors }
  }
  async function readVectors(id: string, revision: string, signal?: AbortSignal) {
    const keys = [vectorRevisionKey(id), vectorKey(id)]
    const scope = signal ? { isCurrent: () => !signal.aborted } : {}
    const ids = await redis.eval(READ_VECTOR_IDS, { keys, arguments: [revision], ...scope })
    signal?.throwIfAborted()
    if (ids === null) return undefined
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ROWS || !ids.every(sourceId) || new Set(ids).size !== ids.length) fail()
    const vectors = new Map<string, StoredSemanticVector>()
    for (let offset = 0; offset < ids.length; offset += VECTOR_PAGE_SIZE) {
      const page = ids.slice(offset, offset + VECTOR_PAGE_SIZE)
      const values = await redis.eval(READ_VECTOR_PAGE, { keys, arguments: [revision, ...page], ...scope })
      signal?.throwIfAborted()
      if (values === null) return undefined
      if (!Array.isArray(values) || values.length !== page.length) fail()
      for (const [index, encoded] of values.entries()) {
        if (typeof encoded !== 'string') fail()
        const vector = unpackSemanticVector(encoded)
        if (!vector) fail()
        vectors.set(page[index]!, vector)
      }
    }
    return vectors
  }
  async function snapshot(id: string, reuse?: VectorSnapshot, signal?: AbortSignal): Promise<SemanticSnapshot> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted()
      const saved = await sourceSnapshot(id, redis)
      signal?.throwIfAborted()
      if (!saved.revision || !saved.state) return saved
      const vectors = reuse?.revision === saved.revision ? reuse.values : await readVectors(id, saved.revision, signal)
      if (vectors) return { ...saved, state: withVectors(saved.state, vectors), vectors }
    }
    return fail()
  }

  // The read projection may hide a blocked partition. Physical cleanup below
  // deliberately keeps the unfiltered snapshot for evidence and counts.
  function visible(state: AgentSemanticMemoryState | undefined, cleanup: SemanticCleanupFences): AgentSemanticMemoryState | undefined {
    if (!state) return undefined
    const rows = filterSemanticCleanupRows(state.scope, state.rows, cleanup)
    return state.rows.length && !rows.length ? undefined : { ...state, rows }
  }
  async function rawList(includeVectors: boolean) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const catalogRaw = raw(await redis.get(CATALOG_KEY))
      const catalog = parseCatalog(catalogRaw)
      const keys = [CATALOG_KEY, CLEANUP_KEY, ...catalog.flatMap(entry => [stateKey(entry.id), vectorRevisionKey(entry.id)])]
      const values = await redis.eval(READ_LIST, { keys, arguments: expected(catalogRaw) })
      if (values === null) continue
      if (!Array.isArray(values) || values.length !== keys.length - 1) fail()
      const cleanup = parseSemanticCleanup(raw(values[0]))
      const states: AgentSemanticMemoryState[] = []
      for (const [index, entry] of catalog.entries()) {
        const state = parseState(raw(values[index * 2 + 1]), entry.id)
        if (!state || agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
        const revision = vectorRevision(values[index * 2 + 2])
        if (includeVectors && revision) {
          const vectors = await readVectors(entry.id, revision)
          if (!vectors) break
          states.push(withVectors(state, vectors))
        } else states.push(state)
      }
      if (states.length === catalog.length) return { states, cleanup }
    }
    return fail()
  }
  function catalogFor(saved: SemanticSnapshot, id: string, next: AgentSemanticMemoryState | undefined) {
    const entry = next && { id, scope: next.scope }
    const entries = entry
      ? saved.catalog.some(item => item.id === id) ? saved.catalog.map(item => item.id === id ? entry : item) : [...saved.catalog, entry]
      : saved.catalog.filter(item => item.id !== id)
    if (entries.length > MAX_STATES) fail()
    return JSON.stringify({ version: 1, entries })
  }
  async function commit(saved: SemanticSnapshot, id: string, next: AgentSemanticMemoryState | undefined,
    isCurrent?: () => boolean, io = redis, progress?: () => void) {
    const previous = new Map(saved.state?.rows.map(row => [row.messageId, row]))
    const retained = new Set<string>(), removed: string[] = [], changed: string[] = []
    const replacements = new Map<string, StoredSemanticVector>()
    const rows = next?.rows.map(row => {
      const { vector, providerId, ...source } = row
      const old = previous.get(row.messageId)
      retained.add(row.messageId)
      if (vector && providerId && (saved.inlineVectors.has(row.messageId) || vectorChanged(old, row))) {
        changed.push(row.messageId, packSemanticVector({ ...source, vector, providerId }))
        replacements.set(row.messageId, { vector, providerId, sourceDigest: semanticVectorSourceDigest(source) })
      } else if (!vector && (old?.vector || saved.vectors?.has(row.messageId))) removed.push(row.messageId)
      return source
    })
    if (next) for (const id of previous.keys()) if (!retained.has(id)) removed.push(id)
    const stateRaw = next ? JSON.stringify({ ...next, rows }) : null
    if (!current(isCurrent)) return 'cancelled'
    if (stateRaw === saved.stateRaw && !removed.length && !changed.length) return 'committed'
    const catalogRaw = catalogFor(saved, id, next)
    const nextRevision = randomBytes(16).toString('hex')
    const arguments_ = [...expected(saved.catalogRaw), ...expected(saved.stateRaw), ...expected(saved.cleanupRaw),
      catalogRaw, ...expected(stateRaw), ...expected(saved.revision), nextRevision, String(removed.length), ...removed, ...changed]
    let cancelled = false
    const result = await io.eval(COMPARE_AND_SET, { keys: [...snapshotKeys(id), vectorKey(id)], arguments: arguments_,
      ...(isCurrent ? { isCurrent: () => {
        cancelled ||= !current(isCurrent)
        return !cancelled
      } } : {}) })
    if (cancelled) return 'cancelled'
    progress?.()
    if (result !== 0 && result !== 1) fail()
    if (result === 0) return 'conflict'
    if (!next) forgetObservation(id)
    else if (removed.length || replacements.size) {
      // The CAS proves both the base revision and our delta. Advance only
      // from a complete set for that revision, or an initially empty hash.
      const prior = observations.get(id)?.vectors
      const base = prior?.revision === saved.revision ? prior.values : saved.vectors
      if (!saved.revision || base) {
        const values = new Map(base)
        let vectorsChanged = replacements.size > 0
        for (const key of removed) if (values.delete(key)) vectorsChanged = true
        for (const [key, value] of replacements) values.set(key, value)
        if (vectorsChanged) rememberObservation(id, undefined, values.size ? vectorSnapshot(nextRevision, values) : undefined)
      }
    }
    return 'committed'
  }

  type Mutation = (state: AgentSemanticMemoryState | undefined) => AgentSemanticMemoryState | undefined
  async function update(id: string, mutate: Mutation, isCurrent?: () => boolean,
    options: { sourcesOnly?: boolean; intake?: boolean; progress?: () => void } = {}): Promise<boolean> {
    const io = options.intake ? captureStorage : redis, progress = options.progress
    try {
      if (!ID_PATTERN.test(id)) fail()
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (!current(isCurrent)) return false
        const saved = await (options.sourcesOnly ? sourceSnapshot(id, io) : snapshot(id))
        progress?.()
        if (!current(isCurrent)) return false
        const { state, cleanup } = saved
        const projected = visible(state, cleanup)
        const candidate = mutate(projected === undefined ? undefined : structuredClone(projected))
        const validated = parseState(candidate === undefined ? null : JSON.stringify(candidate), id)
        if (state && validated) {
          if (agentConversationKey(state.scope) !== agentConversationKey(validated.scope)) fail()
          const previous = new Map(state.rows.map(row => [row.messageId, row]))
          for (const row of validated.rows) {
            const original = previous.get(row.messageId)
            if (original && !sameSemanticMemorySource(original, row)) fail()
          }
        }
        const filtered = visible(validated, cleanup)
        const next = filtered && !filtered.rows.length && state?.rows.length && !projected ? undefined : filtered
        if (!current(isCurrent)) return false
        const result = await commit(saved, id, next, isCurrent, io, progress)
        if (result !== 'conflict') return result === 'committed'
      }
    } catch { fail() }
    return fail()
  }

  return {
    /** Stages previously verified original sources against the same corpus and cleanup snapshots. */
    async planSourceImport(scope: AgentConversationScope, rows: readonly AgentSemanticMemoryRow[], capacity: number) {
      if (!validScope(scope) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_ROWS) return fail()
      if (!rows.length) return { imported: 0, checks: [] }
      const id = agentSemanticMemoryId(scope)
      const saved = await sourceSnapshot(id, redis)
      const existing = new Map(saved.state?.rows.map(row => [row.messageId, row]))
      // The archive transaction writes strings. Keep fenced physical rows for
      // the cleanup transaction, which deletes their detached vectors too.
      const nextRows = [...(saved.state?.rows ?? [])]
      let visibleCount = visible(saved.state, saved.cleanup)?.rows.length ?? 0
      let imported = 0
      const candidates = filterSemanticCleanupRows(scope, rows, saved.cleanup).sort((a, b) => b.at - a.at)
      for (const row of candidates) {
        const previous = existing.get(row.messageId)
        if (previous) {
          if (!sameSemanticMemorySource(previous, row)) return fail()
          continue
        }
        if (visibleCount >= capacity || nextRows.length >= MAX_ROWS) break
        existing.set(row.messageId, row)
        nextRows.push(row)
        visibleCount++
        imported++
      }
      if (!imported) return { imported, checks: [] }
      const next = { version: 1 as const, id, scope, rows: nextRows.sort((a, b) => a.at - b.at) }
      const serialized = JSON.stringify(next)
      parseState(serialized, id)
      return { imported, checks: [
        { key: CATALOG_KEY, value: saved.catalogRaw, write: catalogFor(saved, id, next) },
        { key: stateKey(id), value: saved.stateRaw, write: serialized },
        { key: CLEANUP_KEY, value: saved.cleanupRaw },
      ] }
    },
    async listScopes(): Promise<AgentSemanticMemoryScope[]> {
      try { return parseCatalog(raw(await redis.get(CATALOG_KEY))) } catch { return fail() }
    },
    async list(): Promise<AgentSemanticMemoryState[]> {
      try {
        const { states, cleanup } = await rawList(true)
        return states.flatMap(state => { const projected = visible(state, cleanup); return projected ? [projected] : [] })
      } catch { fail() }
      return fail()
    },
    async filterRows(scope: AgentConversationScope, rows: readonly AgentSemanticMemoryRow[], intake = false): Promise<AgentSemanticMemoryRow[]> {
      try {
        if (!validScope({ agentId: scope.agentId, target: scope.target })) fail()
        const io = intake ? captureStorage : redis
        return filterSemanticCleanupRows(scope, rows, parseSemanticCleanup(raw(await io.get(CLEANUP_KEY))))
      } catch { return fail() }
    },
    async read(id: string): Promise<AgentSemanticMemoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        const saved = await snapshot(id)
        return visible(saved.state, saved.cleanup)
      } catch { return fail() }
    },
    async observe(id: string, signal?: AbortSignal) {
      try {
        if (!ID_PATTERN.test(id)) fail()
        signal?.throwIfAborted()
        const prior = observations.get(id)
        if (prior?.observation && await prior.observation.isUnchanged()) {
          signal?.throwIfAborted()
          if (observations.get(id) === prior) rememberObservation(id, prior.observation, prior.vectors)
          return prior.observation
        }
        signal?.throwIfAborted()
        const saved = await snapshot(id, observations.get(id)?.vectors, signal)
        signal?.throwIfAborted()
        const observed = observation(id, saved)
        const cache = observations.get(id)?.vectors
        const vectors = saved.revision && saved.vectors
          ? cache?.revision === saved.revision ? cache : vectorSnapshot(saved.revision, saved.vectors)
          : undefined
        if (cache === prior?.vectors || !cache || cache.revision === saved.revision) rememberObservation(id, observed, vectors)
        return observed
      } catch { signal?.throwIfAborted(); return fail() }
    },
    /** Compare source rows against a fresh snapshot including the cleanup fence. Vector state cannot authorize a source. */
    async hasSources(id: string, expected: readonly AgentSemanticMemoryRow[], signal: AbortSignal): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        signal.throwIfAborted()
        const prior = observations.get(id)?.observation
        let state: AgentSemanticMemoryState | undefined
        if (prior && await prior.isUnchanged(false)) state = prior.state
        else {
          signal.throwIfAborted()
          const saved = await sourceSnapshot(id, redis)
          state = visible(saved.state, saved.cleanup)
        }
        signal.throwIfAborted()
        if (!state) return false
        const current = new Map(state.rows.map(row => [row.messageId, row]))
        return expected.every(row => {
          const present = current.get(row.messageId)
          return present !== undefined && sameSemanticMemorySource(present, row)
        })
      } catch { signal.throwIfAborted(); return fail() }
    },
    update(id: string, mutate: Mutation, isCurrent?: () => boolean) {
      return update(id, mutate, isCurrent)
    },
    /** Preserve existing detached vectors while changing sources or writing the vectors of selected rows. */
    updateSources(id: string, mutate: Mutation, isCurrent: () => boolean, onIntakeProgress?: () => void) {
      return update(id, mutate, isCurrent, { sourcesOnly: true,
        ...(onIntakeProgress ? { intake: true, progress: onIntakeProgress } : {}) })
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
          const result = await redis.eval(PUBLISH_CLEANUP, { keys: [CLEANUP_KEY], arguments: [...expected(previousRaw), nextRaw],
            isCurrent: () => semanticCleanupCurrent(guard) })
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
              const vectors = state.rows.filter(row => !kept.has(row.messageId) && (row.vector !== undefined || saved.vectors?.has(row.messageId))).length
              await authorize()
              const result = await commit(saved, entry.id, rows.length ? { ...state, rows } : undefined, () => semanticCleanupCurrent(guard))
              if (result === 'cancelled') fail()
              if (result === 'conflict') continue
              removedRows += removed; removedVectors += vectors
              if (!rows.length) removedPartitions++
              await authorize()
              settled = true; break
            }
            if (!settled) fail()
          }
          // Completion proves physical state, including catalog retirement; it
          // never infers deletion from the blocked read projection.
          const verified = await rawList(false)
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
