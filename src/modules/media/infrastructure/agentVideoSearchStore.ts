import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentVideoCard } from '../../../contracts/agentVideoCard.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { validateAgentVideoCard } from './agentVideoCard.js'

export interface AgentVideoSearchSource { readonly messageId: string; readonly author: PlatformUserRef }
export interface AgentVideoSearchTicket { readonly scope: string; readonly generation: string; readonly source: AgentVideoSearchSource }
export interface AgentVideoSearchSession extends AgentVideoSearchTicket { readonly version: 1; readonly savedAt: number; readonly items: readonly AgentVideoCard[] }
export interface AgentVideoShareAttempt { readonly key: string; readonly pending: string }
export type AgentVideoShareState = 'pending' | 'sent' | 'failed' | 'unknown'
export interface AgentVideoSearchStoreOptions { readonly now?: () => number; readonly allowsText?: (text: string) => boolean }

const PREFIX = 'agent:video-search:v1:', TTL = 300_000, RETAIN = 7 * 86_400
const PROCESS_OWNER = randomUUID()
const invalid = () => new Error('视频搜索会话或投递记录不可用')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw invalid()
  return value as Record<string, unknown>
}
const checked = `for _, key in ipairs(KEYS) do local t=redis.call('TYPE',key).ok if t~='none' and t~='string' then return redis.error_reply('invalid video search key') end end\n`
const begin = checked + `redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]);redis.call('DEL',KEYS[2]);return 1`
const save = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]);return 1`
const discard = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('DEL',KEYS[2]);return 1`
const current = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end if ARGV[2]~='' and redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end return 1`
const claim = checked + `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return '' end return redis.call('GET',KEYS[1])`
const finish = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`

/** A binding owns one five-minute list; transport claims survive recreated tools and process restarts. */
export function createAgentVideoSearchStore(storage: AgentInboxRedis, options: AgentVideoSearchStoreOptions = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.eval !== 'function') throw invalid()
  const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw invalid(); return value }
  const now = () => integer((options.now ?? Date.now)())
  const text = (value: unknown, maximum = 128): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || options.allowsText?.(value) === false) throw invalid()
    return value
  }
  const source = (input: unknown): AgentVideoSearchSource => {
    const row = object(input, ['messageId', 'author']), user = object(row.author, ['platform', 'namespace', 'id'])
    if (!isPlatformAccount(user as unknown as PlatformUserRef) || !isPlatformIdentifier(row.messageId) || row.messageId === '0') throw invalid()
    return Object.freeze({ messageId: text(row.messageId), author: Object.freeze({ platform: text(user.platform), namespace: text(user.namespace), id: text(user.id) }) })
  }
  const scope = (binding: AgentBindingSnapshot): string => {
    const row = object(binding, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
    if (!isConversationAddress(binding.target) || !['configured', 'legacy'].includes(row.source as string) || row.id !== conversationAddressKey(binding.target) ||
      !isPlatformIdentifier(row.agentId) || !isPlatformIdentifier(row.personaId) || !isPlatformIdentifier(row.connectionId)) throw invalid()
    text(row.id, 4096); text(row.revision, 4096)
    return hash(JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding)]))
  }
  const ticket = (input: AgentVideoSearchTicket): AgentVideoSearchTicket => {
    const row = object(input, ['scope', 'generation', 'source', 'version', 'savedAt', 'items'])
    if (typeof row.scope !== 'string' || !/^[a-f\d]{64}$/u.test(row.scope) || typeof row.generation !== 'string' || !/^[a-f\d-]{36}$/u.test(row.generation)) throw invalid()
    return Object.freeze({ scope: row.scope, generation: row.generation, source: source(row.source) })
  }
  const cards = (input: unknown): readonly AgentVideoCard[] => {
    if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 8 || Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
    const seen = new Set<string>()
    return Object.freeze(Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid()
      const card = validateAgentVideoCard(descriptor.value, options.allowsText)
      if (seen.has(card.id)) throw invalid(); seen.add(card.id)
      return card
    }))
  }
  const session = (input: unknown): AgentVideoSearchSession => {
    const row = object(input, ['version', 'scope', 'generation', 'source', 'savedAt', 'items'])
    if (row.version !== 1) throw invalid()
    return Object.freeze({ ...ticket(input as AgentVideoSearchTicket), version: 1, savedAt: integer(row.savedAt), items: cards(row.items) })
  }
  const parse = (raw: string): AgentVideoSearchSession => { if (typeof raw !== 'string' || raw.length > 32_768) throw invalid(); return session(JSON.parse(raw)) }
  const keys = (id: string) => [PREFIX + 'generation:' + id, PREFIX + 'session:' + id]
  const live = (row: AgentVideoSearchSession) => { const at = now(); return row.savedAt <= at && at - row.savedAt < TTL }
  const attemptRecord = (input: unknown) => {
    const row = object(input, ['version', 'state', 'createdAt', 'owner'])
    if (row.version !== 1 || !['pending', 'sent', 'failed', 'unknown'].includes(row.state as string) || typeof row.owner !== 'string' || !/^[a-f\d-]{36}$/u.test(row.owner)) throw invalid()
    return { version: 1, state: row.state as AgentVideoShareState, createdAt: integer(row.createdAt), owner: row.owner }
  }
  return {
    async begin(binding: AgentBindingSnapshot, original: AgentVideoSearchSource): Promise<AgentVideoSearchTicket> {
      const selected = Object.freeze({ scope: scope(binding), generation: randomUUID(), source: source(original) })
      if (!samePlatformNamespace(selected.source.author, binding.target.account) || selected.source.author.id === binding.target.account.id) throw invalid()
      if (Number(await storage.eval(begin, { keys: keys(selected.scope), arguments: [selected.generation, String(RETAIN)] })) !== 1) throw invalid()
      return selected
    },
    async current(selected: AgentVideoSearchTicket): Promise<boolean> {
      const row = ticket(selected), saved = 'savedAt' in selected ? session(selected) : undefined
      if (saved && !live(saved)) return false
      return Number(await storage.eval(current, { keys: keys(row.scope), arguments: [row.generation, saved ? JSON.stringify(saved) : ''] })) === 1
    },
    async save(selected: AgentVideoSearchTicket, items: readonly AgentVideoCard[]): Promise<AgentVideoSearchSession | undefined> {
      const row = session({ ...ticket(selected), version: 1, savedAt: now(), items }), raw = JSON.stringify(row)
      if (raw.length > 32_768) throw invalid()
      return Number(await storage.eval(save, { keys: keys(row.scope), arguments: [row.generation, raw, String(TTL)] })) === 1 ? row : undefined
    },
    async load(binding: AgentBindingSnapshot): Promise<AgentVideoSearchSession | undefined> {
      const selected = scope(binding), raw = await storage.get(keys(selected)[1]!)
      if (raw === null) return undefined
      const row = parse(raw)
      if (row.scope !== selected || !live(row) || !samePlatformNamespace(row.source.author, binding.target.account) || !await this.current(row)) return undefined
      return row
    },
    async discard(selected: AgentVideoSearchTicket): Promise<void> {
      const row = ticket(selected)
      await storage.eval(discard, { keys: keys(row.scope), arguments: [row.generation] })
    },
    async claimShare(binding: AgentBindingSnapshot, original: AgentVideoSearchSource): Promise<{ attempt?: AgentVideoShareAttempt; state: AgentVideoShareState }> {
      const selected = source(original)
      if (!samePlatformNamespace(selected.author, binding.target.account) || selected.author.id === binding.target.account.id) throw invalid()
      const key = PREFIX + 'share:' + hash(JSON.stringify([scope(binding), selected])), pending = JSON.stringify({ version: 1, state: 'pending', createdAt: now(), owner: PROCESS_OWNER })
      const previous = await storage.eval(claim, { keys: [key], arguments: [pending, String(RETAIN)] })
      if (previous === '') return { attempt: Object.freeze({ key, pending }), state: 'pending' }
      if (typeof previous !== 'string' || previous.length > 256) throw invalid()
      const record = attemptRecord(JSON.parse(previous))
      if (record.state === 'pending' && record.owner !== PROCESS_OWNER) {
        await storage.eval(finish, { keys: [key], arguments: [previous, JSON.stringify({ ...record, state: 'unknown' })] })
        return { state: 'unknown' }
      }
      return { state: record.state }
    },
    async finishShare(selected: AgentVideoShareAttempt, state: Exclude<AgentVideoShareState, 'pending'>): Promise<void> {
      const row = object(selected, ['key', 'pending'])
      if (typeof row.key !== 'string' || !new RegExp(`^${PREFIX}share:[a-f\\d]{64}$`, 'u').test(row.key) ||
        typeof row.pending !== 'string' || row.pending.length > 256 || !['sent', 'failed', 'unknown'].includes(state)) throw invalid()
      const record = attemptRecord(JSON.parse(row.pending))
      if (record.state !== 'pending' || record.owner !== PROCESS_OWNER || Number(await storage.eval(finish,
        { keys: [row.key], arguments: [row.pending, JSON.stringify({ ...record, state })] })) !== 1) throw invalid()
    },
  }
}
export type AgentVideoSearchStore = ReturnType<typeof createAgentVideoSearchStore>
