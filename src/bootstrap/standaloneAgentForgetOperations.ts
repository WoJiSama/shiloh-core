import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import { AgentConsoleError, type AgentConsoleContext, type AgentConsoleAuthPort } from '../contracts/agentConsole.js'
import { ForgetOperationConflictError, type ForgetImpact, type ForgetOperationGuard, type ForgetOperationKind, type ForgetOperationReceipt, type ForgetOperationStore } from '../contracts/forgetOperation.js'
import { agentBindingToken, agentConversationKey } from '../modules/runtime/domain/agentBindings.js'

type Data = Record<string, unknown>
type Awaitable<T> = T | Promise<T>

interface ProfilePort {
  list(context: AgentConsoleContext): Awaitable<readonly { binding: AgentBindingSnapshot; profile: Data }[]>
  remove(userId: string, context: AgentConsoleContext): Awaitable<boolean>
  removeField(userId: string, field: string, value: string | undefined, context: AgentConsoleContext): Awaitable<unknown>
}
interface CharacterPort {
  describeGroup(scopeKey: string, context: AgentConsoleContext): Awaitable<Data>
  controlCharacter(scopeKey: string, operation: 'delete-memory', id: string, context: AgentConsoleContext): Awaitable<string | Data>
}
export interface StandaloneAgentForgetOperations {
  read(operationId: string, context: AgentConsoleContext): Promise<Data>
  profile(input: { userId: string; field?: string; value?: string; requestId?: string }, context: AgentConsoleContext): Promise<Data>
  character(input: { scopeKey: string; memoryId: string; requestId?: string }, context: AgentConsoleContext): Promise<Data>
}

function fail(code: ConstructorParameters<typeof AgentConsoleError>[0]): never { throw new AgentConsoleError(code) }
function copyBinding(binding: AgentBindingSnapshot): AgentBindingSnapshot {
  return Object.freeze({ source: binding.source, id: binding.id, revision: binding.revision, agentId: binding.agentId,
    personaId: binding.personaId, connectionId: binding.connectionId, target: Object.freeze({ ...binding.target,
      account: Object.freeze({ ...binding.target.account }) }) })
}
function token(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_request')
  return value
}
function requestToken(value: string | undefined): string {
  const selected = token(value ?? randomUUID())
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(selected)) fail('invalid_request')
  return selected
}
function sameBinding(left: AgentBindingSnapshot, right: AgentBindingSnapshot): boolean {
  return agentConversationKey(left) === agentConversationKey(right) && agentBindingToken(left) === agentBindingToken(right)
}
function entries(profile: Data): readonly Data[] {
  return records(profile.entries)
}
function records(value: unknown): readonly Data[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return fail('unavailable')
  return value as Data[]
}
function id(value: Data): string { return token(value.id, 512) }
function impact(kind: ForgetImpact['kind'], key: string, partition: string, state: ForgetImpact['state'] = 'completed'): ForgetImpact {
  return { kind, id: token(key, 512), partition: token(partition, 8192), state }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function hasPrunedMemoryVersion(before: Data, after: Data, removedMemoryRefs: ReadonlySet<string>): boolean {
  if (!Number.isSafeInteger(before.revision) || !Number.isSafeInteger(after.revision) || Number(after.revision) <= Number(before.revision) ||
      !Array.isArray(before.versions) || !Array.isArray(after.versions) || !after.versions.length) return false
  const previous = records(before.versions), remaining = records(after.versions)
  const valid = (item: Data, maximum: unknown) => Number.isSafeInteger(item.revision) && Number(item.revision) >= 1 && Number(item.revision) <= Number(maximum)
  if (previous.some(item => !valid(item, before.revision)) || remaining.some(item => !valid(item, after.revision)) ||
      new Set(previous.map(item => item.revision)).size !== previous.length || new Set(remaining.map(item => item.revision)).size !== remaining.length) return false
  const retained = new Set(remaining.map(item => item.revision))
  return previous.some(item => !retained.has(item.revision) && Array.isArray(item.evidenceRefs) && item.evidenceRefs.some(ref => typeof ref === 'string' && removedMemoryRefs.has(ref)))
}

/** Records safe references around the existing source owners; it never replays an accepted mutation. */
export function createStandaloneAgentForgetOperations(options: {
  readonly store: ForgetOperationStore
  readonly bindings: { resolve(target: AgentBindingSnapshot['target']): AgentBindingSnapshot | undefined }
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize'>
  readonly profiles: ProfilePort
  readonly characters: CharacterPort
}): StandaloneAgentForgetOperations {
  const active = new Set<string>()
  async function owned<T>(action: (operationId: string) => Promise<T>): Promise<T> {
    const operationId = randomUUID()
    active.add(operationId)
    try { return await action(operationId) }
    finally { active.delete(operationId) }
  }
  async function settle(receipt: ForgetOperationReceipt, lease: ForgetOperationGuard): Promise<ForgetOperationReceipt> {
    if (['accepted', 'committed', 'settling'].includes(receipt.phase) && !active.has(receipt.operationId))
      return options.store.fail(receipt.operationId, { state: 'unknown', errorCode: 'HOST_OPERATION_INTERRUPTED' }, lease)
    return receipt
  }
  function current(context: AgentConsoleContext, expected?: AgentBindingSnapshot): AgentBindingSnapshot {
    context.ensureCurrent()
    const binding = context.binding
    if (!binding || binding.source !== 'configured' || context.signal.aborted || !context.isCurrent() || expected && !sameBinding(binding, expected)) return fail('conflict')
    const live = options.bindings.resolve(binding.target)
    context.ensureCurrent()
    if (!live || !sameBinding(live, binding) || context.signal.aborted || !context.isCurrent()) return fail('conflict')
    return copyBinding(binding)
  }
  async function authorize(context: AgentConsoleContext, operation: string, binding: AgentBindingSnapshot): Promise<void> {
    current(context, binding)
    const decision = await options.auth.authorize(context.principal, operation, binding, context)
    current(context, binding)
    if (decision === 'unavailable') fail('unavailable')
    if (decision !== 'allowed') fail('forbidden')
  }
  function guard(context: AgentConsoleContext, operation: string, binding: AgentBindingSnapshot): ForgetOperationGuard {
    return { ensureCurrent() { current(context, binding) }, beforeAccess: () => authorize(context, operation, binding) }
  }
  async function checked<T>(context: AgentConsoleContext, operation: string, binding: AgentBindingSnapshot, action: () => Awaitable<T>): Promise<T> {
    await authorize(context, operation, binding)
    const result = await action()
    await authorize(context, operation, binding)
    return result
  }
  async function existing(requestId: string, binding: AgentBindingSnapshot, kind: ForgetOperationKind, requestDigest: string,
    context: AgentConsoleContext, operation: string): Promise<ForgetOperationReceipt | undefined> {
    const previous = await checked(context, operation, binding, () => options.store.readByRequestId(requestId, guard(context, operation, binding)))
    if (previous && (!sameBinding(previous.binding, binding) || previous.kind !== kind || previous.requestDigest !== requestDigest)) fail('conflict')
    return previous && settle(previous, guard(context, operation, binding))
  }
  async function begin(input: Parameters<ForgetOperationStore['begin']>[0], lease: ForgetOperationGuard): Promise<ForgetOperationReceipt> {
    try { return await options.store.begin(input, lease) }
    catch (error) { if (error instanceof ForgetOperationConflictError) fail('conflict'); throw error }
  }
  async function finish(operationId: string, impacts: readonly ForgetImpact[], lease: ForgetOperationGuard): Promise<ForgetOperationReceipt> {
    await options.store.markCommitted(operationId, { impacts }, lease)
    // Existing source owners do not expose a durable proof for every downstream partition.
    return options.store.update(operationId, { phase: 'completed', usage: 'blocked', cleanup: 'unsupported', impacts }, lease)
  }
  async function failed(operationId: string, error: unknown, lease: ForgetOperationGuard): Promise<void> {
    try { await options.store.fail(operationId, { state: 'unknown', errorCode: error instanceof AgentConsoleError ? error.code.toUpperCase() : 'SOURCE_OUTCOME_UNKNOWN' }, lease) }
    catch { /* Revoked requests cannot write a receipt; accepted remains visibly unsettled. */ }
  }
  return {
    async read(operationId, context) {
      const binding = current(context), idValue = token(operationId, 128)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idValue)) fail('invalid_request')
      const receipt = await checked(context, 'forgetting.read', binding, () => options.store.read(idValue, guard(context, 'forgetting.read', binding)))
      if (!receipt) fail('not_found')
      if (!sameBinding(receipt.binding, binding)) fail('conflict')
      return await settle(receipt, guard(context, 'forgetting.read', binding)) as unknown as Data
    },
    async profile(input, context) {
      return owned(async operationId => {
        const binding = current(context), userId = token(input.userId, 128), field = input.field, operationName = field === undefined ? 'profiles.delete' : 'profiles.delete-field'
        const requestId = requestToken(input.requestId), kind = field === undefined ? 'person-profile' : 'person-entry'
        const requestDigest = digest([kind, userId, field ?? null, input.value ?? null])
        const lease = guard(context, operationName, binding), previous = await existing(requestId, binding, kind, requestDigest, context, operationName)
        if (previous) return previous as unknown as Data
        const rows = await checked(context, 'profiles.read', binding, () => options.profiles.list(context))
        const row = rows.find(item => sameBinding(item.binding, binding) && item.profile.userId === userId)
        if (!row) fail('not_found')
        const all = entries(row.profile)
        let selected = all
        if (field !== undefined) {
          if (field === 'entries') selected = all.filter(item => id(item) === input.value)
          else {
            const category = ({ interests: 'interest', facts: 'fact' } as Record<string, string>)[field] ?? field
            selected = all.filter(item => item.category === category && (input.value === undefined || id(item) === input.value || item.text === input.value))
          }
        }
        if (!selected.length) fail('not_found')
        const receipt = await begin({ operationId, requestId, requestDigest, kind, binding,
          subject: { userId, ...(selected.length === 1 ? { entryId: id(selected[0]!) } : {}) }, sourceRevision: binding.revision }, lease)
        await authorize(context, operationName, binding)
        if (receipt.operationId !== operationId) return receipt as unknown as Data
        try {
          let profileResult: unknown
          if (field === undefined) {
            if (!await checked(context, operationName, binding, () => options.profiles.remove(userId, context))) fail('not_found')
          } else profileResult = await checked(context, operationName, binding, () => options.profiles.removeField(userId, field, input.value, context))
          const after = await checked(context, 'profiles.read', binding, () => options.profiles.list(context))
          const remaining = after.find(item => sameBinding(item.binding, binding) && item.profile.userId === userId)
          const liveIds = new Set(remaining ? entries(remaining.profile).map(id) : [])
          if (selected.some(item => liveIds.has(id(item)))) fail('unavailable')
          const partition = `person-memory:${agentConversationKey(binding)}`
          const impacts = [...selected.map(item => impact('person-memory-entry', id(item), partition)), impact('partition', 'source-consumers', partition, 'unsupported')]
          const result = await checked(context, operationName, binding, () => finish(operationId, impacts, lease))
          return { ok: true, message: '来源删除已确认；其他存储的完整清理证明暂不支持', ...(field === undefined ? {} : { profile: profileResult }), ...result } as unknown as Data
        } catch (error) { await failed(operationId, error, lease); throw error }
      })
    },
    async character(input, context) {
      return owned(async operationId => {
        const binding = current(context), scopeKey = token(input.scopeKey, 4096), memoryId = token(input.memoryId, 512), operationName = 'simulation.group-write'
        if (binding.target.kind !== 'group' || agentConversationKey(binding) !== scopeKey) fail('conflict')
        const requestId = requestToken(input.requestId), requestDigest = digest(['character-memory', scopeKey, memoryId]), lease = guard(context, operationName, binding)
        const previous = await existing(requestId, binding, 'character-memory', requestDigest, context, operationName)
        if (previous) return previous as unknown as Data
        const before = await checked(context, 'simulation.group-read', binding, () => options.characters.describeGroup(scopeKey, context)), character = before.character as Data | undefined
        if (!character || !records(character.memories).some(item => id(item) === memoryId)) fail('not_found')
        const receipt = await begin({ operationId, requestId, requestDigest, kind: 'character-memory', binding,
          subject: { groupId: scopeKey, memoryId }, sourceRevision: binding.revision }, lease)
        await authorize(context, operationName, binding)
        if (receipt.operationId !== operationId) return receipt as unknown as Data
        try {
          await checked(context, operationName, binding, () => options.characters.controlCharacter(scopeKey, 'delete-memory', memoryId, context))
          const after = await checked(context, 'simulation.group-read', binding, () => options.characters.describeGroup(scopeKey, context)), updated = after.character as Data | undefined
          if (!updated || records(updated.memories).some(item => id(item) === memoryId)) fail('unavailable')
          const partition = `character:${scopeKey}`, liveMemories = new Set(records(updated.memories).map(id))
          const removedMemories = records(character.memories).filter(item => !liveMemories.has(id(item)))
          const removedMemoryRefs = new Set(removedMemories.map(item => `memory:${id(item)}`))
          const impacts: ForgetImpact[] = removedMemories.map(item => impact('character-memory', id(item), partition))
          const goals = new Map(records(updated.goals ?? []).map(item => [id(item), item]))
          for (const goal of records(character.goals ?? [])) {
            const next = goals.get(id(goal))
            if (!next || next.status === 'abandoned' && goal.status !== 'abandoned') impacts.push(impact('character-goal', id(goal), partition))
          }
          const priorActivity = before.activities as Data | undefined, nextActivity = after.activities as Data | undefined
          for (const [key, impactKind] of [['works', 'character-work'], ['shared', 'character-shared-derived'], ['sharedPending', 'character-shared-derived']] as const) {
            if (!priorActivity || !nextActivity) continue
            const remaining = new Map(records(nextActivity[key] ?? []).map(item => [id(item), item]))
            for (const item of records(priorActivity[key] ?? [])) {
              const next = remaining.get(id(item))
              if (!next || key === 'works' && hasPrunedMemoryVersion(item, next, removedMemoryRefs)) impacts.push(impact(impactKind, id(item), partition))
            }
          }
          impacts.push(impact('partition', 'source-consumers', partition, 'unsupported'))
          const unique = [...new Map(impacts.map(item => [JSON.stringify([item.kind, item.partition, item.id]), item])).values()]
          const result = await checked(context, operationName, binding, () => finish(operationId, unique, lease))
          return { ok: true, message: '角色来源及可观察依赖已处理；其他存储的完整清理证明暂不支持', ...result } as unknown as Data
        } catch (error) { await failed(operationId, error, lease); throw error }
      })
    },
  }
}
