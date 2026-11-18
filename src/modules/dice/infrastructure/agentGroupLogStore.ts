import { createHash, randomUUID } from 'node:crypto'
import type { ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import { conversationAddressKey, isConversationAddress, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import type { LogExportLine } from '../domain/logExport.js'

export interface AgentGroupLogOwner { readonly target: ConversationAddress; readonly agentId: string }
export interface AgentGroupLogEpochs { readonly globalEpoch: string; readonly sceneEpoch: string }
export interface AgentGroupLogRow {
  /** The real inbound source, shared by every derived event for recall and privacy. */
  readonly messageId: string
  readonly authorId: string
  readonly occurredAt: number
  readonly name: string
  readonly content: string
  readonly type?: 'message' | 'dice_result' | 'dice_rule'
  /** A trusted producer's event identity, distinct from the inbound source. */
  readonly eventId?: string
  /** A real confirmed outbound receipt; never a substitute for messageId. */
  readonly deliveryMessageId?: string
}
export interface AgentGroupLogMetadata {
  readonly id: string
  /** An opaque durable log ID, never a filesystem path. */
  readonly file: string
  readonly title: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly count: number
  readonly bytes: number
}
export interface AgentGroupLogState {
  readonly active: boolean
  readonly aiEnabled: boolean
  readonly currentId?: string
  readonly log?: AgentGroupLogMetadata
  /** Oldest first, including the current log; compatible with resolveLogForExport. */
  readonly logs: readonly AgentGroupLogMetadata[]
}
export type AgentGroupLogCommand =
  | { readonly kind: 'start'; readonly title?: string }
  | { readonly kind: 'stop' | 'status' | 'list' }
  | { readonly kind: 'ai'; readonly enabled?: boolean }
  | { readonly kind: 'export'; readonly selector?: string; readonly format?: 'txt' | 'html' }
  | { readonly kind: 'end'; readonly format?: 'txt' | 'html' }
export type AgentGroupLogDelivery = 'ready' | 'pending' | 'confirmed' | 'failed' | 'unknown'
export interface AgentGroupLogCommandEffect {
  readonly commandId: string
  readonly kind: AgentGroupLogCommand['kind']
  readonly changed: boolean
  readonly selectedLogId?: string
  readonly format?: 'txt' | 'html'
  readonly delivery: AgentGroupLogDelivery
  readonly state: AgentGroupLogState
}
interface Redis {
  get(key: string): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

const ROOT = 'agent:group-log:v1'
const PROCESS_OWNER = randomUUID()
const HARD_ROWS = 200_000
const HARD_BYTES = 100 * 1024 * 1024
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const invalid = () => new Error('团录存储数据或归属无效')
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
const scalar = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && wellFormed(value)
function owner(input: AgentGroupLogOwner): AgentGroupLogOwner {
  if (!input || !isConversationAddress(input.target) || input.target.kind !== 'group' || !scalar(input.agentId)) throw invalid()
  const { account, id } = input.target
  return { target: { account: { platform: account.platform, namespace: account.namespace, id: account.id }, kind: 'group', id }, agentId: input.agentId }
}
const ownerId = (value: AgentGroupLogOwner) => hash(JSON.stringify([value.agentId, conversationAddressKey(value.target)]))
const accountAgent = (value: AgentGroupLogOwner) => hash(JSON.stringify([platformAccountKey(value.target.account), value.agentId]))
const sceneId = (target: ConversationAddress) => hash(conversationAddressKey(target))
const globalSubject = (value: AgentGroupLogOwner, subject: string) => hash(JSON.stringify([accountAgent(value), subject]))
const sceneSubject = (value: AgentGroupLogOwner, subject: string) => hash(JSON.stringify([ownerId(value), subject]))
const accountIndex = (account: PlatformAccountRef) => createHash('sha1').update([account.platform, account.namespace, account.id].join('\u0000')).digest('hex')
function parsed<T>(value: unknown): T {
  if (typeof value !== 'string') throw invalid()
  try { return JSON.parse(value) as T } catch { throw invalid() }
}
function epoch(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/u.test(value) }

// All dynamically derived keys extend KEYS[1], retaining the host's Redis namespace.
const COMMON = `
local root = KEYS[1]
local oid, aa, scene = ARGV[1], ARGV[2], ARGV[3]
local base = root .. ':owner:' .. oid
local function expect(key, expected)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected then error('invalid group log storage type') end
end
local function decimal(value)
  return type(value) == 'string' and #value <= 16 and (value == '0' or string.match(value, '^[1-9]%d*$') ~= nil)
end
local function counter(key)
  expect(key, 'string')
  local value = redis.call('GET', key) or '0'
  if not decimal(value) or value == '9999999999999999' then error('invalid or exhausted group log counter') end
  return value
end
local function hashCounter(key, field)
  expect(key, 'hash')
  local value = redis.call('HGET', key, field) or '0'
  if not decimal(value) then error('invalid group log epoch') end
  return value
end
local function state()
  expect(base .. ':state', 'string')
  local raw = redis.call('GET', base .. ':state')
  if not raw then return {active=false, aiEnabled=false} end
  local value = cjson.decode(raw)
  if type(value) ~= 'table' or type(value.active) ~= 'boolean' or type(value.aiEnabled) ~= 'boolean'
    or (value.currentId ~= nil and type(value.currentId) ~= 'string')
    or (value.active and value.currentId == nil) then error('invalid group log state') end
  return value
end
local function metadata(id)
  local key = base .. ':log:' .. id .. ':meta'
  expect(key, 'string')
  local raw = redis.call('GET', key)
  if not raw then error('missing group log metadata') end
  local value = cjson.decode(raw)
  if type(value) ~= 'table' or value.id ~= id or value.file ~= id or type(value.title) ~= 'string'
    or type(value.startedAt) ~= 'string' or (value.endedAt ~= nil and type(value.endedAt) ~= 'string')
    or type(value.count) ~= 'number' or value.count < 0 or value.count > 200000 or value.count ~= math.floor(value.count)
    or type(value.bytes) ~= 'number' or value.bytes < 0 or value.bytes > 104857600 or value.bytes ~= math.floor(value.bytes) then error('invalid group log metadata') end
  return value
end
local function revision()
  return counter(base .. ':revision') .. ':' .. hashCounter(root .. ':privacyRevisions', aa) .. ':' .. hashCounter(root .. ':recallRevisions', scene)
end
local function receipt(raw, id)
  local effect = cjson.decode(raw)
  if type(effect) ~= 'table' or effect.commandId ~= id or type(effect.changed) ~= 'boolean'
    or not ({start=true, stop=true, ai=true, status=true, list=true, export=true, ['end']=true})[effect.kind]
    or not ({ready=true, pending=true, confirmed=true, failed=true, unknown=true})[effect.delivery]
    or (effect.delivery == 'pending' and type(effect.processOwner) ~= 'string')
    or (effect.selectedLogId ~= nil and type(effect.selectedLogId) ~= 'string')
    or (effect.format ~= nil and effect.format ~= 'txt' and effect.format ~= 'html') then error('invalid group log command receipt') end
  return effect
end
local accountOwners = nil
local function registered(raw)
  expect(root .. ':owners', 'hash')
  local account = cjson.decode(raw).target.account
  accountOwners = root .. ':accountOwners:' .. redis.sha1hex(account.platform .. string.char(0) .. account.namespace .. string.char(0) .. account.id)
  expect(accountOwners, 'set')
  local previous = redis.call('HGET', root .. ':owners', oid)
  if previous and previous ~= raw then error('group log owner mismatch') end
end
local function register(raw)
  redis.call('HSET', root .. ':owners', oid, raw)
  redis.call('SADD', accountOwners, oid)
end
`

const CAPTURE = COMMON + `
registered(ARGV[4])
expect(root .. ':globalEpochs', 'hash'); expect(root .. ':sceneEpochs', 'hash')
return {hashCounter(root .. ':globalEpochs', ARGV[5]), hashCounter(root .. ':sceneEpochs', ARGV[6])}
`
const APPEND = COMMON + `
registered(ARGV[4])
expect(root .. ':globalEpochs', 'hash'); expect(root .. ':sceneEpochs', 'hash')
expect(root .. ':recalls:' .. scene, 'hash'); expect(base .. ':seen', 'set')
counter(base .. ':revision')
local current = state()
if not current.active or not current.currentId then return 0 end
if hashCounter(root .. ':globalEpochs', ARGV[5]) ~= ARGV[7]
  or hashCounter(root .. ':sceneEpochs', ARGV[6]) ~= ARGV[8]
  or redis.call('HEXISTS', root .. ':recalls:' .. scene, ARGV[10]) == 1
  or redis.call('SISMEMBER', base .. ':seen', ARGV[9]) == 1 then return 0 end
local log = base .. ':log:' .. current.currentId
expect(log .. ':rows', 'hash'); expect(log .. ':order', 'zset'); counter(log .. ':sequence')
expect(log .. ':author:' .. ARGV[11], 'set'); expect(log .. ':source:' .. ARGV[12], 'set')
local meta = metadata(current.currentId)
local bytes = string.len(ARGV[13])
if meta.count + 1 > tonumber(ARGV[14]) or meta.bytes + bytes > tonumber(ARGV[15]) then return -1 end
register(ARGV[4])
local sequence = redis.call('INCR', log .. ':sequence')
redis.call('HSET', log .. ':rows', ARGV[9], ARGV[13])
redis.call('ZADD', log .. ':order', sequence, ARGV[9])
redis.call('SADD', log .. ':author:' .. ARGV[11], ARGV[9])
redis.call('SADD', log .. ':source:' .. ARGV[12], ARGV[9])
redis.call('SADD', base .. ':seen', ARGV[9])
meta.count = meta.count + 1; meta.bytes = meta.bytes + bytes
redis.call('SET', log .. ':meta', cjson.encode(meta))
redis.call('INCR', base .. ':revision')
return 1
`
const READ = COMMON + `
registered(ARGV[4]); expect(base .. ':logs', 'list')
local result = {cjson.encode(state())}
for _, id in ipairs(redis.call('LRANGE', base .. ':logs', 0, -1)) do table.insert(result, cjson.encode(metadata(id))) end
return result
`
const COMMAND = COMMON + `
registered(ARGV[4]); expect(base .. ':commands', 'hash'); expect(base .. ':logs', 'list'); counter(base .. ':revision')
local old = redis.call('HGET', base .. ':commands', ARGV[5])
if old then
  local effect = receipt(old, ARGV[5])
  if effect.delivery == 'pending' and effect.processOwner ~= ARGV[10] then
    effect.delivery = 'unknown'; effect.processOwner = nil
    old = cjson.encode(effect); redis.call('HSET', base .. ':commands', ARGV[5], old)
  end
  return old
end
expect(root .. ':recalls:' .. scene, 'hash')
if redis.call('HGET', root .. ':recalls:' .. scene, ARGV[5]) == '1' then error('group log command source revoked') end
if ARGV[11] ~= '' and (hashCounter(root .. ':globalEpochs', ARGV[11]) ~= ARGV[13]
  or hashCounter(root .. ':sceneEpochs', ARGV[12]) ~= ARGV[14]) then error('group log command privacy epoch changed') end
local current, command = state(), cjson.decode(ARGV[6])
local effect = {commandId=ARGV[5], kind=command.kind, changed=false, delivery='ready'}
local selected, newMeta, endedMeta = nil, nil, nil
if command.kind == 'start' and not current.active then
  local id = ARGV[8]
  expect(base .. ':log:' .. id .. ':meta', 'string')
  if redis.call('EXISTS', base .. ':log:' .. id .. ':meta') == 1 then error('duplicate group log ID') end
  newMeta = {id=id, file=id, title=command.title, startedAt=ARGV[7], count=0, bytes=0}
  current.active = true; current.currentId = id; effect.changed = true
elseif (command.kind == 'stop' or command.kind == 'end') and current.active and current.currentId then
  endedMeta = metadata(current.currentId); endedMeta.endedAt = ARGV[7]
  current.active = false; effect.changed = true
elseif command.kind == 'ai' and command.enabled ~= nil and command.enabled ~= current.aiEnabled then
  current.aiEnabled = command.enabled; effect.changed = true
end
if command.kind == 'export' or command.kind == 'end' then
  local selector = command.selector or ''
  local ids = redis.call('LRANGE', base .. ':logs', 0, -1)
  if selector == '' or string.lower(selector) == 'current' or selector == '当前' or command.kind == 'end' then selected = current.currentId
  elseif string.match(selector, '^%d+$') then
    local wanted, position = tonumber(selector), 0
    for index = #ids, 1, -1 do
      if ids[index] ~= current.currentId then position = position + 1; if position == wanted then selected = ids[index]; break end end
    end
  else
    if current.currentId and metadata(current.currentId).title == selector then selected = current.currentId end
    if not selected then for index = #ids, 1, -1 do
      if ids[index] ~= current.currentId and metadata(ids[index]).title == selector then selected = ids[index]; break end
    end end
  end
  effect.selectedLogId = selected; effect.format = command.format or 'txt'
end
-- Validate every existing metadata document before applying state or a receipt.
for _, id in ipairs(redis.call('LRANGE', base .. ':logs', 0, -1)) do metadata(id) end
if newMeta then
  redis.call('SET', base .. ':log:' .. newMeta.id .. ':meta', cjson.encode(newMeta))
  redis.call('RPUSH', base .. ':logs', newMeta.id)
end
if endedMeta then redis.call('SET', base .. ':log:' .. endedMeta.id .. ':meta', cjson.encode(endedMeta)) end
register(ARGV[4])
redis.call('SET', base .. ':state', cjson.encode(current))
if effect.changed then redis.call('INCR', base .. ':revision') end
local saved = cjson.encode(effect)
redis.call('HSET', base .. ':commands', ARGV[5], saved)
return saved
`
const DICE_CONTROL = COMMON + `
registered(ARGV[4]); expect(base .. ':diceControls', 'hash'); expect(base .. ':diceLogOwners', 'hash')
expect(base .. ':logs', 'list'); counter(base .. ':revision')
expect(root .. ':recalls:' .. scene, 'hash')
if redis.call('HGET', root .. ':recalls:' .. scene, ARGV[6]) == '1' then error('group log command source revoked') end
if hashCounter(root .. ':globalEpochs', ARGV[11]) ~= ARGV[13]
  or hashCounter(root .. ':sceneEpochs', ARGV[12]) ~= ARGV[14] then error('group log command privacy epoch changed') end
local old = redis.call('HGET', base .. ':diceControls', ARGV[5])
if old then
  local saved = cjson.decode(old)
  if type(saved) ~= 'table' or saved.requestHash ~= ARGV[15]
    or (saved.state ~= 'confirmed' and saved.state ~= 'failed') then error('invalid dice group log control receipt') end
  return old
end
local current, operation = state(), ARGV[7]
local owned = redis.call('HGET', base .. ':diceLogOwners', ARGV[8])
if owned then metadata(owned) end
for _, id in ipairs(redis.call('LRANGE', base .. ':logs', 0, -1)) do metadata(id) end
local effect = {requestHash=ARGV[15], state='failed'}
local created, ended = nil, nil
if operation == 'start' and not current.active and not owned then
  local id = ARGV[10]
  expect(base .. ':log:' .. id .. ':meta', 'string')
  if redis.call('EXISTS', base .. ':log:' .. id .. ':meta') == 1 then error('duplicate group log ID') end
  created = {id=id, file=id, title=ARGV[9], startedAt=ARGV[16], count=0, bytes=0}
  current.active = true; current.currentId = id; effect.state = 'confirmed'; effect.logId = id
elseif operation == 'stop' and owned and current.active and current.currentId == owned then
  ended = metadata(owned); ended.endedAt = ARGV[16]
  current.active = false; effect.state = 'confirmed'; effect.logId = owned
end
if created then
  redis.call('SET', base .. ':log:' .. created.id .. ':meta', cjson.encode(created))
  redis.call('RPUSH', base .. ':logs', created.id)
  redis.call('HSET', base .. ':diceLogOwners', ARGV[8], created.id)
end
if ended then redis.call('SET', base .. ':log:' .. ended.id .. ':meta', cjson.encode(ended)) end
register(ARGV[4])
if effect.state == 'confirmed' then
  redis.call('SET', base .. ':state', cjson.encode(current)); redis.call('INCR', base .. ':revision')
end
local saved = cjson.encode(effect)
redis.call('HSET', base .. ':diceControls', ARGV[5], saved)
return saved
`
const SNAPSHOT = COMMON + `
registered(ARGV[4])
local meta = metadata(ARGV[5]); local log = base .. ':log:' .. ARGV[5]
expect(log .. ':rows', 'hash'); expect(log .. ':order', 'zset')
local result = {cjson.encode(meta), revision()}
for _, id in ipairs(redis.call('ZRANGE', log .. ':order', 0, -1)) do
  local row = redis.call('HGET', log .. ':rows', id)
  if not row then error('missing group log row') end
  table.insert(result, row)
end
if #result - 2 ~= meta.count then error('inconsistent group log row count') end
return result
`
const CURRENT = COMMON + `registered(ARGV[4]); return revision() == ARGV[5] and 1 or 0`
const DELIVERY = COMMON + `
registered(ARGV[4]); expect(base .. ':commands', 'hash')
local raw = redis.call('HGET', base .. ':commands', ARGV[5]); if not raw then return 0 end
local effect = receipt(raw, ARGV[5])
if effect.delivery == 'pending' and effect.processOwner ~= ARGV[7] then
  effect.delivery = 'unknown'; effect.processOwner = nil
  redis.call('HSET', base .. ':commands', ARGV[5], cjson.encode(effect)); return 0
end
if ARGV[6] == 'claim' then
  if effect.delivery ~= 'ready' then return 0 end
  effect.delivery = 'pending'; effect.processOwner = ARGV[7]
else
  if effect.delivery ~= 'pending' or effect.processOwner ~= ARGV[7] then return 0 end
  effect.delivery = ARGV[6]; effect.processOwner = nil
end
redis.call('HSET', base .. ':commands', ARGV[5], cjson.encode(effect)); return 1
`
const REGISTRY = `
local actual = redis.call('TYPE', KEYS[1] .. ':owners').ok
if actual ~= 'none' and actual ~= 'hash' then error('invalid group log registry') end
local result = {}
for _, account in ipairs(ARGV) do
  local index = KEYS[1] .. ':accountOwners:' .. account
  local kind = redis.call('TYPE', index).ok
  if kind ~= 'none' and kind ~= 'set' then error('invalid group log account registry') end
  for _, id in ipairs(redis.call('SMEMBERS', index)) do
    local raw = redis.call('HGET', KEYS[1] .. ':owners', id)
    if not raw then error('missing group log registered owner') end
    table.insert(result, id); table.insert(result, raw)
  end
end
return result
`
const EPOCH = `
local root = KEYS[1]
local function expect(key)
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= 'hash' then error('invalid group log epoch storage') end
end
expect(root .. ':' .. ARGV[1]); expect(root .. ':privacyRevisions')
for _, pair in ipairs({{root .. ':' .. ARGV[1], ARGV[2]}, {root .. ':privacyRevisions', ARGV[3]}}) do
  local value = redis.call('HGET', pair[1], pair[2]) or '0'
  if #value > 16 or not (value == '0' or string.match(value, '^[1-9]%d*$')) or value == '9999999999999999' then error('invalid or exhausted group log epoch') end
end
redis.call('HINCRBY', root .. ':' .. ARGV[1], ARGV[2], 1)
redis.call('HINCRBY', root .. ':privacyRevisions', ARGV[3], 1)
return 1
`
const RECALL = `
local key, revisions = KEYS[1] .. ':recalls:' .. ARGV[1], KEYS[1] .. ':recallRevisions'
for _, name in ipairs({key, revisions}) do
  local actual = redis.call('TYPE', name).ok
  if actual ~= 'none' and actual ~= 'hash' then error('invalid group log recall storage') end
end
local value = redis.call('HGET', revisions, ARGV[1]) or '0'
if #value > 16 or not (value == '0' or string.match(value, '^[1-9]%d*$')) or value == '9999999999999999' then error('invalid or exhausted group log recall revision') end
local previous = redis.call('HGET', key, ARGV[2])
if previous and previous ~= '1' then error('invalid group log recall marker') end
if redis.call('HSETNX', key, ARGV[2], '1') == 1 then redis.call('HINCRBY', revisions, ARGV[1], 1) end
return 1
`
const PURGE = COMMON + `
registered(ARGV[4]); expect(base .. ':logs', 'list'); counter(base .. ':revision')
local removed = 0
local ids = redis.call('LRANGE', base .. ':logs', 0, -1)
-- A read-only pass validates all affected logs before the first deletion. Avoid
-- retaining decoded transcript bodies from multiple logs in the Lua heap.
for _, id in ipairs(ids) do
  local log = base .. ':log:' .. id; local meta = metadata(id)
  expect(log .. ':rows', 'hash'); expect(log .. ':order', 'zset'); expect(log .. ':' .. ARGV[5] .. ':' .. ARGV[6], 'set')
  local victims = redis.call('SMEMBERS', log .. ':' .. ARGV[5] .. ':' .. ARGV[6])
  local count, bytes = 0, 0
  if redis.call('HLEN', log .. ':rows') ~= meta.count or redis.call('ZCARD', log .. ':order') ~= meta.count then error('inconsistent group log row count') end
  for _, rowId in ipairs(victims) do
    local raw = redis.call('HGET', log .. ':rows', rowId)
    if not raw then error('missing group log indexed row') end
    local row = cjson.decode(raw)
    if row[ARGV[7]] ~= ARGV[8] or type(row._authorIndex) ~= 'string' or type(row._sourceIndex) ~= 'string' then error('invalid group log reverse index') end
    expect(log .. ':author:' .. row._authorIndex, 'set'); expect(log .. ':source:' .. row._sourceIndex, 'set')
    if not redis.call('ZSCORE', log .. ':order', rowId) then error('missing group log row order') end
    count = count + 1; bytes = bytes + string.len(raw)
  end
  if count > meta.count or bytes > meta.bytes then error('inconsistent group log byte count') end
end
for _, id in ipairs(ids) do
  local log = base .. ':log:' .. id; local meta = metadata(id)
  local victims = redis.call('SMEMBERS', log .. ':' .. ARGV[5] .. ':' .. ARGV[6])
  for _, rowId in ipairs(victims) do
    local raw = redis.call('HGET', log .. ':rows', rowId); local row = cjson.decode(raw)
    redis.call('HDEL', log .. ':rows', rowId); redis.call('ZREM', log .. ':order', rowId)
    redis.call('SREM', log .. ':author:' .. row._authorIndex, rowId)
    redis.call('SREM', log .. ':source:' .. row._sourceIndex, rowId)
    meta.count = meta.count - 1; meta.bytes = meta.bytes - string.len(raw); removed = removed + 1
  end
  if #victims > 0 then redis.call('SET', log .. ':meta', cjson.encode(meta)) end
end
if removed > 0 then redis.call('INCR', base .. ':revision') end
return removed
`
const RECOVER = COMMON + `
registered(ARGV[4]); expect(base .. ':commands', 'hash')
local rows = redis.call('HGETALL', base .. ':commands'); local changed = 0
for index=1,#rows,2 do receipt(rows[index+1], rows[index]) end
for index=1,#rows,2 do
  local effect = receipt(rows[index+1], rows[index])
  if effect.delivery == 'pending' and effect.processOwner ~= ARGV[5] then
    effect.delivery = 'unknown'; effect.processOwner = nil
    redis.call('HSET', base .. ':commands', rows[index], cjson.encode(effect)); changed = changed + 1
  end
end
return changed
`

/** One externally leased host owns mutations; Redis retains each row and every terminal receipt without TTL. */
export function createAgentGroupLogStore(redis: Redis, options: { maxRows?: number; maxBytes?: number } = {}) {
  const maxRows = options.maxRows ?? HARD_ROWS, maxBytes = options.maxBytes ?? HARD_BYTES
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > HARD_ROWS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_BYTES) throw invalid()
  const args = (value: AgentGroupLogOwner) => [ownerId(value), accountAgent(value), sceneId(value.target), JSON.stringify(value)]
  const evaluate = (script: string, values: string[]) => redis.eval(script, { keys: [ROOT], arguments: values })
  async function read(input: AgentGroupLogOwner): Promise<AgentGroupLogState> {
    const value = owner(input), result = await evaluate(READ, args(value))
    if (!Array.isArray(result) || !result.length) throw invalid()
    const saved = parsed<{ active: boolean; aiEnabled: boolean; currentId?: string }>(result[0])
    const logs = result.slice(1).map(row => parsed<AgentGroupLogMetadata>(row))
    const log = saved.currentId ? logs.find(item => item.id === saved.currentId) : undefined
    if (saved.currentId && !log) throw invalid()
    return { ...saved, ...(log ? { log } : {}), logs }
  }
  async function listOwners(accounts: readonly PlatformAccountRef[]): Promise<AgentGroupLogOwner[]> {
    const allowed = new Set(accounts.map(platformAccountKey)), result = await evaluate(REGISTRY, [...new Set(accounts.map(accountIndex))])
    if (!Array.isArray(result) || result.length % 2) throw invalid()
    const owners: AgentGroupLogOwner[] = []
    for (let index = 0; index < result.length; index += 2) {
      const value = owner(parsed<AgentGroupLogOwner>(result[index + 1]))
      if (ownerId(value) !== result[index]) throw invalid()
      if (allowed.has(platformAccountKey(value.target.account))) owners.push(value)
    }
    return owners
  }
  return {
    read, listOwners,
    async capture(input: AgentGroupLogOwner, subjectId: string): Promise<AgentGroupLogEpochs> {
      const value = owner(input); if (!scalar(subjectId)) throw invalid()
      const result = await evaluate(CAPTURE, [...args(value), globalSubject(value, subjectId), sceneSubject(value, subjectId)])
      if (!Array.isArray(result) || !epoch(result[0]) || !epoch(result[1])) throw invalid()
      return { globalEpoch: result[0], sceneEpoch: result[1] }
    },
    async append(input: AgentGroupLogOwner, row: AgentGroupLogRow, epochs: AgentGroupLogEpochs): Promise<boolean> {
      const value = owner(input), type = row.type ?? 'message'
      const hasEventId = Object.hasOwn(row, 'eventId'), hasDeliveryMessageId = Object.hasOwn(row, 'deliveryMessageId')
      if (!scalar(row.messageId) || !scalar(row.authorId) || !Number.isSafeInteger(row.occurredAt) || row.occurredAt <= 0 ||
          !Number.isFinite(new Date(row.occurredAt).getTime()) || typeof row.name !== 'string' || row.name.length > 256 ||
          typeof row.content !== 'string' || !row.content || !wellFormed(row.content) || !wellFormed(row.name) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(row.content + row.name) ||
          !['message', 'dice_result', 'dice_rule'].includes(type) ||
          hasEventId && (type === 'message' || !scalar(row.eventId)) ||
          hasDeliveryMessageId && (type !== 'dice_result' || !scalar(row.deliveryMessageId)) ||
          !epochs || !epoch(epochs.globalEpoch) || !epoch(epochs.sceneEpoch)) throw invalid()
      const sourceIndex = hash(row.messageId), authorIndex = hash(row.authorId)
      const stored = JSON.stringify({ messageId: row.messageId, authorId: row.authorId, occurredAt: row.occurredAt,
        name: row.name, content: row.content, type, ...(hasEventId ? { eventId: row.eventId } : {}),
        ...(hasDeliveryMessageId ? { deliveryMessageId: row.deliveryMessageId } : {}), _sourceIndex: sourceIndex, _authorIndex: authorIndex })
      if (Buffer.byteLength(stored) > maxBytes) throw new Error('团录超过完整行数或字节上限，未写入')
      const result = Number(await evaluate(APPEND, [...args(value), globalSubject(value, row.authorId), sceneSubject(value, row.authorId),
        epochs.globalEpoch, epochs.sceneEpoch, hash(JSON.stringify(hasEventId ? [row.messageId, type, row.eventId] : [row.messageId, type])),
        row.messageId, authorIndex, sourceIndex, stored, String(maxRows), String(maxBytes)]))
      if (result === -1) throw new Error('团录超过完整行数或字节上限，未写入')
      if (result !== 0 && result !== 1) throw invalid()
      return result === 1
    },
    async command(input: AgentGroupLogOwner, commandId: string, command: AgentGroupLogCommand, now: number,
      fence?: { subjectId: string; epochs: AgentGroupLogEpochs }): Promise<AgentGroupLogCommandEffect> {
      const value = owner(input)
      if (!scalar(commandId) || !Number.isSafeInteger(now) || now <= 0 || !Number.isFinite(new Date(now).getTime()) ||
          !command || !['start', 'stop', 'ai', 'status', 'list', 'export', 'end'].includes(command.kind)) throw invalid()
      if (fence && (!scalar(fence.subjectId) || !epoch(fence.epochs?.globalEpoch) || !epoch(fence.epochs?.sceneEpoch))) throw invalid()
      const iso = new Date(now).toISOString()
      let normalized: AgentGroupLogCommand = command
      if (command.kind === 'start') {
        const title = command.title?.trim() || `COC-log-${iso.slice(0, 10)}`
        if (!scalar(title, 80)) throw invalid()
        normalized = { kind: 'start', title }
      } else if (command.kind === 'ai' && command.enabled !== undefined && typeof command.enabled !== 'boolean') throw invalid()
      else if (command.kind === 'export' || command.kind === 'end') {
        if (command.format !== undefined && command.format !== 'txt' && command.format !== 'html' ||
            command.kind === 'export' && command.selector !== undefined && (typeof command.selector !== 'string' || command.selector.length > 200)) throw invalid()
        normalized = { ...command, ...(command.kind === 'export' ? { selector: command.selector?.trim() ?? '' } : {}) }
      }
      const effect = parsed<Omit<AgentGroupLogCommandEffect, 'state'>>(await evaluate(COMMAND,
        [...args(value), commandId, JSON.stringify(normalized), iso, randomUUID(), '', PROCESS_OWNER,
          fence ? globalSubject(value, fence.subjectId) : '', fence ? sceneSubject(value, fence.subjectId) : '',
          fence?.epochs.globalEpoch ?? '', fence?.epochs.sceneEpoch ?? '']))
      return { ...effect, state: await read(value) }
    },
    /** An automatic session can stop only the exact log it atomically created. */
    async controlDiceLog(input: AgentGroupLogOwner, request: {
      readonly sourceMessageId: string; readonly subjectId: string; readonly operationId: string; readonly index: number
      readonly operation: 'start' | 'stop'; readonly ownershipId: string; readonly title?: string
    }, now: number, epochs: AgentGroupLogEpochs): Promise<{ readonly state: 'confirmed' | 'failed'; readonly logId?: string }> {
      const value = owner(input)
      if (!scalar(request.sourceMessageId) || !scalar(request.subjectId) || !/^[a-f0-9]{64}$/u.test(request.operationId) ||
          !/^[a-f0-9]{64}$/u.test(request.ownershipId) || !Number.isSafeInteger(request.index) || request.index < 0 || request.index >= 4096 ||
          !['start', 'stop'].includes(request.operation) || !Number.isSafeInteger(now) || now <= 0 || !Number.isFinite(new Date(now).getTime()) ||
          !epoch(epochs?.globalEpoch) || !epoch(epochs?.sceneEpoch) || request.title !== undefined && !scalar(request.title, 80)) throw invalid()
      const iso = new Date(now).toISOString(), title = request.title ?? 'Dice log'
      const requestHash = hash(JSON.stringify([request.sourceMessageId, request.subjectId, request.operationId, request.index,
        request.operation, request.ownershipId, title, epochs.globalEpoch, epochs.sceneEpoch]))
      const result = parsed<{ requestHash: string; state: 'confirmed' | 'failed'; logId?: string }>(await evaluate(DICE_CONTROL, [...args(value),
        hash(JSON.stringify([request.operationId, request.index])), request.sourceMessageId, request.operation, request.ownershipId, title,
        randomUUID(), globalSubject(value, request.subjectId), sceneSubject(value, request.subjectId), epochs.globalEpoch, epochs.sceneEpoch, requestHash, iso]))
      if (result.requestHash !== requestHash || !['confirmed', 'failed'].includes(result.state) ||
          result.logId !== undefined && !scalar(result.logId)) throw invalid()
      return { state: result.state, ...(result.logId === undefined ? {} : { logId: result.logId }) }
    },
    async snapshot(input: AgentGroupLogOwner, logId: string): Promise<{
      document: { title: string; startedAt: string; endedAt?: string }; rows: LogExportLine[]; sourceRows: AgentGroupLogRow[]; revision: string
    }> {
      const value = owner(input); if (!scalar(logId)) throw invalid()
      const result = await evaluate(SNAPSHOT, [...args(value), logId])
      if (!Array.isArray(result) || result.length < 2 || typeof result[1] !== 'string') throw invalid()
      const metadata = parsed<AgentGroupLogMetadata>(result[0])
      const sourceRows = result.slice(2).map(raw => {
        const row = parsed<AgentGroupLogRow>(raw)
        return { messageId: row.messageId, authorId: row.authorId, occurredAt: row.occurredAt, name: row.name, content: row.content,
          ...(row.type ? { type: row.type } : {}), ...(row.eventId === undefined ? {} : { eventId: row.eventId }),
          ...(row.deliveryMessageId === undefined ? {} : { deliveryMessageId: row.deliveryMessageId }) }
      })
      return { document: { title: metadata.title, startedAt: metadata.startedAt, ...(metadata.endedAt ? { endedAt: metadata.endedAt } : {}) },
        sourceRows, rows: sourceRows.map(row => ({ at: new Date(row.occurredAt).toISOString(), name: row.name, userId: row.authorId, content: row.content, type: row.type ?? 'message' })), revision: result[1] }
    },
    async isCurrent(input: AgentGroupLogOwner, revision: string): Promise<boolean> {
      const value = owner(input); if (typeof revision !== 'string' || !/^\d+:\d+:\d+$/u.test(revision)) return false
      return Number(await evaluate(CURRENT, [...args(value), revision])) === 1
    },
    async claimCommandDelivery(input: AgentGroupLogOwner, commandId: string): Promise<boolean> {
      const value = owner(input); if (!scalar(commandId)) throw invalid()
      return Number(await evaluate(DELIVERY, [...args(value), commandId, 'claim', PROCESS_OWNER])) === 1
    },
    async settleCommandDelivery(input: AgentGroupLogOwner, commandId: string, outcome: 'confirmed' | 'failed' | 'unknown'): Promise<boolean> {
      const value = owner(input)
      if (!scalar(commandId) || !['confirmed', 'failed', 'unknown'].includes(outcome)) throw invalid()
      return Number(await evaluate(DELIVERY, [...args(value), commandId, outcome, PROCESS_OWNER])) === 1
    },
    async purgeSubject(input: { account: PlatformAccountRef; agentId: string; subjectId: string; groupId?: string }): Promise<number> {
      if (!scalar(input.agentId) || !scalar(input.subjectId) || input.groupId !== undefined && !scalar(input.groupId)) throw invalid()
      // Validate an owner-shaped target before storing a tombstone, even when no log exists yet.
      const sample = owner({ agentId: input.agentId, target: { account: input.account, kind: 'group', id: input.groupId ?? 'privacy' } })
      await evaluate(EPOCH, [input.groupId === undefined ? 'globalEpochs' : 'sceneEpochs',
        input.groupId === undefined ? globalSubject(sample, input.subjectId) : sceneSubject(sample, input.subjectId), accountAgent(sample)])
      const owners = await listOwners([input.account])
      let removed = 0
      for (const value of owners) if (value.agentId === input.agentId && (input.groupId === undefined || value.target.id === input.groupId)) {
        removed += Number(await evaluate(PURGE, [...args(value), 'author', hash(input.subjectId), 'authorId', input.subjectId]))
      }
      return removed
    },
    async revokeSource(target: ConversationAddress, messageId: string): Promise<number> {
      if (target?.kind === 'private') return 0
      if (!isConversationAddress(target) || target.kind !== 'group' || !scalar(messageId)) throw invalid()
      await evaluate(RECALL, [sceneId(target), messageId])
      const owners = await listOwners([target.account])
      let removed = 0
      for (const value of owners) if (conversationAddressKey(value.target) === conversationAddressKey(target)) {
        removed += Number(await evaluate(PURGE, [...args(value), 'source', hash(messageId), 'messageId', messageId]))
      }
      return removed
    },
    async recover(accounts: readonly PlatformAccountRef[]): Promise<void> {
      for (const value of await listOwners(accounts)) await evaluate(RECOVER, [...args(value), PROCESS_OWNER])
    },
  }
}

export type AgentGroupLogStore = ReturnType<typeof createAgentGroupLogStore>
