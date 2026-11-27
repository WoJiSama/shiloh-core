import { randomUUID } from 'node:crypto'
import type { DingTalkReplyPolicy } from '../adapters/dingTalkConnection.js'
import type { PlatformConnection } from '../contracts/agentBinding.js'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleService } from '../contracts/agentConsole.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import type { openAgentRedis } from '../modules/runtime/infrastructure/agentRedis.js'
import { readDingTalkReplyPolicy } from './standaloneDingTalkConfig.js'

const revisionPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const replace = `local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`

type State = { readonly raw: string | null; readonly revision: string; readonly policy: DingTalkReplyPolicy }
type Entry = {
  readonly id: string
  readonly key: string
  readonly initial: State
  active: State | undefined
  pending: Promise<void>
}

function decodeState(raw: string | null, initial: State): State {
  if (raw === null) return initial
  const value = JSON.parse(raw) as { revision?: unknown; policy?: unknown } | null
  if (!value || Object.keys(value).length !== 2 || typeof value.revision !== 'string' || !revisionPattern.test(value.revision) || !value.policy) {
    throw new AgentConsoleError('unavailable')
  }
  return { raw, revision: value.revision, policy: readDingTalkReplyPolicy(value.policy, true) }
}

export async function openStandaloneDingTalkReplyPolicies(options: {
  storage: Pick<Awaited<ReturnType<typeof openAgentRedis>>['storage'], 'get' | 'getMany' | 'eval'>
  connections: readonly { connection: PlatformConnection; replyPolicy: DingTalkReplyPolicy }[]
  privateChatEnabled: boolean
  allowsText?(text: string): boolean
  onUnavailable?(): void
}) {
  const { storage, privateChatEnabled } = options
  const entries = options.connections.map(({ connection, replyPolicy }): Entry => ({
    id: connection.id,
    key: 'agent:dingtalk:reply-policy:' + platformAccountKey(connection.account),
    initial: { raw: null, revision: randomUUID(), policy: replyPolicy },
    active: undefined,
    pending: Promise.resolve(),
  }))
  const stored = await storage.getMany(entries.map(row => row.key))
  for (const [index, row] of entries.entries()) {
    try { row.active = decodeState(stored[index]!, row.initial) }
    catch { options.onUnavailable?.() }
  }
  const byId = new Map(entries.map(row => [row.id, row]))

  async function refresh(row: Entry): Promise<State> {
    row.active = undefined
    try {
      row.active = decodeState(await storage.get(row.key), row.initial)
      return row.active
    } catch { throw new AgentConsoleError('unavailable') }
  }

  function ordered<T>(row: Entry, action: (current: State) => Promise<T>): Promise<T> {
    const next = row.pending.then(async () => action(row.active ?? await refresh(row)))
    row.pending = next.then(() => {}, () => {})
    return next
  }

  const response = (row: Entry, state: State) => ({ kind: 'json' as const, value: {
    connectionId: row.id, revision: state.revision, privateChatEnabled, replyPolicy: { ...state.policy },
  } })
  const route = (effect: 'read' | 'write') => AGENT_CONSOLE_SERVICES.find(row => row.operation === 'dingtalk-reply-policy.' + effect)!
  const services: AgentConsoleService[] = byId.size ? [
    { ...route('read'), async handle(request, context) {
      if (Object.keys(request.query).length) throw new AgentConsoleError('invalid_request')
      const row = byId.get(request.params.connectionId ?? '')
      if (!row) throw new AgentConsoleError('not_found')
      return ordered(row, async state => {
        context.ensureCurrent()
        return response(row, state)
      })
    } },
    { ...route('write'), maxBodyBytes: 140 * 1024, async handle(request, context) {
      const body = request.body as Record<string, unknown>
      if (Object.keys(request.query).length || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'replyPolicy') ||
          typeof body.revision !== 'string' || !revisionPattern.test(body.revision)) throw new AgentConsoleError('invalid_request')
      let policy: DingTalkReplyPolicy
      try { policy = readDingTalkReplyPolicy(body.replyPolicy, true) }
      catch { throw new AgentConsoleError('invalid_request') }
      if (options.allowsText?.(JSON.stringify(policy)) === false) throw new AgentConsoleError('invalid_request')
      const row = byId.get(request.params.connectionId ?? '')
      if (!row) throw new AgentConsoleError('not_found')
      return ordered(row, async current => {
        context.ensureCurrent()
        if (body.revision !== current.revision) throw new AgentConsoleError('conflict')
        if (JSON.stringify(current.policy) === JSON.stringify(policy)) return response(row, current)
        const revision = randomUUID()
        const raw = JSON.stringify({ revision, policy })
        let result: unknown
        try { result = await storage.eval(replace, { keys: [row.key], arguments: [current.raw ?? '', raw] }) }
        catch {
          const recovered = await refresh(row).catch(() => undefined)
          if (recovered?.raw === raw) return response(row, recovered)
          throw new AgentConsoleError('commit_outcome_unknown')
        }
        if (result !== 1) {
          await refresh(row)
          throw new AgentConsoleError('conflict')
        }
        row.active = { raw, revision, policy }
        return response(row, row.active)
      })
    } },
  ] : []

  return { current: (connectionId: string) => byId.get(connectionId)?.active?.policy, services }
}
