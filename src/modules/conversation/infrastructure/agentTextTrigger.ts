import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import type { AgentTextTriggerDecision, AgentTextTriggerState, ResolvedAgentTextTriggerConfig } from '../../../contracts/agentTextTrigger.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { createAgentTextTriggerState, evaluateAgentTextTrigger, recordAgentTextTriggerGate, recordAgentTextTriggerReply } from '../domain/agentTextTriggerPolicy.js'
import { resolveAgentTextTriggerConfig } from './agentTextTriggerConfig.js'
import { isExplicitToolIntent, isExplicitSearchRequest, isRealtimeInfoRequest } from '../domain/messageIntent.js'

export interface AgentTextTriggerSelected { readonly binding: AgentBindingSnapshot; readonly persona?: { readonly name?: unknown } }
export interface AgentTextTriggerContext<T extends AgentTextTriggerSelected = AgentTextTriggerSelected> {
  readonly incoming: IncomingMessage
  readonly selected: T
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  release(): void
}
export interface AgentTextTriggerGuard { readonly signal: AbortSignal; isCurrent(): boolean; ensureCurrent(): Promise<void> }
export interface AgentTextTriggerHistory { readonly user: string; readonly reply: string; readonly speakerId?: string; readonly replyId?: string }
export interface AgentTextTriggerReceipt { readonly state: 'sent' | 'failed' | 'unknown' | 'cancelled'; readonly text?: string; readonly messageId?: string }
export interface AgentTextTriggerRun<T extends AgentTextTriggerSelected = AgentTextTriggerSelected> {
  readonly incoming: IncomingMessage
  readonly selected: T
  readonly sources: readonly IncomingMessage[]
  readonly reason: 'direct' | 'tracking' | 'smart' | 'repeat'
  readonly quote: boolean
  readonly decision: AgentTextTriggerDecision
  readonly metrics: { readonly lastReplyAt: number; readonly lastReplyToUserId: string | null }
  readonly history: readonly AgentTextTriggerHistory[]
  readonly repeatText?: string
}
export interface AgentTextTriggerPorts<T extends AgentTextTriggerSelected> {
  config(): unknown
  now?(): number
  random?(): number
  gate(input: AgentTextTriggerRun<T>, guard: AgentTextTriggerGuard): Promise<{ readonly decision: 'continue' | 'no_action' | 'wait'; readonly reason: string; readonly waitMs?: number }>
  tracking(input: AgentTextTriggerRun<T>, guard: AgentTextTriggerGuard): Promise<boolean>
  reply(input: AgentTextTriggerRun<T>, guard: AgentTextTriggerGuard): Promise<AgentTextTriggerReceipt>
  repeat?(input: AgentTextTriggerRun<T>, guard: AgentTextTriggerGuard): Promise<AgentTextTriggerReceipt>
  readHistory?(input: AgentTextTriggerRun<T>, guard: AgentTextTriggerGuard): Promise<readonly AgentTextTriggerHistory[]>
  logger?: { warn(message: string): void }
  limits?: { readonly maxConversations?: number; readonly maxPendingPerConversation?: number; readonly sourceTtlMs?: number }
  timers?: { set(callback: () => void, delayMs: number): unknown; clear(timer: unknown): void }
}

/** Timers retain admitted sources, never create a new human/platform event. */
export function createAgentTextTrigger<T extends AgentTextTriggerSelected>(ports: AgentTextTriggerPorts<T>) {
  type Held = { context: AgentTextTriggerContext<T>; expiresAt: number; released: boolean; removeAbort(): void }
  type Job = { kind: 'check' | 'direct' | 'tracking' | 'wait' | 'deferred' | 'debounce' | 'repeat'; sources: Held[];
    decision: AgentTextTriggerDecision; dueAt: number; observedAt: number; dispatching: boolean; resolvingQuote: boolean; controller: AbortController }
  type Slot = { key: string; target: ConversationAddress; token: string; configKey: string; config: ResolvedAgentTextTriggerConfig;
    state: AgentTextTriggerState; seen: Map<string, number>; held: Set<Held>; jobs: Job[]; active: Job | undefined; timer: unknown;
    current: boolean; interruptions: number; touchedAt: number; tracking: Map<string, { until: number; lastCheckAt: number }> }
  const now = () => ports.now?.() ?? Date.now()
  const timers = ports.timers ?? { set(callback: () => void, ms: number) { const timer = setTimeout(callback, ms); timer.unref(); return timer }, clear(timer: unknown) { clearTimeout(timer as ReturnType<typeof setTimeout>) } }
  const positive = (value: number | undefined, fallback: number, maximum: number) => value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)))
  const maxConversations = positive(ports.limits?.maxConversations, 100, 1000)
  const maxPending = positive(ports.limits?.maxPendingPerConversation, 128, 1000)
  const sourceTtl = positive(ports.limits?.sourceTtlMs, 3_600_000, 3_600_000)
  const maxSeen = 4096
  const slots = new Map<string, Slot>(), work = new Set<Promise<void>>()
  let stopped = false
  const config = () => resolveAgentTextTriggerConfig(ports.config())
  const warn = () => ports.logger?.warn('文字触发任务已结束，来源或运行状态不可用')
  function reject(context: AgentTextTriggerContext<T>) { try { context.release() } catch { warn() } }

  function release(held: Held) {
    if (held.released) return
    held.released = true; held.removeAbort()
    reject(held.context)
  }
  function retire(slot: Slot, job: Job) {
    job.controller.abort()
    for (const held of job.sources) { release(held); slot.held.delete(held) }
    job.sources = []
  }
  function invalidateSlot(slot: Slot) {
    if (!slot.current) return
    slot.current = false
    if (slot.timer !== undefined) timers.clear(slot.timer)
    slot.timer = undefined; slot.active?.controller.abort()
    for (const job of slot.jobs) retire(slot, job)
    slot.jobs = []
    for (const held of slot.held) release(held)
    slot.held.clear(); slot.tracking.clear(); slot.seen.clear()
    if (slots.get(slot.key) === slot) slots.delete(slot.key)
  }
  function sourceCurrent(slot: Slot, held: Held) {
    try {
      return !stopped && slot.current && !held.released && now() < held.expiresAt && !held.context.signal.aborted && held.context.isCurrent() &&
        agentBindingToken(held.context.selected.binding) === slot.token && conversationAddressKey(held.context.incoming.conversation) === slot.key &&
        JSON.stringify(config()) === slot.configKey
    } catch { return false }
  }
  function guardFor(slot: Slot, job: Job): AgentTextTriggerGuard {
    const signal = AbortSignal.any([job.controller.signal, ...job.sources.map(held => held.context.signal)])
    const isCurrent = () => !signal.aborted && job.sources.length > 0 && job.sources.every(held => sourceCurrent(slot, held))
    return { signal, isCurrent, async ensureCurrent() {
      if (!isCurrent()) throw new Error('文字触发来源已失效')
      for (const held of job.sources) { await held.context.ensureCurrent(); if (!isCurrent()) throw new Error('文字触发来源已失效') }
    } }
  }
  function inputFor(slot: Slot, job: Job, history: readonly AgentTextTriggerHistory[] = []): AgentTextTriggerRun<T> {
    const latest = job.sources.at(-1)!.context
    const reason = job.kind === 'direct' ? 'direct' : job.kind === 'tracking' ? 'tracking' : job.kind === 'repeat' ? 'repeat' : 'smart'
    return { incoming: latest.incoming, selected: latest.selected, sources: job.sources.map(held => held.context.incoming), reason,
      quote: reason === 'direct' || reason === 'tracking' || reason === 'smart' && !slot.config.smart.proactiveReplyNoQuote,
      decision: job.decision, metrics: { lastReplyAt: slot.state.lastBotReplyAt, lastReplyToUserId: slot.state.lastBotReplyToUserId }, history,
      ...(job.kind === 'repeat' && job.decision.text !== undefined ? { repeatText: job.decision.text } : {}) }
  }
  async function bounded<R>(run: () => Promise<R>, guard: AgentTextTriggerGuard, job: Job, deadline: number): Promise<R | undefined> {
    if (!guard.isCurrent()) return undefined
    const timeoutMs = deadline - now()
    if (timeoutMs <= 0) { job.controller.abort(); return undefined }
    let timer: unknown, onAbort: () => void = () => {}
    try {
      return await Promise.race([Promise.resolve().then(() => guard.isCurrent() ? run() : undefined), new Promise<undefined>(resolve => {
        onAbort = () => resolve(undefined); guard.signal.addEventListener('abort', onAbort, { once: true })
        timer = timers.set(() => { job.controller.abort(); resolve(undefined) }, timeoutMs); if (guard.signal.aborted) resolve(undefined)
      })])
    } finally { if (timer !== undefined) timers.clear(timer); guard.signal.removeEventListener('abort', onAbort) }
  }
  function evaluate(slot: Slot, held: Held, observe: boolean, quotesBot = false) {
    const { incoming, selected } = held.context, name = selected.persona?.name
    return evaluateAgentTextTrigger({ message: incoming, binding: selected.binding, bindingToken: slot.token,
      ...(typeof name === 'string' ? { personaName: name } : {}), state: slot.state, config: slot.config, now: now(), observe,
      ...(ports.random ? { random: ports.random() } : {}), quotesBot })
  }
  function schedule(slot: Slot, job: Job) { slot.jobs.push(job); pump(slot) }
  function transfer(slot: Slot, job: Job, kind: Job['kind'], delayMs: number) {
    const sources = job.sources; job.sources = []
    schedule(slot, { ...job, kind, sources, dueAt: now() + delayMs, controller: new AbortController() })
  }
  function cancelDeferred(slot: Slot) {
    slot.jobs = slot.jobs.filter(job => { if (job.kind !== 'deferred') return true; retire(slot, job); return false })
  }
  function defer(slot: Slot, job: Job) {
    if (slot.config.mode !== 'smart' || !slot.config.smart.deferredGateEnabled || slot.state.conversationPhase !== 'cold' || job.kind === 'deferred') return
    cancelDeferred(slot)
    const average = job.decision.stats.avgReplyLatencyMs || slot.config.smart.avgLatencyDefaultMs
    const idle = Math.max(0, now() - slot.state.lastMsgAt)
    const remaining = Math.max(0, job.decision.threshold - slot.state.pendingCount - idle / average)
    transfer(slot, job, 'deferred', Math.max(slot.config.smart.minDeferredMs, Math.min(slot.config.smart.maxDeferredMs, Math.ceil(remaining * average))))
  }
  function mergeDirect(slot: Slot, job: Job) {
    const sender = job.sources.at(-1)!.context.incoming.sender.id
    const waiting = slot.jobs.filter(candidate => candidate.kind === 'wait' && candidate.sources.at(-1)?.context.incoming.sender.id === sender)
    if (slot.active?.kind === 'wait' && !slot.active.dispatching && slot.active.sources.at(-1)?.context.incoming.sender.id === sender) {
      const active = slot.active; active.controller.abort(); job.sources.unshift(...active.sources); active.sources = []
    }
    for (const candidate of waiting) {
      job.sources.unshift(...candidate.sources); candidate.sources = []; candidate.controller.abort()
      slot.jobs.splice(slot.jobs.indexOf(candidate), 1)
    }
    const previous = slot.jobs.find(candidate => candidate.kind === 'direct' && candidate.sources.at(-1)?.context.incoming.sender.id === sender)
    if (previous) {
      previous.sources.push(...job.sources); job.sources = []
      capSources(slot, previous)
      previous.dueAt = job.dueAt; previous.decision = job.decision
    } else slot.jobs.push(job)
    if (!previous) capSources(slot, job)
  }
  function capSources(slot: Slot, job: Job) {
    while (job.sources.length > slot.config.smart.directTriggerMergeMaxMessages) {
      const dropped = job.sources.shift()!; release(dropped); slot.held.delete(dropped)
    }
  }
  function preserveDebounce(slot: Slot, job: Job) {
    return job.kind === 'debounce' && slot.config.smart.maxConsecutiveInterrupts > 0 && slot.interruptions >= slot.config.smart.maxConsecutiveInterrupts
  }
  function interruptOptional(slot: Slot, sender: string, direct: boolean) {
    const optional = (job: Job) => !job.resolvingQuote && ['check', 'debounce', 'deferred'].includes(job.kind) &&
      (slot.config.mode === 'smart' || job.sources.at(-1)?.context.incoming.sender.id === sender)
    const interrupt = (job: Job) => {
      if (!optional(job) || !direct && preserveDebounce(slot, job)) return false
      if (job.kind === 'debounce') slot.interruptions++
      return true
    }
    if (slot.active && interrupt(slot.active)) slot.active.controller.abort()
    slot.jobs = slot.jobs.filter(job => { if (!interrupt(job)) return true; retire(slot, job); return false })
  }
  function scheduledEligible(decision: AgentTextTriggerDecision) {
    return decision.kind !== 'skip' || ['below_threshold', 'gate_cooldown'].includes(decision.reason)
  }
  async function run(slot: Slot, job: Job) {
    const guard = guardFor(slot, job), wasDebounce = job.kind === 'debounce'
    const deadline = Math.min(...job.sources.map(held => held.expiresAt), now() + (slot.config.smart.smartLockTimeoutMs || sourceTtl))
    const ensure = async () => {
      if (!await bounded(async () => { await guard.ensureCurrent(); return true }, guard, job, deadline)) throw new Error('文字触发来源已失效')
    }
    try {
      await ensure()
      let input = inputFor(slot, job)
      const history = ports.readHistory ? await bounded(() => ports.readHistory!(input, guard), guard, job, deadline) : []
      await ensure()
      if (!history) return
      const latest = job.sources.at(-1)!, quoteId = latest.context.incoming.quote?.messageId
      const quotesBot = !!quoteId && (history ?? []).some(turn => turn.replyId === quoteId)
      job.resolvingQuote = false
      if (job.kind === 'check') {
        job.decision = evaluate(slot, latest, false, quotesBot)
        if (job.decision.kind === 'forced') {
          job.kind = 'direct'
          if (latest.context.incoming.conversation.kind === 'group' && slot.config.smart.directTriggerMergeMs > 0) {
            const next = { ...job, sources: job.sources, dueAt: now() + slot.config.smart.directTriggerMergeMs, controller: new AbortController() }
            job.sources = []; mergeDirect(slot, next); return
          }
        } else if (slot.config.mode === 'strict' && job.decision.reason === 'strict_unaddressed') {
          const tracking = slot.tracking.get(latest.context.incoming.sender.id)
          if (!slot.config.tracking.enabled || !tracking || tracking.until <= now()) return
          const previous = slot.jobs.find(candidate => candidate.kind === 'tracking' && candidate.sources.at(-1)?.context.incoming.sender.id === latest.context.incoming.sender.id)
          if (previous) { previous.sources.push(...job.sources); job.sources = []; capSources(slot, previous); return }
          if (now() - tracking.lastCheckAt < slot.config.tracking.throttleMs) return
          tracking.lastCheckAt = now(); transfer(slot, job, 'tracking', slot.config.tracking.batchDelayMs); return
        } else if (job.decision.kind === 'repeat') job.kind = 'repeat'
        else if (job.decision.kind !== 'gate') { if (job.decision.reason === 'below_threshold') defer(slot, job); return }
      }
      input = inputFor(slot, job, job.kind === 'tracking' ? (history ?? []).filter(turn => turn.speakerId === latest.context.incoming.sender.id) : history ?? [])
      if (job.kind === 'tracking') {
        if ((slot.tracking.get(latest.context.incoming.sender.id)?.until ?? 0) <= now() ||
            !input.history.length || !await bounded(() => ports.tracking(input, guard), guard, job, deadline)) return
        await ensure()
      } else if (job.kind === 'wait' || job.kind === 'deferred' || job.kind === 'debounce') {
        job.decision = evaluate(slot, latest, false, quotesBot)
        if (!scheduledEligible(job.decision)) return
        if (job.decision.kind === 'forced') job.kind = 'direct'
        input = inputFor(slot, job, history)
      }
      if (!['direct', 'tracking', 'debounce', 'repeat'].includes(job.kind)) {
        input = inputFor(slot, job, history ?? [])
        const result = await bounded(() => ports.gate(input, guard), guard, job, deadline)
        await ensure()
        if (!result) return
        recordAgentTextTriggerGate(slot.state, result.decision, now(), slot.config)
        if (result.decision === 'wait') {
          if (slot.config.smart.waitToolEnabled) transfer(slot, job, 'wait', Math.max(3000, Math.min(15_000, result.waitMs ?? 5000)))
          return
        }
        if (result.decision !== 'continue') return
        if (slot.config.smart.replyDebounceMs > 0) { transfer(slot, job, 'debounce', slot.config.smart.replyDebounceMs); return }
      }
      await ensure()
      // Only actual dispatch reaches the final reply/source CAS owned by Core.
      job.dispatching = true
      const receipt = await bounded(() => job.kind === 'repeat' && ports.repeat ? ports.repeat(input, guard) : ports.reply(input, guard), guard, job, deadline)
      if (receipt?.state !== 'sent' || typeof receipt.text !== 'string' || !guard.isCurrent()) return
      recordAgentTextTriggerReply(slot.state, { message: latest.context.incoming, bindingToken: slot.token, text: receipt.text,
        now: now(), forced: job.kind === 'direct' || job.kind === 'tracking', repeat: job.kind === 'repeat', latencyMs: Math.max(1, now() - job.observedAt) }, slot.config)
      slot.interruptions = 0
      if (slot.config.tracking.enabled) slot.tracking.set(latest.context.incoming.sender.id, { until: now() + slot.config.tracking.timeoutMs, lastCheckAt: 0 })
      while (slot.tracking.size > maxSeen) slot.tracking.delete(slot.tracking.keys().next().value!)
    } catch { /* Revocation, aborted models and malformed calls never schedule an automatic replay. */ }
    finally {
      if (wasDebounce && !job.controller.signal.aborted) slot.interruptions = 0
      retire(slot, job)
    }
  }
  function pump(slot: Slot) {
    if (!slot.current || stopped) return
    if (slot.timer !== undefined) timers.clear(slot.timer)
    slot.timer = undefined
    const at = now()
    for (const [id, expiry] of slot.seen) if (expiry <= at) slot.seen.delete(id)
    for (const [id, tracking] of slot.tracking) if (tracking.until <= at) slot.tracking.delete(id)
    if (slot.active) return
    slot.jobs = slot.jobs.filter(job => {
      if (job.sources.length && job.sources.every(held => sourceCurrent(slot, held))) return true
      retire(slot, job); return false
    })
    if (!slot.jobs.length && at - slot.touchedAt >= slot.config.smart.activeChatTtlHours * 3_600_000) { invalidateSlot(slot); return }
    const ready = slot.jobs.filter(job => job.dueAt <= at)
    const next = ready.find(job => job.kind === 'direct') ?? ready[0]
    if (next) {
      slot.jobs.splice(slot.jobs.indexOf(next), 1); slot.active = next
      const operation = Promise.resolve().then(() => run(slot, next)).catch(warn).finally(() => {
        work.delete(operation); if (slot.active === next) slot.active = undefined; pump(slot)
      })
      work.add(operation); return
    }
    const wakeAt = Math.min(slot.touchedAt + slot.config.smart.activeChatTtlHours * 3_600_000,
      ...slot.jobs.map(job => job.dueAt), ...[...slot.held].map(held => held.expiresAt))
    slot.timer = timers.set(() => { slot.timer = undefined; pump(slot) }, Math.max(1, wakeAt - at))
  }

  return {
    /** Returns after local admission. A gate, model, merge or wait never blocks the account inbox. */
    admit(context: AgentTextTriggerContext<T>): void {
      let resolved: ResolvedAgentTextTriggerConfig, token: string, key: string
      try {
        if (stopped || context.signal.aborted || !context.isCurrent()) { reject(context); return }
        resolved = config(); token = agentBindingToken(context.selected.binding); key = conversationAddressKey(context.incoming.conversation)
      } catch { reject(context); warn(); return }
      const incoming = context.incoming, configKey = JSON.stringify(resolved)
      if (!incoming.messageId || conversationAddressKey(context.selected.binding.target) !== key ||
          !Number.isSafeInteger(incoming.occurredAt) || incoming.occurredAt <= 0 || now() - incoming.occurredAt >= sourceTtl) { reject(context); return }
      let slot = slots.get(key)
      if (slot && (slot.token !== token || slot.configKey !== configKey)) { invalidateSlot(slot); slot = undefined }
      if (!slot) {
        if (slots.size >= maxConversations) {
          const oldest = [...slots.values()].sort((left, right) => left.touchedAt - right.touchedAt)[0]; if (oldest) invalidateSlot(oldest)
        }
        slot = { key, target: incoming.conversation, token, configKey, config: resolved, state: createAgentTextTriggerState(),
          seen: new Map(), held: new Set(), jobs: [], active: undefined, timer: undefined, current: true, interruptions: 0, touchedAt: now(), tracking: new Map() }
        slots.set(key, slot)
      }
      if (slot.seen.has(incoming.messageId) || slot.held.size >= maxPending) { reject(context); return }
      slot.touchedAt = now(); cancelDeferred(slot)
      const held: Held = { context, expiresAt: Math.min(now() + sourceTtl, incoming.occurredAt + sourceTtl), released: false, removeAbort() {} }
      const captured = slot, aborted = () => invalidateSlot(captured)
      context.signal.addEventListener('abort', aborted, { once: true }); held.removeAbort = () => context.signal.removeEventListener('abort', aborted)
      slot.held.add(held); slot.seen.set(incoming.messageId, held.expiresAt)
      // Core's durable source claim remains authoritative after this bounded local window.
      while (slot.seen.size > maxSeen) slot.seen.delete(slot.seen.keys().next().value!)
      let decision: AgentTextTriggerDecision
      try { decision = evaluate(slot, held, true) } catch { invalidateSlot(slot); warn(); return }
      const controller = new AbortController()
      const toolRequest = isExplicitToolIntent(incoming.text) || isExplicitSearchRequest(incoming.text) || isRealtimeInfoRequest(incoming.text)
      const mergeMs = incoming.conversation.kind === 'private' ? 0 : toolRequest ? resolved.smart.toolRequestMergeMs : resolved.smart.directTriggerMergeMs
      const job: Job = { kind: decision.kind === 'forced' ? 'direct' : 'check', sources: [held], decision,
        dueAt: now() + (decision.kind === 'forced' ? mergeMs : 0), observedAt: now(), dispatching: false,
        resolvingQuote: decision.kind !== 'forced' && !!incoming.quote?.messageId, controller }
      // New chatter may interrupt an optional reply, while queued direct calls remain owned.
      interruptOptional(slot, incoming.sender.id, job.kind === 'direct')
      if (job.kind === 'direct') mergeDirect(slot, job)
      else {
        if (slot.jobs.some(candidate => preserveDebounce(slot!, candidate)) || slot.active && preserveDebounce(slot, slot.active)) {
          release(held); slot.held.delete(held); pump(slot); return
        }
        const waiting = slot.jobs.find(candidate => candidate.kind === 'wait' && candidate.sources.at(-1)?.context.incoming.sender.id === incoming.sender.id)
        if (waiting) {
          waiting.sources.push(held); capSources(slot, waiting)
        } else slot.jobs.push(job)
      }
      pump(slot)
    },
    invalidate(target: ConversationAddress): void { const slot = slots.get(conversationAddressKey(target)); if (slot) invalidateSlot(slot) },
    invalidateAccount(account: PlatformAccountRef): void { for (const slot of slots.values()) if (platformAccountKey(slot.target.account) === platformAccountKey(account)) invalidateSlot(slot) },
    async drain(): Promise<void> { while (work.size) await Promise.allSettled([...work]) },
    async stop(): Promise<void> { stopped = true; for (const slot of slots.values()) invalidateSlot(slot); while (work.size) await Promise.allSettled([...work]) },
  }
}
