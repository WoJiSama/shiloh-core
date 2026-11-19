import type { AgentBindingSnapshot, ConversationAddress } from '../contracts/agentBinding.js'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleCommittedResponse, AgentConsoleCommitPort, AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { CharacterActivityOperation } from '../contracts/characterActivities.js'
import type { TokenLedger } from '../modules/models/infrastructure/tokenLedger.js'
import { agentBindingToken, agentConversationKey, decodeAgentConversationKey, isConversationAddress } from '../modules/runtime/domain/agentBindings.js'
import { createSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'
import { decodeSimulationAddressKey } from '../modules/simulation/infrastructure/simulationAddress.js'
import { PERSON_MEMORY_CATEGORIES } from '../modules/memory/domain/personMemory.js'
import type { StandaloneAgentForgetOperations } from './standaloneAgentForgetOperations.js'

type Data = Record<string, unknown>
type Awaitable<T> = T | Promise<T>
type CharacterOperation = 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory'

/** These are guarded host adapters, not raw legacy runtime methods.
 * scopeKey is a complete agentConversationKey; adapters decode it and recheck context after internal awaits,
 * immediately before every durable write/native action. A raw runtime that ignores context is not sufficient. */
export interface StandaloneAgentConsoleRuntime {
  overview(context: AgentConsoleContext): Awaitable<Data>
  describeGroup(scopeKey: string, context: AgentConsoleContext): Awaitable<Data>
  enableGroup(scopeKey: string, context: AgentConsoleContext): Awaitable<string>
  disableGroup(scopeKey: string, context: AgentConsoleContext): Awaitable<string>
  resetGroup(scopeKey: string, context: AgentConsoleContext): Awaitable<string>
  setInitialPrompt(scopeKey: string, text: string, context: AgentConsoleContext): Awaitable<string>
  setGroupBudget(scopeKey: string, cap: number, context: AgentConsoleContext): Awaitable<string>
  setGroupTurnsCap(scopeKey: string, cap: number, context: AgentConsoleContext): Awaitable<string>
  setGroupReplyMode(scopeKey: string, mode: 'atOnly' | 'auto' | 'active', context: AgentConsoleContext): Awaitable<string>
  controlCharacter(scopeKey: string, operation: CharacterOperation, id: string | undefined, context: AgentConsoleContext): Awaitable<string>
  controlActivity(scopeKey: string, operation: CharacterActivityOperation, id: string | undefined, payload: Data | undefined, context: AgentConsoleContext): Awaitable<string>
  setDefaultBudget(cny: number, context: AgentConsoleContext): Awaitable<string>
  lifeOverview(context: AgentConsoleContext): Awaitable<Data>
  setLifeRhythm(from: number, to: number, context: AgentConsoleContext): Awaitable<string>
  getHealthAlerts(context: AgentConsoleContext): Awaitable<Data>
}

export interface StandaloneAgentConsoleConfigPort {
  /** Already projected schema views, including an opaque revision; never raw host config or environment values. */
  read(kind: string, context: AgentConsoleContext): Awaitable<Data>
  /** Must validate host-supported fields and CAS revision, preserving unedited secrets and unrelated YAML. */
  write(kind: string, payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data | AgentConsoleCommittedResponse>
}

export interface StandaloneAgentConsolePersonaPort {
  read(context: AgentConsoleContext): Awaitable<Data>
  /** Must CAS the returned revision and validate full agent/connection assignments; no bare-group reassignment. */
  write(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data | AgentConsoleCommittedResponse>
  accounts?(context: AgentConsoleContext): Awaitable<unknown>
}

export interface StandaloneAgentConsoleProviderPort {
  /** Masked provider fields and opaque revisions, using the current host's credentials privately. */
  read(context: AgentConsoleContext): Awaitable<Data>
  write(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data | AgentConsoleCommittedResponse>
  probe?(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data>
  probeProvider?(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data>
}

export interface StandaloneAgentConsoleAssignmentPort {
  read(context: AgentConsoleContext): Awaitable<Data>
  write(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data | AgentConsoleCommittedResponse>
}

export interface StandaloneAgentConsoleConfigurationPort {
  read(context: AgentConsoleContext): Awaitable<Data>
  preview(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data>
  commit(payload: Readonly<Data>, context: AgentConsoleContext): Awaitable<Data | AgentConsoleCommittedResponse>
}

export interface StandaloneAgentConsoleServicesPorts {
  readonly bindings: { list(): readonly AgentBindingSnapshot[]; resolve(target: ConversationAddress): AgentBindingSnapshot | undefined }
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly runtime?: Partial<StandaloneAgentConsoleRuntime>
  readonly ledger?: Pick<TokenLedger, 'summary' | 'series' | 'recent'>
  readonly config?: Partial<StandaloneAgentConsoleConfigPort>
  readonly persona?: Partial<StandaloneAgentConsolePersonaPort>
  readonly providers?: Partial<StandaloneAgentConsoleProviderPort>
  readonly assignments?: Partial<StandaloneAgentConsoleAssignmentPort>
  readonly configuration?: Partial<StandaloneAgentConsoleConfigurationPort>
  readonly configState?: (context: AgentConsoleContext) => Awaitable<Data>
  readonly commits?: Pick<AgentConsoleCommitPort, 'isCommitted' | 'verify'>
  readonly identities?: {
    read(context: AgentConsoleContext): Awaitable<Data>
    groups?(context: AgentConsoleContext): Awaitable<unknown>
  }
  readonly profiles?: {
    /** A real profile partition must identify its complete current binding. Unscoped global rows are not guessed. */
    list?(context: AgentConsoleContext): Awaitable<readonly { binding: AgentBindingSnapshot; profile: Data }[]>
    remove?(userId: string, context: AgentConsoleContext): Awaitable<boolean>
    removeField?(userId: string, field: string, value: string | undefined, context: AgentConsoleContext): Awaitable<unknown>
  }
  /** Durable, source-owned forget receipts. Existing mutation ports remain as a compatibility fallback. */
  readonly forgetting?: Partial<StandaloneAgentForgetOperations>
  readonly trusteeship?: {
    /** Commitment/delegated rows must include scopeKey (or binding/conversation), preserving their original IDs. */
    overview?(context: AgentConsoleContext): Awaitable<Data>
    cancelCommitment?(scopeKey: string, id: string, context: AgentConsoleContext): Awaitable<boolean>
    deleteDelegated?(scopeKey: string, id: string, context: AgentConsoleContext): Awaitable<boolean>
    clearFailLog?(context: AgentConsoleContext): Awaitable<boolean>
  }
  /** Additional real operations (accounts, images, games, observation, style, Qzone, etc.), under the same server checks. */
  readonly extra?: readonly AgentConsoleService[]
}

const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }
const schemas = new Set(['groupAdmin', 'dice', 'tracking', 'memory', 'conversation', 'reasoning', 'persona', 'pipeline', 'riskControl', 'turtleSoup', 'umaRace', 'deltaForce'])
const activityOperations = new Set(['work-archive', 'work-restore', 'work-delete', 'subscription-pause', 'subscription-resume', 'subscription-remove', 'shared-approve', 'shared-delete', 'reflection-reset'])
const characterOperations = new Set(['pause', 'resume', 'cancel-goal', 'pause-goal', 'resume-goal', 'delete-memory'])
function data(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_request')
  return value as Data
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || !empty && !value || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return fail('invalid_request')
  return value
}
function identifier(value: unknown, max = 256): string {
  const result = text(value, max)
  if (result.trim() !== result || /[\r\n\t]/u.test(result)) return fail('invalid_request')
  return result
}
function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) return fail('invalid_request')
  return value
}
function fields(body: Data, allowed: readonly string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('invalid_request')
}
function revision(body: Data): void { identifier(body.revision, 256) }
function queryNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/u.test(value)) return fail('invalid_request')
  return number(Number(value), min, max, true)
}
function json(value: unknown) { return { kind: 'json' as const, value: value as AgentConsoleJson } }
function snapshot(binding: AgentBindingSnapshot): AgentBindingSnapshot {
  return Object.freeze({ source: binding.source, id: binding.id, revision: binding.revision, agentId: binding.agentId, personaId: binding.personaId,
    connectionId: binding.connectionId, target: Object.freeze({ kind: binding.target.kind, id: binding.target.id,
      account: Object.freeze({ platform: binding.target.account.platform, namespace: binding.target.account.namespace, id: binding.target.account.id }) }) })
}

/** Maps the existing API shapes to real neutral host ports. Missing ports remain explicit 503 routes. */
export function createStandaloneAgentConsoleServices(ports: StandaloneAgentConsoleServicesPorts): readonly AgentConsoleService[] {
  const services = new Map<string, AgentConsoleService>()
  function install(operation: string, handle: NonNullable<AgentConsoleService['handle']>) {
    const definition = AGENT_CONSOLE_SERVICES.find(item => item.operation === operation)
    if (!definition || services.has(operation)) throw new Error('控制台服务映射重复或无效')
    services.set(operation, Object.freeze({ ...definition, handle }))
  }
  async function invoke<T>(context: AgentConsoleContext, operation: () => Awaitable<T>): Promise<T> {
    context.ensureCurrent()
    const result = await operation()
    context.ensureCurrent()
    return result
  }
  async function invokeWrite(context: AgentConsoleContext, operation: () => Awaitable<Data | AgentConsoleCommittedResponse>) {
    context.ensureCurrent()
    const result = await operation()
    if (ports.commits?.isCommitted(result)) {
      ports.commits.verify(result, context)
      return result
    }
    context.ensureCurrent()
    if ((result as { kind?: unknown }).kind === 'committed-json') return fail('conflict')
    return json(result)
  }
  function current(binding: AgentBindingSnapshot) {
    try {
      const live = ports.bindings.resolve(binding.target)
      return live?.source === 'configured' && agentBindingToken(live) === agentBindingToken(binding) && agentConversationKey(live) === agentConversationKey(binding)
    } catch { return false }
  }
  function scoped(context: AgentConsoleContext): { key: string; binding: AgentBindingSnapshot } {
    context.ensureCurrent()
    const binding = context.binding
    if (binding?.source !== 'configured' || !current(binding)) return fail('conflict')
    return { key: agentConversationKey(binding), binding }
  }
  function group(context: AgentConsoleContext): { key: string; binding: AgentBindingSnapshot } {
    const selected = scoped(context)
    if (selected.binding.target.kind !== 'group') return fail('invalid_request')
    return selected
  }
  function aliases(body: Data, selected: AgentBindingSnapshot) {
    for (const key of ['group', 'groupId']) {
      if (body[key] !== undefined && body[key] !== selected.target.id && body[key] !== agentConversationKey(selected)) return fail('conflict')
    }
  }
  function rowBinding(row: Data): AgentBindingSnapshot | undefined {
    const scopeKey = typeof row.scopeKey === 'string' ? row.scopeKey : typeof row.groupId === 'string' ? row.groupId : ''
    const scope = decodeAgentConversationKey(scopeKey)
    let target = scope?.target
    if (!target && row.binding) target = data(row.binding).target as ConversationAddress
    if (!target && isConversationAddress(row.conversation as ConversationAddress)) target = row.conversation as ConversationAddress
    if (!target && typeof row.groupId === 'string') target = decodeSimulationAddressKey(row.groupId) ?? undefined
    if (!target || !isConversationAddress(target)) return undefined
    const live = ports.bindings.resolve(target)
    if (live?.source !== 'configured' || scope && agentConversationKey(live) !== scopeKey) return undefined
    if (row.binding && agentBindingToken(data(row.binding) as unknown as AgentBindingSnapshot) !== agentBindingToken(live)) return undefined
    if (row.bindingToken !== undefined && row.bindingToken !== agentBindingToken(live)) return undefined
    return snapshot(live)
  }
  function metadata(binding: AgentBindingSnapshot) {
    return { groupId: agentConversationKey(binding), scopeKey: agentConversationKey(binding), bindingToken: agentBindingToken(binding),
      agentId: binding.agentId, account: binding.target.account, conversation: binding.target }
  }
  async function project(row: Data, operation: string, context: AgentConsoleContext): Promise<Data | undefined> {
    context.ensureCurrent()
    const binding = rowBinding(row)
    if (!binding) return undefined
    const guard = createSynchronousGuard(context.signal, () => {
      if (!context.isCurrent() || !current(binding)) fail('conflict')
    }, () => fail('conflict'))
    guard.ensureCurrent()
    const allowed = await ports.auth.authorize(context.principal, operation, binding, guard)
    guard.ensureCurrent()
    if (allowed === 'unavailable') return fail('unavailable')
    if (allowed !== 'allowed') return undefined
    return { ...row, ...metadata(binding), ...(row.binding ? { binding } : {}) }
  }
  async function projectRows(input: unknown, operation: string, context: AgentConsoleContext): Promise<Data[]> {
    if (!Array.isArray(input) || input.length > 10_000) return fail('unavailable')
    const output: Data[] = []
    for (const item of input) {
      const projected = await project(data(item), operation, context)
      context.ensureCurrent()
      if (projected) output.push(projected)
    }
    // Earlier rows can be rebound while later row authorization is pending.
    for (const row of output) if (!rowBinding(row)) return fail('conflict')
    return output
  }
  const runtime = ports.runtime
  if (runtime?.overview) install('simulation.read', async (_request, context) => {
    const view = await invoke(context, () => runtime.overview!(context))
    const groups = await projectRows(view.groups, 'simulation.group-read', context)
    context.ensureCurrent()
    return json({ ...view, groups, unscopedOrHiddenGroups: (view.groups as unknown[]).length - groups.length })
  })
  if (runtime?.describeGroup) install('simulation.group-read', async (request, context) => {
    const selected = group(context); aliases(request.query, selected.binding)
    const view = await invoke(context, () => runtime.describeGroup!(selected.key, context))
    return json({ ...view, ...metadata(selected.binding) })
  })
  const groupMutations = [runtime?.enableGroup, runtime?.disableGroup, runtime?.resetGroup, runtime?.setInitialPrompt,
    runtime?.setGroupBudget, runtime?.setGroupTurnsCap, runtime?.setGroupReplyMode, runtime?.controlCharacter, runtime?.controlActivity]
  if (runtime && groupMutations.some(Boolean)) install('simulation.group-write', async (request, context) => {
    const body = data(request.body), selected = group(context); aliases(body, selected.binding)
    const action = identifier(body.action, 64)
    let operation: (() => Awaitable<string>) | undefined, detail = false, forgettingDelete = false
    if (action === 'enable' || action === 'disable' || action === 'reset') {
      fields(body, ['group', 'groupId', 'action'])
      const method = action === 'enable' ? runtime.enableGroup : action === 'disable' ? runtime.disableGroup : runtime.resetGroup
      if (method) operation = () => method.call(runtime, selected.key, context)
      detail = true
    } else if (action === 'initial-prompt') {
      fields(body, ['group', 'groupId', 'action', 'text']); const value = text(body.text, 2000, true)
      if (runtime.setInitialPrompt) operation = () => runtime.setInitialPrompt!(selected.key, value, context)
    } else if (action === 'reply-mode') {
      fields(body, ['group', 'groupId', 'action', 'mode'])
      if (!['atOnly', 'auto', 'active'].includes(String(body.mode))) return fail('invalid_request')
      if (runtime.setGroupReplyMode) operation = () => runtime.setGroupReplyMode!(selected.key, body.mode as 'atOnly' | 'auto' | 'active', context)
    } else if (action === 'budget' || action === 'turns') {
      fields(body, ['group', 'groupId', 'action', 'cap']); const cap = number(body.cap, -1, 10_000, action === 'turns')
      if (cap < 0 && cap !== -1) return fail('invalid_request')
      const method = action === 'budget' ? runtime.setGroupBudget : runtime.setGroupTurnsCap
      if (method) operation = () => method.call(runtime, selected.key, cap, context)
    } else if (action === 'character' || action === 'activity') {
      fields(body, ['group', 'groupId', 'action', 'operation', 'id', 'requestId', ...(action === 'activity' ? ['payload'] : [])])
      const value = identifier(body.operation, 64)
      if (action === 'character' ? !characterOperations.has(value) : !activityOperations.has(value)) return fail('invalid_request')
      const needsId = action === 'character' ? value !== 'pause' && value !== 'resume' : value !== 'reflection-reset'
      const id = needsId ? identifier(body.id, 200) : undefined
      if (!needsId && body.id !== undefined) return fail('invalid_request')
      let payload: Data | undefined
      if (action === 'activity' && value === 'work-restore') {
        payload = data(body.payload); fields(payload, ['revision']); number(payload.revision, 1, Number.MAX_SAFE_INTEGER, true)
      } else if (body.payload !== undefined) return fail('invalid_request')
      if (action === 'character' && runtime.controlCharacter) operation = () => runtime.controlCharacter!(selected.key, value as CharacterOperation, id, context)
      if (action === 'character' && value === 'delete-memory' && id && ports.forgetting?.character) {
        forgettingDelete = true
        operation = async () => {
          const result = await ports.forgetting!.character!({ scopeKey: selected.key, memoryId: id, ...(body.requestId === undefined ? {} : { requestId: identifier(body.requestId, 256) }) }, context)
          return JSON.stringify(result)
        }
      }
      if (action === 'activity' && runtime.controlActivity) operation = () => runtime.controlActivity!(selected.key, value as CharacterActivityOperation, id, payload, context)
    } else return fail('invalid_request')
    if (!operation) return fail('unavailable')
    const result = await invoke(context, operation)
    if (forgettingDelete) {
      try { return json(JSON.parse(result)) } catch { return fail('unavailable') }
    }
    return json(detail ? { ok: true, detail: result } : { ok: true, message: result })
  })
  if (runtime?.setDefaultBudget) install('simulation.budget-default', async (request, context) => {
    const body = data(request.body); fields(body, ['cny']); const cny = number(body.cny, 0, 10_000)
    return json({ ok: true, message: await invoke(context, () => runtime.setDefaultBudget!(cny, context)) })
  })
  if (runtime?.lifeOverview) install('life.read', async (_request, context) => {
    const view = await invoke(context, () => runtime.lifeOverview!(context))
    const threads = await projectRows(view.threads, 'simulation.group-read', context)
    context.ensureCurrent(); return json({ ...view, threads })
  })
  if (runtime?.setLifeRhythm) install('life.rhythm', async (request, context) => {
    const body = data(request.body); fields(body, ['sleepFrom', 'sleepTo'])
    const from = number(body.sleepFrom, 0, 23, true), to = number(body.sleepTo, 1, 24, true)
    if (to <= from) return fail('invalid_request')
    return json({ ok: true, message: await invoke(context, () => runtime.setLifeRhythm!(from, to, context)) })
  })
  if (runtime?.getHealthAlerts) install('health.read', async (_request, context) => json(await invoke(context, () => runtime.getHealthAlerts!(context))))
  const ledger = ports.ledger
  if (ledger) {
    install('tokens.summary', async (_request, context) => json(await invoke(context, () => ledger.summary())))
    install('tokens.series', async (request, context) => {
      const hours = queryNumber(request.query.hours, 24, 1, 720)
      return json({ hours, buckets: await invoke(context, () => ledger.series(hours)) })
    })
    install('tokens.recent', async (request, context) => json({ rows: await invoke(context, () => ledger.recent(queryNumber(request.query.limit, 50, 1, 500))) }))
  }
  const config = ports.config
  if (config?.read) install('config.read', async (request, context) => {
    const kind = request.params.kind!
    if (!schemas.has(kind)) return fail('not_found')
    return json(await invoke(context, () => config.read!(kind, context)))
  })
  if (config?.write) install('config.write', async (request, context) => {
    const kind = request.params.kind!, body = data(request.body)
    if (!schemas.has(kind)) return fail('not_found')
    fields(body, ['revision', 'values', 'secrets']); revision(body)
    if (body.values !== undefined) data(body.values)
    if (body.secrets !== undefined) data(body.secrets)
    return invokeWrite(context, () => config.write!(kind, body, context))
  })
  const persona = ports.persona
  if (persona?.read) install('persona.read', async (_request, context) => json(await invoke(context, () => persona.read!(context))))
  if (persona?.write) install('persona.write', async (request, context) => {
    const body = data(request.body); fields(body, ['revision', 'personas', 'groupBindings', 'accountBindings', 'privateBinding', 'bindings']); revision(body)
    return invokeWrite(context, () => persona.write!(body, context))
  })
  if (persona?.accounts) install('persona-accounts.read', async (_request, context) => json({ accounts: await invoke(context, () => persona.accounts!(context)) }))
  const providers = ports.providers
  if (providers?.read) install('providers.read', async (_request, context) => json(await invoke(context, () => providers.read!(context))))
  for (const [operation, method] of [['providers.write', providers?.write], ['providers.probe', providers?.probe], ['providers.probe-provider', providers?.probeProvider]] as const) {
    if (!method) continue
    install(operation, async (request, context) => {
      const body = data(request.body)
      if (operation === 'providers.write') { fields(body, ['revision', 'configKey', 'providers']); revision(body) }
      else fields(body, ['configKey', 'provider'])
      identifier(body.configKey, 128)
      if (operation === 'providers.write') return invokeWrite(context, () => method.call(providers, body, context))
      return json(await invoke(context, () => method.call(providers, body, context)))
    })
  }
  const configuration = ports.configuration
  if (configuration?.read) install('configuration.read', async (_request, context) => json(await invoke(context, () => configuration.read!(context))))
  if (configuration?.preview) install('configuration.preview', async (request, context) => {
    const body = data(request.body); fields(body, ['revision', 'change']); revision(body); data(body.change)
    return json(await invoke(context, () => configuration.preview!(body, context)))
  })
  if (configuration?.commit) install('configuration.commit', async (request, context) => {
    const body = data(request.body); fields(body, ['previewId', 'revision', 'candidateDigest', 'readSet']); revision(body)
    identifier(body.previewId, 128); identifier(body.candidateDigest, 128)
    const readSet = data(body.readSet); fields(readSet, ['host', 'personas', 'bindings'])
    for (const key of ['host', 'personas', 'bindings']) identifier(readSet[key], 256)
    // A previously issued preview does not preserve revoked preview permission.
    const decision = await ports.auth.authorize(context.principal, 'configuration.preview', undefined, context)
    context.ensureCurrent()
    if (decision === 'unavailable') return fail('unavailable')
    if (decision !== 'allowed') return fail('forbidden')
    return invokeWrite(context, () => configuration.commit!(body, context))
  })
  if (ports.configState) install('config-state.read', async (_request, context) => json(await invoke(context, () => ports.configState!(context))))
  if (ports.assignments?.read) install('persona-assignments.read', async (_request, context) => json(await invoke(context, () => ports.assignments!.read!(context))))
  if (ports.assignments?.write) install('persona-assignments.write', async (request, context) => {
    const body = data(request.body); fields(body, ['revision', 'agents']); revision(body)
    return invokeWrite(context, () => ports.assignments!.write!(body, context))
  })
  if (ports.identities) {
    const identities = ports.identities
    install('identities.read', async (_request, context) => json(await invoke(context, () => identities.read(context))))
    if (identities.groups) install('groups.read', async (_request, context) => json({ groups: await invoke(context, () => identities.groups!(context)) }))
  }
  const profiles = ports.profiles
  if (profiles?.list) install('profiles.read', async (_request, context) => {
    const rows = await invoke(context, () => profiles.list!(context))
    if (!Array.isArray(rows) || rows.length > 10_000) return fail('unavailable')
    const output: Data[] = []
    for (const row of rows) {
      const projected = await project({ ...row.profile, binding: row.binding }, 'profiles.read', context)
      context.ensureCurrent()
      if (projected) output.push(projected)
    }
    for (const row of output) if (!rowBinding(row)) return fail('conflict')
    return json({ profiles: output })
  })
  for (const operation of ['profiles.delete', 'profiles.delete-field'] as const) {
    if (operation === 'profiles.delete' ? !profiles?.remove : !profiles?.removeField) continue
    install(operation, async (request, context) => {
      scoped(context); const body = data(request.body)
      fields(body, operation === 'profiles.delete' ? ['userId', 'requestId'] : ['userId', 'field', 'value', 'requestId'])
      const userId = identifier(body.userId, 128)
      const requestId = body.requestId === undefined ? undefined : identifier(body.requestId, 256)
      if (ports.forgetting?.profile) {
        if (operation === 'profiles.delete') return json(await invoke(context, () => ports.forgetting!.profile!({ userId, ...(requestId ? { requestId } : {}) }, context)))
        const field = identifier(body.field, 32)
        if (!['entries', 'interests', 'taboos', 'traits', 'facts', ...PERSON_MEMORY_CATEGORIES].includes(field)) return fail('invalid_request')
        const value = body.value === undefined ? undefined : text(body.value, 4000)
        if (field === 'entries' && value === undefined) return fail('invalid_request')
        return json(await invoke(context, () => ports.forgetting!.profile!({ userId, field, ...(value === undefined ? {} : { value }), ...(requestId ? { requestId } : {}) }, context)))
      }
      if (operation === 'profiles.delete') {
        const removed = await invoke(context, () => profiles!.remove!(userId, context))
        if (!removed) return fail('not_found')
        return json({ ok: true, message: '已删除当前来源会话的人物记忆' })
      }
      const field = identifier(body.field, 32)
      if (!['entries', 'interests', 'taboos', 'traits', 'facts', ...PERSON_MEMORY_CATEGORIES].includes(field)) return fail('invalid_request')
      const value = body.value === undefined ? undefined : text(body.value, 4000)
      if (field === 'entries' && value === undefined) return fail('invalid_request')
      return json({ ok: true, profile: await invoke(context, () => profiles!.removeField!(userId, field, value, context)) })
    })
  }
  if (ports.forgetting?.read) install('forgetting.read', async (request, context) => {
    const selected = scoped(context), operationId = identifier(request.params.operationId, 128)
    return json(await invoke(context, () => ports.forgetting!.read!(operationId, { ...context, binding: selected.binding })))
  })
  const trusteeship = ports.trusteeship
  if (trusteeship?.overview) install('trusteeship.read', async (_request, context) => {
    const view = await invoke(context, () => trusteeship.overview!(context))
    const commitments = await projectRows(view.commitments, 'trusteeship.read', context)
    context.ensureCurrent()
    const delegated = await projectRows(view.delegated, 'trusteeship.read', context)
    context.ensureCurrent()
    const failures = await projectRows(view.failures, 'trusteeship.read', context)
    context.ensureCurrent()
    for (const row of [...commitments, ...delegated, ...failures]) if (!rowBinding(row)) return fail('conflict')
    return json({ ...view, commitments, delegated, failures })
  })
  for (const [operation, method] of [['commitments.cancel', trusteeship?.cancelCommitment], ['delegated.delete', trusteeship?.deleteDelegated]] as const) {
    if (!method) continue
    install(operation, async (request, context) => {
      const selected = scoped(context), body = data(request.body); aliases(body, selected.binding)
      fields(body, ['id', 'group', 'groupId']); const id = identifier(body.id)
      const changed = await invoke(context, () => method.call(trusteeship, selected.key, id, context))
      if (!changed) return fail('not_found')
      return json({ ok: true, message: operation === 'commitments.cancel' ? '已取消承诺' : '已删除托付记忆' })
    })
  }
  if (trusteeship?.clearFailLog) install('commitments.clear-failures', async (_request, context) => {
    if (!await invoke(context, () => trusteeship.clearFailLog!(context))) return fail('unavailable')
    return json({ ok: true, message: '已清空失败记录' })
  })
  for (const service of ports.extra ?? []) {
    if (services.has(service.operation)) throw new Error('控制台真实服务重复装配')
    services.set(service.operation, Object.freeze({ ...service }))
  }
  return Object.freeze([...services.values()])
}
