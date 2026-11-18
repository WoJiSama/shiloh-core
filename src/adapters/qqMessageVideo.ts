import { createHash } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../contracts/agentBinding.js'
import type { AgentMessageVideo, MessageVideoReadOptions } from '../contracts/agentVideo.js'
import type { IncomingMessage } from '../contracts/platformMessage.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import { MAX_AGENT_VIDEO_INPUT_BYTES, validateAgentVideoInputBytes } from '../modules/media/domain/agentVideoInput.js'
import { extractForwardIdFromSegment } from '../modules/conversation/domain/messageSegments.js'
import { isPublicAddress } from '../modules/shared/infrastructure/publicAddress.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { parseQqCqMessage } from './qqCqMessage.js'
import { qqId } from './qqIdentity.js'

export const QQ_VIDEO_READ_TIMEOUT_MS = 60_000
export const QQ_VIDEO_API_TIMEOUT_MS = 1_500
type Row = Record<string, unknown>
type VideoApi = 'get_msg' | 'get_forward_msg' | 'get_video_info'
interface VideoResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array>
  close(): void | Promise<void>
}
export type QqVideoRequest = (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<VideoResponse>
interface Resource { readonly url?: string; readonly fileId?: string; readonly identity: unknown }
interface NodeEvidence { readonly author: PlatformUserRef; readonly occurredAt: number }
interface Selected {
  readonly fingerprint: string
  readonly origin: AgentMessageVideo['origin']
  readonly resource: Resource
  readonly sources: readonly IncomingMessage[]
  readonly nodes: readonly NodeEvidence[]
}
const failure = () => new Error('QQ 视频来源或资源不可用')
const plain = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
const row = (value: unknown): Row => plain(value) ? value : Object.create(null) as Row
function closed(value: unknown, keys: readonly string[]): value is Row { return plain(value) && Object.keys(value).every(key => keys.includes(key)) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } return value }
/** Detach protocol JSON before the first asynchronous policy callback, without invoking accessors. */
function snapshot(input: unknown): unknown {
  const seen = new Set<object>(); let count = 0, chars = 0
  const copy = (value: unknown, depth: number): unknown => {
    if (++count > 8192 || depth > 24) throw failure()
    if (typeof value === 'string') { chars += value.length; if (value.length > 128_000 || chars > 512_000) throw failure(); return value }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || seen.has(value)) throw failure()
    seen.add(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 512 || Reflect.ownKeys(value).length !== value.length + 1) throw failure()
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
        return copy(descriptor.value, depth + 1)
      })
    }
    if (!plain(value)) throw failure()
    const result: Row = Object.create(null)
    for (const key of Object.keys(value).sort()) { chars += key.length; if (key.length > 512 || chars > 512_000) throw failure(); result[key] = copy(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1) }
    return result
  }
  return copy(input, 0)
}
function user(value: unknown): value is PlatformUserRef { return closed(value, ['platform', 'namespace', 'id']) && value.platform === 'qq' && value.namespace === 'global' && typeof value.id === 'string' && qqId(value.id) === value.id }
function targetValid(value: unknown): value is ConversationAddress { return closed(value, ['account', 'kind', 'id']) && user(value.account) && value.kind === 'group' && typeof value.id === 'string' && qqId(value.id) === value.id }
function sameUser(left: PlatformUserRef, right: PlatformUserRef): boolean { return left.platform === right.platform && left.namespace === right.namespace && left.id === right.id }
function evidenceId(value: unknown): string | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && qqId(value) === value ? value : undefined }
function messageId(value: unknown): string | undefined { const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value; return typeof text === 'string' && /^-?[1-9]\d{0,9}$/u.test(text) && Number(text) >= -2_147_483_648 && Number(text) <= 2_147_483_647 ? text : undefined }
function forwardId(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f\\/:]/u.test(value) ? value : undefined }
function segments(input: unknown): Row[] {
  const values = typeof input === 'string' ? parseQqCqMessage(input) : input
  if (!Array.isArray(values) || values.length > 128) throw failure()
  return values.map(value => { if (typeof value === 'string') return { type: 'text', data: { text: value } }; if (!plain(value) || typeof value.type !== 'string') throw failure(); return value })
}
function responseData(input: unknown, account: PlatformAccountRef): Row {
  const response = row(snapshot(input)), data = row(response.data)
  if (response.status !== 'ok' || response.retcode !== 0 || !plain(response.data) ||
      response.self_id !== undefined && evidenceId(response.self_id) !== account.id || data.self_id !== undefined && evidenceId(data.self_id) !== account.id) throw failure()
  return data
}
function decodeSource(input: unknown, target: ConversationAddress, id: string): { readonly message: IncomingMessage; readonly native: Row[] } {
  const data = responseData(input, target.account), sender = row(data.sender), author = evidenceId(sender.user_id ?? data.user_id)
  if (data.message_type !== 'group' || evidenceId(data.group_id) !== target.id || messageId(data.message_id) !== id ||
      !author || author === target.account.id || sender.user_id !== undefined && evidenceId(sender.user_id) !== author ||
      data.user_id !== undefined && evidenceId(data.user_id) !== author || data.post_type !== undefined && data.post_type !== 'message' ||
      data.message_sent_type === 'self' || typeof data.time !== 'number' || data.time <= 0 || !Number.isSafeInteger(data.time * 1000)) throw failure()
  const native = segments(data.message ?? data.raw_message)
  const safe = native.map(part => {
    const fields = row(part.data)
    if (part.type === 'text') return { type: 'text', data: { text: part.text ?? fields.text } }
    if (part.type === 'at') return { type: 'at', data: { qq: part.qq ?? fields.qq } }
    return { type: part.type, data: {} }
  })
  const decoded = decodeQqIncomingMessage({ self_id: target.account.id, group_id: target.id, message_type: 'group', message_id: id,
    user_id: author, sender, time: data.time, message: safe })
  if (!decoded || decoded.text.length > 4000 || (decoded.senderName?.length ?? 0) > 256) throw failure()
  const { quote: _quote, ...message } = decoded
  const replies = native.filter(part => part.type === 'reply'), reply = replies[0], quoteId = replies.length === 1 ? messageId(reply!.id ?? row(reply!.data).id) : undefined
  return { message: freeze({ ...message, ...(quoteId ? { quote: { messageId: quoteId, parts: [] } } : {}), conversation: target }), native }
}
/** Native URLs may use dynamic QQ CDN domains; authority comes exclusively from reloaded protocol evidence. */
function videoUrl(input: unknown): URL | undefined {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) return undefined
  try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && !url.hash ? url : undefined } catch { return undefined }
}
function opaqueVideoId(input: unknown): string | undefined { return typeof input === 'string' && /^(?:[A-Za-z0-9_=-]{8,512}|[a-fA-F0-9]{32}\.(?:mp4|webm|video))$/u.test(input) ? input : undefined }
function videoResource(part: Row): Resource {
  const data = row(part.data), urls = [part.url, data.url, part.file_url, data.file_url].filter(value => value !== undefined && value !== ''),
    explicit = [part.file_id, data.file_id].filter(value => value !== undefined && value !== ''), files = [part.file, data.file].filter(value => value !== undefined && value !== '')
  if (urls.length && urls.some(value => typeof value !== 'string') || explicit.length && explicit.some(value => typeof value !== 'string') || files.length && files.some(value => typeof value !== 'string')) throw failure()
  const urlsSet = new Set(urls), ids = new Set(explicit.length ? explicit : files.filter(value => opaqueVideoId(value)))
  if (urlsSet.size > 1 || ids.size > 1) throw failure()
  const url = videoUrl(urls[0] ?? files.find(value => videoUrl(value))), fileId = opaqueVideoId([...ids][0])
  if (!url && !fileId) throw failure()
  return { ...(url ? { url: url.href } : {}), ...(fileId ? { fileId } : {}), identity: { urls, explicit, files } }
}
async function nativeVideoRequest(url: URL, address: LookupAddress, signal: AbortSignal): Promise<VideoResponse> {
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', agent: false, family: address.family, signal,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'video/mp4, video/webm, application/octet-stream', 'Accept-Encoding': 'identity', Referer: 'https://www.qq.com/' },
    }, resolve)
    request.once('error', reject); request.end()
  })
  return { status: response.statusCode ?? 0, headers: response.headers as Record<string, string | undefined>, body: response, close: () => { response.destroy() } }
}

export function createQqMessageVideoReader(options: {
  readonly account: PlatformAccountRef
  readApi(action: VideoApi, params: Readonly<Record<string, unknown>>, guard: { readonly signal: AbortSignal; readonly isCurrent: () => boolean }): Promise<unknown>
  readonly lookup?: (host: string) => Promise<LookupAddress[]>
  readonly request?: QqVideoRequest
  readonly timeoutMs?: number
}): NonNullable<PlatformConnectionAdapter['readMessageVideo']> {
  return async (input, requestedId, supplied) => {
    let cancel: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined
    try {
      if (!targetValid(input) || !user(options.account) || !sameUser(input.account, options.account) || messageId(requestedId) !== requestedId ||
          !closed(supplied, ['signal', 'isCurrent', 'ensureCurrent', 'inspectOnly', 'allowsSource', 'allowsForwardSource']) || !(supplied.signal instanceof AbortSignal) ||
          typeof supplied.isCurrent !== 'function' || typeof supplied.allowsSource !== 'function' || typeof supplied.allowsForwardSource !== 'function' ||
          supplied.ensureCurrent !== undefined && typeof supplied.ensureCurrent !== 'function' || supplied.inspectOnly !== undefined && typeof supplied.inspectOnly !== 'boolean') return undefined
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(supplied.signal)
      const target = freeze({ ...input, account: { ...input.account } }), originalSignal = supplied.signal, current = supplied.isCurrent,
        ensureCurrent = supplied.ensureCurrent, allowsSource = supplied.allowsSource, allowsForwardSource = supplied.allowsForwardSource, inspectOnly = supplied.inspectOnly
      cancel = new AbortController()
      const timeout = options.timeoutMs === undefined ? QQ_VIDEO_READ_TIMEOUT_MS : options.timeoutMs
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > QQ_VIDEO_READ_TIMEOUT_MS) return undefined
      const signal = AbortSignal.any([cancel.signal, originalSignal, AbortSignal.timeout(timeout)])
      const isCurrent = () => {
        try { return !signal.aborted && current.call(supplied) && targetValid(input) && input.id === target.id && sameUser(input.account, target.account) &&
          user(options.account) && sameUser(options.account, target.account) && supplied.signal === originalSignal && supplied.isCurrent === current &&
          supplied.ensureCurrent === ensureCurrent && supplied.allowsSource === allowsSource && supplied.allowsForwardSource === allowsForwardSource && supplied.inspectOnly === inspectOnly } catch { return false }
      }
      const active = async <T>(operation: () => Promise<T>, deadline: AbortSignal = signal, late?: (value: T) => unknown): Promise<T> => {
        if (!isCurrent() || deadline.aborted) throw failure()
        let abort: (() => void) | undefined, done = false
        try { return await new Promise<T>((resolve, reject) => {
          abort = () => { done = true; reject(failure()) }; deadline.addEventListener('abort', abort, { once: true })
          Promise.resolve().then(() => { if (!isCurrent() || deadline.aborted) throw failure(); return operation() }).then(value => {
            if (done || !isCurrent() || deadline.aborted) { try { void Promise.resolve(late?.(value)).catch(() => {}) } catch {}; reject(failure()) } else { done = true; resolve(value) }
          }, reject)
        }) } finally { if (abort) deadline.removeEventListener('abort', abort) }
      }
      const ensure = async () => { if (ensureCurrent) await active(() => ensureCurrent.call(supplied)); if (!isCurrent()) throw failure() }
      const authorize = async (source: IncomingMessage) => { await ensure(); if (await active(() => allowsSource.call(supplied, source)) !== true) throw failure(); await ensure() }
      const authorizeNode = async (source: NodeEvidence) => { await ensure(); if (await active(() => allowsForwardSource.call(supplied, source)) !== true) throw failure(); await ensure() }
      const invoke = async (action: VideoApi, params: Record<string, unknown>) => {
        await ensure(); const deadline = AbortSignal.any([signal, AbortSignal.timeout(QQ_VIDEO_API_TIMEOUT_MS)])
        const result = await active(() => options.readApi(action, Object.freeze(params), { signal: deadline, isCurrent: () => !deadline.aborted && isCurrent() }), deadline)
        await ensure(); return result
      }
      if (!isCurrent()) return undefined
      timer = setInterval(() => { if (!isCurrent()) cancel!.abort() }, 25)
      const select = async (): Promise<Selected | undefined> => {
        const original = decodeSource(await invoke('get_msg', { message_id: Number(requestedId) }), target, requestedId)
        await authorize(original.message)
        const sources = [original.message], sourceKeys: unknown[] = [], nodes: NodeEvidence[] = []
        const sourceKey = (source: typeof original) => ({ messageId: source.message.messageId, author: source.message.sender, occurredAt: source.message.occurredAt, native: source.native })
        sourceKeys.push(sourceKey(original))
        const selected = (resource: Resource, origin: AgentMessageVideo['origin'], path: unknown[]): Selected => ({
          fingerprint: createHash('sha256').update(JSON.stringify({ target, sources: sourceKeys, path, resource: resource.identity })).digest('hex'), origin, resource, sources: [...sources], nodes: [...nodes],
        })
        const direct = (source: typeof original, origin: 'current' | 'reply') => {
          const index = source.native.findIndex(part => part.type === 'video')
          return index < 0 ? undefined : selected(videoResource(source.native[index]!), origin, [{ origin, index }])
        }
        const own = direct(original, 'current'); if (own) return own
        let reply: typeof original | undefined
        const replies = original.native.filter(part => part.type === 'reply')
        if (replies.length > 1) throw failure()
        if (replies.length) {
          const fields = row(replies[0]!.data), id = messageId(replies[0]!.id ?? fields.id)
          if (!id || id === requestedId) throw failure()
          reply = decodeSource(await invoke('get_msg', { message_id: Number(id) }), target, id)
          if (reply.message.occurredAt > original.message.occurredAt) throw failure()
          await authorize(original.message); await authorize(reply.message)
          sources.push(reply.message); sourceKeys.push(sourceKey(reply))
          const quoted = direct(reply, 'reply'); if (quoted) return quoted
        }
        let requests = 0, count = 0
        const visited = new Set<string>()
        const nodeEvidence = (native: Row, ceiling: number): { content: Row[]; evidence: NodeEvidence } => {
          const data = native.type === 'node' ? row(native.data) : native, sender = row(data.sender)
          const values = [sender.user_id, data.user_id, data.uin].filter(value => value !== undefined), author = evidenceId(values[0])
          const rawTime = data.time, seconds = typeof rawTime === 'string' && /^[1-9]\d{0,12}$/u.test(rawTime) ? Number(rawTime) : rawTime
          if (!author || values.some(value => evidenceId(value) !== author) || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000) || seconds * 1000 > ceiling ||
              data.self_id !== undefined && evidenceId(data.self_id) !== target.account.id) throw failure()
          return { content: segments(data.message ?? data.content), evidence: freeze({ author: { ...target.account, id: author }, occurredAt: seconds * 1000 }) }
        }
        const load = async (id: string): Promise<unknown[]> => {
          if (requests >= 6 || visited.has(id)) throw failure()
          visited.add(id); requests++
          const data = responseData(await invoke('get_forward_msg', { id, message_id: id }), target.account)
          if (data.id !== undefined && data.id !== id || data.resid !== undefined && data.resid !== id) throw failure()
          const children = data.messages ?? data.message
          if (!Array.isArray(children)) throw failure()
          return children
        }
        const unpack = async (values: unknown[], depth: number, ceiling: number, path: unknown[]): Promise<Selected | undefined> => {
          if (depth > 2) throw failure()
          for (let index = 0; index < values.length; index++) {
            if (++count > 50) throw failure()
            const { content, evidence } = nodeEvidence(row(values[index]), ceiling)
            await authorizeNode(evidence); nodes.push(evidence)
            const nodePath = [...path, { index, evidence, content }]
            for (let partIndex = 0; partIndex < content.length; partIndex++) {
              const part = content[partIndex]!, fields = row(part.data)
              if (part.type === 'video') return selected(videoResource(part), 'forward', [...nodePath, { partIndex }])
              const rawId = extractForwardIdFromSegment(part), id = forwardId(rawId)
              if (part.type === 'forward' || rawId) {
                if (rawId && !id) throw failure()
                const nested = id ? await load(id) : Array.isArray(fields.content) ? fields.content : undefined
                if (!nested) throw failure()
                const result = await unpack(nested, depth + 1, evidence.occurredAt, [...nodePath, { partIndex, ...(id ? { forwardId: id } : {}) }])
                if (result) return result
              } else if (part.type === 'node') {
                const result = await unpack([part], depth + 1, evidence.occurredAt, [...nodePath, { partIndex }]); if (result) return result
              }
            }
            nodes.pop()
          }
          return undefined
        }
        for (const [sourceIndex, source] of [original, ...(reply ? [reply] : [])].entries()) for (let index = 0; index < source.native.length; index++) {
          const part = source.native[index]!, rawId = extractForwardIdFromSegment(part), id = forwardId(rawId)
          if (part.type !== 'forward' && !rawId) continue
          // Inline nodes alone do not prove a forward root; its ID must come from this get_msg.
          if (!id) throw failure()
          const result = await unpack(await load(id), 0, source.message.occurredAt, [{ sourceIndex, index, forwardId: id }]); if (result) return result
        }
        return undefined
      }
      const selected = await select()
      if (!selected) return undefined
      const authorizeSelected = async () => { for (const source of selected.sources) await authorize(source); for (const node of selected.nodes) await authorizeNode(node) }
      await authorizeSelected()
      if (inspectOnly) { await ensure(); return Object.freeze({ fingerprint: selected.fingerprint, origin: selected.origin }) }
      let url = selected.resource.url ? videoUrl(selected.resource.url) : undefined
      if (!url && selected.resource.fileId) {
        const data = responseData(await invoke('get_video_info', { file: selected.resource.fileId }), target.account)
        if (data.file_id !== undefined && data.file_id !== selected.resource.fileId) return undefined
        url = videoUrl(data.url ?? data.file_url)
      }
      if (!url) return undefined
      const before = await select()
      if (!before || before.fingerprint !== selected.fingerprint || before.origin !== selected.origin) return undefined
      let bytes: Buffer | undefined, expectedMime: 'video/mp4' | 'video/webm' | undefined
      for (let hop = 0; hop <= 3; hop++) {
        await authorizeSelected()
        const host = url.hostname.replace(/^\[|\]$/gu, ''), literal = isIP(host)
        const addresses = literal ? [{ address: host, family: literal }] : await active(() => (options.lookup ?? (hostname => lookup(hostname, { all: true })))(host))
        if (!addresses.length || addresses.length > 64 || addresses.some(address => isIP(address.address) !== address.family || !isPublicAddress(address.address))) return undefined
        await authorizeSelected()
        const address = addresses.find(address => address.family === 4) ?? addresses[0]!
        const response = await active(() => (options.request ?? nativeVideoRequest)(url!, address, signal), signal, response => response.close())
        try {
          await ensure()
          const encoding = response.headers['content-encoding']
          if (encoding !== undefined && (typeof encoding !== 'string' || encoding.toLowerCase() !== 'identity')) return undefined
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.location
            if (hop === 3 || typeof location !== 'string' || /[\s\\]/u.test(location)) return undefined
            const next = videoUrl(new URL(location, url).href)
            if (!next || url.protocol === 'https:' && next.protocol !== 'https:') return undefined
            url = next; continue
          }
          const length = response.headers['content-length'], type = response.headers['content-type']
          if (response.status !== 200 || length !== undefined && (typeof length !== 'string' || !/^[1-9]\d*$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_AGENT_VIDEO_INPUT_BYTES) ||
              type !== undefined && typeof type !== 'string') return undefined
          const mime = type?.split(';', 1)[0]?.trim().toLowerCase()
          if (mime && !['video/mp4', 'video/webm', 'application/octet-stream', 'binary/octet-stream'].includes(mime)) return undefined
          expectedMime = mime === 'video/mp4' || mime === 'video/webm' ? mime : undefined
          const chunks: Buffer[] = []; let size = 0
          const iterator = response.body[Symbol.asyncIterator]()
          try { while (true) {
            const next = await active(() => Promise.resolve(iterator.next())); if (next.done) break
            if (!(next.value instanceof Uint8Array)) return undefined
            size += next.value.byteLength; if (size > MAX_AGENT_VIDEO_INPUT_BYTES) return undefined
            chunks.push(Buffer.from(next.value)); await ensure()
          } } finally { try { void Promise.resolve(iterator.return?.()).catch(() => {}) } catch {} }
          if (!size || length !== undefined && Number(length) !== size) return undefined
          bytes = Buffer.concat(chunks, size); break
        } finally { try { void Promise.resolve(response.close()).catch(() => {}) } catch {} }
      }
      if (!bytes) return undefined
      const video = validateAgentVideoInputBytes(bytes, expectedMime), after = await select()
      if (!after || after.fingerprint !== selected.fingerprint || after.origin !== selected.origin) return undefined
      await authorizeSelected(); await ensure()
      return Object.freeze({ fingerprint: selected.fingerprint, origin: selected.origin, video })
    } catch { return undefined }
    finally { if (timer) clearInterval(timer); cancel?.abort() }
  }
}
