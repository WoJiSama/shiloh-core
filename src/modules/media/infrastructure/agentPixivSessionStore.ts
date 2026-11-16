import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import type { AgentPixivSearchResult } from './agentPixivSearchProvider.js'

export interface AgentPixivSessionSource { readonly messageId: string; readonly author: PlatformUserRef }
export type AgentPixivSessionData = Omit<AgentPixivSearchResult, 'keyword' | 'items'> & {
  readonly items: readonly Omit<AgentPixivSearchResult['items'][number], 'thumbUrl'>[]
}
export interface AgentPixivSearchTicket { readonly scope: string; readonly generation: string; readonly source: AgentPixivSessionSource }
export interface AgentPixivSession extends AgentPixivSearchTicket { readonly version: 1; readonly savedAt: number; readonly data: AgentPixivSessionData }
export interface AgentPixivAttempt { readonly key: string; readonly pending: string }
export type AgentPixivAttemptState = 'pending' | 'sent' | 'failed' | 'unknown'
export interface AgentPixivSessionStoreOptions { readonly now?: () => number; readonly allowsText?: (text: string) => boolean }
const TTL = 300_000, RETAIN = 604_800, prefix = 'agent:pixiv-tools:v1:'
const fail = () => new Error('Pixiv 会话或投递记录不可用')
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw fail()
  return input as Record<string, unknown>
}
const count = (input: unknown, max = Number.MAX_SAFE_INTEGER): number => { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > max) throw fail(); return input }
const artwork = (value: unknown): string => { if (typeof value !== 'string' || !/^[1-9]\d{0,11}$/u.test(value)) throw fail(); return value }
const checkTypes = `for _, key in ipairs(KEYS) do local t=redis.call('TYPE',key).ok if t~='none' and t~='string' then return redis.error_reply('invalid Pixiv key') end end\n`
const beginScript = checkTypes + `redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]);redis.call('DEL',KEYS[2]);return 1`
const saveScript = checkTypes + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]);return 1`
const discardScript = checkTypes + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('DEL',KEYS[2]);return 1`
const touchScript = checkTypes + `if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end redis.call('SET',KEYS[2],ARGV[3],'PX',ARGV[4]);return 1`
const claimScript = checkTypes + `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return '' end return redis.call('GET',KEYS[1])`
const finishScript = checkTypes + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`

/** Durable single-slot selection and send fences; storage failure never falls back to process memory. */
export function createAgentPixivSessionStore(storage: AgentInboxRedis, options: AgentPixivSessionStoreOptions = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.eval !== 'function') throw fail()
  const now = () => count((options.now ?? Date.now)())
  const safe = (input: unknown, max: number, empty = false): string => {
    if (typeof input !== 'string' || input.length > max || !empty && !input.trim() || /[\u0000-\u001f\u007f]/u.test(input) || options.allowsText?.(input) === false) throw fail()
    return input
  }
  const source = (input: unknown): AgentPixivSessionSource => {
    const value = object(input, ['messageId', 'author']), author = object(value.author, ['platform', 'namespace', 'id'])
    if (!isPlatformAccount(author as unknown as PlatformUserRef) || !isPlatformIdentifier(value.messageId)) throw fail()
    for (const value of Object.values(author)) safe(value, 128)
    safe(value.messageId, 128)
    return Object.freeze({ messageId: value.messageId, author: Object.freeze({ platform: author.platform as string, namespace: author.namespace as string, id: author.id as string }) })
  }
  const scope = (binding: AgentBindingSnapshot): string => {
    if (!binding || !isConversationAddress(binding.target) || !['configured', 'legacy'].includes(binding.source) ||
      !isPlatformIdentifier(binding.agentId) || !isPlatformIdentifier(binding.personaId) || !isPlatformIdentifier(binding.connectionId)) throw fail()
    safe(binding.id, 4096); safe(binding.revision, 4096)
    return digest(JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding)]))
  }
  const ticket = (input: AgentPixivSearchTicket): AgentPixivSearchTicket => {
    object(input, ['scope', 'generation', 'source', 'version', 'savedAt', 'data'])
    if (!/^[a-f\d]{64}$/u.test(input.scope) || !/^[a-f\d-]{36}$/u.test(input.generation)) throw fail()
    return Object.freeze({ scope: input.scope, generation: input.generation, source: source(input.source) })
  }
  const data = (input: unknown): AgentPixivSessionData => {
    const value = object(input, ['mode', 'order', 'orderSource', 'total', 'artist', 'items'])
    if (!['artworks', 'artist'].includes(value.mode as string) || !['newest', 'oldest', 'popular'].includes(value.order as string) ||
      !['native', 'ranking', 'rerank'].includes(value.orderSource as string) || !Array.isArray(value.items) || Object.getPrototypeOf(value.items) !== Array.prototype ||
      !value.items.length || value.items.length > 20 || Reflect.ownKeys(value.items).length !== value.items.length + 1) throw fail()
    const seen = new Set<string>()
    const items = Array.from({ length: value.items.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value.items, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail()
      const row = object(descriptor.value, ['id', 'title', 'userName', 'userId', 'pageCount', 'xRestrict', 'bookmarkCount'])
      const id = artwork(row.id); if (seen.has(id)) throw fail(); seen.add(id)
      const pageCount = count(row.pageCount, 2000); if (!pageCount) throw fail()
      return Object.freeze({ id, title: safe(row.title, 300), userName: safe(row.userName, 120, true), pageCount,
        ...(row.userId === undefined ? {} : { userId: artwork(row.userId) }), ...(row.xRestrict === undefined ? {} : { xRestrict: count(row.xRestrict, 2) }),
        ...(row.bookmarkCount === undefined ? {} : { bookmarkCount: count(row.bookmarkCount) }) })
    })
    let artist: AgentPixivSessionData['artist']
    if (value.artist !== undefined) { const row = object(value.artist, ['userId', 'userName']); artist = Object.freeze({ userId: artwork(row.userId), userName: safe(row.userName, 120) }) }
    return Object.freeze({ mode: value.mode as AgentPixivSessionData['mode'], order: value.order as AgentPixivSessionData['order'],
      orderSource: value.orderSource as AgentPixivSessionData['orderSource'], total: count(value.total), ...(artist ? { artist } : {}), items: Object.freeze(items) })
  }
  const parse = (raw: string): AgentPixivSession => {
    if (raw.length > 64_000) throw fail()
    const value = object(JSON.parse(raw), ['version', 'scope', 'generation', 'source', 'savedAt', 'data'])
    if (value.version !== 1) throw fail()
    return Object.freeze({ ...ticket(value as unknown as AgentPixivSession), version: 1, savedAt: count(value.savedAt), data: data(value.data) })
  }
  const keys = (selected: string) => [prefix + 'generation:' + selected, prefix + 'session:' + selected]
  return {
    async begin(binding: AgentBindingSnapshot, original: AgentPixivSessionSource): Promise<AgentPixivSearchTicket> {
      const selected = Object.freeze({ scope: scope(binding), generation: randomUUID(), source: source(original) })
      if (Number(await storage.eval(beginScript, { keys: keys(selected.scope), arguments: [selected.generation, String(RETAIN)] })) !== 1) throw fail()
      return selected
    },
    async current(selected: AgentPixivSearchTicket): Promise<boolean> { const row = ticket(selected); return await storage.get(keys(row.scope)[0]!) === row.generation },
    async save(selected: AgentPixivSearchTicket, result: AgentPixivSessionData): Promise<AgentPixivSession | undefined> {
      const record = Object.freeze({ ...ticket(selected), version: 1 as const, savedAt: now(), data: data(result) }), raw = JSON.stringify(record)
      if (raw.length > 64_000) throw fail()
      return Number(await storage.eval(saveScript, { keys: keys(record.scope), arguments: [record.generation, raw, String(TTL)] })) === 1 ? record : undefined
    },
    async load(binding: AgentBindingSnapshot): Promise<AgentPixivSession | undefined> {
      const selected = scope(binding), raw = await storage.get(keys(selected)[1]!)
      if (raw === null) return undefined
      const record = parse(raw), at = now()
      if (record.scope !== selected || record.savedAt > at || at - record.savedAt >= TTL || !await this.current(record)) return undefined
      return record
    },
    async discard(selected: AgentPixivSearchTicket): Promise<void> { const row = ticket(selected); await storage.eval(discardScript, { keys: keys(row.scope), arguments: [row.generation] }) },
    async touch(selected: AgentPixivSession): Promise<boolean> {
      const record = parse(JSON.stringify(selected)), at = now()
      if (record.savedAt > at || at - record.savedAt >= TTL) return false
      return Number(await storage.eval(touchScript, { keys: keys(record.scope), arguments: [record.generation, JSON.stringify(record), JSON.stringify({ ...record, savedAt: at }), String(TTL)] })) === 1
    },
    async claimAttempt(binding: AgentBindingSnapshot, messageId: string, kind: 'search' | 'download'): Promise<{ attempt?: AgentPixivAttempt; state: AgentPixivAttemptState }> {
      if (!['search', 'download'].includes(kind) || !isPlatformIdentifier(messageId)) throw fail()
      safe(messageId, 128)
      const key = prefix + 'attempt:' + digest(JSON.stringify([scope(binding), messageId, kind])), pending = JSON.stringify({ version: 1, state: 'pending', createdAt: now() })
      const previous = await storage.eval(claimScript, { keys: [key], arguments: [pending, String(RETAIN)] })
      if (previous === '') return { attempt: Object.freeze({ key, pending }), state: 'pending' }
      if (typeof previous !== 'string' || previous.length > 256) throw fail()
      const value = object(JSON.parse(previous), ['version', 'state', 'createdAt']); count(value.createdAt)
      if (value.version !== 1 || !['pending', 'sent', 'failed', 'unknown'].includes(value.state as string)) throw fail()
      return { state: value.state as AgentPixivAttemptState }
    },
    async finishAttempt(selected: AgentPixivAttempt, state: Exclude<AgentPixivAttemptState, 'pending'>): Promise<void> {
      if (!selected.key.startsWith(prefix + 'attempt:') || !['sent', 'failed', 'unknown'].includes(state)) throw fail()
      const previous = object(JSON.parse(selected.pending), ['version', 'state', 'createdAt'])
      if (Number(await storage.eval(finishScript, { keys: [selected.key], arguments: [selected.pending, JSON.stringify({ ...previous, state })] })) !== 1) throw fail()
    },
  }
}
export type AgentPixivSessionStore = ReturnType<typeof createAgentPixivSessionStore>
