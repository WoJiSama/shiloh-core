import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentMediaShare } from '../../../contracts/agentMediaRelayWorkflow.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount } from '../../runtime/domain/agentBindings.js'
import { validateAgentMediaShare } from './agentBilibiliRelayReference.js'

export type MediaOutboxEffect = 'forward' | 'forwardRetry' | 'directIntro' | 'directVideo' | 'link'
export interface AgentMediaOutboxSource {
  readonly messageId: string
  readonly sender: PlatformUserRef
  readonly occurredAt: number
  readonly share: AgentMediaShare
}
export interface AgentMediaOutboxRecord {
  readonly version: 1
  readonly id: string
  readonly sequence: number
  readonly source: AgentMediaOutboxSource
  readonly binding: AgentBindingSnapshot
  readonly state: 'queued' | 'preparing' | 'sending' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly prepareAttempts: number
  readonly prepareFailures: number
  readonly nextAttemptAt: number
  readonly effects: readonly {
    readonly effect: MediaOutboxEffect
    readonly state: 'pending' | 'sent' | 'failed' | 'unknown'
    readonly beganAt: number
    readonly finishedAt?: number
    readonly receipt?: DeliveryReceipt
  }[]
}
export interface AgentMediaOutboxSession {
  readonly record: AgentMediaOutboxRecord
  preparing(): Promise<void>
  begin(effect: MediaOutboxEffect): Promise<void>
  finish(effect: MediaOutboxEffect, receipt: DeliveryReceipt): Promise<void>
  retry(nextAttemptAt: number, failed?: boolean): Promise<void>
  close(state: 'completed' | 'failed' | 'cancelled' | 'unknown'): Promise<void>
  abandon(): void
}
export interface AgentMediaOutboxReadStorage {
  get(key: string): Promise<string | null>
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string | string[]>
}
export interface AgentMediaOutboxObservation {
  readonly id: string
  readonly binding: AgentBindingSnapshot
  readonly provider: AgentMediaShare['provider']
  readonly state: AgentMediaOutboxRecord['state']
  readonly createdAt: number
  readonly updatedAt: number
  /** Scheduling lifetime, not the Redis retention deadline. */
  readonly expiresAt: number
  readonly prepareAttempts: number
  readonly prepareFailures: number
  readonly nextAttemptAt: number
  readonly effects: readonly {
    readonly effect: MediaOutboxEffect
    readonly state: 'pending' | 'sent' | 'failed' | 'unknown'
    readonly beganAt: number
    readonly finishedAt?: number
  }[]
}
const PREFIX = 'agent:media-outbox:v1:', ACTIVE = `${PREFIX}active`, LANES = `${PREFIX}lanes`, SEQUENCE = `${PREFIX}sequence`
export const AGENT_MEDIA_OUTBOX_RETENTION_SECONDS = 7 * 86400
export const AGENT_MEDIA_OUTBOX_LIFETIME_MS = 24 * 60 * 60 * 1000
const RETENTION = AGENT_MEDIA_OUTBOX_RETENTION_SECONDS, LIFETIME = AGENT_MEDIA_OUTBOX_LIFETIME_MS, MAX_BYTES = 16384
const effects = new Set<MediaOutboxEffect>(['forward', 'forwardRetry', 'directIntro', 'directVideo', 'link'])
const terminal = new Set(['completed', 'failed', 'cancelled', 'unknown'])
const states = new Set(['queued', 'preparing', 'sending', ...terminal])
const ownership = new WeakMap<AgentInboxRedis, Map<string, string>>()
const failure = () => new Error('媒体投递账本不可用或任务已失效')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const recordKey = (id: string) => `${PREFIX}job:${id}`
const ownerKey = (id: string) => `${PREFIX}owner:${id}`
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const safeText = (value: unknown, maximum = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) && !/(?:https?|file|data|base64):/iu.test(value)
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw failure()
  return value as Record<string, unknown>
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
function identity(input: unknown): PlatformUserRef {
  const value = closed(input, ['platform', 'namespace', 'id'])
  if (![value.platform, value.namespace, value.id].every(item => safeText(item)) || !isPlatformAccount(value as unknown as PlatformUserRef)) throw failure()
  return { platform: value.platform as string, namespace: value.namespace as string, id: value.id as string }
}
function target(input: unknown): ConversationAddress {
  const value = closed(input, ['account', 'kind', 'id']), account = identity(value.account)
  const selected = { account, kind: value.kind, id: value.id }
  if (!safeText(value.id) || !isConversationAddress(selected as ConversationAddress)) throw failure()
  return selected as ConversationAddress
}
function bindingSnapshot(input: unknown): AgentBindingSnapshot {
  const value = closed(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']), selected = target(value.target)
  if (value.source !== 'configured' && value.source !== 'legacy' || !safeText(value.id, 4096) || value.id !== conversationAddressKey(selected) ||
      !safeText(value.revision, 4096) || ![value.agentId, value.personaId, value.connectionId].every(item => safeText(item, 64))) throw failure()
  return { source: value.source, id: value.id, revision: value.revision, agentId: value.agentId as string,
    personaId: value.personaId as string, connectionId: value.connectionId as string, target: selected }
}
function sourceSnapshot(input: unknown, binding: AgentBindingSnapshot): AgentMediaOutboxSource {
  const value = closed(input, ['messageId', 'sender', 'occurredAt', 'share']), sender = identity(value.sender)
  if (!safeText(value.messageId) || /^0+$/u.test(value.messageId) || !number(value.occurredAt) || value.occurredAt === 0 ||
      sender.platform !== binding.target.account.platform || sender.namespace !== binding.target.account.namespace) throw failure()
  return { messageId: value.messageId, sender, occurredAt: value.occurredAt, share: validateAgentMediaShare(value.share) }
}
export function agentMediaOutboxId(binding: AgentBindingSnapshot, messageId: string): string {
  try {
    const selected = bindingSnapshot(binding)
    if (!safeText(messageId) || /^0+$/u.test(messageId)) throw failure()
    return digest(JSON.stringify([conversationAddressKey(selected.target), agentBindingToken(selected), messageId]))
  } catch { throw failure() }
}
const laneFor = (binding: AgentBindingSnapshot) => digest(JSON.stringify([binding.connectionId, conversationAddressKey(binding.target)]))
/** Automatic media jobs coordinate physical groups; private conversations retain their account boundary. */
export function agentMediaSourceScopeKey(input: ConversationAddress): string {
  try {
    const selected = target(input)
    return digest(JSON.stringify([selected.account.platform, selected.account.namespace, selected.kind, selected.id,
      ...(selected.kind === 'group' ? [] : [selected.account.id])]))
  } catch { throw failure() }
}
const sourceKey = (selected: ConversationAddress, messageId: string) => digest(JSON.stringify([agentMediaSourceScopeKey(selected), messageId]))
// One automatic source can be admitted once per instance, even when account election or binding changes.
const admissionKey = (selected: ConversationAddress, messageId: string) => `${PREFIX}admission:${sourceKey(selected, messageId)}`
const cancelKey = (selected: ConversationAddress, messageId: string) => `${PREFIX}cancel:${sourceKey(selected, messageId)}`
function normalizedReceipt(input: unknown): DeliveryReceipt {
  try {
    const value = closed(input, ['state', 'code', 'messageId'])
    if (value.state === 'failed') return { state: 'failed', code: null }
    if (value.state === 'sent' && safeText(value.messageId) && !/^0+$/u.test(value.messageId)) return { state: 'sent', messageId: value.messageId }
  } catch {}
  return { state: 'unknown' }
}
function serialize(record: AgentMediaOutboxRecord): string {
  const raw = JSON.stringify(record)
  if (Buffer.byteLength(raw) > MAX_BYTES) throw failure()
  return raw
}
function parse(raw: string): AgentMediaOutboxRecord {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw failure()
    const value = closed(JSON.parse(raw), ['version', 'id', 'sequence', 'source', 'binding', 'state', 'createdAt', 'updatedAt', 'expiresAt', 'prepareAttempts', 'prepareFailures', 'nextAttemptAt', 'effects'])
    const binding = bindingSnapshot(value.binding), source = sourceSnapshot(value.source, binding)
    if (value.version !== 1 || typeof value.id !== 'string' || value.id !== agentMediaOutboxId(binding, source.messageId) ||
        !number(value.sequence) || value.sequence < 1 || typeof value.state !== 'string' || !states.has(value.state) ||
        !number(value.createdAt) || !number(value.updatedAt) || value.updatedAt < value.createdAt || !number(value.expiresAt) || value.expiresAt !== value.createdAt + LIFETIME ||
        !number(value.prepareAttempts) || value.prepareAttempts > 1024 || !number(value.prepareFailures) || value.prepareFailures > 3 || value.prepareFailures > value.prepareAttempts ||
        !number(value.nextAttemptAt) || value.nextAttemptAt > value.expiresAt || !Array.isArray(value.effects) || value.effects.length > 5) throw failure()
    const createdAt = value.createdAt, updatedAt = value.updatedAt
    const seen = new Set<MediaOutboxEffect>()
    const rows = value.effects.map((input, index) => {
      const row = closed(input, ['effect', 'state', 'beganAt', 'finishedAt', 'receipt'])
      if (typeof row.effect !== 'string' || !effects.has(row.effect as MediaOutboxEffect) || seen.has(row.effect as MediaOutboxEffect) ||
          !number(row.beganAt) || row.beganAt < createdAt || row.beganAt > updatedAt) throw failure()
      seen.add(row.effect as MediaOutboxEffect)
      const effect = row.effect as MediaOutboxEffect
      if (row.state === 'pending') {
        if (row.finishedAt !== undefined || row.receipt !== undefined || value.state !== 'sending' || index !== (value.effects as unknown[]).length - 1) throw failure()
        return { effect, state: 'pending' as const, beganAt: row.beganAt }
      }
      const receipt = normalizedReceipt(row.receipt)
      if (!number(row.finishedAt) || row.finishedAt < row.beganAt || row.finishedAt > updatedAt || row.state !== receipt.state || JSON.stringify(receipt) !== JSON.stringify(row.receipt) ||
          row.state === 'unknown' && (value.state !== 'unknown' || index !== (value.effects as unknown[]).length - 1)) throw failure()
      return { effect, state: receipt.state, beganAt: row.beganAt, finishedAt: row.finishedAt, receipt }
    })
    if (rows.length && ['queued', 'preparing', 'cancelled'].includes(value.state) || value.state === 'sending' && !rows.length ||
        value.state === 'completed' && (rows.at(-1)?.state !== 'sent' || rows.some(row => row.state !== 'sent' && row.state !== 'failed')) ||
        value.state === 'failed' && rows.some(row => row.state === 'pending' || row.state === 'unknown')) throw failure()
    return freeze({ version: 1, id: value.id, sequence: value.sequence, source, binding, state: value.state as AgentMediaOutboxRecord['state'],
      createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt, prepareAttempts: value.prepareAttempts,
      prepareFailures: value.prepareFailures, nextAttemptAt: value.nextAttemptAt, effects: rows })
  } catch { throw failure() }
}

/** Read only the persisted evidence, including terminal jobs retained after leaving the active index.
 * The caller must authorize and revalidate every complete binding before exposing these observations. */
export function createAgentMediaOutboxReader(storage: AgentMediaOutboxReadStorage) {
  return Object.freeze({
    async read(options: { maxScanned?: number; limit?: number; signal?: AbortSignal; guard?: { ensureCurrent(): void } } = {}): Promise<{
      readonly records: readonly AgentMediaOutboxObservation[]
      readonly scanTruncated: boolean
    }> {
      const maxScanned = options.maxScanned ?? 1000, limit = options.limit ?? 1000
      if (![maxScanned, limit].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2000)) throw failure()
      let guardFailure: { error: unknown } | undefined
      const check = () => {
        try { options.signal?.throwIfAborted(); options.guard?.ensureCurrent() }
        catch (error) { guardFailure = { error }; throw error }
      }
      const seen = new Set<string>(), records: AgentMediaOutboxObservation[] = []
      let scanned = 0, batches = 0, scanTruncated = false
      check()
      try {
        for await (const batch of storage.scanIterator({ MATCH: `${PREFIX}job:*`, COUNT: 100 })) {
          check()
          // A sparse MATCH or repeated keys must not make one console request scan indefinitely.
          if (++batches > Math.min(maxScanned, 64)) { scanTruncated = true; break }
          const keys = Array.isArray(batch) ? batch : [batch]
          for (const key of keys) {
            check()
            if (++scanned > maxScanned) { scanTruncated = true; break }
            if (typeof key !== 'string' || !/^agent:media-outbox:v1:job:[a-f\d]{64}$/u.test(key) || seen.has(key)) continue
            seen.add(key)
            let raw: string | null
            try { raw = await storage.get(key) } catch { check(); throw failure() }
            check()
            if (raw === null) continue
            let record: AgentMediaOutboxRecord
            try { record = parse(raw) } catch { continue }
            if (recordKey(record.id) !== key) continue
            records.push(freeze({ id: record.id, binding: record.binding, provider: record.source.share.provider,
              state: record.state, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
              prepareAttempts: record.prepareAttempts, prepareFailures: record.prepareFailures, nextAttemptAt: record.nextAttemptAt,
              effects: record.effects.map(({ effect, state, beganAt, finishedAt }) => ({ effect, state, beganAt,
                ...(finishedAt === undefined ? {} : { finishedAt }) })) }))
          }
          if (scanTruncated) break
          check()
        }
      } catch (error) {
        if (guardFailure && guardFailure.error === error) throw error
        check()
        // Guard errors retain their owning console semantics; storage errors never expose backend details.
        throw failure()
      }
      check()
      records.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      return Object.freeze({ records: Object.freeze(records.slice(0, limit)), scanTruncated: scanTruncated || records.length > limit })
    },
  })
}
const preflight = `
local function requireTypes(expected)
  for i, wanted in ipairs(expected) do
    local actual = redis.call('TYPE', KEYS[i]).ok
    if actual ~= 'none' and actual ~= wanted then error('invalid media outbox key type') end
  end
end
local function requireInteger(raw, maximum)
  local value = tonumber(raw)
  if not value or value < 0 or value > maximum or value ~= math.floor(value) or raw ~= string.format('%.0f', value) then
    error('invalid media outbox integer')
  end
  return value
end
local function requireIndexes()
  local active = redis.call('HGETALL', KEYS[2])
  local lanes = redis.call('HGETALL', KEYS[3])
  if #active > 256 or #lanes > 256 then error('invalid media outbox index size') end
  local counts = {}
  for i = 1, #active, 2 do
    local id, lane = active[i], active[i + 1]
    if #id ~= 64 or not string.match(id, '^[a-f0-9]+$') or #lane ~= 64 or not string.match(lane, '^[a-f0-9]+$') then error('invalid media outbox index') end
    counts[lane] = (counts[lane] or 0) + 1
    if counts[lane] > 32 then error('invalid media outbox lane size') end
  end
  for i = 1, #lanes, 2 do
    local lane, raw = lanes[i], lanes[i + 1]
    local count = requireInteger(raw, 32)
    if count == 0 or counts[lane] ~= count then error('invalid media outbox lane count') end
    counts[lane] = nil
  end
  if next(counts) ~= nil then error('missing media outbox lane count') end
end
`
const removeActive = `
local oldLane = redis.call('HGET', KEYS[2], ARGV[3])
if oldLane then
  redis.call('HDEL', KEYS[2], ARGV[3])
  if redis.call('HINCRBY', KEYS[3], oldLane, -1) <= 0 then redis.call('HDEL', KEYS[3], oldLane) end
end`
const enqueueScript = `
${preflight}
requireTypes({'string', 'hash', 'hash', 'string', 'string', 'string'})
requireIndexes()
local admission = redis.call('GET', KEYS[6])
if admission and (#admission ~= 64 or not string.match(admission, '^[a-f0-9]+$')) then error('invalid media outbox admission') end
if admission or redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then return 'existing' end
local sequence = requireInteger(redis.call('GET', KEYS[4]) or '0', 9007199254740991)
if sequence >= 9007199254740991 then return redis.error_reply('media outbox sequence exhausted') end
local raw = ARGV[1] .. string.format('%.0f', sequence + 1) .. ARGV[2]
if #raw > 16384 then return redis.error_reply('media outbox record exceeds size limit') end
${removeActive}
if redis.call('HLEN', KEYS[2]) >= 128 or tonumber(redis.call('HGET', KEYS[3], ARGV[4]) or '0') >= 32 then return 'full' end
redis.call('INCR', KEYS[4])
redis.call('SET', KEYS[1], raw, 'EX', ARGV[5])
redis.call('SET', KEYS[6], ARGV[3], 'EX', ARGV[5])
redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
redis.call('HINCRBY', KEYS[3], ARGV[4], 1)
return 'created'`
const writeScript = `
${preflight}
requireTypes({'string', 'hash', 'hash', 'string', 'string'})
requireIndexes()
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[5] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[5] then return 0 end
if ARGV[8] ~= '1' and redis.call('EXISTS', KEYS[5]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[6])
if ARGV[7] == '1' then ${removeActive} end
if ARGV[7] == '1' or ARGV[9] == '1' then redis.call('DEL', KEYS[4]) end
return 1`
const claimScript = `
${preflight}
requireTypes({'string', 'string', 'string'})
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`
const releaseOwner = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`
const missingScript = `${preflight}
requireTypes({'string', 'hash', 'hash'})
requireIndexes()
if redis.call('EXISTS', KEYS[1]) == 0 then ${removeActive} end return 1`

/** Durable attempt evidence. The Core's live single-host execution lease is required for every mutation. */
export function createAgentMediaOutboxLedger(storage: AgentInboxRedis, options: { now?(): number } = {}) {
  let active = ownership.get(storage)
  if (!active) { active = new Map(); ownership.set(storage, active) }
  const owned = active, runId = randomUUID()
  const now = (minimum = 0) => {
    const value = (options.now ?? Date.now)()
    if (!number(value)) throw failure()
    return Math.max(minimum, value)
  }
  const validId = (id: string) => { if (typeof id !== 'string' || !/^[a-f\d]{64}$/u.test(id)) throw failure(); return id }
  async function load(id: string) {
    const raw = await storage.get(recordKey(validId(id)))
    return raw === null ? undefined : { raw, record: parse(raw) }
  }
  async function indexes(): Promise<readonly [string, string][]> {
    const raw = await storage.eval('return redis.call("HGETALL", KEYS[1])', { keys: [ACTIVE], arguments: [] })
    if (!Array.isArray(raw) || raw.length > 256 || raw.length % 2) throw failure()
    const rows: [string, string][] = []
    for (let at = 0; at < raw.length; at += 2) {
      if (typeof raw[at] !== 'string' || typeof raw[at + 1] !== 'string') throw failure()
      rows.push([validId(raw[at] as string), validId(raw[at + 1] as string)])
    }
    return rows
  }
  async function write(before: string, next: AgentMediaOutboxRecord, owner = '', allowCancelled = false, release = false) {
    const raw = serialize(next)
    const result = await storage.eval(writeScript, { keys: [recordKey(next.id), ACTIVE, LANES, ownerKey(next.id), cancelKey(next.binding.target, next.source.messageId)],
      arguments: [before, raw, next.id, laneFor(next.binding), owner, String(RETENTION), terminal.has(next.state) ? '1' : '0', allowCancelled ? '1' : '0', release ? '1' : '0'] })
    if (Number(result) !== 1) throw failure()
    return raw
  }
  function endRecord(record: AgentMediaOutboxRecord, state: AgentMediaOutboxRecord['state']): AgentMediaOutboxRecord {
    const at = now(record.updatedAt)
    return { ...record, state, updatedAt: at, effects: record.effects.map(row => row.state === 'pending'
      ? { ...row, state: 'unknown' as const, finishedAt: at, receipt: { state: 'unknown' as const } } : row) }
  }
  async function listActive(): Promise<readonly AgentMediaOutboxRecord[]> {
    const rows: AgentMediaOutboxRecord[] = []
    for (const [id, lane] of await indexes()) {
      const current = await load(id)
      if (!current) {
        await storage.eval(missingScript, { keys: [recordKey(id), ACTIVE, LANES], arguments: ['', '', id] }); continue
      }
      if (laneFor(current.record.binding) !== lane) throw failure()
      if (!terminal.has(current.record.state)) rows.push(current.record)
      else await write(current.raw, current.record, '', true, true)
    }
    return Object.freeze(rows.sort((left, right) => left.sequence - right.sequence))
  }
  async function recover(): Promise<void> {
    for (const record of await listActive()) {
      if (owned.has(record.id)) continue
      const current = await load(record.id)
      if (!current || owned.has(record.id) || terminal.has(current.record.state)) continue
      const row = current.record, expired = now() >= row.expiresAt
      let next: AgentMediaOutboxRecord | undefined
      if (row.effects.length || row.state === 'sending') next = endRecord(row, 'unknown')
      else if (expired || await storage.get(cancelKey(row.binding.target, row.source.messageId)) !== null) next = endRecord(row, 'cancelled')
      else if (row.state === 'preparing') next = { ...row, state: 'queued', updatedAt: now(row.updatedAt), nextAttemptAt: 0 }
      if (owned.has(record.id)) continue
      if (next) { try { await write(current.raw, next, '', true, true) } catch { if ((await load(record.id))?.raw === current.raw) throw failure() } }
      else {
        const owner = await storage.get(ownerKey(row.id))
        if (owner && !owned.has(row.id)) await storage.eval(releaseOwner, { keys: [ownerKey(row.id)], arguments: [owner] })
      }
    }
  }
  const api = {
    async enqueue(input: { readonly source: AgentMediaOutboxSource; readonly binding: AgentBindingSnapshot }): Promise<'created' | 'existing' | 'full'> {
      try {
        const value = closed(input, ['source', 'binding']), binding = bindingSnapshot(value.binding), source = sourceSnapshot(value.source, binding)
        await recover()
        const at = now(), id = agentMediaOutboxId(binding, source.messageId)
        if (at > Number.MAX_SAFE_INTEGER - LIFETIME) throw failure()
        const record: AgentMediaOutboxRecord = { version: 1, id, sequence: 0, source, binding, state: 'queued', createdAt: at, updatedAt: at,
          expiresAt: at + LIFETIME, prepareAttempts: 0, prepareFailures: 0, nextAttemptAt: 0, effects: [] }
        const raw = serialize(record), marker = '"sequence":0', position = raw.indexOf(marker) + marker.length - 1
        const result = await storage.eval(enqueueScript, { keys: [recordKey(id), ACTIVE, LANES, SEQUENCE, cancelKey(binding.target, source.messageId), admissionKey(binding.target, source.messageId)],
          arguments: [raw.slice(0, position), raw.slice(position + 1), id, laneFor(binding), String(RETENTION)] })
        if (!['created', 'existing', 'full'].includes(result as string)) throw failure()
        return result as 'created' | 'existing' | 'full'
      } catch { throw failure() }
    },
    async listActive() { try { return await listActive() } catch { throw failure() } },
    async inspect(id: string): Promise<AgentMediaOutboxRecord | undefined> { try { return (await load(id))?.record } catch { throw failure() } },
    async recover() { try { await recover() } catch { throw failure() } },
    async cancelSource(input: ConversationAddress, messageId: string): Promise<void> {
      try {
        const selected = target(input), scope = agentMediaSourceScopeKey(selected)
        if (!safeText(messageId) || /^0+$/u.test(messageId)) throw failure()
        if (await storage.eval(`${preflight}\nrequireTypes({'string'})\nreturn redis.call("SET", KEYS[1], "1", "EX", ARGV[1])`, { keys: [cancelKey(selected, messageId)], arguments: [String(RETENTION)] }) !== 'OK') throw failure()
        for (const original of await listActive()) {
          if (original.source.messageId !== messageId || agentMediaSourceScopeKey(original.binding.target) !== scope) continue
          for (let attempt = 0; attempt < 8; attempt++) {
            const current = await load(original.id)
            if (!current || terminal.has(current.record.state)) break
            const next = endRecord(current.record, current.record.effects.length ? 'unknown' : 'cancelled')
            try { await write(current.raw, next, '', true, true); owned.delete(original.id); break }
            catch { if (attempt === 7) throw failure() }
          }
        }
      } catch { throw failure() }
    },
    async claim(id: string): Promise<AgentMediaOutboxSession | undefined> {
      validId(id)
      if (owned.has(id)) return undefined
      const token = `${runId}:${randomUUID()}`; owned.set(id, token)
      let held = true, busy = false, record: AgentMediaOutboxRecord, raw: string
      const abandon = () => {
        if (!held) return
        held = false; if (owned.get(id) === token) owned.delete(id)
        void storage.eval(releaseOwner, { keys: [ownerKey(id)], arguments: [token] }).catch(() => {})
      }
      try {
        const current = await load(id)
        if (!current || current.record.state !== 'queued' || now() >= current.record.expiresAt || now() < current.record.nextAttemptAt) { abandon(); return undefined }
        record = current.record; raw = current.raw
        const claimed = await storage.eval(claimScript, { keys: [recordKey(id), ownerKey(id), cancelKey(record.binding.target, record.source.messageId)], arguments: [raw, token, String(RETENTION)] })
        if (Number(claimed) !== 1) { abandon(); return undefined }
      } catch { abandon(); throw failure() }
      async function mutate(change: () => AgentMediaOutboxRecord, release = false) {
        if (!held || busy || owned.get(id) !== token || terminal.has(record.state)) throw failure()
        let next: AgentMediaOutboxRecord
        try { next = change(); serialize(next) } catch { throw failure() }
        busy = true
        try {
          raw = await write(raw, next, token, false, release); record = parse(raw)
          if (!held || owned.get(id) !== token) throw failure()
          if (release || terminal.has(record.state)) abandon()
        } catch { abandon(); throw failure() }
        finally { busy = false }
      }
      return {
        get record() { return record }, abandon,
        async preparing() { await mutate(() => {
          const at = now(record.updatedAt)
          if (record.state !== 'queued' || record.effects.length || record.prepareAttempts >= 1024 || record.prepareFailures >= 3 || at >= record.expiresAt || at < record.nextAttemptAt) throw failure()
          return { ...record, state: 'preparing', prepareAttempts: record.prepareAttempts + 1, updatedAt: at, nextAttemptAt: 0 }
        }) },
        async begin(effect: MediaOutboxEffect) { await mutate(() => {
          const at = now(record.updatedAt)
          if (!effects.has(effect) || !['preparing', 'sending'].includes(record.state) || at >= record.expiresAt || record.effects.some(row => row.effect === effect || row.state === 'pending' || row.state === 'unknown')) throw failure()
          return { ...record, state: 'sending', updatedAt: at, effects: [...record.effects, { effect, state: 'pending', beganAt: at }] }
        }) },
        async finish(effect: MediaOutboxEffect, input: DeliveryReceipt) { await mutate(() => {
          const pending = record.effects.at(-1)
          if (!effects.has(effect) || pending?.effect !== effect || pending.state !== 'pending' || record.state !== 'sending') throw failure()
          const receipt = normalizedReceipt(input), at = now(record.updatedAt)
          return { ...record, state: receipt.state === 'unknown' ? 'unknown' : 'sending', updatedAt: at,
            effects: [...record.effects.slice(0, -1), { ...pending, state: receipt.state, finishedAt: at, receipt }] }
        }) },
        async retry(nextAttemptAt: number, failed = true) { await mutate(() => {
          const at = now(record.updatedAt), failures = record.prepareFailures + (failed ? 1 : 0)
          if (record.effects.length || record.state !== 'preparing' || typeof failed !== 'boolean' || failures > 3 ||
              !number(nextAttemptAt) || nextAttemptAt < at || nextAttemptAt > record.expiresAt || at >= record.expiresAt) throw failure()
          return { ...record, state: 'queued', updatedAt: at, nextAttemptAt, prepareFailures: failures }
        }, true) },
        async close(state: 'completed' | 'failed' | 'cancelled' | 'unknown') { await mutate(() => {
          if (!terminal.has(state)) throw failure()
          const selected = state === 'cancelled' && record.effects.length ? 'unknown' : state
          if (selected !== 'unknown' && record.effects.some(row => row.state === 'pending' || row.state === 'unknown') || selected === 'completed' && record.effects.at(-1)?.state !== 'sent') throw failure()
          return endRecord(record, selected)
        }, true) },
      }
    },
  }
  return Object.freeze(api)
}
