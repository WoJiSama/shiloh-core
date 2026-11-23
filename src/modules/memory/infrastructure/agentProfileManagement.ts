import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import { AgentManagementError, type AgentManagementBindings, type AgentManagementContext, type AgentManagementGuard } from '../../../contracts/agentManagement.js'
import type { PersonMemoryEntry, PersonMemoryIdentity, PersonMemoryScene } from '../../../contracts/personMemory.js'
import { agentBindingToken, agentConversationKey, agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { PERSON_MEMORY_CATEGORIES, normalizePersonMemoryText } from '../domain/personMemory.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { createPersonMemoryStore } from './personMemoryStore.js'
import { captureSynchronousGuardCheck, createSynchronousGuard } from '../../runtime/domain/synchronousGuard.js'
import { captureAgentBindingDirectoryCheck } from '../../runtime/infrastructure/agentManagementBindings.js'

interface ManagementRedis {
  get(key: string): Promise<unknown>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export interface AgentManagedProfile {
  readonly binding: AgentBindingSnapshot
  readonly profile: Record<string, unknown>
}
const PREFIX = 'shiloh:person-memory:v1', DIRECTORY = PREFIX + ':identities', MAXIMUM = 10_000
const COMMIT = `
for i,key in ipairs(KEYS) do
  local prior=redis.call('GET',key)
  if (prior or false) ~= (ARGV[(i-1)*4+1]=='1' and ARGV[(i-1)*4+2] or false) then return 0 end
end
for i,key in ipairs(KEYS) do
  local mode=ARGV[(i-1)*4+3]
  if mode=='set' then redis.call('SET',key,ARGV[(i-1)*4+4]) elseif mode=='del' then redis.call('DEL',key) end
end
return 1`
const fail = (code: AgentManagementError['code']): never => { throw new AgentManagementError(code) }
const ownerKey = (binding: AgentBindingSnapshot) => JSON.stringify([agentConversationKey(binding), agentBindingToken(binding)])
const memoryBase = (identity: PersonMemoryIdentity) => `${PREFIX}:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}`
function copyBinding(binding: AgentBindingSnapshot): AgentBindingSnapshot {
  if (!binding || binding.source !== 'configured' || !isConversationAddress(binding.target) ||
      typeof binding.id !== 'string' || !binding.id || binding.id.length > 4096 || binding.id.trim() !== binding.id || /[\u0000-\u001f\u007f]/u.test(binding.id) ||
      [binding.revision, binding.agentId, binding.personaId, binding.connectionId].some(value => !isPlatformIdentifier(value))) return fail('unavailable')
  return Object.freeze({ source: 'configured', id: binding.id, revision: binding.revision, agentId: binding.agentId,
    personaId: binding.personaId, connectionId: binding.connectionId, target: Object.freeze({ ...binding.target,
      account: Object.freeze({ ...binding.target.account }) }) })
}
function user(value: string): string {
  if (!isPlatformIdentifier(value) || value.length > 160) return fail('invalid_request')
  return value
}
const safe = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run() } catch (error) { if (error instanceof AgentManagementError) throw error; return fail('unavailable') }
}

/** Exact-source records only. A scene grant never grants deletion of a whole bot/persona profile. */
export function createAgentProfileManagement({ redis, bindings, now = Date.now }: {
  redis: ManagementRedis
  bindings: AgentManagementBindings
  now?: () => number
}) {
  function session(context: AgentManagementContext, operation: string, scoped: boolean) {
    const directory = bindings.list().map(copyBinding)
    if (directory.length > MAXIMUM || new Set(directory.map(item => conversationAddressKey(item.target))).size !== directory.length) return fail('unavailable')
    const signature = JSON.stringify(directory.map(ownerKey).sort()), selected = context.binding && copyBinding(context.binding)
    if (scoped && !selected) return fail('invalid_request')
    const parentCheck = captureSynchronousGuardCheck(context, () => fail('conflict'))
    const sameDirectory = captureAgentBindingDirectoryCheck(bindings, directory) ??
      (() => JSON.stringify(bindings.list().map(copyBinding).map(ownerKey).sort()) === signature)
    const directoryCurrent = () => sameDirectory() &&
      (selected ? !!context.binding && ownerKey(copyBinding(context.binding)) === ownerKey(selected) : context.binding === undefined) &&
      (!selected || ownerKey(bindings.resolve(selected.target)!) === ownerKey(selected))
    const current = () => {
      try { return !context.signal.aborted && context.isCurrent() === true && directoryCurrent() } catch { return false }
    }
    const guard: AgentManagementGuard = parentCheck ? createSynchronousGuard(context.signal, () => {
      parentCheck()
      try { if (!directoryCurrent()) fail('conflict') } catch { fail('conflict') }
    }, () => fail('conflict')) : { signal: context.signal, isCurrent: current,
      ensureCurrent() { context.ensureCurrent(); if (!current()) fail('conflict') } }
    const { ensureCurrent } = guard
    const authorized = new Map<string, { binding: AgentBindingSnapshot; operation: string }>(), captured = new Map<string, string | null>(), changes = new Map<string, string | null>()
    async function authorize(binding: AgentBindingSnapshot, omitDenied = false, action = operation): Promise<boolean> {
      ensureCurrent()
      const live = bindings.resolve(binding.target)
      if (!live || ownerKey(live) !== ownerKey(binding) || selected && ownerKey(selected) !== ownerKey(binding)) return fail('conflict')
      const decision = await context.authorize(action, binding, guard)
      ensureCurrent()
      if (decision === 'unavailable') return fail('unavailable')
      if (decision !== 'allowed') { if (omitDenied) return false; return fail('forbidden') }
      authorized.set(JSON.stringify([action, ownerKey(binding)]), { binding, operation: action })
      return true
    }
    const store = (binding: AgentBindingSnapshot) => {
      const { botId, scene } = personMemoryAddress(binding.target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }, base = memoryBase(identity)
      const allowedKey = (key: string) => key === DIRECTORY || key === DIRECTORY + ':lock' || key === base + ':lock' || key === base + ':scope' || key.startsWith(base + ':person:')
      const checkRead = operation === 'profiles.read' ? () => {
        ensureCurrent()
        if (!authorized.has(JSON.stringify([operation, ownerKey(binding)]))) fail('forbidden')
      } : () => authorize(binding)
      const get = async (key: string) => {
        if (!allowedKey(key)) return fail('unavailable')
        await checkRead()
        if (!captured.has(key)) {
          const value = await redis.get(key)
          await checkRead()
          if (value !== null && value !== undefined && typeof value !== 'string') return fail('unavailable')
          if (captured.has(key) && captured.get(key) !== (value ?? null)) return fail('conflict')
          captured.set(key, value == null ? null : value)
        }
        ensureCurrent()
        return changes.has(key) ? changes.get(key)! : captured.get(key)!
      }
      const stage = (key: string, value: string | null) => {
        ensureCurrent()
        if (!allowedKey(key) || key.endsWith(':lock') || !captured.has(key)) return fail('unavailable')
        changes.set(key, value)
      }
      const memory = createPersonMemoryStore({ now, redis: { get,
        async set(key, value) { stage(key, value); return 'OK' }, async del(key) { stage(key, null); return 1 } } })
      return { identity, scene, memory,
        async prepare() { for (const key of [base + ':lock', DIRECTORY + ':lock']) if (await get(key) !== null) fail('conflict') },
      }
    }
    async function finish() {
      for (const item of authorized.values()) await authorize(item.binding, false, item.operation)
      ensureCurrent()
      const keys = [...captured.keys()]
      const result = keys.length ? await redis.eval(COMMIT, { keys, arguments: keys.flatMap(key => {
        const value = captured.get(key)!, write = changes.get(key)
        return [value === null ? '0' : '1', value ?? '', changes.has(key) ? write === null ? 'del' : 'set' : 'keep', write ?? '']
      }) }) : 1
      ensureCurrent()
      if (Number(result) !== 1) return fail('conflict')
      for (const [key, value] of changes) captured.set(key, value)
      for (const item of authorized.values()) await authorize(item.binding, false, item.operation)
      ensureCurrent()
      // Authorization is asynchronous too: privacy may have changed while it ran.
      // This last comparison is read-only, including after a successful atomic erase.
      if (keys.length) {
        const fresh = await redis.eval(COMMIT, { keys, arguments: keys.flatMap(key => {
          const value = captured.get(key)!
          return [value === null ? '0' : '1', value ?? '', 'keep', '']
        }) })
        ensureCurrent()
        if (Number(fresh) !== 1) return fail('conflict')
      }
    }
    ensureCurrent()
    return { selected, targets: selected ? [selected] : directory, authorize,
      authorizeRead: (binding: AgentBindingSnapshot) => authorize(binding, false, 'profiles.read'), store, finish }
  }
  type SessionStore = ReturnType<ReturnType<typeof session>['store']>
  async function entries(owner: SessionStore, subjectId: string): Promise<PersonMemoryEntry[]> {
    const output: PersonMemoryEntry[] = [], scene: PersonMemoryScene = owner.scene.kind === 'private'
      ? { ...owner.scene, peerId: subjectId } : owner.scene
    let offset = 0
    for (;;) {
      const page = await owner.memory.listScene({ identity: owner.identity, subjectId, scene, viewerUserId: subjectId, offset, limit: 50 })
      output.push(...page.items)
      if (output.length > MAXIMUM) return fail('unavailable')
      if (!page.hasMore) return output
      if (page.nextOffset === undefined || page.nextOffset <= offset || page.nextOffset > MAXIMUM) return fail('unavailable')
      offset = page.nextOffset
    }
  }
  function profile(owner: SessionStore, subjectId: string, items: PersonMemoryEntry[]): Record<string, unknown> {
    return { userId: subjectId, identity: { ...owner.identity }, sourceScene: items[0]?.source.scene ?? { ...owner.scene }, entries: structuredClone(items) }
  }
  async function list(context: AgentManagementContext): Promise<AgentManagedProfile[]> {
    return safe(async () => {
      const work = session(context, 'profiles.read', false), output: AgentManagedProfile[] = []
      for (const binding of work.targets) {
        if (!await work.authorize(binding, !work.selected)) continue
        const owner = work.store(binding); await owner.prepare()
        const subjects = await owner.memory.listSubjects(owner.identity)
        if (subjects.length > MAXIMUM) return fail('unavailable')
        for (const { subjectId } of subjects) {
          const items = await entries(owner, subjectId)
          if (items.length) output.push({ binding, profile: profile(owner, subjectId, items) })
          if (output.length > MAXIMUM) return fail('unavailable')
        }
      }
      await work.finish()
      return output
    })
  }
  async function mutate(subjectId: string, context: AgentManagementContext, field?: string, value?: string) {
    return safe(async () => {
      user(subjectId)
      const work = session(context, field === undefined ? 'profiles.delete' : 'profiles.delete-field', true), binding = work.selected!
      await work.authorize(binding)
      const owner = work.store(binding); await owner.prepare()
      const items = await entries(owner, subjectId)
      if (field === undefined) {
        if (!items.length) { await work.finish(); return false }
        const before = Math.max(now(), ...items.map(item => item.source.at))
        await owner.memory.forget({ identity: owner.identity, subjectId, scene: owner.scene, before })
      } else {
        const aliases: Record<string, string> = { interests: 'interest', facts: 'fact' }, category = aliases[field] ?? field
        if (field !== 'entries' && !(PERSON_MEMORY_CATEGORIES as readonly string[]).includes(category) ||
            value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4000)) return fail('invalid_request')
        if (field === 'entries' && value === undefined) return fail('invalid_request')
        const selected = items.filter(item => field === 'entries' ? item.id === value : item.category === category &&
          (value === undefined || item.id === value || normalizePersonMemoryText(item.text) === normalizePersonMemoryText(value)))
        if (!selected.length) return fail('not_found')
        for (const entry of selected) await owner.memory.forget({ identity: owner.identity, subjectId, scene: owner.scene, id: entry.id })
      }
      if (field !== undefined) await work.authorizeRead(binding)
      const result = field === undefined ? true : profile(owner, subjectId, await entries(owner, subjectId))
      await work.finish()
      return result
    })
  }
  return {
    list,
    async remove(userId: string, context: AgentManagementContext): Promise<boolean> { return await mutate(userId, context) === true },
    async removeField(userId: string, field: string, value: string | undefined, context: AgentManagementContext): Promise<unknown> {
      if (typeof field !== 'string' || !field || field.length > 32) return fail('invalid_request')
      return mutate(userId, context, field, value)
    },
  }
}
