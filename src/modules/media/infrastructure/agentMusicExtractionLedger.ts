import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { normalizeFileDeliveryReceipt } from '../../messaging/infrastructure/agentFileDelivery.js'

export type MusicExtractionStage = 'file' | 'introBundle' | 'introText' | 'preview' | 'failureText'
type StageState = 'pending' | 'sent' | 'uploaded' | 'failed' | 'unknown'
type LedgerState = 'active' | 'completed' | 'failed' | 'cancelled' | 'unknown'
type Receipt = DeliveryReceipt | FileDeliveryReceipt
export interface MusicExtractionStageRecord {
  readonly stage: MusicExtractionStage
  readonly state: StageState
  readonly beganAt: number
  readonly finishedAt?: number
  readonly receipt?: Readonly<Receipt>
}
export interface MusicExtractionRecord {
  readonly version: 1
  readonly state: LedgerState
  readonly createdAt: number
  readonly updatedAt: number
  readonly stages: readonly MusicExtractionStageRecord[]
}
export interface MusicExtractionSession {
  begin(stage: MusicExtractionStage): Promise<void>
  finish(stage: MusicExtractionStage, receipt: Receipt): Promise<void>
  close(state: 'completed' | 'failed' | 'cancelled'): Promise<void>
  /** Release local ownership only. A later reader freezes any unfinished attempt. */
  abandon(): void
}

const stages = new Set<MusicExtractionStage>(['file', 'introBundle', 'introText', 'preview', 'failureText'])
const states = new Set<LedgerState>(['active', 'completed', 'failed', 'cancelled', 'unknown'])
const seconds = 7 * 86_400
// Separate Redis instances may contain the same hash. Within one host, creating
// another ledger over its same storage must not mistake a live session for a crash.
const activeByStorage = new WeakMap<AgentInboxRedis, Set<string>>()
const claimScript = `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 end return 0`
const compareAndSet = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`
const fail = () => new Error('音乐提取回执账本不可用或执行已停止')
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
const id = (value: unknown, max = 128): value is string => text(value, max) && !/^0+$/u.test(value) && !/^[a-z][a-z\d+.-]*:\/\//iu.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function keyFor(binding: AgentBindingSnapshot, trigger: string): string {
  try {
    if (!object(binding) || !isConversationAddress(binding.target) || !['configured', 'legacy'].includes(binding.source) ||
        !text(binding.id, 4096) || !text(binding.revision, 4096) || !isPlatformIdentifier(binding.agentId) ||
        !isPlatformIdentifier(binding.personaId) || !isPlatformIdentifier(binding.connectionId) || !id(trigger)) throw fail()
    return `agent:music-extraction:v1:${createHash('sha256').update(JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding), trigger])).digest('hex')}`
  } catch { throw fail() }
}

/** Copy data fields across realms without invoking a host's receipt accessors. */
function receiptData(input: unknown): Record<string, unknown> | undefined {
  try {
    if (!object(input)) return undefined
    const result: Record<string, unknown> = {}
    for (const key of ['state', 'status', 'retcode', 'code', 'success', 'unknown', 'ok', 'message_id', 'messageId', 'fileId', 'data']) {
      const field = Object.getOwnPropertyDescriptor(input, key)
      if (!field) continue
      if (!Object.hasOwn(field, 'value')) return undefined
      const value: unknown = field.value
      if (key === 'data') {
        if (!object(value)) continue
        const message = Object.getOwnPropertyDescriptor(value, 'message_id')
        if (message && !Object.hasOwn(message, 'value')) return undefined
        if (message) result.data = { message_id: message.value }
      } else if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value
      else return undefined
    }
    return result
  } catch { return undefined }
}

function normalize(stage: MusicExtractionStage, input: unknown): Receipt {
  const value = receiptData(input)
  if (!value) return { state: 'unknown' }
  try {
    const ordinary = normalizeDeliveryReceipt(value)
    // Definite failure wins over any contradictory success ID. Failure text is
    // not evidence and may contain provider data, so persist no arbitrary code.
    if (ordinary.state === 'failed') return { state: 'failed', code: null }
    if (value.state === 'unknown' || value.status === 'unknown' || value.unknown === true) return { state: 'unknown' }
    if (stage === 'file') {
      const file = normalizeFileDeliveryReceipt(value)
      if (file.state !== 'uploaded' || !id(file.fileId, 1024) || file.messageId !== undefined && !id(file.messageId)) return { state: 'unknown' }
      return { state: 'uploaded', fileId: file.fileId, ...(file.messageId === undefined ? {} : { messageId: file.messageId }) }
    }
    if (value.state === 'uploaded' || ordinary.state !== 'sent' || !id(ordinary.messageId)) return { state: 'unknown' }
    return { state: 'sent', messageId: ordinary.messageId }
  } catch { return { state: 'unknown' } }
}

function parse(raw: string): MusicExtractionRecord {
  try {
    if (raw.length > 16_384) throw fail()
    const value: unknown = JSON.parse(raw)
    if (!object(value) || Object.keys(value).some(key => !['version', 'state', 'createdAt', 'updatedAt', 'stages'].includes(key)) || value.version !== 1 ||
        !states.has(value.state as LedgerState) || !time(value.createdAt) || !time(value.updatedAt) || value.updatedAt < value.createdAt ||
        !Array.isArray(value.stages) || value.stages.length > 5) throw fail()
    const seen = new Set<MusicExtractionStage>()
    const records: MusicExtractionStageRecord[] = value.stages.map((entry: unknown, index: number) => {
      if (!object(entry) || Object.keys(entry).some(key => !['stage', 'state', 'beganAt', 'finishedAt', 'receipt'].includes(key)) ||
          !stages.has(entry.stage as MusicExtractionStage) || seen.has(entry.stage as MusicExtractionStage) || !time(entry.beganAt) || entry.beganAt < (value.createdAt as number) || entry.beganAt > (value.updatedAt as number)) throw fail()
      const stage = entry.stage as MusicExtractionStage
      seen.add(stage)
      if (entry.state === 'pending') {
        if (entry.finishedAt !== undefined || entry.receipt !== undefined || value.state !== 'active' || index !== (value.stages as unknown[]).length - 1) throw fail()
        return Object.freeze({ stage, state: 'pending', beganAt: entry.beganAt })
      }
      if (!time(entry.finishedAt) || entry.finishedAt < entry.beganAt || entry.finishedAt > (value.updatedAt as number)) throw fail()
      const receipt = normalize(stage, entry.receipt)
      if (entry.state !== receipt.state || JSON.stringify(receipt) !== JSON.stringify(entry.receipt) ||
          receipt.state === 'unknown' && (value.state !== 'unknown' || index !== (value.stages as unknown[]).length - 1)) throw fail()
      return Object.freeze({ stage, state: receipt.state, beganAt: entry.beganAt, finishedAt: entry.finishedAt, receipt: Object.freeze(receipt) })
    })
    return Object.freeze({ version: 1, state: value.state as LedgerState, createdAt: value.createdAt, updatedAt: value.updatedAt, stages: Object.freeze(records) })
  } catch { throw fail() }
}

/** At-most-once attempts: a restart freezes unfinished work; it never resumes delivery. */
export function createAgentMusicExtractionLedger(storage: AgentInboxRedis, options: { now?(): number } = {}) {
  let active = activeByStorage.get(storage)
  if (!active) { active = new Set(); activeByStorage.set(storage, active) }
  const owned = active
  const now = (minimum = 0) => {
    const value = (options.now ?? Date.now)()
    if (!time(value)) throw fail()
    return Math.max(minimum, value)
  }
  async function write(key: string, before: string, next: MusicExtractionRecord): Promise<string> {
    const raw = JSON.stringify(next)
    if (raw.length > 16_384 || Number(await storage.eval(compareAndSet, { keys: [key], arguments: [before, raw, String(seconds)] })) !== 1) throw fail()
    return raw
  }
  async function read(key: string, recover = false): Promise<{ raw: string; record: MusicExtractionRecord } | undefined> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await storage.get(key)
      if (raw === null) return undefined
      const record = parse(raw)
      if (record.state !== 'active' || !recover && owned.has(key)) return { raw, record }
      const updatedAt = now(record.updatedAt)
      const next: MusicExtractionRecord = { ...record, state: 'unknown', updatedAt, stages: record.stages.map(row => row.state === 'pending'
        ? { ...row, state: 'unknown', finishedAt: updatedAt, receipt: { state: 'unknown' } } : row) }
      const replacement = JSON.stringify(next)
      if (Number(await storage.eval(compareAndSet, { keys: [key], arguments: [raw, replacement, String(seconds)] })) === 1) return { raw: replacement, record: parse(replacement) }
    }
    throw fail()
  }
  return {
    async inspect(binding: AgentBindingSnapshot, triggerMessageId: string): Promise<MusicExtractionRecord | undefined> {
      return (await read(keyFor(binding, triggerMessageId)))?.record
    },
    async claim(binding: AgentBindingSnapshot, triggerMessageId: string): Promise<MusicExtractionSession | undefined> {
      const key = keyFor(binding, triggerMessageId)
      if (owned.has(key)) return undefined
      owned.add(key)
      let held = true, busy = false
      const abandon = () => { if (held) { held = false; owned.delete(key) } }
      let record: MusicExtractionRecord, raw: string
      try {
        const at = now()
        record = { version: 1, state: 'active', createdAt: at, updatedAt: at, stages: [] }
        raw = JSON.stringify(record)
        if (Number(await storage.eval(claimScript, { keys: [key], arguments: [raw, String(seconds)] })) !== 1) {
          await read(key, true); abandon(); return undefined
        }
      } catch { abandon(); throw fail() }
      async function mutate(change: () => MusicExtractionRecord) {
        if (!held || busy || record.state !== 'active') throw fail()
        const next = change()
        busy = true
        try {
          raw = await write(key, raw, next)
          record = next
          if (!held) throw fail()
          if (record.state !== 'active') abandon()
        } catch { abandon(); throw fail() }
        finally { busy = false }
      }
      return {
        abandon,
        async begin(stage: MusicExtractionStage) {
          await mutate(() => {
            if (!stages.has(stage) || record.stages.length >= 5 || record.stages.some(row => row.stage === stage || row.state === 'pending' || row.state === 'unknown')) throw fail()
            const at = now(record.updatedAt)
            return { ...record, updatedAt: at, stages: [...record.stages, { stage, state: 'pending', beganAt: at }] }
          })
        },
        async finish(stage: MusicExtractionStage, receipt: Receipt) {
          await mutate(() => {
            const pending = record.stages.at(-1)
            if (!stages.has(stage) || pending?.stage !== stage || pending.state !== 'pending') throw fail()
            const normalized = normalize(stage, receipt), at = now(record.updatedAt)
            return { ...record, updatedAt: at, state: normalized.state === 'unknown' ? 'unknown' : 'active', stages: [
              ...record.stages.slice(0, -1), { ...pending, state: normalized.state, finishedAt: at, receipt: normalized },
            ] }
          })
        },
        async close(state: 'completed' | 'failed' | 'cancelled') {
          await mutate(() => {
            if (!['completed', 'failed', 'cancelled'].includes(state) || record.stages.some(row => row.state === 'pending' || row.state === 'unknown')) throw fail()
            return { ...record, state, updatedAt: now(record.updatedAt) }
          })
        },
      }
    },
  }
}
