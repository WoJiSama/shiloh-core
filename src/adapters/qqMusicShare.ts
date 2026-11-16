import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentMusicShare } from '../contracts/agentMusicExtraction.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import type { IncomingMessage } from '../contracts/platformMessage.js'
import { parseNeteaseMusicLink, validateAgentMusicShare } from '../modules/media/infrastructure/agentMusicExtractionProvider.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { qqId } from './qqIdentity.js'

type NativeRead = 'get_msg' | 'get_friend_list'
type Segment = { type: string; data: Record<string, unknown>; text?: string }
const MAX_INPUT_CHARS = 128 * 1024
const MAX_JSON_CHARS = 64 * 1024
export const QQ_MUSIC_SHARE_READ_TIMEOUT_MS = 10_000

function plainData(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function targetValid(target: ConversationAddress): boolean {
  return plainData(target) && Object.keys(target).every(key => ['account', 'kind', 'id'].includes(key)) && plainData(target.account) &&
    Object.keys(target.account).every(key => ['platform', 'namespace', 'id'].includes(key)) && target.account.platform === 'qq' &&
    target.account.namespace === 'global' && typeof target.account.id === 'string' && qqId(target.account.id) === target.account.id &&
    typeof target.id === 'string' && qqId(target.id) === target.id &&
    (target.kind === 'group' || target.kind === 'private' && target.id !== target.account.id)
}
function evidenceId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  return typeof value === 'string' && qqId(value) === value ? value : undefined
}
function messageIdValid(value: unknown): value is string {
  return typeof value === 'string' && /^-?[1-9]\d{0,9}$/u.test(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647
}
function boundedData(value: unknown): void {
  const pending = [{ value, depth: 0 }], seen = new Set<object>()
  let nodes = 0, characters = 0
  while (pending.length) {
    const item = pending.pop()!, part = item.value
    if (++nodes > 4096 || item.depth > 16) throw new Error('音乐分享结构过大')
    if (typeof part === 'string') { characters += part.length; if (part.length > MAX_JSON_CHARS || characters > MAX_INPUT_CHARS) throw new Error('音乐分享正文过大'); continue }
    if (part === null || typeof part === 'boolean' || typeof part === 'number' && Number.isFinite(part)) continue
    if (!part || typeof part !== 'object' || seen.has(part)) throw new Error('音乐分享须为普通 JSON 数据')
    seen.add(part)
    if (Array.isArray(part)) {
      if (Object.getPrototypeOf(part) !== Array.prototype || part.length > 512 || Reflect.ownKeys(part).some(key =>
        key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(part, key)!, 'value')))) throw new Error('音乐分享数组无效')
      for (const value of part) pending.push({ value, depth: item.depth + 1 })
    } else {
      if (!plainData(part)) throw new Error('音乐分享须为普通数据')
      for (const [key, value] of Object.entries(part)) {
        characters += key.length
        if (key.length > 512 || characters > MAX_INPUT_CHARS) throw new Error('音乐分享字段过大')
        pending.push({ value, depth: item.depth + 1 })
      }
    }
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const part of Object.values(value)) frozen(part); Object.freeze(value) }
  return value
}
function cqText(value: string, parameter = false): string {
  return value.replace(/&#91;/gu, '[').replace(/&#93;/gu, ']').replace(parameter ? /&#44;/gu : /$^/gu, ',').replace(/&amp;/gu, '&')
}
function segments(value: unknown): Segment[] | undefined {
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined
    return value.flatMap(item => {
      if (typeof item === 'string') return [{ type: 'text', data: { text: item } }]
      if (!plainData(item) || typeof item.type !== 'string' || item.type.length > 64) throw new Error('音乐分享消息段无效')
      if (item.type === 'json') return [{ type: 'json', data: { data: plainData(item.data) && Object.hasOwn(item.data, 'data') ? item.data.data : item.data } }]
      return [{ type: item.type, data: plainData(item.data) ? item.data : {}, ...(typeof item.text === 'string' ? { text: item.text } : {}) }]
    })
  }
  if (typeof value !== 'string' || value.length > MAX_JSON_CHARS) return undefined
  const result: Segment[] = []; let offset = 0
  for (const match of value.matchAll(/\[CQ:([A-Za-z0-9_-]+)((?:,[A-Za-z0-9_-]+=[^[\],]*)*)\]/gu)) {
    if (match.index > offset) result.push({ type: 'text', data: { text: cqText(value.slice(offset, match.index)) } })
    const data: Record<string, string> = Object.create(null)
    for (const entry of (match[2] ?? '').slice(1).split(',').filter(Boolean)) {
      const index = entry.indexOf('='), key = entry.slice(0, index)
      if (Object.hasOwn(data, key)) throw new Error('音乐分享 CQ 字段重复')
      data[key] = cqText(entry.slice(index + 1), true)
    }
    result.push({ type: match[1]!, data }); offset = match.index + match[0].length
    if (result.length > 128) return undefined
  }
  if (offset < value.length) result.push({ type: 'text', data: { text: cqText(value.slice(offset)) } })
  return result.length <= 128 ? result : undefined
}
function parsedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value || value.length > MAX_JSON_CHARS) throw new Error('音乐分享 JSON 过大')
    value = JSON.parse(value)
  }
  boundedData(value)
  return value
}
function link(value: unknown): AgentMusicShare['reference'] | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /\s|[\\\u0000-\u001f\u007f]/u.test(value) ||
      !/^https?:\/\/(?:y\.)?music\.163\.com\/(?:song|dj)\?/iu.test(value)) return undefined
  return parseNeteaseMusicLink(value.replace(/&amp;/gu, '&'))?.reference
}

/** Native content is consumed locally; only the closed neutral reference leaves this adapter. */
export function extractQqMusicShare(input: unknown): Readonly<AgentMusicShare> | undefined {
  try {
    boundedData(input)
    const message = segments(input)
    if (!message) return undefined
    const candidates: Readonly<AgentMusicShare>[] = []
    const add = (value: unknown) => candidates.push(validateAgentMusicShare(value))
    for (const item of message) {
      if (item.type === 'music' && item.data.type === '163') {
        const id = typeof item.data.id === 'number' && Number.isSafeInteger(item.data.id) ? String(item.data.id) : item.data.id
        add({ provider: 'netease', reference: { kind: 'song', id } }); continue
      }
      if (item.type === 'text') {
        const text = item.text ?? item.data.text
        if (typeof text !== 'string') continue
        for (const url of text.match(/https?:\/\/[^\s<>"'，。！？；）)\]}>]+/giu) ?? []) {
          const reference = link(url)
          if (reference) add({ provider: 'netease', reference })
        }
      }
      if (item.type !== 'json') continue
      const pending = [parsedJson(item.data.data)]
      while (pending.length) {
        const value = pending.pop()
        if (Array.isArray(value)) { pending.push(...value); continue }
        if (!plainData(value)) continue
        const mediaUrl = value.musicUrl, page = value.jumpUrl ?? value.url
        const reference = mediaUrl !== undefined ? link(mediaUrl) ?? { kind: 'audio', url: typeof mediaUrl === 'string' ? mediaUrl.replace(/&amp;/gu, '&') : mediaUrl } : link(page)
        if (reference) add({ provider: 'netease', reference,
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.desc !== undefined || value.artist !== undefined ? { artist: value.artist ?? value.desc } : {}),
        })
        pending.push(...Object.values(value))
      }
    }
    const unique = new Map(candidates.map(candidate => [JSON.stringify(candidate.reference), candidate]))
    return unique.size === 1 ? unique.values().next().value : undefined
  } catch { return undefined }
}

function decodedSource(response: unknown, target: ConversationAddress, messageId: string): { message: IncomingMessage; segments: Segment[] } | undefined {
  boundedData(response)
  if (!plainData(response) || response.status !== 'ok' || response.retcode !== 0 || !plainData(response.data)) return undefined
  // Snapshot before any async policy callback so native content cannot be replaced during authorization.
  const result = JSON.parse(JSON.stringify(response)) as Record<string, unknown>, data = result.data as Record<string, unknown>
  const sender = plainData(data.sender) ? data.sender : {}, author = evidenceId(sender.user_id)
  if (!author || evidenceId(data.user_id) !== author ||
      Object.hasOwn(result, 'self_id') && evidenceId(result.self_id) !== target.account.id ||
      Object.hasOwn(data, 'self_id') && evidenceId(data.self_id) !== target.account.id ||
      String(data.message_id) !== messageId || !messageIdValid(String(data.message_id)) ||
      typeof data.time !== 'number' || data.time <= 0 || !Number.isSafeInteger(data.time * 1000)) return undefined
  if (target.kind === 'group') {
    if (data.message_type !== 'group' || evidenceId(data.group_id) !== target.id) return undefined
  } else {
    if (data.message_type !== 'private' || data.sub_type !== undefined && data.sub_type !== 'friend' || data.group_id != null || data.temp_source != null) return undefined
    if (author === target.id) {
      if (data.post_type !== undefined && data.post_type !== 'message' || data.message_sent_type === 'self' ||
          data.target_id !== undefined && evidenceId(data.target_id) !== target.account.id) return undefined
    } else if (author !== target.account.id || evidenceId(data.target_id) !== target.id ||
        data.post_type !== 'message_sent' && data.message_sent_type !== 'self') return undefined
  }
  const native = segments(data.message)
  if (!native) return undefined
  const safe = native.map(item => item.type === 'text' ? { type: 'text', data: { text: item.text ?? item.data.text } } :
    item.type === 'at' ? { type: 'at', data: { qq: item.data.qq ?? item.data.user_id } } : { type: item.type, data: {} })
  const decoded = decodeQqIncomingMessage({ self_id: target.account.id, message_type: target.kind,
    ...(target.kind === 'group' ? { group_id: target.id } : {}), user_id: target.kind === 'private' ? target.id : author,
    sender, message_id: messageId, message: safe, time: data.time,
  })
  if (!decoded || decoded.text.length > 4000 || decoded.senderName && decoded.senderName.length > 256) return undefined
  const { quote: _quote, ...source } = decoded
  return { message: frozen({ ...source, conversation: target, sender: { ...target.account, id: author } }), segments: native }
}
function friendProof(response: unknown, target: ConversationAddress): boolean {
  if (!plainData(response) || response.status !== 'ok' || response.retcode !== 0 || !Array.isArray(response.data) || response.data.length > 10000 ||
      Object.getPrototypeOf(response.data) !== Array.prototype || Reflect.ownKeys(response.data).some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(response.data, key)!, 'value'))) ||
      response.complete === false || response.truncated === true || response.has_more === true ||
      Object.hasOwn(response, 'self_id') && evidenceId(response.self_id) !== target.account.id) return false
  const peers = new Set<string>()
  for (const value of response.data) {
    if (!plainData(value)) return false
    const id = evidenceId(value.user_id)
    if (!id || peers.has(id)) return false
    peers.add(id)
  }
  return peers.has(target.id)
}
async function guarded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('音乐分享读取已取消'))
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export function createQqMusicShareReader(options: {
  readonly account: PlatformAccountRef
  readApi(action: NativeRead, params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<PlatformConnectionAdapter['readMusicShare']> {
  const accountKey = platformAccountKey(options.account)
  return async (input, messageId, guard) => {
    if (!(guard?.signal instanceof AbortSignal) || typeof guard.allowsSource !== 'function' || !targetValid(input) ||
        platformAccountKey(input.account) !== accountKey || !messageIdValid(messageId)) return undefined
    const target = frozen({ ...input, account: { ...input.account } }), targetKey = conversationAddressKey(target)
    const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, guard.signal, AbortSignal.timeout(QQ_MUSIC_SHARE_READ_TIMEOUT_MS)])
    const isCurrent = () => {
      try { return !signal.aborted && guard.isCurrent?.() !== false && targetValid(input) &&
        conversationAddressKey(input) === targetKey && platformAccountKey(options.account) === accountKey } catch { return false }
    }
    if (!isCurrent()) return undefined
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    const invoke = async (action: NativeRead, params: Record<string, unknown>) => {
      if (!isCurrent()) throw new Error('音乐分享读取已取消')
      const response = await guarded(Promise.resolve().then(() => {
        if (!isCurrent()) throw new Error('音乐分享读取已取消')
        return options.readApi(action, Object.freeze(params), { isCurrent, signal })
      }), signal)
      if (!isCurrent()) throw new Error('音乐分享读取已取消')
      return response
    }
    try {
      const source = decodedSource(await invoke('get_msg', { message_id: Number(messageId) }), target, messageId)
      if (!source) return undefined
      // NapCat labels every C2C message "friend", including non-buddies. Never cache this authorization across calls.
      if (target.kind === 'private' && !friendProof(await invoke('get_friend_list', {}), target)) return undefined
      if (!await guarded(Promise.resolve().then(() => guard.allowsSource(source.message)), signal) || !isCurrent()) return undefined
      const share = extractQqMusicShare(source.segments)
      if (!share || !await guarded(Promise.resolve().then(() => guard.allowsSource(source.message)), signal) || !isCurrent()) return undefined
      return { message: source.message, share }
    } catch { return undefined }
    finally { clearInterval(timer); cancel.abort() }
  }
}
