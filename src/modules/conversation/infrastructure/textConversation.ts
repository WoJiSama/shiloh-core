import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { ChatMessage, ChatRequestData, ChatResponse, ChatResponseMessage } from '../../../contracts/modelGateway.js'
import type { ExecutionOptions } from '../../../contracts/modelExecution.js'
import type { PersonMemoryStore } from '../../../contracts/personMemory.js'
import type { PersonaSnapshot } from '../../../contracts/persona.js'
import type { AgentSemanticMemoryRecall } from '../../../contracts/semanticMemory.js'
import type { WebEvidenceQuestion, WebEvidenceRecall } from '../../../contracts/webEvidence.js'
import type { AgentHistoryRecall } from '../../../contracts/agentHistory.js'
import type { CognitionGuard, CognitionRecall } from '../../../contracts/agentCognition.js'
import type { AgentTool, AgentToolContext, AgentQqActionRunner } from '../../../contracts/agentTool.js'
import type { AgentGiftResult } from '../../../contracts/agentQqGift.js'
import type { AgentQzoneResult } from '../../../contracts/agentQzone.js'
import type { AgentRedPacketResult } from '../../../contracts/agentQqRedPacket.js'
import { createAgentHistoryTool } from '../../tools/infrastructure/agentHistoryTool.js'
import { authorizeAgentToolContext } from '../../tools/infrastructure/agentToolAuthorization.js'
import { parseAgentToolArguments, validateAgentToolInput } from '../../tools/infrastructure/agentToolSchema.js'
import type { CoreCapabilityToolFactory } from '../../tools/infrastructure/agentCoreCapabilities.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import { formatPersonMemoryFacts, personMemoryAddress } from '../../memory/infrastructure/personMemoryContext.js'
import { agentPersonaScopeId, conversationAddressKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { textConversationSeconds, type createAgentInbox } from '../../runtime/infrastructure/agentInbox.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { modelContextRequest, optionalContext } from '../../models/domain/requestContext.js'
import type { ConversationTopicRecall } from '../../../contracts/conversationTopic.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { groundFinalReply } from '../application/groundedReply.js'
import { buildPersonaStyleOverride, renderPersonaTemplate, type PersonaText } from '../domain/personaSource.js'
import { enforcePersonaToneBoundary } from '../domain/personaTonePolicy.js'
import { sanitizeFinalReplyText } from '../domain/replySanitizer.js'
import { buildMainSystemPrompt } from '../domain/systemPromptTemplate.js'
import { buildTurnInteractionContext } from '../domain/turnInteractionContext.js'
import { createPersonaSnapshot } from './personaSnapshot.js'
import type { createGroupTextTools, GroupTextToolName } from './groupTextTools.js'
import { groupTextScopedToolNames, groupTextInteractionToolNames, groupTextQqActionToolNames } from './groupTextTools.js'
import { isToolActionDenied } from '../domain/toolActionPolicy.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { generateAgentFailureNotice } from './agentFailureNotice.js'
import { agentTextToolPorts, type AgentTextToolContext, type AgentTextToolPorts } from './agentTextRegistryTools.js'

const textMessageMaxAgeMs = textConversationSeconds * 1000
const maxHistoryTurns = 6
const maxMessageLength = 4_000

type ConversationPersona = { persona: PersonaText; systemContent: string; binding: AgentBindingSnapshot }
export interface TextConversationTrigger {
  readonly reason: 'direct' | 'tracking' | 'smart' | 'repeat'
  readonly sources: readonly IncomingMessage[]
  readonly quote: boolean
  readonly repeatText?: string
  ensureCurrent(): Promise<void>
}
export interface TextConversationReceipt {
  readonly state: 'sent' | 'failed' | 'unknown' | 'cancelled'
  readonly text?: string
  readonly messageId?: string
}

export function createTextConversation(ports: {
  inbox: Pick<ReturnType<typeof createAgentInbox>, 'isTextReplyPending' | 'isTextReplyConfirmed' | 'confirmTextReply' | 'textActionReceipt' | 'textRecallVersion' | 'loadTextHistory' | 'claimTextAction' | 'finishTextAction' | 'claimTextReply' | 'saveTextHistory'> & { confirmTextMedia?: ReturnType<typeof createAgentInbox>['confirmTextMedia']; confirmTextInteraction?: ReturnType<typeof createAgentInbox>['confirmTextInteraction'] }
  actions: MessageActionPort
  personMemory: Pick<PersonMemoryStore, 'getSceneRedactions' | 'query'>
  bindingToken(binding: AgentBindingSnapshot): string
  allowsUndirectedReply?(incoming: IncomingMessage): boolean
  groupToolNames(target: ConversationAddress): readonly GroupTextToolName[]
  privateToolNames?: readonly string[]
  isToolEnabled?(name: string, target: ConversationAddress): boolean
  groupTools: ReturnType<typeof createGroupTextTools>
  checkToolCurrent?(check: () => boolean): boolean
  scopedTools?(target: ConversationAddress, name?: string): readonly AgentTool[]
  registryTools?(target: ConversationAddress): readonly AgentTool[]
  coreCapabilityTool?: CoreCapabilityToolFactory
  videoSelection?(incoming: IncomingMessage, binding: AgentBindingSnapshot): Promise<string | undefined>
  allowsToolInput?(text: string): boolean
  /** The scope checks the supplied turn fence before and after reading live source evidence. */
  scopedContext?(incoming: IncomingMessage, binding: AgentBindingSnapshot, isCurrent: () => boolean, ensureCurrent: () => Promise<void>, signal: AbortSignal,
    registryScope?: { persona: NonNullable<AgentToolContext['persona']>; registerProjection(projection: { isCurrent(): Promise<boolean> }): void }):
    (AgentTextToolContext & Required<Pick<AgentToolContext, 'ensureCurrent'>>) | undefined
  isPrivatePeer(target: ConversationAddress, sender: PlatformUserRef): boolean
  allowsText(text: string): boolean
  reserveGroupTurn(target: ConversationAddress, now: number): Promise<boolean>
  model(request: ChatRequestData, target: ConversationAddress, signal?: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  fallbackText?: string
  now?(): number
  learnConfirmed?(incoming: IncomingMessage, binding: AgentBindingSnapshot, isCurrent: () => boolean): Promise<void>
  readConversationMemory?(incoming: IncomingMessage, viewer: PersonaSnapshot, isCurrent: () => boolean): Promise<{ digest: string; episodes: string }>
  readTopicContext?(binding: AgentBindingSnapshot, authorId: string, messageId: string, text: string, existing: readonly string[], isCurrent: () => boolean,
    signal?: AbortSignal): Promise<ConversationTopicRecall | undefined>
  readSemanticMemory?(incoming: IncomingMessage, isCurrent: () => boolean, signal?: AbortSignal, excludeMessageIds?: readonly string[]): Promise<AgentSemanticMemoryRecall | undefined>
  readWebEvidence?(binding: AgentBindingSnapshot, question: WebEvidenceQuestion, isCurrent: () => boolean, signal?: AbortSignal): Promise<WebEvidenceRecall | undefined>
  readCognition?(incoming: IncomingMessage, guard: CognitionGuard): Promise<CognitionRecall | undefined>
  recordCognitionReply?(incoming: IncomingMessage, binding: AgentBindingSnapshot, reply: string, replyId: string, guard: CognitionGuard, contextNodeIds: readonly string[]): Promise<void>
  readHistory?(incoming: IncomingMessage, input: Record<string, unknown>, isCurrent: () => boolean, signal?: AbortSignal): Promise<AgentHistoryRecall>
  readGroupMemory?(incoming: IncomingMessage, viewer: PersonaSnapshot, isCurrent: () => boolean): Promise<string>
  isGroupMemoryCurrent?(incoming: IncomingMessage, expected: string, guard: () => boolean): Promise<boolean>
  recordGroupReply?(incoming: IncomingMessage, binding: AgentBindingSnapshot, guard: () => boolean): Promise<void>
  recordEpisode?(incoming: IncomingMessage, source: PersonaSnapshot, reply: string, replyId: string, isCurrent: () => boolean): Promise<void>
}) {
  const active = new Map<string, Set<{ current: boolean }>>()

  async function runReply(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean, signal?: AbortSignal,
    trigger?: TextConversationTrigger, observe?: (receipt: TextConversationReceipt) => void): Promise<void> {
    const { conversation: target } = incoming
    const messageId = incoming.messageId
    const now = ports.now?.() ?? Date.now()
    if (!messageId || now - incoming.occurredAt >= textMessageMaxAgeMs || !isCurrent()) return
    try { await trigger?.ensureCurrent() } catch { return }
    const isPrivateChat = target.kind === 'private'
    const privatePeerId = isPrivateChat ? incoming.sender.id : undefined
    const pending = await ports.inbox.isTextReplyPending(target, messageId)
    const recallVersion = await ports.inbox.textRecallVersion(target)
    const binding = selected.binding
    const log = (stage: 'model' | 'tool' | 'runtime', operation: string, outcome: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string, error?: unknown, durationMs?: number) => {
      try { ports.diagnostics?.emit({ stage, operation, outcome, code, ...(error === undefined ? {} : { error }), ...(durationMs === undefined ? {} : { durationMs }) }) }
      catch { /* Optional observers cannot change delivery or cause a replay. */ }
    }
    let textReplyClaimed = false
    const deliver = async (text: string, actionReceipt?: string, memoryCurrent?: () => Promise<boolean>) => {
      try { await trigger?.ensureCurrent() } catch { return }
      if (!ports.allowsText(text)) { log('runtime', 'text_delivery', 'failed', 'forbidden_text'); return }
      if (memoryCurrent && !await memoryCurrent()) { log('runtime', 'text_delivery', 'cancelled', 'authorization_changed'); return }
      if (!isCurrent() || !await ports.inbox.claimTextReply(target, messageId, recallVersion, actionReceipt)) return
      textReplyClaimed = true
      if (memoryCurrent && !await memoryCurrent()) return
      if (!isCurrent()) return
      log('runtime', 'text_delivery', 'started', 'delivery_started')
      try {
        // DingTalk also requires the source ID for private replies without a native quote.
        const receipt = await ports.actions.send({
          version: 1, kind: 'message.send', target, binding, parts: [{ kind: 'text', text }],
          ...(target.account.platform === 'dingtalk' || !isPrivateChat && trigger?.quote !== false ? { replyTo: messageId } : {}),
        }, { isCurrent, async ensureCurrent() {
          if (!isCurrent()) throw new Error('文字回复来源已失效')
          await trigger?.ensureCurrent()
          if (memoryCurrent && !await memoryCurrent()) throw new Error('文字回复记忆权限已改变')
          if (await ports.inbox.textRecallVersion(target) !== recallVersion || !isCurrent()) throw new Error('文字回复来源已失效')
          await trigger?.ensureCurrent()
          if (!isCurrent()) throw new Error('文字回复来源已失效')
        } })
        log('runtime', 'text_delivery', receipt.state === 'sent' ? 'succeeded' : receipt.state, receipt.state === 'failed' ? receipt.code ?? 'delivery_failed' : receipt.state)
        observe?.({ state: receipt.state, text, ...(receipt.state === 'sent' ? { messageId: receipt.messageId } : {}) })
        return receipt
      } catch (error) { log('runtime', 'text_delivery', 'unknown', 'delivery_unconfirmed', error); observe?.({ state: 'unknown' }); return { state: 'unknown' as const } }
    }
    if (!pending) {
      if (isCurrent() && await ports.inbox.isTextReplyConfirmed(target, messageId)) {
        // Trigger classification can change after restart. A confirmed trigger
        // must never re-admit a repeat or a merged source as new learning.
        if (!trigger) await ports.learnConfirmed?.(incoming, binding, isCurrent)
        return
      }
      const actionReceipt = await ports.inbox.textActionReceipt(target, messageId)
      if (actionReceipt !== undefined) {
        // An interrupted action can include an unknown notification delivery.
        // Without a final owned reply receipt, replay must not send anything else.
        if (!actionReceipt) { log('tool', 'group_text_tool', 'unknown', 'interrupted_action_unconfirmed'); return }
        await deliver(actionReceipt, actionReceipt)
      }
      return
    }
    const user = safeTruncateUnicode(incoming.text.trim(), maxMessageLength)
    if (!user) return
    const bindingToken = ports.bindingToken(binding)
    const { botId, scene } = personMemoryAddress(target, privatePeerId)
    const historyPeerId = scene.kind === 'private' ? scene.peerId : undefined
    const identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
    const snapshot = createPersonaSnapshot({
      ...identity,
      persona: { ...selected.persona, name: String(selected.persona.name ?? '') },
      systemContent: selected.systemContent,
      binding,
    })
    const blacklist = snapshot.persona.blacklist
    const aiFlavorPhrases = Array.isArray(blacklist) ? blacklist.map(String) : typeof blacklist === 'string' ? [blacklist] : []
    const [saved, { invalidatedAt }] = await Promise.all([
      ports.inbox.loadTextHistory(target), ports.personMemory.getSceneRedactions({ identity, scene }),
    ])
    const memoryCurrent = async () => {
      try { await trigger?.ensureCurrent() } catch { return false }
      if (!isCurrent() || (await ports.personMemory.getSceneRedactions({ identity, scene })).invalidatedAt !== invalidatedAt || !isCurrent()) return false
      try { await trigger?.ensureCurrent() } catch { return false }
      if (!isCurrent() || await ports.inbox.textRecallVersion(target) !== recallVersion || !isCurrent()) return false
      try { await trigger?.ensureCurrent() } catch { return false }
      return isCurrent()
    }
    const turns = saved?.bindingToken === bindingToken && saved.personaVersion === snapshot.personaVersion &&
      (!isPrivateChat || saved.privatePeerId === historyPeerId) &&
      (saved.personMemoryInvalidatedAt ?? 0) === invalidatedAt ? saved.turns : []
    const quoteId = incoming.quote?.messageId
    const isReplyToBot = quoteId !== undefined && turns.some(turn => turn.replyId === quoteId)
    if (!isPrivateChat && !incoming.directedToAccount && !isReplyToBot && !trigger && !ports.allowsUndirectedReply?.(incoming)) return
    if (trigger) {
      if (isPrivateChat || !trigger.sources.length || trigger.sources.length > 20 || !trigger.sources.some(source => source === incoming) ||
          trigger.sources.some(source => !source.messageId || conversationAddressKey(source.conversation) !== conversationAddressKey(target) ||
            !samePlatformNamespace(source.sender, target.account)) || !await memoryCurrent()) return
      if (trigger.reason === 'repeat') {
        if (!trigger.repeatText || trigger.repeatText !== incoming.text) return
        const text = sanitizeFinalReplyText(trigger.repeatText, { aiFlavorPhrases })
        if (text !== trigger.repeatText || !ports.allowsText(text) || !await ports.reserveGroupTurn(target, now)) return
        const receipt = await deliver(text, undefined, memoryCurrent)
        if (receipt?.state === 'sent' && await memoryCurrent()) await ports.inbox.confirmTextReply(target, messageId, recallVersion)
        return
      }
    }
    const webEvidence = incoming.parts.some(part => part.kind === 'forward') ? undefined : await ports.readWebEvidence?.(binding,
      { messageId, authorId: incoming.sender.id, at: incoming.occurredAt, text: incoming.text }, isCurrent, signal)
    const toolEnabled = (name: string) => ports.isToolEnabled?.(name, target) !== false &&
      (!webEvidence || ['webParserTool', 'searchInformationTool', 'chatHistoryTool'].includes(name))
    const allowedToolNames = (): readonly GroupTextToolName[] => (isPrivateChat
      ? ['commitmentTool', ...(ports.privateToolNames ?? [])] : ports.groupToolNames(target)).filter(toolEnabled)
    const allowed = [...allowedToolNames()]
    const requestContext: AgentToolContext = {
      binding, actor: { kind: 'user', user: incoming.sender }, signal: signal ?? new AbortController().signal,
      request: { messageId, text: incoming.text, mentions: incoming.mentions, occurredAt: incoming.occurredAt }, isCurrent,
    }
    const historyTool = ports.readHistory && toolEnabled('chatHistoryTool') ? createAgentHistoryTool() : undefined
    const historyDefinition = historyTool && { type: 'function', function: { name: historyTool.name, description: historyTool.description, parameters: historyTool.parameters } }
    const scopedTools = ports.scopedContext ? (ports.scopedTools?.(target) ?? []).filter(tool =>
      groupTextScopedToolNames.some(name => name === tool.name) && allowed.some(name => name === tool.name) &&
      (!groupTextQqActionToolNames.some(name => name === tool.name) || !isPrivateChat && !isToolActionDenied(user, tool.name))) : []
    const scopedDefinitions = scopedTools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
    const registryProjections: { isCurrent(): Promise<boolean> }[] = [], registryUsedTools: AgentTool[] = []
    const coreTool = ports.coreCapabilityTool?.(binding, { messageId, authorId: incoming.sender.id, at: incoming.occurredAt },
      isCurrent, isCurrent => registryProjections.push({ isCurrent }))
    const registryAvailable = (tool: AgentTool) => toolEnabled(tool.name) && (tool === coreTool || (ports.registryTools?.(target) ?? []).includes(tool) &&
      (isPrivateChat ? ports.privateToolNames ?? [] : ports.groupToolNames(target)).includes(tool.name) &&
      !groupTextScopedToolNames.some(name => name === tool.name))
    const registryTools = ports.scopedContext ? [...(ports.registryTools?.(target) ?? []), ...(coreTool ? [coreTool] : [])].filter(registryAvailable) : []
    const registryDefinitions = registryTools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
    const tools = [...ports.groupTools.definitions(allowed, isPrivateChat), ...(historyDefinition ? [historyDefinition] : []), ...scopedDefinitions, ...registryDefinitions]
      .sort((a, b) => (a.function?.name ?? '').localeCompare(b.function?.name ?? '', 'en'))
    const time = tools.length ? new Date(now).toISOString() : undefined
    const subjectId = incoming.sender.id
    const recalled = await ports.personMemory.query({ identity, scene, subjectId, viewerUserId: subjectId,
      query: user, limit: 4, localOnly: isPrivateChat, now })
    if (!await memoryCurrent()) return
    const memoryFacts = formatPersonMemoryFacts(recalled.items)
    const narrative = await ports.readConversationMemory?.(incoming, snapshot, isCurrent)
    if (!await memoryCurrent()) return
    let semanticIncomplete = false
    const relevantTurns = turns.filter(turn => turn.user && turn.reply && (isPrivateChat || turn.speakerId === incoming.sender.id))
    const visibleSources = [...(trigger?.sources ?? []), ...relevantTurns].map(source => source.messageId).filter((id): id is string => !!id)
    const sharedSources = [...new Set(visibleSources)]
    const topic = await ports.readTopicContext?.(binding, incoming.sender.id, messageId, user, sharedSources, isCurrent, signal).catch(() => undefined)
    const semantic = await ports.readSemanticMemory?.(incoming, isCurrent, signal, [...sharedSources, ...(topic?.messageIds ?? [])]).catch(error => {
      semanticIncomplete = true; log('runtime', 'text_semantic_memory', 'failed', 'memory_read_failed', error); return undefined
    })
    semanticIncomplete ||= semantic?.incomplete === true
    if (!await memoryCurrent()) return
    const groupMemory = !isPrivateChat ? await ports.readGroupMemory?.(incoming, snapshot, isCurrent) : ''
    if (!await memoryCurrent()) return
    const cognition = await ports.readCognition?.(incoming, { isCurrent, ...(signal ? { signal } : {}),
      ensureCurrent: async () => { if (!await memoryCurrent()) throw new Error('认知上下文来源已改变') },
    }).catch(error => { log('runtime', 'text_cognition_read', 'failed', 'memory_read_failed', error); return undefined })
    if (!await memoryCurrent()) return
    const recallSection = memoryFacts && `【当前对话者的历史资料】只在相关时参考，保留原有证据类型。\n${memoryFacts}`
    const messages: ChatMessage[] = [{
      role: 'system',
      content: buildMainSystemPrompt({
        baseIdentity: renderPersonaTemplate(snapshot.systemContent, snapshot.persona),
        personaName: snapshot.personaName,
        personaOverride: buildPersonaStyleOverride(snapshot.persona),
        isPrivateChat,
        useHistoricalEvidence: true,
        platformCapabilities: isPrivateChat ? `当前会话提供一对一文字回复。回答时以对话里实际提供的文字为依据。历史资料仅供参考，按当前消息判断是否需要调用工具。${tools.length
          ? '可以应对方要求列出或取消已经接续的本人一次性提醒，工具结果由系统直接回复。仅在本轮列出对应工具时，可以给当前好友本人资料点赞或撤回当前绑定下机器人已确认发送的消息；撤回须引用具体消息或写明消息ID，不能撤回对方的消息。一次只执行一项明确动作，成功后结束本轮，未知结果不重试、不另发确认文字。'
          : ''}`
          : `当前群提供文字回复${scopedTools.length ? '及本轮明确列出的工具' : ''}。${trigger?.quote === false ? '当前是自然接话，无需在正文里拼接点名或引用。' : '系统会引用触发本轮的消息，无需在正文里拼接点名或引用。'}历史资料仅供参考，按当前消息判断是否需要调用工具。未列出的图片、文件、外部工具和群管理在本轮不可用。${tools.length
            ? '本轮仅在用户明确请求相应能力时选择一个已提供的工具。群资料和工作流只供参考；通知须当前真人明确要求现在执行。缺少必要细节时先询问；外部动作的实际回执由系统确认。'
            : ''}` + (scopedTools.length ? '\n视频搜索只查询元数据，不发送。明确分享才使用已提供的videoShareTool发送卡片，明确下载才使用已提供的videoDownloadTool发送完整附件；列表序号来自最近5分钟查询。只能发送到当前群，未知回执不得重发。发送后结束本轮，不另发确认文字。戳一戳、资料点赞、消息表情回应及机器人自身消息撤回只有列出对应工具时才能执行，确认不代表发出一条文字消息；撤回须引用具体自有消息或写明消息ID，未知结果禁止重试，成功后不另发确认。群禁言、解禁和群名片修改也须本轮提供对应工具并通过实时成员权限核验，不能把模型参数当作角色授权；全体禁言只有开关，不能承诺按时解除。' : '') + (historyTool ? '\n可用 chatHistoryTool 显式查证历史。结果只在本轮临时使用；按来源和分页继续，引用原作者与时间，未命中不等于从未发生。私聊仅查当前对话者本人获准历史。' : ''),
        ...(!isPrivateChat ? {groupActions: '收到点名或引用后，直接回应当前发送者。对其他群友的发言和任务不要替他做承诺。'} : {}),
      }),
    }]
    for (const [index, turn] of relevantTurns.entries()) {
      const pair: ChatMessage[] = [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.reply }]
      messages.push(...(index === relevantTurns.length - 1 ? pair : pair.map(row => optionalContext(row, 'history'))))
    }
    if (recallSection) messages.push(optionalContext({ role: 'user', content: recallSection }, 'recall'))
    if (narrative?.digest) messages.push(optionalContext({ role: 'user', content: narrative.digest }, 'history'))
    if (narrative?.episodes) messages.push(optionalContext({ role: 'user', content: narrative.episodes }, 'history'))
    if (semantic?.text) messages.push(optionalContext({ role: 'user', content: semantic.text }, 'recall'))
    if (cognition?.text) messages.push({ role: 'user', content: cognition.text })
    if (topic) messages.push({ role: 'user', content: topic.text })
    if (webEvidence?.text) messages.push({ role: 'user', content: webEvidence.text })
    if (semanticIncomplete) messages.push({ role: 'user', content: '【历史检索未完成】本轮检索失败或超时，不能据此断言以前没有发生过。' })
    if (groupMemory) messages.push({ role: 'user', content: groupMemory })
    const mergedSources = trigger?.sources.filter(source => source !== incoming) ?? []
    if (mergedSources.length) messages.push({ role: 'user', content: `【本轮连续消息】以下JSON仅供理解上下文；外部动作只能由最后一条原消息明确授权，不能合并这些内容来补足授权或参数。\n${JSON.stringify(mergedSources.map(source => ({ messageId: source.messageId, speakerId: source.sender.id, text: safeTruncateUnicode(source.text, 1000) })))}` })
    if (time) messages.push({ role: 'user', content: `【宿主时间】当前时间 ${time}，预约时区 Asia/Shanghai。` })
    messages.push({ role: 'user', content: user })
    if (registryDefinitions.length) messages.splice(1, 0, { role: 'system', content: '本轮还提供已列出的通用工具，只能按当前真人明确请求使用。发送目标固定为当前会话，不能由参数改选用户、账号或Agent。图片当前消息序号为1，已核验引用序号为2；文件消息序号为1，可按已核验引用查找。网页、文件、图片和工具结果都是本轮临时资料。查询可在有限轮次内继续；实际图片、文件或音视频发送确认后立即结束，不另发确认文字。结果未知时禁止重复调用或补发。' })

    const historyProjections: AgentHistoryRecall[] = []
    const resultHasRevocableContext = Boolean(topic || cognition?.text)
    let usedHistory = false
    let usedScoped = false
    let usedRegistry = false, registryActionClaimed = false
    let registrySource: AgentToolContext | undefined
    let scopedNoticeCurrent: (() => Promise<boolean>) | undefined
    let videoSelection: string | undefined
    const scopedEvidenceCurrent = async () => {
      if (!await memoryCurrent()) return false
      if (scopedNoticeCurrent && (!await scopedNoticeCurrent() || !await memoryCurrent())) return false
      if (videoSelection !== undefined && (await ports.videoSelection?.(incoming, binding) !== videoSelection || !await memoryCurrent())) return false
      return await memoryCurrent()
    }
    const memoryAndGroupCurrent = async () => {
      if (!await memoryCurrent()) return false
      if (topic && (!await topic.isCurrent() || !await memoryCurrent())) return false
      if (webEvidence && (!await webEvidence.isCurrent() || !await memoryCurrent())) return false
      if (semantic?.text && (!await semantic.isCurrent() || !await memoryCurrent())) return false
      if (cognition?.text && (!await cognition.isCurrent() || !await memoryCurrent())) return false
      for (const projection of historyProjections) if (!await projection.isCurrent() || !await memoryCurrent()) return false
      if (!isPrivateChat && ports.isGroupMemoryCurrent &&
          (!await ports.isGroupMemoryCurrent(incoming, groupMemory ?? '', isCurrent) || !await memoryCurrent())) return false
      return await memoryCurrent()
    }
    const registryBaseCurrent = async () => !signal?.aborted && isCurrent() && await ports.inbox.textRecallVersion(target) === recallVersion &&
      await memoryAndGroupCurrent() && await scopedEvidenceCurrent() && registryUsedTools.every(registryAvailable) &&
      (registryActionClaimed || textReplyClaimed || await ports.inbox.isTextReplyPending(target, messageId))
    const registryEvidenceCurrent = async () => {
      try {
        if (!await registryBaseCurrent()) return false
        await registrySource?.ensureCurrent?.()
        for (const projection of registryProjections) if (!await projection.isCurrent() || !await registryBaseCurrent()) return false
        return await registryBaseCurrent()
      } catch { return false }
    }
    const modelContextCurrent = async () => (registryActionClaimed || await ports.inbox.isTextReplyPending(target, messageId)) &&
      await ports.inbox.textRecallVersion(target) === recallVersion && await memoryAndGroupCurrent() && await scopedEvidenceCurrent() &&
      (!usedRegistry || await registryEvidenceCurrent())
    const personaSystem = [renderPersonaTemplate(snapshot.systemContent, snapshot.persona), buildPersonaStyleOverride(snapshot.persona)].join('\n')
    const reportFailure = async (stage: 'model' | 'tool' | 'runtime', outcome: 'failed' | 'unknown', detail?: string, actionAttempted = false) => {
      actionAttempted ||= registryActionClaimed
      const sourceCurrent = async () => !signal?.aborted && isCurrent() && await ports.inbox.textRecallVersion(target) === recallVersion && await memoryAndGroupCurrent() && await scopedEvidenceCurrent() && (!usedRegistry || await registryEvidenceCurrent())
      const current = async () => await sourceCurrent() && (actionAttempted || await ports.inbox.isTextReplyPending(target, messageId))
      const notice = await generateAgentFailureNotice({
        model: request => ports.model(request, target, signal, isCurrent, async () => { if (!await current()) throw new Error('失败说明的来源权限已改变') }),
        isCurrent: current, allowsText: ports.allowsText, stage, outcome, personaSystem,
        ...(detail ? { detail } : {}), ...(ports.diagnostics ? { diagnostics: ports.diagnostics } : {}),
        ...(ports.fallbackText ? { fallbackText: ports.fallbackText } : {}),
      })
      if (!notice || !await current()) return
      const text = safeTruncateUnicode(sanitizeFinalReplyText(notice, { aiFlavorPhrases }), 600)
      if (!text || !ports.allowsText(text)) { log('runtime', 'failure_notice', 'failed', 'forbidden_notice'); return }
      try {
        if (!await current()) return
        if (actionAttempted && !usedRegistry && !resultHasRevocableContext && !await ports.inbox.finishTextAction(target, messageId, recallVersion, text)) return
        await deliver(text, registryActionClaimed || actionAttempted && resultHasRevocableContext ? '' : actionAttempted ? text : undefined, sourceCurrent)
      } catch (error) { log('runtime', 'failure_notice', 'failed', 'notice_delivery_unavailable', error) }
    }
    let modelRound = 0
    const modelReply = async (request: ChatRequestData, operation: string): Promise<ChatResponseMessage | undefined> => {
      const started = Date.now()
      log('model', operation, 'started', 'model_started')
      try {
        const result = await ports.model(modelContextRequest(request, 'text', ++modelRound), target, signal, isCurrent, async () => {
          if (!await modelContextCurrent()) throw new Error('模型请求的来源权限已改变')
        })
        if (!await modelContextCurrent()) { log('model', operation, 'cancelled', 'authorization_changed'); return }
        const output = result?.choices?.[0]?.message
        if (result?.error || !output || !output.tool_calls?.length && (typeof output.content !== 'string' || !output.content.trim())) {
          log('model', operation, 'failed', result?.error ? 'model_failed' : 'model_empty', result?.error, Date.now() - started)
          await reportFailure('model', 'failed')
          return
        }
        log('model', operation, 'succeeded', 'model_completed', undefined, Date.now() - started)
        return output
      } catch (error) {
        if (!isCurrent() || signal?.aborted) { log('model', operation, 'cancelled', 'authorization_changed'); return }
        log('model', operation, 'failed', 'model_threw', error, Date.now() - started)
        await reportFailure('model', 'failed')
        return
      }
    }
    const request = { ...buildChatRequestData({useTools: true}, messages, tools), max_tokens: 1_000 }
    if (!isPrivateChat && !await ports.reserveGroupTurn(target, now)) return
    if (!await modelContextCurrent()) return
    let output = await modelReply(request, 'text_reply_model')
    if (!output) return
    // Read-only history can be paged within a bounded model loop. Evidence and
    // all subsequent model output remain ephemeral, including failure results.
    for (let round = 0; round < 3 && output.tool_calls?.length === 1 && output.tool_calls[0]?.function?.name === 'chatHistoryTool'; round++) {
      const readHistory = ports.readHistory
      if (!historyTool || typeof readHistory !== 'function') return
      const call = output.tool_calls[0]!
      const callId = (call as { id?: unknown }).id
      if (typeof callId !== 'string' || !callId.trim() || callId.length > 200) return
      const raw = call.function?.arguments
      const input = parseAgentToolArguments(raw)
      if (typeof raw !== 'string' || !validateAgentToolInput(historyTool, input) || ports.allowsToolInput?.(raw) === false ||
          ports.allowsToolInput?.(JSON.stringify(input)) === false) {
        log('tool', 'text_history', 'failed', 'invalid_tool_arguments')
        await reportFailure('tool', 'failed', '历史查询参数无效，本次没有查询。'); return
      }
      const historyCurrent = () => isCurrent() && toolEnabled(historyTool.name) && ports.readHistory === readHistory
      const context = authorizeAgentToolContext(historyTool, input, {
        ...requestContext, isCurrent: historyCurrent,
        ensureCurrent: async () => { if (!await modelContextCurrent() || !historyCurrent()) throw new Error('历史查询来源已改变') },
        async readHistory(query: Record<string, unknown>) {
          if (!historyCurrent()) throw new Error('历史查询来源已改变')
          const projection = await readHistory.call(ports, incoming, query, historyCurrent, signal)
          historyProjections.push(projection)
          if (!await projection.isCurrent()) throw new Error('历史查询结果已失效')
          return projection.text
        },
      })
      if (!context || !historyCurrent()) return
      usedHistory = true
      let outcome
      try {
        log('tool', 'text_history', 'started', 'tool_execution_started')
        outcome = await historyTool.execute(input, context)
      } catch (error) {
        log('tool', 'text_history', 'failed', 'history_read_failed', error)
        await reportFailure('tool', 'failed', '历史查询没有获得可确认结果。'); return
      }
      if (!await modelContextCurrent()) return
      log('tool', 'text_history', outcome.status === 'succeeded' ? 'succeeded' : outcome.status, 'tool_result_ready')
      if (outcome.status !== 'succeeded') {
        await reportFailure('tool', outcome.status === 'unknown' ? 'unknown' : 'failed', outcome.content); return
      }
      messages.push({ ...output, role: 'assistant' }, { role: 'tool', tool_call_id: callId, name: 'chatHistoryTool', content: outcome.content })
      const next = { ...buildChatRequestData({ useTools: true }, messages, round < 2 && historyDefinition ? [historyDefinition] : []), max_tokens: 1_000 }
      output = await modelReply(next, 'text_history_model')
      if (!output) return
    }
    // A registry turn owns one durable slot before any tool runs. Only the slot
    // is stored: temporary tool results and derived answers stay in this call.
    let registryDelivery: 'sent' | 'uploaded' | 'failed' | 'unknown' | undefined
    const trackDelivery = <A extends unknown[], R extends { readonly state: string }>(send: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
      if (registryDelivery !== undefined || !await registryEvidenceCurrent()) throw new Error('本轮工具投递已结束或来源已失效')
      registryDelivery = 'unknown'
      const receipt = await send(...args)
      registryDelivery = receipt.state === 'sent' || receipt.state === 'uploaded' || receipt.state === 'failed' ? receipt.state : 'unknown'
      return receipt
    }
    for (let round = 0; round < 3 && output.tool_calls?.length === 1 && registryTools.some(tool => tool.name === output!.tool_calls![0]!.function?.name); round++) {
      if (usedHistory || usedScoped || !ports.scopedContext) return
      const call = output.tool_calls[0]!, tool = registryTools.find(tool => tool.name === call.function?.name)!
      const id = (call as { id?: unknown }).id, type = (call as { type?: unknown }).type
      let input: Record<string, unknown>
      try {
        const raw = call.function?.arguments
        if (type !== undefined && type !== 'function' || typeof id !== 'string' || !id.trim() || id.length > 200 ||
            typeof raw !== 'string' || raw.length > 16_000 || !ports.allowsText(raw) || ports.allowsToolInput?.(raw) === false) throw new Error('工具参数无效')
        const parsed = parseAgentToolArguments(raw)
        if (!validateAgentToolInput(tool, parsed) || ports.allowsToolInput?.(JSON.stringify(parsed)) === false) throw new Error('工具参数无效')
        input = parsed
      } catch (error) { log('tool', 'text_registry', 'failed', 'invalid_tool_arguments', error); await reportFailure('tool', 'failed'); return }
      usedRegistry = true; registryUsedTools.push(tool)
      const ensureBase = async () => { if (!await registryBaseCurrent()) throw new Error('文字工具回合已失效') }
      if (!registrySource) registrySource = ports.scopedContext(incoming, binding, () => isCurrent() && registryUsedTools.every(registryAvailable), ensureBase, signal ?? new AbortController().signal, {
        persona: { name: snapshot.personaName, version: snapshot.personaVersion, aliases: [snapshot.personaName],
          ...(snapshot.personaGuard ? { guard: snapshot.personaGuard } : {}) },
        registerProjection: projection => { registryProjections.push(projection) },
      })
      if (!registrySource || !await registryEvidenceCurrent()) return
      const { interact: _interact, runQqAction: _runQqAction, qzone: _qzone, qzoneAffinity: _affinity, qzoneCandidates: _candidates,
        reviewQqText: _review, [agentTextToolPorts]: internal = {}, ...source } = registrySource as AgentTextToolContext
      const internalPorts: AgentTextToolPorts = { ...internal,
        ...(internal.sendFile ? { sendFile: trackDelivery(internal.sendFile) } : {}),
        ...(internal.sendAudio ? { sendAudio: trackDelivery(internal.sendAudio) } : {}),
        ...(internal.sendVideo ? { sendVideo: trackDelivery(internal.sendVideo) } : {}),
        ...(internal.sendMusic ? { sendMusic: trackDelivery(internal.sendMusic) } : {}),
      }
      const candidate: AgentTextToolContext = { ...source, [agentTextToolPorts]: internalPorts,
        ...(source.sendImage ? { sendImage: trackDelivery(source.sendImage) } : {}),
        ...(source.sendBundle ? { sendBundle: trackDelivery(source.sendBundle) } : {}),
        ...(source.sendVideoCard ? { sendVideoCard: trackDelivery(source.sendVideoCard) } : {}),
        ...(source.sendMediaRelay ? { sendMediaRelay: trackDelivery(source.sendMediaRelay) } : {}),
        ...(source.sendMessage ? { sendMessage: trackDelivery(source.sendMessage) } : {}),
      }
      // Native file/media ports live under the registry symbol. Include them in
      // preflight so a missing host capability cannot consume the durable slot.
      const granted = authorizeAgentToolContext(tool, input, { ...internalPorts, ...candidate }, { custom: true })
      if (!granted) { log('tool', tool.name, 'cancelled', 'authorization_changed'); return }
      const context = {
        ...Object.fromEntries(Object.entries(candidate).filter(([key]) => Object.hasOwn(granted, key))),
        [agentTextToolPorts]: Object.fromEntries(Object.entries(internalPorts).filter(([key]) => Object.hasOwn(granted, key))),
      } as unknown as AgentTextToolContext
      if (!registryActionClaimed) {
        registryActionClaimed = await ports.inbox.claimTextAction(target, messageId, recallVersion)
        if (!registryActionClaimed || !await registryEvidenceCurrent()) return
      }
      let outcome
      try {
        log('tool', tool.name, 'started', 'tool_execution_started')
        outcome = await tool.execute(input, context)
        log('tool', tool.name, outcome.status, 'tool_result_ready')
      } catch (error) { log('tool', tool.name, 'unknown', 'tool_execution_failed', error); return }
      if (registryDelivery === 'unknown' || outcome.status === 'unknown') return
      if (registryDelivery === 'sent' || registryDelivery === 'uploaded') {
        if (!await registryEvidenceCurrent()) return
        try { await ports.inbox.confirmTextMedia?.(target, messageId, recallVersion) }
        catch (error) { log('tool', tool.name, 'unknown', 'action_confirmation_unavailable', error) }
        return
      }
      if (!await registryEvidenceCurrent()) return
      if (outcome.status !== 'succeeded' || registryDelivery === 'failed') { await reportFailure('tool', 'failed', outcome.content, true); return }
      if (!outcome.content || outcome.content.length > 32_000 || !ports.allowsText(outcome.content) || ports.allowsToolInput?.(outcome.content) === false) {
        await reportFailure('tool', 'failed', undefined, true); return
      }
      messages.push({ ...output, role: 'assistant' }, { role: 'tool', tool_call_id: id as string, name: tool.name, content: outcome.content })
      output = await modelReply({ ...buildChatRequestData({ useTools: true }, messages, round < 2 ? registryDefinitions : []), max_tokens: 1_000 }, 'text_registry_model')
      if (!output) return
    }
    // Searches may feed one bounded follow-up model call; one explicit delivery
    // owns the existing durable action slot and is the turn's only outbound act.
    for (let round = 0; round < 3 && output.tool_calls?.length === 1 && groupTextScopedToolNames.some(name => name === output!.tool_calls![0]!.function?.name); round++) {
      if (usedHistory || usedRegistry) return
      const call = output.tool_calls[0]!, tool = scopedTools.find(tool => tool.name === call.function?.name)
      if (!tool || !ports.scopedContext || !(ports.scopedTools?.(target, tool.name) ?? []).includes(tool)) return
      const id = (call as { id?: unknown }).id, videoSearch = tool.name === 'searchVideoTool'
      const interaction = groupTextInteractionToolNames.some(name => name === tool.name)
      const qqAction = groupTextQqActionToolNames.some(name => name === tool.name)
      const nonMessage = interaction || qqAction
      const operation = qqAction ? 'text_qq_action' : interaction ? 'text_interaction' : tool.name === 'searchMagnetTool' ? 'text_magnet_search' : 'text_video'
      if (videoSearch) videoSelection = undefined
      const raw = call.function?.arguments, type = (call as { type?: unknown }).type
      const input = parseAgentToolArguments(raw, 4096)
      if (type !== undefined && type !== 'function' || typeof id !== 'string' || !id.trim() || id.length > 200 ||
          typeof raw !== 'string' || raw.length > 4096 || !ports.allowsText(raw) || ports.allowsToolInput?.(raw) === false ||
          !validateAgentToolInput(tool, input) || ports.allowsToolInput?.(JSON.stringify(input)) === false) {
        log('tool', operation, 'failed', 'invalid_tool_arguments')
        await reportFailure('tool', 'failed'); return
      }
      usedScoped = true
      let actionClaimed = false
      const currentToolIsAllowed = () => isCurrent() && !signal?.aborted && allowedToolNames().some(name => name === tool.name) &&
        (ports.scopedTools?.(target, tool.name) ?? []).includes(tool)
      const toolCurrent = () => ports.checkToolCurrent ? ports.checkToolCurrent(currentToolIsAllowed) : currentToolIsAllowed()
      const scopedCurrent = async () => toolCurrent() && await ports.inbox.textRecallVersion(target) === recallVersion &&
        await memoryAndGroupCurrent() &&
        (videoSelection === undefined || await ports.videoSelection?.(incoming, binding) === videoSelection) &&
        (actionClaimed || textReplyClaimed || await ports.inbox.isTextReplyPending(target, messageId)) && toolCurrent()
      const ensure = async () => { if (!await scopedCurrent()) throw new Error('工具来源已失效') }
      const scopeMatchesRequest = (scope: AgentToolContext) =>
        conversationAddressKey(scope.binding.target) === conversationAddressKey(target) && ports.bindingToken(scope.binding) === bindingToken &&
        scope.actor.kind === 'user' && scope.actor.user?.id === incoming.sender.id && samePlatformNamespace(scope.actor.user, incoming.sender) &&
        scope.request?.messageId === messageId && scope.request.text === incoming.text
      scopedNoticeCurrent = async () => {
        try {
          const scope = ports.scopedContext!(incoming, binding, toolCurrent, ensure, requestContext.signal)
          if (!scope || !scopeMatchesRequest(scope) || !await scopedCurrent()) return false
          await scope.ensureCurrent?.()
          return await scopedCurrent() && scope.isCurrent()
        } catch { return false }
      }
      if (!await scopedCurrent()) return
      const controller = new AbortController(), deadline = tool.timeoutMs ?? 45_000
      const toolSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(240_000, Math.max(1, deadline))), ...(signal ? [signal] : [])])
      let outcome
      let sending = false
      let claimStarted = false
      let qqStarted = false, qqEntered = false, qqResult: AgentGiftResult | AgentQzoneResult | AgentRedPacketResult | undefined
      try {
        const scope = ports.scopedContext(incoming, binding, () => toolCurrent() && !toolSignal.aborted, ensure, toolSignal)
        if (!scope || !scopeMatchesRequest(scope)) { log('tool', operation, 'cancelled', 'authorization_changed'); return }
        const scopeCurrent = () => !toolSignal.aborted && scope.isCurrent() && scopeMatchesRequest(scope)
        const scopedEnsure = async () => {
          if (!scopeCurrent()) throw new Error('工具来源已失效')
          await scope.ensureCurrent()
          if (!scopeCurrent()) throw new Error('工具来源已失效')
        }
        const runQqAction: AgentQqActionRunner = async (kind, run) => {
          const expected = tool.name === 'sendGiftTool' ? 'gift' : tool.name === 'grabRedBagTool' ? 'red-packet' : 'qzone'
          if (!qqAction || kind !== expected || qqStarted || !actionClaimed || isPrivateChat || !scopeCurrent()) throw new Error('QQ动作未获本轮授权')
          qqStarted = true
          await scopedEnsure(); qqEntered = true
          const result = await run({ signal: toolSignal, isCurrent: scopeCurrent, ensureCurrent: scopedEnsure })
          qqResult = result
          return result
        }
        const reviewQqText = async (text: string): Promise<boolean> => {
          try {
            await scopedEnsure()
            if (typeof text !== 'string' || !text || text.length > maxMessageLength || sanitizeFinalReplyText(text, { aiFlavorPhrases }) !== text) return false
            const context = buildTurnInteractionContext({ rawUserText: user, addressee: { targetKind: 'bot' } })
            if (enforcePersonaToneBoundary(text, { interactionContext: context, persona: snapshot.persona, toolName: tool.name }) !== text) return false
            const result = await groundFinalReply({ candidate: text, context })
            if (result.text !== text || result.audit.violations.length || result.audit.remaining.length || result.audit.fallback ||
                safeTruncateUnicode(sanitizeFinalReplyText(result.text, { aiFlavorPhrases }), maxMessageLength) !== text ||
                !ports.allowsText(text) || ports.allowsToolInput?.(text) === false) return false
            await scopedEnsure(); return true
          } catch { return false }
        }
        const context = authorizeAgentToolContext(tool, input, {
          ...scope, signal: toolSignal, isCurrent: scopeCurrent, ensureCurrent: scopedEnsure,
          ...(qqAction ? { runQqAction, reviewQqText } : {}),
        }, { custom: true })
        if (!context) { log('tool', operation, 'cancelled', 'authorization_changed'); return }
        sending = tool.effect === undefined
          ? !videoSearch && tool.name !== 'searchMagnetTool' && !(tool.name === 'grabRedBagTool' && input.confirm === false)
          : !!(context.sendVideoCard || context.sendMediaRelay || context.interact || context.runQqAction)
        await scopedEnsure()
        if (!scopeCurrent()) return
        if (sending) {
          claimStarted = true
          actionClaimed = await ports.inbox.claimTextAction(target, messageId, recallVersion)
          if (!actionClaimed) return
          await scopedEnsure()
          if (!scopeCurrent()) return
        }
        log('tool', operation, 'started', 'tool_execution_started')
        outcome = await tool.execute(input, context)
        log('tool', operation, outcome.status === 'succeeded' ? 'succeeded' : outcome.status, 'tool_result_ready')
      } catch (error) {
        log('tool', operation, claimStarted ? 'unknown' : 'failed', 'tool_execution_failed', error)
        if (!sending) await reportFailure('tool', 'failed')
        return
      } finally { controller.abort() }
      if (sending) {
        // Neither a crash nor a duplicate can replay an external action or create
        // an extra confirmation message. These receipts never enter text learning.
        if (outcome.status === 'succeeded' || qqResult?.state === 'confirmed') try {
          if (!await (nonMessage ? ports.inbox.confirmTextInteraction?.(target, messageId, recallVersion) : ports.inbox.confirmTextMedia?.(target, messageId, recallVersion))) log('tool', operation, 'unknown', 'action_confirmation_unavailable')
        } catch (error) { log('tool', operation, 'unknown', 'action_confirmation_unavailable', error) }
        if (qqResult?.state === 'confirmed' || qqResult?.state === 'unknown') return
        let explainFailure = !nonMessage
        if (qqAction && outcome.status === 'failed') {
          if (!qqEntered) explainFailure = true
          else if (qqResult?.state === 'failed') {
            const code = 'code' in qqResult ? String(qqResult.code) : ''
            explainFailure = 'completed' in qqResult ? qqResult.completed === 0 &&
              ['gift_source_unavailable', 'gift_invalid_request', 'gift_claim_unavailable', 'gift_denied', 'gift_invalid_input'].includes(code)
              : 'terminal' in qqResult ? qqResult.terminal === false && !code.startsWith('qzone_already_')
                : qqResult.phase === 'claimed' && !qqResult.passwordConfirmed && !qqResult.grabbed && !code.startsWith('red_packet_already_')
          }
        }
        if (interaction && outcome.status === 'failed') try {
          const result = JSON.parse(outcome.content) as { state?: unknown; completed?: unknown; code?: unknown }
          explainFailure = result.state === 'failed' && result.completed === 0 &&
            !['interaction_already_confirmed', 'interaction_already_failed', 'interaction_already_unknown', 'interaction_claim_conflict'].includes(String(result.code))
        } catch { /* An invalid or previously owned result cannot authorize another model call. */ }
        if (outcome.status === 'failed' && explainFailure && await scopedCurrent()) await reportFailure('tool', 'failed', outcome.content, true)
        return
      }
      if (!await scopedCurrent()) return
      if (outcome.status !== 'succeeded') { await reportFailure('tool', outcome.status === 'unknown' ? 'unknown' : 'failed', outcome.content); return }
      if (!outcome.content || outcome.content.length > 16_000 || !ports.allowsText(outcome.content) || ports.allowsToolInput?.(outcome.content) === false) { await reportFailure('tool', 'failed'); return }
      if (videoSearch && ports.videoSelection) {
        videoSelection = await ports.videoSelection(incoming, binding)
        if (!videoSelection) { log('tool', operation, 'cancelled', 'search_list_replaced'); return }
      }
      messages.push({ ...output, role: 'assistant' }, { role: 'tool', tool_call_id: id as string, name: tool.name, content: outcome.content })
      const nextTools = videoSearch && round < 2 ? scopedDefinitions : []
      output = await modelReply({ ...buildChatRequestData({ useTools: nextTools.length > 0 }, messages, nextTools), max_tokens: 1_000 }, videoSearch ? 'text_video_model' : 'text_tool_result_model')
      if (!output) return
      if (!nextTools.length) break
    }
    let toolReply: string | undefined
    let actionAttempted = false
    if (output.tool_calls?.length) {
      if (usedHistory || usedScoped || usedRegistry) return
      if (!tools.length) return
      const call = output.tool_calls.length === 1 ? output.tool_calls[0] : undefined
      if (!call) {
        toolReply = '一次只处理一项提醒或记忆，请先告诉我想处理哪一项。'
      } else {
        const raw = call.function?.arguments
        if (typeof raw !== 'string' || raw.length > 4096 || ports.allowsToolInput?.(raw) === false) {
          log('tool', 'group_text_tool', 'failed', 'invalid_tool_arguments')
          await reportFailure('tool', 'failed'); return
        }
        let actionClaimed = false
        let outcome
        const staticCurrent = () => isCurrent() && allowedToolNames().some(name => name === call.function?.name)
        try { outcome = await ports.groupTools.execute(call, allowed, {
          ...requestContext, userText: user, isCurrent: staticCurrent,
          ensureCurrent: async () => { if (!await memoryAndGroupCurrent() || !await scopedEvidenceCurrent()) throw new Error('文字工具来源已失效') },
          allowsText: ports.allowsText,
          ...(ports.allowsToolInput ? { allowsToolInput: ports.allowsToolInput } : {}),
          claimAction: async () => {
            if (!await memoryCurrent() || !staticCurrent()) return false
            actionClaimed = await ports.inbox.claimTextAction(target, messageId, recallVersion)
            return actionClaimed && await memoryCurrent() && staticCurrent()
          },
        }) } catch (error) {
          log('tool', 'group_text_tool', actionClaimed ? 'unknown' : 'failed', 'tool_execution_failed', error)
          await reportFailure('tool', actionClaimed ? 'unknown' : 'failed', undefined, actionClaimed); return
        }
        if (!outcome) return
        if (outcome.deliveryUnknown) { log('tool', 'group_text_tool', 'unknown', 'delivery_unconfirmed'); return }
        if (outcome.failure) { await reportFailure('tool', outcome.failure, outcome.text, outcome.attempted); return }
        toolReply = outcome.text
        actionAttempted = outcome.attempted
      }
    }
    if (!isCurrent() || (toolReply === undefined && (typeof output?.content !== 'string' || output.tool_calls?.length))) return
    const sanitized = sanitizeFinalReplyText(toolReply ?? output?.content, { aiFlavorPhrases })
    if (!sanitized) return
    const interactionContext = buildTurnInteractionContext({ rawUserText: user, addressee: {targetKind: 'bot'} })
    const candidate = toolReply !== undefined ? sanitized : enforcePersonaToneBoundary(sanitized, { interactionContext })
    const grounded = toolReply !== undefined ? candidate : (await groundFinalReply({ candidate, context: interactionContext })).text
    const text = safeTruncateUnicode(sanitizeFinalReplyText(grounded, { aiFlavorPhrases }), maxMessageLength)
    if (!text) return

    const replyContextCurrent = async () => await memoryAndGroupCurrent() && (!usedScoped || await scopedEvidenceCurrent()) && (!usedRegistry || await registryEvidenceCurrent())
    if (!await replyContextCurrent()) return
    // Keep notifications derived from revocable evidence out of the replayable action receipt.
    if (actionAttempted && !resultHasRevocableContext && !await ports.inbox.finishTextAction(target, messageId, recallVersion, text)) return
    const receipt = await deliver(text, registryActionClaimed || actionAttempted && resultHasRevocableContext ? '' : actionAttempted ? text : undefined, replyContextCurrent)
    if (receipt?.state !== 'sent' || !await memoryCurrent()) return
    if (usedRegistry || webEvidence) return
    if (toolReply === undefined && !mergedSources.length && !groupMemory && !semantic?.text && !topic && !usedHistory && !usedScoped && !incoming.quote) try {
      await ports.recordCognitionReply?.(incoming, binding, text, receipt.messageId, { isCurrent, ...(signal ? { signal } : {}),
        ensureCurrent: async () => { if (!await memoryAndGroupCurrent()) throw new Error('认知表达来源已改变') },
      }, cognition?.nodes.map(node => node.id) ?? [])
    } catch (error) { log('runtime', 'text_cognition_reply', 'failed', 'post_send_record_failed', error) }
    if (toolReply === undefined && !mergedSources.length) {
      if (!semantic?.text && !usedHistory && !usedScoped) try { await ports.recordGroupReply?.(incoming, binding, isCurrent) } catch (error) { log('runtime', 'text_record_group_reply', 'failed', 'post_send_record_failed', error) }
      if (!await memoryCurrent()) return
      if (!groupMemory && !semantic?.text && !resultHasRevocableContext && !usedHistory && !usedScoped) try { await ports.recordEpisode?.(incoming, snapshot, text, receipt.messageId, isCurrent) } catch (error) { log('runtime', 'text_record_episode', 'failed', 'post_send_record_failed', error) }
      if (!await memoryCurrent()) return
    }
    // Persist confirmation before admission. If admission loses its acknowledgement,
    // replay can recover the original inbox source without sending the reply again.
    let learnConfirmed = false
    try {
      if (!await memoryCurrent()) return
      if (toolReply === undefined && !usedScoped && await ports.inbox.confirmTextReply(target, messageId, recallVersion) && await memoryCurrent() && !mergedSources.length) {
        learnConfirmed = true
      }
    } catch (error) { log('runtime', 'text_confirm_reply', 'failed', 'post_send_record_failed', error) }
    if (!await memoryCurrent()) return
    try { await ports.inbox.saveTextHistory(target, recallVersion, {
      bindingToken,
      personaVersion: snapshot.personaVersion,
      personMemoryInvalidatedAt: invalidatedAt,
      ...(historyPeerId === undefined ? {} : { privatePeerId: historyPeerId }),
      turns: mergedSources.length || groupMemory || semantic?.text || topic || cognition?.text || usedHistory || usedScoped ? [] : [...turns, { user: toolReply === undefined ? user : '', reply: toolReply ===undefined ? text : '',
        ...(toolReply === undefined ? { messageId } : {}),
        ...(!isPrivateChat ? {speakerId: incoming.sender.id, replyId: receipt.messageId} : {}) }].slice(-maxHistoryTurns),
    }) } catch (error) { log('runtime', 'text_save_history', 'failed', 'post_send_record_failed', error) }
    // Preserve sent history before admission failure retains the inbox source.
    // Privacy and source revocations return normally instead of requesting a retry.
    if (learnConfirmed && await memoryCurrent()) await ports.learnConfirmed?.(incoming, binding, isCurrent)
  }

  async function ownedReply(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean,
    signal?: AbortSignal, trigger?: TextConversationTrigger): Promise<TextConversationReceipt> {
      const { conversation: target, sender } = incoming
      const key = conversationAddressKey(target)
      const controller = new AbortController(), turnSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
      const turn = { current: true }
      let turns = active.get(key)
      if (!turns) { turns = new Set(); active.set(key, turns) }
      turns.add(turn)
      let receipt: TextConversationReceipt = { state: 'cancelled' }
      try {
        await runReply(incoming, selected, () => turn.current && !signal?.aborted && isCurrent() &&
          (target.kind !== 'private' || (samePlatformNamespace(target.account, sender) && ports.isPrivatePeer(target, sender))), turnSignal, trigger, value => { receipt = value })
      }
      finally { controller.abort(); turns.delete(turn); if (!turns.size) active.delete(key) }
      return receipt
  }

  return {
    async reply(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean, signal?: AbortSignal): Promise<void> {
      await ownedReply(incoming, selected, isCurrent, signal)
    },
    replyWithTrigger(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean,
      signal: AbortSignal, trigger: TextConversationTrigger): Promise<TextConversationReceipt> {
      return ownedReply(incoming, selected, isCurrent, signal, trigger)
    },
    invalidate(target: ConversationAddress): void {
      for (const turn of active.get(conversationAddressKey(target)) ?? []) turn.current = false
    },
  }
}
