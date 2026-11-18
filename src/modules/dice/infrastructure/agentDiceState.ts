import { createHash, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import { agentBindingIdentity, agentBindingToken, agentConversationKey, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { scrubAgentDicePrivateSource, scrubAgentDicePrivateSubject } from './agentDicePrivateDelivery.js'

export type AgentDiceStateJson = null | boolean | number | string | readonly AgentDiceStateJson[] | { readonly [key: string]: AgentDiceStateJson }
export interface AgentDiceStateSource {
  readonly messageId: string
  /** Scoped to the binding account's platform and namespace, never a replacement actor. */
  readonly authorId: string
  readonly sourceHash: string
  readonly occurredAt: number
}
export interface AgentDiceStateSnapshot {
  readonly version: 1
  readonly ownerHash: string
  readonly revision: number
  readonly source: AgentDiceStateSource
  readonly state: AgentDiceStateJson
}
export interface AgentDiceStateClaim {
  readonly id: string
  readonly ownerHash: string
  readonly bindingHash: string
  readonly token: string
  readonly seed: string
  readonly revision: number
  readonly source: AgentDiceStateSource
  readonly snapshotRaw: string | null
}
export type AgentDiceEffectReceipt = { readonly state: 'sent'; readonly messageId: string } |
  { readonly state: 'confirmed' | 'failed' | 'unknown' }
export interface AgentDiceStatePrivateDelivery {
  readonly packId: string
  readonly deliveryId: string
  readonly originMessageId: string
  readonly index: number
}
export interface AgentDiceStateDeliveryRef {
  readonly packId: string
  readonly deliveryId: string
  readonly originId: string
  readonly index: number
}
export interface AgentDiceStateDeliveryIndex extends AgentDiceStateDeliveryRef {
  readonly ownerHash: string
  readonly operationId: string
  readonly state: 'unknown' | 'failed' | 'sent'
}
export interface AgentDiceStateOperation {
  readonly version: 1
  readonly id: string
  readonly ownerHash: string
  readonly bindingHash: string
  readonly source: AgentDiceStateSource
  readonly state: 'preparing' | 'ready' | 'pending' | 'confirmed' | 'failed' | 'unknown'
  readonly baseRevision: number
  readonly committedRevision?: number
  readonly requested: number
  readonly completed: number
  readonly seed?: string
  readonly token?: string
  readonly effects?: readonly AgentDiceStateJson[]
  /** Only the engine supplies these audit facts; this store never invents native messages. */
  readonly event?: AgentDiceStateJson
  readonly receipts?: readonly AgentDiceEffectReceipt[]
  readonly deliveryRefs?: readonly AgentDiceStateDeliveryRef[]
  readonly privacy?: { readonly globalId: string; readonly sceneId: string; readonly globalEpoch: number; readonly sceneEpoch: number }
}
export interface AgentDiceStateGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent?(): Promise<void>
}
export interface AgentDiceStateRedis {
  get(key: string): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export type AgentDiceStateBegin = { readonly kind: 'started'; readonly claim: AgentDiceStateClaim; readonly snapshot: AgentDiceStateSnapshot | null } |
  { readonly kind: 'existing'; readonly operation: AgentDiceStateOperation }

const ROOT = 'agent:dice:engine:v1'
const MAX_BYTES = 1024 * 1024
const MAX_EFFECTS = 128
const SNAPSHOT_RAW = new WeakMap<object, string>()
const invalid = () => new Error('骰子业务持久状态不可用')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const seedValue = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const positiveTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime())
const messageId = (value: unknown): value is string => isPlatformIdentifier(value) && value !== '0'
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const deliveryIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)

/** Own data only: inspecting caller input must never execute a getter, proxy or toJSON. */
function copyJson(input: unknown, seen = new Set<object>(), depth = 0): AgentDiceStateJson {
  if (depth > 32) throw invalid()
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (!input || typeof input !== 'object' || types.isProxy(input) || seen.has(input)) throw invalid()
  const array = Array.isArray(input), prototype = Object.getPrototypeOf(input)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw invalid()
  const keys = Reflect.ownKeys(input)
  if (keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw invalid()
  seen.add(input)
  try {
    if (array) {
      if (input.length > 4096 || keys.length !== input.length + 1) throw invalid()
      const values: AgentDiceStateJson[] = []
      for (let index = 0; index < input.length; index++) {
        const field = Object.getOwnPropertyDescriptor(input, String(index))
        if (!field || !('value' in field) || !field.enumerable) throw invalid()
        values.push(copyJson(field.value, seen, depth + 1))
      }
      return Object.freeze(values)
    }
    if (keys.length > 4096) throw invalid()
    const value: Record<string, AgentDiceStateJson> = {}
    for (const key of keys as string[]) {
      const field = Object.getOwnPropertyDescriptor(input, key)
      if (!field || !('value' in field) || !field.enumerable) throw invalid()
      value[key] = copyJson(field.value, seen, depth + 1)
    }
    return Object.freeze(value)
  } finally { seen.delete(input) }
}
function serialize(value: unknown): string {
  const raw = JSON.stringify(copyJson(value))
  if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid()
  return raw
}
function object(input: AgentDiceStateJson, fields: readonly string[]): Record<string, AgentDiceStateJson> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw invalid()
  return input as Record<string, AgentDiceStateJson>
}
function parse(raw: unknown): AgentDiceStateJson {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw invalid()
  try { return copyJson(JSON.parse(raw)) } catch { throw invalid() }
}
function readSource(input: unknown): AgentDiceStateSource {
  const value = object(copyJson(input), ['messageId', 'authorId', 'sourceHash', 'occurredAt'])
  if (!messageId(value.messageId) || !isPlatformIdentifier(value.authorId) || !digest(value.sourceHash) || !positiveTime(value.occurredAt)) throw invalid()
  return value as unknown as AgentDiceStateSource
}
function owner(input: AgentBindingSnapshot) {
  const value = object(copyJson(input), ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  const internal = (entry: unknown) => typeof entry === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(entry)
  const label = (entry: unknown) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && entry === entry.trim() && !/[\u0000-\u001f\u007f]/u.test(entry)
  const binding = value as unknown as AgentBindingSnapshot
  if (binding.source !== 'configured' || !label(binding.id) || !label(binding.revision) || !internal(binding.agentId) ||
      !internal(binding.connectionId) || !isPlatformIdentifier(binding.personaId) || !isConversationAddress(binding.target)) throw invalid()
  object(value.target!, ['account', 'kind', 'id'])
  object((value.target as Record<string, AgentDiceStateJson>).account!, ['platform', 'namespace', 'id'])
  return { binding, ownerHash: hash([agentBindingIdentity(binding), agentConversationKey(binding)]),
    bindingHash: hash([agentBindingToken(binding), conversationAddressKey(binding.target)]) }
}
function operationId(binding: AgentBindingSnapshot, id: string) { return hash([conversationAddressKey(binding.target), id]) }
function deliveryKey(ownerHash: string, packId: string, deliveryId: string) { return `${ROOT}:delivery:${hash([ownerHash, packId, deliveryId])}` }
function privacyScope(binding: AgentBindingSnapshot) {
  return { globalId: hash([platformAccountKey(binding.target.account), binding.agentId]), sceneId: hash([conversationAddressKey(binding.target), binding.agentId]) }
}
function subjectScope(binding: AgentBindingSnapshot, id: string) {
  return { globalId: hash([platformAccountKey(binding.target.account), binding.agentId, id]), sceneId: hash([conversationAddressKey(binding.target), binding.agentId, id]) }
}
function readSnapshot(raw: unknown, expectedOwner: string): AgentDiceStateSnapshot | null {
  if (raw === null || raw === undefined) return null
  const row = object(parse(raw), ['version', 'ownerHash', 'revision', 'source', 'state'])
  if (row.version !== 1 || row.ownerHash !== expectedOwner || !integer(row.revision) || row.revision < 1 || !Object.hasOwn(row, 'state')) throw invalid()
  readSource(row.source)
  SNAPSHOT_RAW.set(row, raw as string)
  return row as unknown as AgentDiceStateSnapshot
}
function readDeliveryRef(input: unknown, requested: number): AgentDiceStateDeliveryRef {
  const row = object(copyJson(input), ['packId', 'deliveryId', 'originId', 'index'])
  if (!deliveryIdentifier(row.packId) || !deliveryIdentifier(row.deliveryId) || !digest(row.originId) || !integer(row.index) || row.index >= requested) throw invalid()
  return row as unknown as AgentDiceStateDeliveryRef
}
function readDeliveryIndex(raw: unknown, expectedOwner: string, packId: string, deliveryId: string): AgentDiceStateDeliveryIndex | undefined {
  if (raw === null || raw === undefined) return undefined
  const row = object(parse(raw), ['ownerHash', 'packId', 'deliveryId', 'originId', 'operationId', 'index', 'state'])
  if (row.ownerHash !== expectedOwner || row.packId !== packId || row.deliveryId !== deliveryId || !digest(row.originId) || !digest(row.operationId) ||
      !integer(row.index) || row.index >= MAX_EFFECTS || !['unknown', 'failed', 'sent'].includes(row.state as string)) throw invalid()
  return row as unknown as AgentDiceStateDeliveryIndex
}
function receipt(input: unknown): AgentDiceEffectReceipt {
  try {
    const row = object(copyJson(input), ['state', 'messageId'])
    if (row.state === 'sent' && messageId(row.messageId)) return Object.freeze({ state: 'sent', messageId: row.messageId })
    if (typeof row.state === 'string' && ['confirmed', 'failed', 'unknown'].includes(row.state) && !Object.hasOwn(row, 'messageId')) return Object.freeze({ state: row.state as 'confirmed' | 'failed' | 'unknown' })
  } catch { /* An ambiguous receipt must freeze a dispatched effect. */ }
  return Object.freeze({ state: 'unknown' })
}
function readOperation(raw: unknown): AgentDiceStateOperation {
  const row = object(parse(raw), ['version', 'id', 'ownerHash', 'bindingHash', 'source', 'state', 'baseRevision', 'committedRevision',
    'requested', 'completed', 'seed', 'token', 'effects', 'event', 'receipts', 'deliveryRefs', 'privacy'])
  if (row.version !== 1 || !digest(row.id) || !digest(row.ownerHash) || !digest(row.bindingHash) ||
      typeof row.state !== 'string' || !['preparing', 'ready', 'pending', 'confirmed', 'failed', 'unknown'].includes(row.state) ||
      !integer(row.baseRevision) || !integer(row.requested) || row.requested > MAX_EFFECTS ||
      !integer(row.completed) || row.completed > row.requested) throw invalid()
  readSource(row.source)
  if (row.privacy !== undefined) {
    const privacy = object(row.privacy, ['globalId', 'sceneId', 'globalEpoch', 'sceneEpoch'])
    if (!digest(privacy.globalId) || !digest(privacy.sceneId) || !integer(privacy.globalEpoch) || !integer(privacy.sceneEpoch)) throw invalid()
  }
  if (row.committedRevision !== undefined && (!integer(row.committedRevision) || row.committedRevision < row.baseRevision + 1)) throw invalid()
  if (row.deliveryRefs !== undefined) {
    if (!Array.isArray(row.deliveryRefs) || row.deliveryRefs.length > row.requested) throw invalid()
    const refs = row.deliveryRefs.map(value => readDeliveryRef(value, row.requested as number))
    if (new Set(refs.map(ref => ref.index)).size !== refs.length || new Set(refs.map(ref => `${ref.packId}\u0000${ref.deliveryId}`)).size !== refs.length) throw invalid()
  }
  if (row.state === 'preparing') {
    if (!seedValue(row.seed) || !seedValue(row.token) || row.requested !== 0 || row.completed !== 0 ||
        ['effects', 'event', 'receipts', 'committedRevision', 'deliveryRefs'].some(key => Object.hasOwn(row, key))) throw invalid()
  } else {
    if (Object.hasOwn(row, 'seed') || Object.hasOwn(row, 'token')) throw invalid()
    if (row.state === 'ready' || row.state === 'pending') {
      if (!Array.isArray(row.effects) || row.effects.length !== row.requested || row.completed >= row.requested ||
          row.committedRevision === undefined || row.effects.slice(0, row.completed).some(value => value !== null)) throw invalid()
    } else if (Object.hasOwn(row, 'effects') || row.state === 'confirmed' && row.completed !== row.requested) throw invalid()
    if (row.receipts !== undefined && (!Array.isArray(row.receipts) || row.receipts.length > row.requested || row.receipts.some(value => serialize(receipt(value)) !== serialize(value)))) throw invalid()
  }
  return row as unknown as AgentDiceStateOperation
}
function matches(row: AgentDiceStateOperation, selected: ReturnType<typeof owner>, source: AgentDiceStateSource) {
  if (row.id !== operationId(selected.binding, source.messageId) || row.ownerHash !== selected.ownerHash || row.bindingHash !== selected.bindingHash ||
      row.source.messageId !== source.messageId || row.source.authorId !== source.authorId || row.source.sourceHash !== source.sourceHash || row.source.occurredAt !== source.occurredAt) throw invalid()
}
function terminal(row: AgentDiceStateOperation, state: 'confirmed' | 'failed' | 'unknown'): AgentDiceStateOperation {
  const { seed: _seed, token: _token, effects: _effects, ...values } = row
  return Object.freeze({ ...values, state })
}
function refsFor(row: AgentDiceStateOperation) {
  return (row.deliveryRefs ?? []).map(ref => ({ ...ref, key: deliveryKey(row.ownerHash, ref.packId, ref.deliveryId).slice(ROOT.length) }))
}
function nextReceipt(row: AgentDiceStateOperation, index: number, result: unknown) {
  const rawReceipt = receipt(result)
  const settled: AgentDiceEffectReceipt = row.deliveryRefs?.some(ref => ref.index === index) && rawReceipt.state === 'confirmed' ? { state: 'unknown' } : rawReceipt
  const receipts = [...(row.receipts ?? []), settled]
  const completed = index + 1
  const next: AgentDiceStateOperation = settled.state === 'unknown' || settled.state === 'failed' ? terminal({ ...row, receipts }, settled.state) :
    completed === row.requested ? terminal({ ...row, completed, receipts }, 'confirmed') :
      { ...row, completed, receipts, state: 'ready', effects: row.effects!.map((value, at) => at < completed ? null : value) }
  return { next, deliveryState: settled.state === 'sent' ? 'sent' : settled.state === 'failed' ? 'failed' : 'unknown' }
}
async function ensure(guard?: AgentDiceStateGuard) {
  const current = () => { try { return !guard || !guard.signal.aborted && guard.isCurrent() } catch { return false } }
  if (!current()) throw invalid()
  await guard?.ensureCurrent?.()
  if (!current()) throw invalid()
}
async function bounded<T>(promise: Promise<T>, guard?: AgentDiceStateGuard): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(invalid())
      timer = setTimeout(abort, 5_000)
      guard?.signal.addEventListener('abort', abort, { once: true })
      if (guard?.signal.aborted) abort()
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) guard?.signal.removeEventListener('abort', abort)
  }
}
const COMMON = `
local root = KEYS[1]
local operation = root .. ':operation:' .. ARGV[1]
local state = root .. ':state:' .. ARGV[2]
local recall = root .. ':recalled:' .. ARGV[1]
local function owns(ref, row)
  return type(row) == 'table' and row.ownerHash == ARGV[2] and row.operationId == ARGV[1]
    and row.packId == ref.packId and row.deliveryId == ref.deliveryId and row.originId == ref.originId and row.index == ref.index
end
local function unknown_indexes(refs, unfinished)
  for _, ref in ipairs(refs) do
    local raw = redis.call('GET', root .. ref.key)
    if raw then
      local ok, row = pcall(cjson.decode, raw)
      if ok and owns(ref, row) and (not unfinished or row.state == 'unknown') then
        row.state = 'unknown'
        redis.call('SET', root .. ref.key, cjson.encode(row))
      end
    end
  end
end
local function seal(raw, refs, unfinished)
  local ok, row = pcall(cjson.decode, raw)
  if ok and type(row) == 'table' then
    row.state = 'unknown'; row.effects = nil; row.event = nil; row.receipts = nil; row.seed = nil; row.token = nil
    redis.call('SET', operation, cjson.encode(row))
  end
  unknown_indexes(refs, unfinished)
end
local function current_refs(refs)
  for _, ref in ipairs(refs) do
    if redis.call('EXISTS', root .. ':recalled:' .. ref.originId) == 1 then return false end
    local raw = redis.call('GET', root .. ref.key)
    if not raw then return false end
    local ok, row = pcall(cjson.decode, raw)
    if not ok or not owns(ref, row) then return false end
  end
  return true
end
local function privacy_current(row)
  if not row.privacy then return true end
  return tonumber(redis.call('GET', root .. ':privacy:global:' .. row.privacy.globalId) or '0') == row.privacy.globalEpoch
    and tonumber(redis.call('GET', root .. ':privacy:scene:' .. row.privacy.sceneId) or '0') == row.privacy.sceneEpoch
end
local function register_subjects(subjects, origins)
  for _, subject in ipairs(subjects) do
    for _, selected in ipairs({{'global', subject.globalId}, {'scene', subject.sceneId}}) do
      local key = root .. ':subject:' .. selected[1] .. ':' .. selected[2]
      redis.call('SADD', key .. ':operations', ARGV[1]); redis.call('SADD', key .. ':owners', ARGV[2])
      redis.call('SADD', key .. ':origins', ARGV[1])
      for _, origin in ipairs(origins) do redis.call('SADD', key .. ':origins', origin) end
    end
  end
end
`
const BEGIN = COMMON + `
if redis.call('EXISTS', recall) == 1 then return {'revoked'} end
local previous = redis.call('GET', operation)
if previous then return {'existing', previous} end
local snapshot = redis.call('GET', state)
local revision = 0
if snapshot then
  local ok, row = pcall(cjson.decode, snapshot)
  if not ok or type(row) ~= 'table' or row.version ~= 1 or row.ownerHash ~= ARGV[2]
    or type(row.revision) ~= 'number' or row.revision < 1 or row.revision % 1 ~= 0 then return {'invalid'} end
  revision = row.revision
end
local row = cjson.decode(ARGV[3])
row.baseRevision = revision
row.privacy = cjson.decode(ARGV[4])
row.privacy.globalEpoch = tonumber(redis.call('GET', root .. ':privacy:global:' .. row.privacy.globalId) or '0')
row.privacy.sceneEpoch = tonumber(redis.call('GET', root .. ':privacy:scene:' .. row.privacy.sceneId) or '0')
local raw = cjson.encode(row)
redis.call('SET', operation, raw)
redis.call('SADD', root .. ':origin:' .. ARGV[1] .. ':owners', ARGV[2])
redis.call('SADD', root .. ':origin:' .. ARGV[1] .. ':operations', ARGV[1])
register_subjects(cjson.decode(ARGV[5]), {})
return {'started', raw, snapshot or ''}
`
const COMMIT = COMMON + `
if redis.call('EXISTS', recall) == 1 or redis.call('GET', operation) ~= ARGV[3] then return 0 end
local refs = cjson.decode(ARGV[8])
if not privacy_current(cjson.decode(ARGV[3])) then seal(ARGV[3], refs, false); return 0 end
for _, ref in ipairs(refs) do
  if redis.call('EXISTS', root .. ':recalled:' .. ref.originId) == 1 then redis.call('SET', operation, ARGV[7]); return 0 end
  local previous = redis.call('GET', root .. ref.key)
  if ref.originId == ARGV[1] then
    if previous then redis.call('SET', operation, ARGV[7]); return 0 end
  else
    if not previous then redis.call('SET', operation, ARGV[7]); return 0 end
    local ok, row = pcall(cjson.decode, previous)
    if not ok or type(row) ~= 'table' or row.ownerHash ~= ARGV[2] or row.originId ~= ref.originId
      or row.packId ~= ref.packId or row.deliveryId ~= ref.deliveryId or row.state ~= 'failed' then
      redis.call('SET', operation, ARGV[7]); return 0
    end
  end
end
local expected = ARGV[4]
local previous = redis.call('GET', state) or ''
if previous ~= expected then
  redis.call('SET', operation, ARGV[7])
  return 0
end
redis.call('SET', state, ARGV[5])
redis.call('SET', operation, ARGV[6])
redis.call('SADD', root .. ':origin:' .. ARGV[1] .. ':owners', ARGV[2])
redis.call('SADD', root .. ':origin:' .. ARGV[1] .. ':operations', ARGV[1])
for _, ref in ipairs(refs) do
  redis.call('SET', root .. ref.key, ref.raw)
  redis.call('SADD', operation .. ':deliveries', root .. ref.key)
  redis.call('SADD', root .. ':origin:' .. ref.originId .. ':owners', ARGV[2])
  redis.call('SADD', root .. ':origin:' .. ref.originId .. ':operations', ARGV[1])
end
local origins = {}
for _, ref in ipairs(refs) do table.insert(origins, ref.originId) end
register_subjects(cjson.decode(ARGV[9]), origins)
return 1
`
const CHANGE = COMMON + `
if redis.call('EXISTS', recall) == 1 or redis.call('GET', operation) ~= ARGV[3] then return 0 end
local refs = cjson.decode(ARGV[5])
if not current_refs(refs) or not privacy_current(cjson.decode(ARGV[3])) then seal(ARGV[3], refs, false); return 0 end
if ARGV[8] == 'abandon' then seal(ARGV[3], refs, true); return 2 end
for _, ref in ipairs(refs) do
  if tostring(ref.index) == ARGV[6] then
    local row = cjson.decode(redis.call('GET', root .. ref.key))
    if row.state ~= 'unknown' then seal(ARGV[3], refs, false); return 0 end
    if ARGV[7] ~= '' then row.state = ARGV[7]; redis.call('SET', root .. ref.key, cjson.encode(row)) end
  end
end
redis.call('SET', operation, ARGV[4])
return 1
`
const SETTLE_STATE = COMMON + `
if redis.call('EXISTS', recall) == 1 or redis.call('GET', operation) ~= ARGV[3] then return 0 end
local refs = cjson.decode(ARGV[7])
local pending = cjson.decode(ARGV[3])
if pending.state ~= 'pending' or tostring(pending.completed) ~= ARGV[8] then return 0 end
if not current_refs(refs) or not privacy_current(pending) or (redis.call('GET', state) or '') ~= ARGV[4] then seal(ARGV[3], refs, false); return 0 end
for _, ref in ipairs(refs) do
  if tostring(ref.index) == ARGV[8] then
    local row = cjson.decode(redis.call('GET', root .. ref.key))
    if row.state ~= 'unknown' then seal(ARGV[3], refs, false); return 0 end
  end
end
redis.call('SET', state, ARGV[5])
redis.call('SET', operation, ARGV[6])
for _, ref in ipairs(refs) do
  if tostring(ref.index) == ARGV[8] then
    local row = cjson.decode(redis.call('GET', root .. ref.key)); row.state = ARGV[9]
    redis.call('SET', root .. ref.key, cjson.encode(row))
  end
end
return 1
`
const REVOKE_BODY = `
local count, at = 0, 1
local function add_owner(id)
  if type(id) == 'string' and not owners[id] then owners[id] = true; table.insert(ownerList, id) end
end
for _, id in ipairs(initialOwners) do add_owner(id) end
while at <= #queue do
  local id = queue[at]; at = at + 1
  if not seen[id] then
    seen[id] = true
    redis.call('SET', root .. ':recalled:' .. id, '1')
    for _, selected in ipairs(redis.call('SMEMBERS', root .. ':origin:' .. id .. ':owners')) do add_owner(selected) end
    for _, related in ipairs(redis.call('SMEMBERS', root .. ':origin:' .. id .. ':operations')) do
      if not seen[related] then table.insert(queue, related) end
    end
    local key = root .. ':operation:' .. id
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' then
      count = count + 1
      local raw = kind == 'string' and redis.call('GET', key) or ''
      local ok, row = pcall(cjson.decode, raw)
      if ok and type(row) == 'table' then
        add_owner(row.ownerHash)
        if type(row.source) == 'table' and type(row.source.messageId) == 'string' then
          table.insert(sources, {messageId=row.source.messageId,operationId=id})
        end
        row.state='unknown'; row.effects=nil; row.event=nil; row.receipts=nil; row.seed=nil; row.token=nil
        redis.call('SET', key, cjson.encode(row))
      else redis.call('SET', key, '{"version":1,"state":"unknown"}') end
      for _, delivery in ipairs(redis.call('SMEMBERS', key .. ':deliveries')) do
        local value = redis.call('GET', delivery)
        if value then
          local valid, item = pcall(cjson.decode, value)
          if valid and type(item) == 'table' and item.operationId == id then
            item.state='unknown'; redis.call('SET', delivery, cjson.encode(item))
          end
        end
      end
    end
  end
end
return {tostring(count), ownerList, cjson.encode(sources)}
`
const REVOKE = `
local root, origin, message = KEYS[1], ARGV[1], ARGV[2]
local queue, seen, owners, ownerList, sources, initialOwners = {origin}, {}, {}, {}, {{messageId=message,operationId=origin}}, {}
` + REVOKE_BODY
const PURGE = `
local root, scope, id, privacy = KEYS[1], ARGV[1], ARGV[2], ARGV[3]
local subject = root .. ':subject:' .. scope .. ':' .. id
redis.call('INCR', root .. ':privacy:' .. scope .. ':' .. privacy)
redis.call('SET', root .. ':purged:' .. scope .. ':' .. id, '1')
local queue = redis.call('SMEMBERS', subject .. ':origins')
for _, operation in ipairs(redis.call('SMEMBERS', subject .. ':operations')) do table.insert(queue, operation) end
local seen, owners, ownerList, sources, initialOwners = {}, {}, {}, {}, redis.call('SMEMBERS', subject .. ':owners')
` + REVOKE_BODY
const SCRUB_STATE = `
local root = KEYS[1]
if redis.call('EXISTS', root .. ':' .. ARGV[1]) ~= 1 then return 0 end
local key = root .. ':state:' .. ARGV[2]
if redis.call('GET', key) ~= ARGV[3] then return 0 end
redis.call('SET', key, ARGV[4])
return 1
`
const SOURCE_EXISTS = `
local root, id = KEYS[1], ARGV[1]
return redis.call('EXISTS', root .. ':operation:' .. id, root .. ':origin:' .. id .. ':owners',
  root .. ':origin:' .. id .. ':operations', root .. ':recalled:' .. id)
`

/** Atomic business state plus a source fence; it never contacts a platform or reads legacy keys.
 * Only begin.started authorizes computation. Existing preparing/pending rows must be recovered to
 * unknown, never recomputed. Only claimEffect authorizes the next one-shot external attempt. */
export function createAgentDiceState(redis: AgentDiceStateRedis) {
  const evaluate = async (script: string, args: string[], guard?: AgentDiceStateGuard) => {
    try {
      await bounded(ensure(guard), guard)
      const result = await bounded(redis.eval(script, { keys: [ROOT], arguments: args }), guard)
      await bounded(ensure(guard), guard)
      return result
    } catch { throw invalid() }
  }
  const readRaw = async (key: string, guard?: AgentDiceStateGuard) => {
    try {
      await bounded(ensure(guard), guard)
      const raw = await bounded(redis.get(key), guard)
      await bounded(ensure(guard), guard)
      return raw
    } catch { throw invalid() }
  }
  const operation = async (selected: ReturnType<typeof owner>, source: AgentDiceStateSource, guard?: AgentDiceStateGuard) => {
    const raw = await readRaw(`${ROOT}:operation:${operationId(selected.binding, source.messageId)}`, guard)
    if (raw === null || raw === undefined) return undefined
    const row = readOperation(raw)
    matches(row, selected, source)
    return { row, raw: raw as string }
  }
  const scrubSealed = async (result: unknown, fence: string, guard?: AgentDiceStateGuard, subjectId?: string): Promise<number> => {
    if (!Array.isArray(result) || result.length !== 3 || !/^\d+$/u.test(String(result[0])) || !Array.isArray(result[1]) || !result[1].every(digest)) throw invalid()
    const sources = parse(result[2])
    if (!Array.isArray(sources) && !(sources && typeof sources === 'object' && Object.keys(sources).length === 0)) throw invalid()
    const selectedSources = (Array.isArray(sources) ? sources : []).map(value => {
      const row = object(value, ['messageId', 'operationId'])
      if (!messageId(row.messageId) || !digest(row.operationId)) throw invalid()
      return { messageId: row.messageId, operationId: row.operationId }
    })
    for (const selectedOwner of new Set(result[1] as string[])) {
      let complete = false
      for (let attempt = 0; attempt < 16; attempt++) {
        const raw = await readRaw(`${ROOT}:state:${selectedOwner}`, guard), snapshot = readSnapshot(raw, selectedOwner)
        if (!snapshot) { complete = true; break }
        let state: unknown = snapshot.state
        for (const source of selectedSources) state = scrubAgentDicePrivateSource(state, source)
        if (subjectId) state = scrubAgentDicePrivateSubject(state, { subjectId,
          originMessageIds: selectedSources.map(source => source.messageId), operationIds: selectedSources.map(source => source.operationId) })
        const nextState = copyJson(state)
        if (serialize(nextState) === serialize(snapshot.state)) { complete = true; break }
        if (snapshot.revision >= Number.MAX_SAFE_INTEGER) throw invalid()
        const changed = await evaluate(SCRUB_STATE, [fence, selectedOwner, raw as string, serialize({ ...snapshot, revision: snapshot.revision + 1, state: nextState })], guard)
        if (Number(changed) === 1) { complete = true; break }
      }
      if (!complete) throw invalid()
    }
    return Number(result[0])
  }
  const revokeTarget = async (input: ConversationAddress, id: string, guard?: AgentDiceStateGuard): Promise<number> => {
    const value = object(copyJson(input), ['account', 'kind', 'id']), target = value as unknown as ConversationAddress
    object(value.account!, ['platform', 'namespace', 'id'])
    if (!isConversationAddress(target) || !messageId(id)) throw invalid()
    const origin = hash([conversationAddressKey(target), id])
    return scrubSealed(await evaluate(REVOKE, [origin, id], guard), `recalled:${origin}`, guard)
  }
  return {
    async read(binding: AgentBindingSnapshot, guard?: AgentDiceStateGuard): Promise<AgentDiceStateSnapshot | null> {
      const selected = owner(binding)
      return readSnapshot(await readRaw(`${ROOT}:state:${selected.ownerHash}`, guard), selected.ownerHash)
    },
    async begin(binding: AgentBindingSnapshot, input: AgentDiceStateSource, guard?: AgentDiceStateGuard): Promise<AgentDiceStateBegin> {
      const selected = owner(binding), source = readSource(input), id = operationId(selected.binding, source.messageId)
      // The winning seed is durable before any game randomness is consumed. Losing concurrent
      // candidates never become game results; existing rows never expose a fresh computation claim.
      const candidate = { version: 1, id, ownerHash: selected.ownerHash, bindingHash: selected.bindingHash, source,
        state: 'preparing', baseRevision: 0, requested: 0, completed: 0, seed: randomBytes(16).toString('hex'), token: randomBytes(16).toString('hex') }
      const result = await evaluate(BEGIN, [id, selected.ownerHash, serialize(candidate), serialize(privacyScope(selected.binding)), serialize([subjectScope(selected.binding, source.authorId)])], guard)
      if (!Array.isArray(result) || result[0] !== 'started' && result[0] !== 'existing') throw invalid()
      const row = readOperation(result[1]); matches(row, selected, source)
      if (result[0] === 'existing') return Object.freeze({ kind: 'existing', operation: row })
      const snapshot = readSnapshot(result[2] === '' ? null : result[2], selected.ownerHash)
      if (row.state !== 'preparing' || row.seed !== candidate.seed || row.token !== candidate.token || (snapshot?.revision ?? 0) !== row.baseRevision) throw invalid()
      const claim: AgentDiceStateClaim = Object.freeze({ id, ownerHash: row.ownerHash, bindingHash: row.bindingHash, token: row.token!, seed: row.seed!,
        revision: row.baseRevision, source, snapshotRaw: typeof result[2] === 'string' && result[2] ? result[2] : null })
      return Object.freeze({ kind: 'started', claim, snapshot })
    },
    async commit(binding: AgentBindingSnapshot, input: AgentDiceStateClaim, payload: { readonly state: unknown; readonly effects: readonly unknown[]; readonly event: unknown;
      readonly privateDeliveries?: readonly AgentDiceStatePrivateDelivery[]; readonly subjectIds?: readonly string[] }, guard?: AgentDiceStateGuard): Promise<AgentDiceStateOperation | undefined> {
      const selected = owner(binding), claim = object(copyJson(input), ['id', 'ownerHash', 'bindingHash', 'token', 'seed', 'revision', 'source', 'snapshotRaw']) as unknown as AgentDiceStateClaim
      const source = readSource(claim.source)
      if (!digest(claim.id) || claim.id !== operationId(selected.binding, source.messageId) || claim.ownerHash !== selected.ownerHash || claim.bindingHash !== selected.bindingHash ||
          !seedValue(claim.token) || !seedValue(claim.seed) || !integer(claim.revision) || claim.revision >= Number.MAX_SAFE_INTEGER ||
          claim.snapshotRaw !== null && typeof claim.snapshotRaw !== 'string') throw invalid()
      const before = await operation(selected, source, guard)
      if (!before || before.row.state !== 'preparing' || before.row.seed !== claim.seed || before.row.token !== claim.token || before.row.baseRevision !== claim.revision) return undefined
      const data = object(copyJson(payload), ['state', 'effects', 'event', 'privateDeliveries', 'subjectIds'])
      if (!Object.hasOwn(data, 'state') || !Object.hasOwn(data, 'event') || !Array.isArray(data.effects) || data.effects.length > MAX_EFFECTS) throw invalid()
      const effectCount = data.effects.length
      if (data.privateDeliveries !== undefined && (!Array.isArray(data.privateDeliveries) || data.privateDeliveries.length > data.effects.length)) throw invalid()
      const deliveryRefs = ((data.privateDeliveries ?? []) as readonly AgentDiceStateJson[]).map(value => {
        const ref = object(value, ['packId', 'deliveryId', 'originMessageId', 'index'])
        if (!messageId(ref.originMessageId)) throw invalid()
        return readDeliveryRef({ packId: ref.packId, deliveryId: ref.deliveryId, originId: operationId(selected.binding, ref.originMessageId), index: ref.index }, effectCount)
      })
      if (new Set(deliveryRefs.map(ref => ref.index)).size !== deliveryRefs.length || new Set(deliveryRefs.map(ref => `${ref.packId}\u0000${ref.deliveryId}`)).size !== deliveryRefs.length) throw invalid()
      if (data.subjectIds !== undefined && (!Array.isArray(data.subjectIds) || !data.subjectIds.every(isPlatformIdentifier))) throw invalid()
      const subjects = new Set<string>([source.authorId, ...((data.subjectIds ?? []) as readonly string[])])
      const collect = (value: AgentDiceStateJson, depth = 0) => {
        if (depth > 8 || value === null || typeof value !== 'object') return
        if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return }
        for (const [key, item] of Object.entries(value)) {
          if (['subjectId', 'recipientId', 'actorId', 'authorId', 'userId', 'targetId'].includes(key) && isPlatformIdentifier(item)) subjects.add(item)
          if (['facts', 'source', 'actor', 'subject', 'target', 'recipient', 'targets', 'invoker'].includes(key)) {
            if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
              const actor = item as Record<string, AgentDiceStateJson>
              if (isPlatformIdentifier(actor.id) && actor.kind !== 'npc') subjects.add(actor.id)
            }
            collect(item, depth + 1)
          }
        }
      }
      collect(data.effects); collect(data.event!)
      for (const origin of new Set(deliveryRefs.map(ref => ref.originId))) {
        if (origin === claim.id) continue
        const raw = await readRaw(`${ROOT}:operation:${origin}`, guard)
        if (raw !== null && raw !== undefined) subjects.add(readOperation(raw).source.authorId)
      }
      const snapshot: AgentDiceStateSnapshot = Object.freeze({ version: 1, ownerHash: selected.ownerHash, revision: claim.revision + 1, source, state: data.state! })
      const row: AgentDiceStateOperation = Object.freeze({ version: 1, id: claim.id, ownerHash: selected.ownerHash, bindingHash: selected.bindingHash, source,
        state: data.effects.length ? 'ready' : 'confirmed', baseRevision: claim.revision, committedRevision: snapshot.revision,
        requested: data.effects.length, completed: 0, ...(data.effects.length ? { effects: data.effects } : {}), event: data.event!, receipts: [], ...(deliveryRefs.length ? { deliveryRefs } : {}),
        ...(before.row.privacy ? { privacy: before.row.privacy } : {}) })
      const raw = serialize(row); readOperation(raw)
      const indexes = deliveryRefs.map(ref => ({ ...ref, key: deliveryKey(selected.ownerHash, ref.packId, ref.deliveryId).slice(ROOT.length), raw: serialize({ ...ref, ownerHash: selected.ownerHash, operationId: claim.id, state: 'unknown' }) }))
      const result = await evaluate(COMMIT, [claim.id, selected.ownerHash, before.raw, claim.snapshotRaw ?? '', serialize(snapshot), raw, serialize(terminal(before.row, 'unknown')), serialize(indexes),
        serialize([...subjects].map(id => subjectScope(selected.binding, id)))], guard)
      return Number(result) === 1 ? readOperation(raw) : undefined
    },
    async claimEffect(binding: AgentBindingSnapshot, input: AgentDiceStateSource, index: number, guard?: AgentDiceStateGuard): Promise<{ readonly effect: AgentDiceStateJson; readonly operation: AgentDiceStateOperation } | undefined> {
      if (!integer(index) || index >= MAX_EFFECTS) throw invalid()
      const selected = owner(binding), source = readSource(input), before = await operation(selected, source, guard)
      if (!before || before.row.state !== 'ready' || before.row.completed !== index) return undefined
      const next: AgentDiceStateOperation = { ...before.row, state: 'pending' }, raw = serialize(next)
      return Number(await evaluate(CHANGE, [before.row.id, selected.ownerHash, before.raw, raw, serialize(refsFor(before.row)), String(index), '', 'claim'], guard)) === 1 ?
        Object.freeze({ effect: before.row.effects![index]!, operation: readOperation(raw) }) : undefined
    },
    async settleEffect(binding: AgentBindingSnapshot, input: AgentDiceStateSource, index: number, result: AgentDiceEffectReceipt, guard?: AgentDiceStateGuard): Promise<AgentDiceStateOperation | undefined> {
      if (!integer(index) || index >= MAX_EFFECTS) throw invalid()
      const selected = owner(binding), source = readSource(input), before = await operation(selected, source, guard)
      if (!before || before.row.state !== 'pending' || before.row.completed !== index) return undefined
      const { next, deliveryState } = nextReceipt(before.row, index, result)
      const raw = serialize(next); readOperation(raw)
      return Number(await evaluate(CHANGE, [before.row.id, selected.ownerHash, before.raw, raw, serialize(refsFor(before.row)), String(index), deliveryState, 'settle'], guard)) === 1 ? readOperation(raw) : undefined
    },
    async settleEffectAndState(binding: AgentBindingSnapshot, input: AgentDiceStateSource, index: number, result: AgentDiceEffectReceipt,
      update: { readonly snapshot: AgentDiceStateSnapshot; readonly nextState: unknown }, guard?: AgentDiceStateGuard): Promise<AgentDiceStateOperation | undefined> {
      if (!integer(index) || index >= MAX_EFFECTS) throw invalid()
      const selected = owner(binding), source = readSource(input), before = await operation(selected, source, guard)
      if (!before || before.row.state !== 'pending' || before.row.completed !== index) return undefined
      const data = object(copyJson(update), ['snapshot', 'nextState'])
      if (!Object.hasOwn(data, 'snapshot') || !Object.hasOwn(data, 'nextState')) throw invalid()
      const originalSnapshot = Object.getOwnPropertyDescriptor(update, 'snapshot')!.value as unknown
      const expected = originalSnapshot && typeof originalSnapshot === 'object' ? SNAPSHOT_RAW.get(originalSnapshot) : undefined
      const snapshot = readSnapshot(expected ?? serialize(data.snapshot), selected.ownerHash)
      if (!snapshot || snapshot.revision >= Number.MAX_SAFE_INTEGER || snapshot.revision < before.row.committedRevision!) throw invalid()
      const nextSnapshot: AgentDiceStateSnapshot = { version: 1, ownerHash: selected.ownerHash, revision: snapshot.revision + 1, source, state: data.nextState! }
      const { next, deliveryState } = nextReceipt(before.row, index, result)
      const raw = serialize({ ...next, committedRevision: nextSnapshot.revision }); readOperation(raw)
      const settled = await evaluate(SETTLE_STATE, [before.row.id, selected.ownerHash, before.raw, expected ?? serialize(data.snapshot), serialize(nextSnapshot), raw,
        serialize(refsFor(before.row)), String(index), deliveryState], guard)
      return Number(settled) === 1 ? readOperation(raw) : undefined
    },
    async recoverOperation(binding: AgentBindingSnapshot, input: AgentDiceStateSource, guard?: AgentDiceStateGuard): Promise<AgentDiceStateOperation | undefined> {
      const selected = owner(binding), source = readSource(input), before = await operation(selected, source, guard)
      if (!before || before.row.state !== 'preparing' && before.row.state !== 'pending') return before?.row
      const raw = serialize(terminal(before.row, 'unknown'))
      return Number(await evaluate(CHANGE, [before.row.id, selected.ownerHash, before.raw, raw, serialize(refsFor(before.row)), '', '', 'recover'], guard)) === 1 ? readOperation(raw) : undefined
    },
    async abandonOperation(binding: AgentBindingSnapshot, input: AgentDiceStateSource, guard?: AgentDiceStateGuard): Promise<AgentDiceStateOperation | undefined> {
      const selected = owner(binding), source = readSource(input)
      for (let attempt = 0; attempt < 16; attempt++) {
        const before = await operation(selected, source, guard)
        if (!before || !['preparing', 'ready', 'pending'].includes(before.row.state)) return before?.row
        const next = terminal(before.row, 'unknown'), raw = serialize(next)
        const changed = await evaluate(CHANGE, [before.row.id, selected.ownerHash, before.raw, raw, serialize(refsFor(before.row)), '', '', 'abandon'], guard)
        if (Number(changed) === 2) return (await operation(selected, source, guard))?.row
      }
      throw invalid()
    },
    async readDelivery(binding: AgentBindingSnapshot, input: { readonly packId: string; readonly deliveryId: string }, guard?: AgentDiceStateGuard): Promise<AgentDiceStateDeliveryIndex | undefined> {
      const selected = owner(binding), data = object(copyJson(input), ['packId', 'deliveryId'])
      if (!deliveryIdentifier(data.packId) || !deliveryIdentifier(data.deliveryId)) throw invalid()
      return readDeliveryIndex(await readRaw(deliveryKey(selected.ownerHash, data.packId, data.deliveryId), guard), selected.ownerHash, data.packId, data.deliveryId)
    },
    async revokeSource(binding: AgentBindingSnapshot, id: string, guard?: AgentDiceStateGuard): Promise<number> {
      const selected = owner(binding)
      return revokeTarget(selected.binding.target, id, guard)
    },
    revokeSourceByTarget: revokeTarget,
    async hasSourceByTarget(input: ConversationAddress, id: string, guard?: AgentDiceStateGuard): Promise<boolean> {
      const value = object(copyJson(input), ['account', 'kind', 'id']), target = value as unknown as ConversationAddress
      object(value.account!, ['platform', 'namespace', 'id'])
      if (!isConversationAddress(target) || !messageId(id)) throw invalid()
      const result = await evaluate(SOURCE_EXISTS, [hash([conversationAddressKey(target), id])], guard)
      if (typeof result !== 'number' || !integer(result) || result > 4) throw invalid()
      return result > 0
    },
    async purgeSubject(input: { readonly account: PlatformAccountRef; readonly agentId: string; readonly subjectId: string; readonly target?: ConversationAddress }, guard?: AgentDiceStateGuard): Promise<number> {
      const data = object(copyJson(input), ['account', 'agentId', 'subjectId', 'target']), accountData = object(data.account!, ['platform', 'namespace', 'id'])
      const account = accountData as unknown as PlatformAccountRef
      if (!isPlatformAccount(account) || typeof data.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(data.agentId) || !isPlatformIdentifier(data.subjectId)) throw invalid()
      let scope: 'global' | 'scene' = 'global', subject = hash([platformAccountKey(account), data.agentId, data.subjectId]), privacy = hash([platformAccountKey(account), data.agentId])
      if (data.target !== undefined) {
        const targetData = object(data.target, ['account', 'kind', 'id']), targetAccount = object(targetData.account!, ['platform', 'namespace', 'id'])
        const target = targetData as unknown as ConversationAddress
        if (!isConversationAddress(target) || target.kind !== 'group' || platformAccountKey(targetAccount as unknown as PlatformAccountRef) !== platformAccountKey(account)) throw invalid()
        scope = 'scene'; subject = hash([conversationAddressKey(target), data.agentId, data.subjectId]); privacy = hash([conversationAddressKey(target), data.agentId])
      }
      const result = await evaluate(PURGE, [scope, subject, privacy], guard)
      return scrubSealed(result, `purged:${scope}:${subject}`, guard, data.subjectId)
    },
  }
}
