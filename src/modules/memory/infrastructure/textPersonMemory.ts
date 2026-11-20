import type { AgentBindingSnapshot, ConversationAddress } from '../../../contracts/agentBinding.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import type { PersonMemoryStore } from '../../../contracts/personMemory.js'
import type { PersonProfileExtractionContext, PersonProfileExtractor } from '../../../contracts/personProfileExtraction.js'
import type { TextPersonMemoryBatch, TextPersonMemoryConfig, TextPersonMemoryMessage } from '../../../contracts/textPersonMemory.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { conversationAddressKey } from '../../runtime/domain/agentBindings.js'
import { simulationAddressKey } from '../../simulation/infrastructure/simulationAddress.js'
import { groundPersonProfileCandidate, parsePersonProfilePatches } from '../../simulation/domain/personProfile.js'
import { isSimulationUserId } from '../../simulation/domain/simConfig.js'
import { isPersonMemoryRedacted } from '../domain/personMemory.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { agentPersonaScopeId } from '../../runtime/domain/agentBindings.js'
import { classifyBoundary } from './engine/boundary.js'
import { createTextPersonMemoryStore, textPersonMemoryBatchId } from './textPersonMemoryStore.js'
import { PersonProfileExtractionError } from './agentPersonExtractor.js'

type MemoryTurn = { signal: AbortSignal; isCurrent(): boolean; release(): void }

/** One independently revocable task per conversation, role, author and verified private peer. */
export function createTextPersonMemory(ports: {
  redis: AgentInboxRedis
  memory: PersonMemoryStore
  extract?: PersonProfileExtractor
  config(): TextPersonMemoryConfig | undefined
  token(binding: AgentBindingSnapshot): string
  current(batch: TextPersonMemoryBatch): boolean
  available(target: ConversationAddress): boolean
  begin(binding: AgentBindingSnapshot): Promise<MemoryTurn>
  isRecalled(target: ConversationAddress, messageId: string): Promise<boolean>
  logger: { warn(message: string): void }
  diagnostics?: Pick<AgentDiagnostics, 'emit'>
  recordUsage?(input: { scope: string; stage: string; model?: string; usage?: unknown; ms?: number }): void
  now?(): number
}) {
  const store = createTextPersonMemoryStore(ports.redis)
  const now = ports.now ?? Date.now
  const tasks = new Map<string, { target: ConversationAddress; controller: AbortController; promise: Promise<void> }>()
  let stopped = false
  let sweep: Promise<void> | undefined
  const enabled = () => !stopped && ports.config()?.enabled === true && !!ports.extract
  const debounce = () => {
    const value = ports.config()?.userExtractDebounceSeconds
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(3600, value)) * 1000 : 90_000
  }
  const maxBatch = () => {
    const value = ports.config()?.userExtractMaxBatchMessages
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(40, Math.floor(value))) : 6
  }
  const sourceOf = (batch: TextPersonMemoryBatch, message: TextPersonMemoryMessage) => ({
    scene: personMemoryAddress(batch.binding.target, batch.peerId).scene, authorId: batch.subjectId,
    messageId: message.messageId, at: message.at, excerpt: message.text,
  })
  const identityOf = (batch: TextPersonMemoryBatch) => ({
    botId: personMemoryAddress(batch.binding.target).botId, personaId: agentPersonaScopeId(batch.binding.agentId),
  })
  async function allowed(batch: TextPersonMemoryBatch, messages: readonly TextPersonMemoryMessage[]) {
    const state = await ports.memory.getRedactions({ identity: identityOf(batch), subjectId: batch.subjectId })
    const visible: TextPersonMemoryMessage[] = []
    for (const message of await store.filterMessages(batch, [...messages])) {
      if (!await ports.isRecalled(batch.binding.target, message.messageId) &&
          !isPersonMemoryRedacted(sourceOf(batch, message), message.text, state)) visible.push(message)
    }
    return visible
  }
  function invalidate(target: ConversationAddress) {
    for (const task of tasks.values()) {
      if (conversationAddressKey(task.target) === conversationAddressKey(target)) task.controller.abort()
    }
  }
  async function enqueue(incoming: IncomingMessage, binding: AgentBindingSnapshot, isCurrent: () => boolean) {
    if (!enabled() || !isCurrent() || !incoming.messageId || classifyBoundary(incoming.text).verdict === 'drop' || incoming.text.length > 4000 ||
        incoming.parts.some(part => part.kind === 'forward') || incoming.occurredAt > now() + 60_000) return
    const target = binding.target
    if (conversationAddressKey(incoming.conversation) !== conversationAddressKey(target)) return
    const peerId = target.kind === 'private' ? incoming.sender.id : undefined
    const token = ports.token(binding)
    const id = textPersonMemoryBatchId(binding, token, incoming.sender.id, peerId)
    const message = { messageId: incoming.messageId, at: incoming.occurredAt,
      name: (incoming.senderName ?? '').slice(0, 20), text: incoming.text }
    const initial: TextPersonMemoryBatch = { version: 1, id, binding: structuredClone(binding), token,
      subjectId: incoming.sender.id, ...(peerId ? { peerId } : {}), messages: [], dueAt: 0, attempts: 0, retryAt: 0 }
    const current = () => enabled() && isCurrent() && ports.current(initial)
    if (!current() || !(await allowed(initial, [message])).length || !current()) return
    if (!await ports.memory.registerSource({ identity: identityOf(initial), subjectId: initial.subjectId,
      source: sourceOf(initial, message) }, current) || !current()) return
    await store.update(id, saved => {
      const batch = saved ?? initial
      if (batch.messages.some(row => row.messageId === message.messageId) || batch.completedMessageIds?.includes(message.messageId)) return batch
      if (batch.messages.length >= 60) throw new Error('人物事实学习待处理来源已满')
      const messages = [...batch.messages, message]
      return { ...batch, messages, dueAt: messages.length >= maxBatch() ? now() : now() + debounce() }
    }, current)
  }

  async function run(batch: TextPersonMemoryBatch, controller: AbortController) {
    let active = true, usageRecorded = false, timedOut = false
    let turn: MemoryTurn | undefined
    const startedAt = now()
    const target = Object.freeze({ ...batch.binding.target, account: Object.freeze({ ...batch.binding.target.account }) })
    const binding = Object.freeze({ ...batch.binding, target })
    const scopeCurrent = () => {
      try {
        return active && enabled() && turn?.isCurrent() !== false && ports.available(target) && ports.current(batch)
      } catch { return false }
    }
    const current = () => !controller.signal.aborted && scopeCurrent()
    const abortPrivacy = () => controller.abort()
    let rejectAbort!: (reason: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    void aborted.catch(() => {})
    const abort = () => rejectAbort(new Error('人物事实学习已取消'))
    controller.signal.addEventListener('abort', abort, { once: true })
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted])
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    const poll = setInterval(() => { if (!current()) controller.abort() }, 50)
    timer.unref?.(); poll.unref?.()
    let messages: TextPersonMemoryMessage[] = []
    let invalidatedAt = 0
    const ensureCurrent = () => bounded((async () => {
      if (!current()) throw new Error('人物事实学习范围已改变')
      if ((await ports.memory.getSceneRedactions({ identity: identityOf(batch), scene: personMemoryAddress(target, batch.peerId).scene })).invalidatedAt !== invalidatedAt ||
          (await allowed(batch, messages)).length !== messages.length || !current()) throw new Error('人物事实学习来源已改变')
    })())
    try {
      const acquired = await bounded(ports.begin(binding).then(value => {
        if (!active || controller.signal.aborted) { value.release(); throw new Error('人物事实学习已取消') }
        turn = value
        return value
      }))
      acquired.signal.addEventListener('abort', abortPrivacy, { once: true })
      if (acquired.signal.aborted) controller.abort()
      if (!current()) return
      invalidatedAt = (await ports.memory.getSceneRedactions({ identity: identityOf(batch), scene: personMemoryAddress(target, batch.peerId).scene })).invalidatedAt
      const original = batch.result ? batch.messages.filter(row => batch.result!.messageIds.includes(row.messageId)) : batch.messages.slice(0, maxBatch())
      messages = await allowed(batch, original)
      if (messages.length !== original.length) {
        // A stored proposal depends on its exact input. Drop it when any source was revoked.
        const removed = new Set(original.filter(row => !messages.some(safe => safe.messageId === row.messageId)).map(row => row.messageId))
        await store.update(batch.id, saved => {
          if (!saved) return undefined
          const { result: _discarded, ...rest } = saved
          return { ...rest, messages: saved.messages.filter(row => !removed.has(row.messageId)), attempts: 0, retryAt: 0 }
        }, current)
        return
      }
      if (!messages.length) return
      await ensureCurrent()
      let raw = batch.result?.raw
      if (raw === undefined) {
        const context: PersonProfileExtractionContext = Object.freeze({ target, binding, signal: controller.signal,
          isCurrent: current, ensureCurrent,
          recordUsage(model: string, usage: unknown) {
            if (!active || usageRecorded) return
            usageRecorded = true
            ports.recordUsage?.({ scope: simulationAddressKey(target), stage: 'person-profile', model, usage, ms: now() - startedAt })
          },
        })
        const input = Object.freeze(messages.map(row => Object.freeze({ userId: batch.subjectId, name: row.name, text: row.text })))
        raw = await bounded(Promise.resolve().then(() => {
          if (!current()) throw new Error('人物事实学习已取消')
          return ports.extract!(input, current, context)
        }))
        if (typeof raw !== 'string' || raw.length > 64_000 || !Array.isArray(JSON.parse(raw))) throw new Error('人物事实学习返回格式无效')
        await ensureCurrent()
        const result = { raw, messageIds: messages.map(row => row.messageId) }
        // The model result is durable before its first fact write. New ingress is
        // retained by CAS; a crash repeats these exact proposals instead of regenerating them.
        if (!await store.update(batch.id, saved => saved && ({ ...saved, result }), current)) return
      }
      await ensureCurrent()
      const grounding = messages.map(row => ({ userId: batch.subjectId, text: row.text }))
      for (const patch of parsePersonProfilePatches(raw, isSimulationUserId)) {
        if (patch.userId !== batch.subjectId) continue
        for (const entry of patch.entries ?? []) {
          if (!groundPersonProfileCandidate(patch, entry, grounding)) continue
          const message = messages[entry.sourceIndex - 1]!
          await ensureCurrent()
          const result = await ports.memory.remember({ identity: identityOf(batch), subjectId: batch.subjectId,
            text: entry.text, category: entry.category, source: { ...sourceOf(batch, message), excerpt: entry.sourceExcerpt },
            evidenceKind: 'self', sensitivity: entry.sensitivity, portable: target.kind === 'group' && entry.portable, confidence: 0.8,
          }, current)
          if (!result.saved) throw new Error('人物事实学习来源未获准保存')
        }
      }
      await ensureCurrent()
      const completed = new Set(messages.map(row => row.messageId))
      await store.update(batch.id, saved => {
        if (!saved) return undefined
        const { result: _done, ...rest } = saved
        const remaining = saved.messages.filter(row => !completed.has(row.messageId))
        return { ...rest, messages: remaining, attempts: 0, retryAt: 0,
          dueAt: remaining.length >= maxBatch() ? now() : remaining.length ? saved.dueAt : now(),
          completedMessageIds: [...new Set([...(saved.completedMessageIds ?? []), ...completed])].slice(-60) }
      }, current)
    } catch (error) {
      const canRecordFailure = () => current() || timedOut && scopeCurrent()
      if (canRecordFailure()) {
        await store.update(batch.id, saved => saved && ({ ...saved, attempts: saved.attempts + 1,
          retryAt: now() + Math.min(300_000, 15_000 * 2 ** saved.attempts) }), canRecordFailure).catch(() => {})
        const failure = error instanceof PersonProfileExtractionError ? error : undefined
        if (ports.diagnostics) {
          try { ports.diagnostics.emit({ stage: failure ? 'model' : 'memory', operation: 'text_person_profile_extract', outcome: 'failed',
            code: failure?.code ?? (timedOut ? 'extraction_timeout' : 'extraction_failed'),
            ...(failure?.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }), error, durationMs: now() - startedAt }) }
          catch { /* An observer cannot change retry state. */ }
        } else ports.logger.warn('[Agent] 人物事实学习未完成，保留来源等待有限重试')
      }
    } finally {
      active = false
      clearTimeout(timer); clearInterval(poll)
      turn?.signal.removeEventListener('abort', abortPrivacy)
      turn?.release()
      controller.signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }

  function tick(): Promise<void> {
    if (!enabled()) return Promise.resolve()
    if (sweep) return sweep
    sweep = (async () => {
      for (const batch of await store.list()) {
        if (!enabled()) return
        if (!ports.available(batch.binding.target)) continue
        if (!ports.current(batch)) {
          await store.update(batch.id, () => undefined, () => enabled() && !ports.current(batch))
          continue
        }
        if (!batch.messages.length) {
          if (batch.dueAt < now() - 7 * 86_400_000) await store.update(batch.id, saved => saved?.messages.length ? saved : undefined, enabled)
          continue
        }
        if (tasks.size >= 4 || tasks.has(batch.id) || batch.attempts >= 3 || now() < batch.retryAt || now() < batch.dueAt || !ports.available(batch.binding.target)) continue
        const controller = new AbortController()
        const task = run(batch, controller).catch(() => ports.logger.warn('[Agent] 人物事实学习存储暂时不可用'))
          .finally(() => { tasks.delete(batch.id) })
        tasks.set(batch.id, { target: batch.binding.target, controller, promise: task })
      }
    })().catch(() => ports.logger.warn('[Agent] 人物事实学习队列暂时不可用')).finally(() => { sweep = undefined })
    return sweep
  }

  return { enqueue, tick, invalidate, purgeSubject: store.purgeSubject,
    async stop() {
      stopped = true
      for (const task of tasks.values()) task.controller.abort()
      await sweep
      await Promise.allSettled([...tasks.values()].map(task => task.promise))
    },
  }
}
