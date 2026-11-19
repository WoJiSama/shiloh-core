import type { AgentBindingSnapshot, ConversationAddress } from '../contracts/agentBinding.js'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleContext, AgentConsoleJson, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, isConversationAddress, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { createSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'
import { createAgentInboxReader, textConversationSeconds, type AgentInboxQueue, type AgentInboxRedis } from '../modules/runtime/infrastructure/agentInbox.js'
import { AGENT_MEDIA_OUTBOX_LIFETIME_MS, AGENT_MEDIA_OUTBOX_RETENTION_SECONDS, createAgentMediaOutboxReader, type AgentMediaOutboxReadStorage } from '../modules/media/infrastructure/agentMediaOutboxLedger.js'

export interface StandaloneAgentPipelineOptions {
  readonly bindings: { list(): readonly AgentBindingSnapshot[]; resolve(target: ConversationAddress): AgentBindingSnapshot | undefined }
  readonly auth: Pick<AgentConsoleAuthPort, 'authorize' | 'isCurrent'>
  readonly storage: AgentInboxRedis & AgentMediaOutboxReadStorage
  /** The runtime owns text-tool and trigger revisions in addition to the complete binding token. */
  readonly inboxBindingToken: (binding: AgentBindingSnapshot, queue: AgentInboxQueue['kind']) => string
  readonly configState: (context: AgentConsoleContext) => Readonly<Record<string, unknown>>
  readonly now?: () => number
}
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }
const states = new Set(['all', 'queued', 'preparing', 'sending', 'completed', 'failed', 'cancelled', 'unknown'])
function query(request: AgentConsoleRequest) {
  if (request.method !== 'GET' || request.pathname !== '/api/pipeline/jobs' || Object.keys(request.params).length ||
      !request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length ||
      Object.keys(request.query).some(key => !['kind', 'status', 'limit'].includes(key))) return fail('invalid_request')
  const { kind = 'all', status = 'all', limit = '100' } = request.query
  if (!['all', 'event', 'delivery'].includes(kind) || !states.has(status) || !/^[0-9]{1,3}$/u.test(limit) || +limit < 1 || +limit > 100) return fail('invalid_request')
  return { kind, status, limit: +limit }
}
function copy(binding: AgentBindingSnapshot): AgentBindingSnapshot {
  if (binding.source !== 'configured' || !isConversationAddress(binding.target)) return fail('conflict')
  return Object.freeze({ source: binding.source, id: binding.id, revision: binding.revision, agentId: binding.agentId,
    personaId: binding.personaId, connectionId: binding.connectionId, target: Object.freeze({ kind: binding.target.kind, id: binding.target.id,
      account: Object.freeze({ platform: binding.target.account.platform, namespace: binding.target.account.namespace, id: binding.target.account.id }) }) })
}
const identity = (binding: AgentBindingSnapshot) => JSON.stringify([conversationAddressKey(binding.target), agentBindingToken(binding)])

/** Reads only source-owned Core metadata. It never acknowledges, recovers or replays a job. */
export function createStandaloneAgentPipeline(options: StandaloneAgentPipelineOptions): AgentConsoleService {
  const inbox = createAgentInboxReader(options.storage), media = createAgentMediaOutboxReader(options.storage)
  return Object.freeze({ operation: 'pipeline.read', method: 'GET', path: '/api/pipeline/jobs', scope: 'global',
    async handle(request: AgentConsoleRequest, context: AgentConsoleContext) {
      const selected = query(request)
      if (context.binding) return fail('invalid_request')
      function baseEnsure() {
        context.ensureCurrent()
        if (context.signal.aborted || !options.auth.isCurrent(context.principal)) return fail('conflict')
      }
      baseEnsure()
      function directory() {
        const rows = options.bindings.list()
        if (!Array.isArray(rows) || rows.length > 256) return fail('unavailable')
        const copied = rows.map(copy).sort((a, b) => identity(a).localeCompare(identity(b)))
        if (new Set(copied.map(row => conversationAddressKey(row.target))).size !== copied.length) return fail('conflict')
        return copied
      }
      const bindings = directory(), expected = JSON.stringify(bindings.map(identity))
      function ensureCurrent() {
        baseEnsure()
        if (JSON.stringify(directory().map(identity)) !== expected) return fail('conflict')
        for (const binding of bindings) {
          const current = options.bindings.resolve(binding.target)
          if (!current || identity(copy(current)) !== identity(binding)) return fail('conflict')
        }
      }
      const guard = createSynchronousGuard(context.signal, ensureCurrent, () => fail('conflict'))
      type Decision = { operation: string; binding?: AgentBindingSnapshot; result: 'allowed' | 'denied' }
      const decisions: Decision[] = []
      async function authorize(operation: string, binding?: AgentBindingSnapshot, remember = true) {
        guard.ensureCurrent()
        let decision: unknown
        try { decision = await options.auth.authorize(context.principal, operation, binding, guard) }
        catch { guard.ensureCurrent(); return fail('unavailable') }
        guard.ensureCurrent()
        if (decision !== 'allowed' && decision !== 'denied') return fail('unavailable')
        if (remember) decisions.push({ operation, ...(binding ? { binding } : {}), result: decision })
        return decision
      }
      if (await authorize('pipeline.read') !== 'allowed') return fail('forbidden')
      const visible = new Map<string, AgentBindingSnapshot>()
      for (const binding of bindings) {
        if (await authorize('bindings.read', binding) === 'allowed' && await authorize('pipeline.read', binding) === 'allowed') visible.set(identity(binding), binding)
      }
      const metadata = (binding: AgentBindingSnapshot) => ({ scopeKey: agentConversationKey(binding), bindingToken: agentBindingToken(binding),
        agentId: binding.agentId, connectionId: binding.connectionId, account: binding.target.account, conversation: binding.target })
      const jobs: Record<string, unknown>[] = []
      let scanTruncated = false
      try {
        if (visible.size && selected.kind !== 'delivery') {
          const accounts = [...new Map([...visible.values()].map(binding => [platformAccountKey(binding.target.account), binding.target.account])).values()]
          const read = await inbox.read(accounts, guard)
          guard.ensureCurrent()
          scanTruncated ||= read.scanTruncated
          for (const row of read.records) {
            const binding = options.bindings.resolve(row.target)
            if (!binding || !visible.has(identity(binding)) || row.bindingToken !== options.inboxBindingToken(binding, row.queue)) continue
            jobs.push({ id: row.id, kind: 'event', state: 'queued', ...metadata(binding), queue: row.queue, eventKind: row.eventKind,
              ...(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }) })
          }
        }
        if (visible.size && selected.kind !== 'event') {
          const read = await media.read({ maxScanned: 1000, limit: 1000, guard })
          guard.ensureCurrent()
          scanTruncated ||= read.scanTruncated
          for (const row of read.records) {
            if (!visible.has(identity(row.binding))) continue
            jobs.push({ id: row.id, kind: 'delivery', state: row.state, ...metadata(row.binding), provider: row.provider,
              createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt,
              attempts: row.prepareAttempts, prepareFailures: row.prepareFailures, nextRetryAt: row.nextAttemptAt, effects: row.effects })
          }
        }
      } catch { guard.ensureCurrent(); return fail('unavailable') }
      for (const decision of decisions) {
        if (await authorize(decision.operation, decision.binding, false) !== decision.result) return fail('conflict')
      }
      guard.ensureCurrent()
      const filtered = jobs.filter(row => selected.status === 'all' || row.state === selected.status)
        .sort((a, b) => Number(b.updatedAt ?? b.occurredAt ?? 0) - Number(a.updatedAt ?? a.occurredAt ?? 0) || String(a.id).localeCompare(String(b.id)))
      const result = filtered.slice(0, selected.limit)
      const { processEpoch } = options.configState(context)
      if (typeof processEpoch !== 'string' || !processEpoch || processEpoch.length > 4096 || /[\u0000-\u001f\u007f]/u.test(processEpoch)) return fail('unavailable')
      guard.ensureCurrent()
      return { kind: 'json' as const, value: { version: 1, mode: 'standalone', processEpoch, observedAt: (options.now ?? Date.now)(),
        returned: result.length, scanTruncated: scanTruncated || filtered.length > selected.limit, jobs: result,
        retention: { inbox: 'until-acknowledged', textQueueIdleSeconds: textConversationSeconds,
          mediaRecordIdleSeconds: AGENT_MEDIA_OUTBOX_RETENTION_SECONDS, mediaTaskLifetimeSeconds: AGENT_MEDIA_OUTBOX_LIFETIME_MS / 1000 },
      } as unknown as AgentConsoleJson }
    },
  })
}
