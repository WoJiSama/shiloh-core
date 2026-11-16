import { createHash } from 'node:crypto'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import { agentConversationKey, decodeAgentConversationKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

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
const MAX_STATES = 200
const MAX_ROWS = 2000
const MAX_ATTEMPTS = 20
const FAILURE = '历史来源存储不可用或状态无效，已停止读写。'
const ID_PATTERN = /^[\da-f]{64}$/u
const stateKey = (id: string) => `${PREFIX}:state:${id}`

// Declare every Redis key so the standalone host applies its prefix and lease
// to the same atomic catalog/state snapshot and compare-and-set operation.
const READ_PAIR = `return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false}`

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
  async function snapshot(id: string) {
    const values = await redis.eval(READ_PAIR, { keys: [CATALOG_KEY, stateKey(id)], arguments: [] })
    if (!Array.isArray(values) || values.length !== 2) fail()
    const catalogRaw = raw(values[0]), stateRaw = raw(values[1])
    const catalog = parseCatalog(catalogRaw), state = parseState(stateRaw, id)
    const entry = catalog.find(entry => entry.id === id)
    if (Boolean(entry) !== Boolean(state) || entry && state && agentConversationKey(entry.scope) !== agentConversationKey(state.scope)) fail()
    return { catalogRaw, stateRaw, catalog, state }
  }

  return {
    async listScopes(): Promise<AgentHistoryScope[]> {
      try { return parseCatalog(raw(await redis.get(CATALOG_KEY))) } catch { return fail() }
    },
    async read(id: string): Promise<AgentHistoryState | undefined> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        return (await snapshot(id)).state
      } catch { return fail() }
    },
    async update(id: string, mutate: (state: AgentHistoryState | undefined) => AgentHistoryState | undefined, isCurrent?: () => boolean): Promise<boolean> {
      try {
        if (!ID_PATTERN.test(id)) fail()
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (!current(isCurrent)) return false
          const { catalogRaw, stateRaw, catalog, state } = await snapshot(id)
          if (!current(isCurrent)) return false
          const candidate = mutate(state === undefined ? undefined : structuredClone(state))
          const nextRaw = candidate === undefined ? null : JSON.stringify(candidate)
          const next = parseState(nextRaw, id)
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
          const nextEntry = next && { id, scope: next.scope }
          const nextCatalog = nextEntry
            ? catalog.some(entry => entry.id === id) ? catalog.map(entry => entry.id === id ? nextEntry : entry) : [...catalog, nextEntry]
            : catalog.filter(entry => entry.id !== id)
          if (nextCatalog.length > MAX_STATES) fail()
          const arguments_ = [...expected(catalogRaw), ...expected(stateRaw), JSON.stringify({ version: 1, entries: nextCatalog }), ...expected(nextRaw)]
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
