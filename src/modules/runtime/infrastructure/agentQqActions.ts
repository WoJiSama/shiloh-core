import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentTool, AgentToolContext, AgentQqActionGuard } from '../../../contracts/agentTool.js'
import type { PlatformConnectionAdapter } from '../../../contracts/platformConnection.js'
import type { AgentGiftPlan, AgentGiftResult } from '../../../contracts/agentQqGift.js'
import type { AgentQzoneLimits, AgentQzoneOperation, AgentQzoneResult } from '../../../contracts/agentQzone.js'
import type { AgentRedPacketPolicy, AgentRedPacketRequest, AgentRedPacketResult, AgentRedPacketSnapshot, AgentRedPacketStorage } from '../../../contracts/agentQqRedPacket.js'
import { createAgentGiftTools } from '../../tools/infrastructure/agentGiftTools.js'
import { createAgentQzoneTools } from '../../tools/infrastructure/agentQzoneTools.js'
import { validateAgentQzoneBinding, validateAgentQzoneOperation } from '../../tools/infrastructure/agentQzoneValidation.js'
import { createAgentRedPacketTools } from '../../tools/infrastructure/agentRedPacketTools.js'
import { platformAccountKey } from '../domain/agentBindings.js'
import { captureAgentToolSourceGuard, type AgentToolSourceProof } from './agentToolSourceGuard.js'
import type { AgentDiagnostics } from './agentDiagnostics.js'
import { createAgentGiftWorkflow } from './agentGiftWorkflow.js'
import { createAgentQzoneLedger } from './agentQzoneLedger.js'
import { createAgentQzoneRuntime } from './agentQzoneRuntime.js'
import { createAgentRedPacketRuntime } from './agentRedPacketRuntime.js'

export interface AgentQqActionsConfig {
  readonly qzone?: Readonly<{ enabled: boolean }>
  readonly gift?: Readonly<{ enabled: boolean }>
  readonly redPackets?: AgentRedPacketPolicy
}
export type AgentQqActionToolName = 'qqZoneTool' | 'simQzoneInteract' | 'sendGiftTool' | 'grabRedBagTool'
type Source = { readonly messageId: string; readonly author: PlatformUserRef }
export interface AgentQqActionsOptions {
  readonly config?: AgentQqActionsConfig
  readonly storage: AgentRedPacketStorage
  adapterFor(target: ConversationAddress): PlatformConnectionAdapter | undefined
  isCurrent(binding: AgentBindingSnapshot): boolean
  /** The observation ends before any source read, authorization await or effect. */
  observeCurrent?(check: () => boolean): boolean
  authorize(name: AgentQqActionToolName, binding: AgentBindingSnapshot, actor: AgentToolContext['actor']): boolean | Promise<boolean>
  sourceAvailable(binding: AgentBindingSnapshot, source: Source, guard: AgentQqActionGuard): Promise<boolean>
  affinity?(binding: AgentBindingSnapshot, userId: string): number
  allowsText?(text: string, binding: AgentBindingSnapshot, context: AgentToolContext): boolean | Promise<boolean>
  getQzoneLimits?(binding: AgentBindingSnapshot): Partial<AgentQzoneLimits>
  readonly diagnostics?: AgentDiagnostics
  readonly now?: () => number
}
type Kind = 'gift' | 'red-packet' | 'qzone'
const unavailable = () => new Error('qq_action_not_authorized')
const failedGift = (): AgentGiftResult => ({ state: 'failed', completed: 0, code: 'gift_source_unavailable' })
const failedPacket = (): AgentRedPacketResult => ({ state: 'failed', phase: 'claimed', code: 'red_packet_source_unavailable', passwordConfirmed: false, grabbed: false })
const failedQzone = (kind: AgentQzoneOperation['kind']): AgentQzoneResult => ({ state: 'failed', kind, code: 'qzone_source_unavailable', terminal: false })

/** Composition only: the host's runQqAction owns queueing, send budgets and turn termination. */
export function createAgentQqActions(options: AgentQqActionsOptions) {
  const gift = createAgentGiftWorkflow(options.storage), ledger = createAgentQzoneLedger(options.storage)
  const config = () => options.config ?? {}
  const enabled = (kind: Kind, simulation = false) => kind === 'gift' ? config().gift?.enabled === true
    : kind === 'red-packet' ? config().redPackets?.enabled === true : simulation || config().qzone?.enabled === true
  const diagnostic = (kind: Kind) => {
    try { options.diagnostics?.emit({ stage: 'delivery', operation: 'qq_action', outcome: 'failed', code: `qq_${kind.replace('-', '_')}_unavailable` }) } catch { /* Diagnostics cannot authorize an effect. */ }
  }
  function capture(bindingInput: AgentBindingSnapshot, kind: Kind, tool: AgentQqActionToolName,
    actor: AgentToolContext['actor'], outer: AgentQqActionGuard, context?: AgentToolContext, simulation = false, ensureOwnedSource?: AgentToolSourceProof) {
    const binding = validateAgentQzoneBinding(bindingInput), snapshot = JSON.stringify(binding), policy = JSON.stringify(config())
    const identity = context && JSON.stringify([context.binding, context.actor, context.request])
    const adapter = options.adapterFor(binding.target)
    if (!adapter || adapter.id !== binding.connectionId || platformAccountKey(adapter.account) !== platformAccountKey(binding.target.account)) throw unavailable()
    const port = kind === 'gift' ? adapter.gift : kind === 'qzone' ? adapter.qzone : adapter.redPackets
    if (!port) throw unavailable()
    const methods = kind === 'qzone' ? [adapter.qzone?.execute] : kind === 'red-packet'
      ? [adapter.redPackets?.read, adapter.redPackets?.recent, adapter.redPackets?.revalidate, adapter.redPackets?.sendPassword, adapter.redPackets?.grab] : [port]
    return (queue: AgentQqActionGuard = outer) => {
      const signal = AbortSignal.any([outer.signal, queue.signal])
      const evaluateCurrent = () => !signal.aborted && outer.isCurrent() === true && queue.isCurrent() === true && options.isCurrent(binding) === true &&
        JSON.stringify(validateAgentQzoneBinding(bindingInput)) === snapshot && JSON.stringify(config()) === policy && enabled(kind, simulation) &&
        (!context || JSON.stringify([context.binding, context.actor, context.request]) === identity) &&
        options.adapterFor(binding.target) === adapter && adapter.isReady() === true && adapter.id === binding.connectionId &&
        platformAccountKey(adapter.account) === platformAccountKey(binding.target.account) &&
        (kind === 'gift' ? adapter.gift : kind === 'qzone' ? adapter.qzone : adapter.redPackets) === port &&
        (kind === 'qzone' ? [adapter.qzone?.execute] : kind === 'red-packet'
          ? [adapter.redPackets?.read, adapter.redPackets?.recent, adapter.redPackets?.revalidate, adapter.redPackets?.sendPassword, adapter.redPackets?.grab] : [adapter.gift])
          .every((method, index) => method === methods[index])
      const current = () => {
        try {
          return options.observeCurrent ? options.observeCurrent(evaluateCurrent) === true : evaluateCurrent()
        } catch { return false }
      }
      const base = async () => {
        if (!current()) throw unavailable()
        await outer.ensureCurrent()
        if (!current()) throw unavailable()
        if (queue !== outer) await queue.ensureCurrent()
        if (!current() || await options.authorize(tool, binding, actor) !== true || !current()) throw unavailable()
      }
      const sourceGuard: AgentQqActionGuard = Object.freeze({ signal, isCurrent: current, ensureCurrent: base })
      const sourceAvailable = async (source: Source): Promise<boolean> => {
        if (ensureOwnedSource?.matchesSource(source)) { await ensure(); return true }
        await base()
        if (await options.sourceAvailable(binding, source, sourceGuard) !== true) return false
        await base(); return true
      }
      const ensure = async (): Promise<void> => {
        await base()
        if (context) {
          if (context.actor.kind !== 'user' || !context.actor.user || !context.request || typeof context.ensureCurrent !== 'function') throw unavailable()
          // Queue and authorization callbacks may revoke the source after base's first read.
          // The owned validator reads it again, without the generic source guard's recursion.
          if (ensureOwnedSource) {
            await ensureOwnedSource()
            if (!current()) throw unavailable()
            return
          }
          if (!await sourceAvailable({ messageId: context.request.messageId, author: context.actor.user })) throw unavailable()
        }
        await base()
      }
      return { binding, adapter, guard: Object.freeze({ signal, isCurrent: current, ensureCurrent: ensure }), sourceAvailable }
    }
  }
  function outer(context: AgentToolContext): { guard: AgentQqActionGuard; ensureOwnedSource?: AgentToolSourceProof } {
    if (typeof context.ensureCurrent !== 'function' || typeof context.runQqAction !== 'function') throw unavailable()
    const owned = captureAgentToolSourceGuard(context)
    return { guard: { signal: context.signal, isCurrent: () => context.isCurrent(), ensureCurrent: owned ?? (() => context.ensureCurrent!()) },
      ...(owned ? { ensureOwnedSource: owned } : {}) }
  }
  async function executeGift(plan: AgentGiftPlan, context: AgentToolContext): Promise<AgentGiftResult> {
    let entered = false
    try {
      const parent = outer(context)
      const enter = capture(context.binding, 'gift', 'sendGiftTool', context.actor, parent.guard, context, false, parent.ensureOwnedSource)
      return await context.runQqAction!('gift', async queue => {
        const scope = enter(queue)
        await scope.guard.ensureCurrent(); entered = true
        return gift.execute({ action: { version: 1, kind: 'qq.gift-display', binding: scope.binding,
          source: { messageId: context.request!.messageId, author: context.actor.user! }, plan }, ...scope.guard,
          dispatch: (action, guard) => scope.adapter.gift!(action, guard) })
      })
    } catch { diagnostic('gift'); return entered ? { state: 'unknown', completed: 0, code: 'gift_outcome_unknown' } : failedGift() }
  }
  async function executeQzone(operationInput: AgentQzoneOperation, context: AgentToolContext): Promise<AgentQzoneResult> {
    let kind: AgentQzoneOperation['kind'] = 'publish', entered = false
    try {
      const operation = validateAgentQzoneOperation(operationInput); kind = operation.kind
      const simulation = !['publish', 'delete'].includes(kind), parent = outer(context)
      const enter = capture(context.binding, 'qzone', simulation ? 'simQzoneInteract' : 'qqZoneTool', context.actor, parent.guard, context, simulation, parent.ensureOwnedSource)
      return await context.runQqAction!('qzone', async queue => {
        const scope = enter(queue)
        await scope.guard.ensureCurrent()
        const runtime = createAgentQzoneRuntime({ ledger, provider: scope.adapter.qzone!, enabled: config().qzone?.enabled === true,
          ...(options.getQzoneLimits ? { getLimits: options.getQzoneLimits } : {}), ...(options.now ? { now: options.now } : {}),
          ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) })
        entered = true
        return runtime.execute({ binding: scope.binding, identity: context.request!.messageId, actor: context.actor, operation, ...scope.guard,
          authorize: async () => { await scope.guard.ensureCurrent(); return true },
          readMember: async (userId, guard) => {
            await scope.guard.ensureCurrent()
            const read = scope.adapter.readConversationMember
            if (!read) return undefined
            const value = await read.call(scope.adapter, scope.binding.target, { ...scope.binding.target.account, id: userId }, guard)
            await scope.guard.ensureCurrent(); return value
          },
          affinity: userId => context.qzoneAffinity ? context.qzoneAffinity(userId) : options.affinity?.(scope.binding, userId) ?? Number.NaN,
          allowsText: async text => {
            await scope.guard.ensureCurrent()
            if (typeof context.reviewQqText !== 'function' || typeof options.allowsText !== 'function' ||
                await context.reviewQqText(text) !== true) return false
            await scope.guard.ensureCurrent()
            const allowed = await options.allowsText(text, scope.binding, context)
            await scope.guard.ensureCurrent(); return allowed === true
          },
        })
      })
    } catch { diagnostic('qzone'); return entered ? { state: 'unknown', kind, code: 'qzone_outcome_unknown', terminal: true } : failedQzone(kind) }
  }
  async function executePacket(request: AgentRedPacketRequest, context: AgentToolContext): Promise<AgentRedPacketResult> {
    let entered = false
    try {
      const parent = outer(context)
      const enter = capture(context.binding, 'red-packet', 'grabRedBagTool', context.actor, parent.guard, context, false, parent.ensureOwnedSource)
      return await context.runQqAction!('red-packet', async queue => {
        const scope = enter(queue)
        await scope.guard.ensureCurrent()
        const runtime = createAgentRedPacketRuntime({ storage: options.storage, port: scope.adapter.redPackets!,
          policy: () => config().redPackets ?? { enabled: false }, ...(options.now ? { now: options.now } : {}) })
        entered = true
        return runtime.execute({ binding: scope.binding, actor: context.actor, ...(context.request ? { request: context.request } : {}),
          ...scope.guard, isSourceAvailable: scope.sourceAvailable }, request)
      })
    } catch { diagnostic('red-packet'); return entered ? { ...failedPacket(), state: 'unknown', code: 'red_packet_outcome_unknown' } : failedPacket() }
  }
  /** The caller admits a trusted wallet event through its fixed-binding queue before invoking this producer. */
  async function automatic(packet: AgentRedPacketSnapshot, binding: AgentBindingSnapshot, guard: AgentQqActionGuard): Promise<AgentRedPacketResult> {
    let entered = false
    try {
      const scope = capture(binding, 'red-packet', 'grabRedBagTool', { kind: 'autonomous' }, guard)()
      await scope.guard.ensureCurrent()
      const runtime = createAgentRedPacketRuntime({ storage: options.storage, port: scope.adapter.redPackets!,
        policy: () => config().redPackets ?? { enabled: false }, ...(options.now ? { now: options.now } : {}) })
      entered = true
      return await runtime.executeAutomatic({ binding: scope.binding, ...scope.guard, isSourceAvailable: scope.sourceAvailable }, packet)
    } catch { diagnostic('red-packet'); return entered ? { ...failedPacket(), state: 'unknown', code: 'red_packet_outcome_unknown' } : failedPacket() }
  }
  const qzoneTools = createAgentQzoneTools({ enabled: config().qzone?.enabled === true }).map(tool => Object.freeze({ ...tool,
    execute: (input: Record<string, unknown>, context: AgentToolContext) => tool.execute(input, { ...context, qzone: operation => executeQzone(operation, context) }),
  }))
  const builtIn: readonly AgentTool[] = Object.freeze([...qzoneTools,
    ...createAgentGiftTools({ enabled: config().gift?.enabled === true, execute: executeGift }),
    ...createAgentRedPacketTools({ enabled: config().redPackets?.enabled === true, execute: executePacket }),
  ])
  return Object.freeze({ builtIn, executeQzone, automatic })
}
