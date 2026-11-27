import type { ConversationAddress, PlatformConnection, PlatformUserRef } from '../contracts/agentBinding.js'
import { conversationAddressKey, samePlatformNamespace } from '../modules/runtime/domain/agentBindings.js'
import { validateStandaloneBindingAddress } from './standaloneDingTalkConfig.js'

const label = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('会话记忆空间配置无效')
  }
  return value as Record<string, unknown>
}

function list(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new Error('会话记忆空间名单无效')
  return value
}

export function readStandaloneMemorySpaces(input: unknown, connections: readonly PlatformConnection[],
  hasBinding: (target: ConversationAddress) => boolean) {
  const groups = new Map<string, string>()
  const accounts = new Map(connections.map(connection => [connection.id, connection]))
  const privateUsers = new Map<string, { space: string; person: string }>()
  const spaces = new Set<string>()
  function target(value: unknown, kind: 'group' | 'private'): ConversationAddress {
    const item = object(value, ['connectionId', 'conversationId'])
    const connection = typeof item.connectionId === 'string' ? accounts.get(item.connectionId) : undefined
    if (!connection || !connection.memorySpaceId || typeof item.conversationId !== 'string') throw new Error('记忆空间会话未配置所属账号')
    const address = { account: connection.account, kind, id: item.conversationId }
    validateStandaloneBindingAddress(address)
    if (!hasBinding(address)) throw new Error('记忆空间会话须已有角色绑定')
    return address
  }
  for (const value of input === undefined ? [] : list(input, 64)) {
    const row = object(value, ['id', 'groups', 'privateUsers'])
    if (typeof row.id !== 'string' || !label.test(row.id) || spaces.has(row.id)) throw new Error('记忆空间 ID 无效或重复')
    const space = row.id
    spaces.add(space)
    const match = (value: unknown, kind: 'group' | 'private') => {
      const address = target(value, kind)
      const member = accounts.get(String(object(value, ['connectionId', 'conversationId']).connectionId))
      if (member?.memorySpaceId !== space) throw new Error('会话和账号须属于同一个记忆空间')
      return conversationAddressKey(address)
    }
    for (const group of list(row.groups ?? [], 64)) {
      const key = match(group, 'group')
      if (groups.has(key)) throw new Error('共享群重复')
      groups.set(key, space)
    }
    const people = new Set<string>()
    for (const value of list(row.privateUsers ?? [], 256)) {
      const user = object(value, ['id', 'aliases'])
      if (typeof user.id !== 'string' || !label.test(user.id) || people.has(user.id)) throw new Error('已验证用户标识无效或重复')
      people.add(user.id)
      const aliases = list(user.aliases, 16)
      if (aliases.length < 2) throw new Error('同一人的跨账号私聊须有至少两个已核实的会话')
      for (const alias of aliases) {
        const key = match(alias, 'private')
        if (privateUsers.has(key)) throw new Error('同一私聊只能归属于一个共享身份')
        privateUsers.set(key, { space, person: user.id })
      }
    }
  }
  return {
    get active() { return groups.size > 0 || privateUsers.size > 0 },
    available(address: ConversationAddress) {
      const key = conversationAddressKey(address)
      return groups.has(key) || privateUsers.has(key)
    },
    scope(address: ConversationAddress, actor: PlatformUserRef, currentSpace?: string) {
      if (!currentSpace || !samePlatformNamespace(address.account, actor)) return
      const key = conversationAddressKey(address)
      if (address.kind === 'group' && groups.get(key) === currentSpace) return { space: currentSpace, audience: 'groups' }
      const user = privateUsers.get(key)
      if (address.kind === 'private' && actor.id === address.id && user?.space === currentSpace) {
        return { space: currentSpace, audience: 'private:' + user.person }
      }
    },
  }
}
