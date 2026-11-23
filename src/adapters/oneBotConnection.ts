import { createQqInteractionDeliveryPort, QQ_INTERACTION_TIMEOUT_MS } from './qqInteractionDelivery.js'
import { captureQqOwnMessageTarget, isQqOwnMessageId, proveQqFriend, proveQqOwnMessage } from './qqOwnMessageProof.js'
export { createQqInteractionDeliveryPort, QQ_INTERACTION_TIMEOUT_MS } from './qqInteractionDelivery.js'
export type { QqInteractionApiAction, QqInteractionApiOptions } from './qqInteractionDelivery.js'
import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import WebSocket from 'ws'
import type { ConversationAddress, PlatformConnection, PlatformUserRef } from '../contracts/agentBinding.js'
import { QQ_OWNER_ALERT_MAX_LENGTH, type AgentDiagnosticDetails } from '../contracts/agentDiagnostics.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { ConversationMember, ConversationMemberProfile, ConversationMemberReadOptions, ForwardContent, PlatformConnectionAdapter, PlatformConversationEvent } from '../contracts/platformConnection.js'
import type { MessageActionOptions } from '../contracts/platformMessage.js'
import type { FileReadGuard, ConversationFileEntry } from '../contracts/agentFiles.js'
import type { AgentQzoneGuard, AgentQzoneLedger } from '../contracts/agentQzone.js'
import { createQqGiftDeliveryPort } from './qqGiftDelivery.js'
import { createQqQzoneProvider } from './qqQzoneProvider.js'
import { createQqRedPacketPort } from './qqRedPacket.js'
import type { QqRedPacketPort } from './qqRedPacket.js'
import { extractForwardIdFromSegment } from '../modules/conversation/domain/messageSegments.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { safeTruncateUnicode } from '../modules/models/domain/unicodeText.js'
import { queuedDeliveryAllowed } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId, resolveQqConversationAddress } from './qqIdentity.js'
import { createQqConversationNames } from './qqConversationNames.js'
import { decodeQqIncomingMessage, decodeQqNudge, opaqueMessageId } from './qqMessage.js'
import { parseQqCqMessage as parseCqMessage } from './qqCqMessage.js'
import { readQqMessageImage } from './qqMessageImage.js'
import { createQqMessageVideoReader, QQ_VIDEO_API_TIMEOUT_MS } from './qqMessageVideo.js'
import { authorizeQqFile, downloadQqFile, ensureQqFileCurrent, parseQqFileResource, withQqFileRead } from './qqMessageFile.js'
import { createQqConversationFiles, qqFileResponseData } from './qqConversationFiles.js'
import { createQqMessageActionPort } from './qqMessageDelivery.js'
import { createQqFileDeliveryPort } from './qqFileDelivery.js'
import { createQqMediaDeliveryPort, QQ_MEDIA_SEND_TIMEOUT_MS } from './qqMediaDelivery.js'
import { createQqMusicDeliveryPort, QQ_MUSIC_SEND_TIMEOUT_MS } from './qqMusicDelivery.js'
import { createQqBilibiliAuthDeliveryPort, QQ_BILIBILI_AUTH_TIMEOUT_MS } from './qqBilibiliAuthDelivery.js'
import { createQqDicePrivateDeliveryPort } from './qqDicePrivateDelivery.js'
import { createQqVideoCardDeliveryPort, QQ_VIDEO_CARD_SEND_TIMEOUT_MS } from './qqVideoCardDelivery.js'
import { createQqAudioFileDeliveryPort, QQ_AUDIO_FILE_SEND_TIMEOUT_MS } from './qqAudioFileDelivery.js'
import { createQqMusicShareReader } from './qqMusicShare.js'
import { createQqMediaShareReader, QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS } from './qqMediaShare.js'
import { createQqMediaRelayDeliveryPort } from './qqMediaRelayDelivery.js'
import type { QqMediaRelayBridge } from './qqMediaRelayBridge.js'
import { createQqRequesterArchiveDeliveryPort } from './qqRequesterArchiveDelivery.js'
import type { QqRequesterArchiveBridge } from './qqRequesterArchiveBridge.js'
import { createQqGroupLogDeliveryPort } from './qqGroupLogDelivery.js'
import type { QqGroupLogBridge } from './qqGroupLogBridge.js'
import { listenOneBotReverseSocket } from './oneBotReverseSocket.js'
import { ONEBOT_MAX_PAYLOAD_BYTES } from './oneBotLimits.js'

export { createQqMediaRelayDeliveryPort, QQ_MEDIA_RELAY_SEND_TIMEOUT_MS } from './qqMediaRelayDelivery.js'
export { createQqMediaShareReader, extractQqMediaShare, QQ_MEDIA_SHARE_READ_TIMEOUT_MS, QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS } from './qqMediaShare.js'
export { openQqMediaRelayBridge } from './qqMediaRelayBridge.js'
export type { QqMediaRelayBridge, QqMediaRelayBridgeOptions, QqMediaRelayResourceLease } from './qqMediaRelayBridge.js'
export { createQqRequesterArchiveDeliveryPort } from './qqRequesterArchiveDelivery.js'
export { openQqRequesterArchiveBridge, QQ_REQUESTER_ARCHIVE_TIMEOUT_MS } from './qqRequesterArchiveBridge.js'
export type { QqRequesterArchiveBridge, QqRequesterArchiveBridgeOptions, QqRequesterArchiveLease } from './qqRequesterArchiveBridge.js'
export { openQqGroupLogBridge, QQ_GROUP_LOG_TIMEOUT_MS } from './qqGroupLogBridge.js'
export type { QqGroupLogBridge, QqGroupLogBridgeOptions, QqGroupLogLease } from './qqGroupLogBridge.js'
export { createQqGroupLogDeliveryPort } from './qqGroupLogDelivery.js'
export { createQqBilibiliAuthDeliveryPort, QQ_BILIBILI_AUTH_TIMEOUT_MS } from './qqBilibiliAuthDelivery.js'
export { createQqDicePrivateDeliveryPort, QQ_DICE_PRIVATE_TIMEOUT_MS } from './qqDicePrivateDelivery.js'
export type { QqDicePrivateApiOptions } from './qqDicePrivateDelivery.js'
export { createQqGiftDeliveryPort } from './qqGiftDelivery.js'
export type { QqGiftApiAction, QqGiftApiOptions, QqGiftDeliveryOptions } from './qqGiftDelivery.js'
export { createQqQzoneProvider, QQ_QZONE_TIMEOUT_MS, QQ_QZONE_HTTP_TIMEOUT_MS, QQ_QZONE_MAX_RESPONSE_BYTES } from './qqQzoneProvider.js'
export type { QqQzoneApiAction, QqQzoneApiOptions, QqQzoneProviderOptions } from './qqQzoneProvider.js'
export { createQqRedPacketPort, QQ_RED_PACKET_TIMEOUT_MS } from './qqRedPacket.js'
export type { QqRedPacketApiAction, QqRedPacketApiOptions, QqRedPacketOptions, QqRedPacketPort } from './qqRedPacket.js'

interface PendingRequest {
  finish(value?: unknown): void
  ownerAlert: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Reject alternate encodings rather than silently normalizing returned identities. */
function canonicalQqId(value: unknown): string | undefined {
  const id = qqId(value)
  return id && (typeof value === 'number' || value === id) ? id : undefined
}

function memberProfileText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 240 && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined
}

function memberProfileTime(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
  const milliseconds = value * 1000
  return Number.isSafeInteger(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : undefined
}

function memberProfileLevel(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/u.test(value) && Number.isSafeInteger(Number(value)) ? value : undefined
}

function decodeConversationMember(value: unknown, target: ConversationAddress, detail = false): ConversationMember | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = record(value), id = canonicalQqId(row.user_id)
  if (!id || canonicalQqId(row.group_id) !== target.id ||
      ('self_id' in row && canonicalQqId(row.self_id) !== target.account.id)) return undefined
  const name = [row.card, row.nickname].find(value => typeof value === 'string' && value.trim())
  const profile: ConversationMemberProfile = Object.freeze(Object.fromEntries(Object.entries({
    nickname: memberProfileText(row.nickname),
    conversationName: memberProfileText(row.card),
    ...(detail ? {
      title: memberProfileText(row.title),
      level: memberProfileLevel(row.level),
      joinedAt: memberProfileTime(row.join_time),
      lastSpokeAt: memberProfileTime(row.last_sent_time),
      mutedUntil: memberProfileTime(row.shut_up_timestamp),
      gender: row.sex === 'male' || row.sex === 'female' || row.sex === 'unknown' ? row.sex : undefined,
      age: typeof row.age === 'number' && Number.isSafeInteger(row.age) && row.age >= 1 && row.age <= 150 ? row.age : undefined,
      region: memberProfileText(row.area),
    } : {}),
  }).filter(([, content]) => content !== undefined)))
  return Object.freeze({
    user: Object.freeze({ platform: 'qq', namespace: 'global', id }),
    displayName: safeTruncateUnicode(typeof name === 'string' ? name.trim() : id, 128),
    role: row.role === 'owner' || row.role === 'admin' || row.role === 'member' ? row.role : 'unknown',
    ...(Object.keys(profile).length ? { profile } : {}),
  })
}

export function parseOneBotUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('OneBot url 必须是 WebSocket 地址') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OneBot url 须使用 ws:// 或 wss://，凭据单独从环境变量读取')
  }
  return url
}

export function parseOneBotReverseUrl(value: string): URL {
  const url = parseOneBotUrl(value)
  if (url.protocol !== 'ws:') throw new Error('反向 OneBot 监听地址须使用 ws://，TLS 由部署代理提供')
  return url
}

function decodeEvent(payload: Record<string, unknown>, accountId: string): PlatformConversationEvent | null {
  if (qqId(payload.self_id) !== accountId) return null
  const kind = payload.message_type
  const isFriend = kind === 'private' && payload.sub_type === 'friend' && payload.group_id == null
  if (payload.post_type === 'message' && (kind === 'group' || isFriend)) {
    const time = typeof payload.time === 'number' || (typeof payload.time === 'string' && /^\d+$/u.test(payload.time))
      ? Number(payload.time) : NaN
    if (!Number.isSafeInteger(time * 1000) || time <= 0) return null
    const segments = typeof payload.message === 'string' ? parseCqMessage(payload.message) : payload.message
    const message = decodeQqIncomingMessage({
      self_id: payload.self_id, group_id: payload.group_id, user_id: payload.user_id, message_id: payload.message_id,
      message_type: kind, time, sender: payload.sender, message: segments,
    })
    if (!message?.messageId || message.conversation.kind !== kind || message.sender.id === accountId) return null
    const { quote, ...incoming } = message
    // A reply segment identifies the source to verify. Its parameters alone
    // do not prove the quoted author or the scope of any quoted text.
    const hasReply = quote?.messageId || (Array.isArray(segments) && segments.some(part => record(part).type === 'reply'))
    return { kind: 'message', message: { ...incoming,
      ...(hasReply ? { quote: { parts: [], ...(quote?.messageId ? { messageId: quote.messageId } : {}) } } : {}),
    } }
  }
  if (payload.post_type !== 'notice') return null
  const recallKind = payload.notice_type === 'group_recall' ? 'group' : payload.notice_type === 'friend_recall' ? 'private' : null
  if (!recallKind) return decodeQqNudge(payload, { requireRecipient: true })
  const target = resolveQqConversationAddress(payload)
  const messageId = opaqueMessageId(payload.message_id)
  return target?.kind === recallKind && messageId ? { kind: 'recall', target, messageId } : null
}

function decodeGroupMessage(response: unknown, target: ConversationAddress, messageId: string) {
  const result = record(response)
  const data = record(result.data)
  const authorId = qqId(record(data.sender).user_id ?? data.user_id)
  if (result.status !== 'ok' || result.retcode !== 0 || data.message_type !== 'group' ||
      (result.self_id != null && canonicalQqId(result.self_id) !== target.account.id) ||
      qqId(data.group_id) !== target.id || opaqueMessageId(data.message_id) !== messageId || !authorId ||
      (data.self_id != null && qqId(data.self_id) !== target.account.id) ||
      (data.user_id != null && qqId(data.user_id) !== authorId) ||
      typeof data.time !== 'number' || !Number.isSafeInteger(data.time * 1000) || data.time <= 0) return undefined
  const segments = typeof data.message === 'string' ? parseCqMessage(data.message) : data.message
  if (!Array.isArray(segments)) return undefined
  const message = decodeQqIncomingMessage({ self_id: target.account.id, message_type: 'group', group_id: target.id,
    user_id: authorId, sender: data.sender, message_id: messageId, message: segments, time: data.time })
  // Keep the original text intact for downstream forgetting checks. Do not
  // accept a truncated source that could omit a deleted excerpt.
  if (message && message.text.length > 4_000) return undefined
  return message ?? undefined
}

/** A private re-read proves a friend source, never a TEMP/group conversation. */
function decodePrivateMessage(response: unknown, target: ConversationAddress, messageId: string) {
  const result = record(response), data = record(result.data), sender = record(data.sender)
  const authorId = canonicalQqId(sender.user_id)
  if (result.status !== 'ok' || result.retcode !== 0 || data.message_type !== 'private' || data.sub_type !== undefined && data.sub_type !== 'friend' ||
      data.group_id != null || data.temp_source != null || data.isGroup === true || sender.group_id != null ||
      !authorId || authorId !== target.id || authorId === target.account.id ||
      (result.self_id !== undefined && canonicalQqId(result.self_id) !== target.account.id) ||
      (data.self_id !== undefined && canonicalQqId(data.self_id) !== target.account.id) ||
      (data.user_id !== undefined && canonicalQqId(data.user_id) !== authorId) ||
      opaqueMessageId(data.message_id) !== messageId || typeof data.message_id !== 'number' && data.message_id !== messageId ||
      typeof data.message !== 'string' && !Array.isArray(data.message)) return undefined
  // Use the ingress decoder so quote markers and CQ/array parts have identical
  // authority. A reply's embedded author/text is never promoted to evidence.
  const event = decodeEvent({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: target.account.id,
    user_id: authorId, sender, message_id: data.message_id, time: data.time, message: data.message }, target.account.id)
  return event?.kind === 'message' && event.message.text.length <= 4_000 ? event.message : undefined
}

function privateFriendProof(response: unknown, target: ConversationAddress): boolean {
  const result = record(response), values = result.data
  if (result.status !== 'ok' || result.retcode !== 0 || !Array.isArray(values) || values.length > 10_000 ||
      result.complete === false || result.truncated === true || result.has_more === true ||
      result.self_id !== undefined && canonicalQqId(result.self_id) !== target.account.id) return false
  const peers = new Set<string>()
  for (const value of values) {
    const row = record(value), id = canonicalQqId(row.user_id)
    if (!id || peers.has(id) || row.self_id !== undefined && canonicalQqId(row.self_id) !== target.account.id) return false
    peers.add(id)
  }
  return peers.has(target.id)
}

function forwardIdOf(value: unknown): string | undefined {
  const id = opaqueMessageId(value)
  return id && id.length <= 256 && !/\s|[\u0000-\u001f\u007f]|:\/\//u.test(id) ? id : undefined
}

function forwardNodes(value: unknown): unknown[] | undefined {
  const result = record(value)
  if (result.status !== 'ok' || result.retcode !== 0) return undefined
  const data = record(result.data)
  const nodes = data.messages ?? data.message
  return Array.isArray(nodes) ? nodes : undefined
}

const forwardMediaLabels = new Map([
  ['image', '[图片]'], ['mface', '[表情]'], ['face', '[表情]'], ['video', '[视频]'],
  ['audio', '[语音]'], ['record', '[语音]'], ['voice', '[语音]'], ['file', '[文件]'], ['json', '[卡片]'], ['xml', '[卡片]'],
])

/** Normalize OneBot node segments and implementations returning message rows. */
async function readForwardContent(root: string, fetchNodes: (id: string) => Promise<unknown[] | undefined>): Promise<ForwardContent | undefined> {
  const entries: Array<ForwardContent['entries'][number]> = []
  const visited = new Set([root])
  let partial = false
  let nodeCount = 0
  async function unpack(nodes: unknown[], depth: number): Promise<void> {
    for (const raw of nodes) {
      if (nodeCount >= 50) { partial = true; return }
      nodeCount++
      const node = record(raw)
      const data = node.type === 'node' ? record(node.data) : node
      const content = data.message ?? data.content
      const segments = typeof content === 'string' ? parseCqMessage(content) : content
      if (!Array.isArray(segments)) { partial = true; continue }
      const sender = record(data.sender)
      const rawName = sender.card || sender.nickname || data.nickname || data.name
      const senderName = typeof rawName === 'string' && rawName.trim() ? rawName : undefined
      const occurredAt = (typeof data.time === 'number' || typeof data.time === 'string') ? Number(data.time) * 1_000 : 0
      const children: Array<{ id?: string; nodes?: unknown[] }> = []
      const text: string[] = []
      for (const rawPart of segments.slice(0, 100)) {
        const part = record(rawPart)
        const fields = record(part.data)
        const id = forwardIdOf(extractForwardIdFromSegment(part))
        if (part.type === 'forward' || id) {
          const inline = Array.isArray(fields.content) ? fields.content : undefined
          children.push({ ...(id ? { id } : {}), ...(inline ? { nodes: inline } : {}) })
          text.push('[内嵌转发]')
        } else if (part.type === 'node') {
          children.push({ nodes: [part] })
          text.push('[内嵌转发]')
        } else if (typeof rawPart === 'string') {
          text.push(rawPart)
        } else if (part.type === 'text') {
          const body = fields.text ?? part.text
          if (typeof body === 'string') text.push(body)
          else partial = true
        } else if (part.type === 'at') {
          text.push('[@]')
        } else if (typeof part.type === 'string') {
          const label = forwardMediaLabels.get(part.type)
          if (label) text.push(label)
          else if (part.type !== 'reply') { text.push('[其他消息]'); partial = true }
        } else partial = true
      }
      const body = text.join('')
      if (segments.length > 100 || body.length > 4_000 || (senderName?.length ?? 0) > 256) partial = true
      else entries.push({ depth, text: body, ...(senderName ? { senderName } : {}),
        ...(Number.isSafeInteger(occurredAt) && occurredAt > 0 ? { occurredAt } : {}) })
      for (const child of children) {
        if (depth >= 2 || nodeCount >= 50 || (child.id && visited.has(child.id))) { partial = true; continue }
        if (child.id) visited.add(child.id)
        const nested = child.nodes ?? (child.id ? await fetchNodes(child.id) : undefined)
        if (!nested?.length) { partial = true; continue }
        await unpack(nested, depth + 1)
      }
    }
  }
  const nodes = await fetchNodes(root)
  if (!nodes?.length) return undefined
  await unpack(nodes, 0)
  return entries.length ? { entries, partial } : undefined
}

interface OneBotEndpoint {
  connection: PlatformConnection
  url: string
  accessToken?: string
  transport?: 'forward-websocket' | 'reverse-websocket'
  /** Trusted host transport capability; native resource URLs never enter Core. */
  mediaRelay?: { readonly bridge: QqMediaRelayBridge; readonly allowsText?: (text: string) => boolean }
  /** Explicit requester-only ZIP transport; group source is verified before private upload. */
  requesterArchive?: { readonly bridge: QqRequesterArchiveBridge; readonly allowsText?: (text: string) => boolean }
  /** Explicit complete group-log transport; never opened or configured implicitly. */
  bilibiliAuth?: { readonly allowsText: (text: string) => boolean }
  /** Explicit group-authorized private dice transport; recipient is proven as a friend before send. */
  dicePrivate?: { readonly allowsText: (text: string) => boolean }
  groupLog?: { readonly bridge: QqGroupLogBridge; readonly allowsText?: (text: string) => boolean }
  qqActions?: { readonly driver: 'napcat'; readonly giftDisplay?: boolean; readonly redPackets?: boolean; readonly qzone?: boolean }
  qzoneOwnPost?: AgentQzoneLedger['readOwnPost']
}

interface OneBotConnectionOptions extends OneBotEndpoint {
  /** A running host keeps its reverse listener available until an authenticated peer arrives. */
  keepReverseListenerWaiting?: boolean
  /** Start the transport without making the rest of the host wait for QQ authentication. */
  startOffline?: boolean
  onDisconnect(): void
  onReconnect(): void
  onError(): void
  onEventError(event: { code: 'onebot_admission_queue_full' | 'onebot_admission_unconfirmed'; outcome: 'failed' | 'unknown';
    details: AgentDiagnosticDetails; error?: unknown }): void
  onApiFailure?(action: string, outcome: 'failed' | 'unknown', code: string, details: AgentDiagnosticDetails): void
  readonly alertOwner?: PlatformUserRef
  readonly conversationNameTargets?: readonly ConversationAddress[]
}

interface OwnerAlertGuard { readonly signal: AbortSignal; isCurrent(): boolean }
type OneBotAdapter = PlatformConnectionAdapter & {
  sendOwnerAlert?(text: string, guard: OwnerAlertGuard): Promise<DeliveryReceipt>
  beginOwnerAlertDrain?(): (() => void) | undefined
}

function createOneBotSession(options: OneBotConnectionOptions) {
  const { connection } = options
  const alertOwner = options.alertOwner
  const alertTarget = alertOwner?.platform === 'qq' && alertOwner.namespace === 'global'
    ? captureQqOwnMessageTarget({ account: connection.account, kind: 'private', id: alertOwner.id }) : undefined
  if (alertOwner && !alertTarget) throw new Error('QQ 告警主人或连接无效')
  if (options.transport !== undefined && !['forward-websocket', 'reverse-websocket'].includes(options.transport)) {
    throw new Error('OneBot transport 无效')
  }
  const reverse = options.transport === 'reverse-websocket'
  const url = reverse ? parseOneBotReverseUrl(options.url) : parseOneBotUrl(options.url)
  if (reverse && !options.accessToken?.trim()) throw new Error('反向 OneBot 连接必须配置 access token')
  let socket: WebSocket | undefined
  let ownerDrainSocket: WebSocket | undefined
  let listener: { close(): void } | undefined
  let cancelFirstPeer: (() => void) | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let nameRefresh: ReturnType<typeof setInterval> | undefined
  let stopped = true
  let verified = false
  let botName = connection.account.id
  const conversationNames = createQqConversationNames(connection.account, options.conversationNameTargets ?? [])
  let accept: ((event: PlatformConversationEvent) => Promise<void>) | undefined
  let receiveQueue = Promise.resolve()
  let queued = 0
  const pending = new Map<string, PendingRequest>()
  const qqActions = options.qqActions?.driver === 'napcat' ? options.qqActions : undefined
  let redPacketPort: QqRedPacketPort | undefined
  const recalledWalletSources = new Set<string>()
  const walletSourceKey = (target: ConversationAddress, messageId: string) => JSON.stringify([conversationAddressKey(target), messageId])

  function qqActionGuard(input: AgentQzoneGuard, extraKeys: string[] = []): AgentQzoneGuard | undefined {
    try {
      if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
          Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['signal', 'isCurrent', 'ensureCurrent', ...extraKeys].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return undefined
      const signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
        ensure = Object.getOwnPropertyDescriptor(input, 'ensureCurrent')?.value, client = socket, admitted = queuedDeliveryAllowed()
      if (types.isProxy(signal) || !(signal instanceof AbortSignal) || typeof check !== 'function' || types.isProxy(check) ||
          typeof ensure !== 'function' || types.isProxy(ensure) || !client) return undefined
      const isCurrent = () => {
        try { return admitted && !signal.aborted && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
          Reflect.apply(check, input, []) === true } catch { return false }
      }
      return { signal, isCurrent, async ensureCurrent() {
        if (!isCurrent()) throw new Error('OneBot QQ 操作来源已失效')
        await Reflect.apply(ensure, input, [])
        if (!isCurrent()) throw new Error('OneBot QQ 操作来源已失效')
      } }
    } catch { return undefined }
  }

  async function qqActionApi(action: string, params: Readonly<Record<string, unknown>>, guard: AgentQzoneGuard & { readonly timeoutMs: number }): Promise<unknown> {
    const client = socket
    const current = () => {
      try { return !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed() } catch { return false }
    }
    if (!client || !current()) return { state: 'failed', code: 'qq_action_cancelled' }
    try { await guard.ensureCurrent() } catch { return { state: 'failed', code: 'qq_action_cancelled' } }
    if (!current()) return { state: 'failed', code: 'qq_action_cancelled' }
    let dispatched = false
    const result = await call(client, action, params, current, guard.timeoutMs, guard.signal, () => { dispatched = true })
    // Native peers cannot forge the transport's pre-dispatch rejection marker.
    return dispatched && Object.hasOwn(record(result), 'state') ? { state: 'unknown' } : result
  }

  function openRedPackets(client: WebSocket): void {
    redPacketPort?.close()
    recalledWalletSources.clear()
    redPacketPort = qqActions?.redPackets === true ? createQqRedPacketPort({ account: connection.account, connectionId: connection.id,
      driver: 'napcat', supportsRedPacket: true, isReady: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN,
      callApi: qqActionApi }) : undefined
  }

  async function call(client: WebSocket, action: string, params: Record<string, unknown>, guard?: () => boolean, timeoutMs = 10_000, signal?: AbortSignal, onDispatch?: () => void, observeFailures = true): Promise<unknown> {
    const report = (outcome: 'failed' | 'unknown', code: string, details: AgentDiagnosticDetails = { dispatched: false, result: 'not_dispatched' }) => {
      try { if (observeFailures) options.onApiFailure?.(action, outcome, code, details) } catch { /* Observers do not affect API results. */ }
    }
    if (/^(?:set_group_kick|set_group_kick_members)(?:_async)?$/iu.test(action) ||
        /^set_group_leave(?:_async)?$/iu.test(action) && params.is_dismiss === true) {
      report('failed', 'onebot_action_forbidden')
      return { state: 'failed', code: 'onebot_action_forbidden' }
    }
    if (socket !== client || client.readyState !== WebSocket.OPEN) {
      if (!stopped) report('failed', 'onebot_disconnected')
      return { state: 'failed', code: 'onebot_disconnected' }
    }
    if (signal?.aborted) return { state: 'unknown' }
    if (guard?.() === false) return { state: 'failed', code: 'binding_changed' }
    if (pending.size >= 128) {
      report('failed', 'onebot_busy', { dispatched: false, limit: 128, result: 'not_dispatched' })
      return { state: 'failed', code: 'onebot_busy' }
    }
    const echo = randomUUID()
    type DispatchFailure = 'onebot_timeout' | 'onebot_transport_unconfirmed'
    const { value, failure, dispatched, observeResult } = await new Promise<{ value: unknown; failure: DispatchFailure | undefined;
      dispatched: boolean; observeResult: boolean }>(resolve => {
      let finished = false, dispatched = false
      const finish = (value?: unknown, failure?: DispatchFailure) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(echo)
        resolve({ value, failure, dispatched, observeResult: dispatched && !stopped && !signal?.aborted })
      }
      const abort = () => finish(undefined, signal?.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'onebot_timeout' : undefined)
      const timer = setTimeout(() => finish(undefined, 'onebot_timeout'), timeoutMs)
      pending.set(echo, { finish, ownerAlert: !observeFailures })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        if (signal?.aborted) { finish(); return }
        if (guard?.() === false) { finish({ state: 'failed', code: 'binding_changed' }); return }
        onDispatch?.()
        dispatched = true
        client.send(JSON.stringify({ action, params, echo }), error => { if (error) finish(undefined, 'onebot_transport_unconfirmed') })
      }
      catch { finish(undefined, 'onebot_transport_unconfirmed') }
    })
    // Continue in the caller's trace context after settling the WebSocket callback.
    if (failure) report(dispatched ? 'unknown' : 'failed', failure, { dispatched, result: dispatched ? 'confirmation_pending' : 'not_dispatched',
      ...(failure === 'onebot_timeout' && !signal?.aborted ? { limit: timeoutMs } : {}) })
    else if (observeResult) {
      const response = record(value)
      const nativeCode = typeof response.retcode === 'number' && Number.isInteger(response.retcode) &&
        Math.abs(response.retcode) <= 2_147_483_647 ? response.retcode : undefined
      const details: AgentDiagnosticDetails = { dispatched, ...(nativeCode === undefined ? {} : { nativeCode }) }
      if (response.status === 'async') report('unknown', 'onebot_response_unconfirmed', { ...details, result: 'confirmation_pending' })
      else if (response.status === 'failed' || Number.isInteger(response.retcode) && response.retcode !== 0) report('failed', 'onebot_rejected', details)
      else if (response.status !== 'ok' || response.retcode !== 0) report('unknown',
        value === undefined ? 'onebot_transport_unconfirmed' : 'onebot_response_unconfirmed', { ...details, result: 'confirmation_pending' })
    }
    return value ?? { state: 'unknown' }
  }

  async function sendOwnerAlert(text: string, guard: OwnerAlertGuard): Promise<DeliveryReceipt> {
    if (!alertTarget || !text || text.length > QQ_OWNER_ALERT_MAX_LENGTH) return { state: 'failed', code: 'owner_alert_invalid' }
    const client = socket
    const current = () => {
      try {
        return !guard.signal.aborted && socket === client && client?.readyState === WebSocket.OPEN &&
          (stopped ? ownerDrainSocket === client : verified) && guard.isCurrent()
      }
      catch { return false }
    }
    if (!client || !current()) return { state: 'failed', code: 'owner_alert_unavailable' }
    // Reconfirm the fixed recipient on the authenticated socket. Alert transport failures
    // are recorded by the dispatcher and cannot feed its own queue.
    const friends = await call(client, 'get_friend_list', {}, current, 4_000, guard.signal, undefined, false)
    if (!current() || !proveQqFriend(friends, alertTarget)) return { state: 'failed', code: 'owner_friend_unconfirmed' }
    let dispatched = false
    try {
      const numericId = Number(alertTarget.id)
      const raw = await call(client, 'send_private_msg', { user_id: Number.isSafeInteger(numericId) ? numericId : alertTarget.id,
        message: [{ type: 'text', data: { text } }] }, current, 7_000, guard.signal, () => { dispatched = true }, false)
      if (!dispatched) return { state: 'failed', code: 'owner_alert_unavailable' }
      const response = record(raw), data = record(response.data)
      if (response.retcode === 400 || response.retcode === 1400) return { state: 'failed', code: 'owner_alert_rejected' }
      const messageId = opaqueMessageId(data.message_id)
      if (response.status !== 'ok' || response.retcode !== 0 || !messageId || [response, data].some(row => row.group_id != null ||
        row.user_id !== undefined && canonicalQqId(row.user_id) !== alertTarget.id ||
        row.self_id !== undefined && canonicalQqId(row.self_id) !== alertTarget.account.id)) return { state: 'unknown' }
      return { state: 'sent', messageId }
    } catch { return dispatched ? { state: 'unknown' } : { state: 'failed', code: 'owner_alert_unavailable' } }
  }

  function reconnect(): void {
    if (stopped || reverse || retry) return
    retry = setTimeout(() => {
      retry = undefined
      void connect(false).catch(() => reconnect())
    }, 2_000)
  }

  async function connect(initial: boolean): Promise<void> {
    if (stopped) return
    const client = new WebSocket(url, {
      handshakeTimeout: 5_000, maxPayload: ONEBOT_MAX_PAYLOAD_BYTES,
      ...(options.accessToken ? { headers: { Authorization: `Bearer ${options.accessToken}` } } : {}),
    })
    await attach(client, initial)
  }

  async function attach(client: WebSocket, initial: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket = client
      let authenticated = false
      let alive = true
      const detach = () => {
        if (socket !== client) return
        socket = undefined
        verified = false
        redPacketPort?.close()
        redPacketPort = undefined
        recalledWalletSources.clear()
        if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
        if (nameRefresh) { clearInterval(nameRefresh); nameRefresh = undefined }
        for (const request of pending.values()) request.finish()
      }
      client.on('error', () => {})
      client.once('close', () => {
        const current = socket === client
        detach()
        if (!authenticated) reject(new Error(`OneBot 连接 ${connection.id} 未能验证 QQ 账号`))
        else if (current && !stopped) { options.onDisconnect(); reconnect() }
      })
      client.on('pong', () => { alive = true })
      client.on('message', (frame, binary) => {
        if (socket !== client || binary) return
        let payload: Record<string, unknown>
        try { payload = record(JSON.parse(String(frame))) } catch { return }
        if (typeof payload.echo === 'string') { pending.get(payload.echo)?.finish(payload); return }
        if (!authenticated || !accept) return
        const event = decodeEvent(payload, connection.account.id)
        if (!event) return
        if (event.kind === 'recall') {
          redPacketPort?.revoke(event.target, event.messageId)
          if (redPacketPort) {
            recalledWalletSources.add(walletSourceKey(event.target, event.messageId))
            if (recalledWalletSources.size > 4096) recalledWalletSources.delete(recalledWalletSources.values().next().value!)
          }
        }
        if (queued >= 256) {
          options.onEventError({ code: 'onebot_admission_queue_full', outcome: 'failed', details: { step: 'dispatch', limit: 256, result: 'not_dispatched' } })
          return
        }
        const handle = accept
        queued++
        const packetPort = redPacketPort
        const wallet = payload.post_type === 'message' && payload.message_type === 'group' &&
          Array.isArray(payload.message) && payload.message.some(value => record(value).type === 'wallet')
        receiveQueue = receiveQueue.then(async () => {
          if (wallet && packetPort && event.kind === 'message') {
            const current = () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && redPacketPort === packetPort &&
              !recalledWalletSources.has(walletSourceKey(event.message.conversation, event.message.messageId!))
            const packet = await packetPort.readIncoming(event.message.conversation, payload, {
              signal: new AbortController().signal, isCurrent: current,
              async ensureCurrent() { if (!current()) throw new Error('OneBot 红包来源已失效') },
            })
            if (packet && current()) await handle({ kind: 'red-packet', target: packet.target, packet })
            return
          }
          await handle(event)
        }).catch(error => options.onEventError({ code: 'onebot_admission_unconfirmed', outcome: 'unknown',
          details: { step: 'enqueue', result: 'confirmation_pending' }, error })).finally(() => { queued-- })
      })
      const authenticate = () => {
        void (async () => {
          const response = record(await call(client, 'get_login_info', {}))
          const identity = record(response.data)
          if (stopped || socket !== client) { client.terminate(); return }
          if (response.status !== 'ok' || response.retcode !== 0 || qqId(identity.user_id) !== connection.account.id) {
            if (response.status === 'ok' && response.retcode === 0) {
              try { options.onApiFailure?.('get_login_info', 'failed', 'onebot_identity_mismatch',
                { step: 'authorization', dispatched: true, nativeCode: 0, result: 'discarded' }) } catch { /* Preserve the verified identity check. */ }
              if (!initial && !options.startOffline) { stopped = true; options.onError() }
            }
            client.terminate()
            return
          }
          authenticated = true
          verified = true
          openRedPackets(client)
          botName = typeof identity.nickname === 'string' ? identity.nickname.slice(0, 128) || botName : botName
          heartbeat = setInterval(() => {
            if (!alive || client.readyState !== WebSocket.OPEN) { client.terminate(); return }
            alive = false
            client.ping()
          }, 15_000)
          heartbeat.unref()
          if (conversationNames.enabled) {
            const current = () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN
            let refreshing = false
            const refreshNames = async () => {
              if (refreshing || !current()) return
              refreshing = true
              try {
                await conversationNames.refresh((action, params) => call(client, action, params, current, 10_000, undefined, undefined, false), current)
              } catch {
                // QQ name availability does not determine connection health.
              } finally { refreshing = false }
            }
            void refreshNames()
            nameRefresh = setInterval(refreshNames, 5 * 60_000)
            nameRefresh.unref()
          }
          if (!initial) options.onReconnect()
          resolve()
        })().catch(() => client.terminate())
      }
      if (client.readyState === WebSocket.OPEN) authenticate()
      else client.once('open', authenticate)
    })
  }

  let reverseGeneration = 0
  async function listen(): Promise<void> {
    const generation = ++reverseGeneration
    const waiting = options.startOffline === true || options.keepReverseListenerWaiting === true
    const live = () => !stopped && generation === reverseGeneration
    let firstPeer = true
    let complete!: () => void
    let fail!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
    // Register rejection handling before opening the listener, including when bind fails.
    void ready.catch(() => {})
    cancelFirstPeer = () => fail(new Error(`OneBot 连接 ${connection.id} 未能验证 QQ 账号`))
    const cancel = cancelFirstPeer
    const timer = waiting ? undefined : setTimeout(cancel, 15_000)
    try {
      const listening = await listenOneBotReverseSocket({
        url, accountId: connection.account.id, accessToken: options.accessToken!,
        available: () => live() && !socket,
        accept(client) {
          if (!live()) { client.terminate(); return }
          const initial = firstPeer
          void attach(client, initial || waiting).then(() => {
            if (!live()) return
            firstPeer = false
            complete()
            if (waiting && (!initial || options.startOffline)) options.onReconnect()
          }, error => { if (live() && initial && !waiting) fail(error instanceof Error ? error : new Error('OneBot 账号核验失败')) })
        },
        onError: options.onError,
      })
      if (!live()) { listening.close(); throw new Error('OneBot 连接已停止') }
      listener = listening
      if (!options.startOffline) await ready
    } finally {
      clearTimeout(timer)
      if (cancelFirstPeer === cancel) cancelFirstPeer = undefined
    }
  }

  function stop(): void {
    stopped = true
    reverseGeneration++
    accept = undefined
    verified = false
    redPacketPort?.close()
    redPacketPort = undefined
    recalledWalletSources.clear()
    cancelFirstPeer?.()
    if (retry) { clearTimeout(retry); retry = undefined }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
    if (nameRefresh) { clearInterval(nameRefresh); nameRefresh = undefined }
    const client = socket
    const drainingAlerts = !!client && client === ownerDrainSocket
    for (const request of pending.values()) if (!drainingAlerts || !request.ownerAlert) request.finish()
    if (!drainingAlerts) {
      socket = undefined
      client?.terminate()
      listener?.close()
      listener = undefined
    }
    conversationFiles.clear()
  }

  function beginOwnerAlertDrain(): (() => void) | undefined {
    const client = socket
    if (!alertTarget || stopped || !verified || client?.readyState !== WebSocket.OPEN) return undefined
    ownerDrainSocket = client
    stop()
    return () => {
      if (ownerDrainSocket !== client) return
      ownerDrainSocket = undefined
      stop()
    }
  }

  const outbound = createQqMessageActionPort({
    sendApi: (action, params) => verified && socket ? call(socket, action, params, queuedDeliveryAllowed) : Promise.resolve({ state: 'failed', code: 'onebot_disconnected' }),
  })
  const nativeGift = qqActions?.giftDisplay === true ? createQqGiftDeliveryPort({ account: connection.account, connectionId: connection.id,
    supportsGiftPacket: true, isReady: () => !stopped && verified && socket?.readyState === WebSocket.OPEN, callApi: qqActionApi }) : undefined
  const nativeQzone = qqActions?.qzone === true ? createQqQzoneProvider({ account: connection.account, connectionId: connection.id,
    isReady: () => !stopped && verified && socket?.readyState === WebSocket.OPEN, callApi: qqActionApi,
    ...(options.qzoneOwnPost ? { readOwnPost: options.qzoneOwnPost } : {}) }) : undefined
  const redPackets = qqActions?.redPackets === true ? Object.freeze<NonNullable<PlatformConnectionAdapter['redPackets']>>({
    read(target, id, input) { const guard = qqActionGuard(input), port = redPacketPort; return guard && port ? port.read(target, id, guard) : Promise.resolve(undefined) },
    recent(target, input) {
      const guard = qqActionGuard(input, ['limit']), port = redPacketPort
      return guard && port ? port.recent(target, { ...guard, limit: Object.getOwnPropertyDescriptor(input, 'limit')?.value }) : Promise.resolve([])
    },
    revalidate(packet, input) { const guard = qqActionGuard(input), port = redPacketPort; return guard && port ? port.revalidate(packet, guard) : Promise.resolve(false) },
    sendPassword(packet, input) { const guard = qqActionGuard(input), port = redPacketPort; return guard && port ? port.sendPassword(packet, guard) : Promise.resolve({ state: 'failed', code: 'qq_action_cancelled' }) },
    grab(packet, input) { const guard = qqActionGuard(input), port = redPacketPort; return guard && port ? port.grab(packet, guard) : Promise.resolve({ state: 'failed', code: 'qq_action_cancelled' }) },
    revoke(target, id) { redPacketPort?.revoke(target, id) },
  }) : undefined
  const sendFile = createQqFileDeliveryPort({
    account: connection.account, connectionId: connection.id,
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, 20_000, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendMedia = createQqMediaDeliveryPort({
    account: connection.account, connectionId: connection.id,
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, QQ_MEDIA_SEND_TIMEOUT_MS, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendMusic = createQqMusicDeliveryPort({
    account: connection.account, connectionId: connection.id,
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, QQ_MUSIC_SEND_TIMEOUT_MS, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendDicePrivate = createQqDicePrivateDeliveryPort({
    account: connection.account, connectionId: connection.id,
    ...(options.dicePrivate ? { allowsText: options.dicePrivate.allowsText } : {}),
    readApi: async (action, params, guard) => {
      const result = await qqActionApi(action, params, guard), response = record(result)
      // A native handler/transport failure does not prove that its source is invalid.
      if (response.state === 'failed' || response.status === 'ok' && response.retcode === 0 ||
          response.retcode === 400 || response.retcode === 1400) return result
      throw new Error('OneBot 骰子私密投递来源读取结果未知')
    },
    sendApi: qqActionApi,
  })
  const sendRequesterBilibiliAuth = createQqBilibiliAuthDeliveryPort({
    account: connection.account, connectionId: connection.id,
    ...(options.bilibiliAuth ? { allowsText: options.bilibiliAuth.allowsText } : {}),
    readApi: async (action, params, guard) => {
      const client = socket
      const current = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent()
      if (!client || !current()) return undefined
      return call(client, action, params, current, 1_500, guard.signal)
    },
    sendApi: async (action, params, guard) => {
      const client = socket
      const current = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !current()) return { state: 'failed', code: 'onebot_disconnected' }
      const result = await call(client, action, params, current, QQ_BILIBILI_AUTH_TIMEOUT_MS, guard.signal)
      return current() ? result : { state: 'unknown' }
    },
  })
  const interact = createQqInteractionDeliveryPort({
    account: connection.account, connectionId: connection.id,
    isReady: () => !!socket && !stopped && verified && socket.readyState === WebSocket.OPEN,
    async callApi(action, params, guard) {
      const client = socket
      const current = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !current()) return { state: 'failed', code: 'onebot_disconnected' }
      await guard.ensureCurrent()
      if (!current()) return { state: 'failed', code: 'interaction_cancelled' }
      const result = await call(client, action, params, current, guard.timeoutMs, guard.signal)
      return current() ? result : { state: 'unknown' }
    },
  })
  const sendVideoCard = createQqVideoCardDeliveryPort({
    account: connection.account, connectionId: connection.id,
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, QQ_VIDEO_CARD_SEND_TIMEOUT_MS, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendAudioFile = createQqAudioFileDeliveryPort({
    account: connection.account, connectionId: connection.id,
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, QQ_AUDIO_FILE_SEND_TIMEOUT_MS, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendMediaRelay = options.mediaRelay && createQqMediaRelayDeliveryPort({
    account: connection.account, connectionId: connection.id, bridge: options.mediaRelay.bridge,
    ...(options.mediaRelay.allowsText ? { allowsText: options.mediaRelay.allowsText } : {}),
    sendApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return { state: 'failed', code: 'onebot_disconnected' }
      // guard also captures the socket at actions.sendMediaRelay entry, before
      // adapter queuing or resource preparation can await/reconnect.
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent() && queuedDeliveryAllowed()
      const response = await call(client, action, params, isCurrent, guard.timeoutMs, guard.signal)
      return isCurrent() ? response : { state: 'unknown' }
    },
  })
  const sendRequesterArchive = options.requesterArchive && createQqRequesterArchiveDeliveryPort({
    account: connection.account, connectionId: connection.id, bridge: options.requesterArchive.bridge,
    ...(options.requesterArchive.allowsText ? { allowsText: options.requesterArchive.allowsText } : {}),
    readApi: async (action, params, guard) => {
      const client = socket
      const isCurrent = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !isCurrent()) return undefined
      const result = await call(client, action, params, isCurrent, guard.timeoutMs, guard.signal)
      return isCurrent() ? result : undefined
    },
    sendApi: async (action, params, guard) => {
      const client = socket
      const isCurrent = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !isCurrent()) return { state: 'failed', code: 'onebot_disconnected' }
      const result = await call(client, action, params, isCurrent, guard.timeoutMs, guard.signal)
      return isCurrent() ? result : { state: 'unknown' }
    },
  })
  const sendGroupLog = options.groupLog && createQqGroupLogDeliveryPort({
    account: connection.account, connectionId: connection.id, bridge: options.groupLog.bridge,
    ...(options.groupLog.allowsText ? { allowsText: options.groupLog.allowsText } : {}),
    readApi: async (action, params, guard) => {
      const client = socket
      const isCurrent = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !isCurrent()) return undefined
      const result = await call(client, action, params, isCurrent, guard.timeoutMs, guard.signal)
      return isCurrent() ? result : undefined
    },
    sendApi: async (action, params, guard) => {
      const client = socket
      const isCurrent = () => !!client && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && queuedDeliveryAllowed()
      if (!client || !isCurrent()) return { state: 'failed', code: 'onebot_disconnected' }
      const result = await call(client, action, params, isCurrent, guard.timeoutMs, guard.signal)
      return isCurrent() ? result : { state: 'unknown' }
    },
  })
  const readMusicShare = createQqMusicShareReader({
    account: connection.account,
    readApi: async (action, params, guard) => {
      const client = socket
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return undefined
      const isCurrent = () => !guard.signal.aborted && !stopped && verified && socket === client &&
        client.readyState === WebSocket.OPEN && guard.isCurrent()
      const response = await call(client, action, params, isCurrent, action === 'get_friend_list' ? 5_000 : 1_500, guard.signal)
      return isCurrent() ? response : undefined
    },
  })
  const accountKey = platformAccountKey(connection.account)
  const servesAccount = (target: ConversationAddress) => platformAccountKey(target.account) === accountKey
  const servesGroup = (target: ConversationAddress) => target.kind === 'group' && servesAccount(target)
  const conversationFiles = createQqConversationFiles()
  function memberReadScope(target: ConversationAddress, options: ConversationMemberReadOptions, user?: PlatformUserRef) {
    const client = socket, signal = options?.signal, check = options?.isCurrent
    if (!(signal instanceof AbortSignal) || target?.kind !== 'group' || target.account?.platform !== 'qq' ||
        target.account.namespace !== 'global' || canonicalQqId(target.account.id) !== target.account.id ||
        canonicalQqId(target.id) !== target.id || !servesAccount(target) || !client || !verified || stopped ||
        user && (user.platform !== 'qq' || user.namespace !== 'global' || canonicalQqId(user.id) !== user.id)) return undefined
    const key = conversationAddressKey(target), userKey = user && platformAccountKey(user)
    const captured = Object.freeze({ account: Object.freeze({ ...target.account }), kind: 'group' as const, id: target.id })
    const isCurrent = () => {
      try {
        if (check?.() === false) return false
        return !signal.aborted && !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
          platformAccountKey(connection.account) === accountKey && conversationAddressKey(target) === key &&
          (!user || platformAccountKey(user) === userKey)
      } catch { return false }
    }
    return isCurrent() ? { client, signal, target: captured, isCurrent } : undefined
  }
  async function readConversationMembers(target: ConversationAddress, options: ConversationMemberReadOptions, user?: PlatformUserRef) {
    try {
      const scope = memberReadScope(target, options, user)
      if (!scope) return undefined
      const requestedId = user?.id
      const response = record(await call(scope.client, user ? 'get_group_member_info' : 'get_group_member_list', {
        group_id: scope.target.id, ...(user ? { user_id: requestedId, no_cache: true } : {}),
      }, scope.isCurrent, 1500, scope.signal))
      if (!scope.isCurrent() || response.status !== 'ok' || response.retcode !== 0 ||
          ('self_id' in response && canonicalQqId(response.self_id) !== scope.target.account.id)) return undefined
      const rows = user ? [response.data] : response.data
      if (!Array.isArray(rows) || rows.length > 5000) return undefined
      const members = new Map<string, ConversationMember>()
      for (const row of rows) {
        const member = decodeConversationMember(row, scope.target, user !== undefined)
        if (!member || requestedId !== undefined && member.user.id !== requestedId) return undefined
        const existing = members.get(member.user.id)
        if (existing && (existing.role !== member.role || existing.displayName !== member.displayName || JSON.stringify(existing.profile) !== JSON.stringify(member.profile))) return undefined
        members.set(member.user.id, member)
      }
      if (!scope.isCurrent()) return undefined
      return { target: scope.target, observedAt: Date.now(), members: Object.freeze([...members.values()]), complete: true as const }
    } catch { return undefined }
  }
  async function readMessage(target: ConversationAddress, messageId: string, guard?: MessageActionOptions & { signal?: AbortSignal }) {
    if (target.kind === 'private') {
      try {
        const client = socket, id = Number(messageId), signal = guard?.signal
        if (!verified || !client || !servesAccount(target) || target.account.platform !== 'qq' || target.account.namespace !== 'global' ||
            canonicalQqId(target.account.id) !== target.account.id || canonicalQqId(target.id) !== target.id || target.id === connection.account.id ||
            !/^-?[1-9][0-9]{0,9}$/u.test(messageId) || id < -2_147_483_648 || id > 2_147_483_647 ||
            signal !== undefined && !(signal instanceof AbortSignal)) return undefined
        const key = conversationAddressKey(target), captured = Object.freeze({ account: Object.freeze({ ...target.account }), kind: 'private' as const, id: target.id })
        const isCurrent = () => {
          try { return !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && !signal?.aborted &&
            platformAccountKey(connection.account) === accountKey && conversationAddressKey(target) === key &&
            (guard?.isCurrent === undefined || guard.isCurrent() === true) } catch { return false }
        }
        if (!isCurrent()) return undefined
        // Standard get_msg has no required friend subtype. Prove friendship on
        // this exact authenticated socket for each read; never cache a TEMP peer.
        const friends = await call(client, 'get_friend_list', {}, isCurrent, 5_000, signal)
        if (!isCurrent() || !privateFriendProof(friends, captured)) return undefined
        const response = await call(client, 'get_msg', { message_id: id }, isCurrent, 1_500, signal)
        return isCurrent() ? decodePrivateMessage(response, captured, messageId) : undefined
      } catch { return undefined }
    }
    const client = socket
    // OneBot v11 get_msg accepts a signed 32-bit message ID.
    const id = Number(messageId)
    if (!verified || !client || !servesGroup(target) ||
        !/^-?[1-9][0-9]{0,9}$/u.test(messageId) || id < -2_147_483_648 || id > 2_147_483_647) return undefined
    const response = await call(client, 'get_msg', { message_id: id }, guard?.isCurrent, 1_500, guard?.signal)
    if (guard?.signal?.aborted || socket !== client || !verified || guard?.isCurrent?.() === false) return undefined
    return decodeGroupMessage(response, target, messageId)
  }
  async function readOwnMessage(target: ConversationAddress, messageId: string, guard: MessageActionOptions & { signal?: AbortSignal } = {}) {
    let cancel: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, watch: ReturnType<typeof setInterval> | undefined
    try {
      const captured = captureQqOwnMessageTarget(target), client = socket
      if (!captured || !isQqOwnMessageId(messageId) || !servesAccount(captured) || !client || !verified || stopped ||
          !guard || typeof guard !== 'object' || types.isProxy(guard) || ![Object.prototype, null].includes(Object.getPrototypeOf(guard)) ||
          Reflect.ownKeys(guard).some(key => typeof key !== 'string' || !['isCurrent', 'signal', 'ensureCurrent'].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(guard, key)!, 'value'))) return undefined
      const check = Object.getOwnPropertyDescriptor(guard, 'isCurrent')?.value, parent = Object.getOwnPropertyDescriptor(guard, 'signal')?.value,
        ensure = Object.getOwnPropertyDescriptor(guard, 'ensureCurrent')?.value
      if (check !== undefined && (typeof check !== 'function' || types.isProxy(check)) ||
          ensure !== undefined && (typeof ensure !== 'function' || types.isProxy(ensure)) ||
          parent !== undefined && (typeof parent !== 'object' || !parent || types.isProxy(parent) || Object.getPrototypeOf(parent) !== AbortSignal.prototype ||
            Reflect.ownKeys(parent).some(key => typeof key === 'string'))) return undefined
      if (parent !== undefined) Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(parent)
      cancel = new AbortController()
      const signal = AbortSignal.any([cancel.signal, ...(parent ? [parent as AbortSignal] : [])]), key = conversationAddressKey(captured)
      const current = () => {
        try { const live = captureQqOwnMessageTarget(target); return !signal.aborted && !stopped && verified && socket === client &&
          client.readyState === WebSocket.OPEN && platformAccountKey(connection.account) === accountKey && !!live &&
          conversationAddressKey(live) === key && (check === undefined || check.call(guard) === true) } catch { return false }
      }
      if (!current()) return undefined
      timer = setTimeout(() => cancel!.abort(), QQ_INTERACTION_TIMEOUT_MS)
      watch = setInterval(() => { if (!current()) cancel!.abort() }, 25)
      return await new Promise<ReturnType<typeof proveQqOwnMessage>>(resolve => {
        const abort = () => resolve(undefined)
        signal.addEventListener('abort', abort, { once: true })
        const operation = async () => {
          await ensure?.call(guard)
          if (!current()) return undefined
          if (captured.kind === 'private') {
            const friends = await call(client, 'get_friend_list', {}, current, 5000, signal)
            if (!current() || !proveQqFriend(friends, captured)) return undefined
          }
          await ensure?.call(guard)
          if (!current()) return undefined
          const response = await call(client, 'get_msg', { message_id: Number(messageId) }, current, 1500, signal)
          return current() ? proveQqOwnMessage(response, captured, messageId) : undefined
        }
        void operation().then(resolve, () => resolve(undefined)).finally(() => signal.removeEventListener('abort', abort))
      })
    } catch { return undefined }
    finally { if (timer) clearTimeout(timer); if (watch) clearInterval(watch); cancel?.abort() }
  }
  async function readFileOperation<T>(target: ConversationAddress, options: FileReadGuard,
    read: (target: ConversationAddress, guard: FileReadGuard, invoke: (action: string, params: Record<string, unknown>) => Promise<unknown>) => Promise<T>) {
    const scope = memberReadScope(target, options)
    if (!scope) return undefined
    return withQqFileRead({ signal: scope.signal, isCurrent: scope.isCurrent,
      ...(options.ensureCurrent ? { ensureCurrent: () => options.ensureCurrent!() } : {}),
    }, async guard => {
      const invoke = async (action: string, params: Record<string, unknown>) => {
        await ensureQqFileCurrent(guard)
        const response = await call(scope.client, action, params, guard.isCurrent, 1500, guard.signal)
        await ensureQqFileCurrent(guard)
        return response
      }
      return read(scope.target, guard, invoke)
    })
  }
  async function resolveFileUrl(target: ConversationAddress, file: { id: string; busid?: string }, invoke: (action: string, params: Record<string, unknown>) => Promise<unknown>) {
    const response = await invoke('get_group_file_url', { group_id: target.id, file_id: file.id,
      ...(file.busid !== undefined ? { busid: file.busid } : {}),
    })
    const data = qqFileResponseData(response, target)
    if (!data || data.file_id !== undefined && data.file_id !== file.id || data.busid !== undefined && String(data.busid) !== file.busid) return undefined
    const url = data.url ?? data.file_url ?? data.download_url
    return typeof url === 'string' ? url : undefined
  }
  async function start(handler?: (event: PlatformConversationEvent) => Promise<void>): Promise<void> {
    if (ownerDrainSocket) throw new Error('OneBot 告警队列正在退出')
    if (!stopped) return
    stopped = false
    accept = handler
    if (options.startOffline && !reverse) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Local peers often authenticate immediately. Give them a bounded initial
        // window without blocking Core startup when NapCat is offline.
        await Promise.race([connect(false).catch(reconnect), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000) })])
      } finally { clearTimeout(timer) }
      return
    }
    try { await (reverse ? listen() : connect(true)) } catch (error) { stop(); throw error }
  }

  const adapter: OneBotAdapter = {
    ...connection,
    ...(nativeGift ? { gift: (action: Parameters<NonNullable<PlatformConnectionAdapter['gift']>>[0], input: AgentQzoneGuard) => {
      const guard = qqActionGuard(input)
      return guard ? nativeGift(action, guard) : Promise.resolve({ state: 'failed' as const, code: 'qq_action_cancelled' })
    } } : {}),
    ...(nativeQzone ? { qzone: Object.freeze({ execute(action: Parameters<typeof nativeQzone.execute>[0], input: AgentQzoneGuard) {
      const guard = qqActionGuard(input)
      return guard ? nativeQzone.execute(action, guard) : Promise.resolve({ state: 'failed' as const, code: 'qq_action_cancelled' })
    } }) } : {}),
    ...(redPackets ? { redPackets, invalidateRedPacketSources() {
      const client = socket
      if (client && !stopped && verified && client.readyState === WebSocket.OPEN) openRedPackets(client)
      else {
        redPacketPort?.close()
        redPacketPort = undefined
        recalledWalletSources.clear()
      }
    } } : {}),
    botUserId: connection.account.id,
    ...(alertTarget ? { sendOwnerAlert, beginOwnerAlertDrain } : {}),
    get botName() { return botName },
    ...(conversationNames.enabled ? { conversationName: conversationNames.read } : {}),
    resolvePrivatePeer(target) {
      if (target.kind !== 'private' || !servesAccount(target) || qqId(target.id) !== target.id || target.id === connection.account.id) return undefined
      return { ...connection.account, id: target.id }
    },
    async verifyPrivateFriend(target, { signal, isCurrent: guard }) {
      const client = socket
      const isCurrent = () => !!client && socket === client && verified && !stopped && !signal.aborted && guard?.() !== false
      if (!client || !isCurrent() || target.kind !== 'private' || !servesAccount(target)) return false
      const friends = await call(client, 'get_friend_list', {}, isCurrent, 5000, signal, undefined, false)
      return isCurrent() && proveQqFriend(friends, target)
    },
    async findOwnTextDelivery(target, proof, guard) {
      const selected = captureQqOwnMessageTarget(target), client = socket
      if (!selected || !client || !servesAccount(selected) || !/^[a-f0-9]{64}$/u.test(proof.sha256) ||
          (proof.mentionId !== undefined && (selected.kind !== 'group' || qqId(proof.mentionId) !== proof.mentionId)) ||
          !Number.isSafeInteger(proof.from) || !Number.isSafeInteger(proof.until) || proof.until <= proof.from ||
          proof.until - proof.from > 60_000) return undefined
      const key = conversationAddressKey(selected)
      const current = () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
        !guard.signal.aborted && guard.isCurrent() && conversationAddressKey(target) === key
      if (!current()) return undefined
      if (selected.kind === 'private') {
        const friends = await call(client, 'get_friend_list', {}, current, 5_000, guard.signal, undefined, false)
        if (!current() || !proveQqFriend(friends, selected)) return undefined
      }
      const response = record(await call(client, selected.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history',
        selected.kind === 'group' ? { group_id: selected.id, count: 50 } : { user_id: selected.id, count: 50 },
        current, 3_000, guard.signal, undefined, false))
      const messages = record(response.data).messages
      if (!current() || response.status !== 'ok' || response.retcode !== 0 || !Array.isArray(messages) || messages.length > 50) return undefined
      let match: Awaited<ReturnType<NonNullable<PlatformConnectionAdapter['findOwnTextDelivery']>>>
      for (const raw of messages) {
        const row = record(raw), id = opaqueMessageId(row.message_id)
        if (!id) continue
        const evidence = proveQqOwnMessage({ ...response, data: row }, selected, id)
        if (!evidence || evidence.occurredAt < proof.from || evidence.occurredAt > proof.until) continue
        let parts = typeof row.message === 'string' ? parseCqMessage(row.message) : row.message
        if (proof.mentionId !== undefined) {
          if (!Array.isArray(parts) || record(parts[0]).type !== 'at' || String(record(record(parts[0]).data).qq) !== proof.mentionId) continue
          parts = parts.slice(1)
        }
        if (!Array.isArray(parts) || !parts.length || parts.some(part => record(part).type !== 'text' || typeof record(record(part).data).text !== 'string')) continue
        const text = parts.map(part => String(record(record(part).data).text)).join('')
        if (createHash('sha256').update(text).digest('hex') !== proof.sha256) continue
        if (match && match.messageId !== evidence.messageId) return undefined
        match = evidence
      }
      return current() ? match : undefined
    },
    async moderateMessage(source, action, guard) {
      const { conversation, sender, messageId } = source
      const scope = memberReadScope(conversation, guard, sender)
      if (!scope || !messageId || source.sender.id === connection.account.id ||
          !['recall', 'mute', 'unmute'].includes(action)) return { state: 'failed', code: 'moderation_scope_invalid' }
      let dispatched = false
      try {
        await guard.ensureCurrent()
        const bot = (await readConversationMembers(conversation, guard, connection.account))?.members[0]
        const member = (await readConversationMembers(conversation, guard, sender))?.members[0]
        if (!bot || !['owner', 'admin'].includes(bot.role) || member?.role !== 'member') return { state: 'failed', code: 'moderation_role_changed' }
        const observed = action === 'unmute' ? source : await readMessage(conversation, messageId, guard)
        if (!observed || observed.messageId !== messageId || observed.occurredAt !== source.occurredAt ||
            platformAccountKey(observed.sender) !== platformAccountKey(sender) || observed.text !== source.text) {
          return { state: 'failed', code: 'moderation_source_changed' }
        }
        await guard.ensureCurrent()
        if (!scope.isCurrent()) return { state: 'failed', code: 'moderation_scope_changed' }
        const result = record(await call(scope.client, action === 'recall' ? 'delete_msg' : 'set_group_ban',
          action === 'recall' ? { message_id: messageId } : { group_id: conversation.id, user_id: sender.id, duration: action === 'mute' ? 120 : 0 },
          scope.isCurrent, 8000, scope.signal, () => { dispatched = true }))
        if (result.status === 'ok' && result.retcode === 0) return { state: 'confirmed' }
        if (!dispatched || result.status === 'failed' || typeof result.retcode === 'number' && result.retcode !== 0) {
          return { state: 'failed', code: 'moderation_rejected' }
        }
        return { state: 'unknown' }
      } catch {
        return dispatched ? { state: 'unknown' } : { state: 'failed', code: 'moderation_preflight_failed' }
      }
    },
    readMessage,
    readOwnMessage,
    readMusicShare(target, messageId, guard) {
      const client = socket, check = guard?.isCurrent
      if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve(undefined)
      return readMusicShare(target, messageId, { ...guard,
        isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
      })
    },
    async readMediaShare(target, messageId, guard) {
      try {
        const client = socket
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN || !guard ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(guard)) || Reflect.ownKeys(guard).some(key =>
              typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(guard, key)!, 'value'))) return undefined
        const { signal, isCurrent: check, allowsSource, expectedSource } = guard
        if (typeof allowsSource !== 'function' || check !== undefined && typeof check !== 'function') return undefined
        const current = () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
          platformAccountKey(connection.account) === accountKey && guard.signal === signal && guard.isCurrent === check &&
          guard.allowsSource === allowsSource && guard.expectedSource === expectedSource && check?.call(guard) !== false
        // Keep the socket captured at entry through lookup and both asynchronous authorizations.
        const read = createQqMediaShareReader({ account: connection.account, readApi: async (action, params, scope) => {
          const isCurrent = () => current() && !scope.signal.aborted && scope.isCurrent()
          if (!isCurrent()) return undefined
          const response = await call(client, action, params, isCurrent, QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS, scope.signal)
          return isCurrent() ? response : undefined
        } })
        return await read(target, messageId, { signal, expectedSource, isCurrent: current,
          allowsSource: source => allowsSource.call(guard, source) })
      } catch { return undefined }
    },
    async readMessageVideo(target, messageId, guard) {
      try {
        const client = socket
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN || !guard ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(guard)) || Reflect.ownKeys(guard).some(key =>
              typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(guard, key)!, 'value'))) return undefined
        const { signal, isCurrent: check, ensureCurrent, allowsSource, allowsForwardSource, inspectOnly } = guard
        const current = () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN &&
          platformAccountKey(connection.account) === accountKey && guard.signal === signal && guard.isCurrent === check &&
          guard.ensureCurrent === ensureCurrent && guard.allowsSource === allowsSource && guard.allowsForwardSource === allowsForwardSource &&
          guard.inspectOnly === inspectOnly && check.call(guard)
        const read = createQqMessageVideoReader({ account: connection.account, readApi: async (action, params, scope) => {
          const isCurrent = () => current() && !scope.signal.aborted && scope.isCurrent()
          if (!isCurrent()) return undefined
          const response = await call(client, action, params, isCurrent, QQ_VIDEO_API_TIMEOUT_MS, scope.signal)
          return isCurrent() ? response : undefined
        } })
        return await read(target, messageId, { signal, isCurrent: current, ...(ensureCurrent ? { ensureCurrent: () => ensureCurrent.call(guard) } : {}),
          ...(inspectOnly === undefined ? {} : { inspectOnly }), allowsSource: source => allowsSource.call(guard, source),
          allowsForwardSource: source => allowsForwardSource.call(guard, source) })
      } catch { return undefined }
    },
    async readMessageFile(target, messageId, fileIndex, options) {
      if (!Number.isSafeInteger(fileIndex) || fileIndex < 1 || fileIndex > 128) return undefined
      const id = Number(messageId)
      if (!/^-?[1-9][0-9]{0,9}$/u.test(messageId) || id < -2_147_483_648 || id > 2_147_483_647) return undefined
      return readFileOperation(target, options, async (captured, guard, invoke) => {
        const original = decodeGroupMessage(await invoke('get_msg', { message_id: id }), captured, messageId)
        if (!original) return undefined
        const part = original.parts.filter(part => part.kind === 'file')[fileIndex - 1]
        const file = parseQqFileResource(part?.kind === 'file' ? part.resource : undefined)
        if (!file || part?.kind !== 'file' || part.name !== file.name) return undefined
        const authorize = () => options.allowsSource(original)
        if (!await authorizeQqFile(guard, authorize)) return undefined
        const url = await resolveFileUrl(captured, file, invoke)
        return url ? downloadQqFile(url, file.name, guard, authorize) : undefined
      })
    },
    listConversationFiles(target, options) {
      return readFileOperation(target, options, (captured, guard, invoke) => conversationFiles.list(captured, guard, invoke))
    },
    readConversationFile(target, entry, options) {
      if (!entry || typeof entry.reference !== 'string') return Promise.resolve(undefined)
      // The submitted object may be mutable; never use it as native API authority.
      const selected: ConversationFileEntry = Object.freeze({ ...entry,
        ...(entry.uploadedBy ? { uploadedBy: Object.freeze({ ...entry.uploadedBy }) } : {}),
      })
      return readFileOperation(target, options, async (captured, guard, invoke) => {
        const verified = await conversationFiles.verify(captured, selected, guard, invoke)
        if (!verified) return undefined
        const authorize = () => options.allowsFile(verified.entry)
        if (!await authorizeQqFile(guard, authorize)) return undefined
        const url = await resolveFileUrl(captured, verified.file, invoke)
        return url ? downloadQqFile(url, verified.file.name, guard, authorize) : undefined
      })
    },
    async readConversationMember(target, user, options) {
      if (!user) return undefined
      const result = await readConversationMembers(target, options, user)
      const member = result?.members[0]
      return result && member ? { target: result.target, observedAt: result.observedAt, member } : undefined
    },
    listConversationMembers: (target, options) => readConversationMembers(target, options),
    async readForward(target, source, guard) {
      const client = socket
      const root = forwardIdOf(source.forwardId)
      if (!verified || !client || !servesGroup(target) || !root || root !== source.forwardId) return undefined
      const deadline = performance.now() + 5_000
      const isCurrent = () => socket === client && verified && guard?.isCurrent?.() !== false
      const original = await readMessage(target, source.messageId, { isCurrent })
      if (!original?.parts.some(part => part.kind === 'forward' && part.id === root)) return undefined
      let requests = 0
      const result = await readForwardContent(root, async id => {
        const timeout = Math.min(1_500, Math.floor(deadline - performance.now()))
        if (!isCurrent() || requests >= 6 || timeout <= 0) return undefined
        requests++
        // OneBot v11 uses id. go-cqhttp-compatible servers use message_id for the same forward identifier.
        const response = await call(client, 'get_forward_msg', { id, message_id: id }, isCurrent, timeout)
        return isCurrent() ? forwardNodes(response) : undefined
      })
      return isCurrent() ? result : undefined
    },
    async readMessageImages(target, messageId, guard) {
      const client = socket
      const cancel = new AbortController()
      const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(5_000), ...(guard.signal ? [guard.signal] : [])])
      const isCurrent = () => {
        try { return !signal.aborted && !!client && socket === client && verified && guard.isCurrent?.() !== false }
        catch { return false }
      }
      if (!isCurrent()) return undefined
      const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
      try {
        const original = await readMessage(target, messageId, { isCurrent, signal })
        if (!original || !isCurrent()) return undefined
        const images = []
        const seen = new Set<string>()
        for (const part of original.parts) {
          if (images.length === 2 || seen.size === 2 || !isCurrent()) break
          if (part.kind !== 'image' || !part.resource || seen.has(part.resource.value)) continue
          seen.add(part.resource.value)
          try {
            const image = await readQqMessageImage(part.resource, { signal, isCurrent, authorize: () => guard.allowsSource(original) })
            if (image) images.push(image)
          } catch { /* The other attachment may still be available. */ }
        }
        return images.length && isCurrent() ? images : undefined
      } finally { clearInterval(timer); cancel.abort() }
    },
    actions: {
      ...(sendRequesterArchive ? { sendRequesterArchive: ((action, guard) => {
        try {
          const client = socket, check = guard?.isCurrent, signal = guard?.signal
          if (check !== undefined && typeof check !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) return Promise.resolve({ state: 'failed' as const, code: 'invalid_requester_archive_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed' as const, code: 'onebot_disconnected' })
          return sendRequesterArchive(action, { ...(signal ? { signal } : {}),
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
          })
        } catch { return Promise.resolve({ state: 'failed' as const, code: 'invalid_requester_archive_guard' }) }
      }) satisfies NonNullable<PlatformConnectionAdapter['actions']['sendRequesterArchive']> } : {}),
      ...(sendGroupLog ? { sendGroupLog: ((action, guard) => {
        try {
          const input = guard ?? {}
          if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
              Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['isCurrent', 'signal'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return Promise.resolve({ state: 'failed' as const, code: 'invalid_group_log_guard' })
          const client = socket, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
            signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value
          if (check !== undefined && (typeof check !== 'function' || types.isProxy(check)) ||
              signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return Promise.resolve({ state: 'failed' as const, code: 'invalid_group_log_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed' as const, code: 'onebot_disconnected' })
          return sendGroupLog(action, { ...(signal ? { signal } : {}),
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && (!check || check() === true),
          })
        } catch { return Promise.resolve({ state: 'failed' as const, code: 'invalid_group_log_guard' }) }
      }) satisfies NonNullable<PlatformConnectionAdapter['actions']['sendGroupLog']> } : {}),
      ...(sendMediaRelay ? { sendMediaRelay: ((action, guard) => {
        try {
          const input = guard === undefined ? {} : guard
          if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
              Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['isCurrent', 'signal', 'ensureCurrent'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return Promise.resolve({ state: 'failed' as const, code: 'invalid_media_relay_guard' })
          const client = socket, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
            signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value, ensure = Object.getOwnPropertyDescriptor(input, 'ensureCurrent')?.value
          if (check !== undefined && (typeof check !== 'function' || types.isProxy(check)) ||
              signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal)) ||
              ensure !== undefined && (typeof ensure !== 'function' || types.isProxy(ensure))) return Promise.resolve({ state: 'failed' as const, code: 'invalid_media_relay_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed' as const, code: 'onebot_disconnected' })
          return sendMediaRelay(action, { ...(signal ? { signal } : {}), ...(ensure ? { ensureCurrent: () => Reflect.apply(ensure, input, []) } : {}),
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && (!check || check() === true),
          })
        } catch { return Promise.resolve({ state: 'failed' as const, code: 'invalid_media_relay_guard' }) }
      }) satisfies NonNullable<PlatformConnectionAdapter['actions']['sendMediaRelay']> } : {}),
      sendAudioFile(action, guard) {
        const client = socket, check = guard?.isCurrent
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
        return sendAudioFile(action, { ...(guard?.signal ? { signal: guard.signal } : {}),
          isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
        })
      },
      sendDicePrivate(action, input) {
        const guard = qqActionGuard(input)
        return guard ? sendDicePrivate(action, guard) : Promise.resolve({ state: 'failed', code: 'qq_action_cancelled' })
      },
      sendGamePrivate(action, input) {
        const guard = qqActionGuard(input)
        return guard ? sendDicePrivate(action, guard) : Promise.resolve({ state: 'failed', code: 'qq_action_cancelled' })
      },
      sendRequesterBilibiliAuth(action, guard) {
        try {
          const input = guard ?? {}
          if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
              Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['isCurrent', 'signal'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return Promise.resolve({ state: 'failed', code: 'invalid_bilibili_auth_guard' })
          const client = socket, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
            signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value
          if (typeof check !== 'function' || types.isProxy(check) || !(signal instanceof AbortSignal) || types.isProxy(signal)) return Promise.resolve({ state: 'failed', code: 'invalid_bilibili_auth_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
          return sendRequesterBilibiliAuth(action, { signal,
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check() === true,
          })
        } catch { return Promise.resolve({ state: 'failed', code: 'invalid_bilibili_auth_guard' }) }
      },
      interact(action, guard) {
        try {
          const input = guard === undefined ? {} : guard
          if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
              Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['isCurrent', 'signal', 'ensureCurrent'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return Promise.resolve({ state: 'failed', code: 'invalid_interaction_guard' })
          const client = socket, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
            signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value, ensure = Object.getOwnPropertyDescriptor(input, 'ensureCurrent')?.value
          if (check !== undefined && (typeof check !== 'function' || types.isProxy(check)) ||
              signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal)) ||
              ensure !== undefined && (typeof ensure !== 'function' || types.isProxy(ensure))) return Promise.resolve({ state: 'failed', code: 'invalid_interaction_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
          return interact(action, { ...(signal ? { signal } : {}), ...(ensure ? { ensureCurrent: () => Reflect.apply(ensure, input, []) } : {}),
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && (!check || check() === true),
          })
        } catch { return Promise.resolve({ state: 'failed', code: 'invalid_interaction_guard' }) }
      },
      sendVideoCard(action, guard) {
        try {
          const input = guard === undefined ? {} : guard
          if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
              Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['isCurrent', 'signal', 'ensureCurrent'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) return Promise.resolve({ state: 'failed', code: 'invalid_video_card_guard' })
          const client = socket, check = Object.getOwnPropertyDescriptor(input, 'isCurrent')?.value,
            signal = Object.getOwnPropertyDescriptor(input, 'signal')?.value, ensure = Object.getOwnPropertyDescriptor(input, 'ensureCurrent')?.value
          if (check !== undefined && (typeof check !== 'function' || types.isProxy(check)) ||
              signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal)) ||
              ensure !== undefined && (typeof ensure !== 'function' || types.isProxy(ensure))) return Promise.resolve({ state: 'failed', code: 'invalid_video_card_guard' })
          if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
          return sendVideoCard(action, { ...(signal ? { signal } : {}), ...(ensure ? { ensureCurrent: () => Reflect.apply(ensure, input, []) } : {}),
            isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && (!check || check() === true),
          })
        } catch { return Promise.resolve({ state: 'failed', code: 'invalid_video_card_guard' }) }
      },
      sendMusic(action, guard) {
        const client = socket, check = guard?.isCurrent
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
        return sendMusic(action, { ...(guard?.signal ? { signal: guard.signal } : {}),
          isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
        })
      },
      sendMedia(action, guard) {
        const client = socket, check = guard?.isCurrent
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
        return sendMedia(action, { ...(guard?.signal ? { signal: guard.signal } : {}),
          isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
        })
      },
      sendFile(action, guard) {
        const client = socket, check = guard?.isCurrent
        if (!client || !verified || stopped || client.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'failed', code: 'onebot_disconnected' })
        return sendFile(action, { ...(guard?.signal ? { signal: guard.signal } : {}),
          isCurrent: () => !stopped && verified && socket === client && client.readyState === WebSocket.OPEN && check?.() !== false,
        })
      },
      send: (action, guard) => {
        if (!servesAccount(action.target) || (action.binding && action.binding.connectionId !== connection.id)) {
          return Promise.resolve({ state: 'failed', code: 'onebot_target_mismatch' })
        }
        return outbound.send(action, guard)
      },
      sendBundle: (action, guard) => {
        if (!servesAccount(action.target) || (action.binding && action.binding.connectionId !== connection.id)) {
          return Promise.resolve({ state: 'failed', code: 'onebot_target_mismatch' })
        }
        return outbound.sendBundle!(action, guard)
      },
    },
    isReady: () => verified && socket?.readyState === WebSocket.OPEN,
    start,
    stop,
  }
  return { adapter, start }
}

export function createOneBotConnection(options: OneBotConnectionOptions): OneBotAdapter {
  return createOneBotSession(options).adapter
}

/** Verify the configured QQ account with get_login_info, without installing an event consumer. */
export async function verifyOneBotLogin(options: OneBotEndpoint): Promise<void> {
  const { adapter, start } = createOneBotSession({ ...options,
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  try { await start() } finally { adapter.stop() }
}
