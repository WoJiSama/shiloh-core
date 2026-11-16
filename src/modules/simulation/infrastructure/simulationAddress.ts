import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import { conversationAddressKey, decodeConversationAddressKey } from '../../runtime/domain/agentBindings.js'

export function isQqSimulationAddress(target: ConversationAddress): boolean {
  return target.kind === 'group' && target.account.platform === 'qq' && target.account.namespace === 'global'
}

export function qqSimulationAddress(groupId: string, accountId: string): ConversationAddress {
  return { account: { platform: 'qq', namespace: 'global', id: accountId }, kind: 'group', id: groupId }
}

const prefix = 'v2.'

export function simulationAddressKey(target: ConversationAddress): string {
  return prefix + Buffer.from(conversationAddressKey(target)).toString('base64url')
}

export function decodeSimulationAddressKey(key: string): ConversationAddress | null {
  if (key.length > 6000 || !key.startsWith(prefix)) return null
  const encoded = key.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  const target = decodeConversationAddressKey(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!target || target.kind === 'private' || simulationAddressKey(target) !== key) return null
  if (target.account.platform === 'qq' && (!isQqSimulationAddress(target) || !/^[1-9]\d*$/.test(target.account.id) || !/^[1-9]\d*$/.test(target.id))) return null
  return target
}
