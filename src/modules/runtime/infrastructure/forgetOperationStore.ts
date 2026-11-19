import { createHash, randomUUID } from 'node:crypto'
import type {
  ForgetCleanupOwner, ForgetCleanupPlan, ForgetCleanupState, ForgetImpact, ForgetImpactKind, ForgetOperationKind, ForgetOperationPhase,
  ForgetOperationGuard, ForgetOperationReceipt, ForgetOperationStorage, ForgetOperationStore, ForgetOperationSubject, ForgetUsageState,
} from '../../../contracts/forgetOperation.js'
import { ForgetOperationConflictError } from '../../../contracts/forgetOperation.js'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'

const BEGIN = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
if redis.call('EXISTS', KEYS[2]) == 1 then return redis.error_reply('forget operation id conflict') end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return ARGV[1]`
const COMPARE_AND_SET = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`

const operationKinds = new Set<ForgetOperationKind>(['person-profile', 'person-entry', 'character-memory'])
const phases = new Set<ForgetOperationPhase>(['accepted', 'committed', 'settling', 'completed', 'failed', 'unknown'])
const cleanups = new Set<ForgetCleanupState>(['pending', 'completed', 'failed', 'unknown', 'unsupported'])
const usages = new Set<ForgetUsageState>(['pending', 'blocked', 'unknown'])
const cleanupOwners = new Set<ForgetCleanupOwner>(['local-emoji', 'semantic-memory', 'conversation-memory', 'group-memory', 'source-memory'])
const impactKinds = new Set<ForgetImpactKind>([
  'person-memory-entry', 'character-memory', 'character-goal', 'character-work', 'character-shared-derived', 'source-consumer', 'partition',
])
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const failure = (message = '遗忘操作回执不可用'): never => { throw new Error(message) }

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return failure()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || pattern !== undefined && !pattern.test(value)) return failure()
  return value
}
function time(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000) return failure()
  return Number(value)
}
function copyBinding(value: unknown): AgentBindingSnapshot {
  const row = plain(value), target = plain(row.target), account = plain(target.account)
  if (row.source !== 'configured' || !['group', 'private', 'channel', 'thread'].includes(String(target.kind))) return failure()
  return Object.freeze({
    source: 'configured', id: text(row.id, 4096), revision: text(row.revision, 4096),
    agentId: text(row.agentId, 128), personaId: text(row.personaId, 256), connectionId: text(row.connectionId, 128),
    target: Object.freeze({
      kind: target.kind as AgentBindingSnapshot['target']['kind'], id: text(target.id, 1024),
      account: Object.freeze({ platform: text(account.platform, 64), namespace: text(account.namespace, 128), id: text(account.id, 256) }),
    }),
  })
}
function copySubject(value: unknown): ForgetOperationSubject {
  const row = plain(value), output: Record<string, string> = {}
  for (const key of Object.keys(row)) {
    if (!['userId', 'entryId', 'groupId', 'memoryId'].includes(key)) return failure()
    output[key] = text(row[key], key === 'groupId' ? 4096 : 512)
  }
  if (!Object.keys(output).length) return failure()
  return Object.freeze(output)
}
function copyImpact(value: unknown): ForgetImpact {
  const row = plain(value)
  if (typeof row.kind !== 'string' || !impactKinds.has(row.kind as ForgetImpactKind) || typeof row.state !== 'string' || !cleanups.has(row.state as ForgetCleanupState)) return failure()
  return Object.freeze({ kind: row.kind as ForgetImpactKind, id: text(row.id, 512), partition: text(row.partition, 8192), state: row.state as ForgetCleanupState })
}
function copyImpacts(value: unknown): readonly ForgetImpact[] {
  if (!Array.isArray(value) || value.length > 10_000) return failure()
  const output = value.map(copyImpact), seen = new Set<string>()
  for (const item of output) {
    const key = `${item.kind}\u0000${item.partition}\u0000${item.id}`
    if (seen.has(key)) return failure()
    seen.add(key)
  }
  return Object.freeze(output)
}
function copyCleanupPlan(value: unknown): ForgetCleanupPlan {
  const row = plain(value)
  if (row.version !== 1 || typeof row.sourceCommitted !== 'boolean' || !Array.isArray(row.owners) || row.owners.length > cleanupOwners.size) return failure()
  const seen = new Set<string>()
  const owners = row.owners.map(value => {
    const item = plain(value)
    if (typeof item.owner !== 'string' || !cleanupOwners.has(item.owner as ForgetCleanupOwner) || seen.has(item.owner) ||
        typeof item.state !== 'string' || !cleanups.has(item.state as ForgetCleanupState)) return failure()
    seen.add(item.owner)
    return Object.freeze({ owner: item.owner as ForgetCleanupOwner, state: item.state as ForgetCleanupState })
  })
  return Object.freeze({ version: 1, sourceCommitted: row.sourceCommitted, owners: Object.freeze(owners) })
}
function copyReceipt(value: unknown): ForgetOperationReceipt {
  const row = plain(value)
  if (row.version !== 1 || typeof row.operationId !== 'string' || !uuidPattern.test(row.operationId) ||
      typeof row.requestId !== 'string' || !tokenPattern.test(row.requestId) || typeof row.kind !== 'string' || !operationKinds.has(row.kind as ForgetOperationKind) ||
      typeof row.phase !== 'string' || !phases.has(row.phase as ForgetOperationPhase) || typeof row.usage !== 'string' || !usages.has(row.usage as ForgetUsageState) ||
      typeof row.cleanup !== 'string' || !cleanups.has(row.cleanup as ForgetCleanupState)) return failure()
  const output: ForgetOperationReceipt = {
    version: 1, operationId: row.operationId, requestId: row.requestId, requestDigest: text(row.requestDigest, 64, /^[0-9a-f]{64}$/u), kind: row.kind as ForgetOperationKind,
    binding: copyBinding(row.binding), subject: copySubject(row.subject), phase: row.phase as ForgetOperationPhase,
    usage: row.usage as ForgetUsageState, cleanup: row.cleanup as ForgetCleanupState,
    impacts: copyImpacts(row.impacts), createdAt: time(row.createdAt), updatedAt: time(row.updatedAt),
    ...(row.sourceRevision === undefined ? {} : { sourceRevision: text(row.sourceRevision, 4096) }),
    ...(row.errorCode === undefined ? {} : { errorCode: text(row.errorCode, 256) }),
    ...(row.cleanupPlan === undefined ? {} : { cleanupPlan: copyCleanupPlan(row.cleanupPlan) }),
  }
  if (output.updatedAt < output.createdAt) return failure()
  if (output.cleanupPlan && (output.kind !== 'person-profile' || !output.subject.userId || output.cleanupPlan.sourceCommitted && output.usage !== 'blocked')) return failure()
  return Object.freeze(output)
}

function phaseRank(value: ForgetOperationPhase): number { return { accepted: 0, committed: 1, settling: 2, completed: 3, failed: 3, unknown: 3 }[value] }
function terminal(value: ForgetOperationPhase): boolean { return value === 'completed' || value === 'failed' || value === 'unknown' }

export function createForgetOperationStore(options: {
  readonly redis: ForgetOperationStorage
  readonly prefix?: string
  readonly now?: () => number
}): ForgetOperationStore {
  const prefix = options.prefix ?? 'agent:forget-operation:v1'
  if (!/^[A-Za-z][A-Za-z0-9:_-]{0,128}$/u.test(prefix)) return failure('遗忘操作回执前缀无效')
  const now = options.now ?? Date.now
  const operationKey = (id: string) => `${prefix}:operation:${id}`
  const requestKey = (id: string) => `${prefix}:request:${id}`

  async function access<T>(guard: ForgetOperationGuard | undefined, action: () => Promise<T>): Promise<T> {
    guard?.ensureCurrent()
    await guard?.beforeAccess?.()
    guard?.ensureCurrent()
    const result = await action()
    guard?.ensureCurrent()
    return result
  }
  async function readRaw(operationId: string, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt | undefined> {
    const raw = await access(guard, () => options.redis.get(operationKey(text(operationId, 128, uuidPattern))))
    if (raw === null) return undefined
    try { return copyReceipt(JSON.parse(raw)) } catch { return failure() }
  }
  async function writeCas(operationId: string, current: ForgetOperationReceipt, next: ForgetOperationReceipt, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt> {
    const result = await access(guard, () => options.redis.eval(COMPARE_AND_SET, { keys: [operationKey(operationId)], arguments: [JSON.stringify(current), JSON.stringify(next)] }))
    if (Number(result) !== 1) return failure('遗忘操作回执发生并发冲突')
    return next
  }
  async function mutate(operationId: string, apply: (current: ForgetOperationReceipt) => ForgetOperationReceipt, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await readRaw(operationId, guard)
      if (!current) return failure('遗忘操作不存在')
      const next = apply(current)
      try { return await writeCas(operationId, current, next, guard) } catch (error) {
        if (attempt === 3) throw error
      }
    }
    return failure('遗忘操作回执发生并发冲突')
  }

  return {
    async begin(input, guard) {
      const requestId = text(input.requestId, 256, tokenPattern), kind = input.kind
      if (!operationKinds.has(kind)) return failure('遗忘操作类型无效')
      const binding = copyBinding(input.binding), subject = copySubject(input.subject), at = input.now === undefined ? time(now()) : time(input.now)
      const operationId = input.operationId === undefined ? randomUUID() : text(input.operationId, 128, uuidPattern)
      const requestDigest = input.requestDigest === undefined ? createHash('sha256').update(JSON.stringify([kind, binding, subject])).digest('hex') : text(input.requestDigest, 64, /^[0-9a-f]{64}$/u)
      const plan = input.cleanupOwners === undefined ? undefined : copyCleanupPlan({ version: 1, sourceCommitted: false,
        owners: input.cleanupOwners.map(owner => ({ owner, state: 'pending' })) })
      const receipt = copyReceipt({ version: 1, operationId, requestId, requestDigest, kind, binding, subject,
        phase: 'accepted', usage: 'pending', cleanup: 'pending', impacts: copyImpacts(input.impacts ?? []), createdAt: at, updatedAt: at,
        ...(input.sourceRevision === undefined ? {} : { sourceRevision: text(input.sourceRevision, 4096) }),
        ...(plan === undefined ? {} : { cleanupPlan: plan }) })
      const result = await access(guard, () => options.redis.eval(BEGIN, { keys: [requestKey(requestId), operationKey(operationId)], arguments: [operationId, JSON.stringify(receipt)] }))
      const selected = text(String(result ?? ''), 128, uuidPattern)
      const existing = await readRaw(selected, guard)
      if (!existing) return failure('遗忘操作回执提交后不可读取')
      if (existing.kind !== kind || existing.requestDigest !== requestDigest || JSON.stringify(existing.binding) !== JSON.stringify(binding) || JSON.stringify(existing.subject) !== JSON.stringify(subject)) throw new ForgetOperationConflictError()
      return existing
    },
    read: readRaw,
    async readByRequestId(requestId, guard) {
      const id = await access(guard, () => options.redis.get(requestKey(text(requestId, 256, tokenPattern))))
      if (id === null) return undefined
      return readRaw(text(id, 128, uuidPattern), guard)
    },
    async update(operationId, patch, guard) {
      const id = text(operationId, 128, uuidPattern)
      return mutate(id, current => {
        if (patch.phase !== undefined && (!phases.has(patch.phase) || phaseRank(patch.phase) < phaseRank(current.phase) || terminal(current.phase) && patch.phase !== current.phase)) return failure('遗忘操作状态不可回退')
        if (patch.usage !== undefined && (!usages.has(patch.usage) || current.usage === 'blocked' && patch.usage !== 'blocked' || current.usage === 'unknown' && patch.usage === 'pending')) return failure('遗忘使用状态不可回退')
        if (patch.cleanup !== undefined && (!cleanups.has(patch.cleanup) || current.cleanup !== 'pending' && patch.cleanup !== current.cleanup)) return failure('遗忘清理状态不可回退')
        let plan = current.cleanupPlan
        if (patch.cleanupOwner !== undefined) {
          if (!plan?.sourceCommitted || !['committed', 'settling'].includes(current.phase)) return failure('来源删除尚未确认或清理未恢复')
          const selected = plan.owners.find(item => item.owner === patch.cleanupOwner!.owner)
          if (!selected) return failure('清理负责人不在原计划中')
          if (!cleanups.has(patch.cleanupOwner.state)) return failure()
          if (['completed', 'unsupported'].includes(selected.state) && selected.state !== patch.cleanupOwner.state) return failure('已确认的清理结果不可回退')
          plan = copyCleanupPlan({ ...plan, owners: plan.owners.map(item => item.owner === selected.owner ? patch.cleanupOwner : item) })
        }
        if (plan && (patch.phase === 'completed' || patch.cleanup === 'completed' || patch.cleanup === 'unsupported') &&
            (!plan.sourceCommitted || plan.owners.some(item => !['completed', 'unsupported'].includes(item.state)))) return failure('仍有未确认的清理负责人')
        const at = patch.now === undefined ? time(now()) : time(patch.now)
        if (at < current.updatedAt) return failure('遗忘操作时间不可回退')
        const next: ForgetOperationReceipt = { ...current, ...(patch.phase === undefined ? {} : { phase: patch.phase }), ...(patch.usage === undefined ? {} : { usage: patch.usage }),
          ...(patch.cleanup === undefined ? {} : { cleanup: patch.cleanup }), ...(patch.impacts === undefined ? {} : { impacts: copyImpacts(patch.impacts) }),
          ...(patch.sourceRevision === undefined ? {} : { sourceRevision: text(patch.sourceRevision, 4096) }), ...(patch.errorCode === undefined ? {} : { errorCode: text(patch.errorCode, 256) }),
          ...(plan === undefined ? {} : { cleanupPlan: plan }), updatedAt: at }
        return copyReceipt(next)
      }, guard)
    },
    async resumeCleanup(operationId, guard) {
      return mutate(text(operationId, 128, uuidPattern), current => {
        if (!current.cleanupPlan?.sourceCommitted || current.usage !== 'blocked') return failure('来源删除尚未确认')
        if (current.phase === 'completed') return current
        const { errorCode: _errorCode, ...retained } = current
        return copyReceipt({ ...retained, phase: 'settling', cleanup: 'pending', updatedAt: Math.max(current.updatedAt, time(now())) })
      }, guard)
    },
    async markCommitted(operationId, input = {}, guard) {
      return mutate(text(operationId, 128, uuidPattern), current => {
        if (terminal(current.phase) && (!current.cleanupPlan || current.cleanupPlan.sourceCommitted) || current.phase === 'completed' || current.phase === 'settling') return current
        const at = input.now === undefined ? time(now()) : time(input.now)
        if (at < current.updatedAt) return failure('遗忘操作时间不可回退')
        return copyReceipt({ ...current, phase: 'committed', usage: 'blocked', cleanup: 'pending', updatedAt: at,
          ...(input.impacts === undefined ? {} : { impacts: copyImpacts(input.impacts) }),
          ...(input.sourceRevision === undefined ? {} : { sourceRevision: text(input.sourceRevision, 4096) }),
          ...(current.cleanupPlan === undefined ? {} : { cleanupPlan: { ...current.cleanupPlan, sourceCommitted: true } }) })
      }, guard)
    },
    async complete(operationId, input = {}, guard) {
      const current = await readRaw(text(operationId, 128, uuidPattern), guard)
      if (!current) return failure('遗忘操作不存在')
      if (terminal(current.phase)) return current
      return this.update(current.operationId, { phase: 'completed', usage: 'blocked', cleanup: 'completed', ...(input.impacts === undefined ? {} : { impacts: input.impacts }), ...(input.now === undefined ? {} : { now: input.now }) }, guard)
    },
    async fail(operationId, input, guard) {
      const current = await readRaw(text(operationId, 128, uuidPattern), guard)
      if (!current) return failure('遗忘操作不存在')
      if (terminal(current.phase)) return current
      const state = input.state ?? 'failed'
      if (!['failed', 'unknown', 'unsupported'].includes(state)) return failure('遗忘失败状态无效')
      return this.update(current.operationId, { phase: state === 'unknown' ? 'unknown' : 'failed', usage: current.phase === 'accepted' ? 'unknown' : 'blocked', cleanup: state, errorCode: input.errorCode, ...(input.now === undefined ? {} : { now: input.now }) }, guard)
    },
  }
}

