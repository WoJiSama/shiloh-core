import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentLocalEmojiCollectionContext, AgentLocalEmojiRuntime } from '../../../contracts/agentLocalEmoji.js'
import type { MessageImage } from '../../../contracts/platformConnection.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { abortableAgentWeb } from '../../tools/infrastructure/agentPublicWeb.js'

export type AgentLocalEmojiIngressGuard = Pick<AgentLocalEmojiCollectionContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export interface AgentLocalEmojiIngressInput {
  readonly binding: AgentBindingSnapshot
  readonly source: IncomingMessage
  /** Host closure re-proves this original source before the adapter reads any image. */
  readonly read: (guard: AgentLocalEmojiIngressGuard) => Promise<readonly MessageImage[] | undefined>
  readonly guard: AgentLocalEmojiIngressGuard
  /** Releases a lazily acquired source/memory fence on every terminal path. */
  readonly release?: () => void
}
export interface AgentLocalEmojiIngressOptions {
  readonly collect: AgentLocalEmojiRuntime['collect']
  readonly enabled: () => boolean
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
}
interface Pending {
  readonly scope: string
  readonly identity: string
  readonly input: AgentLocalEmojiIngressInput
  readonly binding: AgentBindingSnapshot
  readonly source: AgentLocalEmojiCollectionContext['source']
  readonly imageCount: number
  readonly guard: AgentLocalEmojiIngressGuard
  readonly lifetime: AbortController
  readonly release: () => void
  readonly onAbort: () => void
}
const rejected = () => new Error('自动表情收藏来源已不可用')
const MAX_IMAGE_BASE64 = Math.ceil(5 * 1024 * 1024 / 3) * 4

/** Best-effort, host-owned ingress: two workers, two pending per full conversation, 64 pending total. */
export function createAgentLocalEmojiIngress(options: AgentLocalEmojiIngressOptions) {
  const secretCheck = createAgentSecretTextCheck(options.secrets ?? [])
  const allowed = (text: string) => secretCheck(text) && options.allowsText?.(text) !== false
  const waiting: Pending[] = [], active = new Map<Pending, Promise<void>>(), known = new Set<string>(), stop = new AbortController()
  let stopped = false, pumping = false
  function bindingKey(binding: AgentBindingSnapshot): string {
    if (!binding || !isConversationAddress(binding.target) || !['configured', 'legacy'].includes(binding.source) ||
        ![binding.id, binding.revision, binding.agentId, binding.personaId, binding.connectionId].every(isPlatformIdentifier) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.agentId)) throw rejected()
    return JSON.stringify([agentBindingToken(binding), conversationAddressKey(binding.target)])
  }
  function identity(input: AgentLocalEmojiIngressInput): string {
    const { binding, source } = input, key = bindingKey(binding)
    if (!source || source.version !== 1 || !source.binding || bindingKey(source.binding) !== key || !isConversationAddress(source.conversation) ||
        conversationAddressKey(source.conversation) !== conversationAddressKey(binding.target) || !isPlatformIdentifier(source.messageId) ||
        !isPlatformAccount(source.sender) || !samePlatformNamespace(source.sender, binding.target.account) || source.sender.id === binding.target.account.id ||
        !Number.isSafeInteger(source.occurredAt) || source.occurredAt < 0 || typeof source.text !== 'string' || source.text.length > 32_768 ||
        !Array.isArray(source.parts) || source.parts.length > 128 || !source.parts.some(part => part?.kind === 'image')) throw rejected()
    const value = JSON.stringify([key, source.messageId, source.sender, source.occurredAt, source.text, source.parts])
    if (value.length > 65_536 || !allowed(value)) throw rejected()
    return value
  }
  function discard(row: Pending) {
    const index = waiting.indexOf(row)
    if (index !== -1) waiting.splice(index, 1)
    row.guard.signal.removeEventListener('abort', row.onAbort)
    known.delete(row.identity); row.lifetime.abort(); row.release()
  }
  async function run(row: Pending) {
    const { guard } = row
    try {
      await guard.ensureCurrent()
      const images = await abortableAgentWeb(Promise.resolve().then(() => {
        if (!guard.isCurrent()) throw rejected()
        return row.input.read(guard)
      }), guard.signal)
      await guard.ensureCurrent()
      if (!Array.isArray(images)) return
      for (const raw of images.slice(0, row.imageCount)) {
        await guard.ensureCurrent()
        if (!raw || typeof raw.base64 !== 'string' || raw.base64.length > MAX_IMAGE_BASE64 || !allowed(raw.base64)) continue
        let image: MessageImage
        try {
          image = validateAgentToolImage(raw)
          if (!allowed(Buffer.from(image.base64, 'base64').toString('utf8'))) continue
        } catch { continue }
        await guard.ensureCurrent()
        await abortableAgentWeb(Promise.resolve().then(() => {
          if (!guard.isCurrent()) throw rejected()
          return options.collect({ mime: image.mime, base64: image.base64 }, { binding: row.binding, source: row.source, ...guard })
        }), guard.signal)
        await guard.ensureCurrent()
      }
    } catch { /* Background collection never interrupts the admitted chat. */ }
  }
  function pump() {
    if (stopped || pumping) return
    pumping = true
    try {
      for (const row of active.keys()) if (!row.guard.isCurrent()) row.lifetime.abort()
      for (const row of [...waiting]) if (!row.guard.isCurrent()) discard(row)
      while (active.size < 2) {
        const index = waiting.findIndex(row => ![...active.keys()].some(running => running.scope === row.scope))
        if (index === -1) break
        const row = waiting.splice(index, 1)[0]!
        const task = abortableAgentWeb(Promise.resolve().then(() => run(row)), row.guard.signal).catch(() => {}).finally(() => {
          active.delete(row); discard(row); pump()
        })
        active.set(row, task)
      }
    } finally { pumping = false }
  }
  return Object.freeze({
    enqueue(input: AgentLocalEmojiIngressInput): void {
      let released = false
      const release = () => { if (!released) { released = true; try { input.release?.() } catch {} } }
      try {
        if (stopped || !options.enabled()) { release(); return }
        const expected = identity(input), original = input.guard
        if (!original || !(original.signal instanceof AbortSignal) || typeof original.isCurrent !== 'function' || typeof original.ensureCurrent !== 'function' || typeof input.read !== 'function') throw rejected()
        const lifetime = new AbortController(), signal = AbortSignal.any([original.signal, stop.signal, lifetime.signal, AbortSignal.timeout(90_000)])
        const guard: AgentLocalEmojiIngressGuard = {
          signal,
          isCurrent() {
            try { return !signal.aborted && !stopped && options.enabled() && identity(input) === expected && original.isCurrent() } catch { return false }
          },
          async ensureCurrent() {
            if (!guard.isCurrent()) throw rejected()
            await abortableAgentWeb(Promise.resolve().then(() => {
              if (!guard.isCurrent()) throw rejected()
              return original.ensureCurrent()
            }), signal)
            if (!guard.isCurrent()) throw rejected()
          },
        }
        if (!guard.isCurrent() || known.has(expected)) { lifetime.abort(); release(); return }
        const row: Pending = { scope: conversationAddressKey(input.binding.target), identity: expected, input,
          binding: structuredClone(input.binding), source: { messageId: input.source.messageId!, author: structuredClone(input.source.sender), occurredAt: input.source.occurredAt },
          imageCount: Math.min(2, input.source.parts.filter(part => part.kind === 'image').length), guard, lifetime, release,
          onAbort() { if (waiting.includes(row)) { discard(row); pump() } },
        }
        pump()
        const sameScope = waiting.filter(pending => pending.scope === row.scope)
        if (sameScope.length >= 2) discard(sameScope[0]!)
        if (waiting.length >= 64) discard(waiting[0]!)
        known.add(expected); waiting.push(row); signal.addEventListener('abort', row.onAbort, { once: true }); pump()
      } catch { release() }
    },
    async stop(): Promise<void> {
      stopped = true; stop.abort()
      for (const row of [...waiting]) discard(row)
      await Promise.allSettled([...active.values()])
    },
  })
}
