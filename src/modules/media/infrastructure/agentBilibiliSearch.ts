import { types } from 'node:util'
import { decodeHTMLStrict } from 'entities'
import type { AgentVideoCard, AgentVideoSearchProvider } from '../../../contracts/agentVideoCard.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { bilibiliGuard, bilibiliOfficialUrl, createBilibiliHttp, nativeAgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import { parseAgentBilibiliReference } from './agentBilibiliRelayReference.js'
import { validateAgentVideoCard } from './agentVideoCard.js'

export interface AgentBilibiliSearchProviderOptions {
  readonly lookup?: AgentBilibiliLookup
  readonly request?: AgentBilibiliRequest
  readonly allowsText?: (text: string) => boolean
  readonly secrets?: readonly string[]
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  /** May shorten the complete operation's 15s deadline. */
  readonly timeoutMs?: number
}
export type AgentBilibiliSearchProvider = AgentVideoSearchProvider

const failure = () => new Error('B站视频查询失败：来源、网络或内容不符合要求')
const META_BYTES = 2 * 1024 * 1024
const FINGERPRINT = 'https://api.bilibili.com/x/frontend/finger/spi'
const validBvid = (value: unknown): value is string => typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/u.test(value)
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const invalidDisplayCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u

function stripTags(value: string): string {
  let result = ''
  for (let at = 0; at < value.length; at++) {
    if (value[at] !== '<' || !/[A-Za-z!/?]/u.test(value[at + 1] ?? '')) { result += value[at]; continue }
    let quote = '', end = at + 1
    for (; end < value.length; end++) {
      const char = value[end]!
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end === value.length) throw failure()
    at = end
  }
  return result
}
function display(input: unknown, maximum: number, required = false): string {
  if (typeof input !== 'string' || input.length > 32_768 || invalidDisplayCharacters.test(input)) throw failure()
  let value = input
  for (let pass = 0; pass < 4; pass++) {
    const stripped = stripTags(value)
    // HTML decoders repair invalid numeric references and remap C1 codes.
    // Validate their original values before decoding so those cannot be hidden.
    for (const match of stripped.matchAll(/&#(x[\da-f]+|\d+);/giu)) {
      const entity = match[1]!, hex = entity[0]?.toLowerCase() === 'x', code = Number.parseInt(entity.slice(hex ? 1 : 0), hex ? 16 : 10)
      if (!Number.isInteger(code) || code < 0x20 && ![9, 10, 13].includes(code) || code >= 0x7f && code <= 0x9f ||
          code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw failure()
    }
    const next = decodeHTMLStrict(stripped)
    if (invalidDisplayCharacters.test(next)) throw failure()
    if (next === value) break
    value = next
  }
  value = stripTags(value).replace(/\s+/gu, ' ').trim()
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || /&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/iu.test(value)) throw failure()
  const result = Array.from(value).slice(0, maximum).join('')
  if (required && !result) throw failure()
  return result
}
function seconds(input: unknown): number {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) return input
  if (typeof input !== 'string' || !/^\d{1,8}:[0-5]\d(?::[0-5]\d)?$/u.test(input)) throw failure()
  const result = input.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  if (!Number.isSafeInteger(result)) throw failure()
  return result
}
function closedInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['query', 'url'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Number(Object.hasOwn(descriptors, 'query')) + Number(Object.hasOwn(descriptors, 'url')) !== 1) throw failure()
  return input as Record<string, unknown>
}

/** Metadata only. Official URLs and anonymous device cookies remain inside this provider. */
export function createAgentBilibiliSearchProvider(options: AgentBilibiliSearchProviderOptions = {}): AgentBilibiliSearchProvider {
  try {
    if (!options || typeof options !== 'object' || types.isProxy(options) ||
      options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 15_000) ||
      options.lookup !== undefined && typeof options.lookup !== 'function' || options.request !== undefined && typeof options.request !== 'function' ||
      options.allowsText !== undefined && typeof options.allowsText !== 'function' ||
      options.secrets !== undefined && (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(value => typeof value !== 'string' || value.length > 32768))) throw failure()
  } catch { throw failure() }
  const hostSecrets = [...options.secrets ?? []], hostCheck = createAgentSecretTextCheck(hostSecrets)
  const hostAllows = (text: string) => { try { return hostCheck(text) && options.allowsText?.(text) !== false } catch { return false } }
  const diagnoseFallback = () => {
    const event = { stage: 'runtime' as const, operation: 'bilibili_search_fingerprint', outcome: 'failed' as const, code: 'fingerprint_unavailable_fallback' }
    try { if (options.diagnostics) { options.diagnostics.emit(event); return } } catch { /* Use the fixed console event when an observer is unavailable. */ }
    try { console.warn('[Agent] runtime/bilibili_search_fingerprint failed fingerprint_unavailable_fallback') } catch { /* Diagnostics cannot change the result. */ }
  }
  const keyword = (input: unknown) => {
    if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/u.test(input)) throw failure()
    const value = input.trim()
    if (!value || Array.from(value).length > 200 || !hostAllows(value)) throw failure()
    return value
  }
  async function run<T>(context: AgentMediaResourceContext, operation: (current: ReturnType<typeof session>) => Promise<T>): Promise<T> {
    let guard: ReturnType<typeof bilibiliGuard> | undefined
    try { guard = bilibiliGuard(context, options.timeoutMs ?? 15_000); await guard.ensure(); const result = await operation(session(guard)); await guard.ensure(); return result }
    catch { throw failure() }
    finally { guard?.close() }
  }
  function session(guard: ReturnType<typeof bilibiliGuard>) {
    let secretCheck = hostCheck
    const allows = (text: string) => { try { return secretCheck(text) && options.allowsText?.(text) !== false } catch { return false } }
    const safe = (text: string) => { if (!allows(text)) throw failure(); return text }
    const inspect = (value: unknown, check: (text: string) => boolean) => {
      const pending = [{ value, depth: 0 }]; let count = 0
      while (pending.length) {
        const next = pending.pop()!
        if (++count > 40_000 || next.depth > 16) throw failure()
        if (typeof next.value === 'string') { if (next.value.length > 32_768 || !check(next.value)) throw failure() }
        else if (Array.isArray(next.value)) for (const item of next.value) pending.push({ value: item, depth: next.depth + 1 })
        else if (next.value && typeof next.value === 'object') for (const [key, item] of Object.entries(next.value)) { if (key.length > 256 || !check(key)) throw failure(); pending.push({ value: item, depth: next.depth + 1 }) }
      }
    }
    const read = createBilibiliHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), allows })
    async function json(input: string, cookie = '', fingerprint = false): Promise<Record<string, unknown>> {
      // Redirects cannot turn a fixed metadata operation into another allowed API.
      const expected = bilibiliOfficialUrl(input, 'metadata').href
      const exact = createBilibiliHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), allows,
        request: (url, address, signal, policy) => { if (url.href !== expected) throw failure(); return (options.request ?? nativeAgentBilibiliRequest)(url, address, signal, policy) } })
      let response: Awaited<ReturnType<typeof exact>> | undefined
      try {
        response = await exact(expected, 'metadata', guard, META_BYTES, cookie)
        if (response.url.href !== expected || response.mime !== 'application/json' && !response.mime.endsWith('+json')) throw failure()
        const chunks: Uint8Array[] = []; let size = 0
        for await (const bytes of response.chunks) { chunks.push(bytes); size += bytes.length }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), check = fingerprint ? hostAllows : allows
        if (!check(raw)) throw failure()
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure()
        inspect(parsed, check); await guard.ensure(); return parsed as Record<string, unknown>
      } finally { await response?.close() }
    }
    async function fingerprint(): Promise<string> {
      try {
        const payload = await json(FINGERPRINT, '', true), data = row(payload.data)
        // Same SPI token policy as the relay provider: b_4 may carry a base64 tail; a
        // rejected b_4 degrades to buvid3-only instead of dropping the whole fingerprint.
        const token = /^[A-Za-z0-9_+=:\/-]{1,256}$/u
        const b3 = typeof data.b_3 === 'string' && token.test(data.b_3) ? data.b_3 : ''
        const b4 = typeof data.b_4 === 'string' && token.test(data.b_4) ? data.b_4 : ''
        if (payload.code !== 0 || !b3) throw failure()
        const tokens = [b3, ...(b4 ? [b4] : [])]
        secretCheck = createAgentSecretTextCheck([...hostSecrets, ...tokens])
        await guard.ensure()
        return `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`
      } catch { await guard.ensure(); diagnoseFallback(); return '' }
    }
    const card = (id: string, title: unknown, author: unknown, durationSeconds: number, episode = false): AgentVideoCard => {
      return validateAgentVideoCard({ provider: 'bilibili', id: episode ? `ep${id}` : id, title: safe(display(title, 300, true)), author: safe(display(author ?? '', 120)), durationSeconds,
        pageUrl: safe(episode ? `https://www.bilibili.com/bangumi/play/ep${id}` : `https://www.bilibili.com/video/${id}`) }, allows)
    }
    async function search(value: string): Promise<{ readonly items: readonly AgentVideoCard[] }> {
      const cookie = await fingerprint(), url = new URL('https://api.bilibili.com/x/web-interface/search/type')
      url.searchParams.set('keyword', value); url.searchParams.set('search_type', 'video'); url.searchParams.set('order', 'totalrank'); url.searchParams.set('page', '1')
      const payload = await json(url.href, cookie), results = row(payload.data).result
      if (payload.code !== 0 || !Array.isArray(results) || results.length > 1000) throw failure()
      const items: AgentVideoCard[] = [], seen = new Set<string>()
      for (const input of results) {
        const value = row(input)
        if (!validBvid(value.bvid) || seen.has(value.bvid)) continue
        let item: AgentVideoCard
        try { item = card(value.bvid, value.title, value.author, seconds(value.duration)) } catch { continue }
        seen.add(item.id); items.push(item)
        if (items.length === 8) break
      }
      await guard.ensure(); return Object.freeze({ items: Object.freeze(items) })
    }
    async function resolveUrl(input: unknown): Promise<AgentVideoCard> {
      if (typeof input !== 'string' || !hostAllows(input)) throw failure()
      const url = bilibiliOfficialUrl(input, 'share')
      let share = parseAgentBilibiliReference(url.href)
      if (!share) throw failure()
      if (share.reference.kind === 'short') {
        let response: Awaited<ReturnType<typeof read>> | undefined
        try { response = await read(`https://b23.tv/${share.reference.id}`, 'share', guard, META_BYTES); share = parseAgentBilibiliReference(response.url.href) }
        finally { await response?.close() }
      }
      if (!share || share.reference.kind === 'short' || share.reference.kind === 'video' && !validBvid(share.reference.id)) throw failure()
      const episode = share.reference.kind === 'episode', id = share.reference.id, cookie = await fingerprint()
      const payload = await json(episode ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${id}` : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`, cookie)
      if (payload.code !== 0) throw failure()
      if (!episode) {
        const data = row(payload.data)
        if (data.bvid !== id) throw failure()
        return card(id, data.title, row(data.owner).name, seconds(data.duration))
      }
      const episodes = row(payload.result).episodes
      if (!Array.isArray(episodes) || episodes.length > 1000) throw failure()
      const matches = episodes.filter(value => { const identity = row(value).id; return typeof identity === 'string' && identity === id || typeof identity === 'number' && Number.isSafeInteger(identity) && String(identity) === id })
      if (matches.length !== 1) throw failure()
      const data = row(matches[0]), duration = data.duration
      if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0) throw failure()
      const season = row(payload.result)
      return card(id, data.long_title || data.share_copy || data.title, row(data.owner).name ?? row(season.up_info).uname, duration / 1000, true)
    }
    return { search, resolveUrl }
  }
  return Object.freeze({
    async search(input: string, context: AgentMediaResourceContext) { return run(context, current => current.search(keyword(input))) },
    async resolve(input: { readonly query?: string; readonly url?: string }, context: AgentMediaResourceContext) {
      return run(context, async current => {
        const owned = closedInput(input)
        if (Object.hasOwn(owned, 'url')) return current.resolveUrl(owned.url)
        const result = await current.search(keyword(owned.query)), first = result.items[0]
        if (!first) throw failure()
        return first
      })
    },
  })
}
