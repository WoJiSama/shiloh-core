import { ClientClosedError, ClientOfflineError, ConnectionTimeoutError, createClient, ErrorReply,
  SocketClosedUnexpectedlyError, SocketTimeoutError, TimeoutError, type RedisClientOptions } from '@redis/client'
import { randomUUID } from 'node:crypto'
import type { AgentDiagnosticDetails } from '../../../contracts/agentDiagnostics.js'
import { annotateAgentError } from './agentDiagnostics.js'

const heartbeatMs = 10_000
const leaseMs = 45_000
const commandTimeoutMs = 2_000
const semanticSocketIdleMs = 15_000
const semanticQueueLimit = 8
const renewLease = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`
const releaseLease = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`
const guardedWrite = `if redis.call('GET', KEYS[#KEYS]) ~= ARGV[#ARGV] then return redis.error_reply('agent host lease lost') end
table.remove(KEYS); table.remove(ARGV)
`
const setValue = `return redis.call('SET', KEYS[1], unpack(ARGV))`
const deleteKeys = `return redis.call('DEL', unpack(KEYS))`
const getMany = `
local values = {}
for i = 1, #KEYS do values[i] = redis.call('GET', KEYS[i]) or false end
return values`
const matchStringDigests = `
for i = 1, #KEYS do
  local value = redis.call('GET', KEYS[i])
  if (value and redis.sha1hex(value) or 'absent') ~= ARGV[i] then return 0 end
end
return 1`

export function agentRedisPrefix(instance: string): string {
  return `bl-agent:${instance}:`
}

export async function connectAgentRedis(url: string) {
  let connection: RedisClientOptions
  try {
    const address = new URL(url)
    const socket = { connectTimeout: 3_000, reconnectStrategy: false } as const
    if (address.protocol !== 'unix:' && address.protocol !== 'redis:' && address.protocol !== 'rediss:') throw new Error('unsupported Redis scheme')
    if (address.protocol === 'unix:' && (address.host || address.search || address.hash || !address.pathname.startsWith('/'))) throw new Error('invalid Unix socket')
    connection = address.protocol === 'unix:'
      ? { socket: { ...socket, path: decodeURIComponent(address.pathname) } }
      : { url, socket }
  } catch { throw annotateAgentError(new Error('独立宿主 Redis 地址无效'), { step: 'configuration', cause: 'redis_address_invalid' }) }
  const client = createClient({ ...connection, disableOfflineQueue: true, commandOptions: { timeout: commandTimeoutMs } })
  client.on('error', () => {})
  try { await client.connect() }
  catch (cause) { throw annotateAgentError(new Error('独立宿主无法连接 Redis', { cause }),
    { step: 'connect', cause: 'redis_connect_failed' }) }
  return client
}

type RedisCommandOperation = 'redis_command' | 'semantic_redis_command' | 'semantic_capture_redis_command'
type RedisCommandStep = 'get' | 'get_many' | 'set' | 'del' | 'eval' | 'scan' | 'snapshot' | 'digest'
type RedisFailureCode = 'redis_command_queue_timeout' | 'redis_connection_unavailable' | 'redis_command_rejected' |
  'redis_command_queue_full' | 'redis_socket_idle_timeout' | 'redis_command_failed' | 'redis_reply_invalid' | 'redis_lease_lost'
class SemanticRedisQueueFull extends Error {}
class RedisInvalidReply extends Error {}
class RedisLeaseLost extends Error {}

export async function openAgentRedis({ url, instance, onLost, onCommandFailure, onReadRecovered }: {
  url: string
  instance: string
  onLost(): void
  onCommandFailure?(event: { operation: RedisCommandOperation; outcome: 'failed' | 'unknown'; code: RedisFailureCode;
    durationMs: number; details: AgentDiagnosticDetails; error: unknown }): void
  onReadRecovered?(durationMs: number, step: 'get' | 'get_many'): void
}) {
  const client = await connectAgentRedis(url)
  const prefix = agentRedisPrefix(instance)
  const key = (value: string) => prefix + value
  const token = randomUUID()
  const leaseKey = key('agent:host-lease')
  let expiresAt = performance.now() + leaseMs
  try {
    if (await client.set(leaseKey, token, { NX: true, PX: leaseMs }) !== 'OK') throw new Error('lease unavailable')
  } catch (cause) {
    client.destroy()
    throw annotateAgentError(new Error('独立宿主未取得 Redis 执行租约，请确认同一实例只有一个进程且 Redis 可写', { cause }),
      { step: 'acquire', cause: 'redis_lease_acquire_failed' })
  }

  let running = true
  const isCurrent = () => running && client.isReady && performance.now() < expiresAt
  const loseLease = () => { if (running) { running = false; onLost() } }
  let heartbeat: Promise<void> | undefined
  const timer = setInterval(() => {
    if (!running || heartbeat) return
    const deadline = performance.now() + leaseMs
    heartbeat = client.eval(renewLease, { keys: [leaseKey], arguments: [token, String(leaseMs)] }).then(result => {
      if (Number(result) !== 1) throw new Error('lease lost')
      expiresAt = deadline
    }).catch(loseLease).finally(() => { heartbeat = undefined })
  }, heartbeatMs)
  timer.unref()
  client.on('end', loseLease)

  type DispatchTurn = { ranAt?: number }
  let pendingDispatchTurn: DispatchTurn | undefined
  function observeDispatchTurn(): DispatchTurn {
    if (pendingDispatchTurn) return pendingDispatchTurn
    const turn: DispatchTurn = {}
    pendingDispatchTurn = turn
    // Node Redis schedules primary writes with setImmediate. A shared probe records
    // whether the check phase ran while a command was waiting, before any retry.
    setImmediate(() => {
      turn.ranAt = performance.now()
      pendingDispatchTurn = undefined
    }).unref()
    return turn
  }

  async function observe<T>(operation: RedisCommandOperation, step: RedisCommandStep, run: () => Promise<T>, readAttempt?: 1 | 2): Promise<T> {
    const started = performance.now()
    let dispatchTurn: DispatchTurn | undefined
    try {
      const request = run()
      if (operation === 'redis_command' && onCommandFailure) dispatchTurn = observeDispatchTurn()
      return await request
    }
    catch (error) {
      let code: RedisFailureCode = 'redis_command_failed'
      if (error instanceof SemanticRedisQueueFull) code = 'redis_command_queue_full'
      else if (error instanceof SocketTimeoutError && operation !== 'redis_command') code = 'redis_socket_idle_timeout'
      else if (error instanceof TimeoutError) code = 'redis_command_queue_timeout'
      else if (error instanceof ClientClosedError || error instanceof ClientOfflineError ||
        error instanceof SocketClosedUnexpectedlyError || error instanceof ConnectionTimeoutError) code = 'redis_connection_unavailable'
      else if (error instanceof ErrorReply) code = 'redis_command_rejected'
      else if (error instanceof RedisInvalidReply) code = 'redis_reply_invalid'
      else if (error instanceof RedisLeaseLost) code = 'redis_lease_lost'
      const waiting = code === 'redis_command_queue_full' || code === 'redis_command_queue_timeout'
      const retryRead = readAttempt === 1 && (step === 'get' || step === 'get_many') && code === 'redis_command_queue_timeout' && isCurrent()
      const uncertain = code === 'redis_socket_idle_timeout' || error instanceof SocketClosedUnexpectedlyError
      const limit = code === 'redis_command_queue_full' ? semanticQueueLimit : code === 'redis_command_queue_timeout' ?
        commandTimeoutMs : code === 'redis_socket_idle_timeout' ? semanticSocketIdleMs : undefined
      const durationMs = performance.now() - started
      const dispatchTiming = code === 'redis_command_queue_timeout' && dispatchTurn ? {
        timeoutOverrunMs: Math.max(0, Math.round(durationMs - commandTimeoutMs)),
        ...(dispatchTurn.ranAt === undefined ? { dispatchTurnPending: true } : {
          dispatchTurnPending: false, dispatchTurnMs: Math.max(0, Math.round(dispatchTurn.ranAt - started)),
        }),
      } : undefined
      const details: AgentDiagnosticDetails = { step, ...(limit === undefined ? {} : { limit }),
        ...dispatchTiming,
        ...(readAttempt === undefined ? {} : { attempt: readAttempt, maxAttempts: 2 }),
        ...(waiting ? { dispatched: false, result: retryRead ? 'retry_scheduled' : 'not_dispatched' }
          : uncertain ? { result: 'confirmation_pending' } : {}) }
      annotateAgentError(error, { cause: code, ...details })
      if (running) try { onCommandFailure?.({ operation, code, outcome: uncertain ? 'unknown' : 'failed',
        details, durationMs, error }) } catch { /* Preserve the command error. */ }
      if (retryRead && isCurrent()) {
        const recovered = await observe(operation, step, run, 2)
        if (running) try { onReadRecovered?.(performance.now() - started, step) } catch { /* Preserve the read result. */ }
        return recovered
      }
      throw error
    }
  }

  function evaluate(connection: typeof client, script: string, keys: string[], args: string[]): Promise<unknown> {
    if (!isCurrent()) { loseLease(); return Promise.reject(new RedisLeaseLost('独立宿主执行租约已失效')) }
    return connection.eval(guardedWrite + script, { keys: [...keys.map(key), leaseKey], arguments: [...args, token] }).catch(error => {
      if (error instanceof Error && error.message.includes('agent host lease lost')) loseLease()
      throw error
    })
  }

  const primary = <T>(step: RedisCommandStep, run: () => Promise<T>) => observe('redis_command', step, run)
  const storage = {
    // TimeoutError removes an unsent command. Retry this read once while the host still owns its lease.
    get: (name: string) => observe('redis_command', 'get', () => client.get(key(name)), 1),
    async getMany(names: string[]): Promise<(string | null)[]> {
      if (!names.length) return []
      return observe('redis_command', 'get_many', async () => {
        const values: unknown = await client.eval(getMany, { keys: names.map(key), arguments: [] })
        if (!Array.isArray(values) || values.length !== names.length || !values.every((value): value is string | null => value === null || typeof value === 'string')) {
          throw new RedisInvalidReply('Redis 批量读取结果无效')
        }
        return values
      }, 1)
    },
    async matchesStringDigests(names: string[], digests: string[]): Promise<boolean> {
      return await primary('digest', () => client.eval(matchStringDigests, { keys: names.map(key), arguments: digests })) === 1
    },
    set(name: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean }) {
      const args = [value]
      if (options?.NX) args.push('NX')
      if (options?.PX !== undefined) args.push('PX', String(options.PX))
      else if (options?.EX !== undefined) args.push('EX', String(options.EX))
      return primary('set', () => evaluate(client, setValue, [name], args))
    },
    del: (...names: string[]) => names.length ? primary('del', () => evaluate(client, deleteKeys, names, [])) : Promise.resolve(0),
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => primary('eval', () => evaluate(client, script, options.keys, options.arguments)),
    async *scanIterator(options: { MATCH: string; COUNT: number }) {
      let cursor = '0'
      do {
        const reply = await primary('scan', () => client.scan(cursor, { ...options, MATCH: key(options.MATCH) }))
        cursor = reply.cursor
        yield reply.keys.map(name => name.slice(prefix.length))
      } while (cursor.toString() !== '0')
    },
    async keys(pattern: string): Promise<string[]> {
      const keys = []
      for await (const names of storage.scanIterator({ MATCH: pattern, COUNT: 100 })) keys.push(...names)
      return keys
    },
  }

  // Large semantic reads, intake and the host lease each have a socket queue.
  // Every writer uses the same lease token.
  function semanticConnection(operation: 'semantic_redis_command' | 'semantic_capture_redis_command') {
    let connection: typeof client | undefined
    let tail = Promise.resolve()
    let pending = 0
    function enqueue<T>(step: RedisCommandStep, run: (connection: typeof client) => Promise<T>): Promise<T> {
      return observe(operation, step, async () => {
        if (pending >= semanticQueueLimit) throw new SemanticRedisQueueFull()
        pending++
        const work = tail.then(async () => {
          if (!isCurrent()) throw new RedisLeaseLost('独立宿主执行租约已失效')
          if (!connection?.isReady) {
            if (connection?.isOpen) connection.destroy()
            connection = client.duplicate({ socket: { ...client.options.socket, socketTimeout: semanticSocketIdleMs } })
            connection.on('error', () => {})
            await connection.connect()
          }
          if (!isCurrent()) throw new RedisLeaseLost('独立宿主执行租约已失效')
          return run(connection)
        })
        tail = work.then(() => {}, () => {})
        try { return await work } finally { pending-- }
      })
    }
    return {
      storage: {
        get: (name: string) => enqueue('get', connection => connection.get(key(name))),
        getSnapshot: (names: string[]) => enqueue('snapshot', async connection => {
          const request = connection.multi().get(leaseKey)
          for (const name of names) request.get(key(name))
          const [lease, ...values]: unknown[] = await request.exec()
          if (lease !== token) { loseLease(); throw new RedisLeaseLost('独立宿主执行租约已失效') }
          if (values.length !== names.length || !values.every((value): value is string | null => value === null || typeof value === 'string')) {
            throw new RedisInvalidReply('Redis 快照读取结果无效')
          }
          return values
        }),
        matchesStringDigests: (names: string[], digests: string[]) =>
          enqueue('digest', async connection => await connection.eval(matchStringDigests, { keys: names.map(key), arguments: digests }) === 1),
        eval: (script: string, options: { keys: string[]; arguments: string[]; isCurrent?: () => boolean }) =>
          enqueue('eval', connection => options.isCurrent?.() === false ? Promise.resolve(0) : evaluate(connection, script, options.keys, options.arguments)),
      },
      async close() {
        if (connection?.isOpen) connection.destroy()
        await tail
      },
    }
  }
  const semantic = semanticConnection('semantic_redis_command')
  const capture = semanticConnection('semantic_capture_redis_command')

  return {
    storage,
    semanticStorage: { ...semantic.storage, captureStorage: capture.storage },
    isCurrent,
    async close(): Promise<void> {
      running = false
      clearInterval(timer)
      await Promise.all([semantic.close(), capture.close()])
      await heartbeat
      try { if (client.isReady) await client.eval(releaseLease, { keys: [leaseKey], arguments: [token] }) }
      finally { if (client.isOpen) await client.close() }
    },
  }
}
