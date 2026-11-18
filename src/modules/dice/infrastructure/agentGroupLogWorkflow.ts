import { createHash, randomUUID } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { agentBindingToken, conversationAddressKey, isConversationAddress, isPlatformIdentifier, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { parseAgentGroupLogCommand } from '../domain/agentGroupLogCommand.js'
import type { createAgentGroupLogRenderer } from './agentGroupLog.js'
import type { AgentGroupLogCommandEffect, AgentGroupLogEpochs, AgentGroupLogOwner, AgentGroupLogRow, AgentGroupLogState, AgentGroupLogStore } from './agentGroupLogStore.js'

export interface AgentGroupLogWorkflowPorts {
  store: AgentGroupLogStore
  render: ReturnType<typeof createAgentGroupLogRenderer>
  diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  isRunning(): boolean
  resolveBinding(target: ConversationAddress): AgentBindingSnapshot | undefined
  isBindingCurrent(binding: AgentBindingSnapshot): boolean
  authorized(message: IncomingMessage, binding: AgentBindingSnapshot, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean>
  sourceAllowed(row: AgentGroupLogRow, owner: AgentGroupLogOwner): Promise<boolean>
  canReply(target: ConversationAddress, messageId: string): Promise<boolean>
  allowsText(text: string): boolean
  actions: Pick<MessageActionPort, 'send' | 'sendGroupLog'>
  setAI(target: ConversationAddress, allowed: boolean): void
  failureNotice?(input: { target: ConversationAddress; detail: string; isCurrent: () => Promise<boolean>; signal: AbortSignal }): Promise<string | undefined>
  now?(): number
}

const safeId = (value: unknown): value is string => isPlatformIdentifier(value) && value !== '0'
const allowedAI = (state: AgentGroupLogState) => !state.active || state.aiEnabled
const ownerOf = (binding: AgentBindingSnapshot): AgentGroupLogOwner => ({ target: binding.target, agentId: binding.agentId })
const bodyHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const failed = () => new Error('团录操作没有取得可确认结果')

/** Resource metadata never becomes transcript text; only literal text and fixed type labels are recorded. */
function transcript(message: IncomingMessage, allowsText: (value: string) => boolean): AgentGroupLogRow | undefined {
  const pieces: string[] = []
  for (const part of message.parts) {
    if (part.kind === 'text') pieces.push(part.text)
    else if (part.kind === 'mention') pieces.push('[提及]')
    else if (part.kind === 'image') pieces.push('[图片]')
    else if (part.kind === 'audio') pieces.push('[语音]')
    else if (part.kind === 'video') pieces.push('[视频]')
    else if (part.kind === 'forward') pieces.push('[合并转发]')
    else if (part.kind === 'extension') pieces.push('[平台扩展]')
    else if (part.kind === 'file') {
      if (part.name !== undefined && !allowsText(part.name)) return undefined
      const name = part.name && part.name.length <= 255 && !/[\\/:\u0000-\u001f\u007f-\u009f]/u.test(part.name) ? part.name : undefined
      pieces.push(name ? `[文件：${name}]` : '[文件]')
    }
  }
  const content = pieces.join(''), name = message.senderName ?? message.sender.id
  if (!content.trim() || !allowsText(content) || !allowsText(name)) return undefined
  return { messageId: message.messageId!, authorId: message.sender.id, occurredAt: message.occurredAt, name, content, type: 'message' }
}

function status(state: AgentGroupLogState): string {
  if (!state.log) return '本群还没有团录。使用 .log on [团名] 开始记录。'
  return [`团录状态：${state.active ? '记录中' : '已结束'}`, `团名：${state.log.title}`,
    `开始：${state.log.startedAt}`, ...(state.log.endedAt ? [`结束：${state.log.endedAt}`] : []),
    `消息数：${state.log.count}`, `跑团期间 AI：${state.aiEnabled ? '继续活动' : '静默'}`].join('\n')
}
function list(state: AgentGroupLogState): string {
  if (!state.log) return '本群还没有团录。'
  const history = state.logs.filter(item => item.id !== state.currentId).slice().reverse()
  return ['本群团录：', `当前：${state.log.title}（${state.active ? '记录中' : '已结束'}，${state.log.count} 条）`,
    ...history.slice(0, 10).map((item, index) => `${index + 1}. ${item.title}（${item.count} 条）`),
    ...(history.length > 10 ? [`历史共 ${history.length} 份，仅显示最近 10 份。`] : []),
    '导出：.log export [历史序号或团名] [html]'].join('\n')
}
const invalidCommand = '团录命令需要单独发送纯文字，不要附带引用或提及。可用 .log on [团名]、.log off、.log status、.log list、.log export [序号或团名] [html]、.log end。'
const deniedCommand = '只有可信主人、群主或管理员可以操作团录。'

/** Core owns command authority, source permissions and transport; this workflow never reads a URL or local path. */
export function createAgentGroupLogWorkflow(ports: AgentGroupLogWorkflowPorts) {
  const operations = new Map<string, { target: ConversationAddress; controllers: Set<AbortController> }>()
  const gateReads = new Map<string, number>()
  const generations = new Map<string, number>()
  const now = ports.now ?? Date.now
  const emit = (operation: string, outcome: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string, error?: unknown) => {
    try { ports.diagnostics?.emit({ stage: 'runtime', operation, outcome, code, ...(error === undefined ? {} : { error }) }) }
    catch { /* Diagnostic observers cannot affect recording, receipts or sends. */ }
  }
  function bindingCurrent(binding: AgentBindingSnapshot): boolean {
    try {
      const resolved = ports.resolveBinding(binding.target)
      return ports.isRunning() && ports.isBindingCurrent(binding) && !!resolved && agentBindingToken(resolved) === agentBindingToken(binding)
    } catch { return false }
  }
  async function refreshGate(target: ConversationAddress, binding: AgentBindingSnapshot): Promise<AgentGroupLogState> {
    if (conversationAddressKey(target) !== conversationAddressKey(binding.target)) throw failed()
    const key = conversationAddressKey(target), ticket = (gateReads.get(key) ?? 0) + 1, generation = generations.get(key) ?? 0
    gateReads.set(key, ticket)
    const state = await ports.store.read(ownerOf(binding))
    if (gateReads.get(key) === ticket && (generations.get(key) ?? 0) === generation && bindingCurrent(binding)) ports.setAI(target, allowedAI(state))
    return state
  }
  function invalidate(target: ConversationAddress): void {
    const key = conversationAddressKey(target)
    generations.set(key, (generations.get(key) ?? 0) + 1)
    for (const controller of operations.get(key)?.controllers ?? []) controller.abort()
  }
  function safeText(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim() || value.length > 8_000 || !ports.allowsText(value)) return undefined
    const cleaned = sanitizeFinalReplyText(value).trim()
    return cleaned && cleaned.length <= 4_000 && ports.allowsText(cleaned) ? cleaned : undefined
  }
  function valid(message: IncomingMessage, binding: AgentBindingSnapshot): boolean {
    return isConversationAddress(message.conversation) && message.conversation.kind === 'group' && binding.target.kind === 'group' &&
      conversationAddressKey(message.conversation) === conversationAddressKey(binding.target) && binding.source === 'configured' &&
      safeId(message.messageId) && safeId(message.sender.id) && message.sender.platform === message.conversation.account.platform &&
      message.sender.namespace === message.conversation.account.namespace && Number.isSafeInteger(message.occurredAt) && message.occurredAt > 0 &&
      (!message.binding || agentBindingToken(message.binding) === agentBindingToken(binding))
  }
  return {
    restore: refreshGate,
    invalidate,
    invalidateAccount(account: PlatformAccountRef): void {
      const key = platformAccountKey(account)
      for (const entry of operations.values()) if (platformAccountKey(entry.target.account) === key) invalidate(entry.target)
    },
    async handle(message: IncomingMessage, binding: AgentBindingSnapshot, epochs: AgentGroupLogEpochs): Promise<{ consumed: boolean; aiAllowed: boolean }> {
      const command = parseAgentGroupLogCommand(message.text)
      if (!valid(message, binding) || !bindingCurrent(binding)) return { consumed: !!command, aiAllowed: false }
      const owner = ownerOf(binding), target = message.conversation, messageId = message.messageId!, key = conversationAddressKey(target)
      const controller = new AbortController(), entry = operations.get(key) ?? { target, controllers: new Set<AbortController>() }
      entry.controllers.add(controller); operations.set(key, entry)
      const current = () => !controller.signal.aborted && bindingCurrent(binding)
      const sourceCurrent = async () => current() && await ports.canReply(target, messageId) && current()
      const commandFence = { subjectId: message.sender.id, epochs }
      let queryReference: string = randomUUID()
      try {
        const trace = ports.diagnostics?.traceId()
        if (typeof trace === 'string' && /^[a-z\d:_-]{1,128}$/iu.test(trace)) queryReference = trace
      } catch { /* The generated local reference still makes the terminal fallback identifiable. */ }
      const poll = setInterval(() => { if (!current()) controller.abort() }, 25)
      poll.unref?.()
      let state: AgentGroupLogState | undefined, claimed = false, transportStarted = false
      const result = () => ({ consumed: !!command || !!state && !allowedAI(state), aiAllowed: state ? allowedAI(state) : false })
      const settle = async (outcome: 'confirmed' | 'failed' | 'unknown', id = messageId) => {
        try { await ports.store.settleCommandDelivery(owner, id, outcome) }
        catch (error) { emit('group_log_receipt', 'unknown', 'receipt_not_saved', error); throw error }
      }
      const sendNotice = async (detail: string) => {
        if (!await sourceCurrent()) return
        let notice: string | undefined
        try { notice = safeText(await ports.failureNotice?.({ target, detail, isCurrent: sourceCurrent, signal: controller.signal })) }
        catch (error) { emit('group_log_failure_notice', 'failed', 'explanation_failed', error) }
        if (!notice) {
          notice = safeText(`团录操作未完成，请核对后再发起新的命令。查询编号：${queryReference}`)
          // Hosts without a diagnostic context can still locate this generated fallback reference.
          try { console.error(`[Agent] group_log_failure_notice trace=${queryReference}`) } catch { /* Terminal unavailable. */ }
        }
        if (!notice || !await sourceCurrent()) return
        try {
          const receipt = await ports.actions.send({ version: 1, kind: 'message.send', target, binding, replyTo: messageId,
            parts: [{ kind: 'text', text: notice }] }, { isCurrent: current })
          emit('group_log_failure_notice', receipt.state === 'sent' && safeId(receipt.messageId) ? 'succeeded' : receipt.state === 'failed' ? 'failed' : 'unknown', 'explanation_delivery')
        } catch (error) { emit('group_log_failure_notice', 'unknown', 'explanation_delivery_unconfirmed', error) }
      }
      const noticeBeforeEffect = async () => {
        if (!await sourceCurrent()) return
        const noticeId = `notice-${bodyHash(messageId)}`
        try {
          await ports.store.command(owner, noticeId, { kind: 'status' }, now(), commandFence)
          if (!await ports.store.claimCommandDelivery(owner, noticeId)) return
          // A crash or uncertain explanation send is terminal too; never replay this notice.
          await settle('failed', noticeId)
          await sendNotice('团录记录或命令尚未取得可确认的存储结果，请求仍待处理。')
        } catch (error) { emit('group_log_failure_notice', 'failed', 'notice_claim_unavailable', error) }
      }
      try {
        state = await refreshGate(target, binding)
        if (!await sourceCurrent()) { emit('group_log', 'cancelled', 'source_unavailable'); return result() }
        const latestEpochs = await ports.store.capture(owner, message.sender.id)
        if (latestEpochs.globalEpoch !== epochs.globalEpoch || latestEpochs.sceneEpoch !== epochs.sceneEpoch) {
          emit('group_log', 'cancelled', 'admission_privacy_changed')
          return { consumed: true, aiAllowed: allowedAI(state) }
        }
        if (!command) {
          if (state.active) {
            const row = transcript(message, ports.allowsText)
            if (row && await ports.sourceAllowed(row, owner) && await sourceCurrent()) {
              const written = await ports.store.append(owner, row, epochs)
              emit('group_log_append', written ? 'succeeded' : 'cancelled', written ? 'row_committed' : 'inactive_duplicate_or_revoked')
            } else emit('group_log_append', 'cancelled', 'source_not_allowed')
          }
          state = await refreshGate(target, binding)
          return result()
        }
        const standalone = message.quote === undefined && message.mentions.length === 0 && message.parts.length > 0 &&
          message.parts.every(part => part.kind === 'text') && message.parts.map(part => part.kind === 'text' ? part.text : '').join('') === message.text &&
          ports.allowsText(message.text)
        let explanation: string | undefined
        let effect: AgentGroupLogCommandEffect
        if (!standalone || command.kind === 'invalid') {
          explanation = invalidCommand
          effect = await ports.store.command(owner, messageId, { kind: 'status' }, now(), commandFence)
        } else {
          const authorized = await ports.authorized(message, binding, controller.signal, current)
          if (!await sourceCurrent()) return result()
          if (!authorized) {
            explanation = deniedCommand
            emit('group_log_command', 'failed', 'authority_denied')
            effect = await ports.store.command(owner, messageId, { kind: 'status' }, now(), commandFence)
          } else effect = await ports.store.command(owner, messageId, command.kind === 'end' ? { kind: 'end', format: 'txt' } : command, now(), commandFence)
        }
        // The effect's historical state must never reopen a gate changed by a newer command.
        state = await refreshGate(target, binding)
        if (!await sourceCurrent() || !await ports.store.claimCommandDelivery(owner, messageId)) return result()
        claimed = true
        emit('group_log_command', 'started', 'delivery_claimed')
        if (explanation === undefined && (effect.kind === 'export' || effect.kind === 'end')) {
          if (!effect.selectedLogId) explanation = '没有找到可导出的团录。请用 .log list 查看当前与历史团录。'
          else {
            const snapshot = await ports.store.snapshot(owner, effect.selectedLogId)
            if (!snapshot.rows.length) explanation = '这份团录还没有记录到消息。'
            else {
              const artifact = ports.render(snapshot.document, snapshot.rows, effect.format ?? 'txt')
              for (const row of snapshot.sourceRows) {
                if (!current() || !await ports.sourceAllowed(row, owner) || !current()) throw failed()
              }
              if (!await sourceCurrent()) throw failed()
              if (!await ports.store.isCurrent(owner, snapshot.revision) || !current()) throw failed()
              if (!ports.actions.sendGroupLog) throw failed()
              transportStarted = true
              const receipt = await ports.actions.sendGroupLog({ version: 1, kind: 'group-log.upload', target, binding,
                source: { messageId, sender: message.sender, occurredAt: message.occurredAt, textSha256: bodyHash(message.text) }, log: artifact,
              }, { signal: controller.signal, isCurrent: current })
              if (receipt.state === 'uploaded' && safeId(receipt.fileId)) {
                await settle('confirmed'); emit('group_log_export', 'succeeded', 'upload_confirmed')
              } else if (receipt.state === 'failed') {
                await settle('failed'); emit('group_log_export', 'failed', 'upload_failed')
                await sendNotice('团录完整文件没有取得成功上传回执。')
              } else { await settle('unknown'); emit('group_log_export', 'unknown', 'upload_unconfirmed') }
              return result()
            }
          }
        }
        if (explanation === undefined) {
          if (effect.kind === 'status') explanation = status(state)
          else if (effect.kind === 'list') explanation = list(state)
          else if (effect.kind === 'ai') explanation = `本群跑团期间 AI：${state.aiEnabled ? '继续活动' : '静默'}。`
          else if (effect.kind === 'start') explanation = state.active ? `团录已开启。跑团期间 AI ${state.aiEnabled ? '继续活动' : '静默'}，可用 .骰娘 跑团AI 开/关 调整；.log end 结束并导出，.log off 只结束。` : status(state)
          else explanation = '团录已结束，AI 对话已恢复。使用 .log export 导出完整文件。'
        }
        const text = safeText(explanation)
        if (!text) throw failed()
        if (!await sourceCurrent()) throw failed()
        transportStarted = true
        const receipt = await ports.actions.send({ version: 1, kind: 'message.send', target, binding, replyTo: messageId,
          parts: [{ kind: 'text', text }] }, { isCurrent: current })
        if (receipt.state === 'sent' && safeId(receipt.messageId)) { await settle('confirmed'); emit('group_log_command', 'succeeded', 'reply_confirmed') }
        else if (receipt.state === 'failed') { await settle('failed'); emit('group_log_command', 'failed', 'reply_failed'); await sendNotice('团录命令的说明没有取得成功发送回执。') }
        else { await settle('unknown'); emit('group_log_command', 'unknown', 'reply_unconfirmed') }
        return result()
      } catch (error) {
        emit(command ? 'group_log_command' : 'group_log_append', transportStarted ? 'unknown' : 'failed', transportStarted ? 'delivery_unconfirmed' : 'operation_failed', error)
        if (claimed) {
          await settle(transportStarted ? 'unknown' : 'failed')
          if (!transportStarted) await sendNotice('团录操作没有取得可确认结果，未发送完整导出文件。')
          return result()
        }
        try { state = await refreshGate(target, binding) } catch { /* The original storage error owns the retained inbox row. */ }
        await noticeBeforeEffect()
        throw error
      } finally {
        clearInterval(poll); controller.abort(); entry.controllers.delete(controller)
        if (!entry.controllers.size && operations.get(key) === entry) operations.delete(key)
      }
    },
  }
}

export type AgentGroupLogWorkflow = ReturnType<typeof createAgentGroupLogWorkflow>
