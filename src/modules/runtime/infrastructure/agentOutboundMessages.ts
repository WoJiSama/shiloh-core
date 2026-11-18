import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentInboxRedis } from './agentInbox.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../domain/agentBindings.js'

const retainSeconds = 7 * 86_400
const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('出站消息归属读取超时')), 5000)
  operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
const remember = `local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='string' then return redis.error_reply('invalid outbound key') end
if redis.call('SET',KEYS[1],'1','NX','EX',ARGV[1]) then return 1 end
if redis.call('GET',KEYS[1])=='1' then return 1 end return 0`

/** Only confirmed, same-conversation receipts establish recall ownership.
 * Keys contain no message text or unencrypted identity; missing evidence denies recall. */
export function createAgentOutboundMessages(storage: AgentInboxRedis) {
  const key = (binding: AgentBindingSnapshot, messageId: string) => {
    if (!binding || !isConversationAddress(binding.target) || !isPlatformIdentifier(messageId) || messageId === '0') throw new Error('出站消息归属无效')
    return 'agent:outbound:v1:' + createHash('sha256').update(JSON.stringify([
      conversationAddressKey(binding.target), agentBindingToken(binding), messageId,
    ])).digest('hex')
  }
  return {
    async remember(binding: AgentBindingSnapshot, messageId: string): Promise<void> {
      if (Number(await bounded(storage.eval(remember, { keys: [key(binding, messageId)], arguments: [String(retainSeconds)] }))) !== 1) throw new Error('出站消息归属未确认')
    },
    async owns(binding: AgentBindingSnapshot, messageId: string): Promise<boolean> {
      return await bounded(storage.get(key(binding, messageId))) === '1'
    },
  }
}
