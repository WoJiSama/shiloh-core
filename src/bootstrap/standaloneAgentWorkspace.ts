import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../contracts/agentBinding.js'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext, AgentConsoleGuard, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { AgentManagementBindings } from '../contracts/agentManagement.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'

export interface StandaloneAgentWorkspaceAgent {
  readonly id: string
  readonly name: string
  readonly personaId: string
  readonly personaName: string
}

export interface StandaloneAgentWorkspaceConnection {
  readonly id: string
  readonly account: PlatformAccountRef
  readonly state: 'connected' | 'disconnected' | 'unknown'
  readonly capabilities: readonly string[]
}

/** Synchronous, host-projected metadata from the loaded configuration; no runtime/model lookup. */
export interface StandaloneAgentWorkspaceOptions {
  readonly bindings: AgentManagementBindings
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize' | 'isCurrent'>
  readonly agents: () => readonly StandaloneAgentWorkspaceAgent[]
  readonly connections: () => readonly StandaloneAgentWorkspaceConnection[]
  /** Include only installed services. A declaration without a handler is unavailable. */
  readonly services: () => readonly AgentConsoleService[]
  readonly configState: (context: AgentConsoleContext) => Record<string, unknown>
  readonly now?: () => number
}

type ConfigState = Readonly<{
  processEpoch: string; loadedRevision: string; storedRevision: string; requiresRestart: boolean
  phase: 'active' | 'restart-required' | 'uncertain'
}>
type InstalledService = Readonly<{ operation: string; method: string; path: string; scope: 'global' | 'conversation'; handler: AgentConsoleService['handle'] }>
type Capability = Readonly<{
  operation: string; scope: 'global' | 'conversation'; effect: 'read' | 'write'
  status: 'available' | 'forbidden' | 'unavailable' | 'restart-required'; reason: string
  authorizedScopes?: readonly string[]
}>
const maximumRows = 256, maximumServices = 128, maximumResponseBytes = 1024 * 1024
// One workspace check, each binding, two directory permissions and each real capability/scope.
const maximumAuthorizations = 3 + maximumRows + AGENT_CONSOLE_SERVICES.reduce((sum, row) => sum + (row.scope === 'conversation' ? maximumRows : 1), 0)
const internalId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }

function object(input: unknown, code: 'invalid_request' | 'unavailable' = 'unavailable'): object {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail(code)
  return input
}
function own(input: object, key: string, optional = false): unknown {
  const field = Object.getOwnPropertyDescriptor(input, key)
  if (!field && optional) return undefined
  if (!field || !Object.hasOwn(field, 'value')) return fail('unavailable')
  return field.value
}
function label(input: unknown, maximum = 128, empty = false): string {
  if (typeof input !== 'string' || !empty && !input || input.length > maximum || input.trim() !== input || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) return fail('unavailable')
  return input
}
function identifier(input: unknown): string {
  const value = label(input, 64)
  if (!internalId.test(value)) return fail('unavailable')
  return value
}
function array<T>(input: unknown, maximum: number, project: (entry: unknown) => T): readonly T[] {
  if (!input || typeof input !== 'object' || types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail('unavailable')
  const length = own(input, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) return fail('unavailable')
  const result: T[] = []
  for (let index = 0; index < length; index++) result.push(project(own(input, String(index))))
  return Object.freeze(result)
}
function account(input: unknown): PlatformAccountRef {
  const row = object(input)
  return Object.freeze({ platform: identifier(own(row, 'platform')), namespace: label(own(row, 'namespace')), id: label(own(row, 'id')) })
}
function binding(input: unknown): AgentBindingSnapshot {
  const row = object(input), target = object(own(row, 'target')), source = own(row, 'source'), kind = own(target, 'kind')
  if (source !== 'configured' && source !== 'legacy' || kind !== 'group' && kind !== 'private' && kind !== 'channel' && kind !== 'thread') return fail('unavailable')
  return Object.freeze({ source, id: label(own(row, 'id'), 4096), revision: label(own(row, 'revision'), 4096),
    agentId: identifier(own(row, 'agentId')), personaId: label(own(row, 'personaId')), connectionId: identifier(own(row, 'connectionId')),
    target: Object.freeze({ account: account(own(target, 'account')), kind, id: label(own(target, 'id')) }) })
}
function bindingIdentity(row: AgentBindingSnapshot): string { return JSON.stringify([agentBindingToken(row), conversationAddressKey(row.target)]) }
function fingerprint(input: unknown): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex') }
function sort<T>(rows: readonly T[], key: (row: T) => string): readonly T[] {
  return Object.freeze([...rows].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0))
}
function unique<T>(rows: readonly T[], key: (row: T) => string): void {
  if (new Set(rows.map(key)).size !== rows.length) fail('conflict')
}
function agents(input: unknown): readonly StandaloneAgentWorkspaceAgent[] {
  const rows = array(input, maximumRows, input => {
    const row = object(input)
    return Object.freeze({ id: identifier(own(row, 'id')), name: label(own(row, 'name'), 256), personaId: label(own(row, 'personaId')), personaName: label(own(row, 'personaName'), 256) })
  })
  unique(rows, row => row.id)
  return sort(rows, row => row.id)
}
function connections(input: unknown): readonly StandaloneAgentWorkspaceConnection[] {
  const rows = array(input, maximumRows, input => {
    const row = object(input), state = own(row, 'state'), capabilities = array(own(row, 'capabilities'), 64, value => label(value))
    if (state !== 'connected' && state !== 'disconnected' && state !== 'unknown') return fail('unavailable')
    return Object.freeze({ id: identifier(own(row, 'id')), account: account(own(row, 'account')), state, capabilities: Object.freeze([...new Set(capabilities)].sort()) })
  })
  unique(rows, row => row.id); unique(rows, row => platformAccountKey(row.account))
  return sort(rows, row => row.id)
}
function installed(input: unknown): readonly InstalledService[] {
  const rows = array(input, maximumServices, input => {
    const row = object(input), method = label(own(row, 'method'), 8), scope = own(row, 'scope'), handler = own(row, 'handle', true)
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || scope !== 'global' && scope !== 'conversation' || handler !== undefined && (typeof handler !== 'function' || types.isProxy(handler))) return fail('unavailable')
    return Object.freeze({ operation: label(own(row, 'operation')), method, path: label(own(row, 'path'), 256), scope, handler: handler as AgentConsoleService['handle'] })
  })
  unique(rows, row => row.operation)
  return sort(rows, row => row.operation)
}
function state(input: unknown): ConfigState {
  const row = object(input), requiresRestart = own(row, 'requiresRestart'), phase = own(row, 'phase')
  if (typeof requiresRestart !== 'boolean' || phase !== 'active' && phase !== 'restart-required' && phase !== 'uncertain') return fail('unavailable')
  const result = Object.freeze({ processEpoch: label(own(row, 'processEpoch'), 4096), loadedRevision: label(own(row, 'loadedRevision'), 4096),
    storedRevision: label(own(row, 'storedRevision'), 4096, true), requiresRestart, phase })
  if (!requiresRestart && (phase !== 'active' || result.loadedRevision !== result.storedRevision)) return fail('conflict')
  return result
}
function empty(input: unknown): void {
  if (Reflect.ownKeys(object(input, 'invalid_request')).length) fail('invalid_request')
}
function validateRequest(input: AgentConsoleRequest, context: AgentConsoleContext): void {
  const row = object(input, 'invalid_request')
  // Read request fields by descriptor too: direct service callers receive the same closed shape as HTTP callers.
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== 'string' || !['method', 'pathname', 'params', 'query', 'body'].includes(key)) return fail('invalid_request')
    const field = Object.getOwnPropertyDescriptor(row, key)
    if (!field || !Object.hasOwn(field, 'value')) return fail('invalid_request')
  }
  if (Reflect.ownKeys(row).length !== 5) return fail('invalid_request')
  if (own(row, 'method') !== 'GET' || own(row, 'pathname') !== '/api/workspace' || context.binding) return fail('invalid_request')
  empty(own(row, 'params')); empty(own(row, 'query')); empty(own(row, 'body'))
}

/** A detached, permission-filtered directory snapshot. It never calls a management runtime or a native/model port. */
export function createStandaloneAgentWorkspace(options: StandaloneAgentWorkspaceOptions): AgentConsoleService {
  return Object.freeze({ operation: 'workspace.read', method: 'GET', path: '/api/workspace', scope: 'global',
    async handle(request: AgentConsoleRequest, context: AgentConsoleContext) {
      validateRequest(request, context)
      function baseCurrent(): boolean {
        try { return !context.signal.aborted && context.isCurrent() && options.auth.isCurrent(context.principal) === true } catch { return false }
      }
      function baseEnsure(): void { if (!baseCurrent()) fail('conflict'); context.ensureCurrent() }
      baseEnsure()
      function directory(): readonly AgentBindingSnapshot[] {
        const rows = sort(array(options.bindings.list(), maximumRows, binding), row => conversationAddressKey(row.target))
        unique(rows, row => conversationAddressKey(row.target))
        for (const row of rows) {
          const resolved = options.bindings.resolve(row.target)
          if (!resolved || bindingIdentity(binding(resolved)) !== bindingIdentity(row)) return fail('conflict')
        }
        return rows
      }
      const rows = directory(), expectedDirectory = fingerprint(rows), agentRows = agents(options.agents()), connectionRows = connections(options.connections())
      const serviceRows = installed(options.services()), configState = state(options.configState(context))
      const expectedMetadata = fingerprint([agentRows, connectionRows, serviceRows.map(row => ({ ...row, handler: !!row.handler })), configState])
      const agentMap = new Map(agentRows.map(row => [row.id, row])), connectionMap = new Map(connectionRows.map(row => [row.id, row]))
      for (const row of rows) {
        const owner = agentMap.get(row.agentId), connection = connectionMap.get(row.connectionId)
        // The complete loaded directory must agree; never infer a connection from an equal group or account ID.
        if (!owner || owner.personaId !== row.personaId || !connection || platformAccountKey(connection.account) !== platformAccountKey(row.target.account)) return fail('conflict')
      }
      function isCurrent(): boolean {
        try { return baseCurrent() && fingerprint(directory()) === expectedDirectory } catch { return false }
      }
      function ensureCurrent(): void { baseEnsure(); if (!isCurrent()) fail('conflict') }
      const guard: AgentConsoleGuard = Object.freeze({ signal: context.signal, isCurrent, ensureCurrent })
      let authorizations = 0
      async function authorize(operation: string, selected?: AgentBindingSnapshot): Promise<'allowed' | 'denied' | 'unavailable'> {
        ensureCurrent()
        if (++authorizations > maximumAuthorizations) return fail('unavailable')
        let decision: unknown
        try { decision = await options.auth.authorize(context.principal, operation, selected, guard) }
        catch { ensureCurrent(); return 'unavailable' }
        ensureCurrent()
        return decision === 'allowed' || decision === 'denied' ? decision : 'unavailable'
      }
      const workspaceDecision = await authorize('workspace.read')
      ensureCurrent()
      if (workspaceDecision !== 'allowed') return fail(workspaceDecision === 'denied' ? 'forbidden' : 'unavailable')
      const visible: AgentBindingSnapshot[] = []
      for (const row of rows) {
        const decision = await authorize('bindings.read', row)
        ensureCurrent()
        if (decision === 'unavailable') return fail('unavailable')
        if (decision === 'allowed') visible.push(row)
      }
      const visibleAgents = new Set(visible.map(row => row.agentId)), visibleConnections = new Set(visible.map(row => row.connectionId))
      const globalVisibility = async (operation: string, needed: boolean): Promise<boolean> => {
        if (!needed) return false
        const decision = await authorize(operation)
        ensureCurrent()
        if (decision === 'unavailable') return fail('unavailable')
        return decision === 'allowed'
      }
      const showUnboundAgents = await globalVisibility('agents.read', agentRows.some(row => !visibleAgents.has(row.id)))
      ensureCurrent()
      const showUnboundConnections = await globalVisibility('connections.read', connectionRows.some(row => !visibleConnections.has(row.id)))
      ensureCurrent()
      const outputAgents = Object.freeze(agentRows.filter(row => showUnboundAgents || visibleAgents.has(row.id)).map(row => Object.freeze({ ...row,
        conversations: Object.freeze(visible.filter(selected => selected.agentId === row.id).map(selected => Object.freeze({
          scopeKey: agentConversationKey(selected), bindingToken: agentBindingToken(selected), binding: selected,
        }))),
      })))
      const outputConnections = Object.freeze(connectionRows.filter(row => showUnboundConnections || visibleConnections.has(row.id)).map(row => Object.freeze({ ...row,
        conversationCount: visible.filter(selected => selected.connectionId === row.id).length,
      })))
      const services = new Map(serviceRows.map(row => [row.operation, row])), capabilities: Capability[] = []
      for (const definition of AGENT_CONSOLE_SERVICES) {
        const base = { operation: definition.operation, scope: definition.scope, effect: definition.method === 'GET' ? 'read' as const : 'write' as const }
        const service = services.get(definition.operation), matching = service?.method === definition.method && service.path === definition.path && service.scope === definition.scope
        if (configState.requiresRestart && !['workspace.read', 'config-state.read'].includes(definition.operation) && !definition.operation.startsWith('auth.')) {
          capabilities.push(Object.freeze({ ...base, status: 'restart-required', reason: 'execution-retired', ...(definition.scope === 'conversation' ? { authorizedScopes: Object.freeze([]) } : {}) }))
        } else if (!matching || !service.handler) {
          capabilities.push(Object.freeze({ ...base, status: 'unavailable', reason: 'handler-unavailable', ...(definition.scope === 'conversation' ? { authorizedScopes: Object.freeze([]) } : {}) }))
        } else if (definition.scope === 'global') {
          const decision = await authorize(definition.operation)
          ensureCurrent()
          capabilities.push(Object.freeze({ ...base, status: decision === 'allowed' ? 'available' : decision === 'denied' ? 'forbidden' : 'unavailable',
            reason: decision === 'allowed' ? 'authorized' : decision === 'denied' ? 'authorization-denied' : 'authorization-unavailable' }))
        } else {
          const authorizedScopes: string[] = []; let unavailable = false
          for (const selected of visible) {
            const decision = await authorize(definition.operation, selected)
            ensureCurrent()
            if (decision === 'allowed') authorizedScopes.push(agentConversationKey(selected))
            if (decision === 'unavailable') unavailable = true
          }
          capabilities.push(Object.freeze({ ...base, status: unavailable ? 'unavailable' : authorizedScopes.length ? 'available' : 'forbidden',
            reason: unavailable ? 'authorization-unavailable' : authorizedScopes.length ? 'authorized' : visible.length ? 'authorization-denied' : 'no-visible-conversations',
            authorizedScopes: Object.freeze(authorizedScopes) }))
        }
      }
      ensureCurrent()
      const observedAt = (options.now ?? Date.now)()
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) return fail('unavailable')
      const finalAgents = agents(options.agents()), finalConnections = connections(options.connections()), finalServices = installed(options.services())
      if (fingerprint([finalAgents, finalConnections, finalServices.map(row => ({ ...row, handler: !!row.handler })), state(options.configState(context))]) !== expectedMetadata ||
          finalServices.some((row, index) => row.handler !== serviceRows[index]?.handler)) return fail('conflict')
      const content = { mode: 'standalone' as const, version: 1, agents: outputAgents, connections: outputConnections, capabilities: Object.freeze(capabilities),
        configState, cognition: Object.freeze({ status: 'planned' as const }) }
      const value = Object.freeze({ ...content, observedAt, revision: `workspace:${fingerprint(content)}` })
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumResponseBytes) return fail('unavailable')
      ensureCurrent()
      // All response fields above were copied from validated own data descriptors into frozen JSON values.
      return Object.freeze({ kind: 'json' as const, value: value as unknown as AgentConsoleJson })
    },
  })
}
