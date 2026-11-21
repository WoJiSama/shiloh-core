import { ClientClosedError, ClientOfflineError, ConnectionTimeoutError, createClient, ErrorReply,
  SocketClosedUnexpectedlyError, TimeoutError, type RedisClientOptions } from '@redis/client'
import { randomUUID } from 'node:crypto'

const heartbeatMs = 10_000
const leaseMs = 45_000
const commandTimeoutMs = 2_000
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
  } catch { throw new Error('独立宿主 Redis 地址无效') }
  const client = createClient({ ...connection, disableOfflineQueue: true, commandOptions: { timeout: commandTimeoutMs } })
  client.on('error', () => {})
  try { await client.connect() }
  catch { throw new Error('独立宿主无法连接 Redis') }
  return client
}

type RedisCommandOperation = 'redis_command' | 'semantic_redis_command'
type RedisFailureCode = 'redis_command_queue_timeout' | 'redis_connection_unavailable' | 'redis_command_rejected' |
  'redis_command_queue_full' | 'redis_command_reply_timeout' | 'redis_command_failed'
class SemanticRedisQueueFull extends Error {}
class SemanticRedisReplyTimeout extends Error {}

export async function openAgentRedis({ url, instance, onLost, onCommandFailure }: {
  url: string
  instance: string
  onLost(): void
  onCommandFailure?(event: { operation: RedisCommandOperation; outcome: 'failed' | 'unknown'; code: RedisFailureCode; durationMs: number }): void
}) {
  const client = await connectAgentRedis(url)
  const prefix = agentRedisPrefix(instance)
  const key = (value: string) => prefix + value
  const token = randomUUID()
  const leaseKey = key('agent:host-lease')
  let expiresAt = performance.now() + leaseMs
  try {
    if (await client.set(leaseKey, token, { NX: true, PX: leaseMs }) !== 'OK') throw new Error('lease unavailable')
  } catch {
    client.destroy()
    throw new Error('独立宿主未取得 Redis 执行租约，请确认同一实例只有一个进程且 Redis 可写')
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

  async function observe<T>(operation: RedisCommandOperation, run: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try { return await run() }
    catch (error) {
      if (running && onCommandFailure) {
        let code: RedisFailureCode = 'redis_command_failed'
        if (error instanceof SemanticRedisQueueFull) code = 'redis_command_queue_full'
        else if (error instanceof SemanticRedisReplyTimeout) code = 'redis_command_reply_timeout'
        else if (error instanceof TimeoutError) code = 'redis_command_queue_timeout'
        else if (error instanceof ClientClosedError || error instanceof ClientOfflineError ||
          error instanceof SocketClosedUnexpectedlyError || error instanceof ConnectionTimeoutError) code = 'redis_connection_unavailable'
        else if (error instanceof ErrorReply) code = 'redis_command_rejected'
        try {
          onCommandFailure({ operation, code, outcome: code === 'redis_command_reply_timeout' ? 'unknown' : 'failed',
            durationMs: performance.now() - started })
        }
        catch { /* The observer cannot change Redis command results. */ }
      }
      throw error
    }
  }

  function evaluate(connection: typeof client, script: string, keys: string[], args: string[]): Promise<unknown> {
    if (!isCurrent()) { loseLease(); return Promise.reject(new Error('独立宿主执行租约已失效')) }
    return connection.eval(guardedWrite + script, { keys: [...keys.map(key), leaseKey], arguments: [...args, token] }).catch(error => {
      if (error instanceof Error && error.message.includes('agent host lease lost')) loseLease()
      throw error
    })
  }

  const primary = <T>(run: () => Promise<T>) => observe('redis_command', run)
  const storage = {
    get: (name: string) => primary(() => client.get(key(name))),
    async getMany(names: string[]): Promise<(string | null)[]> {
      const values: unknown = await primary(() => client.eval(getMany, { keys: names.map(key), arguments: [] }))
      if (!Array.isArray(values) || values.length !== names.length || !values.every((value): value is string | null => value === null || typeof value === 'string')) {
        throw new Error('Redis 批量读取结果无效')
      }
      return values
    },
    async matchesStringDigests(names: string[], digests: string[]): Promise<boolean> {
      return await primary(() => client.eval(matchStringDigests, { keys: names.map(key), arguments: digests })) === 1
    },
    set(name: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean }) {
      const args = [value]
      if (options?.NX) args.push('NX')
      if (options?.PX !== undefined) args.push('PX', String(options.PX))
      else if (options?.EX !== undefined) args.push('EX', String(options.EX))
      return primary(() => evaluate(client, setValue, [name], args))
    },
    del: (...names: string[]) => names.length ? primary(() => evaluate(client, deleteKeys, names, [])) : Promise.resolve(0),
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => primary(() => evaluate(client, script, options.keys, options.arguments)),
    async *scanIterator(options: { MATCH: string; COUNT: number }) {
      for await (const names of client.scanIterator({ ...options, MATCH: key(options.MATCH) })) {
        yield names.map(name => name.slice(prefix.length))
      }
    },
    async keys(pattern: string): Promise<string[]> {
      const keys = []
      for await (const names of storage.scanIterator({ MATCH: pattern, COUNT: 100 })) keys.push(...names)
      return keys
    },
  }

  // Multi-megabyte semantic values must not sit ahead of inbox and lease commands
  // in the same socket write queue. Both connections use the same lease token.
  let semanticClient: typeof client | undefined
  let semanticTail = Promise.resolve()
  let pendingSemantic = 0
  function semantic<T>(run: (connection: typeof client) => Promise<T>): Promise<T> {
    return observe('semantic_redis_command', async () => {
      if (pendingSemantic >= semanticQueueLimit) throw new SemanticRedisQueueFull()
      pendingSemantic++
      const work = semanticTail.then(async () => {
        if (!isCurrent()) throw new Error('独立宿主执行租约已失效')
        if (!semanticClient?.isReady) {
          if (semanticClient?.isOpen) semanticClient.destroy()
          semanticClient = client.duplicate()
          semanticClient.on('error', () => {})
          await semanticClient.connect()
        }
        if (!isCurrent()) throw new Error('独立宿主执行租约已失效')
        const connection = semanticClient
        let timedOut = false
        const timeout = setTimeout(() => {
          timedOut = true
          if (connection.isOpen) connection.destroy()
        }, commandTimeoutMs)
        timeout.unref()
        try { return await run(connection) }
        catch (error) { if (timedOut) throw new SemanticRedisReplyTimeout(); throw error }
        finally { clearTimeout(timeout) }
      })
      semanticTail = work.then(() => {}, () => {})
      try { return await work } finally { pendingSemantic-- }
    })
  }
  const semanticStorage = {
    get: (name: string) => semantic(connection => connection.get(key(name))),
    getSnapshot: (names: string[]) => semantic(async connection => {
      // Native GET replies avoid copying large values through the Lua interpreter.
      const request = connection.multi().get(leaseKey)
      for (const name of names) request.get(key(name))
      const [lease, ...values]: unknown[] = await request.exec()
      if (lease !== token) { loseLease(); throw new Error('独立宿主执行租约已失效') }
      if (values.length !== names.length || !values.every((value): value is string | null => value === null || typeof value === 'string')) {
        throw new Error('Redis 快照读取结果无效')
      }
      return values
    }),
    matchesStringDigests: (names: string[], digests: string[]) =>
      semantic(async connection => await connection.eval(matchStringDigests, { keys: names.map(key), arguments: digests }) === 1),
    eval: (script: string, options: { keys: string[]; arguments: string[]; isCurrent?: () => boolean }) =>
      semantic(connection => options.isCurrent?.() === false ? Promise.resolve(0) : evaluate(connection, script, options.keys, options.arguments)),
  }

  return {
    storage,
    semanticStorage,
    isCurrent,
    async close(): Promise<void> {
      running = false
      clearInterval(timer)
      if (semanticClient?.isOpen) semanticClient.destroy()
      await semanticTail
      await heartbeat
      try { if (client.isReady) await client.eval(releaseLease, { keys: [leaseKey], arguments: [token] }) }
      finally { if (client.isOpen) await client.close() }
    },
  }
}
