import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CharacterScope, CharacterState } from '../../../contracts/character.js'
import { annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'
import { characterHistoryCanShrink, characterKey, compactCharacterState, createEmptyCharacterState, validateCharacterState } from '../domain/characterState.js'
import type { SimRedisLike } from './simSessionStore.js'

export interface CharacterRedis extends SimRedisLike {
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

// Also serialize fake/in-process stores that lack Lua. Production Redis uses the token checked commit below.
const queues = new WeakMap<object, Map<string, Promise<unknown>>>()
const COMMIT = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[2], ARGV[2]) redis.call("DEL", KEYS[1]) return 1'
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'
type Mutation = (state: CharacterState) => CharacterState

export function createCharacterStore({ redis, now = Date.now, retainEvidenceRefs }: { redis: CharacterRedis; now?: () => number; retainEvidenceRefs?(scope: CharacterScope): Promise<string[]> }) {
  async function load(scope: CharacterScope): Promise<CharacterState> {
    const raw = await redis.get(characterKey(scope))
    // Do not turn corrupt/failed reads into an empty state that can overwrite history.
    return raw === null ? createEmptyCharacterState(scope) : validateCharacterState(JSON.parse(raw), scope)
  }

  async function prepare(scope: CharacterScope, current: CharacterState, mutate: Mutation): Promise<CharacterState> {
    const next = characterHistoryCanShrink(current)
      ? compactCharacterState(current, now(), await retainEvidenceRefs?.(scope))
      : structuredClone(current)
    return validateCharacterState(mutate(next), scope)
  }

  async function update(scope: CharacterScope, mutate: Mutation, skipUnchanged = false): Promise<CharacterState> {
    const key = characterKey(scope)
    let queue = queues.get(redis)
    if (!queue) { queue = new Map(); queues.set(redis, queue) }
    const previous = queue.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const token = randomUUID()
      const lock = `${key}:lock`
      let acquired = false, failed = false
      if (redis.eval) {
        const deadline = Date.now() + 2500
        do {
          const result = await redis.set(lock, token, { NX: true, PX: 10_000 })
          acquired = result === 'OK' || result === true
          if (!acquired) await new Promise(resolve => setTimeout(resolve, 25))
        } while (!acquired && Date.now() < deadline)
        if (!acquired) throw annotateAgentError(new Error('角色状态正忙，请稍后重试'), { cause: 'character_state_busy', result: 'not_saved' })
      }
      try {
        const current = await load(scope)
        const next = await prepare(scope, current, mutate)
        if (skipUnchanged && isDeepStrictEqual(next, current)) return current
        next.revision = current.revision + 1
        if (redis.eval) {
          const committed = await redis.eval(COMMIT, { keys: [lock, key], arguments: [token, JSON.stringify(next)] })
          if (Number(committed) !== 1) throw annotateAgentError(new Error('角色状态锁已失效，修改未提交'),
            { cause: 'character_state_lock_expired', result: 'not_saved' })
          acquired = false
        } else {
          await redis.set(key, JSON.stringify(next))
        }
        return next
      } catch (error) {
        failed = true
        throw error
      } finally {
        if (acquired) {
          try { await redis.eval!(RELEASE, { keys: [lock], arguments: [token] }) }
          catch (error) { if (!failed) throw error }
        }
      }
    })
    queue.set(key, operation)
    try { return await operation } finally { if (queue.get(key) === operation) queue.delete(key) }
  }
  // Maintenance only accepts a pure transform. Recompute under the lock when a write is required.
  async function maintain(scope: CharacterScope, mutate: Mutation): Promise<CharacterState> {
    const current = await load(scope)
    if (isDeepStrictEqual(await prepare(scope, current, mutate), current)) return current
    return update(scope, mutate, true)
  }

  return { load, update, maintain }
}
