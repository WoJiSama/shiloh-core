import type { AgentBindingSnapshot, ConversationAddress } from '../contracts/agentBinding.js'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext } from '../contracts/agentConsole.js'
import { agentBindingToken, agentConversationKey, decodeAgentConversationKey } from '../modules/runtime/domain/agentBindings.js'
import { simulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import type { SimulationRuntime } from '../modules/simulation/infrastructure/simulationRuntime.js'
import { SimulationAdministrationConflictError, type SimulationAdministrationGuard } from '../modules/simulation/infrastructure/simulationAdministration.js'
import type { StandaloneAgentConsoleRuntime } from './standaloneAgentConsoleServices.js'

type Data = Record<string, unknown>
export interface StandaloneAgentConsoleRuntimePorts {
  readonly runtime: SimulationRuntime
  readonly bindings: { list(): readonly AgentBindingSnapshot[]; resolve(target: ConversationAddress): AgentBindingSnapshot | undefined }
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize' | 'isCurrent'>
}
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }
function copy(binding: AgentBindingSnapshot): AgentBindingSnapshot {
  return Object.freeze({ source: binding.source, id: binding.id, revision: binding.revision, agentId: binding.agentId,
    personaId: binding.personaId, connectionId: binding.connectionId, target: Object.freeze({ kind: binding.target.kind,
      id: binding.target.id, account: Object.freeze({ ...binding.target.account }) }) })
}

/** Real simulation management, with a lease at each Redis commit and complete address conversion. */
export function createStandaloneAgentConsoleRuntime(ports: StandaloneAgentConsoleRuntimePorts): StandaloneAgentConsoleRuntime {
  if (typeof ports.runtime.runAdministration !== 'function') throw new TypeError('simulation administration is required')
  function current(binding: AgentBindingSnapshot): boolean {
    try {
      const live = ports.bindings.resolve(binding.target)
      return live?.source === 'configured' && agentBindingToken(live) === agentBindingToken(binding) && agentConversationKey(live) === agentConversationKey(binding)
    } catch { return false }
  }
  function groups(): readonly AgentBindingSnapshot[] {
    const entries = ports.bindings.list()
    if (entries.length > 10_000) return fail('unavailable')
    const result = entries.filter(item => item.source === 'configured' && item.target.kind === 'group').map(copy)
    if (new Set(result.map(item => simulationAddressKey(item.target))).size !== result.length) return fail('conflict')
    if (result.some(item => !current(item))) return fail('conflict')
    return result
  }
  const directoryToken = (entries: readonly AgentBindingSnapshot[]) => JSON.stringify(entries.map(item => JSON.stringify([agentConversationKey(item), agentBindingToken(item)])).sort())
  function guard(context: AgentConsoleContext, operation: string, selected?: AgentBindingSnapshot, directory?: readonly AgentBindingSnapshot[]) {
    const expectedDirectory = directory && directoryToken(directory)
    const isCurrent = () => {
      try {
        return !context.signal.aborted && context.isCurrent() && ports.auth.isCurrent(context.principal) &&
          (!context.binding || current(context.binding)) && (!selected || current(selected)) &&
          (expectedDirectory === undefined || directoryToken(groups()) === expectedDirectory)
      } catch { return false }
    }
    const ensureCurrent = () => { context.ensureCurrent(); if (!isCurrent()) fail('conflict') }
    const lease: SimulationAdministrationGuard = { signal: context.signal, isCurrent, ensureCurrent }
    async function authorize(): Promise<'allowed' | 'denied'> {
      ensureCurrent()
      const decision = await ports.auth.authorize(context.principal, operation, selected, lease)
      ensureCurrent()
      if (decision === 'unavailable') return fail('unavailable')
      return decision === 'allowed' ? 'allowed' : 'denied'
    }
    lease.beforeWrite = async () => { if (await authorize() !== 'allowed') fail('forbidden') }
    return { lease, authorize }
  }
  async function execute<T>(context: AgentConsoleContext, operation: string, action: () => Promise<T>, selected?: AgentBindingSnapshot,
    directory?: readonly AgentBindingSnapshot[]): Promise<T> {
    const { lease, authorize } = guard(context, operation, selected, directory)
    lease.ensureCurrent()
    try {
      return await ports.runtime.runAdministration(lease, async () => {
        // Runs after the administration queue, before in-memory management effects.
        if (await authorize() !== 'allowed') return fail('forbidden')
        lease.ensureCurrent()
        const result = await action()
        lease.ensureCurrent()
        return result
      })
    } catch (error) {
      if (error instanceof SimulationAdministrationConflictError) return fail('conflict')
      throw error
    }
  }
  function select(scopeKey: string, context: AgentConsoleContext): AgentBindingSnapshot {
    context.ensureCurrent()
    const selected = context.binding
    if (!decodeAgentConversationKey(scopeKey) || selected?.source !== 'configured' || agentConversationKey(selected) !== scopeKey || !current(selected)) return fail('conflict')
    if (selected.target.kind !== 'group') return fail('invalid_request')
    return copy(selected)
  }
  async function scoped<T>(scopeKey: string, context: AgentConsoleContext, operation: string, action: (key: string) => Promise<T>): Promise<T> {
    const selected = select(scopeKey, context)
    return execute(context, operation, () => action(simulationAddressKey(selected.target)), selected)
  }
  async function visible(context: AgentConsoleContext, entries: readonly AgentBindingSnapshot[]): Promise<AgentBindingSnapshot[]> {
    const result: AgentBindingSnapshot[] = []
    for (const selected of entries) {
      const { lease, authorize } = guard(context, 'simulation.group-read', selected, entries)
      if (await authorize() === 'allowed') result.push(selected)
      lease.ensureCurrent()
    }
    return result
  }
  const metadata = (selected: AgentBindingSnapshot) => ({ groupId: agentConversationKey(selected), scopeKey: agentConversationKey(selected),
    bindingToken: agentBindingToken(selected), binding: selected, conversation: selected.target, agentId: selected.agentId, account: selected.target.account })
  const groupContext = (context: AgentConsoleContext, selected: AgentBindingSnapshot): AgentConsoleContext => ({ ...context, binding: selected })
  const runtime = ports.runtime
  return Object.freeze({
    async overview(context) {
      const entries = groups()
      // Raw overview normally prunes group state. Get metadata only, then authorize actual group reads first.
      const view = await execute(context, 'simulation.read', () => runtime.overview([]), undefined, entries)
      const allowed = await visible(context, entries), rows: Data[] = []
      for (const selected of allowed) {
        const result = await scoped(agentConversationKey(selected), groupContext(context, selected), 'simulation.group-read', key => runtime.describeGroup(key))
        rows.push({ ...result, ...metadata(selected) })
      }
      guard(context, 'simulation.read', undefined, entries).lease.ensureCurrent()
      const names = new Map(allowed.map(item => [simulationAddressKey(item.target), agentConversationKey(item)]))
      const list = (input: unknown) => Array.isArray(input) ? input.filter((key): key is string => typeof key === 'string' && names.has(key)).map(key => names.get(key)!) : []
      const caps = view.budgetGroupsCny && typeof view.budgetGroupsCny === 'object' ? Object.fromEntries(Object.entries(view.budgetGroupsCny).filter(([key]) => names.has(key)).map(([key, value]) => [names.get(key)!, value])) : {}
      return { ...view, disabled: list(view.disabled), explicitEnabled: list(view.explicitEnabled), budgetGroupsCny: caps, groups: rows }
    },
    describeGroup: (scopeKey, context) => scoped(scopeKey, context, 'simulation.group-read', key => runtime.describeGroup(key)),
    enableGroup: (scopeKey, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.enableGroup(key)),
    disableGroup: (scopeKey, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.disableGroup(key)),
    resetGroup: (scopeKey, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.resetGroup(key)),
    setInitialPrompt: (scopeKey, text, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.setInitialPrompt(key, text)),
    setGroupBudget: (scopeKey, cap, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.setGroupBudget(key, cap)),
    setGroupTurnsCap: (scopeKey, cap, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.setGroupTurnsCap(key, cap)),
    setGroupReplyMode: (scopeKey, mode, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.setGroupReplyMode(key, mode)),
    controlCharacter: (scopeKey, operation, id, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.controlCharacter(key, operation, id)),
    controlActivity: (scopeKey, operation, id, payload, context) => scoped(scopeKey, context, 'simulation.group-write', key => runtime.controlActivity(key, operation, id, payload)),
    setDefaultBudget: (cny, context) => execute(context, 'simulation.budget-default', () => runtime.setDefaultBudget(cny)),
    async lifeOverview(context) {
      const entries = groups(), allowed = await visible(context, entries), byKey = new Map(allowed.map(item => [simulationAddressKey(item.target), item]))
      const view = await execute(context, 'life.read', () => runtime.lifeOverview([...byKey.keys()]), undefined, entries)
      const threads = (view.threads as Data[]).map(row => {
        const selected = typeof row.groupId === 'string' && byKey.get(row.groupId)
        if (!selected) return fail('conflict')
        return { ...row, ...metadata(selected) }
      })
      guard(context, 'life.read', undefined, entries).lease.ensureCurrent()
      return { ...view, threads }
    },
    setLifeRhythm(from, to, context) {
      const entries = groups()
      return execute(context, 'life.rhythm', () => runtime.setLifeRhythm(from, to, entries.map(item => simulationAddressKey(item.target))), undefined, entries)
    },
    getHealthAlerts: context => execute(context, 'health.read', () => runtime.getHealthAlerts()),
  } satisfies StandaloneAgentConsoleRuntime)
}
