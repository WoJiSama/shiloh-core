import { createHash } from 'node:crypto'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import { agentConversationKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import type { AgentSourceMemoryCleanupGuard, AgentSourceMemoryPurgeSubject } from '../../../contracts/sourceMemoryCleanup.js'
import { conversationCleanupCurrent, conversationCleanupMatchesScope, filterConversationCleanupRows, parseConversationCleanup } from './conversationMemoryCleanup.js'
import { createSubjectMemoryCleanup } from './subjectMemoryCleanup.js'

export interface AgentHistoryRow {
  messageId: string
  authorId: string
  name: string
  text: string
  at: number
  peerId?: string
}

export interface AgentHistoryState {
  version: 1
  id: string
  scope: AgentConversationScope
  rows: AgentHistoryRow[]
}

export interface AgentHistoryScope {
  id: string
  scope: AgentConversationScope
}

interface AgentHistoryRedis {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const PREFIX = 'agent:history:v1'
const CATALOG_KEY = `${PREFIX}:catalog`
const CLEANUP_KEY = `${PREFIX}:cleanup`
const MAX_STATES = 200
const MAX_ROWS = 2000
const MAX_ATTEMPTS = 20
const FAILURE = '历史来源存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const stateKey = (id: string) => `${PREFIX}:state:${id}`

// Declare every Redis key so the standalone host applies its prefix and lease
// to the same atomic catalog/state snapshot and compare-and-set operation.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false, redis.call('GET', KEYS[3]) or false}`

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

export function agentHistoryId(scope: AgentConversationScope): string {
  return createHash('sha256').update(agentConversationKey(scope)).digest('hex')
}

function parseCatalog(value: string | null): AgentHistoryScope[] {
  if (value === null) return []
  if (value.length > 400_000) fail()
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'entries']) || parsed.version !== 1 || !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_STATES) fail()
  const ids = new Set<string>()
  for (const entry of parsed.entries) {
    if (!object(entry) || !keys(entry, ['id', 'scope']) || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) ||
        ids.has(entry.id) || !validScope(entry.scope) || agentHistoryId(entry.scope) !== entry.id) fail()
    ids.add(entry.id)
  }
  return parsed.entries as AgentHistoryScope[]
}

function parseState(value: string | null, id: string): AgentHistoryState | undefined {
  if (value === null) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!object(parsed) || !keys(parsed, ['version', 'id', 'scope', 'rows']) || parsed.version !== 1 || parsed.id !== id ||
      !validScope(parsed.scope) || agentHistoryId(parsed.scope) !== id || !Array.isArray(parsed.rows) || parsed.rows.length > MAX_ROWS) fail()
  const { target } = parsed.scope
  for (const row of parsed.rows) {
    if (!object(row) || !keys(row, ['messageId', 'authorId', 'name', 'text', 'at', 'peerId']) ||
        !sourceId(row.messageId) || !sourceId(row.authorId) || typeof row.name !== 'string' || row.name.length > 24 ||
        typeof row.text !== 'string' || !row.text.trim() || row.text.length > 4000 ||
        typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at <= 0 ||
        (row.peerId !== undefined && !sourceId(row.peerId))) fail()
    if (target.kind === 'private' ? row.authorId !== (row.peerId ?? target.id) : row.peerId !== undefined) fail()

  }
  if (new Set(parsed.rows.map(row => row.messageId)).size !== parsed.rows.length) fail()
  return parsed as unknown as AgentHistoryState
}

function sameSource(left: AgentHistoryRow, right: AgentHistoryRow): boolean {
  return left.authorId === right.authorId && left.name === right.name && left.text === right.text &&
    left.at === right.at && left.peerId === right.peerId
}

export function createAgentHistoryStore(redis: AgentHistoryRedis) {
  const cleanup = createSubjectMemoryCleanup(redis, CLEANUP_KEY, 'history-records')
  async function snapshot(id: string) {
    const values = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY], arguments: [] })
    if (!Array.isArray(values) || values.length !== 3) fail()
    const catalogRaw = raw(values[0]), stateRaw = raw(values[1]), cleanupRaw = raw(values[2])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    const entry = catalog.find(entry => entry.id === id)
    if (Boolean(entry) !== Boolean(state) || entry && state && agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
    return { catalogRaw, stateRaw, catalog, state, cleanupRaw, fences: parseConversationCleanup(cleanupRaw) }
  }
  function filtered(state: AgentHistoryState | undefined, fences: ReturnType<typeof parseConversationCleanup>) {
    if (!state) return undefined
    const rows = filterConversationCleanupRows(state.scope, state.rows, fences)
    return rows.length || !fences.entries.some(entry => conversationCleanupMatchesScope(state.scope, entry)) ? { ...state, rows } : undefined
  }
  async function commit(id: string, saved: Awaited<ReturnType<typeof snapshot>>, next: AgentHistoryState | undefined) {
    const nextRaw = next ? JSON.stringify(next) : null
    const entry = next && { id, scope: next.scope }
    const entries = entry ? saved.catalog.some(row => row.id === id) ? saved.catalog.map(row => row.id === id ? entry : row) : [...saved.catalog, entry] : saved.catalog.filter(row => row.id !== id)
    if (entries.length > MAX_STATES) fail()
    const result = await redis.eval(COMPARE_AND_SET, { keys: [CATALOG_KEY, stateKey(id), CLEANUP_KEY],
      arguments: [...expected(saved.catalogRaw), ...expected(saved.stateRaw), ...expected(saved.cleanupRaw), JSON.stringify({ version: 1, entries }), ...expected(nextRaw)] })
    if (result !== 0 && result !== 1) fail()
    return result === 1
  }

  return {
    async listScopes(): Promise<AgentHistoryScope[]> {
      try { return parseCatalog(raw(await redis.get(CATALOG_KEY))) } catch { return fail() }
    },
    async read(id: string): Promise<AgentHistoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        const saved = await snapshot(id)
        return filtered(saved.state, saved.fences)
      } catch { return fail() }
    },
    async update(id: string, mutate: (state: AgentHistoryState | undefined) => AgentHistoryState | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          const saved = await snapshot(id), { stateRaw, state } = saved
          if (!current(isCurrent)) return false
          const candidate = mutate(structuredClone(filtered(state, saved.fences)))
          const next = filtered(parseState(candidate === undefined ? null : JSON.stringify(candidate), id), saved.fences)
          const nextRaw = next === undefined ? null : JSON.stringify(next)
          if (state && next) {
            if (agentConversationKey(state.scope) !== agentConversationKey(next.scope)) fail()
            const previous = new Map(state.rows.map(row => [row.messageId, row]))
            for (const row of next.rows) {
              const original = previous.get(row.messageId)
              if (original && !sameSource(original, row)) fail()
            }
          }
          if (!current(isCurrent)) return false
          if (nextRaw === stateRaw || !state && !next) return true
          if (!current(isCurrent)) return false
          if (await commit(id, saved, next)) return true
        }
      } catch { fail() }
      return fail()
    },
    purgeSubject(input: AgentSourceMemoryPurgeSubject, guard: AgentSourceMemoryCleanupGuard) {
      return cleanup.purge(input, guard, async (selector, authorize, counts) => {
        const scopes = parseCatalog(raw(await redis.get(CATALOG_KEY)))
        await authorize()
        for (const { id, scope } of scopes) {
          if (!conversationCleanupMatchesScope(scope, selector)) continue
          let settled = false
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const saved = await snapshot(id); await authorize()
            if (!saved.state) { settled = true; break }
            const next = filtered(saved.state, saved.fences)
            const removed = saved.state.rows.length - (next?.rows.length ?? 0)
            if (!removed) { settled = true; break }
            await authorize()
            if (!await commit(id, saved, next)) continue
            counts.removedRecords += removed; if (!next) counts.removedPartitions++
            settled = true; break
          }
          if (!settled || !conversationCleanupCurrent(guard)) fail()
        }
        for (const { id, scope } of parseCatalog(raw(await redis.get(CATALOG_KEY)))) {
          await authorize()
          if (!conversationCleanupMatchesScope(scope, selector)) continue
          const saved = await snapshot(id); await authorize()
          if (saved.state && filterConversationCleanupRows(scope, saved.state.rows, saved.fences).length !== saved.state.rows.length) fail()
        }
      })
    },
  }
}
