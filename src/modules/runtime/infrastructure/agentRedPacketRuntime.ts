import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentRedPacketAutomaticContext, AgentRedPacketContext, AgentRedPacketGrabReceipt, AgentRedPacketGuard,
  AgentRedPacketPasswordReceipt, AgentRedPacketPolicy, AgentRedPacketPort, AgentRedPacketRequest, AgentRedPacketResult,
  AgentRedPacketRuntime, AgentRedPacketSnapshot, AgentRedPacketStorage } from '../../../contracts/agentQqRedPacket.js'
import { conversationAddressKey, samePlatformNamespace } from '../domain/agentBindings.js'
import { createAgentRedPacketLedger, type AgentRedPacketSession } from './agentRedPacketLedger.js'
import { redPacketAccount, redPacketArray, redPacketBinding, redPacketData, redPacketError, redPacketText,
  validateAgentRedPacketRequest, validateAgentRedPacketSnapshot } from './agentRedPacketValidation.js'

export interface AgentRedPacketRuntimeOptions {
  readonly storage: AgentRedPacketStorage
  readonly port: AgentRedPacketPort
  /** Re-read before every external step. Missing grants are disabled. */
  policy(binding: AgentBindingSnapshot): AgentRedPacketPolicy
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly random?: () => number
  /** Test seam; production waits 500ms after a confirmed password, with cancellation. */
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}
const result = (state: AgentRedPacketResult['state'], code: string, session?: AgentRedPacketSession): AgentRedPacketResult =>
  Object.freeze({ state, code, phase: session?.record.phase ?? 'claimed', passwordConfirmed: session?.record.passwordConfirmed ?? false, grabbed: false })

/** The current human's own positive request is required in addition to the money-tool grant. */
export function hasAgentRedPacketRequest(text: string): boolean {
  if (typeof text !== 'string' || !text.trim() || text.length > 64_000) return false
  const clauses = text.split(/[，,。；;！？!?\n]+/u).map(value => value.trim())
  const action = /(?:抢|领取|领)(?:一(?:下|个)|一下)?[^，,。；;！？!?\n]{0,50}红包/u
  if (clauses.some(value => action.test(value) && (/(?:不要|不用|不必|无需|别|甭|先不)|(?:没(?:有)?|并未)(?:让|叫|要求)你/u.test(value) ||
      /(?:只是|仅仅是|只是在).{0,6}(?:讨论|举例|示例|转述|引用)|^(?:例如|比如|示例|例子)[：:\s]/u.test(value) ||
      /^(?:他|她|他们|她们|朋友|同事).{0,6}(?:说|会|让|要)/u.test(value) || /[“”「」『』"']/u.test(value)))) return false
  return clauses.some(value => /^(?:(?:请|麻烦|你|帮我|替我|给我|帮忙|确认|现在|先|再)\s*)*(?:抢|领取|领)(?:一(?:下|个)|一下)?[^，,。；;！？!?\n]{0,50}红包/u.test(value))
}
function policy(input: unknown): AgentRedPacketPolicy {
  const row = redPacketData(input, ['enabled', 'allowExplicit', 'allowRecentSearch', 'allowReferenceFallback', 'allowPasswordSend', 'recentLimit', 'automatic'])
  for (const field of ['enabled', 'allowExplicit', 'allowRecentSearch', 'allowReferenceFallback', 'allowPasswordSend']) {
    if (row[field] !== undefined && typeof row[field] !== 'boolean') throw redPacketError()
  }
  if (row.recentLimit !== undefined && (!Number.isSafeInteger(row.recentLimit) || Number(row.recentLimit) < 1 || Number(row.recentLimit) > 1000)) throw redPacketError()
  const auto = row.automatic === undefined ? undefined : redPacketData(row.automatic, ['enabled', 'toolConfigured', 'allowPasswordSend'])
  if (auto) for (const field of ['enabled', 'toolConfigured', 'allowPasswordSend']) if (auto[field] !== undefined && typeof auto[field] !== 'boolean') throw redPacketError()
  return Object.freeze({ enabled: row.enabled === true, allowExplicit: row.allowExplicit === true, allowRecentSearch: row.allowRecentSearch === true,
    allowReferenceFallback: row.allowReferenceFallback === true, allowPasswordSend: row.allowPasswordSend === true, recentLimit: Number(row.recentLimit ?? 100),
    ...(auto ? { automatic: Object.freeze({ enabled: auto.enabled === true, toolConfigured: auto.toolConfigured === true, allowPasswordSend: auto.allowPasswordSend === true }) } : {}) })
}
function samePacket(left: AgentRedPacketSnapshot, right: AgentRedPacketSnapshot): boolean {
  return conversationAddressKey(left.target) === conversationAddressKey(right.target) && left.packetIdentity === right.packetIdentity &&
    JSON.stringify(left.source) === JSON.stringify(right.source) && left.kind === right.kind && left.title === right.title && left.exclusiveForBot === right.exclusiveForBot
}
function confirmedPassword(input: unknown): AgentRedPacketPasswordReceipt {
  try {
    const row = redPacketData(input, ['state', 'messageId', 'code'])
    if (row.state === 'confirmed' && row.messageId !== '0' && !Object.hasOwn(row, 'code')) return { state: 'confirmed', messageId: redPacketText(row.messageId) }
    if (row.state === 'failed' && !Object.hasOwn(row, 'messageId')) return { state: 'failed' }
  } catch { /* Untrusted receipt data is never coerced or exposed. */ }
  return { state: 'unknown' }
}
function confirmedGrab(input: unknown): AgentRedPacketGrabReceipt {
  try {
    const row = redPacketData(input, ['state', 'amountFen', 'code'])
    if (row.state === 'confirmed' && !Object.hasOwn(row, 'code') && Number.isSafeInteger(row.amountFen) && Number(row.amountFen) > 0) return { state: 'confirmed', amountFen: row.amountFen as number }
    if (row.state === 'failed' && !Object.hasOwn(row, 'amountFen')) return { state: 'failed' }
  } catch { /* No raw native error or credentials enter a result. */ }
  return { state: 'unknown' }
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(redPacketError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
}

/** Core owns selection, live permissions, cooldown, durable stages and ordering.
 * The port alone owns native wallet credentials, protocol proof and one-item dispatch. */
export function createAgentRedPacketRuntime(options: AgentRedPacketRuntimeOptions): AgentRedPacketRuntime {
  const ledger = createAgentRedPacketLedger(options.storage), port = options.port, timeoutMs = options.timeoutMs ?? 45_000
  if (!port || [port.read, port.recent, port.revalidate, port.sendPassword, port.grab, options.policy].some(value => typeof value !== 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw redPacketError()
  const now = options.now ?? Date.now, random = options.random ?? Math.random, wait = options.wait ?? pause
  async function execute(context: AgentRedPacketContext | AgentRedPacketAutomaticContext, input: AgentRedPacketRequest | AgentRedPacketSnapshot, automatic: boolean): Promise<AgentRedPacketResult> {
    let request: AgentRedPacketRequest | undefined, selected: AgentBindingSnapshot, sourceIdentity: string, fingerprint: () => string
    const human = context as AgentRedPacketContext
    try {
      if (!automatic) {
        request = validateAgentRedPacketRequest(input)
        if (request.confirm === false) return result('cancelled', 'red_packet_cancelled')
      }
      redPacketData(context)
      selected = redPacketBinding(context.binding)
      if (types.isProxy(context.signal) || !(context.signal instanceof AbortSignal) ||
          [context.isCurrent, context.isSourceAvailable, context.ensureCurrent].some(value => typeof value !== 'function' || types.isProxy(value))) throw redPacketError()
      if (automatic) fingerprint = () => JSON.stringify(redPacketBinding(context.binding))
      else {
        fingerprint = () => {
          const actor = redPacketData(human.actor, ['kind', 'user']), origin = redPacketData(human.request, ['messageId', 'text', 'occurredAt', 'mentions', 'replyAuthor', 'replyMessageId'])
          const user = redPacketAccount(actor.user)
          if (actor.kind !== 'user' || !samePlatformNamespace(user, selected.target.account) || user.id === selected.target.account.id ||
              origin.messageId === '0' || typeof origin.text !== 'string' || !hasAgentRedPacketRequest(origin.text) ||
              origin.occurredAt !== undefined && (!Number.isSafeInteger(origin.occurredAt) || Number(origin.occurredAt) <= 0)) throw redPacketError()
          return JSON.stringify([redPacketBinding(context.binding), user, redPacketText(origin.messageId), origin.text,
            origin.replyMessageId === undefined ? null : redPacketText(origin.replyMessageId), origin.occurredAt ?? null])
        }
      }
      sourceIdentity = fingerprint()
    } catch { return result('failed', 'red_packet_invalid_request') }

    const cancel = new AbortController(), signal = AbortSignal.any([context.signal, cancel.signal]), timer = setTimeout(() => cancel.abort(), timeoutMs)
    let packet: AgentRedPacketSnapshot | undefined, session: AgentRedPacketSession | undefined
    let nativePending = false, usesRecent = false, usesReferenceFallback = false
    const currentPolicy = () => policy(options.policy(selected))
    const allowed = (p: AgentRedPacketPolicy) => p.enabled && (automatic ? p.automatic?.enabled === true && p.automatic.toolConfigured === true : p.allowExplicit === true)
    const passwordAllowed = (p: AgentRedPacketPolicy) => automatic ? p.automatic?.allowPasswordSend === true : p.allowPasswordSend === true
    const current = () => {
      try {
        const p = currentPolicy()
        return !signal.aborted && context.isCurrent() === true && fingerprint() === sourceIdentity && allowed(p) &&
          (!usesRecent || p.allowRecentSearch === true) && (!usesReferenceFallback || p.allowReferenceFallback === true) &&
          (!packet || packet.kind !== 'password' || passwordAllowed(p))
      } catch { return false }
    }
    const watcher = setInterval(() => { if (!current()) cancel.abort() }, 25)
    const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(redPacketError()) }
      operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, () => { signal.removeEventListener('abort', abort); reject(redPacketError()) })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    // This callback must not re-enter port.revalidate: the adapter also calls it inside its native queue.
    const ensure = async () => {
      if (!current()) throw redPacketError()
      await bounded(Promise.resolve().then(() => context.ensureCurrent?.()))
      if (!current()) throw redPacketError()
      if (!automatic) {
        const user = redPacketAccount(human.actor.user)
        if (await bounded(Promise.resolve().then(() => context.isSourceAvailable({ messageId: human.request!.messageId, author: user }))) !== true) { cancel.abort(); throw redPacketError() }
      }
      if (packet && await bounded(Promise.resolve().then(() => context.isSourceAvailable(packet!.source))) !== true) { cancel.abort(); throw redPacketError() }
      if (!current() || session && !await bounded(session.isCurrent())) throw redPacketError()
    }
    const guard: AgentRedPacketGuard = Object.freeze({ signal, isCurrent: current, ensureCurrent: ensure })
    const read = async (id: string) => {
      await ensure()
      const raw = await bounded(Promise.resolve().then(() => port.read(selected.target, id, guard)))
      await ensure()
      if (raw === undefined) return undefined
      const value = validateAgentRedPacketSnapshot(raw, now())
      if (conversationAddressKey(value.target) !== conversationAddressKey(selected.target) || value.source.messageId !== id) throw redPacketError()
      return value
    }
    const fresh = async () => {
      await ensure()
      if (!packet || await bounded(Promise.resolve().then(() => port.revalidate(packet!, guard))) !== true) throw redPacketError()
      await ensure()
    }
    const save = async (value: AgentRedPacketResult): Promise<AgentRedPacketResult> => {
      if (!session) return value
      // Settlement is still allowed after cancellation. It cannot dispatch external work.
      try {
        const completion = session.finish(value)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([completion, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(redPacketError()), 5000) })]) }
        finally { clearTimeout(timeout) }
        return value.state === 'confirmed' ? Object.freeze({ ...value, phase: 'finished' }) : value
      } catch { return result('unknown', 'red_packet_settlement_unknown', session) }
    }
    try {
      if (!allowed(currentPolicy())) return result('failed', 'red_packet_not_authorized')
      if (automatic) {
        const candidate = validateAgentRedPacketSnapshot(input, now())
        if (conversationAddressKey(candidate.target) !== conversationAddressKey(selected.target)) throw redPacketError()
        packet = await read(candidate.source.messageId)
        if (!packet || !samePacket(candidate, packet)) return result('skipped', 'red_packet_source_unavailable')
      } else {
        let id: string | undefined, pinned: AgentRedPacketSnapshot | undefined
        const visible = redPacketArray(human.visiblePackets ?? [], 1000)
        const snapshots = visible.map(value => validateAgentRedPacketSnapshot(value, now()))
        if (snapshots.some(value => conversationAddressKey(value.target) !== conversationAddressKey(selected.target))) throw redPacketError()
        if (request!.packetRef !== undefined) {
          const candidates = snapshots.filter(value => value.packetRef === request!.packetRef)
          if (candidates.length !== 1) return result('failed', 'red_packet_untrusted_selection')
          pinned = candidates[0]!
          id = candidates[0]!.source.messageId
        } else if (request!.messageId !== undefined) {
          const permitted = new Set([human.request!.messageId, human.request!.replyMessageId, ...snapshots.map(value => value.source.messageId)])
          if (!permitted.has(request!.messageId)) return result('failed', 'red_packet_untrusted_selection')
          id = request!.messageId
          pinned = snapshots.find(value => value.source.messageId === id)
        } else id = human.request!.replyMessageId ?? human.request!.messageId
        packet = await read(id)
        if (packet && pinned && !samePacket(pinned, packet)) return result('failed', 'red_packet_source_unavailable')
        if (!packet) {
          const p = currentPolicy(), explicitSelection = request!.messageId !== undefined || request!.packetRef !== undefined
          if (explicitSelection || !p.allowRecentSearch || human.request!.replyMessageId && !p.allowReferenceFallback) return result('failed', 'red_packet_not_found')
          const limit = p.recentLimit ?? 100
          usesRecent = true; usesReferenceFallback = human.request!.replyMessageId !== undefined
          await ensure()
          const recent = await bounded(Promise.resolve().then(() => port.recent(selected.target, { ...guard, limit })))
          await ensure()
          const values = redPacketArray(recent, limit)
          if (values.length) {
            const candidate = validateAgentRedPacketSnapshot(values[0], now())
            if (conversationAddressKey(candidate.target) !== conversationAddressKey(selected.target)) throw redPacketError()
            packet = await read(candidate.source.messageId)
            if (!packet || !samePacket(candidate, packet)) throw redPacketError()
          }
        }
        if (!packet) return result('failed', 'red_packet_not_found')
      }
      if (packet.kind === 'exclusive' && !packet.exclusiveForBot) return result(automatic ? 'skipped' : 'failed', 'red_packet_not_recipient')
      if (packet.kind === 'password' && !passwordAllowed(currentPolicy())) return result(automatic ? 'skipped' : 'failed', 'red_packet_password_not_authorized')
      await fresh()
      if (automatic && packet.kind !== 'exclusive') {
        const draw = () => { const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw redPacketError(); return value }
        const probability = 0.3 + draw() * 0.5
        if (draw() >= probability) return result('skipped', 'red_packet_probability_skipped')
        if (!current()) throw redPacketError()
        if (!await bounded(ledger.claimAutomaticCooldown(selected))) return result('skipped', 'red_packet_cooldown')
        await ensure()
      }
      const claim = await bounded(ledger.claim(selected, packet))
      if (claim.state === 'duplicate') {
        const uncertain = claim.record.state === 'active' || claim.record.state === 'unknown'
        return Object.freeze({ state: uncertain ? 'unknown' : 'failed', phase: claim.record.phase,
          code: uncertain ? 'red_packet_already_unknown' : 'red_packet_already_attempted', passwordConfirmed: claim.record.passwordConfirmed, grabbed: false })
      }
      session = claim.session
      if (packet.kind === 'password') {
        await fresh()
        await bounded(session.begin('password_pending'))
        await ensure()
        nativePending = true
        const receipt = confirmedPassword(await bounded(Promise.resolve().then(() => { if (!current()) throw redPacketError(); return port.sendPassword(packet!, guard) })))
        nativePending = false
        if (receipt.state !== 'confirmed') return await save(result(receipt.state, receipt.state === 'unknown' ? 'red_packet_password_unknown' : 'red_packet_password_failed', session))
        // Persist the actual receipt before waiting, reauthorization or any grab attempt.
        try { await bounded(session.confirmPassword(receipt.messageId)) }
        catch { return Object.freeze({ ...result('unknown', 'red_packet_password_settlement_unknown', session), passwordConfirmed: true }) }
        await ensure()
        await bounded(Promise.resolve().then(() => wait(500, signal)))
      }
      await fresh()
      await bounded(session.begin('grab_pending'))
      await ensure()
      nativePending = true
      const receipt = confirmedGrab(await bounded(Promise.resolve().then(() => { if (!current()) throw redPacketError(); return port.grab(packet!, guard) })))
      nativePending = false
      if (receipt.state !== 'confirmed') return await save(result(receipt.state, receipt.state === 'unknown' ? 'red_packet_grab_unknown' : 'red_packet_grab_failed', session))
      return await save(Object.freeze({ state: 'confirmed', code: 'red_packet_grabbed', phase: 'grab_pending',
        passwordConfirmed: session.record.passwordConfirmed, grabbed: true, amountFen: receipt.amountFen }))
    } catch {
      const uncertain = nativePending || session && ['password_pending', 'grab_pending'].includes(session.record.phase)
      return await save(result(uncertain ? 'unknown' : !current() ? 'cancelled' : 'failed', uncertain ? 'red_packet_outcome_unknown' : !current() ? 'red_packet_cancelled' : 'red_packet_source_unavailable', session))
    } finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
  }
  return Object.freeze({
    execute: (context: AgentRedPacketContext, request: AgentRedPacketRequest = {}) => execute(context, request, false),
    executeAutomatic: (context: AgentRedPacketAutomaticContext, packet: AgentRedPacketSnapshot) => execute(context, packet, true),
  })
}

/** Host wires only actual trusted wallet ingress to this producer, independently of human tools. */
export function createAgentRedPacketAutomaticProducer(runtime: AgentRedPacketRuntime) {
  if (!runtime || typeof runtime.executeAutomatic !== 'function') throw redPacketError()
  return Object.freeze({ accept: (context: AgentRedPacketAutomaticContext, packet: AgentRedPacketSnapshot) => runtime.executeAutomatic(context, packet) })
}
