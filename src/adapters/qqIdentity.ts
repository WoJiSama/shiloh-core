import type { ConversationAddress } from '../contracts/agentBinding.js'
type QqConversationAddress = ConversationAddress & { readonly kind: 'group' | 'private' }

export function qqId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim())) return null
  return value.trim().replace(/^0+/, '') || null
}

export function validateQqBindingAddress(target: ConversationAddress): void {
  if (target.account.platform !== 'qq') return
  if (target.account.namespace !== 'global' || qqId(target.account.id) !== target.account.id ||
      qqId(target.id) !== target.id || (target.kind !== 'group' && target.kind !== 'private')) {
    throw new Error('QQ 绑定须使用 global 命名空间、群聊或私聊类型，以及无前导零的 QQ ID 字符串')
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function hasConflictingQqAccount(value: unknown): boolean {
  const event = record(value)
  const reported = qqId(event.self_id)
  const attached = qqId(record(event.bot).uin)
  return Boolean(reported && attached && reported !== attached)
}

/** An explicit QQ account must resolve to an actual account, including on a multi-bot host. */
export function findQqAccount(root: unknown, value: unknown): unknown {
  const id = qqId(value)
  if (!id) return undefined
  const host = record(root)
  const bots = record(host.bots)
  return [host[id], bots[id], ...Object.values(bots), root].find(bot => qqId(record(bot).uin) === id)
}

/** A legacy notice with no account can use an unambiguous local QQ host identity. */
export function soleQqAccountId(root: unknown): string | undefined {
  const host = record(root)
  const accounts = new Set<string>()
  const hostIds = host.uin
  for (const value of Array.isArray(hostIds) ? hostIds : [hostIds]) {
    const id = qqId(value)
    if (id) accounts.add(id)
  }
  for (const [key, bot] of Object.entries(record(host.bots))) {
    const named = qqId(key)
    const attached = qqId(record(bot).uin)
    if (named) accounts.add(named)
    if (attached) accounts.add(attached)
  }
  if (accounts.size === 1) return accounts.values().next().value
}

export function resolveQqConversationAddress(value: unknown): QqConversationAddress | null {
  const event = record(value)
  const id = qqId(event.self_id) ?? qqId(record(event.bot).uin)
  if (!id || hasConflictingQqAccount(event)) return null
  const account = Object.freeze({ platform: 'qq', namespace: 'global', id })
  const groupId = qqId(event.group_id)
  if (event.message_type === 'group' || event.isGroup === true || groupId !== null) {
    return groupId ? Object.freeze({ account, kind: 'group', id: groupId }) : null
  }
  if (event.group_id != null && event.group_id !== '') return null
  const peerId = qqId(event.user_id)
  return peerId ? Object.freeze({ account, kind: 'private', id: peerId }) : null
}
