import type { CognitionGuard, CognitionRedis, CognitionState } from '../../../contracts/agentCognition.js'
import { COGNITION_LIMITS, cognitionKey, createEmptyCognitionState, validateCognitionState, validateCognitionTransition } from '../domain/cognitionState.js'
import { agentErrorDetails, annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'

const COMMIT = `local prior=redis.call('GET',KEYS[1])
if ARGV[1]=='0' then if prior then return 0 end elseif prior~=ARGV[2] then return 0 end
if ARGV[3]=='set' then redis.call('SET',KEYS[1],ARGV[4]) end
return 1`
const queues = new WeakMap<object, Map<string, Promise<void>>>()
const fail = (): never => { throw new Error('认知存储不可用或状态无效，已停止读写') }
const current = (guard: CognitionGuard) => {
  if (!guard || guard.signal?.aborted || guard.isCurrent() !== true) throw annotateAgentError(new Error('认知操作已失效'),
    { step: 'cognition_authorization', cause: 'cognition_authority_changed' })
}
async function check(guard: CognitionGuard) { current(guard); await guard.ensureCurrent?.(); current(guard) }
function decode(raw: unknown, agentId: string): CognitionState {
  if (raw === null || raw === undefined) return createEmptyCognitionState(agentId)
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > COGNITION_LIMITS.bytes) return fail()
  try { return validateCognitionState(JSON.parse(raw), agentId) } catch { return fail() }
}
async function serialized<T>(redis: CognitionRedis, key: string, run: () => Promise<T>): Promise<T> {
  let table = queues.get(redis)
  if (!table) { table = new Map(); queues.set(redis, table) }
  const previous = table.get(key) ?? Promise.resolve()
  const result = previous.then(run, run), tail = result.then(() => {}, () => {})
  table.set(key, tail)
  try { return await result } finally { if (table.get(key) === tail) table.delete(key) }
}

/** CAS protects multiple hosts when eval exists. get/set-only substitutes require one host
 * and the same Redis object: their shared in-process queue is not a distributed lock. */
export function createCognitionStore(redis: CognitionRedis) {
  if (!redis || typeof redis.get !== 'function' || typeof redis.set !== 'function' || redis.eval !== undefined && typeof redis.eval !== 'function') return fail()
  async function read(agentId: string): Promise<CognitionState> {
    return decode(await redis.get(cognitionKey(agentId)), agentId)
  }
  async function update(agentId: string, mutate: (state: CognitionState) => CognitionState | void, guard: CognitionGuard): Promise<CognitionState> {
    const key = cognitionKey(agentId)
    current(guard)
    return serialized(redis, key, async () => {
      let step = 'cognition_authorization'
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          step = 'cognition_authorization'
          await check(guard)
          step = 'cognition_store_read'
          const raw = await redis.get(key)
          step = 'cognition_store_decode'
          const previous = decode(raw, agentId)
          await check(guard)
          step = 'cognition_store_validate'
          const draft = structuredClone(previous), returned = mutate(draft)
          if (returned && typeof (returned as unknown as { then?: unknown }).then === 'function') return fail()
          const next = validateCognitionState(returned ?? draft, agentId)
          validateCognitionTransition(previous, next)
          const changed = JSON.stringify(previous) !== JSON.stringify(next)
          if (changed) {
            if (previous.revision === Number.MAX_SAFE_INTEGER) return fail()
            next.revision = previous.revision + 1
          }
          const encoded = JSON.stringify(next)
          if (Buffer.byteLength(encoded, 'utf8') > COGNITION_LIMITS.bytes) return fail()
          await check(guard)
          step = 'cognition_store_commit'
          if (redis.eval) {
            const result = Number(await redis.eval(COMMIT, { keys: [key], arguments: [raw == null ? '0' : '1', raw == null ? '' : String(raw), changed ? 'set' : 'keep', encoded] }))
            await check(guard)
            if (result === 0) continue
            if (result !== 1) return fail()
          } else if (changed) {
            const result = await redis.set(key, encoded)
            await check(guard)
            if (result !== 'OK') return fail()
          }
          return structuredClone(next)
        }
        throw annotateAgentError(new Error('认知状态持续冲突，请稍后重试'), { cause: 'cognition_store_conflict' })
      } catch (error) {
        const details = agentErrorDetails(error)
        throw annotateAgentError(error, { ...details, step: details?.cause?.startsWith('redis_') ? step : details?.step ?? step })
      }
    })
  }
  return { read, update }
}
