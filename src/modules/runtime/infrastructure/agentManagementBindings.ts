import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentManagementBindings } from '../../../contracts/agentManagement.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../domain/agentBindings.js'

const observations = new WeakMap<AgentManagementBindings, () => string>()
const fail = (): never => { throw new Error('管理绑定观察无效') }

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail()
  return descriptor.value
}
function copyBinding(value: unknown): AgentBindingSnapshot {
  const source = field(value, 'source'), id = field(value, 'id'), revision = field(value, 'revision'),
    agentId = field(value, 'agentId'), personaId = field(value, 'personaId'), connectionId = field(value, 'connectionId')
  const address = field(value, 'target'), account = field(address, 'account')
  const target = { account: { platform: field(account, 'platform'), namespace: field(account, 'namespace'), id: field(account, 'id') },
    kind: field(address, 'kind'), id: field(address, 'id') }
  if (source !== 'configured' && source !== 'legacy' || typeof id !== 'string' || !id || id.length > 4096 || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id) ||
      !isPlatformIdentifier(revision) || !isPlatformIdentifier(agentId) || !isPlatformIdentifier(personaId) || !isPlatformIdentifier(connectionId) ||
      !isConversationAddress(target as ConversationAddress)) return fail()
  return Object.freeze({ source, id, revision, agentId, personaId, connectionId,
    target: Object.freeze({ ...target, account: Object.freeze(target.account) }) as ConversationAddress })
}
function copyDirectory(value: unknown): readonly AgentBindingSnapshot[] {
  if (types.isProxy(value)) return fail()
  if (types.isPromise(value)) {
    // An invalid async reader must not leak its rejected Promise or invoke an overridden then.
    try { void Promise.prototype.then.call(value, undefined, () => {}) } catch { /* It is still invalid. */ }
    return fail()
  }
  if (!Array.isArray(value)) return fail()
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current) as object | null) {
    if (types.isProxy(current)) return fail()
    const then = Object.getOwnPropertyDescriptor(current, 'then')
    if (!then) continue
    if (!Object.hasOwn(then, 'value') || typeof then.value === 'function') return fail()
    break
  }
  const result: AgentBindingSnapshot[] = [], addresses = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const binding = copyBinding(field(value, String(index))), address = conversationAddressKey(binding.target)
    if (addresses.has(address)) return fail()
    addresses.add(address); result.push(binding)
  }
  return Object.freeze(result)
}
const signature = (bindings: readonly AgentBindingSnapshot[]) => JSON.stringify(bindings.map(binding =>
  JSON.stringify([agentConversationKey(binding), agentBindingToken(binding)])).sort())

/** A dynamic source is checked on every read. A loaded process snapshot is copied once. */
export function createAgentManagementBindings(source: (() => readonly AgentBindingSnapshot[]) | readonly AgentBindingSnapshot[]): AgentManagementBindings {
  const loaded = typeof source === 'function' ? undefined : copyDirectory(source)
  const loadedByTarget = loaded && new Map(loaded.map(binding => [conversationAddressKey(binding.target), binding]))
  const loadedSignature = loaded && signature(loaded)
  const list = typeof source === 'function' ? () => copyDirectory(source()) : () => loaded!
  const bindings = Object.freeze({ list, resolve(target: ConversationAddress) {
    const address = conversationAddressKey(target)
    return loadedByTarget ? loadedByTarget.get(address) : list().find(binding => conversationAddressKey(binding.target) === address)
  } })
  observations.set(bindings, () => loadedSignature ?? signature(list()))
  return bindings
}

/** Only this factory's exact port defines all resolution from the same complete observation.
 * The captured expectation is static; each invocation reads and compares the whole live directory.
 * A supplied holder must retain the same own data property before and after each read.
 * No observation object or authorization result escapes for reuse across callbacks or awaits. */
export function captureAgentBindingDirectoryCheck(bindings: AgentManagementBindings,
  expected: readonly AgentBindingSnapshot[], owner?: { readonly bindings: AgentManagementBindings }): (() => boolean) | undefined {
  const observe = observations.get(bindings)
  if (!observe) return undefined
  const owns = () => {
    if (owner === undefined) return true
    if (!owner || typeof owner !== 'object' || types.isProxy(owner)) return false
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'bindings')
    return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === bindings
  }
  if (!owns()) return undefined
  const captured = signature(copyDirectory(expected))
  return () => {
    if (!owns()) return false
    const current = observe()
    return owns() && current === captured
  }
}
