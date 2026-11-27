import { isProxy } from 'node:util/types'
import type { AgentBindingSnapshot, ConversationAddress } from '../contracts/agentBinding.js'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext, AgentConsoleGuard, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { AgentDiagnosticEvent, AgentOperationJournal } from '../contracts/agentDiagnostics.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { parseAgentDiagnosticEvent } from '../modules/runtime/infrastructure/agentOperationJournal.js'
import type { AgentJournalReadResult } from '../modules/runtime/infrastructure/agentOperationJournalReader.js'
import { captureSynchronousGuardCheck, createSynchronousGuard, ensureSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'
import { describeAgentDiagnostic } from './standaloneQqAlerts.js'
import { aggregateContextMetrics } from '../modules/runtime/domain/contextMetrics.js'

export interface StandaloneAgentObserveOptions {
  readonly bindings: { list(): readonly AgentBindingSnapshot[]; resolve(target: ConversationAddress): AgentBindingSnapshot | undefined }
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize' | 'isCurrent'>
  readonly read: (guard: AgentConsoleGuard, traceId?: string) => Promise<AgentJournalReadResult>
  readonly health: AgentOperationJournal['health']
  readonly configState: (context: AgentConsoleContext) => Record<string, AgentConsoleJson>
  readonly now?: () => number
}

const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('invalid_request')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) return fail('invalid_request')
    result[key] = field.value
  }
  return result
}
function text(value: unknown, maximum = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value || value.trim() !== value || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) return fail('unavailable')
  return value
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail('unavailable')
  return value as number
}
function copyBinding(value: unknown): AgentBindingSnapshot {
  try {
    const parsed = parseAgentDiagnosticEvent({ version: 1, id: 'binding', traceId: 'binding', at: 0,
      scope: { kind: 'conversation', binding: value }, stage: 'host', operation: 'binding', outcome: 'started' })
    if (parsed.scope.kind !== 'conversation' || parsed.scope.binding.source !== 'configured') return fail('conflict')
    return parsed.scope.binding
  } catch { return fail('conflict') }
}
const identity = (binding: AgentBindingSnapshot): string => JSON.stringify([agentBindingToken(binding), conversationAddressKey(binding.target)])
const owner = (binding: AgentBindingSnapshot): string => JSON.stringify([binding.source, binding.id, binding.agentId, binding.personaId, binding.connectionId, conversationAddressKey(binding.target)])
function snapshot(rows: readonly AgentBindingSnapshot[]): readonly AgentBindingSnapshot[] {
  if (!Array.isArray(rows) || isProxy(rows) || rows.length > 256) return fail('unavailable')
  const copied: AgentBindingSnapshot[] = []
  for (let index = 0; index < rows.length; index++) {
    const field = Object.getOwnPropertyDescriptor(rows, index)
    if (!field || !Object.hasOwn(field, 'value')) return fail('conflict')
    copied.push(copyBinding(field.value))
  }
  if (new Set(copied.map(row => conversationAddressKey(row.target))).size !== copied.length) return fail('conflict')
  return Object.freeze(copied.sort((a, b) => conversationAddressKey(a.target).localeCompare(conversationAddressKey(b.target))))
}
function query(request: AgentConsoleRequest): { limit: number; traceId?: string; outcome?: string } {
  const input = record(request)
  if (Object.keys(input).length !== 5 || Object.keys(input).some(key => !['method', 'pathname', 'params', 'query', 'body'].includes(key)) ||
      input.method !== 'GET' || input.pathname !== '/api/observe/summary' || Object.keys(record(input.params)).length || Object.keys(record(input.body)).length) return fail('invalid_request')
  const fields = record(input.query)
  if (Object.keys(fields).some(key => !['limit', 'traceId', 'outcome'].includes(key))) return fail('invalid_request')
  let limit = 200
  if (fields.limit !== undefined) {
    if (typeof fields.limit !== 'string' || !/^[0-9]{1,3}$/u.test(fields.limit) || Number(fields.limit) < 1 || Number(fields.limit) > 200) return fail('invalid_request')
    limit = Number(fields.limit)
  }
  if (fields.traceId !== undefined && (typeof fields.traceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fields.traceId))) return fail('invalid_request')
  if (fields.outcome !== undefined && (typeof fields.outcome !== 'string' || !['started', 'succeeded', 'failed', 'unknown', 'cancelled'].includes(fields.outcome))) return fail('invalid_request')
  return { limit, ...(fields.traceId === undefined ? {} : { traceId: fields.traceId as string }), ...(fields.outcome === undefined ? {} : { outcome: fields.outcome as string }) }
}

/** The operational view reads the existing journal and grants no business or cross-conversation authority. */
export function createStandaloneAgentObserve(options: StandaloneAgentObserveOptions): AgentConsoleService {
  return Object.freeze({ operation: 'observe.read', method: 'GET', path: '/api/observe/summary', scope: 'global',
    async handle(request: AgentConsoleRequest, context: AgentConsoleContext) {
      const selected = query(request)
      if (context.binding) return fail('invalid_request')
      const captured = captureSynchronousGuardCheck(context, () => fail('conflict'))
      function baseEnsure(): void {
        if (context.signal.aborted || options.auth.isCurrent(context.principal) !== true) return fail('conflict')
        if (captured) captured()
        else ensureSynchronousGuard(context, () => fail('conflict'), 'current-first')
        if (context.signal.aborted || options.auth.isCurrent(context.principal) !== true) return fail('conflict')
      }
      baseEnsure()
      const rows = snapshot(options.bindings.list()), expected = JSON.stringify(rows.map(identity)), byOwner = new Map(rows.map(row => [owner(row), row]))
      function ensureCurrent(): void {
        baseEnsure()
        if (JSON.stringify(snapshot(options.bindings.list()).map(identity)) !== expected) return fail('conflict')
      }
      const guard = createSynchronousGuard(context.signal, ensureCurrent, () => fail('conflict'))
      type Decision = { operation: string; binding?: AgentBindingSnapshot; result: 'allowed' | 'denied' }
      const decisions: Decision[] = []
      async function authorize(operation: string, binding?: AgentBindingSnapshot, remember = true): Promise<'allowed' | 'denied'> {
        ensureCurrent()
        const selectedGuard: AgentConsoleGuard = binding ? createSynchronousGuard(context.signal, () => {
            ensureCurrent()
            const current = options.bindings.resolve(binding.target)
            if (!current || identity(copyBinding(current)) !== identity(binding)) return fail('conflict')
          }, () => fail('conflict')) : guard
        selectedGuard.ensureCurrent()
        let result: unknown
        try { result = await options.auth.authorize(context.principal, operation, binding, selectedGuard) }
        catch { selectedGuard.ensureCurrent(); return fail('unavailable') }
        selectedGuard.ensureCurrent()
        if (result !== 'allowed' && result !== 'denied') return fail('unavailable')
        if (remember) decisions.push({ operation, ...(binding ? { binding } : {}), result })
        return result
      }
      if (await authorize('observe.read') !== 'allowed') return fail('forbidden')
      const hostVisible = await authorize('observe.host') === 'allowed', accountsVisible = await authorize('connections.read') === 'allowed'
      ensureCurrent()
      let read: AgentJournalReadResult
      try { read = await options.read(guard, selected.traceId) } catch { ensureCurrent(); return fail('unavailable') }
      ensureCurrent()
      if (!Array.isArray(read.events) || read.events.length > 10000 || typeof read.truncated !== 'boolean') return fail('unavailable')
      const visible: (AgentDiagnosticEvent & { scopeKey?: string; bindingToken?: string; currentBinding?: boolean })[] = []
      const access = new Map<string, boolean>(), accounts = new Set(rows.map(row => platformAccountKey(row.target.account)))
      for (const input of read.events) {
        let event: AgentDiagnosticEvent
        try { event = parseAgentDiagnosticEvent(input) } catch { return fail('unavailable') }
        if (event.scope.kind === 'host') { if (hostVisible) visible.push(event); continue }
        if (event.scope.kind === 'account') { if (accountsVisible && accounts.has(platformAccountKey(event.scope.account))) visible.push(event); continue }
        const recorded = event.scope.binding, current = byOwner.get(owner(recorded))
        if (!current) continue
        const key = owner(current)
        if (!access.has(key)) {
          const bindingVisible = await authorize('bindings.read', current) === 'allowed'
          access.set(key, bindingVisible && await authorize('observe.read', current) === 'allowed')
          ensureCurrent()
        }
        if (!access.get(key)) continue
        const currentBinding = identity(current) === identity(recorded)
        visible.push(Object.freeze({ ...event, currentBinding,
          ...(currentBinding ? { scopeKey: agentConversationKey(current), bindingToken: agentBindingToken(current) } : {}),
        }))
      }
      for (const decision of decisions) {
        if (await authorize(decision.operation, decision.binding, false) !== decision.result) return fail('conflict')
      }
      ensureCurrent()
      const configuration = record(options.configState(context))
      const processEpoch = text(configuration.processEpoch, 256), loadedRevision = text(configuration.loadedRevision), storedRevision = text(configuration.storedRevision, 512, true)
      const phase = text(configuration.phase, 64)
      if (!['active', 'saving', 'restart-required', 'uncertain'].includes(phase) || typeof configuration.requiresRestart !== 'boolean') return fail('unavailable')
      const health = hostVisible ? options.health() : undefined
      const journal = health ? Object.freeze({ available: true as const,
        degraded: typeof health.degraded === 'boolean' ? health.degraded : fail('unavailable'), written: count(health.written), failed: count(health.failed),
        ...(health.lastWrittenAt === undefined ? {} : { lastWrittenAt: count(health.lastWrittenAt) }) }) : Object.freeze({ available: false as const })
      const filtered = visible.filter(event => (!selected.traceId || event.traceId === selected.traceId) && (!selected.outcome || event.outcome === selected.outcome))
      const events = Object.freeze(filtered.slice(0, selected.limit).map(event => ({ ...event, diagnosis: describeAgentDiagnostic(event) })))
      const observedAt = count((options.now ?? Date.now)())
      ensureCurrent()
      return { kind: 'json' as const, value: Object.freeze({ version: 1, mode: 'standalone', processEpoch, observedAt,
        configuration: Object.freeze({ loadedRevision, storedRevision, phase, requiresRestart: configuration.requiresRestart }), journal,
        scan: Object.freeze({ truncated: read.truncated || filtered.length > selected.limit, hostCountersVisible: hostVisible,
          invalidRecords: hostVisible ? count(read.invalidRecords) : 0, scannedEvents: hostVisible ? read.events.length : visible.length }), events,
        contextMetrics: aggregateContextMetrics(filtered),
      }) as unknown as AgentConsoleJson }
    },
  })
}
