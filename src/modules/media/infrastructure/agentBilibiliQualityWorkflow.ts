import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentBilibiliAuthService, AgentBilibiliAuthSession, AgentBilibiliAuthSource, SendRequesterBilibiliAuthAction } from '../../../contracts/agentBilibiliAuth.js'
import type { AgentBilibiliQualityConfig, AgentBilibiliQualityProvider } from '../../../contracts/agentBilibiliQuality.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { withDeliveryGuard } from '../../messaging/infrastructure/deliveryScope.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import { validateAgentMediaPreparedPageUrl } from './agentMediaRelayReference.js'
import { douyinGuard } from './agentDouyinRelayHttp.js'
import { ownBilibiliQualityData, isAgentBilibiliQualityCommand, parseAgentBilibiliQualityCommand, validateAgentBilibiliQualityConfig } from './agentBilibiliQualityPolicy.js'
import { createAgentBilibiliQualityStore, type AgentBilibiliQualityClaim, type AgentBilibiliQualityStage, type AgentBilibiliQualityState } from './agentBilibiliQualityStore.js'
export { isAgentBilibiliQualityCommand, validateAgentBilibiliQualityConfig } from './agentBilibiliQualityPolicy.js'

export interface AgentBilibiliQualityContext extends AgentMediaResourceContext {
  readCurrent(): Promise<IncomingMessage | undefined>
  release?(): void
}
export interface AgentBilibiliQualityWorkflowOptions {
  readonly storage: AgentInboxRedis
  readonly auth: AgentBilibiliAuthService
  provider(binding: AgentBindingSnapshot): AgentBilibiliQualityProvider | undefined
  readonly actions: Pick<MessageActionPort, 'send' | 'sendMediaRelay'> & {
    sendRequesterBilibiliAuth?(action: SendRequesterBilibiliAuthAction, context: { readonly signal: AbortSignal; isCurrent(): boolean }): Promise<DeliveryReceipt>
  }
  readonly allowsText?: (text: string) => boolean
  readonly secrets?: readonly string[]
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  explainFailure?(input: { readonly binding: AgentBindingSnapshot; readonly source: AgentBilibiliAuthSource; readonly detail: string; readonly signal: AbortSignal; isCurrent(): boolean; ensureCurrent(): Promise<void> }): Promise<string | undefined>
  readonly now?: () => number
}
interface Task { readonly binding: AgentBindingSnapshot; readonly source: AgentBilibiliAuthSource; readonly cancel: AbortController; readonly done: Promise<void>; finish(): void }
const failure = () => new Error('B站高清命令、来源、权限或交付不可用')
const sourceHash = (message: IncomingMessage) => {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value
  return createHash('sha256').update(JSON.stringify(canonical([message.conversation, message.messageId, message.sender, message.occurredAt, message.text, message.parts, message.mentions, message.quote]))).digest('hex')
}
function delivery(value: unknown): Exclude<AgentBilibiliQualityState, 'pending'> {
  try {
    const row = ownBilibiliQualityData(value) as DeliveryReceipt
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !['state', 'messageId', 'code'].includes(key))) return 'unknown'
    return row.state === 'failed' ? 'failed' : row.state === 'sent' && isPlatformIdentifier(row.messageId) && !/^0+$/u.test(row.messageId) ? 'sent' : 'unknown'
  } catch { return 'unknown' }
}

/** Deterministic human commands only. The host supplies live standalone source/lease authority. */
export function createAgentBilibiliQualityWorkflow(input: AgentBilibiliQualityConfig, options: AgentBilibiliQualityWorkflowOptions) {
  const config = validateAgentBilibiliQualityConfig(input), store = createAgentBilibiliQualityStore(options.storage, options), now = options.now ?? Date.now
  const secrets = createAgentSecretTextCheck(options.secrets ?? [])
  const safe = (text: string) => { try { return secrets(text) && options.allowsText?.(text) !== false && sanitizeFinalReplyText(text) === text } catch { return false } }
  const tasks = new Set<Task>(), logins = new Map<string, Task>()
  let running = false, closing: Promise<void> | undefined
  const traceId = () => {
    try { const value = options.diagnostics?.traceId(); if (value && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) return value } catch { /* Use a local query ID. */ }
    return randomUUID()
  }
  const emit = (operation: string, state: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string, trace = traceId()) => {
    try { if (options.diagnostics) { options.diagnostics.emit({ stage: 'runtime', operation, outcome: state, code }); return } } catch { /* Preserve a metadata-only terminal record. */ }
    try { console.error(`[Agent] runtime/${operation} ${state} ${code} trace=${trace}`) } catch { /* No writable observer remains. */ }
  }
  const master = (who: PlatformUserRef) => config.masters.some(value => platformAccountKey(value) === platformAccountKey(who))
  const seed = (binding: AgentBindingSnapshot) => config.whitelist?.find(row => conversationAddressKey(row.target) === conversationAddressKey(binding.target))?.users ?? []
  const allowed = async (binding: AgentBindingSnapshot, who: PlatformUserRef) => master(who) || (await store.users(binding, seed(binding))).some(value => platformAccountKey(value) === platformAccountKey(who))
  const loginKey = (binding: AgentBindingSnapshot) => JSON.stringify([platformAccountKey(binding.target.account), binding.agentId])
  const cancelMatching = (predicate: (task: Task) => boolean) => { for (const task of tasks) if (predicate(task)) task.cancel.abort() }
  const api = {
    async start(): Promise<void> { if (closing) throw failure(); if (running || !config.enabled) return; await store.recover(); if (closing) throw failure(); running = true },
    async stop(): Promise<void> {
      closing ??= (async () => { running = false; cancelMatching(() => true); await Promise.allSettled([...tasks].map(task => task.done)); await options.auth.close() })()
      return closing
    },
    invalidate(target: ConversationAddress): void { cancelMatching(task => conversationAddressKey(task.binding.target) === conversationAddressKey(target)) },
    invalidateAccount(account: PlatformAccountRef): void { cancelMatching(task => platformAccountKey(task.binding.target.account) === platformAccountKey(account)) },
    invalidateSource(target: ConversationAddress, messageId: string): void { cancelMatching(task => conversationAddressKey(task.binding.target) === conversationAddressKey(target) && task.source.messageId === messageId) },
    invalidateSubject(account: PlatformAccountRef, author: PlatformUserRef): void { cancelMatching(task => platformAccountKey(task.binding.target.account) === platformAccountKey(account) && platformAccountKey(task.source.author) === platformAccountKey(author)) },
    async handle(original: IncomingMessage, selected: AgentBindingSnapshot, context: AgentBilibiliQualityContext): Promise<{ consumed: boolean }> {
      const early = (consumed: boolean) => {
        try { context.release?.() } catch { emit('bilibili_quality_context', 'failed', 'context_release_unavailable') }
        return { consumed }
      }
      if (!isAgentBilibiliQualityCommand(original)) return early(false)
      if (!config.enabled || !running) return early(true)
      let message: IncomingMessage, binding: AgentBindingSnapshot
      try {
        message = ownBilibiliQualityData(original); binding = ownBilibiliQualityData(selected)
        if (message.version !== 1 || !isConversationAddress(message.conversation) || !['group', 'private'].includes(message.conversation.kind) ||
            binding.source !== 'configured' || conversationAddressKey(binding.target) !== conversationAddressKey(message.conversation) ||
            binding.id !== conversationAddressKey(binding.target) || !isPlatformAccount(message.sender) || !samePlatformNamespace(message.sender, binding.target.account) ||
            message.sender.id === binding.target.account.id || !isPlatformIdentifier(message.messageId) || /^0+$/u.test(message.messageId) ||
            !Number.isSafeInteger(message.occurredAt) || message.occurredAt <= 0 || message.binding && agentBindingToken(message.binding) !== agentBindingToken(binding) || !safe(message.text.trim())) throw failure()
      } catch { emit('bilibili_quality_command', 'failed', 'source_invalid'); return early(true) }
      const command = parseAgentBilibiliQualityCommand(message)!, fingerprint = sourceHash(message)
      const source: AgentBilibiliAuthSource = Object.freeze({ target: binding.target, messageId: message.messageId!, author: message.sender, occurredAt: message.occurredAt, textSha256: createHash('sha256').update(message.text).digest('hex') })
      const queryId = traceId()
      const report = (operation: string, state: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string) => emit(operation, state, code, queryId)
      let complete!: () => void
      const task: Task = { binding, source, cancel: new AbortController(), done: new Promise<void>(resolve => { complete = resolve }), finish: () => complete() }
      tasks.add(task)
      let claim: AgentBilibiliQualityClaim | undefined, detached = false, uncertain = false, session: AgentBilibiliAuthSession | undefined
      let permission: (() => Promise<boolean>) | undefined
      const live = () => { try { return running && !task.cancel.signal.aborted && !context.signal.aborted && context.isCurrent() === true && agentBindingToken(selected) === agentBindingToken(binding) } catch { return false } }
      const guard = douyinGuard({ signal: AbortSignal.any([task.cancel.signal, context.signal]), isCurrent: live, async ensureCurrent() {
        await context.ensureCurrent?.()
        if (!live()) throw failure()
        const fresh = await context.readCurrent()
        if (!fresh || sourceHash(ownBilibiliQualityData(fresh)) !== fingerprint || !live() || claim && !await store.current(claim) || permission && !await permission()) throw failure()
        if (!live()) throw failure()
      } }, command.kind === 'auth' && command.operation === 'login' ? 175_000 : 15 * 60_000)
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        try {
          try { session?.cancel() } catch { report('bilibili_auth_session', 'failed', 'session_cancel_unavailable') }
          guard.close()
        } finally {
          tasks.delete(task); if (logins.get(loginKey(binding)) === task) logins.delete(loginKey(binding))
          try { context.release?.() } catch { report('bilibili_quality_context', 'failed', 'context_release_unavailable') }
          finally { task.finish() }
        }
      }
      const native = async (stage: AgentBilibiliQualityStage, send: () => Promise<unknown>) => {
        await guard.ensure(); await store.begin(claim!, stage); await guard.ensure()
        let state: Exclude<AgentBilibiliQualityState, 'pending'>
        try { state = delivery(await guard.wait(withDeliveryGuard(guard.context.isCurrent, send))) }
        catch { state = 'unknown'; report('bilibili_quality_delivery', 'unknown', `stage_${stage}_transport_unconfirmed`) }
        uncertain ||= state === 'unknown'
        try { await store.finish(claim!, stage, state) }
        catch {
          // After dispatch, a failed durable receipt is uncertain even when
          // transport returned success. It must never open a fallback send.
          uncertain = true
          report('bilibili_quality_ledger', 'failed', 'delivery_receipt_unavailable')
          throw failure()
        }
        report('bilibili_quality_delivery', state === 'sent' ? 'succeeded' : state, `stage_${stage}_${state}`)
        return state
      }
      const groupText = (stage: AgentBilibiliQualityStage, text: string) => {
        if (!safe(text)) throw failure()
        return native(stage, () => options.actions.send({ version: 1, kind: 'message.send', target: binding.target, binding, replyTo: source.messageId, parts: [{ kind: 'text', text }] }, { isCurrent: guard.context.isCurrent }))
      }
      const privateText = (stage: AgentBilibiliQualityStage, text: string) => {
        if (!safe(text) || !options.actions.sendRequesterBilibiliAuth) throw failure()
        return native(stage, () => options.actions.sendRequesterBilibiliAuth!({ version: 1, kind: 'bilibili-auth.notify', binding, source, content: { kind: 'text', text } }, { signal: guard.signal, isCurrent: guard.context.isCurrent }))
      }
      const settle = async (state: 'sent' | 'failed' | 'unknown') => {
        try { if (claim) await store.settle(claim, state); claim = undefined }
        catch {
          uncertain ||= state !== 'failed'
          report('bilibili_quality_ledger', 'failed', 'terminal_state_unavailable')
          throw failure()
        }
      }
      const settleAfterFailure = async () => {
        try { await settle(uncertain ? 'unknown' : 'failed') }
        catch { report('bilibili_quality_ledger', 'failed', 'terminal_state_unavailable') }
      }
      const releasePrepared = async (prepared: { release(): Promise<void> }) => {
        try { await prepared.release() }
        catch { report('bilibili_quality_cleanup', 'failed', 'prepared_release_unavailable') }
      }
      const explain = async () => {
        if (!claim || uncertain) return
        try {
          await guard.ensure()
          report('bilibili_quality_failure_notice', 'started', 'explanation_requested')
          const detail = 'B站高清或授权操作未完成，未确认交付；请核对当前权限、来源或服务状态。'
          await store.begin(claim, 'failure'); await guard.ensure()
          let text: string | undefined
          try { text = await guard.wait(Promise.resolve(options.explainFailure?.({ binding, source, detail, ...guard.context, ensureCurrent: guard.ensure }))) }
          catch { report('bilibili_quality_failure_notice', 'failed', 'explanation_model_unavailable'); await guard.ensure() }
          if (typeof text !== 'string' || text.length > 1800 || !safe(text) || /(?:https?:|data:|base64:|file:)/iu.test(text)) text = `B站操作未完成，服务暂时异常，未确认发送。查询编号：${queryId}`
          else text += `\n查询编号：${queryId}`
          if (!safe(text)) throw failure()
          // failure was claimed before model work. Its native call must reuse that same pending stage.
          await guard.ensure()
          let state: Exclude<AgentBilibiliQualityState, 'pending'>
          try {
            const sent = withDeliveryGuard(guard.context.isCurrent, () => command.kind === 'auth' && options.actions.sendRequesterBilibiliAuth
              ? options.actions.sendRequesterBilibiliAuth({ version: 1, kind: 'bilibili-auth.notify', binding, source, content: { kind: 'text', text } }, { signal: guard.signal, isCurrent: guard.context.isCurrent })
              : options.actions.send({ version: 1, kind: 'message.send', target: binding.target, binding, replyTo: source.messageId, parts: [{ kind: 'text', text }] }, { isCurrent: guard.context.isCurrent }))
            state = delivery(await guard.wait(sent))
          } catch { state = 'unknown'; report('bilibili_quality_failure_notice', 'unknown', 'notice_transport_unconfirmed') }
          uncertain ||= state === 'unknown'; await store.finish(claim, 'failure', state)
          report('bilibili_quality_failure_notice', state === 'sent' ? 'succeeded' : state, `notice_${state}`)
        } catch { report('bilibili_quality_failure_notice', live() ? 'failed' : 'cancelled', 'explanation_unavailable') }
      }
      try {
        await guard.ensure(); claim = await guard.wait(store.claim(binding, source.messageId, fingerprint))
        if (!claim) return { consumed: true }
        if (command.kind === 'invalid') { await groupText('confirmation', 'B站命令格式无效。高清：.高清搬运 1080P BV号或官方链接；主人可管理高清搬运白名单，或使用 .B站授权 登录/状态/退出。'); await settle(uncertain ? 'unknown' : 'failed'); return { consumed: true } }
        permission = command.kind === 'quality' ? () => allowed(binding, source.author) : async () => master(source.author)
        if (!await permission()) { permission = undefined; await groupText('confirmation', command.kind === 'quality' ? '高清搬运只允许可信主人或本群白名单使用。' : '该B站管理命令只允许可信主人使用。'); await settle(uncertain ? 'unknown' : 'failed'); return { consumed: true } }
        await guard.ensure()
        if (command.kind === 'whitelist') {
          if (command.operation !== 'list') { await store.begin(claim, 'operation'); await guard.ensure(); await store.update(binding, claim, command.users, command.operation === 'add'); await store.finish(claim, 'operation', 'sent') }
          const users = await store.users(binding, seed(binding))
          const state = await groupText('confirmation', command.operation === 'list' ? (users.length ? `本群高清搬运白名单：${users.map(who => who.id).join('、')}。可信主人始终可用。` : '本群高清搬运白名单为空；可信主人始终可用。') : `已${command.operation === 'add' ? '添加' : '删除'}本群高清搬运白名单：${command.users.map(who => who.id).join('、')}。`)
          await settle(state); return { consumed: true }
        }
        if (command.kind === 'quality') {
          const provider = options.provider(binding)
          if (!provider || !options.actions.sendMediaRelay) throw failure()
          const prepared = await guard.wait(provider.prepare(command.request, guard.context), releasePrepared)
          try {
            await guard.ensure(); validateAgentMediaPreparedPageUrl(prepared.pageUrl, command.request.share)
            if (prepared.status !== 'ready' || prepared.requestedQuality !== command.request.quality || !Array.isArray(prepared.actualQualities) || !prepared.actualQualities.length || prepared.actualQualities.length > 128 ||
                prepared.actualQualities.some(value => !Number.isSafeInteger(value.quality) || value.quality < 1 || value.quality > 127 || typeof value.label !== 'string' || !safe(value.label)) || !safe(prepared.infoText)) throw failure()
            const plan = validateAgentMediaRelayPlan(ownBilibiliQualityData(prepared.plan), { allowsText: safe })
            if (!plan.items.some(item => item.parts.some(part => part.kind === 'video'))) throw failure()
            const state = await native('media', () => options.actions.sendMediaRelay!({ version: 1, kind: 'media-relay.send', target: binding.target, binding, mode: 'forward', plan }, { signal: guard.signal, isCurrent: guard.context.isCurrent }))
            if (state === 'failed') throw failure()
            await settle(state)
          } finally { await releasePrepared(prepared) }
          return { consumed: true }
        }
        if (command.operation === 'status') {
          const result = ownBilibiliQualityData(await guard.wait(options.auth.status(binding, guard.context))); await guard.ensure()
          if (!result || typeof result.authorized !== 'boolean' || Object.keys(result).some(key => !['authorized', 'updatedAt'].includes(key)) ||
              result.updatedAt !== undefined && (!Number.isSafeInteger(result.updatedAt) || result.updatedAt < 0)) throw failure()
          await settle(await groupText('confirmation', result.authorized ? '当前绑定已保存B站授权。' : '当前绑定尚无B站授权。')); return { consumed: true }
        }
        if (command.operation === 'logout') {
          const previous = logins.get(loginKey(binding)); previous?.cancel.abort()
          await store.begin(claim, 'operation'); await guard.ensure(); await guard.wait(options.auth.logout(binding, guard.context)); await store.finish(claim, 'operation', 'sent')
          await settle(await groupText('confirmation', '当前绑定的B站授权已退出，待处理扫码已取消。')); return { consumed: true }
        }
        const previous = logins.get(loginKey(binding)); previous?.cancel.abort(); logins.set(loginKey(binding), task)
        if (!options.actions.sendRequesterBilibiliAuth) throw failure()
        await store.begin(claim, 'operation'); await guard.ensure()
        session = await guard.wait(options.auth.start(binding, guard.context), late => late.cancel()); await store.finish(claim, 'operation', 'sent')
        const image = validateAgentToolImage(ownBilibiliQualityData(session.image))
        if (image.mime !== 'image/png' || !secrets(image.base64) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now()) throw failure()
        const pollDeadline = Math.min(session.expiresAt, now() + 170_000)
        const qrState = await native('qr', () => options.actions.sendRequesterBilibiliAuth!({ version: 1, kind: 'bilibili-auth.notify', binding, source, content: { kind: 'qr', mime: 'image/png', base64: image.base64 } }, { signal: guard.signal, isCurrent: guard.context.isCurrent }))
        if (qrState !== 'sent') { await settle(qrState); return { consumed: true } }
        if (binding.target.kind === 'group') {
          const state = await groupText('confirmation', 'B站授权二维码已确认私发给原请求者，请在有效期内扫码。')
          if (state !== 'sent') { await settle(state); return { consumed: true } }
        }
        const pollingSession = session
        const poll = async () => {
          try {
            while (true) {
              await guard.ensure()
              if (now() >= pollDeadline) { await settle(await privateText('result', 'B站授权二维码已过期，请重新发起授权登录。')); return }
              await guard.wait(delay(Math.min(3000, pollDeadline - now()), undefined, { signal: guard.signal }))
              await guard.ensure()
              if (now() >= pollDeadline) continue
              const state = await guard.wait(pollingSession.poll(guard.context)); await guard.ensure()
              if (state === 'waiting') continue
              if (state !== 'success' && state !== 'expired') throw failure()
              await settle(await privateText('result', state === 'success' ? 'B站授权已成功保存到当前绑定。' : 'B站授权二维码已过期，请重新发起授权登录。')); return
            }
          } catch {
            report('bilibili_auth_poll', live() ? 'failed' : 'cancelled', live() ? 'poll_unavailable' : 'poll_cancelled')
            if (live()) await explain()
            await settleAfterFailure()
          }
          finally { cleanup() }
        }
        detached = true; void poll(); return { consumed: true }
      } catch {
        if (claim && !uncertain && live()) await explain()
        await settleAfterFailure()
        report('bilibili_quality_command', uncertain ? 'unknown' : live() ? 'failed' : 'cancelled', uncertain ? 'delivery_unconfirmed' : 'operation_unavailable')
        return { consumed: true }
      } finally { if (!detached) cleanup() }
    },
  }
  return api
}
