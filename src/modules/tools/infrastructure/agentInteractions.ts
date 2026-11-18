import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentInteraction, AgentInteractionPlan, AgentInteractionResult, InteractionReceipt, SendInteractionAction } from '../../../contracts/agentInteraction.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { createAgentDiagnostics, type AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { conversationAddressKey, isPlatformAccount, isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'

const invalid = () => new Error('互动计划或来源无效')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u
const RETAIN_SECONDS = 7 * 86_400
const PREFIX = 'agent:interaction:v1:'
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    result[key] = field.value
  }
  return result
}
function token(input: unknown, maximum = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > maximum || input !== input.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) throw invalid()
  return input
}
function user(input: unknown): Readonly<PlatformUserRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  const result = { platform: token(row.platform, 64), namespace: token(row.namespace), id: token(row.id) }
  if (!isPlatformAccount(result)) throw invalid()
  return Object.freeze(result)
}
function address(input: unknown): Readonly<ConversationAddress> {
  const row = data(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group' && row.kind !== 'private') throw invalid()
  return Object.freeze({ account: user(row.account), kind: row.kind, id: token(row.id) })
}
function binding(input: unknown): Readonly<AgentBindingSnapshot> {
  const row = data(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  if (row.source !== 'configured' && row.source !== 'legacy') throw invalid()
  return Object.freeze({ source: row.source, id: token(row.id, 4096), revision: token(row.revision, 4096),
    agentId: token(row.agentId), personaId: token(row.personaId), connectionId: token(row.connectionId), target: address(row.target) })
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || !input.length || input.length > maximum ||
      Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
  return Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw invalid()
    return field.value
  })
}

export function validateAgentInteraction(input: unknown, account?: PlatformAccountRef): Readonly<AgentInteraction> {
  const row = data(input, ['kind', 'user', 'count', 'messageId', 'emojiId', 'seconds', 'enabled', 'name', 'requester'])
  if (row.kind === 'member-mute' || row.kind === 'group-mute' || row.kind === 'member-card') {
    const allowed = row.kind === 'group-mute' ? ['kind', 'enabled', 'requester'] : row.kind === 'member-mute' ? ['kind', 'user', 'seconds', 'requester'] : ['kind', 'user', 'name', 'requester']
    if (Object.keys(row).length !== allowed.length || Object.keys(row).some(key => !allowed.includes(key))) throw invalid()
    const requester = user(row.requester)
    if (account && !samePlatformNamespace(requester, user(account))) throw invalid()
    if (row.kind === 'group-mute') {
      if (typeof row.enabled !== 'boolean') throw invalid()
      return Object.freeze({ kind: row.kind, enabled: row.enabled, requester })
    }
    const selected = user(row.user)
    if (!samePlatformNamespace(requester, selected) || account && !samePlatformNamespace(selected, user(account))) throw invalid()
    if (row.kind === 'member-mute') {
      if (typeof row.seconds !== 'number' || !Number.isSafeInteger(row.seconds) || row.seconds < 0 || row.seconds > 30 * 86_400) throw invalid()
      return Object.freeze({ kind: row.kind, user: selected, seconds: row.seconds, requester })
    }
    if (typeof row.name !== 'string' || [...row.name].length > 60 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(row.name)) throw invalid()
    return Object.freeze({ kind: row.kind, user: selected, name: row.name, requester })
  }
  if (row.kind === 'message-recall') {
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, 'messageId') || !isPlatformIdentifier(row.messageId) || row.messageId === '0') throw invalid()
    return Object.freeze({ kind: row.kind, messageId: row.messageId })
  }
  if (row.kind === 'message-reaction') {
    if (Object.keys(row).length !== 3 || row.user !== undefined || row.count !== undefined || !isPlatformIdentifier(row.messageId) || row.messageId === '0' ||
        typeof row.emojiId !== 'string' || !/^[1-9]\d{0,5}$/u.test(row.emojiId)) throw invalid()
    const id = Number(row.emojiId)
    if (!(id >= 1 && id <= 500 || id >= 127801 && id <= 128563)) throw invalid()
    return Object.freeze({ kind: row.kind, messageId: row.messageId, emojiId: row.emojiId })
  }
  if (row.kind !== 'poke' && row.kind !== 'profile-like' || Object.keys(row).length !== (row.kind === 'poke' ? 2 : 3) ||
      row.messageId !== undefined || row.emojiId !== undefined || row.kind === 'poke' && Object.hasOwn(row, 'count')) throw invalid()
  const selected = user(row.user)
  if (account && !samePlatformNamespace(selected, user(account))) throw invalid()
  if (row.kind === 'poke') return Object.freeze({ kind: row.kind, user: selected })
  if (typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 20) throw invalid()
  return Object.freeze({ kind: row.kind, user: selected, count: row.count })
}

export function validateAgentInteractionPlan(input: unknown, account?: PlatformAccountRef): Readonly<AgentInteractionPlan> {
  const row = data(input, ['version', 'kind', 'operations'])
  if (row.version !== 1 || !['poke', 'profile-like', 'message-reaction', 'message-recall', 'member-mute', 'group-mute', 'member-card'].includes(row.kind as string)) throw invalid()
  const kind = row.kind as AgentInteraction['kind']
  const operations = array(row.operations, kind === 'poke' ? 100 : kind === 'message-reaction' || kind === 'member-mute' ? 20 : 1).map(value => validateAgentInteraction(value, account))
  if (operations.some(operation => operation.kind !== kind)) throw invalid()
  if (kind === 'poke') {
    const counts = new Map<string, number>()
    for (const operation of operations) {
      if (operation.kind !== 'poke') throw invalid()
      const key = platformAccountKey(operation.user), count = (counts.get(key) ?? 0) + 1
      if (count > 10) throw invalid()
      counts.set(key, count)
    }
    if (counts.size > 20) throw invalid()
  }
  if (kind === 'member-mute') {
    const seen = new Set<string>(), requesters = new Set<string>()
    for (const operation of operations) {
      if (operation.kind !== 'member-mute') throw invalid()
      const selected = platformAccountKey(operation.user)
      if (seen.has(selected)) throw invalid()
      seen.add(selected); requesters.add(platformAccountKey(operation.requester))
    }
    if (requesters.size !== 1) throw invalid()
  }
  return Object.freeze({ version: 1, kind, operations: Object.freeze(operations) })
}

export function validateAgentInteractionAction(input: unknown): Readonly<SendInteractionAction> {
  const row = data(input, ['version', 'kind', 'target', 'binding', 'interaction'])
  if (row.version !== 1 || row.kind !== 'conversation.interact') throw invalid()
  const target = address(row.target), selected = binding(row.binding)
  if (conversationAddressKey(selected.target) !== conversationAddressKey(target)) throw invalid()
  const interaction = validateAgentInteraction(row.interaction, target.account)
  if (target.kind === 'private' && interaction.kind !== 'message-recall' && interaction.kind !== 'profile-like') throw invalid()
  return Object.freeze({ version: 1, kind: 'conversation.interact', target, binding: selected, interaction })
}
export const validateSendInteractionAction = validateAgentInteractionAction

export function normalizeInteractionReceipt(input: unknown): InteractionReceipt {
  try {
    const row = data(input, ['state', 'code'])
    if (row.state === 'failed' && (row.code === undefined || typeof row.code === 'string' && codePattern.test(row.code))) {
      return Object.freeze({ state: 'failed', ...(row.code === undefined ? {} : { code: row.code as string }) })
    }
    if ((row.state === 'confirmed' || row.state === 'unknown') && !Object.hasOwn(row, 'code')) return Object.freeze({ state: row.state })
  } catch { /* Malformed native/host results cannot establish confirmation. */ }
  return Object.freeze({ state: 'unknown' })
}

const resultCodes = new Set([
  'interaction_invalid_request', 'interaction_invalid_result', 'interaction_already_confirmed', 'interaction_already_failed',
  'interaction_already_unknown', 'interaction_claim_conflict', 'interaction_claim_failed', 'interaction_cancelled',
  'interaction_source_unavailable', 'interaction_outcome_unknown', 'interaction_rejected', 'interaction_progress_failed',
  'interaction_settlement_failed',
])

/** Host results own no behavior and cannot under-report a confirmed plan's budget. */
export function normalizeAgentInteractionResult(input: unknown, requested: number): Readonly<AgentInteractionResult> {
  const expected = Number.isSafeInteger(requested) && requested >= 0 && requested <= 100 ? requested : 0
  try {
    if (expected !== requested) throw invalid()
    const row = data(input, ['state', 'completed', 'requested', 'code'])
    if (!['confirmed', 'failed', 'unknown'].includes(row.state as string) || row.requested !== expected ||
        typeof row.completed !== 'number' || !Number.isSafeInteger(row.completed) || row.completed < 0 || row.completed > expected ||
        row.state === 'confirmed' && (expected < 1 || row.completed !== expected) ||
        row.code !== undefined && (typeof row.code !== 'string' || !resultCodes.has(row.code))) throw invalid()
    return Object.freeze({ state: row.state as AgentInteractionResult['state'], completed: row.completed, requested: expected,
      ...(row.code === undefined ? {} : { code: row.code as string }) })
  } catch { return Object.freeze({ state: 'unknown', completed: 0, requested: expected, code: 'interaction_invalid_result' }) }
}

type RecordState = 'pending' | InteractionReceipt['state']
interface Attempt { readonly version: 1; readonly state: RecordState; readonly planHash: string; readonly tokenHash: string; readonly completed: number; readonly requested: number }
const checked = `local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='string' then return redis.error_reply('invalid interaction key') end\n`
const claim = checked + `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return '' end return redis.call('GET',KEYS[1])`
const compare = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return 1`
const settle = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`
function attempt(input: unknown): Attempt {
  const row = data(input, ['version', 'state', 'planHash', 'tokenHash', 'completed', 'requested'])
  if (row.version !== 1 || !['pending', 'confirmed', 'failed', 'unknown'].includes(row.state as string) ||
      typeof row.planHash !== 'string' || !/^[a-f\d]{64}$/u.test(row.planHash) || typeof row.tokenHash !== 'string' || !/^[a-f\d]{64}$/u.test(row.tokenHash) ||
      typeof row.completed !== 'number' || !Number.isSafeInteger(row.completed) || typeof row.requested !== 'number' || !Number.isSafeInteger(row.requested) ||
      row.requested < 1 || row.requested > 100 || row.completed < 0 || row.completed > row.requested || row.state === 'confirmed' && row.completed !== row.requested) throw invalid()
  return row as unknown as Attempt
}

export interface AgentInteractionExecution {
  readonly binding: AgentBindingSnapshot
  readonly identity: string
  readonly plan: AgentInteractionPlan
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  validateOperation(operation: AgentInteraction): Promise<boolean>
  dispatch(action: SendInteractionAction, guard: { readonly signal: AbortSignal; isCurrent(): boolean; ensureCurrent(): Promise<void> }): Promise<InteractionReceipt>
}
export interface AgentInteractionWorkflowOptions { readonly diagnostics?: AgentDiagnostics; readonly timeoutMs?: number }

/** A seven-day claim owns the whole plan, including partial and uncertain outcomes. */
export function createAgentInteractionWorkflow(storage: AgentInboxRedis, options: AgentInteractionWorkflowOptions = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.eval !== 'function') throw invalid()
  const diagnostics = options.diagnostics ?? createAgentDiagnostics(), timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240_000) throw invalid()
  const emit = (code: string, outcome: 'failed' | 'unknown' | 'cancelled' = 'failed') => {
    try { diagnostics.emit({ stage: 'delivery', operation: 'interaction', outcome, code }) }
    catch { console.warn('[Agent] delivery/interaction failed interaction_diagnostics_failed') }
  }
  const stored = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(invalid()), Math.min(timeoutMs, 5000))
    operation.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); reject(invalid()) })
  })
  return {
    async execute(input: AgentInteractionExecution): Promise<AgentInteractionResult> {
      let selected: AgentBindingSnapshot, plan: AgentInteractionPlan, identity: string
      try {
        selected = binding(input.binding); plan = validateAgentInteractionPlan(input.plan, selected.target.account); identity = token(input.identity, 4096)
        for (const interaction of plan.operations) validateAgentInteractionAction({ version: 1, kind: 'conversation.interact', target: selected.target, binding: selected, interaction })
        if (types.isProxy(input.signal) || !(input.signal instanceof AbortSignal) || [input.isCurrent, input.ensureCurrent, input.validateOperation, input.dispatch].some(value => typeof value !== 'function' || types.isProxy(value))) throw invalid()
      } catch { emit('interaction_invalid_request'); return { state: 'failed', completed: 0, requested: 0, code: 'interaction_invalid_request' } }
      const key = PREFIX + hash(JSON.stringify([selected, identity, plan.kind])), requested = plan.operations.length
      let row: Attempt = { version: 1, state: 'pending', planHash: hash(JSON.stringify(plan)), tokenHash: hash(randomUUID()), completed: 0, requested }
      let pending = JSON.stringify(row)
      try {
        const previous = await stored(storage.eval(claim, { keys: [key], arguments: [pending, String(RETAIN_SECONDS)] }))
        if (previous !== '') {
          if (typeof previous !== 'string' || previous.length > 1024) throw invalid()
          const saved = attempt(JSON.parse(previous)), uncertain = saved.state === 'pending' || saved.state === 'unknown'
          const state = uncertain ? 'unknown' : 'failed'
          const code = saved.planHash !== row.planHash ? 'interaction_claim_conflict'
            : uncertain ? 'interaction_already_unknown' : saved.state === 'confirmed' ? 'interaction_already_confirmed' : 'interaction_already_failed'
          emit(code, state)
          return { state, completed: 0, requested, code }
        }
      } catch { emit('interaction_claim_failed'); return { state: 'failed', completed: 0, requested, code: 'interaction_claim_failed' } }
      const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, input.signal]), timer = setTimeout(() => cancel.abort(), timeoutMs)
      const current = () => { try { return !signal.aborted && input.isCurrent() === true } catch { return false } }
      const watcher = setInterval(() => { if (!current()) cancel.abort() }, 25)
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => reject(invalid()), clear = () => signal.removeEventListener('abort', abort)
        promise.then(value => { clear(); resolve(value) }, () => { clear(); reject(invalid()) })
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
      const ensure = async () => { if (!current()) throw invalid(); await wait(Promise.resolve().then(() => input.ensureCurrent())); if (!current()) throw invalid() }
      const write = async (state: RecordState, completed: number) => {
        const next: Attempt = { ...row, state, completed }, serialized = JSON.stringify(next)
        if (Number(await stored(storage.eval(settle, { keys: [key], arguments: [pending, serialized] }))) !== 1) throw invalid()
        row = next; pending = serialized
      }
      let state: InteractionReceipt['state'] = 'confirmed', completed = 0, resultCode: string | undefined
      try {
        for (const interaction of plan.operations) {
          const authorize = async () => {
            await ensure()
            if (await wait(Promise.resolve().then(() => input.validateOperation(interaction))) !== true) throw invalid()
            await ensure()
            if (Number(await wait(stored(storage.eval(compare, { keys: [key], arguments: [pending] })))) !== 1 || !current()) throw invalid()
          }
          try { await authorize() }
          catch { state = 'failed'; resultCode = signal.aborted ? 'interaction_cancelled' : 'interaction_source_unavailable'; emit(resultCode, signal.aborted ? 'cancelled' : 'failed'); break }
          let receipt: InteractionReceipt, dispatched = false
          try {
            const action = validateAgentInteractionAction({ version: 1, kind: 'conversation.interact', target: selected.target, binding: selected, interaction })
            if (!current()) { state = 'failed'; resultCode = 'interaction_cancelled'; emit(resultCode, 'cancelled'); break }
            receipt = normalizeInteractionReceipt(await wait(Promise.resolve().then(() => {
              if (!current()) throw invalid()
              dispatched = true
              return input.dispatch(action, { signal, isCurrent: current, ensureCurrent: authorize })
            })))
          } catch { receipt = dispatched ? { state: 'unknown' } : { state: 'failed', code: 'interaction_cancelled' } }
          if (receipt.state !== 'confirmed') {
            state = receipt.state; resultCode = receipt.state === 'unknown' ? 'interaction_outcome_unknown' : 'interaction_rejected'; emit(resultCode, state); break
          }
          completed++
          try { await write('pending', completed) }
          catch { state = 'unknown'; resultCode = 'interaction_progress_failed'; emit(resultCode, 'unknown'); break }
        }
        try { await write(state, completed) }
        catch { state = 'unknown'; resultCode = 'interaction_settlement_failed'; emit(resultCode, 'unknown') }
        return { state, completed, requested, ...(resultCode ? { code: resultCode } : {}) }
      } finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
    },
  }
}

export { createAgentInteractionTools } from './agentInteractionTools.js'
export type { AgentInteraction, AgentInteractionPlan, AgentInteractionResult, InteractionReceipt, SendInteractionAction } from '../../../contracts/agentInteraction.js'
