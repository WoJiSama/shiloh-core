import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentTorrentMetadata } from '../../../contracts/agentTorrent.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { parseMagnetUri } from './torrentDownload.js'

export interface AgentTorrentSource {
  readonly messageId: string
  readonly sender: PlatformUserRef
  readonly occurredAt: number
}
export type AgentTorrentStage = 'notice' | 'listing' | 'archive' | 'confirmation' | 'failure'
type State = 'queued' | 'preparing' | 'sending' | 'awaiting-selection' | 'completed' | 'failed' | 'cancelled' | 'unknown'
type Receipt = DeliveryReceipt | FileDeliveryReceipt
export interface AgentTorrentRecord {
  readonly version: 1
  readonly id: string
  readonly binding: AgentBindingSnapshot
  readonly trigger: AgentTorrentSource
  readonly source: AgentTorrentSource
  readonly state: State
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly stages: readonly {
    readonly stage: AgentTorrentStage
    readonly state: 'pending' | 'sent' | 'uploaded' | 'failed' | 'unknown'
    readonly beganAt: number
    readonly finishedAt?: number
    readonly receipt?: Receipt
  }[]
}
export interface AgentTorrentSelection {
  readonly version: 1
  readonly id: string
  readonly binding: AgentBindingSnapshot
  readonly source: AgentTorrentSource
  readonly magnet: string
  readonly metadata: AgentTorrentMetadata
  readonly selectableIndexes: readonly number[]
  readonly listingParts: number
  readonly createdAt: number
  readonly expiresAt: number
  readonly state: 'pending' | 'ready' | 'reserved'
  readonly reservedBy?: string
}
export interface AgentTorrentSession {
  readonly record: AgentTorrentRecord
  preparing(): Promise<void>
  begin(stage: AgentTorrentStage): Promise<void>
  finish(stage: AgentTorrentStage, receipt: Receipt): Promise<void>
  close(state: 'completed' | 'failed' | 'cancelled' | 'awaiting-selection' | 'unknown'): Promise<void>
  saveSelection(input: { readonly magnet: string; readonly metadata: AgentTorrentMetadata; readonly selectableIndexes: readonly number[]; readonly ttlSeconds?: number; readonly listingParts?: number }): Promise<void>
  abandon(): void
}
export interface AgentTorrentSelectionReservation {
  readonly selection: AgentTorrentSelection
  readonly session: AgentTorrentSession
  commit(): Promise<void>
  release(): Promise<void>
}

const PREFIX = 'agent:torrent:v1:', ACTIVE = PREFIX + 'active', SELECTIONS = PREFIX + 'selections'
const RETENTION = 604800, LIFETIME = 86400000, MAX_BYTES = 1048576
const stageNames = new Set<AgentTorrentStage>(['notice', 'listing', 'archive', 'confirmation', 'failure'])
const terminal = new Set<State>(['awaiting-selection', 'completed', 'failed', 'cancelled', 'unknown'])
const states = new Set<State>(['queued', 'preparing', 'sending', ...terminal])
const ownership = new WeakMap<AgentInboxRedis, Map<string, string>>()
const fail = () => new Error('磁链下载账本不可用或任务已失效')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const hex = (value: unknown, length = 64): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
const safeId = (value: unknown, max = 128): value is string => text(value, max) && !/^0+$/u.test(value) && !/(?:https?|file|data|base64):/iu.test(value)
const jobKey = (id: string) => PREFIX + 'job:' + id
const ownerKey = (id: string) => PREFIX + 'owner:' + id
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw fail()
  return value as Record<string, unknown>
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) throw fail()
  const result: unknown[] = []
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw fail()
    result.push(field.value)
  }
  return result
}
function user(input: unknown): PlatformUserRef {
  const value = closed(input, ['platform', 'namespace', 'id'])
  if (![value.platform, value.namespace, value.id].every(part => safeId(part)) || !isPlatformAccount(value as unknown as PlatformUserRef)) throw fail()
  return { platform: value.platform as string, namespace: value.namespace as string, id: value.id as string }
}
function target(input: unknown): ConversationAddress {
  const value = closed(input, ['account', 'kind', 'id']), account = user(value.account)
  if (value.kind !== 'group' || !safeId(value.id)) throw fail()
  const result = { account, kind: 'group' as const, id: value.id }
  if (!isConversationAddress(result)) throw fail()
  return result
}
function bindingValue(input: unknown): AgentBindingSnapshot {
  const value = closed(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']), selected = target(value.target)
  if (value.source !== 'configured' || value.id !== conversationAddressKey(selected) || !safeId(value.revision, 4096) ||
    ![value.agentId, value.personaId, value.connectionId].every(part => safeId(part, 64))) throw fail()
  return { source: 'configured', id: value.id, revision: value.revision, agentId: value.agentId as string,
    personaId: value.personaId as string, connectionId: value.connectionId as string, target: selected }
}
function sourceValue(input: unknown, binding: AgentBindingSnapshot): AgentTorrentSource {
  const value = closed(input, ['messageId', 'sender', 'occurredAt']), sender = user(value.sender)
  if (!safeId(value.messageId) || !integer(value.occurredAt) || !value.occurredAt || sender.id === binding.target.account.id ||
    sender.platform !== binding.target.account.platform || sender.namespace !== binding.target.account.namespace) throw fail()
  return { messageId: value.messageId, sender, occurredAt: value.occurredAt }
}
const sameSource = (a: AgentTorrentSource, b: AgentTorrentSource) => a.messageId === b.messageId && a.occurredAt === b.occurredAt && platformAccountKey(a.sender) === platformAccountKey(b.sender)
const scope = (binding: AgentBindingSnapshot, sender: PlatformUserRef) => hash(JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding), platformAccountKey(sender)]))
const physicalSource = (selected: ConversationAddress, messageId: string) => hash(JSON.stringify([selected.account.platform, selected.account.namespace, selected.kind, selected.id, messageId]))
const cancelKey = (selected: ConversationAddress, messageId: string) => PREFIX + 'cancel:' + physicalSource(selected, messageId)
const selectionKey = (selected: string) => PREFIX + 'selection:' + selected
export function agentTorrentId(binding: AgentBindingSnapshot, trigger: AgentTorrentSource): string {
  try {
    const selected = bindingValue(binding), source = sourceValue(trigger, selected)
    return hash(JSON.stringify([scope(selected, source.sender), source.messageId]))
  } catch { throw fail() }
}
function metadataValue(input: unknown): AgentTorrentMetadata {
  const value = closed(input, ['infoHash', 'fingerprint', 'name', 'files', 'totalBytes'])
  const inputs = array(value.files, 2048)
  if (typeof value.infoHash !== 'string' || !/^[A-F0-9]{40}$/u.test(value.infoHash) || !hex(value.fingerprint) || !text(value.name, 180) ||
    /[/\\]/u.test(value.name) || value.name === '.' || value.name === '..' || !inputs.length || !integer(value.totalBytes)) throw fail()
  let total = 0
  const paths = new Set<string>()
  const files = inputs.map((input, offset) => {
    const row = closed(input, ['index', 'relativePath', 'size'])
    const relativePath = array(row.relativePath, 32)
    if (row.index !== offset + 1 || !integer(row.size) || !row.size || !relativePath.length ||
      relativePath.some(part => !text(part, 180) || part === '.' || part === '..' || /[/\\]/u.test(part as string)) || relativePath[0] !== value.name) throw fail()
    const path = JSON.stringify(relativePath)
    if (paths.has(path)) throw fail()
    paths.add(path); total += row.size
    if (!Number.isSafeInteger(total)) throw fail()
    return { index: offset + 1, relativePath: relativePath as string[], size: row.size }
  })
  if (total !== value.totalBytes) throw fail()
  return { infoHash: value.infoHash, fingerprint: value.fingerprint, name: value.name, files, totalBytes: total }
}
function receiptValue(stage: AgentTorrentStage, input: unknown): Receipt {
  const value = closed(input, ['state', 'code', 'messageId', 'fileId'])
  if (value.state === 'failed') return { state: 'failed', code: null }
  if (value.state === 'unknown') return { state: 'unknown' }
  if (stage === 'archive' && value.state === 'uploaded' && safeId(value.fileId, 1024) && (value.messageId === undefined || safeId(value.messageId))) {
    return { state: 'uploaded', fileId: value.fileId, ...(value.messageId === undefined ? {} : { messageId: value.messageId }) }
  }
  if (stage !== 'archive' && value.state === 'sent' && safeId(value.messageId)) return { state: 'sent', messageId: value.messageId }
  return { state: 'unknown' }
}
function bytes(input: unknown): string { const raw = JSON.stringify(input); if (Buffer.byteLength(raw) > MAX_BYTES) throw fail(); return raw }
function parseRecord(raw: string): AgentTorrentRecord {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw fail()
    const value = closed(JSON.parse(raw), ['version', 'id', 'binding', 'trigger', 'source', 'state', 'createdAt', 'updatedAt', 'expiresAt', 'stages'])
    const binding = bindingValue(value.binding), trigger = sourceValue(value.trigger, binding), source = sourceValue(value.source, binding)
    if (value.version !== 1 || value.id !== agentTorrentId(binding, trigger) || platformAccountKey(trigger.sender) !== platformAccountKey(source.sender) ||
      !states.has(value.state as State) || !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt || !integer(value.expiresAt) ||
      value.expiresAt - value.createdAt !== LIFETIME || !Array.isArray(value.stages) || value.stages.length > 516) throw fail()
    const createdAt = value.createdAt, updatedAt = value.updatedAt
    const seen = new Set<string>()
    const stages = value.stages.map((input, index) => {
      const row = closed(input, ['stage', 'state', 'beganAt', 'finishedAt', 'receipt']), stage = row.stage as AgentTorrentStage
      if (!stageNames.has(stage) || seen.has(stage) && stage !== 'listing' || !integer(row.beganAt) || row.beganAt < createdAt || row.beganAt > updatedAt) throw fail()
      seen.add(stage)
      if (row.state === 'pending') {
        if (row.finishedAt !== undefined || row.receipt !== undefined || value.state !== 'sending' || index !== (value.stages as unknown[]).length - 1) throw fail()
        return { stage, state: 'pending' as const, beganAt: row.beganAt }
      }
      const receipt = receiptValue(stage, row.receipt)
      if (!integer(row.finishedAt) || row.finishedAt < row.beganAt || row.finishedAt > updatedAt || row.state !== receipt.state ||
        JSON.stringify(receipt) !== JSON.stringify(row.receipt) || receipt.state === 'unknown' && (value.state !== 'unknown' || index !== (value.stages as unknown[]).length - 1)) throw fail()
      return { stage, state: receipt.state, beganAt: row.beganAt, finishedAt: row.finishedAt, receipt }
    })
    const listings = stages.filter(row => row.stage === 'listing')
    if (listings.length > 512 || listings.slice(0, -1).some(row => row.state !== 'sent')) throw fail()
    if (stages.length && ['queued', 'preparing', 'cancelled'].includes(value.state as string) || value.state === 'sending' && !stages.length ||
      value.state === 'awaiting-selection' && (!listings.length || listings.some(row => row.state !== 'sent')) ||
      value.state === 'completed' && stages.find(row => row.stage === 'archive')?.state !== 'uploaded' ||
      value.state === 'failed' && stages.some(row => row.state === 'unknown' || row.state === 'pending')) throw fail()
    return freeze({ version: 1, id: value.id as string, binding, trigger, source, state: value.state as State,
      createdAt: value.createdAt, updatedAt: value.updatedAt, expiresAt: value.expiresAt, stages })
  } catch { throw fail() }
}
function parseSelection(raw: string): AgentTorrentSelection {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw fail()
    const value = closed(JSON.parse(raw), ['version', 'id', 'binding', 'source', 'magnet', 'metadata', 'selectableIndexes', 'listingParts', 'createdAt', 'expiresAt', 'state', 'reservedBy'])
    const binding = bindingValue(value.binding), source = sourceValue(value.source, binding), metadata = metadataValue(value.metadata)
    if (value.version !== 1 || value.id !== agentTorrentId(binding, source) || !text(value.magnet, 16384) || parseMagnetUri(value.magnet).infoHash !== metadata.infoHash ||
      !integer(value.createdAt) || !integer(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 1800000 ||
      !['pending', 'ready', 'reserved'].includes(value.state as string) || !integer(value.listingParts ?? 1) || Number(value.listingParts ?? 1) < 1 || Number(value.listingParts ?? 1) > 512 ||
      (value.state === 'reserved' ? !hex(value.reservedBy) : value.reservedBy !== undefined) ||
      !Array.isArray(value.selectableIndexes) || !value.selectableIndexes.length || value.selectableIndexes.length > metadata.files.length ||
      value.selectableIndexes.some(index => !integer(index) || index < 1 || index > metadata.files.length) || new Set(value.selectableIndexes).size !== value.selectableIndexes.length) throw fail()
    return freeze({ version: 1, id: value.id as string, binding, source, magnet: value.magnet, metadata, selectableIndexes: [...value.selectableIndexes] as number[],
      listingParts: Number(value.listingParts ?? 1),
      createdAt: value.createdAt, expiresAt: value.expiresAt, state: value.state as AgentTorrentSelection['state'], ...(value.reservedBy === undefined ? {} : { reservedBy: value.reservedBy as string }) })
  } catch { throw fail() }
}

const preflight = `
local function types(expected)
  for i, wanted in ipairs(expected) do local actual = redis.call('TYPE', KEYS[i]).ok
    if actual ~= 'none' and actual ~= wanted then error('invalid torrent ledger key type') end
  end
end
local function hex(value) return value and #value == 64 and string.match(value, '^[a-f0-9]+$') end
local function index(key, maximum, active)
  local rows = redis.call('HGETALL', key)
  if #rows > maximum * 2 then error('invalid torrent ledger index size') end
  for i = 1, #rows, 2 do if not hex(rows[i]) or (active and rows[i + 1] ~= '1') or (not active and not hex(rows[i + 1])) then error('invalid torrent ledger index') end end
end
local function selectionTtl(raw)
  local value = tonumber(raw)
  if not value or value < 1 or value > 1800000 or value ~= math.floor(value) then error('invalid torrent selection lifetime') end
  return value
end
`
const claimScript = `${preflight}
types({'string','hash','string','string','string','string','string','hash'})
index(KEYS[2], 8, true); index(KEYS[8], 128, false)
local admission = redis.call('GET', KEYS[6])
if admission and not hex(admission) then error('invalid torrent source admission') end
if admission and admission ~= ARGV[3] then return 0 end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1 then return 0 end
local before = redis.call('GET', KEYS[1])
if (before or '') ~= ARGV[1] then return 0 end
if not before and redis.call('HLEN', KEYS[2]) >= 8 then return -1 end
local ttl
if ARGV[5] == '1' then
  if (redis.call('GET', KEYS[7]) or '') ~= ARGV[6] then return 0 end
  ttl = selectionTtl(ARGV[8])
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', 604800)
redis.call('SET', KEYS[3], ARGV[4], 'EX', 604800)
redis.call('HSET', KEYS[2], ARGV[3], '1')
if not admission then redis.call('SET', KEYS[6], ARGV[3], 'EX', 604800) end
if ttl then redis.call('SET', KEYS[7], ARGV[7], 'PX', ttl) end
return 1`
const writeScript = `${preflight}
types({'string','hash','string','string','string','string','hash'})
index(KEYS[2], 8, true); index(KEYS[7], 128, false)
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[4] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[4] then return 0 end
if ARGV[6] ~= '1' and (redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[5]) == 1) then return 0 end
local ttl
if ARGV[7] ~= 'keep' then
  if (redis.call('GET', KEYS[6]) or '') ~= ARGV[8] then return 0 end
  if ARGV[7] == 'set' then
    ttl = selectionTtl(ARGV[10])
    if redis.call('HEXISTS', KEYS[7], ARGV[11]) == 0 and redis.call('HLEN', KEYS[7]) >= 128 then error('torrent selection capacity exhausted') end
  elseif ARGV[7] ~= 'delete' then error('invalid torrent selection mutation') end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', 604800)
if ARGV[5] == '1' then redis.call('HDEL', KEYS[2], ARGV[3]); redis.call('DEL', KEYS[3]) end
if ttl then redis.call('SET', KEYS[6], ARGV[9], 'PX', ttl); redis.call('HSET', KEYS[7], ARGV[11], ARGV[12])
elseif ARGV[7] == 'delete' then redis.call('DEL', KEYS[6]); redis.call('HDEL', KEYS[7], ARGV[11]) end
return 1`
const releaseOwner = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`

/** Uses the enclosing host's execution lease; it does not introduce a second distributed lease. */
export function createAgentTorrentLedger(storage: AgentInboxRedis, options: { now?(): number } = {}) {
  let owners = ownership.get(storage)
  if (!owners) { owners = new Map(); ownership.set(storage, owners) }
  const owned = owners, runId = randomUUID()
  const reservationTransitions = new WeakMap<AgentTorrentSession, (change: SelectionChange) => Promise<void>>()
  const now = (minimum = 0) => { const at = (options.now ?? Date.now)(); if (!integer(at)) throw fail(); return Math.max(at, minimum) }
  const validId = (id: string) => { if (!hex(id)) throw fail(); return id }
  async function load(id: string) { const raw = await storage.get(jobKey(validId(id))); return raw === null ? undefined : { raw, record: parseRecord(raw) } }
  async function selection(binding: AgentBindingSnapshot, sender: PlatformUserRef) {
    const key = scope(binding, sender), raw = await storage.get(selectionKey(key))
    if (raw === null) return undefined
    const record = parseSelection(raw)
    if (scope(record.binding, record.source.sender) !== key) throw fail()
    return { key, raw, record }
  }
  async function entries(key: string, max: number): Promise<[string, string][]> {
    const result = await storage.eval('return redis.call("HGETALL", KEYS[1])', { keys: [key], arguments: [] })
    if (!Array.isArray(result) || result.length > max * 2 || result.length % 2) throw fail()
    const rows: [string, string][] = []
    for (let at = 0; at < result.length; at += 2) {
      if (!hex(result[at]) || typeof result[at + 1] !== 'string' || (key === ACTIVE ? result[at + 1] !== '1' : !hex(result[at + 1]))) throw fail()
      rows.push([result[at] as string, result[at + 1] as string])
    }
    return rows
  }
  type SelectionChange = { before: string; next?: AgentTorrentSelection }
  async function write(before: string, record: AgentTorrentRecord, token = '', allowCancelled = false, change?: SelectionChange) {
    const raw = bytes(record), selected = scope(record.binding, record.source.sender)
    parseRecord(raw)
    const next = change?.next && bytes(change.next)
    if (next) parseSelection(next)
    const result = await storage.eval(writeScript, { keys: [jobKey(record.id), ACTIVE, ownerKey(record.id), cancelKey(record.binding.target, record.trigger.messageId),
      cancelKey(record.binding.target, record.source.messageId), selectionKey(selected), SELECTIONS],
    arguments: [before, raw, record.id, token, terminal.has(record.state) ? '1' : '0', allowCancelled ? '1' : '0', change ? next ? 'set' : 'delete' : 'keep',
      change?.before ?? '', next || '', next ? String(change!.next!.expiresAt - now()) : '', selected, change?.next?.id ?? ''] })
    if (Number(result) !== 1) throw fail()
    return raw
  }
  function ended(record: AgentTorrentRecord, state: 'cancelled' | 'unknown'): AgentTorrentRecord {
    const at = now(record.updatedAt)
    return { ...record, state: record.stages.length ? 'unknown' : state, updatedAt: at, stages: record.stages.map(row => row.state === 'pending'
      ? { ...row, state: 'unknown', finishedAt: at, receipt: { state: 'unknown' } } : row) }
  }
  async function forgetSelection(key: string, before: string) {
    const script = `${preflight}\ntypes({'string','hash'}); index(KEYS[2],128,false)\nif redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end\nredis.call('DEL',KEYS[1]); redis.call('HDEL',KEYS[2],ARGV[2]); return 1`
    await storage.eval(script, { keys: [selectionKey(key), SELECTIONS], arguments: [before, key] })
  }
  async function listActive() {
    const result: AgentTorrentRecord[] = []
    for (const [id] of await entries(ACTIVE, 8)) {
      const current = await load(id)
      if (!current) {
        await storage.eval(`${preflight}\ntypes({'string','hash'}); index(KEYS[2],8,true)\nif redis.call('EXISTS',KEYS[1]) == 0 then redis.call('HDEL',KEYS[2],ARGV[1]) end return 1`, { keys: [jobKey(id), ACTIVE], arguments: [id] })
      } else if (terminal.has(current.record.state)) await write(current.raw, current.record, '', true)
      else result.push(current.record)
    }
    return Object.freeze(result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)))
  }
  async function recover() {
    for (const current of await listActive()) {
      if (owned.has(current.id)) continue
      const row = await load(current.id)
      if (!row || owned.has(current.id) || terminal.has(row.record.state)) continue
      const record = row.record
      const cancelled = record.expiresAt <= now() || await storage.get(cancelKey(record.binding.target, record.source.messageId)) !== null ||
        await storage.get(cancelKey(record.binding.target, record.trigger.messageId)) !== null
      const next = record.stages.length ? ended(record, 'unknown') : cancelled ? ended(record, 'cancelled') : { ...record, state: 'queued' as const, updatedAt: now(record.updatedAt) }
      const selected = await selection(record.binding, record.source.sender)
      const removes = selected && (selected.record.id === record.id && selected.record.state === 'pending' || selected.record.reservedBy === record.id) && terminal.has(next.state)
      await write(row.raw, next, '', true, removes ? { before: selected!.raw } : undefined)
      const owner = await storage.get(ownerKey(record.id))
      if (owner) await storage.eval(releaseOwner, { keys: [ownerKey(record.id)], arguments: [owner] })
    }
    for (const [key] of await entries(SELECTIONS, 128)) {
      const raw = await storage.get(selectionKey(key))
      if (raw === null) {
        await storage.eval(`${preflight}\ntypes({'string','hash'}); index(KEYS[2],128,false)\nif redis.call('EXISTS',KEYS[1]) == 0 then redis.call('HDEL',KEYS[2],ARGV[1]) end return 1`, { keys: [selectionKey(key), SELECTIONS], arguments: [key] })
        continue
      }
      const selected = parseSelection(raw)
      if (key !== scope(selected.binding, selected.source.sender)) throw fail()
      if (selected.expiresAt <= now() || await storage.get(cancelKey(selected.binding.target, selected.source.messageId)) !== null) await forgetSelection(key, raw)
    }
  }
  async function claimInternal(binding: AgentBindingSnapshot, trigger: AgentTorrentSource, source: AgentTorrentSource, reserve?: { raw: string; next: AgentTorrentSelection }) {
    const id = agentTorrentId(binding, trigger)
    if (owned.has(id)) return undefined
    const token = `${runId}:${randomUUID()}`; owned.set(id, token)
    let held = true, busy = false, raw = '', record: AgentTorrentRecord
    const abandon = () => { if (!held) return; held = false; if (owned.get(id) === token) owned.delete(id); void storage.eval(releaseOwner, { keys: [ownerKey(id)], arguments: [token] }).catch(() => {}) }
    try {
      const existing = await load(id), at = now()
      if (existing && (existing.record.state !== 'queued' || existing.record.stages.length || existing.record.expiresAt <= at || !sameSource(existing.record.trigger, trigger) || !sameSource(existing.record.source, source))) { abandon(); return undefined }
      record = existing?.record ?? { version: 1, id, binding, trigger, source, state: 'queued', createdAt: at, updatedAt: at, expiresAt: at + LIFETIME, stages: [] }
      raw = bytes(record); parseRecord(raw)
      const selected = scope(binding, source.sender), next = reserve && bytes(reserve.next)
      if (next) parseSelection(next)
      const result = Number(await storage.eval(claimScript, { keys: [jobKey(id), ACTIVE, ownerKey(id), cancelKey(binding.target, trigger.messageId), cancelKey(binding.target, source.messageId),
        PREFIX + 'admission:' + physicalSource(binding.target, trigger.messageId), selectionKey(selected), SELECTIONS],
      arguments: [existing?.raw ?? '', raw, id, token, reserve ? '1' : '0', reserve?.raw ?? '', next ?? '', reserve ? String(reserve.next.expiresAt - now()) : ''] }))
      if (result === -1) throw fail()
      if (result !== 1) { abandon(); return undefined }
      record = parseRecord(raw)
    } catch { abandon(); throw fail() }
    async function mutate(change: () => AgentTorrentRecord, selected?: SelectionChange) {
      if (!held || busy || owned.get(id) !== token || terminal.has(record.state)) throw fail()
      const next = change()
      parseRecord(bytes(next))
      busy = true
      try { raw = await write(raw, next, token, false, selected); record = parseRecord(raw); if (!held || owned.get(id) !== token) throw fail(); if (terminal.has(record.state)) abandon() }
      catch { abandon(); throw fail() }
      finally { busy = false }
    }
    const session: AgentTorrentSession = {
      get record() { return record }, abandon,
      async preparing() { await mutate(() => { if (record.state !== 'queued' || record.expiresAt <= now()) throw fail(); return { ...record, state: 'preparing', updatedAt: now(record.updatedAt) } }) },
      async begin(stage) {
        const selected = stage === 'listing' ? await selection(record.binding, record.source.sender) : undefined
        await mutate(() => {
        const prior = record.stages.filter(row => row.stage === stage)
        const listingAllowed = stage === 'listing' && selected?.record.id === id && selected.record.state === 'pending' &&
          prior.length < selected.record.listingParts && prior.every(row => row.state === 'sent')
        if (!stageNames.has(stage) || !['preparing', 'sending'].includes(record.state) || record.expiresAt <= now() ||
          record.stages.some(row => row.state === 'pending' || row.state === 'unknown') || (stage === 'listing' ? !listingAllowed : prior.length > 0)) throw fail()
        const at = now(record.updatedAt)
        return { ...record, state: 'sending', updatedAt: at, stages: [...record.stages, { stage, state: 'pending', beganAt: at }] }
      }) },
      async finish(stage, input) {
        let receipt: Receipt
        try { receipt = receiptValue(stage, input) } catch { receipt = { state: 'unknown' } }
        const selected = await selection(record.binding, record.source.sender)
        let change: SelectionChange | undefined
        if (selected && selected.record.id === id && selected.record.state === 'pending' && stage === 'listing') {
          const sentParts = record.stages.filter(row => row.stage === 'listing' && row.state === 'sent').length
          if (receipt.state !== 'sent' || sentParts + 1 === selected.record.listingParts) change = { before: selected.raw,
            ...(receipt.state === 'sent' ? { next: { ...selected.record, state: 'ready' } } : {}) }
        }
        if (selected && selected.record.reservedBy === id && receipt.state === 'unknown') change = { before: selected.raw }
        await mutate(() => {
          const pending = record.stages.at(-1), at = now(record.updatedAt)
          if (!stageNames.has(stage) || pending?.stage !== stage || pending.state !== 'pending') throw fail()
          return { ...record, state: receipt.state === 'unknown' ? 'unknown' : 'sending', updatedAt: at,
            stages: [...record.stages.slice(0, -1), { ...pending, state: receipt.state, finishedAt: at, receipt }] }
        }, change)
      },
      async close(state) {
        const selected = await selection(record.binding, record.source.sender)
        const removes = selected && state !== 'awaiting-selection' && (selected.record.id === id && (state === 'unknown' || selected.record.state === 'pending') || selected.record.reservedBy === id)
        const releases = selected?.record.reservedBy === id && state === 'failed' && selected.record.expiresAt > now() &&
          !record.stages.some(row => row.stage === 'archive' || row.state === 'pending' || row.state === 'unknown')
        const { reservedBy: _reservedBy, ...ready } = selected?.record ?? {} as AgentTorrentSelection
        await mutate(() => {
          if (!['completed', 'failed', 'cancelled', 'awaiting-selection', 'unknown'].includes(state) || state !== 'unknown' && record.stages.some(row => row.state === 'pending' || row.state === 'unknown')) throw fail()
          if (state === 'awaiting-selection' && (!selected || selected.record.id !== id || selected.record.state !== 'ready' ||
            record.stages.filter(row => row.stage === 'listing' && row.state === 'sent').length !== selected.record.listingParts)) throw fail()
          if (state === 'unknown') return ended(record, 'unknown')
          const value = state === 'cancelled' && record.stages.length ? 'unknown' : state
          return { ...record, state: value, updatedAt: now(record.updatedAt) }
        }, removes ? { before: selected!.raw, ...(releases ? { next: { ...ready, state: 'ready' as const } as AgentTorrentSelection } : {}) } : undefined)
      },
      async saveSelection(input) {
        try {
        const value = closed(input, ['magnet', 'metadata', 'selectableIndexes', 'ttlSeconds', 'listingParts'])
        if (!sameSource(record.trigger, record.source) || record.stages.some(row => row.stage === 'listing' || row.stage === 'archive') ||
          value.ttlSeconds !== undefined && (!integer(value.ttlSeconds) || value.ttlSeconds < 1 || value.ttlSeconds > 1800)) throw fail()
        if (value.listingParts !== undefined && (!integer(value.listingParts) || value.listingParts < 1 || value.listingParts > 512)) throw fail()
        if (!text(value.magnet, 16384)) throw fail()
        const metadata = metadataValue(value.metadata), selectableIndexes = array(value.selectableIndexes, 2048)
        if (selectableIndexes.some(index => !integer(index))) throw fail()
        const ttl = value.ttlSeconds === undefined ? 1800 : value.ttlSeconds
        const at = now(), next = parseSelection(bytes({ version: 1, id, binding: record.binding, source: record.source, magnet: value.magnet,
          metadata, selectableIndexes, listingParts: value.listingParts ?? 1, createdAt: at, expiresAt: at + (ttl as number) * 1000, state: 'pending' }))
        const before = await selection(record.binding, record.source.sender)
        if (before?.record.state === 'reserved' && before.record.expiresAt > at) throw fail()
        await mutate(() => ({ ...record, updatedAt: now(record.updatedAt) }), { before: before?.raw ?? '', next })
        } catch { throw fail() }
      },
    }
    reservationTransitions.set(session, change => mutate(() => ({ ...record, updatedAt: now(record.updatedAt) }), change))
    return session
  }
  const api = {
    async claim(inputBinding: AgentBindingSnapshot, inputTrigger: AgentTorrentSource, inputSource: AgentTorrentSource = inputTrigger) {
      try {
        const binding = bindingValue(inputBinding), trigger = sourceValue(inputTrigger, binding), source = sourceValue(inputSource, binding)
        if (platformAccountKey(trigger.sender) !== platformAccountKey(source.sender)) throw fail()
        await recover(); return await claimInternal(binding, trigger, source)
      } catch { throw fail() }
    },
    async inspect(id: string) { try { return (await load(id))?.record } catch { throw fail() } },
    async listActive() { try { return await listActive() } catch { throw fail() } },
    async recover() { try { await recover(); return await listActive() } catch { throw fail() } },
    async readSelection(inputBinding: AgentBindingSnapshot, inputSender: PlatformUserRef) {
      try {
        const binding = bindingValue(inputBinding), sender = user(inputSender), selected = await selection(binding, sender)
        if (!selected || selected.record.state !== 'ready') return undefined
        if (selected.record.expiresAt <= now() || await storage.get(cancelKey(binding.target, selected.record.source.messageId)) !== null) { await forgetSelection(selected.key, selected.raw); return undefined }
        return selected.record
      } catch { throw fail() }
    },
    async reserveSelection(inputBinding: AgentBindingSnapshot, inputTrigger: AgentTorrentSource): Promise<AgentTorrentSelectionReservation | undefined> {
      try {
        const binding = bindingValue(inputBinding), trigger = sourceValue(inputTrigger, binding), id = agentTorrentId(binding, trigger)
        await recover()
        const selected = await selection(binding, trigger.sender)
        if (!selected || selected.record.expiresAt <= now() || selected.record.state === 'pending' || selected.record.state === 'reserved' && selected.record.reservedBy !== id || sameSource(selected.record.source, trigger)) return undefined
        const next: AgentTorrentSelection = { ...selected.record, state: 'reserved', reservedBy: id }
        const session = await claimInternal(binding, trigger, selected.record.source, { raw: selected.raw, next })
        if (!session) return undefined
        const heldSession: AgentTorrentSession = session
        const initial = freeze(next)
        let done: 'committed' | 'released' | undefined
        async function transition(commit: boolean) {
          if (done) { if (done !== (commit ? 'committed' : 'released')) throw fail(); return }
          const current = await selection(binding, trigger.sender)
          if (!current || current.record.state !== 'reserved' || current.record.reservedBy !== id || current.record.id !== initial.id || current.record.expiresAt <= now()) throw fail()
          const record = heldSession.record
          if (commit ? record.stages.find(row => row.stage === 'archive')?.state !== 'uploaded' : record.state === 'unknown' || record.stages.some(row => row.stage === 'archive' || row.state === 'pending' || row.state === 'unknown')) throw fail()
          const { reservedBy: _reservedBy, ...ready } = current.record
          const loaded = await load(id)
          if (!loaded || loaded.record.state === 'unknown' || terminal.has(loaded.record.state) || loaded.raw !== bytes(record)) throw fail()
          await reservationTransitions.get(heldSession)!({ before: current.raw, ...(commit ? {} : { next: { ...ready, state: 'ready' as const } }) })
          done = commit ? 'committed' : 'released'
        }
        return { selection: initial, session, commit: () => transition(true), release: () => transition(false) }
      } catch { throw fail() }
    },
    async cancelSource(input: ConversationAddress, messageId: string) {
      try {
        const selected = target(input)
        if (!safeId(messageId)) throw fail()
        await storage.eval(`${preflight}\ntypes({'string'})\nreturn redis.call('SET',KEYS[1],'1','EX',604800)`, { keys: [cancelKey(selected, messageId)], arguments: [] })
        for (const current of await listActive()) if (physicalSource(current.binding.target, messageId) === physicalSource(selected, messageId) &&
          (current.source.messageId === messageId || current.trigger.messageId === messageId)) {
          const loaded = await load(current.id)
          if (!loaded || terminal.has(loaded.record.state)) continue
          const pending = await selection(current.binding, current.source.sender)
          const removes = pending && (pending.record.source.messageId === messageId || pending.record.reservedBy === current.id)
          await write(loaded.raw, ended(loaded.record, 'cancelled'), '', true, removes ? { before: pending!.raw } : undefined)
          owned.delete(current.id)
        }
        for (const [key] of await entries(SELECTIONS, 128)) {
          const raw = await storage.get(selectionKey(key)); if (!raw) continue
          const pending = parseSelection(raw)
          if (physicalSource(pending.binding.target, messageId) === physicalSource(selected, messageId) && pending.source.messageId === messageId) await forgetSelection(key, raw)
        }
      } catch { throw fail() }
    },
    async cancelScope(input: AgentBindingSnapshot, inputSender?: PlatformUserRef) {
      try {
        const binding = bindingValue(input), sender = inputSender && user(inputSender)
        const matches = (current: AgentBindingSnapshot, author: PlatformUserRef) => agentBindingToken(current) === agentBindingToken(binding) &&
          conversationAddressKey(current.target) === conversationAddressKey(binding.target) && (!sender || platformAccountKey(sender) === platformAccountKey(author))
        for (const current of await listActive()) if (matches(current.binding, current.source.sender)) await api.cancelSource(current.binding.target, current.source.messageId)
        for (const [key] of await entries(SELECTIONS, 128)) {
          const raw = await storage.get(selectionKey(key)); if (!raw) continue
          const current = parseSelection(raw)
          if (matches(current.binding, current.source.sender)) { await api.cancelSource(current.binding.target, current.source.messageId); await forgetSelection(key, raw) }
        }
      } catch { throw fail() }
    },
  }
  return Object.freeze(api)
}
