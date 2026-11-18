import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'

export interface AgentDiceItem { readonly eventId: string; readonly text: string; readonly result: boolean }
export interface AgentDiceRecord {
  readonly version: 1
  readonly bindingHash: string
  readonly sourceHash: string
  readonly globalIndex: string
  readonly sceneIndex: string
  readonly state: 'ready' | 'pending' | 'confirmed' | 'failed' | 'unknown'
  readonly completed: number
  readonly requested: number
  readonly items?: readonly AgentDiceItem[]
}
export interface AgentDiceLedgerSource { readonly target: ConversationAddress; readonly agentId: string; readonly authorId: string; readonly messageId: string }
interface Redis {
  get(key: string): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
const ROOT = 'agent:dice:v1'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = () => new Error('骰子持久状态不可用')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function indexes(source: AgentDiceLedgerSource) {
  return { operation: hash([conversationAddressKey(source.target), source.messageId]),
    global: hash([platformAccountKey(source.target.account), source.agentId, source.authorId]),
    scene: hash([conversationAddressKey(source.target), source.agentId, source.authorId]) }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(invalid()), 5_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
function decode(raw: unknown): AgentDiceRecord | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== 'string') throw invalid()
  const row = JSON.parse(raw) as AgentDiceRecord
  if (!row || Object.keys(row).some(key => !['version', 'bindingHash', 'sourceHash', 'globalIndex', 'sceneIndex', 'state', 'completed', 'requested', 'items'].includes(key)) ||
      row.version !== 1 || !digest(row.bindingHash) || !digest(row.sourceHash) || !digest(row.globalIndex) || !digest(row.sceneIndex) ||
      !['ready', 'pending', 'confirmed', 'failed', 'unknown'].includes(row.state) || !Number.isSafeInteger(row.requested) || row.requested < 1 || row.requested > 5 ||
      !Number.isSafeInteger(row.completed) || row.completed < 0 || row.completed > row.requested) throw invalid()
  if (row.state === 'ready' || row.state === 'pending') {
    if (!Array.isArray(row.items) || row.items.length !== row.requested || row.items.some((item, index) => !item ||
        Object.keys(item).some(key => !['eventId', 'text', 'result'].includes(key)) || !digest(item.eventId) ||
        typeof item.result !== 'boolean' || typeof item.text !== 'string' || item.text.length > 8_000 || (index >= row.completed && !item.text.trim()))) throw invalid()
  } else if (Object.hasOwn(row, 'items')) throw invalid()
  return row
}
const COMMON = `
local root = KEYS[1]
local operation, global, scene = ARGV[1], ARGV[2], ARGV[3]
local key = root .. ':operation:' .. operation
local function epoch(scope, id) return redis.call('HGET', root .. ':' .. scope .. '-epochs', id) or '0' end
local function current()
  return epoch('global', global) == ARGV[4] and epoch('scene', scene) == ARGV[5]
    and redis.call('HGET', root .. ':recalls', operation) ~= '1'
end
local function digest(value) return type(value) == 'string' and #value == 64 and not string.find(value, '[^a-f0-9]') end
local function unindex(row, id)
  if digest(row.globalIndex) then redis.call('SREM', root .. ':active:global:' .. row.globalIndex, id) end
  if digest(row.sceneIndex) then redis.call('SREM', root .. ':active:scene:' .. row.sceneIndex, id) end
end
local function scrub(id)
  local selected = root .. ':operation:' .. id
  local kind = redis.call('TYPE', selected).ok
  if kind == 'none' then return 0 end
  if kind ~= 'string' then redis.call('SET', selected, '{"state":"unknown"}'); return 1 end
  local raw = redis.call('GET', selected)
  if not raw then return 0 end
  local ok, row = pcall(cjson.decode, raw)
  if not ok or type(row) ~= 'table' then redis.call('SET', selected, '{"state":"unknown"}'); return 1 end
  unindex(row, id)
  if not digest(row.bindingHash) or not digest(row.sourceHash) or not digest(row.globalIndex) or not digest(row.sceneIndex)
    or type(row.requested) ~= 'number' or row.requested < 1 or row.requested > 5 or row.requested % 1 ~= 0
    or type(row.completed) ~= 'number' or row.completed < 0 or row.completed > row.requested or row.completed % 1 ~= 0
    then redis.call('SET', selected, '{"state":"unknown"}'); return 1 end
  local tombstone = {version=1, state='unknown', bindingHash=row.bindingHash, sourceHash=row.sourceHash,
    globalIndex=row.globalIndex, sceneIndex=row.sceneIndex, completed=row.completed, requested=row.requested}
  redis.call('SET', selected, cjson.encode(tombstone))
  return 1
end
`
const CAPTURE = COMMON + `return {epoch('global', global), epoch('scene', scene), redis.call('HGET', root .. ':recalls', operation) or '0'}`
const PREPARE = COMMON + `
if not current() or redis.call('EXISTS', key) == 1 then return 0 end
redis.call('SET', key, ARGV[6])
redis.call('SADD', root .. ':active:global:' .. global, operation)
redis.call('SADD', root .. ':active:scene:' .. scene, operation)
return 1
`
const CHANGE = COMMON + `
if not current() or redis.call('GET', key) ~= ARGV[6] then return 0 end
local row = cjson.decode(ARGV[7])
redis.call('SET', key, ARGV[7])
if row.state ~= 'ready' and row.state ~= 'pending' then unindex(row, operation) end
return 1
`
const RECALL = COMMON + `redis.call('HSET', root .. ':recalls', operation, '1'); return scrub(operation)`
const PURGE = COMMON + `
local scope, id = ARGV[6], ARGV[7]
redis.call('HINCRBY', root .. ':' .. scope .. '-epochs', id, 1)
local index = root .. ':active:' .. scope .. ':' .. id
local removed = 0
for _, operationId in ipairs(redis.call('SMEMBERS', index)) do removed = removed + scrub(operationId) end
redis.call('DEL', index)
return removed
`
export function createAgentDiceLedger(redis: Redis) {
  const evaluate = (script: string, args: string[]) => bounded(redis.eval(script, { keys: [ROOT], arguments: args }))
  const args = (source: AgentDiceLedgerSource, epochs?: { global: string; scene: string }) => {
    const index = indexes(source)
    return [index.operation, index.global, index.scene, epochs?.global ?? '0', epochs?.scene ?? '0']
  }
  return {
    async capture(source: AgentDiceLedgerSource): Promise<{ global: string; scene: string; recalled: boolean }> {
      const row = await evaluate(CAPTURE, args(source))
      if (!Array.isArray(row) || row.length !== 3 || row.some(value => typeof value !== 'string' || !/^\d{1,16}$/u.test(value))) throw invalid()
      return { global: row[0], scene: row[1], recalled: row[2] === '1' }
    },
    async read(source: AgentDiceLedgerSource): Promise<{ record: AgentDiceRecord; raw: string } | undefined> {
      const raw = await bounded(redis.get(ROOT + ':operation:' + indexes(source).operation)), record = decode(raw)
      return record ? { record, raw: raw as string } : undefined
    },
    async prepare(source: AgentDiceLedgerSource, binding: AgentBindingSnapshot, sourceHash: string, items: readonly AgentDiceItem[], epochs: { global: string; scene: string }) {
      if (binding.agentId !== source.agentId || conversationAddressKey(binding.target) !== conversationAddressKey(source.target)) throw invalid()
      const index = indexes(source)
      const record: AgentDiceRecord = { version: 1, bindingHash: hash(agentBindingToken(binding)), sourceHash, globalIndex: index.global, sceneIndex: index.scene,
        state: 'ready', completed: 0, requested: items.length, items }
      const raw = JSON.stringify(record); decode(raw)
      return Number(await evaluate(PREPARE, [...args(source, epochs), raw])) === 1 ? { record, raw } : undefined
    },
    async change(source: AgentDiceLedgerSource, before: { raw: string }, record: AgentDiceRecord, epochs: { global: string; scene: string }) {
      const previous = decode(before.raw), index = indexes(source)
      if (!previous || previous.globalIndex !== index.global || previous.sceneIndex !== index.scene ||
          (['bindingHash', 'sourceHash', 'globalIndex', 'sceneIndex', 'requested'] as const).some(key => previous[key] !== record[key])) throw invalid()
      const raw = JSON.stringify(record); decode(raw)
      return Number(await evaluate(CHANGE, [...args(source, epochs), before.raw, raw])) === 1 ? { record, raw } : undefined
    },
    async revokeSource(target: ConversationAddress, messageId: string) {
      return evaluate(RECALL, args({ target, agentId: '', authorId: '', messageId }))
    },
    async purgeSubject(input: { account: PlatformAccountRef; agentId: string; subjectId: string; target?: ConversationAddress }) {
      const target = input.target ?? { account: input.account, kind: 'group' as const, id: '_' }
      const source = { target, agentId: input.agentId, authorId: input.subjectId, messageId: '_' }, index = indexes(source)
      return evaluate(PURGE, [...args(source), input.target ? 'scene' : 'global', input.target ? index.scene : index.global])
    },
    bindingHash: (binding: AgentBindingSnapshot) => hash(agentBindingToken(binding)),
  }
}
