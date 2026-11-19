import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { types } from 'node:util'
import { decodeHTMLStrict } from 'entities'
import type { AgentLifeThreadContext, AgentLifeThreadProvider } from '../../../contracts/agentLifeThread.js'
export type { AgentLifeThreadContext, AgentLifeThreadProvider } from '../../../contracts/agentLifeThread.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { bilibiliGuard, nativeAgentBilibiliRequest, reportBilibiliCleanupFailure } from '../../media/infrastructure/agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest, AgentBilibiliResponse } from '../../media/infrastructure/agentBilibiliRelayHttp.js'

export interface AgentLifeThreadProviderOptions {
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly lookup?: AgentBilibiliLookup
  readonly request?: AgentBilibiliRequest
  /** May shorten the complete operation's thirty-second deadline. */
  readonly timeoutMs?: number
}
const FAILURE = '追番资料暂时不可用：参数、来源、权限、网络或内容未通过验证'
const MAX_BYTES = 1024 * 1024, MAX_ROWS = 1000
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const failure = () => new Error(FAILURE)
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw failure()
  return value as Record<string, unknown>
}
function sourceId(value: unknown): string {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof normalized !== 'string' || !/^[1-9]\d{0,15}$/u.test(normalized)) throw failure()
  return normalized
}
function bindingIdentity(context: AgentLifeThreadContext): string {
  const binding = context.binding
  if (!binding || !['configured', 'legacy'].includes(binding.source) || !isConversationAddress(binding.target) ||
      ![binding.id, binding.revision, binding.agentId, binding.personaId, binding.connectionId].every(isPlatformIdentifier)) throw failure()
  return JSON.stringify([agentBindingToken(binding), conversationAddressKey(binding.target)])
}
function display(input: unknown, maximum: number, allows: (text: string) => boolean, required = true): string {
  if (typeof input !== 'string' || input.length > 16_384 || controls.test(input)) throw failure()
  let value = input
  for (let pass = 0; pass < 4; pass++) {
    const stripped = value.replace(/<[^>]*>/gu, '')
    for (const match of stripped.matchAll(/&#(x[\da-f]+|\d+);/giu)) {
      const entity = match[1]!, hex = entity[0]?.toLowerCase() === 'x', code = Number.parseInt(entity.slice(hex ? 1 : 0), hex ? 16 : 10)
      if (!Number.isInteger(code) || code < 0x20 && ![9, 10, 13].includes(code) || code >= 0x7f && code <= 0x9f ||
          code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw failure()
    }
    const decoded = decodeHTMLStrict(stripped)
    if (controls.test(decoded)) throw failure()
    if (decoded === value) break
    value = decoded
  }
  value = value.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim()
  if (/https?:\/\/|base64:\/\/|data:|file:\/\//iu.test(value) || !allows(value)) throw failure()
  const result = Array.from(value).slice(0, maximum).join('')
  if (required && !result) throw failure()
  return result
}
function queryTitle(input: unknown, allows: (text: string) => boolean): string {
  if (typeof input !== 'string' || input.length > 40 || !input.trim() || /[\u0000-\u001f\u007f]/u.test(input) ||
      controls.test(input) || /https?:\/\/|file:\/\/|base64:\/\//iu.test(input) || !allows(input)) throw failure()
  return input.trim()
}

/** Bilibili's public search/season/reply operations, bound to a caller-owned character and source fence. */
export function createAgentLifeThreadProvider(options: AgentLifeThreadProviderOptions = {}): AgentLifeThreadProvider {
  if (!options || typeof options !== 'object' || types.isProxy(options) ||
      options.lookup !== undefined && typeof options.lookup !== 'function' || options.request !== undefined && typeof options.request !== 'function' ||
      options.allowsText !== undefined && typeof options.allowsText !== 'function' ||
      options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) ||
      options.secrets !== undefined && (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(secret => typeof secret !== 'string' || secret.length > 32768))) throw failure()
  const hostSecrets = [...options.secrets ?? []], hostCheck = createAgentSecretTextCheck(hostSecrets)
  const hostAllows = (text: string) => { try { return hostCheck(text) && options.allowsText?.(text) !== false } catch { return false } }
  const cleanup = async (response: AgentBilibiliResponse | undefined, guard?: ReturnType<typeof bilibiliGuard>) => {
    const closing = Promise.resolve().then(() => response?.close?.()).catch(() => reportBilibiliCleanupFailure('response_close_failed'))
    // Even an injected asynchronous release cannot hold a cancelled operation open.
    if (guard) { try { await guard.wait(closing) } catch { /* The release remains observed after authority or deadline expiry. */ } }
  }
  async function run<T>(context: AgentLifeThreadContext, operation: (session: ReturnType<typeof createSession>) => Promise<T>): Promise<T> {
    let guard: ReturnType<typeof bilibiliGuard> | undefined
    try {
      if (!context || !(context.signal instanceof AbortSignal) || typeof context.isCurrent !== 'function' || typeof context.ensureCurrent !== 'function') throw failure()
      const identity = bindingIdentity(context), currentMethod = context.isCurrent, ensureMethod = context.ensureCurrent, signal = context.signal
      const current = () => {
        try { return !signal.aborted && context.signal === signal && context.isCurrent === currentMethod && context.ensureCurrent === ensureMethod &&
          bindingIdentity(context) === identity && currentMethod.call(context) === true } catch { return false }
      }
      guard = bilibiliGuard({ signal, isCurrent: current, async ensureCurrent() {
        if (!current()) throw failure()
        await ensureMethod.call(context)
        if (!current()) throw failure()
      } }, options.timeoutMs ?? 30_000)
      await guard.ensure()
      const result = await operation(createSession(guard))
      await guard.ensure()
      return result
    } finally { guard?.close() }
  }
  function createSession(guard: ReturnType<typeof bilibiliGuard>) {
    let secretCheck = hostCheck
    const allows = (text: string) => { try { return secretCheck(text) && options.allowsText?.(text) !== false } catch { return false } }
    const text = (input: unknown, maximum: number, required = true) => display(input, maximum, allows, required)
    async function json(url: URL, cookie = '', fingerprint = false): Promise<Record<string, unknown>> {
      let response: AgentBilibiliResponse | undefined
      try {
        if (url.protocol !== 'https:' || url.hostname !== 'api.bilibili.com' || url.port || url.username || url.password || url.hash || !hostCheck(url.href)) throw failure()
        await guard.ensure()
        const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
        if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address =>
          !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw failure()
        await guard.ensure()
        const received = await guard.wait(Promise.resolve().then(() => {
          guard.check()
          return (options.request ?? nativeAgentBilibiliRequest)(url, addresses[0]!, guard.signal, { maxBytes: MAX_BYTES,
            headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) } })
        }), late => cleanup(late))
        response = received
        await guard.ensure()
        const type = (received.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), length = received.headers['content-length']
        if (received.status !== 200 || type !== 'application/json' && !/^application\/[a-z\d.+-]+\+json$/u.test(type) ||
            received.headers['content-encoding'] && received.headers['content-encoding']!.toLowerCase() !== 'identity' ||
            length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) throw failure()
        const body = received.body, iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array
          ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw failure()
        const chunks: Uint8Array[] = [], iterator = iterable[Symbol.asyncIterator](); let size = 0
        try {
          while (true) {
            await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next())); await guard.ensure()
            if (next.done) break
            if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > MAX_BYTES) throw failure()
            chunks.push(Buffer.from(next.value))
          }
        } finally {
          try { void Promise.resolve(iterator.return?.()).catch(() => reportBilibiliCleanupFailure('iterator_return_failed')) }
          catch { reportBilibiliCleanupFailure('iterator_return_failed') }
        }
        if (!size || length !== undefined && Number(length) !== size) throw failure()
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), check = fingerprint ? hostCheck : secretCheck
        if (!check(raw)) throw failure()
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure()
        const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }]; let visited = 0
        while (pending.length) {
          const next = pending.pop()!
          if (++visited > 40_000 || next.depth > 20) throw failure()
          if (typeof next.value === 'string') { if (next.value.length > 32768 || !check(next.value)) throw failure() }
          else if (Array.isArray(next.value)) for (const value of next.value) pending.push({ value, depth: next.depth + 1 })
          else if (next.value && typeof next.value === 'object') for (const [key, value] of Object.entries(next.value)) {
            if (key.length > 256 || !check(key)) throw failure()
            pending.push({ value, depth: next.depth + 1 })
          }
        }
        await guard.ensure()
        return parsed as Record<string, unknown>
      } finally { await cleanup(response, guard) }
    }
    async function fingerprint(): Promise<string> {
      try {
        const payload = await json(new URL(SPI), '', true), data = row(payload.data), token = /^[A-Za-z0-9_+=:\/-]{1,256}$/u
        if (payload.code !== 0 || typeof data.b_3 !== 'string' || !token.test(data.b_3)) throw failure()
        const tokens = [data.b_3, ...(typeof data.b_4 === 'string' && token.test(data.b_4) ? [data.b_4] : [])]
        secretCheck = createAgentSecretTextCheck([...hostSecrets, ...tokens])
        await guard.ensure()
        return `buvid3=${tokens[0]}${tokens[1] ? `; buvid4=${tokens[1]}` : ''}`
      } catch { await guard.ensure(); return '' }
    }
    return { guard, allows, text, json, fingerprint }
  }
  return {
    async resolve(input, context) {
      try {
        const value = closed(input, ['title']), title = queryTitle(value.title, hostAllows)
        return await run(context, async session => {
          const cookie = await session.fingerprint(), url = new URL('https://api.bilibili.com/x/web-interface/search/type')
          url.searchParams.set('keyword', title); url.searchParams.set('search_type', 'media_bangumi')
          const payload = await session.json(url, cookie), entries = row(payload.data).result
          if (payload.code !== 0 || !Array.isArray(entries) || entries.length > MAX_ROWS) throw failure()
          const results = entries.flatMap(input => {
            const entry = row(input)
            try { return [{ sourceId: sourceId(entry.season_id), title: session.text(entry.title, 40) }] } catch { return [] }
          })
          if (!results.length) return { ok: false as const, error: '没有找到符合要求的番剧资料' }
          const selected = results.find(entry => !/中配|配音/u.test(entry.title)) ?? results[0]!
          await session.guard.ensure()
          return { ok: true as const, ...selected }
        })
      } catch { return { ok: false, error: FAILURE } }
    },
    async sync(input, context) {
      try {
        const value = closed(input, ['sourceId', 'title', 'lastEpisode'])
        if (typeof value.sourceId !== 'string') throw failure()
        const id = sourceId(value.sourceId)
        queryTitle(value.title, hostAllows)
        if (value.lastEpisode !== undefined && (!Number.isSafeInteger(value.lastEpisode) || Number(value.lastEpisode) < 1 || Number(value.lastEpisode) > 1_000_000)) throw failure()
        const previous = Number(value.lastEpisode ?? 0)
        return await run(context, async session => {
          const cookie = await session.fingerprint(), url = new URL('https://api.bilibili.com/pgc/view/web/season')
          url.searchParams.set('season_id', id)
          const payload = await session.json(url, cookie), result = row(payload.result), episodes = result.episodes
          if (payload.code !== 0 || sourceId(result.season_id) !== id || !Array.isArray(episodes) || episodes.length > MAX_ROWS) throw failure()
          if (!episodes.length) return { newNotes: [] }
          const latest = row(episodes[episodes.length - 1]), label = latest.title
          if (typeof label !== 'string' && typeof label !== 'number') throw failure()
          const match = /^(\d{1,6})(?:\b|[^\d])/u.exec(String(label)), episode = match ? Number(match[1]) : 0
          if (episode < 1 || episode > 1_000_000) return { newNotes: [] }
          const newNotes: string[] = []
          if (episode > previous) {
            let date = '近期'
            if (latest.pub_time !== undefined && latest.pub_time !== 0) {
              if (!Number.isSafeInteger(latest.pub_time) || Number(latest.pub_time) < 0) throw failure()
              const at = new Date(Number(latest.pub_time) * 1000 + 8 * 3600_000)
              if (!Number.isFinite(at.getTime())) throw failure()
              date = at.toISOString().slice(0, 10)
            }
            const longTitle = session.text(latest.long_title ?? '', 60, false)
            const official = `〔官方〕第${episode}集「${longTitle}」（${date} 更新）`
            if (!session.allows(official)) throw failure()
            newNotes.push(official)
            if (latest.aid !== undefined && latest.aid !== 0) {
              try {
                const aid = sourceId(latest.aid), repliesUrl = new URL('https://api.bilibili.com/x/v2/reply')
                repliesUrl.searchParams.set('type', '1'); repliesUrl.searchParams.set('oid', aid); repliesUrl.searchParams.set('sort', '1'); repliesUrl.searchParams.set('ps', '5')
                const repliesPayload = await session.json(repliesUrl, cookie), replies = row(repliesPayload.data).replies
                if (repliesPayload.code !== 0 || !Array.isArray(replies) || replies.length > MAX_ROWS) throw failure()
                for (const reply of replies.slice(0, 3)) {
                  const entry = row(reply), likes = entry.like
                  if (typeof likes !== 'number' || !Number.isSafeInteger(likes) || likes < 10 || likes > 1_000_000_000) continue
                  try {
                    const note = `〔观众·${likes}赞〕${session.text(row(entry.content).message, 60)}`
                    if (session.allows(note)) newNotes.push(note)
                  } catch { /* Untrusted audience text never becomes an official observation. */ }
                }
              } catch { await session.guard.ensure() /* Comments are optional, as in the legacy provider. */ }
            }
          }
          await session.guard.ensure()
          return { newNotes, episode }
        })
      } catch { return { error: FAILURE } }
    },
  }
}
