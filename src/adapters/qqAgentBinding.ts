import path from 'node:path'
import { isAgentBindingCurrent, type AgentBindingSnapshot, type AgentBindingTurn, type RestoreDeferredAgentBinding } from '../contracts/agentBinding.js'
import type { createPersonaLibrary } from '../modules/conversation/infrastructure/personaLibrary.js'
import { resolveConfiguredAgentPersona } from '../modules/runtime/application/agentPersona.js'
import { agentBindingIdentity, agentBindingToken, conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { createAgentBindingConfig } from '../modules/runtime/infrastructure/agentBindingConfig.js'
import { hasConflictingQqAccount, resolveQqConversationAddress, validateQqBindingAddress } from './qqIdentity.js'

type PersonaLibrary = Pick<ReturnType<typeof createPersonaLibrary>, 'file' | 'resolve' | 'detailById'>
type PersonaSelection = ReturnType<PersonaLibrary['resolve']>
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function createQqAgentBindingResolver(library: PersonaLibrary) {
  const read = createAgentBindingConfig(path.join(path.dirname(library.file), 'agent-bindings.yaml'), validateQqBindingAddress)

  return function resolve(value: unknown): { selected: PersonaSelection; scopeId: string; binding?: AgentBindingSnapshot } {
    const event = record(value)
    if (hasConflictingQqAccount(event)) throw new Error('QQ 事件账号与宿主账号不一致')
    const target = resolveQqConversationAddress(event)
    const directory = read()
    const configured = target && directory?.resolve(target)
    if (configured) {
      return { ...resolveConfiguredAgentPersona(configured, library.detailById), binding: configured }
    }

    const selected = library.resolve({
      messageType: String(event.message_type || ''),
      groupId: String(event.group_id || ''),
      selfId: String(event.self_id || record(event.bot).uin || ''),
    })
    if (!target) return { selected, scopeId: selected.id }
    const connectionId = directory?.connectionFor(target.account)?.id ?? `qq:${target.account.id}`
    const binding: AgentBindingSnapshot = Object.freeze({
      source: 'legacy',
      id: conversationAddressKey(target),
      revision: 'legacy-v1',
      agentId: JSON.stringify(['legacy-qq', target.account.id, selected.id]),
      personaId: selected.id,
      connectionId,
      target,
    })
    return { selected, scopeId: selected.id, binding }
  }
}

const resolvers = new WeakMap<PersonaLibrary, ReturnType<typeof createQqAgentBindingResolver>>()

export function resolveQqAgentBinding(library: PersonaLibrary, event: unknown) {
  let resolve = resolvers.get(library)
  if (!resolve) {
    resolve = createQqAgentBindingResolver(library)
    resolvers.set(library, resolve)
  }
  return resolve(event)
}

/** Ingress, delayed turns and restart recovery must agree on the binding they use. */
export function captureQqBinding(library: PersonaLibrary, event: AgentBindingTurn, binding: AgentBindingSnapshot): boolean {
  const token = agentBindingToken(binding)
  const expected = event._expectedAgentBindingToken ?? event._agentBindingToken
  if (expected !== undefined && expected !== token) return false
  if (event._isAgentBindingCurrent && !isAgentBindingCurrent(event)) return false
  event._agentBinding = binding
  if (event._isAgentBindingCurrent) return true

  let valid = true
  event._agentBindingToken = token
  event._isAgentBindingCurrent = () => {
    if (!valid) return false
    valid = false
    const target = resolveQqConversationAddress(event)
    if (!target || conversationAddressKey(target) !== binding.id) return false
    const live = resolveQqAgentBinding(library, event).binding
    valid = live !== undefined && agentBindingToken(live) === token
    return valid
  }
  return true
}

/** Deferred work may only acquire a guard for its stored revision or registered owner. */
export function restoreQqDeferredBinding(library: PersonaLibrary, ...[event, expected]: Parameters<RestoreDeferredAgentBinding>): ReturnType<RestoreDeferredAgentBinding> {
  if (hasConflictingQqAccount(event)) return 'changed'
  try {
    const {binding} = resolveQqAgentBinding(library, event)
    if (!binding) return 'unavailable'
    if (expected) {
      if ('token' in expected ? agentBindingToken(binding) !== expected.token : agentBindingIdentity(binding) !== expected.identity) return 'changed'
    } else if (binding.source !== 'legacy') return 'changed'
    return captureQqBinding(library, event, binding) ? 'current' : 'changed'
  } catch {
    return 'unavailable'
  }
}
