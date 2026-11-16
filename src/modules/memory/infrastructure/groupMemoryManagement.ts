import { randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import type { PlatformConnectionAdapter } from '../../../contracts/platformConnection.js'
import type { GroupMemoryAgentState, GroupMemoryEntry, GroupMemoryState } from '../../../contracts/groupMemory.js'
import type { PersonMemoryIdentity, PersonMemoryStore } from '../../../contracts/personMemory.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformAccount,
  isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { isPersonMemoryRedacted } from '../domain/personMemory.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { createGroupMemoryStore, groupMemoryId } from './groupMemoryStore.js'

export interface GroupMemoryManagementContext extends AgentToolContext {
  /** Supplied by the host from genuine ingress, never from model/tool arguments. */
  readonly requestMessageId: string
}
export type GroupMemoryManagementFailure = { status: 'forbidden' | 'cancelled' | 'unavailable' | 'not_found' | 'ambiguous' |
  'invalid_confirmation' | 'capacity_exceeded' | 'invalid_request' }
export type GroupMemoryManagementList = { status: 'listed'; entries: GroupMemoryEntry[] } | GroupMemoryManagementFailure
export type GroupMemoryManagementDeletion = { status: 'deleted'; deleted: number } | GroupMemoryManagementFailure
export type GroupMemoryManagementClear = { status: 'confirmation_required'; confirmationId: string; expiresAt: number } |
  { status: 'cleared'; deleted: number } | GroupMemoryManagementFailure
type FailureStatus = GroupMemoryManagementFailure['status']
class ManagementFailure extends Error {
  constructor(readonly status: FailureStatus) { super('群记忆管理未完成。') }
}
type Selection = { entry: GroupMemoryEntry; shared: boolean }
type Confirmation = { key: string; requestMessageId: string; issuedAt: number; expiresAt: number }
const WINDOW_MS = 30_000
const ROLE_FRESHNESS_MS = 1500
const MAX_TOMBSTONES = 1000
const unique = (values: readonly string[]) => [...new Set(values)]
function tombstones(previous: readonly string[], added: readonly string[]): string[] | undefined {
  const result = unique([...previous, ...added])
  return result.length > MAX_TOMBSTONES ? undefined : result
}
function selected(state: GroupMemoryState, agentId: string): Selection[] {
  return [...state.entries.map(entry => ({ entry, shared: true })),
    ...(state.agents.find(agent => agent.agentId === agentId)?.entries ?? []).map(entry => ({ entry, shared: false }))]
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ManagementFailure('cancelled'))
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Explicit management only. The host owns semantic routing and actual user confirmation. */
export function createGroupMemoryManagement(ports: {
  redis: Parameters<typeof createGroupMemoryStore>[0]
  memory: Pick<PersonMemoryStore, 'getRedactions' | 'getSceneRedactions'>
  adapter(target: ConversationAddress): PlatformConnectionAdapter | undefined
  resolve(target: ConversationAddress): { binding: AgentBindingSnapshot } | undefined
  isRecalled(target: ConversationAddress, messageId: string): Promise<boolean>
  now?(): number
}) {
  const store = createGroupMemoryStore(ports.redis), now = ports.now ?? Date.now
  const confirmations = new Map<string, Confirmation>()

  async function operate<T>(original: GroupMemoryManagementContext, run: (operation: {
    context: GroupMemoryManagementContext; current(): boolean; check(): Promise<void>; role(): Promise<'member' | 'admin' | 'owner'>;
  }) => Promise<T>): Promise<T | GroupMemoryManagementFailure> {
    const lifecycle = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      if (!original || original.actor?.kind !== 'user' || !original.actor.user || !isPlatformAccount(original.actor.user) ||
          !isConversationAddress(original.binding?.target) || original.binding.target.kind === 'private' || original.binding.source !== 'configured' ||
          original.binding.id !== conversationAddressKey(original.binding.target) || !isPlatformIdentifier(original.requestMessageId) || original.requestMessageId === '0' ||
          !samePlatformNamespace(original.actor.user, original.binding.target.account)) throw new ManagementFailure('forbidden')
      const context: GroupMemoryManagementContext = { ...original, binding: structuredClone(original.binding),
        actor: { kind: 'user', user: structuredClone(original.actor.user) } }
      const binding = context.binding, target = binding.target, adapter = ports.adapter(target)
      const signal = AbortSignal.any([context.signal, lifecycle.signal, AbortSignal.timeout(30_000)])
      let roleFreshUntil: number | undefined
      const current = () => {
        try {
          const live = ports.resolve(target)?.binding
          return !signal.aborted && (roleFreshUntil === undefined || Date.now() <= roleFreshUntil) &&
            context.isCurrent() && adapter?.isReady() === true && ports.adapter(target) === adapter &&
            adapter.id === binding.connectionId && platformAccountKey(adapter.account) === platformAccountKey(target.account) &&
            !!live && isConversationAddress(live.target) && conversationAddressKey(live.target) === conversationAddressKey(target) &&
            agentBindingToken(live) === agentBindingToken(binding)
        } catch { return false }
      }
      const check = async () => {
        if (!current()) throw new ManagementFailure('cancelled')
        if (context.ensureCurrent) await abortable(Promise.resolve().then(() => context.ensureCurrent!()), signal)
        if (!current()) throw new ManagementFailure('cancelled')
      }
      timer = setInterval(() => { if (!current()) lifecycle.abort() }, 25)
      timer.unref?.()
      const role = async (): Promise<'member' | 'admin' | 'owner'> => {
        await check()
        if (!adapter?.readConversationMember || !context.actor.user || context.actor.user.id === adapter.botUserId) throw new ManagementFailure('forbidden')
        const startedAt = Date.now()
        const snapshot = await abortable(adapter.readConversationMember(target, context.actor.user, { signal, isCurrent: current }), signal)
        await check()
        if (!snapshot || !isConversationAddress(snapshot.target) || conversationAddressKey(snapshot.target) !== conversationAddressKey(target) ||
            !Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < startedAt - 5000 || snapshot.observedAt > Date.now() + 5000 ||
            !isPlatformAccount(snapshot.member?.user) || !samePlatformNamespace(snapshot.member.user, target.account) ||
            snapshot.member.user.id !== context.actor.user.id || !['member', 'admin', 'owner'].includes(snapshot.member.role)) throw new ManagementFailure('forbidden')
        roleFreshUntil = Date.now() + ROLE_FRESHNESS_MS
        return snapshot.member.role as 'member' | 'admin' | 'owner'
      }
      await check()
      return await abortable(run({ context, current, check, role }), signal)
    } catch (error) {
      if (error instanceof ManagementFailure) return { status: error.status }
      return { status: original?.signal?.aborted || lifecycle.signal.aborted ? 'cancelled' : 'unavailable' }
    } finally { if (timer) clearInterval(timer); lifecycle.abort() }
  }

  async function allowed(binding: AgentBindingSnapshot, entry: GroupMemoryEntry): Promise<boolean> {
    if (await ports.isRecalled(binding.target, entry.source.messageId)) return false
    const address = personMemoryAddress(binding.target), identity = { botId: address.botId, personaId: agentPersonaScopeId(binding.agentId) }
    const identities = [identity, ...(entry.persona.personaId !== identity.personaId ? [entry.persona] : [])]
    const source = { scene: address.scene, authorId: entry.source.authorId, messageId: entry.source.messageId, at: entry.source.at, excerpt: entry.source.text }
    for (const owner of identities) for (const subjectId of unique([entry.source.authorId, ...entry.targetUserIds, ...entry.relatedUserIds, ...(entry.ownerId ? [entry.ownerId] : [])])) {
      const redactions = await ports.memory.getRedactions({ identity: owner, subjectId })
      if (isPersonMemoryRedacted(source, entry.source.text, redactions) ||
          isPersonMemoryRedacted(source, entry.text ?? entry.subject ?? entry.condition ?? '', redactions)) return false
    }
    return true
  }
  const identity = (binding: AgentBindingSnapshot): PersonMemoryIdentity => ({
    botId: personMemoryAddress(binding.target).botId, personaId: agentPersonaScopeId(binding.agentId),
  })
  const epoch = (binding: AgentBindingSnapshot, owner: PersonMemoryIdentity = identity(binding)) =>
    ports.memory.getSceneRedactions({ identity: owner, scene: personMemoryAddress(binding.target).scene })

  async function remove(input: { id?: string; subject?: string }, context: GroupMemoryManagementContext): Promise<GroupMemoryManagementDeletion> {
    return await operate(context, async operation => {
      const byId = input.id !== undefined
      if (byId ? !isPlatformIdentifier(input.id) : typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 4000) return { status: 'invalid_request' } as const
      await operation.role()
      const role = await operation.role(), binding = operation.context.binding, actorId = operation.context.actor.user!.id
      let result: GroupMemoryManagementDeletion = { status: 'not_found' }
      const committed = await store.update(groupMemoryId(binding.target), state => {
        result = { status: 'not_found' }
        if (!state) return state
        const candidates = selected(state, binding.agentId).filter(({ entry }) => byId ? entry.id === input.id :
          (entry.subject ?? entry.condition ?? entry.text) === input.subject!.trim())
        if (!candidates.length) return state
        if (new Set(candidates.map(value => JSON.stringify([value.shared, value.entry.source.messageId]))).size !== 1) { result = { status: 'ambiguous' }; return state }
        const first = candidates[0]!, sourceId = first.entry.source.messageId
        if (role === 'member' && first.entry.createdBy !== actorId) { result = { status: 'forbidden' }; return state }
        let deleted = 0
        if (first.shared) {
          const revoked = tombstones(state.teachingDeletedSources ?? [], [sourceId])
          if (!revoked) { result = { status: 'capacity_exceeded' }; return state }
          state.teachingDeletedSources = revoked
          deleted = state.entries.filter(entry => entry.source.messageId === sourceId).length
          state.entries = state.entries.filter(entry => entry.source.messageId !== sourceId)
          for (const agent of state.agents) agent.jobs = agent.jobs.filter(job => job.mode !== 'teaching' || !job.messages.some(message => message.messageId === sourceId))
        } else {
          const agent = state.agents.find(value => value.agentId === binding.agentId)!
          const revoked = tombstones(agent.deletedSources, [sourceId])
          if (!revoked) { result = { status: 'capacity_exceeded' }; return state }
          agent.deletedSources = revoked
          deleted = agent.entries.filter(entry => entry.source.messageId === sourceId).length
          agent.entries = agent.entries.filter(entry => entry.source.messageId !== sourceId)
          agent.jobs = agent.jobs.filter(job => job.mode !== 'consensus' || !job.messages.some(message => message.messageId === sourceId))
        }
        result = { status: 'deleted', deleted }
        return state
      }, operation.current)
      if (!committed) return { status: 'cancelled' } as const
      return result
    })
  }

  return {
    async list(context: GroupMemoryManagementContext): Promise<GroupMemoryManagementList> {
      return await operate(context, async operation => {
        await operation.role()
        const binding = operation.context.binding, state = await store.load(groupMemoryId(binding.target)), entries: GroupMemoryEntry[] = []
        const owners = new Map<string, PersonMemoryIdentity>([[identity(binding).personaId, identity(binding)]])
        for (const { entry } of state ? selected(state, binding.agentId) : []) owners.set(entry.persona.personaId, entry.persona)
        const revisions = new Map<string, string>()
        for (const [id, owner] of owners) revisions.set(id, (await epoch(binding, owner)).revision)
        if (state) {
          const agent = state.agents.find(value => value.agentId === binding.agentId)
          for (const item of selected(state, binding.agentId)) {
            const { entry, shared } = item, sourceId = entry.source.messageId
            if (state.deletedSources.includes(sourceId) || (shared ? state.teachingDeletedSources?.includes(sourceId) || entry.source.at <= (state.teachingClearedAt ?? 0)
              : agent?.deletedSources.includes(sourceId) || entry.source.at <= (agent?.clearedAt ?? 0)) || !await allowed(binding, entry)) continue
            entries.push(entry)
          }
        }
        await operation.role()
        for (const [id, owner] of owners) if ((await epoch(binding, owner)).revision !== revisions.get(id)) return { status: 'cancelled' } as const
        await operation.check()
        return { status: 'listed', entries } as const
      })
    },
    delete(input: { id: string }, context: GroupMemoryManagementContext): Promise<GroupMemoryManagementDeletion> { return remove(input, context) },
    forget(input: { subject: string }, context: GroupMemoryManagementContext): Promise<GroupMemoryManagementDeletion> { return remove(input, context) },
    async clear(input: { confirmationId?: string }, context: GroupMemoryManagementContext): Promise<GroupMemoryManagementClear> {
      return await operate(context, async operation => {
        if (input.confirmationId !== undefined && !isPlatformIdentifier(input.confirmationId)) return { status: 'invalid_request' } as const
        if (await operation.role() === 'member') return { status: 'forbidden' } as const
        const binding = operation.context.binding, actor = operation.context.actor.user!, at = now()
        const key = JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding), actor.platform, actor.namespace, actor.id])
        for (const [id, value] of confirmations) if (value.expiresAt <= at || value.issuedAt > at) confirmations.delete(id)
        if (!input.confirmationId) {
          for (const [id, value] of confirmations) if (value.key === key) confirmations.delete(id)
          if (confirmations.size >= 1000) return { status: 'capacity_exceeded' } as const
          const confirmationId = randomUUID(), expiresAt = at + WINDOW_MS
          confirmations.set(confirmationId, { key, requestMessageId: operation.context.requestMessageId, issuedAt: at, expiresAt })
          return { status: 'confirmation_required', confirmationId, expiresAt } as const
        }
        const confirmation = confirmations.get(input.confirmationId)
        if (!confirmation || confirmation.key !== key || confirmation.requestMessageId === operation.context.requestMessageId || confirmation.expiresAt <= at) return { status: 'invalid_confirmation' } as const
        if (await operation.role() === 'member') return { status: 'forbidden' } as const
        if (confirmation.expiresAt <= now() || confirmation.issuedAt > now()) return { status: 'invalid_confirmation' } as const
        confirmations.delete(input.confirmationId)
        let deleted = 0
        let failure: GroupMemoryManagementFailure | undefined
        const committed = await store.update(groupMemoryId(binding.target), saved => {
          deleted = 0; failure = undefined
          const state: GroupMemoryState = saved ?? { version: 1, id: groupMemoryId(binding.target), target: structuredClone(binding.target),
            agents: [], entries: [], deletedSources: [] }
          let agent = state.agents.find(value => value.agentId === binding.agentId)
          const missingAgent = !agent
          if (!agent) {
            if (state.agents.length >= 20) { failure = { status: 'capacity_exceeded' }; return saved }
            agent = { agentId: binding.agentId, binding: structuredClone(binding), token: agentBindingToken(binding), records: [], jobs: [],
              entries: [], seen: [], consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0 } satisfies GroupMemoryAgentState
          }
          const clearedAt = now(), cutoff = Math.max(state.teachingClearedAt ?? 0, clearedAt), facts = agent.entries
          const sources = unique([...agent.records, ...agent.jobs.flatMap(job => job.messages), ...facts.map(entry => entry.source)].map(message => message.messageId))
          const factTombstones = tombstones(agent.deletedSources, sources)
          const teachingTombstones = tombstones(state.teachingDeletedSources ?? [], state.entries.filter(entry => entry.source.at > cutoff).map(entry => entry.source.messageId))
          if (!factTombstones || !teachingTombstones) { failure = { status: 'capacity_exceeded' }; return state }
          if (missingAgent) state.agents.push(agent)
          state.teachingDeletedSources = teachingTombstones
          deleted = state.entries.length + facts.length
          state.entries = []; state.teachingClearedAt = cutoff
          for (const owner of state.agents) owner.jobs = owner.jobs.filter(job => job.mode !== 'teaching' || !job.messages.some(message => message.at <= cutoff))
          agent.binding = structuredClone(binding); agent.token = agentBindingToken(binding)
          agent.deletedSources = factTombstones; agent.entries = []; agent.records = []; agent.jobs = []; agent.nextConsensusAt = 0
          agent.clearedAt = Math.max(agent.clearedAt ?? 0, clearedAt)
          return state
        }, () => operation.current() && now() < confirmation.expiresAt && now() >= confirmation.issuedAt)
        if (!committed) return { status: now() >= confirmation.expiresAt ? 'invalid_confirmation' : 'cancelled' } as const
        return failure ?? { status: 'cleared', deleted } as const
      })
    },
  }
}
