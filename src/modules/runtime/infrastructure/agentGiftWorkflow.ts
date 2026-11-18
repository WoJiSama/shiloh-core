import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentGiftAction, AgentGiftDeliveryPort, AgentGiftGuard, AgentGiftResult, AgentGiftStorage } from '../../../contracts/agentQqGift.js'
import { giftData, giftInvalid, normalizeAgentGiftReceipt, validateAgentGiftAction } from '../../tools/infrastructure/agentGiftValidation.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const RETENTION_SECONDS = 7 * 86_400
const checked = `local t=redis.call('TYPE',KEYS[1]).ok if t~='none' and t~='string' then return redis.error_reply('invalid gift ledger') end\n`
const claim = checked + `if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return '' end return redis.call('GET',KEYS[1])`
const compare = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return 1`
const settle = checked + `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL');return 1`
interface Attempt { version: 1; state: 'pending' | 'confirmed' | 'failed' | 'unknown'; planHash: string; tokenHash: string }
function saved(input: unknown): Attempt {
  const row = giftData(input, ['version', 'state', 'planHash', 'tokenHash'])
  if (row.version !== 1 || !['pending', 'confirmed', 'failed', 'unknown'].includes(row.state as string) ||
      typeof row.planHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.planHash) || typeof row.tokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.tokenHash)) throw giftInvalid()
  return row as unknown as Attempt
}
export interface AgentGiftExecution extends AgentGiftGuard { readonly action: AgentGiftAction; readonly dispatch: AgentGiftDeliveryPort }

/** The host holds the Redis instance lease. A pending attempt never resumes after restart. */
export function createAgentGiftWorkflow(storage: AgentGiftStorage, options: { readonly timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 40_000
  if (!storage || typeof storage.eval !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240_000) throw giftInvalid()
  const bounded = <T>(promise: Promise<T>, maximum = 5000): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(giftInvalid()), Math.min(maximum, timeoutMs))
    promise.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); reject(giftInvalid()) })
  })
  return Object.freeze({
    async execute(input: AgentGiftExecution): Promise<AgentGiftResult> {
      let action: Readonly<AgentGiftAction>, snapshot: string
      try {
        action = validateAgentGiftAction(input.action); snapshot = JSON.stringify(action)
        if (types.isProxy(input.signal) || !(input.signal instanceof AbortSignal) || [input.isCurrent, input.ensureCurrent, input.dispatch].some(value => typeof value !== 'function' || types.isProxy(value))) throw giftInvalid()
      } catch { return { state: 'failed', completed: 0, code: 'gift_invalid_request' } }
      const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, input.signal]), timer = setTimeout(() => cancel.abort(), timeoutMs)
      const current = () => { try { return !signal.aborted && input.isCurrent() === true && JSON.stringify(validateAgentGiftAction(input.action)) === snapshot } catch { return false } }
      const watcher = setInterval(() => { if (!current()) cancel.abort() }, 25)
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(giftInvalid()) }, clear = () => signal.removeEventListener('abort', abort)
        promise.then(value => { clear(); resolve(value) }, () => { clear(); reject(giftInvalid()) })
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
      })
      const ensure = async () => { if (!current()) throw giftInvalid(); await wait(Promise.resolve().then(() => input.ensureCurrent())); if (!current()) throw giftInvalid() }
      const key = 'agent:gift-display:v1:' + hash(JSON.stringify([action.binding, action.source, action.kind]))
      const row: Attempt = { version: 1, state: 'pending', planHash: hash(JSON.stringify(action.plan)), tokenHash: hash(randomUUID()) }, pending = JSON.stringify(row)
      let claimed = false, dispatched = false, completed: 0 | 1 = 0
      try {
        try { await ensure() } catch { return { state: 'failed', completed: 0, code: 'gift_source_unavailable' } }
        try {
          const previous = await bounded(storage.eval(claim, { keys: [key], arguments: [pending, String(RETENTION_SECONDS)] }))
          if (previous !== '') {
            if (typeof previous !== 'string' || previous.length > 1024) throw giftInvalid()
            const old = saved(JSON.parse(previous)), uncertain = old.state === 'pending' || old.state === 'unknown'
            return { state: uncertain ? 'unknown' : 'failed', completed: 0, code: old.planHash !== row.planHash ? 'gift_claim_conflict' : uncertain ? 'gift_already_unknown' : old.state === 'confirmed' ? 'gift_already_confirmed' : 'gift_already_failed' }
          }
          claimed = true
        } catch { return { state: 'failed', completed: 0, code: 'gift_claim_unavailable' } }
        const authorize = async () => {
          await ensure()
          if (Number(await wait(bounded(storage.eval(compare, { keys: [key], arguments: [pending] })))) !== 1 || !current()) throw giftInvalid()
        }
        let state: AgentGiftResult['state'], code: string | undefined
        try {
          await authorize()
          const receipt = normalizeAgentGiftReceipt(await wait(Promise.resolve().then(() => {
            if (!current()) throw giftInvalid()
            dispatched = true
            return input.dispatch(action, Object.freeze({ signal, isCurrent: current, ensureCurrent: authorize }))
          })))
          state = receipt.state
          if (state === 'confirmed') completed = 1
          else code = state === 'unknown' ? 'gift_outcome_unknown' : 'gift_native_rejected'
          if (!current()) { state = 'unknown'; code = 'gift_outcome_unknown' }
        } catch { state = dispatched ? 'unknown' : 'failed'; code = dispatched ? 'gift_outcome_unknown' : 'gift_source_unavailable' }
        try {
          if (Number(await bounded(storage.eval(settle, { keys: [key], arguments: [pending, JSON.stringify({ ...row, state })] }))) !== 1) throw giftInvalid()
        } catch { state = 'unknown'; code = 'gift_settlement_failed' }
        return { state, completed, ...(code ? { code } : {}) }
      } catch {
        // An unexpected post-claim error leaves the durable pending fence in place.
        return { state: claimed ? 'unknown' : 'failed', completed, code: claimed ? 'gift_outcome_unknown' : 'gift_claim_unavailable' }
      } finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
    },
  })
}
