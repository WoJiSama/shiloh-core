import type { ConversationContext } from '../contracts/conversation.js'
import type {PersonaIdentity} from '../contracts/persona.js'
import type {AgentBindingSnapshot} from '../contracts/agentBinding.js'
import {agentBindingToken, conversationAddressKey} from '../modules/runtime/domain/agentBindings.js'
import {qqId, resolveQqConversationAddress} from './qqIdentity.js'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
/** Parse only identity fields from a legacy event. Invalid identity does not interrupt legacy chat. */
export function resolveConversationContext(value: unknown): ConversationContext | null {
  const event = record(value)
  if (!event) return null
  const address = resolveQqConversationAddress(event)
  const userId = qqId(event.user_id)
  if (!address || !userId) return null
  const botId = address.account.id
  const snapshot = record(event._personaSnapshot)
  const persona: PersonaIdentity | undefined = snapshot?.botId === botId &&
    typeof snapshot.personaId === 'string' && Boolean(snapshot.personaId) &&
    typeof snapshot.personaVersion === 'string' && Boolean(snapshot.personaVersion) &&
    typeof snapshot.personaName === 'string' && Boolean(snapshot.personaName)
    ? Object.freeze({personaId: snapshot.personaId, personaVersion: snapshot.personaVersion, personaName: snapshot.personaName}) : undefined
  // Only project the binding captured by the host for this address.
  const candidate = persona ? snapshot?.binding as AgentBindingSnapshot | undefined : undefined
  const binding = candidate && typeof event._agentBindingToken === 'string' &&
    candidate.id === conversationAddressKey(address) && event._agentBindingToken === agentBindingToken(candidate)
    ? Object.freeze({
        source: candidate.source,
        id: candidate.id,
        revision: candidate.revision,
        agentId: candidate.agentId,
        personaId: candidate.personaId,
        connectionId: candidate.connectionId,
        target: address,
      }) : undefined
  const context = {
    botId,
    userId,
    conversationId: JSON.stringify(['qq', botId, address.kind, address.id]),
    ...(persona ? {persona} : {}),
    ...(binding ? {binding, sender: Object.freeze({platform: address.account.platform, namespace: address.account.namespace, id: userId})} : {}),
  }
  return address.kind === 'group'
    ? { ...context, kind: 'group', groupId: address.id }
    : { ...context, kind: 'private' }
}
