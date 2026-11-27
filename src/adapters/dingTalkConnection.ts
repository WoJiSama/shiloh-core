import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import type { ConversationAddress, PlatformConnection } from '../contracts/agentBinding.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { PlatformConnectionAdapter, PlatformConversationEvent } from '../contracts/platformConnection.js'
import type { IncomingMessage, MessageActionOptions, SendMessageAction } from '../contracts/platformMessage.js'
import { platformAccountKey, isPlatformIdentifier, samePlatformNamespace } from '../modules/runtime/domain/agentBindings.js'

const origin = 'https://api.dingtalk.com'
const robotTopic = '/v1.0/im/bot/messages/get'
const failed = (code: string): DeliveryReceipt => ({ state: 'failed', code })
const unknown = (): DeliveryReceipt => ({ state: 'unknown' })

export interface DingTalkReplyPolicy {
  readonly mode: 'both' | 'private' | 'group'
  readonly requireMention: boolean
  readonly allowUserIds: readonly string[]
  readonly denyUserIds: readonly string[]
  readonly allowGroupIds: readonly string[]
  readonly denyGroupIds: readonly string[]
}

export const defaultDingTalkReplyPolicy: DingTalkReplyPolicy = {
  mode: 'both', requireMention: true, allowUserIds: [], denyUserIds: [], allowGroupIds: [], denyGroupIds: [],
}

export interface DingTalkConnectionOptions {
  readonly connection: PlatformConnection
  readonly name: string
  readonly clientId: string
  readonly clientSecret: string
  readonly replyPolicy?: DingTalkReplyPolicy
  /** A configured live reader can withhold a policy while its stored version is unconfirmed. */
  readonly getReplyPolicy?: () => DingTalkReplyPolicy | undefined
  readonly fetch?: typeof fetch
  readonly openSocket?: (endpoint: URL) => WebSocket
  readonly onState?: (state: 'connected' | 'disconnected') => void
  canUse(target: ConversationAddress): boolean
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const valid = (value: unknown): value is string => isPlatformIdentifier(value) && value !== '0'

function allowsId(id: string, allow: readonly string[], deny: readonly string[]): boolean {
  return !deny.includes(id) && (!allow.length || allow.includes(id))
}

export function normalizeDingTalkMessage(connection: PlatformConnection, input: unknown): IncomingMessage | undefined {
  const data = object(input), account = connection.account
  if (account.platform !== 'dingtalk' || data.chatbotCorpId !== account.namespace || data.robotCode !== account.id ||
      data.msgtype !== 'text' || data.senderCorpId !== account.namespace || !valid(data.senderStaffId) ||
      data.senderStaffId === account.id || !valid(data.msgId)) return
  const kind = data.conversationType === '2' ? 'group' : data.conversationType === '1' ? 'private' : undefined
  if (!kind) return
  const id = kind === 'group' ? data.conversationId : data.senderStaffId
  const text = object(data.text).content, at = data.createAt
  if (!valid(id) || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 ||
      typeof text !== 'string' || !text.trim() || text.length > 8000) return
  const sender = { platform: account.platform, namespace: account.namespace, id: data.senderStaffId }
  const content = text.trim()
  const mentioned = kind === 'group' && data.isInAtList === true
  return { version: 1, conversation: { account, kind, id }, sender, messageId: data.msgId, occurredAt: at, text: content,
    ...(typeof data.senderNick === 'string' && data.senderNick.length <= 120 ? { senderName: data.senderNick } : {}),
    parts: [{ kind: 'text', text: content }], mentions: mentioned ? [account] : [], directedToAccount: kind === 'private' || mentioned }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('钉钉响应为空')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 64 * 1024) throw new Error('钉钉响应超过大小限制')
      chunks.push(next.value)
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createDingTalkConnection(options: DingTalkConnectionOptions): PlatformConnectionAdapter {
  const { connection: { account }, clientId, clientSecret, replyPolicy = defaultDingTalkReplyPolicy } = options
  const getReplyPolicy = options.getReplyPolicy ?? (() => replyPolicy)
  const accountKey = platformAccountKey(account)
  const fetchImpl = options.fetch ?? fetch
  const lifetime = new AbortController()
  let accept: ((event: PlatformConversationEvent) => Promise<void>) | undefined
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0, callbacks = 0
  let token: { value: string; until: number } | undefined
  let tokenPending: Promise<string> | undefined
  const isReady = () => !lifetime.signal.aborted && socket?.readyState === WebSocket.OPEN

  function obs(state: 'connected' | 'disconnected') {
    try { options.onState?.(state) } catch { /* Connection observers do not affect admission. */ }
  }

  async function post(endpoint: string, data: unknown, signal: AbortSignal, accessToken?: string) {
    return fetchImpl(origin + endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        ...(accessToken ? { 'x-acs-dingtalk-access-token': accessToken } : {}) },
      body: JSON.stringify(data) })
  }

  async function accessToken() {
    if (token && token.until > Date.now()) return token.value
    if (!tokenPending) tokenPending = (async () => {
      const response = await post('/v1.0/oauth2/accessToken', { appKey: clientId, appSecret: clientSecret },
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]))
      if (!response.ok) { await response.body?.cancel(); throw new Error('钉钉应用鉴权失败') }
      const body = await responseJson(response)
      if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 4096 ||
          typeof body.expireIn !== 'number' || !Number.isFinite(body.expireIn) || body.expireIn <= 0) throw new Error('钉钉应用令牌无效')
      token = { value: body.accessToken, until: Date.now() + Math.max(1, Math.min(7200, body.expireIn) - 60) * 1000 }
      return token.value
    })().finally(() => { tokenPending = undefined })
    return tokenPending
  }

  function owns(target: ConversationAddress, policy = getReplyPolicy()) {
    return !!policy && platformAccountKey(target.account) === accountKey && valid(target.id) &&
      (target.kind === 'group' && policy.mode !== 'private' && allowsId(target.id, policy.allowGroupIds, policy.denyGroupIds) ||
       target.kind === 'private' && policy.mode !== 'group' && allowsId(target.id, policy.allowUserIds, policy.denyUserIds)) &&
      options.canUse(target)
  }

  function allowsReply(incoming: IncomingMessage, policy = getReplyPolicy()): boolean {
    const { conversation, sender } = incoming
    if (!policy || !samePlatformNamespace(sender, account) || !valid(sender.id) || sender.id === account.id || !owns(conversation, policy)) return false
    if (conversation.kind === 'private') return sender.id === conversation.id
    return allowsId(sender.id, policy.allowUserIds, policy.denyUserIds) && (!policy.requireMention ||
      incoming.directedToAccount && incoming.mentions.some(user => user?.id === account.id && samePlatformNamespace(user, account)))
  }

  async function send(action: SendMessageAction, guard?: MessageActionOptions): Promise<DeliveryReceipt> {
    const current = () => isReady() && !guard?.signal?.aborted && guard?.isCurrent?.() !== false && owns(action.target)
    if (!current() || action.version !== 1 || action.kind !== 'message.send' || !valid(action.replyTo) ||
        !action.parts.length || !action.parts.every(part => part.kind === 'text')) return failed('dingtalk_send_not_authorized')
    const content = action.parts.map(part => part.kind === 'text' ? part.text : '').join('')
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 15_000) return failed('dingtalk_message_invalid')
    let sent = false
    try {
      await guard?.ensureCurrent?.()
      if (!current()) return failed('dingtalk_send_not_authorized')
      const access = await accessToken()
      await guard?.ensureCurrent?.()
      if (!current()) return failed('dingtalk_send_not_authorized')
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000), ...(guard?.signal ? [guard.signal] : [])])
      const group = action.target.kind === 'group'
      sent = true
      const response = await post(group ? '/v1.0/robot/groupMessages/send' : '/v1.0/robot/oToMessages/batchSend', {
        robotCode: account.id, msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
        ...(group ? { openConversationId: action.target.id } : { userIds: [action.target.id] }),
      }, signal, access)
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 401 || response.status === 403) token = undefined
        return [400, 401, 403, 404, 422, 429].includes(response.status) ? failed('dingtalk_send_rejected') : unknown()
      }
      const body = await responseJson(response)
      if (Array.isArray(body.invalidStaffIdList) && body.invalidStaffIdList.length || typeof body.code === 'string' && body.code !== '0') {
        return failed('dingtalk_send_rejected')
      }
      if (valid(body.messageId)) return { state: 'sent', messageId: body.messageId }
      if (!valid(body.processQueryKey)) return unknown()
      // The one-target robot APIs return a stable batch receipt, not an IM message id.
      return { state: 'sent', messageId: 'dingtalk-send-' + createHash('sha256').update(body.processQueryKey).digest('hex') }
    } catch { return sent ? unknown() : failed('dingtalk_access_unavailable') }
  }

  function ack(client: WebSocket, messageId: string, code = 200, data = '{}') {
    if (client === socket && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ code, headers: { messageId, contentType: 'application/json' },
        message: code === 200 ? 'OK' : 'LATER', data }), () => {})
    }
  }

  async function onMessage(client: WebSocket, raw: string) {
    if (client !== socket || !isReady()) return
    let frame: Record<string, unknown>
    try { frame = object(JSON.parse(raw)) } catch { return }
    const headers = object(frame.headers), messageId = headers.messageId
    if (!valid(messageId)) return
    if (frame.type === 'SYSTEM') {
      if (headers.topic === 'ping') ack(client, messageId, 200, typeof frame.data === 'string' ? frame.data : '{}')
      if (headers.topic === 'disconnect') {
        ack(client, messageId)
        client.close()
      }
      return
    }
    if (frame.type !== 'CALLBACK' || headers.topic !== robotTopic || typeof frame.data !== 'string') return
    let input: unknown
    try { input = JSON.parse(frame.data) } catch { ack(client, messageId); return }
    const incoming = normalizeDingTalkMessage(options.connection, input)
    if (!incoming) { ack(client, messageId); return }
    const policy = getReplyPolicy()
    if (!policy) { ack(client, messageId, 500); return }
    if (!allowsReply(incoming, policy)) { ack(client, messageId); return }
    if (callbacks >= 24) { ack(client, messageId, 500); return }
    callbacks++
    try {
      // Core admission persists the ID and queue entry before it returns.
      await accept?.({ kind: 'message', message: incoming })
      ack(client, messageId)
    } catch { ack(client, messageId, 500) }
    finally { callbacks-- }
  }

  function reconnect() {
    if (lifetime.signal.aborted || retry) return
    const delay = Math.min(60_000, 1500 * 2 ** Math.min(failures++, 6))
    retry = setTimeout(() => { retry = undefined; void connect() }, delay)
    retry.unref()
  }

  async function connect() {
    if (lifetime.signal.aborted) return
    try {
      const response = await post('/v1.0/gateway/connections/open', {
        clientId, clientSecret, ua: 'shiloh-core', subscriptions: [{ type: 'CALLBACK', topic: robotTopic }],
      }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]))
      if (!response.ok) { await response.body?.cancel(); throw new Error('钉钉 Stream 未能连接') }
      const result = await responseJson(response)
      if (typeof result.endpoint !== 'string' || typeof result.ticket !== 'string' || !result.ticket || result.ticket.length > 4096) throw new Error('钉钉 Stream 响应无效')
      const url = new URL(result.endpoint)
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.dingtalk.com') ||
          url.username || url.password || url.hash || url.search) throw new Error('钉钉 Stream 地址无效')
      url.searchParams.set('ticket', result.ticket)
      if (lifetime.signal.aborted) return
      const client = socket = options.openSocket?.(url) ?? new WebSocket(url, { followRedirects: false, maxPayload: 256 * 1024, handshakeTimeout: 10_000 })
      let lastPong = 0
      let heartbeat: ReturnType<typeof setInterval> | undefined
      client.on('error', () => client.terminate())
      client.once('open', () => {
        failures = 0
        lastPong = Date.now()
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 60_000) client.terminate()
          else if (client.readyState === WebSocket.OPEN) client.ping()
        }, 25_000)
        heartbeat.unref()
        obs('connected')
      })
      client.on('pong', () => { lastPong = Date.now() })
      client.on('message', raw => {
        const text = Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw).toString('utf8')
        void onMessage(client, text).catch(() => {})
      })
      client.once('close', () => {
        if (heartbeat) clearInterval(heartbeat)
        if (socket === client) socket = undefined
        if (!lifetime.signal.aborted) { obs('disconnected'); reconnect() }
      })
    } catch { if (!lifetime.signal.aborted) { obs('disconnected'); reconnect() } }
  }

  return {
    ...options.connection, botName: options.name, botUserId: account.id, actions: { send }, allowsReply, isReady,
    async start(handler) {
      if (accept || lifetime.signal.aborted) return
      accept = handler
      void connect()
    },
    stop() {
      lifetime.abort()
      if (retry) clearTimeout(retry)
      retry = undefined
      socket?.terminate()
      token = undefined
    },
  }
}
