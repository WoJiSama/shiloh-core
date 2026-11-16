import type { ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../contracts/agentBinding.js'
import type { AgentMediaShare } from '../contracts/agentMediaRelayWorkflow.js'
import type { MediaShareReadOptions, PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import type { IncomingMessage } from '../contracts/platformMessage.js'
import { parseAgentBilibiliReference } from '../modules/media/infrastructure/agentBilibiliRelayReference.js'
import { parseAgentDouyinReference } from '../modules/media/infrastructure/agentDouyinRelayReference.js'
import { parseAgentYoutubeReference } from '../modules/media/infrastructure/agentYoutubeRelayReference.js'
import { parseAgentPixivReference } from '../modules/media/infrastructure/agentPixivRelayReference.js'
import { parseAgentXiaohongshuReference, readAgentXiaohongshuAccess } from '../modules/media/infrastructure/agentXiaohongshuRelayReference.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { qqId } from './qqIdentity.js'

const MAX_INPUT_CHARS = 128 * 1024
const MAX_STRING_CHARS = 64 * 1024
export const QQ_MEDIA_SHARE_READ_TIMEOUT_MS = 10_000
export const QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS = 1_500
type Segment = { type: string; data: Record<string, unknown>; original: Record<string, unknown>; text?: string }
type ExpectedSource = MediaShareReadOptions['expectedSource']
type SelectedShare = { readonly share: Readonly<AgentMediaShare>; readonly accessText?: string }

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
      typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).every(key => keys.includes(key as string))
}
/** Read descriptors rather than native getters, and detach all data before awaiting source policy. */
function snapshot(value: unknown): unknown {
  const seen = new Set<object>(); let nodes = 0, characters = 0
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error('媒体分享结构过大')
    if (typeof part === 'string') {
      characters += part.length
      if (part.length > MAX_STRING_CHARS || characters > MAX_INPUT_CHARS) throw new Error('媒体分享正文过大')
      return part
    }
    if (part === null || typeof part === 'boolean' || typeof part === 'number' && Number.isFinite(part)) return part
    if (!part || typeof part !== 'object' || seen.has(part)) throw new Error('媒体分享须为普通 JSON 数据')
    seen.add(part)
    if (Array.isArray(part)) {
      if (Object.getPrototypeOf(part) !== Array.prototype || part.length > 512 || Reflect.ownKeys(part).length !== part.length + 1) throw new Error('媒体分享数组无效')
      const result: unknown[] = []
      for (let i = 0; i < part.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(part, String(i))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('媒体分享数组无效')
        result.push(copy(descriptor.value, depth + 1))
      }
      return result
    }
    if (!plain(part)) throw new Error('媒体分享须为普通数据')
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(part) as string[]) {
      characters += key.length
      if (key.length > 512 || characters > MAX_INPUT_CHARS) throw new Error('媒体分享字段过大')
      result[key] = copy(Object.getOwnPropertyDescriptor(part, key)!.value, depth + 1)
    }
    return result
  }
  return copy(value, 0)
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const part of Object.values(value)) frozen(part); Object.freeze(value) }
  return value
}
function userValid(value: unknown): value is PlatformUserRef {
  return closed(value, ['platform', 'namespace', 'id']) && value.platform === 'qq' && value.namespace === 'global' &&
    typeof value.id === 'string' && qqId(value.id) === value.id
}
function targetValid(value: unknown): value is ConversationAddress {
  return closed(value, ['account', 'kind', 'id']) && userValid(value.account) && value.kind === 'group' &&
    typeof value.id === 'string' && qqId(value.id) === value.id
}
function expectedValid(value: unknown, account: PlatformAccountRef): value is ExpectedSource {
  return closed(value, ['author', 'occurredAt']) && userValid(value.author) && value.author.id !== account.id &&
    typeof value.occurredAt === 'number' && Number.isSafeInteger(value.occurredAt) && value.occurredAt > 0
}
function sameUser(left: PlatformUserRef, right: PlatformUserRef): boolean {
  return left.platform === right.platform && left.namespace === right.namespace && left.id === right.id
}
function evidenceId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  return typeof value === 'string' && qqId(value) === value ? value : undefined
}
function messageIdValid(value: unknown): value is string {
  return typeof value === 'string' && /^-?[1-9]\d{0,9}$/u.test(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647
}
function evidenceMessageId(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  return messageIdValid(String(value)) ? String(value) : undefined
}
function cqText(value: string, parameter = false): string {
  return value.replace(/&#91;/gu, '[').replace(/&#93;/gu, ']').replace(parameter ? /&#44;/gu : /$^/gu, ',').replace(/&amp;/gu, '&')
}
function entities(value: string): string {
  return value.replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&apos;/giu, "'").replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&#(\d+);|&#x([0-9a-f]+);/giu, (original, decimal: string | undefined, hex: string | undefined) => {
      const code = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16)
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original
    }).replace(/\\\//gu, '/')
}
function segments(value: unknown): Segment[] | undefined {
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined
    return value.map(item => {
      if (typeof item === 'string') return { type: 'text', data: { text: item }, original: {} }
      if (!plain(item) || typeof item.type !== 'string' || item.type.length > 64) throw new Error('媒体分享消息段无效')
      return { type: item.type, data: plain(item.data) ? item.data : {}, original: item,
        ...(typeof item.text === 'string' ? { text: item.text } : {}) }
    })
  }
  if (typeof value !== 'string' || value.length > MAX_STRING_CHARS) return undefined
  const result: Segment[] = []; let offset = 0
  for (const match of value.matchAll(/\[CQ:([A-Za-z0-9_-]+)((?:,[A-Za-z0-9_-]+=[^[\],]*)*)\]/gu)) {
    if (match.index > offset) result.push({ type: 'text', data: { text: cqText(value.slice(offset, match.index)) }, original: {} })
    const data: Record<string, string> = Object.create(null)
    for (const entry of (match[2] ?? '').slice(1).split(',').filter(Boolean)) {
      const index = entry.indexOf('='), key = entry.slice(0, index)
      if (Object.hasOwn(data, key)) throw new Error('媒体分享 CQ 字段重复')
      data[key] = cqText(entry.slice(index + 1), true)
    }
    result.push({ type: match[1]!, data, original: { type: match[1]!, data } }); offset = match.index + match[0].length
    if (result.length > 128) return undefined
  }
  if (offset < value.length) result.push({ type: 'text', data: { text: cqText(value.slice(offset)) }, original: {} })
  return result.length <= 128 ? result : undefined
}
function jsonPayload(value: unknown): unknown {
  for (let depth = 0; typeof value === 'string' && depth < 8; depth++) {
    if (!value || value.length > MAX_STRING_CHARS) return undefined
    try { value = snapshot(JSON.parse(entities(value))) } catch { return undefined }
  }
  return value && typeof value === 'object' ? value : undefined
}
function reference(value: unknown, provider?: AgentMediaShare['provider']): SelectedShare | undefined {
  if (typeof value !== 'string') return undefined
  const text = entities(value)
  const share = provider === 'bilibili' ? parseAgentBilibiliReference(text) : provider === 'douyin' ? parseAgentDouyinReference(text)
    : provider === 'youtube' ? parseAgentYoutubeReference(text)
    : provider === 'pixiv' ? parseAgentPixivReference(text)
    : provider === 'xiaohongshu' ? parseAgentXiaohongshuReference(text)
      : parseAgentBilibiliReference(text) ?? parseAgentDouyinReference(text) ?? parseAgentYoutubeReference(text) ?? parseAgentPixivReference(text) ?? parseAgentXiaohongshuReference(text)
  return share ? { share, ...(share.provider === 'xiaohongshu' ? { accessText: text } : {}) } : undefined
}
function jsonShare(input: unknown): SelectedShare | undefined {
  const payload = jsonPayload(input)
  if (!payload) return undefined
  const objects: Record<string, unknown>[] = []
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 16) return
    if (plain(value)) objects.push(value)
    for (const item of Object.values(value)) collect(item, depth + 1)
  }
  collect(payload, 0)
  const detail = objects.find(item => item.qqdocurl || item.preview || item.desc || item.title)
  const preferred = reference(detail?.qqdocurl)
  if (preferred && ['bilibili', 'douyin'].includes(preferred.share.provider)) return preferred
  const find = (value: unknown, depth: number, provider: AgentMediaShare['provider']): SelectedShare | undefined => {
    if (depth > 16) return undefined
    const direct = reference(value, provider)
    if (direct) return direct
    if (typeof value === 'string' && /^\s*(?:\{|\[|")/u.test(value)) return find(jsonPayload(value), depth + 1, provider)
    if (value && typeof value === 'object') for (const item of Object.values(value)) { const found = find(item, depth + 1, provider); if (found) return found }
    return undefined
  }
  const news = plain(payload) && plain(payload.meta) && plain(payload.meta.news) ? payload.meta.news : undefined
  return find(payload, 0, 'bilibili') ?? find(payload, 0, 'douyin') ??
    (preferred?.share.provider === 'youtube' ? preferred : find(payload, 0, 'youtube')) ??
    (preferred?.share.provider === 'pixiv' ? preferred : find(payload, 0, 'pixiv')) ?? preferred ??
    reference(news?.jumpUrl, 'xiaohongshu') ?? find(payload, 0, 'xiaohongshu')
}
function rawJsonShare(raw: string, provider?: AgentMediaShare['provider']): SelectedShare | undefined {
  for (const item of segments(raw) ?? []) if (item.type === 'json') {
    const found = jsonShare(item.data.data)
    if (found && (provider === undefined || found.share.provider === provider)) return found
  }
  return undefined
}
function selectedShare(message: Segment[], raw: string): SelectedShare | undefined {
  let douyin: SelectedShare | undefined, youtube: SelectedShare | undefined, pixiv: SelectedShare | undefined, xiaohongshu: SelectedShare | undefined
  for (const item of message) {
    if (item.type === 'text') {
      const value = item.text ?? item.data.text, found = reference(value, 'bilibili')
      if (found) return found
      douyin ??= reference(value, 'douyin')
      youtube ??= reference(value, 'youtube')
      pixiv ??= reference(value, 'pixiv')
      xiaohongshu ??= reference(value, 'xiaohongshu')
    }
    if (item.type === 'json') {
      const original = item.original.data
      const payload = plain(original) && Object.hasOwn(original, 'data') ? original.data : original
      const parsed = jsonPayload(payload ?? item.data.data)
      const found = parsed ? jsonShare(parsed) : rawJsonShare(raw)
      if (found?.share.provider === 'bilibili') return found
      if (found?.share.provider === 'douyin') douyin ??= found
      if (found?.share.provider === 'youtube') youtube ??= found
      if (found?.share.provider === 'pixiv') pixiv ??= found
      if (found?.share.provider === 'xiaohongshu') xiaohongshu ??= found
    }
    if (item.type === 'bilibili') {
      for (const source of [item.original, item.data]) for (const key of ['short_url', 'page_url', 'video_url', 'qqdocurl', 'url', 'jumpUrl']) {
        const found = reference(source[key], 'bilibili'); if (found) return found
      }
      return undefined
    }
    // Native media retains its original position; malformed native cards cannot
    // select a different, later share or supply raw IDs and downloaded resources.
    if (item.type === 'douyin') {
      for (const source of [item.original, item.data]) for (const key of ['short_url', 'page_url', 'video_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
        const found = reference(source[key], 'douyin'); if (found) return found
      }
      return undefined
    }
    // YouTube is a fallback after Douyin. Native card IDs and metadata cannot
    // substitute for an official URL or stop a later valid provider candidate.
    if (item.type === 'youtube') {
      for (const source of [item.original, item.data]) for (const key of ['short_url', 'page_url', 'video_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
        youtube ??= reference(source[key], 'youtube')
      }
    }
    if (item.type === 'pixiv') {
      for (const source of [item.original, item.data]) for (const key of ['short_url', 'page_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
        pixiv ??= reference(source[key], 'pixiv')
      }
    }
    // Unlike the original native Douyin branch, Xiaohongshu was a final fallback
    // in the old pipeline. Native URLs cannot pre-empt later Bilibili or Douyin.
    if (item.type === 'xiaohongshu') {
      for (const source of [item.original, item.data]) for (const key of ['short_url', 'page_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
        xiaohongshu ??= reference(source[key], 'xiaohongshu')
      }
    }
  }
  return rawJsonShare(raw, 'bilibili') ?? reference(raw, 'bilibili') ?? douyin ?? rawJsonShare(raw, 'douyin') ?? reference(raw, 'douyin') ??
    youtube ?? rawJsonShare(raw, 'youtube') ?? reference(raw, 'youtube') ??
    pixiv ?? rawJsonShare(raw, 'pixiv') ?? reference(raw, 'pixiv') ??
    xiaohongshu ?? rawJsonShare(raw, 'xiaohongshu') ?? reference(raw, 'xiaohongshu')
}

/** Native cards stay here; only a closed reference from Core's syntax parser crosses the boundary. */
export function extractQqMediaShare(input: unknown, rawMessage = ''): Readonly<AgentMediaShare> | undefined {
  try {
    const data = snapshot({ input, rawMessage }) as { input: unknown; rawMessage: string }
    if (typeof data.rawMessage !== 'string') return undefined
    const message = segments(data.input)
    return message ? selectedShare(message, data.rawMessage)?.share : undefined
  } catch { return undefined }
}

function decodedSource(input: unknown, target: ConversationAddress, messageId: string, expected: ExpectedSource):
  { message: IncomingMessage; native: Segment[]; raw: string } | undefined {
  const result = snapshot(input)
  if (!plain(result) || result.status !== 'ok' || result.retcode !== 0 || !plain(result.data)) return undefined
  const data = result.data, sender = plain(data.sender) ? data.sender : {}, author = evidenceId(sender.user_id)
  if (!author || author === target.account.id || author !== expected.author.id || evidenceId(data.user_id) !== author ||
      Object.hasOwn(result, 'self_id') && evidenceId(result.self_id) !== target.account.id ||
      Object.hasOwn(data, 'self_id') && evidenceId(data.self_id) !== target.account.id ||
      evidenceMessageId(data.message_id) !== messageId ||
      data.message_type !== 'group' || evidenceId(data.group_id) !== target.id ||
      data.post_type !== undefined && data.post_type !== 'message' || data.message_sent_type === 'self' ||
      typeof data.time !== 'number' || data.time <= 0 || !Number.isSafeInteger(data.time * 1000) || data.time * 1000 !== expected.occurredAt) return undefined
  const raw = typeof data.raw_message === 'string' ? data.raw_message : ''
  const native = segments(data.message ?? raw)
  if (!native) return undefined
  const safe = native.map(item => item.type === 'text' ? { type: 'text', data: { text: item.text ?? item.data.text } } :
    item.type === 'at' ? { type: 'at', data: { qq: item.data.qq ?? item.data.user_id } } : { type: item.type, data: {} })
  const decoded = decodeQqIncomingMessage({ self_id: target.account.id, message_type: 'group', group_id: target.id,
    user_id: author, sender, message_id: messageId, message: safe, time: data.time })
  if (!decoded || decoded.text.length > 4000 || decoded.senderName && decoded.senderName.length > 256) return undefined
  const { quote: _quote, ...source } = decoded
  return { message: frozen({ ...source, conversation: target, sender: { ...expected.author } }), native, raw }
}
async function guarded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('媒体分享读取已取消'))
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export function createQqMediaShareReader(options: {
  readonly account: PlatformAccountRef
  readApi(action: 'get_msg', params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<PlatformConnectionAdapter['readMediaShare']> {
  return async (input, messageId, guard) => {
    let cancel: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined
    try {
      if (!plain(guard) || !(guard.signal instanceof AbortSignal) || typeof guard.allowsSource !== 'function' ||
          guard.isCurrent !== undefined && typeof guard.isCurrent !== 'function' || !targetValid(input) || !userValid(options.account) ||
          !sameUser(input.account, options.account) || !messageIdValid(messageId) || !expectedValid(guard.expectedSource, input.account)) return undefined
      // The native getter rejects forged/Proxy signals before any work is dispatched.
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(guard.signal)
      const suppliedSignal = guard.signal, current = guard.isCurrent, authorize = guard.allowsSource, expectedInput = guard.expectedSource
      const target = frozen({ ...input, account: { ...input.account } }), expected = frozen({ ...expectedInput, author: { ...expectedInput.author } })
      cancel = new AbortController()
      const signal = AbortSignal.any([cancel.signal, suppliedSignal, AbortSignal.timeout(QQ_MEDIA_SHARE_READ_TIMEOUT_MS)])
      const isCurrent = () => {
        try {
          return !signal.aborted && current?.call(guard) !== false && targetValid(input) && input.kind === target.kind && input.id === target.id &&
            sameUser(input.account, target.account) && userValid(options.account) && sameUser(options.account, target.account) &&
            expectedValid(expectedInput, target.account) && sameUser(expectedInput.author, expected.author) && expectedInput.occurredAt === expected.occurredAt &&
            guard.expectedSource === expectedInput && guard.signal === suppliedSignal && guard.allowsSource === authorize && guard.isCurrent === current
        } catch { return false }
      }
      if (!isCurrent()) return undefined
      timer = setInterval(() => { if (!isCurrent()) cancel!.abort() }, 25)
      const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS)])
      const response = await guarded(Promise.resolve().then(() => {
        if (!isCurrent() || lookupSignal.aborted) throw new Error('媒体分享读取已取消')
        return options.readApi('get_msg', Object.freeze({ message_id: Number(messageId) }), { isCurrent: () => isCurrent() && !lookupSignal.aborted, signal: lookupSignal })
      }), lookupSignal)
      if (!isCurrent()) return undefined
      const source = decodedSource(response, target, messageId, expected)
      if (!source) return undefined
      const allows = () => guarded(Promise.resolve().then(() => isCurrent() ? authorize.call(guard, source.message) : false), signal)
      if (!await allows() || !isCurrent()) return undefined
      const selected = selectedShare(source.native, source.raw)
      if (!selected || !await allows() || !isCurrent()) return undefined
      const access = selected.share.provider === 'xiaohongshu' && selected.accessText !== undefined
        ? readAgentXiaohongshuAccess(selected.accessText, selected.share) : undefined
      if (!isCurrent()) return undefined
      return Object.freeze({ message: source.message, share: selected.share, ...(access ? { access } : {}) })
    } catch { return undefined }
    finally { if (timer) clearInterval(timer); cancel?.abort() }
  }
}
