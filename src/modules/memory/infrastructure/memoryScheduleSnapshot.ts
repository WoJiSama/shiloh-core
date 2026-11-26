import { createHash } from 'node:crypto'

const readChanges = `
local catalog = redis.call('GET', KEYS[1])
if (catalog or false) ~= (ARGV[1] == '1' and ARGV[2] or false) then return false end
local cleanup = redis.call('GET', KEYS[2])
local sameCleanup = (cleanup and redis.sha1hex(cleanup) or 'absent') == ARGV[3]
local result = {cleanup or false}
for i = 3, #KEYS do
  local state = redis.call('GET', KEYS[i])
  if state and sameCleanup and ARGV[i + 1] ~= '' and redis.sha1hex(state) == ARGV[i + 1] then
    result[i - 1] = 1
  else
    result[i - 1] = state or false
  end
end
return result`

type ScheduleRedis = {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
const maxCachedBytes = 8 * 1024 * 1024
const digest = (value: string) => createHash('sha1').update(value).digest('hex')

/** Inspect one atomic catalog and cleanup snapshot. Unchanged partitions need no payload or client-side parsing. */
export function createMemoryScheduleSnapshot<State, Cleanup>(redis: ScheduleRedis, options: {
  catalogKey: string
  cleanupKey: string
  stateKey(id: string): string
  parseCatalog(value: string | null): string[]
  parseCleanup(value: string | null): Cleanup
  project(value: string, id: string, cleanup: Cleanup): State | undefined
}) {
  type Entry = { hash: string; bytes: number; state: State | undefined }
  let cached = new Map<string, Entry>(), cleanupHash = ''
  return async (): Promise<readonly State[] | undefined> => {
    const prior = cached, priorCleanup = cleanupHash
    const catalog = await redis.get(options.catalogKey), ids = options.parseCatalog(catalog)
    const snapshot = await redis.eval(readChanges, {
      keys: [options.catalogKey, options.cleanupKey, ...ids.map(options.stateKey)],
      arguments: [catalog === null ? '0' : '1', catalog ?? '', priorCleanup, ...ids.map(id => prior.get(id)?.hash ?? '')],
    })
    if (snapshot === null) return undefined
    if (!Array.isArray(snapshot) || snapshot.length !== ids.length + 1 ||
        snapshot[0] !== null && typeof snapshot[0] !== 'string') throw new Error('记忆调度快照无效')
    const cleanup = options.parseCleanup(snapshot[0]), next = new Map<string, Entry>(), states: State[] = []
    let remaining = maxCachedBytes
    for (const [index, id] of ids.entries()) {
      const value = snapshot[index + 1]
      const entry = value === 1 ? prior.get(id) : typeof value === 'string'
        ? { hash: digest(value), bytes: Buffer.byteLength(value), state: options.project(value, id, cleanup) }
        : undefined
      if (!entry) throw new Error('记忆调度分区无效')
      if (entry.state !== undefined) states.push(entry.state)
      if (entry.bytes <= remaining) { next.set(id, entry); remaining -= entry.bytes }
    }
    cached = next
    cleanupHash = snapshot[0] === null ? 'absent' : digest(snapshot[0])
    return states
  }
}
