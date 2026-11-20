import type { AgentTool, AgentToolAccess, AgentToolCapability, AgentToolContext, AgentToolEffect, AgentToolMetadata } from '../../../contracts/agentTool.js'
import { isConversationAddress, isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'

const capabilities = new Set<AgentToolCapability>([
  'sendImage', 'sendFile', 'sendAudio', 'sendVideo', 'sendMusic', 'sendVideoCard', 'sendMediaRelay', 'interact',
  'runQqAction', 'qzone', 'qzoneAffinity', 'qzoneCandidates', 'reviewQqText', 'isSourceAvailable', 'sendBundle',
  'readImages', 'readMember', 'listMembers', 'sendMessage', 'readHistory', 'readFile', 'readVideo', 'listFiles',
])
const metadata = new Set<AgentToolMetadata>(['request', 'botUserId', 'privatePeer', 'persona'])
const privateReads = new Set<AgentToolCapability>(['readHistory', 'readFile', 'readVideo', 'listFiles'])
const unavailableWithEphemeralData = new Set<AgentToolCapability>([
  'sendFile', 'sendAudio', 'sendVideo', 'sendMusic', 'sendVideoCard', 'sendMediaRelay', 'interact',
])

export type AgentToolAccessContext = Pick<AgentToolContext, 'binding' | 'actor' | 'isCurrent' | 'ensureCurrent' | 'recordUsage' | AgentToolMetadata> &
  Partial<Record<AgentToolCapability, unknown>> & { readonly signal?: AbortSignal }

function validSelection<T>(selection: readonly T[] | undefined, names: ReadonlySet<T>): boolean {
  return selection === undefined || Array.isArray(selection) && selection.every(name => names.has(name))
}

function validAccess(access: AgentToolAccess): boolean {
  return !!access && typeof access === 'object' && !Array.isArray(access) &&
    Object.keys(access).every(key => ['actor', 'conversation', 'required', 'optional', 'metadata'].includes(key)) &&
    (access.actor === undefined || access.actor === 'user') &&
    (access.conversation === undefined || access.conversation === 'group' || access.conversation === 'private') &&
    validSelection(access.required, capabilities) && validSelection(access.optional, capabilities) && validSelection(access.metadata, metadata)
}

export function isAgentToolEffect(effect: AgentToolEffect | undefined): boolean {
  return effect === undefined || effect === 'read' || effect === 'sendMusic' || typeof effect === 'function' || validAccess(effect)
}

function hasHumanRequest(context: AgentToolAccessContext): boolean {
  const { actor, binding, request, botUserId } = context
  return actor.kind === 'user' && isPlatformAccount(actor.user) && isConversationAddress(binding.target) &&
    samePlatformNamespace(actor.user, binding.target.account) && actor.user.id !== binding.target.account.id && actor.user.id !== botUserId &&
    isPlatformIdentifier(request?.messageId) && request.messageId !== '0' && typeof request.text === 'string'
}

/** Check actor and available host ports before running a provider or taking an action slot. */
export function authorizeAgentToolContext<T extends AgentToolAccessContext>(
  tool: Pick<AgentTool, 'effect' | 'dataPolicy'>,
  input: Readonly<Record<string, unknown>>,
  context: T,
  options: { custom?: boolean } = {},
): T | undefined {
  const { effect, dataPolicy } = tool
  try {
    if (options.custom && !hasHumanRequest(context)) return undefined
    if (effect === undefined) return context
    const access: AgentToolAccess = effect === 'read' ? {} : effect === 'sendMusic'
      ? { actor: 'user', conversation: 'group', required: ['sendMusic'] }
      : typeof effect === 'function' ? effect(input, context.binding.target.kind) : effect
    if (!validAccess(access) || access.actor === 'user' && !hasHumanRequest(context) ||
        access.conversation && context.binding.target?.kind !== access.conversation) return undefined
    const available = (key: AgentToolCapability) => typeof context[key] === 'function' &&
      (dataPolicy === 'ephemeral' ? !unavailableWithEphemeralData.has(key) : !privateReads.has(key))
    if (access.required?.some(key => !available(key))) return undefined
    const keys = [...new Set([
      ...(access.metadata ?? []),
      ...(access.required ?? []),
      ...(access.optional ?? []).filter(available),
    ])]
    const { binding, actor, signal, isCurrent, ensureCurrent, recordUsage } = context
    return {
      binding, actor, isCurrent,
      ...(signal ? { signal } : {}),
      ...(ensureCurrent ? { ensureCurrent } : {}),
      ...(recordUsage ? { recordUsage } : {}),
      ...Object.fromEntries(keys.filter(key => context[key] !== undefined).map(key => [key, context[key]])),
    } as T
  } catch { return undefined }
}
