import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentQzoneAction, AgentQzoneExecution, AgentQzoneGuard, AgentQzoneLedger, AgentQzoneLimits, AgentQzoneProvider, AgentQzoneReceipt, AgentQzoneResult } from '../../../contracts/agentQzone.js'
import { createAgentDiagnostics, type AgentDiagnostics } from './agentDiagnostics.js'
import { normalizeAgentQzoneCode, normalizeAgentQzoneLimits, normalizeAgentQzoneReceipt, qzoneData, qzoneToken, validateAgentQzoneAccount, validateAgentQzoneAction, validateAgentQzoneBinding, validateAgentQzoneOwnPost, validateAgentQzoneVisit } from '../../tools/infrastructure/agentQzoneValidation.js'

const invalid = () => new Error('qzone_source_unavailable')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isSimulation = ({ operation }: AgentQzoneAction) => operation.kind === 'visit' || operation.kind === 'like' || operation.kind === 'comment'
const callable = (input: unknown) => typeof input === 'function' && !types.isProxy(input)
const executionKeys = ['binding', 'identity', 'actor', 'operation', 'signal', 'isCurrent', 'ensureCurrent', 'authorize', 'readMember', 'affinity', 'allowsText'] as const
export interface AgentQzoneRuntimeOptions {
  readonly ledger: AgentQzoneLedger
  readonly provider: AgentQzoneProvider
  /** Own publishing/deletion remain disabled without this explicit host switch and live authorize grant. */
  readonly enabled?: boolean
  /** Only the owner's background worker supplies this grant. The regular tool coordinator has no autonomous path. */
  readonly personal?: Readonly<{ read: boolean; publish: boolean }>
  readonly limits?: Partial<AgentQzoneLimits>
  /** Re-read simulation.qzone for every external step. Revocation must also invalidate the host guard. */
  getLimits?(binding: AgentBindingSnapshot): Partial<AgentQzoneLimits>
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly diagnostics?: AgentDiagnostics
}

/** Independent business flow. Each call owns at most one native/HTTP effect, with a durable fence before dispatch. */
export function createAgentQzoneRuntime(options: AgentQzoneRuntimeOptions) {
  const ledger = options.ledger, provider = options.provider, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 45_000
  if (!ledger || !provider || !callable(provider.execute) || !callable(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      ['claim', 'isPending', 'settle', 'readOwnPost', 'readVisit'].some(key => !callable(ledger[key as keyof AgentQzoneLedger]))) throw invalid()
  const defaults = normalizeAgentQzoneLimits(options.limits), diagnostics = options.diagnostics ?? createAgentDiagnostics()
  const emit = (code: string, outcome: 'failed' | 'unknown' | 'cancelled' = 'failed') => {
    try { diagnostics.emit({ stage: 'delivery', operation: 'qzone', outcome, code }) }
    catch { console.warn('[Agent] delivery/qzone failed qzone_diagnostics_failed') }
  }
  return {
    async execute(input: AgentQzoneExecution): Promise<AgentQzoneResult> {
      let action: Readonly<AgentQzoneAction>, identity: string, actorId: string | undefined, actorKey: string, personal: boolean
      let rejectedKind: AgentQzoneResult['kind'] = 'publish'
      let parent: AbortSignal, execution: AgentQzoneExecution
      try {
        const row = qzoneData(input, executionKeys)
        action = validateAgentQzoneAction({ version: 1, binding: row.binding, operation: row.operation }); identity = qzoneToken(row.identity, 4096)
        rejectedKind = action.operation.kind
        const actor = qzoneData(row.actor, ['kind', 'user'])
        personal = actor.kind === 'autonomous'
        const account = action.binding.target.account
        if (personal) {
          if (Object.hasOwn(actor, 'user') || (rejectedKind === 'read' ? options.personal?.read !== true :
              rejectedKind !== 'publish' || options.personal?.publish !== true)) throw invalid()
          actorKey = 'autonomous'
        } else {
          if (actor.kind !== 'user' || rejectedKind === 'read') throw invalid()
          const user = validateAgentQzoneAccount(actor.user)
          if (user.platform !== account.platform || user.namespace !== account.namespace || user.id === account.id) throw invalid()
          actorId = user.id
          actorKey = JSON.stringify(user)
        }
        if (!['isCurrent', 'ensureCurrent', 'authorize'].every(key => callable(row[key])) || types.isProxy(row.signal) || !(row.signal instanceof AbortSignal)) throw invalid()
        parent = row.signal
        if (isSimulation(action) && (!callable(row.readMember) || !callable(row.affinity)) ||
            'text' in action.operation && !callable(row.allowsText)) throw invalid()
        execution = row as unknown as AgentQzoneExecution
      } catch {
        emit('qzone_invalid_request')
        return { state: 'failed', kind: rejectedKind, code: 'qzone_invalid_request', terminal: false }
      }
      const kind = action.operation.kind, readsFeed = kind === 'visit' || kind === 'read', simulation = isSimulation(action), snapshot = JSON.stringify(action)
      const fail = (code: string, terminal = false): AgentQzoneResult => ({ state: 'failed', kind, code, terminal })
      const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, parent]), timer = setTimeout(() => cancel.abort(), timeoutMs)
      const current = () => {
        try {
          const row = qzoneData(input, executionKeys), actor = qzoneData(row.actor, ['kind', 'user'])
          const matchesActor = personal ? actor.kind === 'autonomous' && !Object.hasOwn(actor, 'user')
            : actor.kind === 'user' && JSON.stringify(validateAgentQzoneAccount(actor.user)) === actorKey
          return !signal.aborted && execution.isCurrent() === true && row.identity === identity && matchesActor &&
            JSON.stringify(validateAgentQzoneAction({ version: 1, binding: row.binding, operation: row.operation })) === snapshot
        } catch { return false }
      }
      const watcher = setInterval(() => { if (!current()) cancel.abort() }, 25)
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => { clear(); reject(invalid()) }, clear = () => signal.removeEventListener('abort', abort)
        promise.then(value => { clear(); resolve(value) }, () => { clear(); reject(invalid()) })
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
      const base = async () => {
        if (!current()) throw invalid()
        await wait(Promise.resolve().then(() => execution.ensureCurrent()))
        if (!current()) throw invalid()
      }
      const baseGuard: AgentQzoneGuard = Object.freeze({ signal, isCurrent: current, ensureCurrent: base })
      const limits = () => normalizeAgentQzoneLimits(options.getLimits ? options.getLimits(action.binding) : defaults)
      const operationAllowed = (config: AgentQzoneLimits) => personal
        ? (kind === 'read' ? options.personal?.read : options.personal?.publish) === true : simulation ? config.enabled : options.enabled === true
      let capturedLimits: string | undefined
      const fresh = async (userId: string) => {
        await base()
        const raw = await wait(Promise.resolve().then(() => execution.readMember!(userId, baseGuard)))
        await base()
        const member = qzoneData(raw, ['target', 'observedAt', 'member']), row = qzoneData(member.member, ['user', 'displayName', 'role', 'profile'])
        const user = validateAgentQzoneAccount(row.user), timestamp = now()
        const target = validateAgentQzoneBinding({ ...action.binding, target: member.target }).target
        if (!same(target, action.binding.target) || user.platform !== action.binding.target.account.platform || user.namespace !== action.binding.target.account.namespace || user.id !== userId ||
            typeof row.displayName !== 'string' || !['owner', 'admin', 'member', 'unknown'].includes(row.role as string) ||
            typeof member.observedAt !== 'number' || !Number.isSafeInteger(member.observedAt) || member.observedAt < timestamp - 15_000 || member.observedAt > timestamp + 2000) throw invalid()
      }
      const authorize = async () => {
        await base()
        const config = limits()
        if (simulation) {
          const identity = JSON.stringify(config)
          if (capturedLimits !== undefined && identity !== capturedLimits) throw invalid()
          capturedLimits = identity
        }
        if (!operationAllowed(config)) throw invalid()
        if (await wait(Promise.resolve().then(() => execution.authorize(action))) !== true) throw invalid()
        await base()
        if ('text' in action.operation) {
          const text = action.operation.text
          if (await wait(Promise.resolve().then(() => execution.allowsText!(text, action.binding.target))) !== true) throw invalid()
          await base()
        }
        const op = action.operation
        if (op.kind === 'delete') {
          const raw = await wait(ledger.readOwnPost(action.binding.target.account, op.postId))
          const own = validateAgentQzoneOwnPost(raw)
          if (own.agentId !== action.binding.agentId || own.postId !== op.postId || !same(own.account, action.binding.target.account)) throw invalid()
        } else if (op.kind === 'visit' || op.kind === 'like' || op.kind === 'comment') {
          const affinity = execution.affinity!(op.userId)
          if (op.userId === action.binding.target.account.id || typeof affinity !== 'number' || !Number.isFinite(affinity) || affinity < config.minAffinity) throw invalid()
          if (!actorId) throw invalid()
          await fresh(actorId)
          if (op.userId !== actorId) await fresh(op.userId)
          if (op.kind !== 'visit') {
            const visit = validateAgentQzoneVisit(await wait(ledger.readVisit(op.visitId)))
            const timestamp = now()
            if (!same(visit.binding, action.binding) || visit.sourceId !== identity || visit.userId !== op.userId || !visit.postIds.includes(op.postId) ||
                visit.observedAt > timestamp + 2000 || visit.expiresAt <= timestamp) throw invalid()
          }
        }
        await base()
        // Async member/ledger reads must not carry a grant past a configuration or host-policy revocation.
        const liveLimits = limits()
        if (!operationAllowed(liveLimits) || simulation && JSON.stringify(liveLimits) !== capturedLimits) throw invalid()
        if (await wait(Promise.resolve().then(() => execution.authorize(action))) !== true) throw invalid()
        await base()
      }
      let dispatched = false, claimed = false
      try {
        try { await authorize() }
        catch { emit('qzone_source_unavailable', signal.aborted ? 'cancelled' : 'failed'); return fail('qzone_source_unavailable') }
        let claim
        try { claim = await wait(ledger.claim({ binding: action.binding, identity, operation: action.operation, now: now(), limits: limits() })) }
        catch { emit('qzone_claim_failed'); return fail('qzone_claim_failed') }
        if (claim.state !== 'claimed') {
          // Do not expose provider/storage strings or replay a pending/unknown effect.
          const state = claim.state === 'unknown' ? 'unknown' : 'failed'
          const code = normalizeAgentQzoneCode(claim.code)
          emit(code, state)
          return { state, kind, code, terminal: state === 'unknown' || code === 'qzone_already_confirmed' && !readsFeed }
        }
        claimed = true
        const pending = claim.claim
        const guarded = async () => {
          await authorize()
          if (await wait(ledger.isPending(pending)) !== true) throw invalid()
          await base()
        }
        let receipt: AgentQzoneReceipt
        try {
          await guarded()
          receipt = normalizeAgentQzoneReceipt(await wait(Promise.resolve().then(() => {
            if (!current()) throw invalid()
            dispatched = true
            return provider.execute(action, Object.freeze({ signal, isCurrent: current, ensureCurrent: guarded }))
          })), action.operation)
        } catch { receipt = dispatched && !readsFeed ? { state: 'unknown' } : { state: 'failed', code: 'qzone_source_unavailable' } }
        // Reads must still be current before feed text can be returned. Writes settle their actual receipt even after revocation.
        if (readsFeed && receipt.state === 'confirmed') {
          try { await guarded() } catch { receipt = { state: 'failed', code: 'qzone_source_unavailable' } }
        }
        const observedAt = now(), visitId = kind === 'visit' && receipt.state === 'confirmed' ? randomUUID() : undefined
        const evidence = receipt.state !== 'confirmed' ? undefined : kind === 'publish' && receipt.postId ? { ownPost: {
          account: action.binding.target.account, agentId: action.binding.agentId, postId: receipt.postId, source: action.binding,
        } } : kind === 'visit' && action.operation.kind === 'visit' && receipt.feeds && visitId ? { visit: {
          id: visitId, binding: action.binding, sourceId: identity, userId: action.operation.userId, postIds: receipt.feeds.map(feed => feed.postId), observedAt, expiresAt: observedAt + 900_000,
        } } : undefined
        try {
          // Settlement must run after cancellation as well. A bounded storage failure leaves the permanent pending fence.
          let timeout: ReturnType<typeof setTimeout> | undefined
          const saved = await Promise.race([ledger.settle(pending, receipt.state, evidence), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 5000) })]).finally(() => { if (timeout) clearTimeout(timeout) })
          if (saved !== true) throw invalid()
        } catch {
          emit('qzone_settlement_failed', 'unknown')
          return { state: 'unknown', kind, code: 'qzone_settlement_failed', terminal: true }
        }
        if (receipt.state !== 'confirmed') {
          emit(receipt.state === 'unknown' ? 'qzone_outcome_unknown' : 'qzone_rejected', receipt.state)
          return { state: receipt.state, kind, code: receipt.state === 'unknown' ? 'qzone_outcome_unknown' : 'qzone_rejected', terminal: dispatched && !readsFeed || receipt.state === 'unknown' }
        }
        if (readsFeed) {
          // Settlement can itself await durable storage while the source is withdrawn. Never release a late private feed.
          try { await authorize() }
          catch { emit('qzone_source_unavailable'); return fail('qzone_source_unavailable') }
        }
        return { state: 'confirmed', kind, terminal: !readsFeed,
          ...('postId' in receipt && receipt.postId ? { postId: receipt.postId } : {}),
          ...(readsFeed && receipt.feeds ? { feeds: receipt.feeds, ...(visitId ? { visitId } : {}) } : {}) }
      } catch {
        emit(claimed ? 'qzone_outcome_unknown' : 'qzone_source_unavailable', claimed ? 'unknown' : 'failed')
        return { state: claimed ? 'unknown' : 'failed', kind, code: claimed ? 'qzone_outcome_unknown' : 'qzone_source_unavailable', terminal: claimed }
      } finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
    },
  }
}
