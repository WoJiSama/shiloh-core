import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'

export type AgentBilibiliQualityState = 'pending' | 'sent' | 'failed' | 'unknown'
export type AgentBilibiliQualityStage = 'operation' | 'qr' | 'confirmation' | 'result' | 'media' | 'failure'
export interface AgentBilibiliQualityClaim { readonly key: string; readonly owner: string; readonly fingerprint: string }
interface RecordValue { version: 1; owner: string; fingerprint: string; createdAt: number; state: AgentBilibiliQualityState; effects: Partial<Record<AgentBilibiliQualityStage, AgentBilibiliQualityState>> }
const PREFIX = 'agent:bilibili-quality:v1:', ACTIVE = PREFIX + 'active', RETAIN = 604800
const states = ['pending', 'sent', 'failed', 'unknown'], stages = ['operation', 'qr', 'confirmation', 'result', 'media', 'failure']
const invalid = () => new Error('B站高清命令记录不可用')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value)
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw invalid()
  return value as Record<string, unknown>
}
function user(input: unknown): PlatformUserRef {
  const row = closed(input, ['platform', 'namespace', 'id'])
  if (!isPlatformAccount(row as unknown as PlatformUserRef) || [row.platform, row.namespace, row.id].some(value => typeof value !== 'string' || /(?:https?|file|data):/iu.test(value))) throw invalid()
  return Object.freeze({ platform: row.platform as string, namespace: row.namespace as string, id: row.id as string })
}
function scope(binding: AgentBindingSnapshot, revision: boolean): string {
  const row = closed(binding, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  if (!isConversationAddress(binding.target) || !['group', 'private'].includes(binding.target.kind) || row.source !== 'configured' || row.id !== conversationAddressKey(binding.target) ||
      ![row.agentId, row.personaId, row.connectionId, row.revision].every(isPlatformIdentifier)) throw invalid()
  user(binding.target.account)
  return hash(JSON.stringify([conversationAddressKey(binding.target), revision ? agentBindingToken(binding) : binding.agentId]))
}
function record(raw: string): RecordValue {
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid()
  const row = closed(JSON.parse(raw), ['version', 'owner', 'fingerprint', 'createdAt', 'state', 'effects']), effects = closed(row.effects, stages)
  if (row.version !== 1 || typeof row.owner !== 'string' || !/^[a-f\d-]{36}$/u.test(row.owner) || !hex(row.fingerprint) ||
      typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !states.includes(row.state as string) ||
      Object.values(effects).some(value => !states.includes(value as string))) throw invalid()
  return { version: 1, owner: row.owner, fingerprint: row.fingerprint, createdAt: row.createdAt, state: row.state as AgentBilibiliQualityState,
    effects: { ...effects } as RecordValue['effects'] }
}
const strings = `for i,key in ipairs(KEYS) do if i>1 then local t=redis.call('TYPE',key).ok if t~='none' and t~='string' then return redis.error_reply('invalid quality key') end end end\n`
const claimScript = strings + `local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='set' then return redis.error_reply('invalid quality index') end local old=redis.call('GET',KEYS[2]);if old then return old end if redis.call('SCARD',KEYS[1])>=4096 then return redis.error_reply('quality capacity') end redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2]);redis.call('SADD',KEYS[1],ARGV[3]);return ''`
const cas = `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`
const finishScript = `if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end redis.call('SET',KEYS[2],ARGV[2],'KEEPTTL');redis.call('SREM',KEYS[1],ARGV[3]);return 1`
const whiteWrite = `if redis.call('GET',KEYS[1])~=ARGV[1] or (redis.call('GET',KEYS[2]) or '')~=ARGV[2] then return 0 end redis.call('SET',KEYS[2],ARGV[3]);return 1`

/** Durable decisions contain hashes and fixed states, never URLs, QR bytes, keys or cookies. */
export function createAgentBilibiliQualityStore(storage: AgentInboxRedis, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const selected = async (claim: AgentBilibiliQualityClaim) => {
    const input = closed(claim, ['key', 'owner', 'fingerprint'])
    if (typeof input.key !== 'string' || !new RegExp(`^${PREFIX}command:[a-f\\d]{64}$`, 'u').test(input.key) || !hex(input.fingerprint)) throw invalid()
    const raw = await storage.get(input.key), value = raw && record(raw)
    if (!value || value.owner !== input.owner || value.fingerprint !== input.fingerprint || value.state !== 'pending') throw invalid()
    return { raw: raw!, value }
  }
  const whitelist = async (binding: AgentBindingSnapshot) => {
    if (binding.target.kind !== 'group') throw invalid()
    const key = PREFIX + 'whitelist:' + scope(binding, false), raw = await storage.get(key)
    if (!raw) return { key, raw: '', values: [] as { user: PlatformUserRef; allowed: boolean }[] }
    if (raw.length > 65536) throw invalid()
    const row = closed(JSON.parse(raw), ['version', 'overrides'])
    if (row.version !== 1 || !Array.isArray(row.overrides) || row.overrides.length > 128) throw invalid()
    const seen = new Set<string>(), values = row.overrides.map(input => {
      const item = closed(input, ['user', 'allowed']), who = user(item.user), id = platformAccountKey(who)
      if (typeof item.allowed !== 'boolean' || seen.has(id) || !samePlatformNamespace(who, binding.target.account)) throw invalid()
      seen.add(id); return { user: who, allowed: item.allowed }
    })
    return { key, raw, values }
  }
  const api = {
    async recover(): Promise<void> {
      const keys = await storage.eval(`local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='set' then return redis.error_reply('invalid quality index') end return redis.call('SMEMBERS',KEYS[1])`, { keys: [ACTIVE], arguments: [] })
      if (!Array.isArray(keys) || keys.length > 4096) throw invalid()
      for (const key of keys) {
        if (typeof key !== 'string' || !new RegExp(`^${PREFIX}command:[a-f\\d]{64}$`, 'u').test(key)) throw invalid()
        const raw = await storage.get(key)
        if (!raw) { await storage.eval(`return redis.call('SREM',KEYS[1],ARGV[1])`, { keys: [ACTIVE], arguments: [key] }); continue }
        const value = record(raw)
        value.state = 'unknown'
        for (const stage of stages as AgentBilibiliQualityStage[]) if (value.effects[stage] === 'pending') value.effects[stage] = 'unknown'
        await storage.eval(finishScript, { keys: [ACTIVE, key], arguments: [raw, JSON.stringify(value), key] })
      }
    },
    async claim(binding: AgentBindingSnapshot, messageId: string, fingerprint: string): Promise<AgentBilibiliQualityClaim | undefined> {
      if (!isPlatformIdentifier(messageId) || messageId === '0' || !hex(fingerprint)) throw invalid()
      const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw invalid()
      const key = PREFIX + 'command:' + hash(JSON.stringify([scope(binding, true), messageId])), owner = randomUUID()
      const value: RecordValue = { version: 1, owner, fingerprint, createdAt: at, state: 'pending', effects: {} }
      const old = await storage.eval(claimScript, { keys: [ACTIVE, key], arguments: [JSON.stringify(value), String(RETAIN), key] })
      if (old === '') return Object.freeze({ key, owner, fingerprint })
      if (typeof old !== 'string') throw invalid()
      const previous = record(old)
      if (previous.state === 'pending') {
        previous.state = 'unknown'
        for (const stage of stages as AgentBilibiliQualityStage[]) if (previous.effects[stage] === 'pending') previous.effects[stage] = 'unknown'
        await storage.eval(finishScript, { keys: [ACTIVE, key], arguments: [old, JSON.stringify(previous), key] })
      }
      return undefined
    },
    async current(claim: AgentBilibiliQualityClaim): Promise<boolean> { try { await selected(claim); return true } catch { return false } },
    async begin(claim: AgentBilibiliQualityClaim, stage: AgentBilibiliQualityStage): Promise<void> {
      if (!stages.includes(stage)) throw invalid()
      const { raw, value } = await selected(claim)
      if (value.effects[stage] !== undefined) throw invalid()
      value.effects[stage] = 'pending'
      if (Number(await storage.eval(cas, { keys: [claim.key], arguments: [raw, JSON.stringify(value)] })) !== 1) throw invalid()
    },
    async finish(claim: AgentBilibiliQualityClaim, stage: AgentBilibiliQualityStage, state: Exclude<AgentBilibiliQualityState, 'pending'>): Promise<void> {
      if (!stages.includes(stage) || !states.slice(1).includes(state)) throw invalid()
      const { raw, value } = await selected(claim)
      if (value.effects[stage] !== 'pending') throw invalid()
      value.effects[stage] = state
      if (Number(await storage.eval(cas, { keys: [claim.key], arguments: [raw, JSON.stringify(value)] })) !== 1) throw invalid()
    },
    async settle(claim: AgentBilibiliQualityClaim, state: Exclude<AgentBilibiliQualityState, 'pending'>): Promise<void> {
      const { raw, value } = await selected(claim)
      if (!states.slice(1).includes(state)) throw invalid()
      value.state = state
      for (const stage of stages as AgentBilibiliQualityStage[]) if (value.effects[stage] === 'pending') value.effects[stage] = 'unknown'
      if (Number(await storage.eval(finishScript, { keys: [ACTIVE, claim.key], arguments: [raw, JSON.stringify(value), claim.key] })) !== 1) throw invalid()
    },
    async users(binding: AgentBindingSnapshot, seed: readonly PlatformUserRef[]): Promise<readonly PlatformUserRef[]> {
      const { values } = await whitelist(binding), merged = new Map(seed.map(input => { const who = user(input); return [platformAccountKey(who), who] }))
      for (const value of values) if (value.allowed) merged.set(platformAccountKey(value.user), value.user); else merged.delete(platformAccountKey(value.user))
      return Object.freeze([...merged.values()])
    },
    async update(binding: AgentBindingSnapshot, claim: AgentBilibiliQualityClaim, users: readonly PlatformUserRef[], allowed: boolean): Promise<void> {
      if (typeof allowed !== 'boolean' || users.length < 1 || users.length > 20) throw invalid()
      const additions = users.map(user)
      if (additions.some(who => !samePlatformNamespace(who, binding.target.account) || who.id === binding.target.account.id)) throw invalid()
      for (let retry = 0; retry < 8; retry++) {
        const { raw: command } = await selected(claim), current = await whitelist(binding), merged = new Map(current.values.map(value => [platformAccountKey(value.user), value]))
        for (const who of additions) merged.set(platformAccountKey(who), { user: who, allowed })
        if (merged.size > 128) throw invalid()
        if (Number(await storage.eval(whiteWrite, { keys: [claim.key, current.key], arguments: [command, current.raw, JSON.stringify({ version: 1, overrides: [...merged.values()] })] })) === 1) return
      }
      throw invalid()
    },
  }
  return api
}
export type AgentBilibiliQualityStore = ReturnType<typeof createAgentBilibiliQualityStore>
