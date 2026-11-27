import { createHash, randomUUID } from 'node:crypto'
import type { ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { PlatformConversationEvent, PlatformNudgeEvent } from '../../../contracts/platformConnection.js'
import type { PersonMemoryCommand } from '../../memory/domain/personMemoryCommands.js'
import { conversationAddressKey, decodeConversationAddressKey, isConversationAddress, isPlatformAccount, platformAccountKey } from '../domain/agentBindings.js'

export interface AgentInboxGroupLog {
  readonly agentId: string
  readonly globalEpoch: string
  readonly sceneEpoch: string
  /** Present only when deterministic dice was authorized at admission. */
  readonly dicePolicy?: string
}

export interface AgentInboxPrivacyOwner {
  readonly agentId: string
}

export interface AgentInboxGroupLogIngress {
  readonly kind: 'group-log'
  readonly groupLog: AgentInboxGroupLog
}

export interface AgentInboxRedis {
  get(key: string): Promise<string | null>
  getMany?(keys: string[]): Promise<(string | null)[]>
  matchesStringDigests?(keys: string[], digests: string[]): Promise<boolean>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export type AgentInboxEntry = {
  event: Exclude<PlatformConversationEvent, PlatformNudgeEvent | { readonly kind: 'red-packet' }>
  bindingToken?: string
  privacyCommand?: PersonMemoryCommand
  groupLog?: AgentInboxGroupLog
  privacyOwner?: AgentInboxPrivacyOwner
} | {
  event: PlatformNudgeEvent
  bindingToken: string
  ingressId: string
}

export interface TextInbox {
  readonly account: PlatformAccountRef
  readonly kind: 'private' | 'group'
}

export interface PrivateInbox extends TextInbox {
  readonly conversationId: string
  readonly kind: 'private'
}

export type AgentInboxQueue = PrivateInbox | { readonly account: PlatformAccountRef; readonly kind: TextInbox['kind'] | 'simulation' | 'privacy' | 'group-log' }

export interface AgentInboxObservation {
  readonly id: string
  readonly target: ConversationAddress
  readonly bindingToken: string
  readonly queue: AgentInboxQueue['kind']
  readonly eventKind: 'message' | 'recall' | 'nudge'
  readonly occurredAt?: number
}

function queueKey(queue: AgentInboxQueue): string {
  if ('conversationId' in queue) return 'agent:inbox:private-conversation:' + privateQueueMember(queue)
  const kind = queue.kind === 'group' ? 'group-text' : queue.kind
  return `agent:inbox:${kind}:${platformAccountKey(queue.account)}`
}
export { queueKey as agentInboxQueueKey }
const privateQueueMember = (queue: PrivateInbox) => conversationAddressKey({ account: queue.account, kind: 'private', id: queue.conversationId })
const privateQueueIndex = (account: PlatformAccountRef) => `agent:inbox:private-active:${platformAccountKey(account)}`
const readPrivateQueueIndex = `return redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. redis.call('TIME')[1], '+inf', 'LIMIT', 0, ARGV[1])`
const maxPrivateQueues = 10_000

function privateQueueFor(target: ConversationAddress): PrivateInbox {
  return { account: target.account, kind: 'private', conversationId: target.id }
}

async function listPrivateQueues(client: Pick<AgentInboxRedis, 'eval'>, account: PlatformAccountRef, limit: number): Promise<PrivateInbox[]> {
  const members: unknown = await client.eval(readPrivateQueueIndex, { keys: [privateQueueIndex(account)], arguments: [String(limit)] })
  if (!Array.isArray(members)) throw new Error('平台私聊队列索引暂时无法读取')
  return members.map((member: unknown) => {
    const address = typeof member === 'string' ? decodeConversationAddressKey(member) : null
    if (!address || address.kind !== 'private' || platformAccountKey(address.account) !== platformAccountKey(account)) {
      throw new Error('平台私聊队列索引归属无效')
    }
    return privateQueueFor(address)
  })
}
const legacySimulationQueue = 'agent:inbox'
const legacyBatchSize = 32
const readLegacyBatch = `return redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)`
const moveLegacyBatch = `
local rows = redis.call('LRANGE', KEYS[1], 0, #ARGV - 1)
if #rows ~= #ARGV then return 0 end
for i, row in ipairs(rows) do
  if row ~= ARGV[i] then return 0 end
  local destinationType = redis.call('TYPE', KEYS[i + 1]).ok
  if destinationType ~= 'none' and destinationType ~= 'list' then
    return redis.error_reply('invalid Agent inbox destination')
  end
end
for i, row in ipairs(rows) do redis.call('RPUSH', KEYS[i + 1], row) end
redis.call('LTRIM', KEYS[1], #rows, -1)
return 1`
const moveLegacyPrivateBatch = `
local count = #KEYS - 2
local rows = redis.call('LRANGE', KEYS[1], 0, count - 1)
if #rows ~= count then return 0 end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('invalid Agent private inbox index') end
for i, row in ipairs(rows) do
  if row ~= ARGV[i] then return 0 end
  local destinationType = redis.call('TYPE', KEYS[i + 2]).ok
  if destinationType ~= 'none' and destinationType ~= 'list' then return redis.error_reply('invalid Agent private inbox destination') end
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[count * 2 + 1]) end
ttl = math.max(1, math.min(ttl, tonumber(ARGV[count * 2 + 1])))
local now = tonumber(redis.call('TIME')[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
for i, row in ipairs(rows) do
  local target = KEYS[i + 2]
  redis.call('RPUSH', target, row)
  redis.call('EXPIRE', target, math.max(ttl, redis.call('TTL', target)))
  redis.call('ZADD', KEYS[2], now + redis.call('TTL', target) + 1, ARGV[count + i])
end
redis.call('EXPIRE', KEYS[2], ARGV[count * 2 + 1])
redis.call('LTRIM', KEYS[1], count, -1)
return 1`

export function inboxEventTarget(event: PlatformConversationEvent | undefined): ConversationAddress | undefined {
  switch (event?.kind) {
    case 'message': return event.message?.conversation
    case 'recall':
    case 'red-packet':
    case 'nudge': return event.target
  }
}

function legacyDestination(raw: string): string {
  try {
    const entry = JSON.parse(raw) as AgentInboxEntry | null
    const target = inboxEventTarget(entry?.event)
    if (isConversationAddress(target) && target.kind !== 'private') return queueKey({ kind: 'simulation', account: target.account })
  } catch { /* Keep the source rows on parse or routing failure. */ }
  throw new Error('原仿真收件队列存在无法识别的会话地址')
}

const enqueue = `
if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return -2 end
if KEYS[2] and redis.call('EXISTS', KEYS[2]) == 1 then return redis.call('LLEN', KEYS[1]) end
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then return -1 end
local now
if KEYS[4] then
  local indexType = redis.call('TYPE', KEYS[4]).ok
  if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('invalid Agent private inbox index') end
  now = tonumber(redis.call('TIME')[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
  if not redis.call('ZSCORE', KEYS[4], ARGV[6]) and redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[7]) then return -1 end
end
redis.call('RPUSH', KEYS[1], ARGV[1])
if KEYS[2] then redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[3]) end
if ARGV[4] ~= '' then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
if KEYS[4] then
  redis.call('ZADD', KEYS[4], now + tonumber(ARGV[4]) + 1, ARGV[6])
  redis.call('EXPIRE', KEYS[4], ARGV[4])
end
return redis.call('LLEN', KEYS[1])`
const head = `return redis.call('LINDEX', KEYS[1], 0)`
const length = `return redis.call('LLEN', KEYS[1])`
const acknowledge = `
if redis.call('LINDEX', KEYS[1], 0) ~= ARGV[1] then return -1 end
if KEYS[2] then
  local indexType = redis.call('TYPE', KEYS[2]).ok
  if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('invalid Agent private inbox index') end
end
redis.call('LPOP', KEYS[1])
local remaining = redis.call('LLEN', KEYS[1])
if remaining == 0 and KEYS[2] then redis.call('ZREM', KEYS[2], ARGV[2]) end
return remaining`
const forward = `
if redis.call('LINDEX', KEYS[1], 0) ~= ARGV[1] then return -1 end
local destinationType = redis.call('TYPE', KEYS[2]).ok
if destinationType ~= 'none' and destinationType ~= 'list' then return -2 end
if redis.call('LLEN', KEYS[2]) >= tonumber(ARGV[3]) then return -3 end
redis.call('RPUSH', KEYS[2], ARGV[2])
if ARGV[4] ~= '' then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
redis.call('LPOP', KEYS[1])
return redis.call('LLEN', KEYS[1])`
const revokeTextSource = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return 1`
const transitionTextReceipt = `
if redis.call('GET', KEYS[1]) ~= ARGV[3] then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if (redis.call('GET', KEYS[3]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[2])
return 1`
const rememberTextReply = `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1`
const reserveGroupTextTurn = `
local turns = tonumber(redis.call('GET', KEYS[1]) or '0') + tonumber(ARGV[3])
if tonumber(ARGV[1]) >= 0 and turns >= tonumber(ARGV[1]) then return 0 end
if not redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[2]) then return 0 end
if tonumber(ARGV[1]) >= 0 then
  redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], 172800)
end
return 1`
const receiptSeconds = 7 * 86_400
const privacyReceipt = (state: 'pending' | 'applied', entry: string) =>
  `privacy:${state}:${createHash('sha256').update(entry, 'utf8').digest('hex')}`
const claimPrivacyReply = `if redis.call('GET', KEYS[1]) ~= ARGV[1]
  or redis.call('GET', KEYS[2]) == '1' or redis.call('GET', KEYS[3]) == '1' then return 0 end
redis.call('SET', KEYS[1], 'attempted', 'KEEPTTL')
return 1`
const maxQueuedEvents = 10_000
export const textConversationSeconds = 3_600

const internalId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const epochToken = /^(?:0|[1-9][0-9]{0,15})$/u
function metadata(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    throw new Error('平台收件归属元数据无效')
  }
  return value as Record<string, unknown>
}
function groupLogMetadata(value: unknown): AgentInboxGroupLog {
  const row = metadata(value, ['agentId', 'globalEpoch', 'sceneEpoch', 'dicePolicy'])
  if (typeof row.agentId !== 'string' || !internalId.test(row.agentId) ||
      typeof row.globalEpoch !== 'string' || !epochToken.test(row.globalEpoch) ||
      typeof row.sceneEpoch !== 'string' || !epochToken.test(row.sceneEpoch) ||
      Object.hasOwn(row, 'dicePolicy') && (typeof row.dicePolicy !== 'string' || !/^[a-f0-9]{64}$/u.test(row.dicePolicy))) throw new Error('平台团录收件归属无效')
  return { agentId: row.agentId, globalEpoch: row.globalEpoch, sceneEpoch: row.sceneEpoch,
    ...(typeof row.dicePolicy === 'string' ? { dicePolicy: row.dicePolicy } : {}) }
}
function privacyOwnerMetadata(value: unknown): AgentInboxPrivacyOwner {
  const row = metadata(value, ['agentId'])
  if (typeof row.agentId !== 'string' || !internalId.test(row.agentId)) throw new Error('平台隐私收件归属无效')
  return { agentId: row.agentId }
}
function validBindingToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

export interface TextHistoryTurn {
  user: string
  reply: string
  speakerId?: string
  replyId?: string
}

export interface TextHistory {
  bindingToken: string
  personaVersion: string
  personMemoryInvalidatedAt?: number
  privatePeerId?: string
  turns: TextHistoryTurn[]
}

function eventKey(kind: PlatformConversationEvent['kind'] | 'text-recall', target: ConversationAddress, messageId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([kind, conversationAddressKey(target), messageId])).digest('hex')
  const prefix = kind === 'text-recall' ? 'text-recall-receipt' : 'receipt'
  return `agent:inbox:${prefix}:${digest}`
}

function recalledTextMessage(target: ConversationAddress, messageId: string): string {
  return eventKey(target.kind === 'private' ? 'recall' : 'text-recall', target, messageId)
}

function textRecallKey(target: ConversationAddress): string {
  const prefix = target.kind === 'private' ? 'private-recall' : 'group-text-recall'
  return `agent:${prefix}:${conversationAddressKey(target)}`
}

function textHistoryKey(target: ConversationAddress): string {
  const prefix = target.kind === 'private' ? 'private-history' : 'group-text-history'
  return `agent:${prefix}:${conversationAddressKey(target)}`
}

/** Metadata for entries still awaiting acknowledgement. This is not a completed-event ledger. */
export function createAgentInboxReader(client: Pick<AgentInboxRedis, 'eval'>) {
  return {
    async read(accounts: readonly PlatformAccountRef[], guard: { ensureCurrent(): void }): Promise<{
      records: readonly AgentInboxObservation[]; scanTruncated: boolean
    }> {
      guard.ensureCurrent()
      if (accounts.length > 256 || accounts.some(account => !isPlatformAccount(account))) throw new Error('平台收件查询账号无效')
      const unique = [...new Map(accounts.map(account => [platformAccountKey(account), account])).values()]
      const queues: AgentInboxQueue[] = []
      let scanTruncated = false
      for (const account of unique) {
        if (queues.length >= 100) { scanTruncated = true; break }
        queues.push(...(['private', 'group', 'simulation', 'privacy', 'group-log'] as const).map(kind => ({ account, kind })))
        guard.ensureCurrent()
        queues.push(...await listPrivateQueues(client, account, Math.max(0, 101 - queues.length)))
      }
      const records: AgentInboxObservation[] = [], seen = new Set<string>()
      let scanned = 0, bytes = 0
      scanTruncated ||= queues.length > 100
      for (const queue of queues.slice(0, 100)) {
        guard.ensureCurrent()
        const remaining = Math.min(200, 1000 - scanned)
        if (remaining < 1 || bytes >= 4 * 1024 * 1024) { scanTruncated = true; break }
        const batch: unknown = await client.eval(readLegacyBatch, { keys: [queueKey(queue)], arguments: [String(remaining + 1)] })
        guard.ensureCurrent()
        if (!Array.isArray(batch) || batch.length > remaining + 1 || batch.some(raw => typeof raw !== 'string')) throw new Error('平台收件队列暂时无法读取')
        if (batch.length > remaining) scanTruncated = true
        for (const raw of (batch as string[]).slice(0, remaining)) {
          scanned++
          bytes += Buffer.byteLength(raw)
          if (bytes > 4 * 1024 * 1024) { scanTruncated = true; break }
          if (Buffer.byteLength(raw) > 64 * 1024) { scanTruncated = true; continue }
          try {
            const entry = JSON.parse(raw) as AgentInboxEntry, event = entry?.event, target = inboxEventTarget(event)
            if (!isConversationAddress(target) || platformAccountKey(target.account) !== platformAccountKey(queue.account) ||
                !validBindingToken(entry.bindingToken) || !['message', 'recall', 'nudge'].includes(event?.kind) ||
                'conversationId' in queue && target.id !== queue.conversationId ||
                queue.kind === 'private' && target.kind !== 'private' || queue.kind === 'group' && target.kind !== 'group' ||
                ['simulation', 'group-log'].includes(queue.kind) && target.kind === 'private') { scanTruncated = true; continue }
            const id = createHash('sha256').update(JSON.stringify([queueKey(queue), raw])).digest('hex')
            if (seen.has(id)) continue
            seen.add(id)
            const at = event.kind === 'message' ? event.message.occurredAt : event.kind === 'nudge' ? event.occurredAt : undefined
            records.push(Object.freeze({ id, target: Object.freeze({ account: Object.freeze({ platform: target.account.platform,
              namespace: target.account.namespace, id: target.account.id }), kind: target.kind, id: target.id }),
              bindingToken: entry.bindingToken, queue: queue.kind, eventKind: event.kind,
              ...(typeof at === 'number' && Number.isSafeInteger(at) && at > 0 ? { occurredAt: at } : {}) }))
          } catch { scanTruncated = true }
        }
      }
      guard.ensureCurrent()
      return { records: Object.freeze(records), scanTruncated }
    },
  }
}

/** Consumers acknowledge queue heads after persisting the event's effects. */
export function createAgentInbox(client: AgentInboxRedis) {
  async function isRecalled(target: ConversationAddress, messageId: string): Promise<boolean> {
    return await client.get(eventKey('recall', target, messageId)) === '1'
      || (target.kind === 'group' && await client.get(recalledTextMessage(target, messageId)) === '1')
  }
  async function recalledMessageIds(target: ConversationAddress, messageIds: readonly string[], signal: AbortSignal): Promise<Set<string>> {
    const recalled = new Set<string>()
    for (let offset = 0; offset < messageIds.length; offset += 128) {
      signal.throwIfAborted()
      const ids = messageIds.slice(offset, offset + 128)
      if (!client.getMany) {
        for (const messageId of ids) {
          signal.throwIfAborted()
          if (await isRecalled(target, messageId)) recalled.add(messageId)
        }
        continue
      }
      const stride = target.kind === 'group' ? 2 : 1
      const keys = ids.flatMap(id => {
        const native = eventKey('recall', target, id)
        return stride === 2 ? [native, recalledTextMessage(target, id)] : [native]
      })
      const states = await client.getMany(keys)
      signal.throwIfAborted()
      if (states.length !== keys.length) throw new Error('撤回凭据读取结果无效')
      for (const [index, id] of ids.entries()) {
        const first = index * stride
        if (states[first] === '1' || stride === 2 && states[first + 1] === '1') recalled.add(id)
      }
    }
    return recalled
  }
  async function transitionText(target: ConversationAddress, messageId: string, recallVersion: string, from: string, to: string): Promise<boolean> {
    const keys = [eventKey('message', target, messageId), recalledTextMessage(target, messageId), textRecallKey(target)]
    const result = await client.eval(transitionTextReceipt, { keys, arguments: [recallVersion, String(receiptSeconds), from, to] })
    return Number(result) === 1
  }

  return {
    /** Move older entries before adapters can enqueue new ones. Preserve their bytes and per-account order. */
    async moveLegacySimulationQueue(isCurrent: () => boolean): Promise<void> {
      while (isCurrent()) {
        const batch: unknown = await client.eval(readLegacyBatch, { keys: [legacySimulationQueue], arguments: [String(legacyBatchSize)] })
        if (!Array.isArray(batch) || batch.some(row => typeof row !== 'string')) throw new Error('原仿真收件队列暂时无法读取')
        if (!batch.length || !isCurrent()) return
        const destinations = batch.map(legacyDestination)
        const moved = await client.eval(moveLegacyBatch, { keys: [legacySimulationQueue, ...destinations], arguments: batch })
        if (Number(moved) !== 1) throw new Error('原仿真收件队列顺序已改变')
      }
    },
    async moveLegacyPrivateQueue(account: PlatformAccountRef, isCurrent: () => boolean): Promise<void> {
      const source = queueKey({ account, kind: 'private' })
      while (isCurrent()) {
        const batch: unknown = await client.eval(readLegacyBatch, { keys: [source], arguments: [String(legacyBatchSize)] })
        if (!Array.isArray(batch) || batch.some(row => typeof row !== 'string')) throw new Error('原私聊队列暂时无法读取')
        if (!batch.length || !isCurrent()) return
        const destinations = batch.map((raw: string) => {
          try {
            const entry = JSON.parse(raw) as AgentInboxEntry | null
            const target = inboxEventTarget(entry?.event)
            if (isConversationAddress(target) && target.kind === 'private' && platformAccountKey(target.account) === platformAccountKey(account)) {
              return privateQueueFor(target)
            }
          } catch { /* Do not partially migrate a batch with an invalid row. */ }
          throw new Error('原私聊队列存在无法识别的会话地址')
        })
        const moved = await client.eval(moveLegacyPrivateBatch, {
          keys: [source, privateQueueIndex(account), ...destinations.map(queueKey)],
          arguments: [...batch, ...destinations.map(privateQueueMember), String(textConversationSeconds)],
        })
        if (Number(moved) !== 1) throw new Error('原私聊队列顺序已改变')
      }
    },
    listPrivateQueues: (account: PlatformAccountRef) => listPrivateQueues(client, account, maxPrivateQueues),
    async accountsWithPrivacyWork(accounts: readonly PlatformAccountRef[]): Promise<PlatformAccountRef[]> {
      const pending = await Promise.all(accounts.map(async account => {
        const remaining = Number(await client.eval(length, { keys: [queueKey({ account, kind: 'privacy' })], arguments: [] }))
        if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('平台隐私收件队列暂时无法读取')
        return remaining > 0
      }))
      return accounts.filter((_account, index) => pending[index])
    },
    async accept(entry: { event: PlatformConversationEvent; bindingToken?: string; privacyCommand?: PersonMemoryCommand; privacyOwner?: AgentInboxPrivacyOwner }, text?: TextInbox,
      setPrivacyPending?: (pending: boolean) => void, ingress?: AgentInboxGroupLogIngress): Promise<AgentInboxQueue | undefined> {
      const { event } = entry
      if (event.kind === 'red-packet') throw new Error('红包凭证不能进入普通消息收件队列')
      const target = inboxEventTarget(event)
      if (!isConversationAddress(target)) throw new Error('平台事件缺少有效会话地址')
      if (text && (text.kind !== target.kind || platformAccountKey(text.account) !== platformAccountKey(target.account))) {
        throw new Error('平台事件与收件队列不匹配')
      }
      const privacyCommand = entry.privacyCommand
      if (privacyCommand && (event.kind !== 'message' || !entry.bindingToken ||
          (target.kind !== 'group' && target.kind !== 'private'))) throw new Error('隐私指令缺少有效会话归属')
      let groupLog: AgentInboxGroupLog | undefined
      if (ingress !== undefined) {
        const input = metadata(ingress, ['kind', 'groupLog'])
        if (input.kind !== 'group-log' || event.kind !== 'message' || target.kind !== 'group' || !validBindingToken(entry.bindingToken)) {
          throw new Error('平台团录收件缺少有效群消息归属')
        }
        groupLog = groupLogMetadata(input.groupLog)
      }
      const privacyOwner = entry.privacyOwner === undefined ? undefined : privacyOwnerMetadata(entry.privacyOwner)
      if (privacyOwner && (event.kind !== 'message' || !validBindingToken(entry.bindingToken) || (target.kind !== 'group' && target.kind !== 'private'))) {
        throw new Error('平台隐私收件缺少有效会话归属')
      }
      const queue: AgentInboxQueue = target.kind === 'private' && !privacyCommand && event.kind === 'message'
        ? privateQueueFor(target)
        : { account: target.account, kind: privacyCommand ? 'privacy' : groupLog ? 'group-log' : target.kind === 'private' ? 'private' : text?.kind ?? 'simulation' }
      const keys = [queueKey(queue)]
      let stored: AgentInboxEntry
      if (event.kind === 'nudge') {
        if (!entry.bindingToken) throw new Error('平台互动缺少绑定')
        // OneBot nudges have no event ID. This identifies an accepted queue
        // item on replay, while separate reports can still be distinct nudges.
        stored = { event, bindingToken: entry.bindingToken, ingressId: randomUUID() }
      } else {
        const messageId = event.kind === 'message' ? event.message.messageId : event.messageId
        if (!messageId) throw new Error('平台事件缺少消息标识')
        keys.push(eventKey(event.kind, target, messageId))
        if (event.kind === 'message') keys.push(recalledTextMessage(target, messageId))
        stored = { event, ...(entry.bindingToken ? { bindingToken: entry.bindingToken } : {}), ...(privacyCommand ? { privacyCommand } : {}),
          ...(groupLog ? { groupLog } : {}), ...(privacyOwner ? { privacyOwner } : {}) }
      }
      const payload = JSON.stringify(stored)
      if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('平台事件超出收件大小限制')
      const privateQueue = 'conversationId' in queue ? queue : undefined
      if (privateQueue) keys.push(privateQueueIndex(queue.account))
      const result = Number(await client.eval(enqueue, {
        keys,
        arguments: [payload, String(maxQueuedEvents), String(receiptSeconds),
          queue.kind === 'private' || queue.kind === 'group' ? String(textConversationSeconds) : '', privacyCommand ? privacyReceipt('pending', payload) : '1',
          ...(privateQueue ? [privateQueueMember(privateQueue), String(maxPrivateQueues)] : [])],
      }))
      if (result === -2) return undefined
      if (!Number.isSafeInteger(result) || result < 0) throw new Error('平台收件队列暂时无法接收消息')
      if (privacyCommand) setPrivacyPending?.(result > 0)
      return queue
    },
    /** Transfer one admitted group message without creating or changing its deduplication receipt. */
    async forward(raw: string, sourceQueue: AgentInboxQueue, destinationQueue: AgentInboxQueue, replacement?: AgentInboxEntry): Promise<void> {
      if (sourceQueue.kind !== 'group-log' || !['group', 'simulation'].includes(destinationQueue.kind) ||
          !isPlatformAccount(sourceQueue.account) || !isPlatformAccount(destinationQueue.account) ||
          platformAccountKey(sourceQueue.account) !== platformAccountKey(destinationQueue.account)) throw new Error('平台团录收件转发目标无效')
      const original: AgentInboxEntry = JSON.parse(raw)
      const stored = replacement ?? original
      if (original?.event?.kind !== 'message' || stored?.event?.kind !== 'message') throw new Error('平台团录收件转发消息无效')
      const target = inboxEventTarget(original.event), nextTarget = inboxEventTarget(stored.event)
      if (!isConversationAddress(target) || target.kind !== 'group' || !isConversationAddress(nextTarget) ||
          conversationAddressKey(target) !== conversationAddressKey(nextTarget) ||
          platformAccountKey(target.account) !== platformAccountKey(sourceQueue.account) ||
          !original.event.message.messageId || original.event.message.messageId !== stored.event.message.messageId ||
          !validBindingToken(original.bindingToken) || !validBindingToken(stored.bindingToken) ||
          'privacyCommand' in original && original.privacyCommand !== undefined ||
          'privacyCommand' in stored && stored.privacyCommand !== undefined) throw new Error('平台团录收件转发消息归属无效')
      const groupLog = groupLogMetadata('groupLog' in original ? original.groupLog : undefined)
      const originalOwner = 'privacyOwner' in original ? original.privacyOwner : undefined
      const owner = originalOwner === undefined ? undefined : privacyOwnerMetadata(originalOwner)
      if ('groupLog' in stored && stored.groupLog !== undefined && JSON.stringify(groupLogMetadata(stored.groupLog)) !== JSON.stringify(groupLog) ||
          'privacyOwner' in stored && stored.privacyOwner !== undefined && JSON.stringify(privacyOwnerMetadata(stored.privacyOwner)) !== JSON.stringify(owner)) {
        throw new Error('平台团录收件转发归属已改变')
      }
      const payload = JSON.stringify({ event: stored.event, bindingToken: stored.bindingToken, groupLog, ...(owner ? { privacyOwner: owner } : {}) })
      if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('平台事件超出收件大小限制')
      const remaining = Number(await client.eval(forward, { keys: [queueKey(sourceQueue), queueKey(destinationQueue)],
        arguments: [raw, payload, String(maxQueuedEvents), destinationQueue.kind === 'group' ? String(textConversationSeconds) : ''] }))
      if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('平台团录收件暂时无法转发消息')
    },
    async next(queue: AgentInboxQueue, setPrivacyPending?: (pending: boolean) => void): Promise<{ raw: string; entry: AgentInboxEntry } | null> {
      const raw = await client.eval(head, { keys: [queueKey(queue)], arguments: [] })
      if (queue.kind === 'privacy') setPrivacyPending?.(typeof raw === 'string')
      if (typeof raw !== 'string') return null
      const entry: AgentInboxEntry = JSON.parse(raw)
      return { raw, entry }
    },
    async acknowledge(raw: string, queue: AgentInboxQueue, setPrivacyPending?: (pending: boolean) => void): Promise<number> {
      const remaining = Number(await client.eval(acknowledge, {
        keys: [queueKey(queue), ...('conversationId' in queue ? [privateQueueIndex(queue.account)] : [])],
        arguments: [raw, ...('conversationId' in queue ? [privateQueueMember(queue)] : [])],
      }))
      if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('平台收件队列顺序已改变')
      if (queue.kind === 'privacy') setPrivacyPending?.(remaining > 0)
      return remaining
    },
    async privacyCommandState(target: ConversationAddress, messageId: string, entry: string) {
      const state = await client.get(eventKey('message', target, messageId))
      return state === privacyReceipt('pending', entry) ? 'pending' : state === privacyReceipt('applied', entry) ? 'applied' : undefined
    },
    privacyCommandReceipt(target: ConversationAddress, messageId: string, entry: string) {
      return {
        key: eventKey('message', target, messageId), pending: privacyReceipt('pending', entry), applied: privacyReceipt('applied', entry),
        recallKeys: [eventKey('recall', target, messageId), recalledTextMessage(target, messageId)] as const,
        queueKey: queueKey({ account: target.account, kind: 'privacy' }), entry,
      }
    },
    async claimPrivacyConfirmation(target: ConversationAddress, messageId: string, entry: string): Promise<boolean> {
      return Number(await client.eval(claimPrivacyReply, {
        keys: [eventKey('message', target, messageId), eventKey('recall', target, messageId), recalledTextMessage(target, messageId)],
        arguments: [privacyReceipt('applied', entry)],
      })) === 1
    },
    async canReply(target: ConversationAddress, messageId: string): Promise<boolean> {
      const message = eventKey('message', target, messageId)
      if (!client.getMany) return await client.get(message) !== null && !await isRecalled(target, messageId)
      const keys = [message, eventKey('recall', target, messageId)]
      if (target.kind === 'group') keys.push(recalledTextMessage(target, messageId))
      const values = await client.getMany(keys)
      if (values.length !== keys.length) throw new Error('回复来源读取结果无效')
      return typeof values[0] === 'string' && values[1] !== '1' && values[2] !== '1'
    },
    async isTextReplyPending(target: ConversationAddress, messageId: string): Promise<boolean> {
      return await client.get(eventKey('message', target, messageId)) === '1'
        && await client.get(recalledTextMessage(target, messageId)) !== '1'
    },
    async isTextReplyConfirmed(target: ConversationAddress, messageId: string): Promise<boolean> {
      return await client.get(eventKey('message', target, messageId)) === 'confirmed-text'
        && !await isRecalled(target, messageId)
    },
    async confirmTextReply(target: ConversationAddress, messageId: string, recallVersion: string): Promise<boolean> {
      return await transitionText(target, messageId, recallVersion, 'attempted', 'confirmed-text')
    },
    async confirmTextMedia(target: ConversationAddress, messageId: string, recallVersion: string): Promise<boolean> {
      return await transitionText(target, messageId, recallVersion, 'action-attempted', 'confirmed-media')
    },
    async confirmTextInteraction(target: ConversationAddress, messageId: string, recallVersion: string): Promise<boolean> {
      return await transitionText(target, messageId, recallVersion, 'action-attempted', 'confirmed-action')
    },
    async textActionReceipt(target: ConversationAddress, messageId: string): Promise<string | undefined> {
      const state = await client.get(eventKey('message', target, messageId))
      return state === 'action-attempted' ? '' : state?.startsWith('action-result:') ? state.slice('action-result:'.length) : undefined
    },
    async textRecallVersion(target: ConversationAddress): Promise<string> {
      return await client.get(textRecallKey(target)) ?? ''
    },
    async recallText(target: ConversationAddress, messageId: string): Promise<boolean> {
      return Number(await client.eval(revokeTextSource, {
        keys: [recalledTextMessage(target, messageId), textRecallKey(target), textHistoryKey(target)],
        arguments: [String(receiptSeconds)],
      })) === 1
    },
    async loadTextHistory(target: ConversationAddress): Promise<TextHistory | undefined> {
      const raw = await client.get(textHistoryKey(target))
      return raw ? JSON.parse(raw) as TextHistory : undefined
    },
    async reserveGroupTextTurn(target: ConversationAddress, day: string, limit: number, minGapMs: number, carriedTurns = 0): Promise<boolean> {
      const scope = conversationAddressKey(target)
      const keys = [`agent:group-text-budget:${scope}:${day}`, `agent:group-text-cooldown:${scope}`]
      return Number(await client.eval(reserveGroupTextTurn, { keys, arguments: [String(limit), String(minGapMs), String(carriedTurns)] })) === 1
    },
    async saveTextHistory(target: ConversationAddress, recallVersion: string, history: TextHistory): Promise<void> {
      await client.eval(rememberTextReply, {
        keys: [textRecallKey(target), textHistoryKey(target)],
        arguments: [recallVersion, JSON.stringify(history), String(textConversationSeconds)],
      })
    },
    async claimTextAction(target: ConversationAddress, messageId: string, recallVersion: string): Promise<boolean> {
      return await transitionText(target, messageId, recallVersion, '1', 'action-attempted')
    },
    async finishTextAction(target: ConversationAddress, messageId: string, recallVersion: string, receipt: string): Promise<boolean> {
      return await transitionText(target, messageId, recallVersion, 'action-attempted', `action-result:${receipt}`)
    },
    async claimTextReply(target: ConversationAddress, messageId: string, recallVersion: string, actionReceipt?: string): Promise<boolean> {
      const expected = actionReceipt === undefined ? '1' : actionReceipt ? `action-result:${actionReceipt}` : 'action-attempted'
      return await transitionText(target, messageId, recallVersion, expected, 'attempted')
    },
    isRecalled, recalledMessageIds,
  }
}
