import type { AgentInteraction } from '../../../contracts/agentInteraction.js'
import type { ConversationMember } from '../../../contracts/platformConnection.js'

export type AgentGroupManagement = Extract<AgentInteraction, { kind: 'member-mute' | 'group-mute' | 'member-card' }>
type Member = Pick<ConversationMember, 'user' | 'role'>
const sameUser = (left: Member['user'], right: Member['user']) => left.platform === right.platform && left.namespace === right.namespace && left.id === right.id
const manager = (member: Member) => member.role === 'owner' || member.role === 'admin'
const known = (member: Member) => manager(member) || member.role === 'member'

export function isAgentGroupManagement(operation: AgentInteraction): operation is AgentGroupManagement {
  return operation.kind === 'member-mute' || operation.kind === 'group-mute' || operation.kind === 'member-card'
}

/** Authority is derived from fresh members, never a model-supplied role.
 * Adapters still own native scope evidence and the platform's final decision. */
export function canApplyGroupManagement(operation: AgentGroupManagement, requester: Member, bot: Member, target?: Member): boolean {
  if (!known(requester) || !known(bot) || !sameUser(operation.requester, requester.user) || sameUser(requester.user, bot.user) ||
      requester.user.platform !== bot.user.platform || requester.user.namespace !== bot.user.namespace) return false
  if (operation.kind === 'group-mute') return manager(requester) && manager(bot)
  if (!target || !known(target) || !sameUser(operation.user, target.user) ||
      target.user.platform !== bot.user.platform || target.user.namespace !== bot.user.namespace) return false
  if (operation.kind === 'member-mute') return manager(requester) && manager(bot) && target.role === 'member' && !sameUser(target.user, bot.user)
  return (sameUser(requester.user, target.user) || manager(requester)) && (sameUser(bot.user, target.user) || manager(bot))
}
