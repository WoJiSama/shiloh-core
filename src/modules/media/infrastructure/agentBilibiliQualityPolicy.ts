import { types } from 'node:util'
import type { AgentBilibiliQualityConfig, AgentBilibiliQualityRequest } from '../../../contracts/agentBilibiliQuality.js'
import type { ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import { conversationAddressKey, isConversationAddress, isPlatformAccount, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { parseAgentBilibiliReference } from './agentBilibiliRelayReference.js'

const fail = () => new Error('B站高清命令配置或来源不符合要求')
/** Only bounded own data is cloned; no getter, Proxy, toJSON or native event crosses the workflow. */
export function ownBilibiliQualityData<T>(input: T): T {
  let count = 0
  const visit = (value: unknown, depth: number): void => {
    if (++count > 4000 || depth > 12) throw fail()
    if (value === undefined || value === null || ['string', 'boolean', 'number'].includes(typeof value)) return
    if (typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw fail()
    if (Array.isArray(value) && (value.length > 4000 || Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some(present => !present))) throw fail()
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === 'toJSON') throw fail()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail()
      visit(descriptor.value, depth + 1)
    }
  }
  visit(input, 0)
  return JSON.parse(JSON.stringify(input)) as T
}
function user(value: unknown): PlatformUserRef {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,namespace,platform' || !isPlatformAccount(value as PlatformUserRef)) throw fail()
  return Object.freeze({ ...(value as PlatformUserRef) })
}
function target(value: unknown): ConversationAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'account,id,kind' || !isConversationAddress(value as ConversationAddress) || (value as ConversationAddress).kind !== 'group') throw fail()
  const selected = value as ConversationAddress
  return Object.freeze({ account: user(selected.account), kind: 'group', id: selected.id })
}
export function validateAgentBilibiliQualityConfig(input: unknown): Readonly<AgentBilibiliQualityConfig> {
  const value = ownBilibiliQualityData(input ?? { enabled: false, masters: [] }) as Record<string, unknown>
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'masters', 'whitelist'].includes(key)) || typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.masters) || value.masters.length > 64 || value.whitelist !== undefined && (!Array.isArray(value.whitelist) || value.whitelist.length > 128)) throw fail()
  const masters = value.masters.map(user)
  if (new Set(masters.map(platformAccountKey)).size !== masters.length) throw fail()
  const seen = new Set<string>(), whitelist = ((value.whitelist ?? []) as unknown[]).map(input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'target,users') throw fail()
    const row = input as { target: unknown; users: unknown }, selected = target(row.target)
    if (!Array.isArray(row.users) || row.users.length > 128 || seen.has(conversationAddressKey(selected))) throw fail()
    seen.add(conversationAddressKey(selected))
    const users = row.users.map(user)
    if (users.some(who => !samePlatformNamespace(who, selected.account) || who.id === selected.account.id) || new Set(users.map(platformAccountKey)).size !== users.length) throw fail()
    return Object.freeze({ target: selected, users: Object.freeze(users) })
  })
  return Object.freeze({ enabled: value.enabled, masters: Object.freeze(masters), whitelist: Object.freeze(whitelist) })
}
export type AgentBilibiliQualityCommand = { readonly kind: 'invalid' } | { readonly kind: 'quality'; readonly request: AgentBilibiliQualityRequest }
  | { readonly kind: 'whitelist'; readonly operation: 'add' | 'remove' | 'list'; readonly users: readonly PlatformUserRef[] }
  | { readonly kind: 'auth'; readonly operation: 'login' | 'status' | 'logout' }
const prefix = /^[.。]\s*(?:高清搬运|B站授权)/iu
export function isAgentBilibiliQualityCommand(message: IncomingMessage | string): boolean {
  try {
    if (typeof message === 'string') return prefix.test(message.trim())
    if (!message || types.isProxy(message)) return false
    const descriptor = Object.getOwnPropertyDescriptor(message, 'text')
    return !!descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && prefix.test(descriptor.value.trim())
  } catch { return false }
}
export function parseAgentBilibiliQualityCommand(message: IncomingMessage): AgentBilibiliQualityCommand | undefined {
  if (!isAgentBilibiliQualityCommand(message)) return undefined
  const invalid = { kind: 'invalid' as const }, text = message.text.trim()
  if (text.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(text) || message.quote !== undefined ||
      !Array.isArray(message.parts) || !message.parts.length || message.parts.some(part => part.kind !== 'text' && part.kind !== 'mention')) return invalid
  const body = message.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('').trim()
  const auth = /^[.。]\s*B站授权\s*(登录|状态|退出)$/iu.exec(body)
  if (auth) return message.mentions.length || message.parts.some(part => part.kind === 'mention') ? invalid : { kind: 'auth', operation: auth[1] === '登录' ? 'login' : auth[1] === '退出' ? 'logout' : 'status' }
  if (message.conversation.kind !== 'group') return invalid
  const white = /^[.。]\s*高清搬运白名单(?:\s*(添加|删除|查看))?\s*$/u.exec(body)
  if (white) {
    const mentions = message.parts.flatMap(part => part.kind === 'mention' && part.user !== 'everyone' ? [part.user] : [])
    if (message.parts.some(part => part.kind === 'mention' && part.user === 'everyone') || mentions.length > 20 ||
        mentions.some(who => !isPlatformAccount(who) || !samePlatformNamespace(who, message.conversation.account) || who.id === message.conversation.account.id) ||
        JSON.stringify(mentions.map(platformAccountKey).sort()) !== JSON.stringify(message.mentions.map(platformAccountKey).sort())) return invalid
    const operation = white[1] === '添加' ? 'add' : white[1] === '删除' ? 'remove' : 'list'
    if (operation === 'list' ? mentions.length > 0 : mentions.length === 0) return invalid
    return { kind: 'whitelist', operation, users: Object.freeze([...new Map(mentions.map(who => [platformAccountKey(who), Object.freeze({ ...who })])).values()]) }
  }
  if (message.mentions.length || message.parts.some(part => part.kind === 'mention') || body !== text) return invalid
  const match = /^[.。]\s*高清搬运\s+(\S+)\s+(\S+)$/u.exec(body)
  if (!match) return invalid
  const qualities: Record<string, number> = { '240P': 6, '360P': 16, '480P': 32, '720P': 64, '1080P': 80, '1080P+': 112, '4K': 120 }
  const qualityText = match[1]!.toUpperCase(), quality = qualities[qualityText] ?? Number(qualityText.replace(/^QN=?/u, ''))
  if (!Number.isInteger(quality) || quality < 1 || quality > 127) return invalid
  const raw = match[2]!, direct = /^BV[0-9A-Za-z]{10}$/u.test(raw) ? `https://www.bilibili.com/video/${raw}` : raw
  let url: URL
  try { url = new URL(direct) } catch { return invalid }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || /[\\\s]/u.test(direct) ||
      !(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname) && /^(?:\/video\/BV[0-9A-Za-z]{10}|\/bangumi\/play\/ep[1-9]\d{0,19})\/?$/u.test(url.pathname) ||
        url.hostname === 'b23.tv' && /^\/[A-Za-z0-9_-]{1,128}\/?$/u.test(url.pathname))) return invalid
  const share = parseAgentBilibiliReference(direct)
  return share?.provider === 'bilibili' ? { kind: 'quality', request: { quality, share } } : invalid
}
