import type {AgentBindingSnapshot} from '../../../contracts/agentBinding.js'
import {agentBindingToken} from '../../runtime/domain/agentBindings.js'

export interface ConversationIdentity {
 self_id?:string|number|null|undefined;bot?:{uin?:string|number|null|undefined};
 _agentBinding?:AgentBindingSnapshot;message_type?:string;user_id?:string|number;
}

/** Live chat state belongs to the captured route revision. Durable role data uses its stable identity. */
export function configuredConversationKey(binding?:AgentBindingSnapshot): string | undefined {
 if (binding?.source === 'configured') return `binding:${agentBindingToken(binding)}`
}

/** Explicit event identity scopes bot-owned state; legacy callers retain their group-only namespace. */
export function smartConversationKey(groupId:string|number,event?:ConversationIdentity):string|number {
 const configured = configuredConversationKey(event?._agentBinding)
 if (configured) return configured
 const botId=event?.self_id ?? event?.bot?.uin
 // 私聊按用户隔离:此前 groupId 为空串,所有私聊用户共享一份会话状态互相串台
 if (event?.message_type === "private") {
  const userId=String(event.user_id ?? "")
  return botId === undefined || botId === null || botId === '' ? `private:${userId}` : `bot:${String(botId)}:private:${userId}`
 }
 return botId === undefined || botId === null || botId === '' ? groupId : `bot:${String(botId)}:group:${String(groupId)}`
}
