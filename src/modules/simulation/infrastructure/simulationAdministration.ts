import { AsyncLocalStorage } from 'node:async_hooks'
import type { SimRedisLike } from './simSessionStore.js'

export interface SimulationAdministrationGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): void
  /** Reauthorize after store queues/reads, immediately before the actual Redis mutation. */
  beforeWrite?(): Promise<void>
}

export class SimulationAdministrationConflictError extends Error {
  constructor() { super('simulation_administration_expired'); this.name = 'SimulationAdministrationConflictError' }
}

interface Lease {
  readonly guard: SimulationAdministrationGuard
  readonly locks: Map<string, string>
  active: boolean
}

// These exact token checked scripts are shared by characterStore and scopedStateStore.
// No arbitrary DEL/eval is allowed to bypass a revoked lease for cleanup.
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'
const COMMIT = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[2], ARGV[2]) redis.call("DEL", KEYS[1]) return 1'

function createAdministration(source: SimRedisLike) {
  const context = new AsyncLocalStorage<Lease>()
  let queue: Promise<void> = Promise.resolve()
  function check(lease = context.getStore()): void {
    if (!lease) return
    try {
      if (!lease.active || lease.guard.signal.aborted || !lease.guard.isCurrent()) throw new SimulationAdministrationConflictError()
      lease.guard.ensureCurrent()
    } catch (error) { lease.active = false; throw error }
  }
  async function beforeWrite(lease: Lease | undefined): Promise<void> {
    check(lease)
    try { if (lease?.guard.beforeWrite) await lease.guard.beforeWrite() }
    catch (error) { if (lease) lease.active = false; throw error }
    check(lease)
  }
  async function cleanup(lease: Lease, key: string, token: string): Promise<unknown> {
    if (!source.eval || lease.locks.get(key) !== token) throw new SimulationAdministrationConflictError()
    try { return await source.eval(RELEASE, { keys: [key], arguments: [token] }) }
    finally { lease.locks.delete(key) }
  }
  const redis: SimRedisLike = {
    async get(key) {
      const lease = context.getStore(); check(lease)
      const result = await source.get(key)
      check(lease); return result
    },
    async set(key, value, options) {
      const lease = context.getStore(); await beforeWrite(lease); check(lease)
      const result = await source.set(key, value, options)
      const acquired = lease && key.endsWith(':lock') && options?.NX === true && options.PX === 10_000 && (result === 'OK' || result === true)
      if (acquired) lease.locks.set(key, value)
      try { check(lease) }
      catch (error) {
        // The caller has not observed the acquired lock yet, so its finally cannot release it.
        if (acquired) await cleanup(lease, key, value).catch(() => undefined)
        throw error
      }
      return result
    },
    async del(...keys) {
      const lease = context.getStore(); await beforeWrite(lease); check(lease)
      const result = await source.del(...keys)
      check(lease); return result
    },
    ...(source.keys ? { async keys(pattern: string) {
      const lease = context.getStore(); check(lease)
      const result = await source.keys!(pattern)
      check(lease); return result
    } } : {}),
    ...(source.eval ? { async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      const lease = context.getStore(), key = options.keys[0], token = options.arguments[0]
      if (lease && script === RELEASE && options.keys.length === 1 && options.arguments.length === 1 && key && token && lease.locks.get(key) === token) {
        return cleanup(lease, key, token)
      }
      await beforeWrite(lease); check(lease)
      const result = await source.eval!(script, options)
      check(lease)
      if (lease && script === COMMIT && options.keys.length === 2 && options.arguments.length === 2 && key && token && Number(result) === 1 && lease.locks.get(key) === token) lease.locks.delete(key)
      return result
    } } : {}),
  }
  return {
    redis,
    ensureCurrent: check,
    /** Only scheduler ownership boundaries may deliberately drop the administration lease. */
    background<T>(operation: () => T): T { check(); return context.exit(operation) },
    run<T>(guard: SimulationAdministrationGuard, operation: () => Promise<T>): Promise<T> {
      // Do not let a nested operation deadlock on its own administration queue.
      if (context.getStore()) return Promise.reject(new SimulationAdministrationConflictError())
      const lease: Lease = { guard, active: true, locks: new Map() }
      const result = queue.then(() => context.run(lease, async () => {
        try {
          check(lease)
          const value = await operation()
          check(lease)
          return value
        } finally { lease.active = false }
      }))
      queue = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

type SimulationAdministration = ReturnType<typeof createAdministration>
const administrations = new WeakMap<object, SimulationAdministration>()

/** Preserve store queue identity when two runtime instances share the same local Redis adapter. */
export function createSimulationAdministration(source: SimRedisLike): SimulationAdministration {
  let administration = administrations.get(source)
  if (!administration) {
    administration = createAdministration(source)
    administrations.set(source, administration)
    administrations.set(administration.redis, administration)
  }
  return administration
}
