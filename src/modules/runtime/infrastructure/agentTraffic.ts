import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentDiagnosticEvent } from '../../../contracts/agentDiagnostics.js'
import type { CommitmentRedisLike } from '../../../contracts/commitments.js'
import { agentConversationKey } from '../domain/agentBindings.js'

const dayMs = 86_400_000
const keys = ['received', 'sent', 'failed', 'unknown'] as const
type Counter = typeof keys[number]
const startedKey = 'agent:traffic:v1:started-at'
const day = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10)
const scope = (binding: AgentBindingSnapshot) => createHash('sha256').update(agentConversationKey(binding)).digest('hex')
const dayKey = (date: string) => 'agent:traffic:v1:' + date
const store = `
  local day = KEYS[1]
  if ARGV[2] ~= '' then
    if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', 172800) then return 0 end
  end
  redis.call('HINCRBY', day, ARGV[1], 1)
  redis.call('EXPIRE', day, 7862400)
  return 1
`
const reads = `
  local out = {}
  for i, key in ipairs(KEYS) do
    out[i] = redis.call('HMGET', key, unpack(ARGV))
  end
  return out
`

export function createAgentTraffic(redis: Pick<CommitmentRedisLike, 'eval'>, now = Date.now) {
  return {
    async start() {
      await redis.eval("return redis.call('SET', KEYS[1], ARGV[1], 'NX')", { keys: [startedKey], arguments: [String(now())] })
    },
    async record(event: AgentDiagnosticEvent) {
      if (event.scope.kind !== 'conversation') return
      const key = scope(event.scope.binding)
      let counter: Counter
      let id = ''
      if (event.operation === 'inbound_message' && event.outcome === 'succeeded') {
        counter = 'received'
        id = event.scope.messageId ?? ''
      } else if (event.stage === 'delivery' && event.operation.startsWith('send_') && event.delivery) {
        const { state, messageId } = event.delivery
        if (state === 'confirmed') return
        counter = state === 'sent' || state === 'uploaded' ? 'sent' : state
        if (counter === 'sent') id = messageId ?? ''
      } else return
      const date = day(event.at)
      const eventKey = 'agent:traffic:seen:' + createHash('sha256').update(JSON.stringify([key, counter, id])).digest('hex')
      await redis.eval(store, { keys: [dayKey(date), eventKey], arguments: [key + ':' + counter, id] })
    },
    async list(bindings: readonly AgentBindingSnapshot[], days: number) {
      const dates = Array.from({ length: days }, (_, index) => day(now() - index * dayMs))
      const startedAt = Number(await redis.eval("return redis.call('GET', KEYS[1])", { keys: [startedKey], arguments: [] }))
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error('收发统计尚未初始化')
      const rows = []
      for (let offset = 0; offset < bindings.length; offset += 64) {
        const batch = bindings.slice(offset, offset + 64)
        const fields = batch.flatMap(binding => keys.map(key => scope(binding) + ':' + key))
        const matrix = await redis.eval(reads, { keys: dates.map(dayKey), arguments: fields })
        if (!Array.isArray(matrix) || matrix.length !== dates.length || matrix.some(row => !Array.isArray(row) || row.length !== fields.length)) {
          throw new Error('收发统计暂时无法读取')
        }
        rows.push(...batch.map((binding, index) => ({ scopeKey: agentConversationKey(binding),
          connectionId: binding.connectionId, kind: binding.target.kind, id: binding.target.id,
          daily: dates.map((date, i) => ({
            date,
            ...Object.fromEntries(keys.map((key, k) => [key, Number(matrix[i][index * keys.length + k] ?? 0)])) as Record<Counter, number>,
          })),
        })))
      }
      return { dates, rows, startedAt }
    },
  }
}
