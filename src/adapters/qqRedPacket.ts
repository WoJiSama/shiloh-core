import { createHash, randomBytes } from 'node:crypto'
import { types } from 'node:util'
import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type {
  AgentRedPacketGrabReceipt, AgentRedPacketGuard, AgentRedPacketKind, AgentRedPacketPasswordReceipt,
  AgentRedPacketPort, AgentRedPacketSnapshot,
} from '../contracts/agentQqRedPacket.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'

export type QqRedPacketApiAction = 'get_msg' | 'get_group_msg_history' | 'get_group_member_info' | 'send_group_msg' | 'grab_red_bag'
export interface QqRedPacketApiOptions extends AgentRedPacketGuard { readonly timeoutMs: number }
export interface QqRedPacketOptions {
  readonly account: PlatformAccountRef
  readonly connectionId: string
  /** An explicit host assertion for the currently authenticated NapCat implementation. */
  readonly driver?: 'napcat' | 'llbot' | 'unknown'
  readonly supportsRedPacket?: boolean
  readonly isReady: () => boolean
  readonly timeoutMs?: number
  callApi(action: QqRedPacketApiAction, params: Readonly<Record<string, unknown>>, guard: QqRedPacketApiOptions): Promise<unknown>
}
export interface QqRedPacketPort extends AgentRedPacketPort {
  /** The native event must come from this port's captured authenticated socket. No text is fabricated. */
  readIncoming(target: ConversationAddress, nativeEvent: unknown, guard: AgentRedPacketGuard): Promise<AgentRedPacketSnapshot | undefined>
  revoke(target: ConversationAddress, messageId?: string): void
  close(): void
}

export const QQ_RED_PACKET_TIMEOUT_MS = 30_000
const MAX_CACHE_ENTRIES = 256, CACHE_MS = 5 * 60_000
const invalid = () => new Error('QQ red packet source unavailable')
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const kinds: readonly AgentRedPacketKind[] = ['normal', 'lucky', 'password', 'exclusive', 'unknown']
const failed = (): { state: 'failed'; code: string } => ({ state: 'failed', code: 'red_packet_source_unavailable' })
const unknown = (): { state: 'unknown' } => ({ state: 'unknown' })

function data(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    result[key] = field.value
  }
  return result
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw invalid()
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw invalid()
    return field.value
  })
}
function id(value: unknown): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalid()
  const result = String(value)
  if (!/^[1-9]\d{0,19}$/u.test(result)) throw invalid()
  return result
}
function messageId(value: unknown): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalid()
  const result = String(value), numeric = Number(result)
  if (!/^-?[1-9]\d{0,9}$/u.test(result) || numeric < -2_147_483_648 || numeric > 2_147_483_647) throw invalid()
  return result
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > maximum || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) throw invalid()
  return value
}
function account(value: unknown): PlatformAccountRef {
  const row = data(value, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string') throw invalid()
  return Object.freeze({ platform: 'qq', namespace: 'global', id: id(row.id) })
}
function target(value: unknown, configured: PlatformAccountRef): ConversationAddress {
  const row = data(value, ['account', 'kind', 'id']), owner = account(row.account)
  if (row.kind !== 'group' || typeof row.id !== 'string' || owner.id !== configured.id) throw invalid()
  return Object.freeze({ account: owner, kind: 'group', id: id(row.id) })
}
function signal(value: unknown): AbortSignal {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== AbortSignal.prototype) throw invalid()
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key === 'string' || !field || !Object.hasOwn(field, 'value') || types.isProxy(field.value)) throw invalid()
  }
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(value)
  return value as AbortSignal
}
function optionalScope(row: Record<string, unknown>, scope: ConversationAddress, userId?: string, allowUnprovenAuthor = false): boolean {
  try {
    return (!Object.hasOwn(row, 'self_id') || id(row.self_id) === scope.account.id) &&
      (!Object.hasOwn(row, 'group_id') || id(row.group_id) === scope.id) &&
      (!Object.hasOwn(row, 'user_id') || (userId !== undefined ? id(row.user_id) === userId : allowUnprovenAuthor && !!id(row.user_id)))
  } catch { return false }
}
function response(value: unknown, scope: ConversationAddress, userId?: string, allowUnprovenAuthor = false): Record<string, unknown> {
  const row = data(value)
  if (row.status !== 'ok' || row.retcode !== 0 || row.state !== undefined || !optionalScope(row, scope, userId, allowUnprovenAuthor)) throw invalid()
  return row
}
function uint(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})$/u.test(value)) return undefined
  const result = Number(value)
  return Number.isSafeInteger(result) ? result : undefined
}

interface NativePacket {
  readonly target: ConversationAddress
  readonly messageId: string
  readonly authorId: string
  readonly at: number
  readonly pcBody: string
  readonly index: string
  readonly sequence: string
  readonly title: string
  readonly kind: AgentRedPacketKind
  readonly exclusiveForBot: boolean
  readonly packetIdentity: string
  readonly fingerprint: string
}
function nativePacket(value: unknown, scope: ConversationAddress, requestedId?: string): NativePacket {
  const row = data(value), sender = data(row.sender), authorId = id(row.user_id), sourceId = messageId(row.message_id)
  if (row.message_type !== 'group' || id(row.group_id) !== scope.id || id(sender.user_id) !== authorId || requestedId !== undefined && sourceId !== requestedId ||
      row.post_type !== undefined && row.post_type !== 'message' || !optionalScope(row, scope, authorId) ||
      typeof row.time !== 'number' || !Number.isSafeInteger(row.time) || row.time <= 0 || row.time > Math.floor(Date.now() / 1000) + 60) throw invalid()
  const segments = array(row.message ?? row.msg, 128), wallets: Record<string, unknown>[] = []
  for (const value of segments) {
    const segment = data(value)
    if (segment.type === 'wallet') wallets.push(data(segment.data ?? segment))
  }
  // One source is one native packet. Ambiguous sources cannot silently select the first wallet.
  if (wallets.length !== 1) throw invalid()
  const wallet = wallets[0]!, raw = wallet.raw === undefined ? Object.create(null) as Record<string, unknown> : data(wallet.raw)
  const pcBody = text(wallet.pc_body, 65_536), index = text(wallet.string_index, 4096), title = text(wallet.title, 512, true)
  const sequence = id(wallet.msg_seq ?? row.message_seq ?? row.seq)
  for (const reported of [wallet.msg_seq, row.message_seq, row.seq]) if (reported !== undefined && id(reported) !== sequence) throw invalid()
  const channel = uint(wallet.red_channel) || uint(raw.redChannel), redType = uint(wallet.red_type) || uint(raw.redType), msgType = uint(raw.msgType)
  const kind: AgentRedPacketKind = channel === 1024 ? 'exclusive' : channel === 32 ? 'password' : redType === 2 ? 'normal' : redType === 1 && msgType === 3 ? 'lucky' : 'unknown'
  if (kind === 'password' && !title) throw invalid()
  const recipients = raw.grapUin === undefined ? [] : array(raw.grapUin, 100).map(id)
  const exclusiveForBot = kind === 'exclusive' && recipients.includes(scope.account.id)
  // The opaque native index identifies the packet. It includes neither a command ID nor a binding revision.
  const packetIdentity = digest(['qq.red-packet.v1', scope.id, index, pcBody])
  const fields = { target: scope, messageId: sourceId, authorId, at: row.time * 1000, pcBody, index, sequence, title, kind, exclusiveForBot, packetIdentity }
  return Object.freeze({ ...fields, fingerprint: digest(fields) })
}
interface CacheEntry { readonly packet: NativePacket; readonly snapshot: AgentRedPacketSnapshot; readonly expiresAt: number }

/** Native credentials are bounded, ephemeral adapter state. Core owns authorization, cooldown and the durable attempt ledger. */
export function createQqRedPacketPort(options: QqRedPacketOptions): QqRedPacketPort | undefined {
  const configured = data(options, ['account', 'connectionId', 'driver', 'supportsRedPacket', 'isReady', 'timeoutMs', 'callApi'])
  if (configured.driver !== 'napcat' || configured.supportsRedPacket !== true) return undefined
  const configuredAccount = configured.account, owner = account(configuredAccount), connectionId = text(configured.connectionId, 128)
  if (typeof configured.isReady !== 'function' || types.isProxy(configured.isReady) || typeof configured.callApi !== 'function' || types.isProxy(configured.callApi)) throw invalid()
  const timeout = configured.timeoutMs === undefined ? QQ_RED_PACKET_TIMEOUT_MS : configured.timeoutMs
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > QQ_RED_PACKET_TIMEOUT_MS) throw invalid()
  const timeoutMs: number = timeout
  const isReady = configured.isReady as () => boolean, callApi = configured.callApi as QqRedPacketOptions['callApi']
  let closed = false
  const cache = new Map<string, CacheEntry>(), controllers = new Map<AbortController, { readonly targetId: string; readonly messageId?: string }>()
  const prune = () => {
    for (const [key, value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key)
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
  }
  function remember(packet: NativePacket): AgentRedPacketSnapshot {
    const snapshot: AgentRedPacketSnapshot = Object.freeze({ version: 1, target: packet.target,
      source: Object.freeze({ messageId: packet.messageId, author: Object.freeze({ ...owner, id: packet.authorId }), at: packet.at }), observedAt: Date.now(),
      packetRef: 'qqrp_' + randomBytes(24).toString('hex'), packetIdentity: packet.packetIdentity, kind: packet.kind, title: packet.title, exclusiveForBot: packet.exclusiveForBot })
    cache.set(snapshot.packetRef, { packet, snapshot, expiresAt: Date.now() + CACHE_MS }); prune()
    return snapshot
  }
  function cached(value: unknown): CacheEntry {
    prune()
    const row = data(value, ['version', 'target', 'source', 'observedAt', 'packetRef', 'packetIdentity', 'kind', 'title', 'exclusiveForBot'])
    const scope = target(row.target, owner), source = data(row.source, ['messageId', 'author', 'at']), author = account(source.author)
    const key = text(row.packetRef, 128), entry = cache.get(key)
    if (!entry || row.version !== 1 || typeof row.kind !== 'string' || !kinds.includes(row.kind as AgentRedPacketKind) ||
        typeof row.packetIdentity !== 'string' || !/^[a-f0-9]{64}$/u.test(row.packetIdentity) || typeof row.exclusiveForBot !== 'boolean' ||
        typeof source.at !== 'number' || !Number.isSafeInteger(source.at) || source.at <= 0 ||
        typeof row.observedAt !== 'number' || !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 ||
        JSON.stringify({ version: row.version, target: scope, source: { messageId: messageId(source.messageId), author, at: source.at }, observedAt: row.observedAt,
          packetRef: key, packetIdentity: row.packetIdentity, kind: row.kind, title: text(row.title, 512, true), exclusiveForBot: row.exclusiveForBot }) !== JSON.stringify(entry.snapshot)) throw invalid()
    return entry
  }
  interface Invocation {
    readonly guard: QqRedPacketApiOptions
    invoke(action: QqRedPacketApiAction, params: Record<string, unknown>): Promise<unknown>
  }
  async function run<T>(input: AgentRedPacketGuard, unchanged: () => boolean, before: T, after: T, work: (scope: Invocation) => Promise<T>, source: { readonly targetId: string; readonly messageId?: string }): Promise<T> {
    let parent: AbortSignal, check: () => boolean, ensure: () => Promise<void>
    try {
      const row = data(input, ['signal', 'isCurrent', 'ensureCurrent', 'limit'])
      parent = signal(row.signal)
      if (typeof row.isCurrent !== 'function' || types.isProxy(row.isCurrent) || typeof row.ensureCurrent !== 'function' || types.isProxy(row.ensureCurrent)) throw invalid()
      check = row.isCurrent as () => boolean; ensure = row.ensureCurrent as () => Promise<void>
    } catch { return before }
    const controller = new AbortController(), combined = AbortSignal.any([parent, controller.signal]), deadline = Date.now() + timeoutMs
    let dispatched = false
    const isCurrent = () => { try { return !closed && !combined.aborted && isReady() === true && check() === true && account(configuredAccount).id === owner.id && unchanged() } catch { return false } }
    if (!isCurrent()) return before
    controllers.set(controller, source)
    const timer = setTimeout(() => controller.abort(), timeoutMs), watcher = setInterval(() => { if (!isCurrent()) controller.abort() }, 25)
    const wait = <V>(promise: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
      const abort = () => reject(invalid()), clear = () => combined.removeEventListener('abort', abort)
      promise.then(value => { clear(); resolve(value) }, () => { clear(); reject(invalid()) })
      if (combined.aborted) abort(); else combined.addEventListener('abort', abort, { once: true })
    })
    const ensureCurrent = async () => { if (!isCurrent()) throw invalid(); await wait(Promise.resolve().then(ensure)); if (!isCurrent()) throw invalid() }
    const guard = Object.freeze({ signal: combined, isCurrent, ensureCurrent, timeoutMs: Math.max(1, deadline - Date.now()) })
    const invoke = async (action: QqRedPacketApiAction, params: Record<string, unknown>): Promise<unknown> => {
      await ensureCurrent()
      return wait(Promise.resolve().then(() => {
        if (!isCurrent()) throw invalid()
        return withDeliveryGuard(isCurrent, () => {
          if (action === 'send_group_msg' || action === 'grab_red_bag') dispatched = true
          return callApi(action, Object.freeze(params), Object.freeze({ ...guard, timeoutMs: Math.max(1, deadline - Date.now()) }))
        })
      }))
    }
    try {
      const value = await wait(Promise.resolve().then(() => work({ guard, invoke })))
      return isCurrent() ? value : dispatched ? after : before
    } catch { return dispatched ? after : before }
    finally { clearTimeout(timer); clearInterval(watcher); controller.abort(); controllers.delete(controller) }
  }
  async function fresh(entry: CacheEntry, call: Invocation): Promise<NativePacket> {
    const proof = response(await call.invoke('get_msg', { message_id: Number(entry.packet.messageId) }), entry.packet.target, entry.packet.authorId, true)
    const packet = nativePacket(proof.data, entry.packet.target, entry.packet.messageId)
    if (packet.fingerprint !== entry.packet.fingerprint || Object.hasOwn(proof, 'user_id') && id(proof.user_id) !== packet.authorId) throw invalid()
    return packet
  }
  function rejection(value: unknown): { state: 'failed'; code: string } | undefined {
    const row = data(value)
    // The captured transport alone constructs this marker before native dispatch.
    if (row.state === 'failed' && Object.keys(row).every(key => key === 'state' || key === 'code')) return { state: 'failed', code: 'red_packet_transport_rejected' }
    if (row.retcode === 400 || row.retcode === 1400) return { state: 'failed', code: 'red_packet_native_rejected' }
    return undefined
  }
  const port: QqRedPacketPort = {
    async read(input, sourceId, guard) {
      let selected: ConversationAddress, selectedId: string
      try { selected = target(input, owner); selectedId = messageId(sourceId) } catch { return undefined }
      return run(guard, () => JSON.stringify(target(input, owner)) === JSON.stringify(selected) && messageId(sourceId) === selectedId, undefined, undefined, async call => {
        const proof = response(await call.invoke('get_msg', { message_id: Number(selectedId) }), selected, undefined, true)
        const packet = nativePacket(proof.data, selected, selectedId)
        if (!optionalScope(proof, selected, packet.authorId)) throw invalid()
        await call.guard.ensureCurrent()
        return remember(packet)
      }, { targetId: selected.id, messageId: selectedId })
    },
    async recent(input, guard) {
      let selected: ConversationAddress, limit: number
      try { selected = target(input, owner); const row = data(guard, ['signal', 'isCurrent', 'ensureCurrent', 'limit']);
        if (typeof row.limit !== 'number' || !Number.isSafeInteger(row.limit) || row.limit < 1 || row.limit > 1000) throw invalid(); limit = row.limit } catch { return [] }
      return run<readonly AgentRedPacketSnapshot[]>(guard, () => JSON.stringify(target(input, owner)) === JSON.stringify(selected), [], [], async call => {
        const proof = response(await call.invoke('get_group_msg_history', { group_id: selected.id, count: limit }), selected), body = data(proof.data)
        const rows = array(body.messages, limit), packets: { packet: NativePacket; position: number }[] = []
        for (const [position, row] of rows.entries()) try { packets.push({ packet: nativePacket(row, selected), position }) } catch { /* An unrelated/incomplete row is not native wallet proof. */ }
        packets.sort((left, right) => right.packet.at - left.packet.at || right.position - left.position)
        await call.guard.ensureCurrent()
        return Object.freeze(packets.slice(0, MAX_CACHE_ENTRIES).map(({ packet }) => remember(packet)))
      }, { targetId: selected.id })
    },
    async revalidate(input, guard) {
      let entry: CacheEntry
      try { entry = cached(input) } catch { return false }
      return run(guard, () => cached(input) === entry, false, false, async call => { await fresh(entry, call); return true }, { targetId: entry.packet.target.id, messageId: entry.packet.messageId })
    },
    async sendPassword(input, guard): Promise<AgentRedPacketPasswordReceipt> {
      let entry: CacheEntry
      try { entry = cached(input); if (entry.packet.kind !== 'password') throw invalid() } catch { return failed() }
      return run<AgentRedPacketPasswordReceipt>(guard, () => cached(input) === entry, failed(), unknown(), async call => {
        const packet = await fresh(entry, call)
        const raw = await call.invoke('send_group_msg', { group_id: packet.target.id, message: [Object.freeze({ type: 'text', data: Object.freeze({ text: packet.title }) })] })
        const rejected = rejection(raw); if (rejected) return rejected
        try {
          const proof = response(raw, packet.target, owner.id), body = data(proof.data), sentId = messageId(body.message_id)
          if (!optionalScope(body, packet.target, owner.id) || proof.message_id !== undefined && messageId(proof.message_id) !== sentId ||
              Object.hasOwn(proof, 'messageId') || Object.hasOwn(body, 'messageId')) return unknown()
          return { state: 'confirmed', messageId: sentId }
        } catch { return unknown() }
      }, { targetId: entry.packet.target.id, messageId: entry.packet.messageId })
    },
    async grab(input, guard): Promise<AgentRedPacketGrabReceipt> {
      let entry: CacheEntry
      try { entry = cached(input); if (entry.packet.kind === 'exclusive' && !entry.packet.exclusiveForBot) throw invalid() } catch { return failed() }
      return run<AgentRedPacketGrabReceipt>(guard, () => cached(input) === entry, failed(), unknown(), async call => {
        const packet = await fresh(entry, call), memberProof = response(await call.invoke('get_group_member_info', { group_id: packet.target.id, user_id: owner.id, no_cache: true }), packet.target, owner.id)
        const member = data(memberProof.data)
        if (id(member.group_id) !== packet.target.id || id(member.user_id) !== owner.id || !optionalScope(member, packet.target, owner.id)) throw invalid()
        const name = typeof member.card === 'string' && member.card ? text(member.card, 240) : text(member.nickname, 240)
        const raw = await call.invoke('grab_red_bag', { recv_uin: packet.target.id, recv_type: 2, peer_uid: packet.target.id, name,
          pc_body: packet.pcBody, wishing: packet.title, msg_seq: packet.sequence, index: packet.index })
        const rejected = rejection(raw); if (rejected) return rejected
        try {
          const proof = response(raw, packet.target), body = data(proof.data), result = data(body.result), grabbed = data(result.grabRedBagRsp)
          if (!optionalScope(body, packet.target) || !optionalScope(grabbed, packet.target) || Object.hasOwn(grabbed, 'message_id') || Object.hasOwn(grabbed, 'messageId')) return unknown()
          const order = grabbed.recvdOrder === undefined ? undefined : data(grabbed.recvdOrder), amountFen = order === undefined ? undefined : uint(order.amount)
          if (grabbed.result === 0 && amountFen !== undefined && amountFen > 0) return { state: 'confirmed', amountFen }
          if (grabbed.result === 7 && (amountFen === undefined || amountFen === 0)) return { state: 'failed', code: 'red_packet_empty_or_expired' }
          if (grabbed.result === 0 && amountFen === 0) return { state: 'failed', code: 'red_packet_already_received' }
          return unknown()
        } catch { return unknown() }
      }, { targetId: entry.packet.target.id, messageId: entry.packet.messageId })
    },
    async readIncoming(input, event, guard) {
      let selected: ConversationAddress, candidate: NativePacket
      try { selected = target(input, owner); const row = data(event); if (id(row.self_id) !== owner.id || row.post_type !== 'message') throw invalid(); candidate = nativePacket(row, selected) } catch { return undefined }
      return run(guard, () => nativePacket(event, selected).fingerprint === candidate.fingerprint, undefined, undefined, async call => {
        const proof = response(await call.invoke('get_msg', { message_id: Number(candidate.messageId) }), selected, candidate.authorId, true), packet = nativePacket(proof.data, selected, candidate.messageId)
        if (packet.fingerprint !== candidate.fingerprint || Object.hasOwn(proof, 'user_id') && id(proof.user_id) !== packet.authorId) throw invalid()
        await call.guard.ensureCurrent()
        return remember(packet)
      }, { targetId: selected.id, messageId: candidate.messageId })
    },
    revoke(input, sourceId) {
      let selected: ConversationAddress
      try { selected = target(input, owner); if (sourceId !== undefined) messageId(sourceId) } catch { return }
      for (const [key, entry] of cache) if (entry.packet.target.id === selected.id && (sourceId === undefined || entry.packet.messageId === sourceId)) cache.delete(key)
      for (const [controller, active] of controllers) if (active.targetId === selected.id && (sourceId === undefined || active.messageId === undefined || active.messageId === sourceId)) controller.abort()
    },
    close() { closed = true; cache.clear(); for (const controller of controllers.keys()) controller.abort() },
  }
  // Bind the opaque handles to this captured connection even when an account has multiple lifetimes.
  void connectionId
  return Object.freeze(port)
}
