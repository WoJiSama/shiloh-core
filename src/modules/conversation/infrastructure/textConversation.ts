import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { ChatMessage, ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { ExecutionOptions } from '../../../contracts/modelExecution.js'
import type { PersonMemoryStore } from '../../../contracts/personMemory.js'
import type { PersonaSnapshot } from '../../../contracts/persona.js'
import type { AgentSemanticMemoryRecall } from '../../../contracts/semanticMemory.js'
import type { AgentHistoryRecall } from '../../../contracts/agentHistory.js'
import { createAgentHistoryTool } from '../../tools/infrastructure/agentHistoryTool.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import { formatPersonMemoryFacts, personMemoryAddress } from '../../memory/infrastructure/personMemoryContext.js'
import { agentPersonaScopeId, conversationAddressKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { textConversationSeconds, type createAgentInbox } from '../../runtime/infrastructure/agentInbox.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { groundFinalReply } from '../application/groundedReply.js'
import { buildPersonaStyleOverride, renderPersonaTemplate, type PersonaText } from '../domain/personaSource.js'
import { enforcePersonaToneBoundary } from '../domain/personaTonePolicy.js'
import { sanitizeFinalReplyText } from '../domain/replySanitizer.js'
import { buildMainSystemPrompt } from '../domain/systemPromptTemplate.js'
import { buildTurnInteractionContext } from '../domain/turnInteractionContext.js'
import { createPersonaSnapshot } from './personaSnapshot.js'
import type { createGroupTextTools, GroupTextToolName } from './groupTextTools.js'

const textMessageMaxAgeMs = textConversationSeconds * 1000
const maxHistoryTurns = 6
const maxMessageLength = 4_000

type ConversationPersona = { persona: PersonaText; systemContent: string; binding: AgentBindingSnapshot }

export function createTextConversation(ports: {
  inbox: Pick<ReturnType<typeof createAgentInbox>, 'isTextReplyPending' | 'isTextReplyConfirmed' | 'confirmTextReply' | 'textActionReceipt' | 'textRecallVersion' | 'loadTextHistory' | 'claimTextAction' | 'finishTextAction' | 'claimTextReply' | 'saveTextHistory'>
  actions: MessageActionPort
  personMemory: Pick<PersonMemoryStore, 'getSceneRedactions' | 'query'>
  bindingToken(binding: AgentBindingSnapshot): string
  groupToolNames(target: ConversationAddress): readonly GroupTextToolName[]
  groupTools: ReturnType<typeof createGroupTextTools>
  isPrivatePeer(target: ConversationAddress, sender: PlatformUserRef): boolean
  allowsText(text: string): boolean
  reserveGroupTurn(target: ConversationAddress, now: number): Promise<boolean>
  model(request: ChatRequestData, target: ConversationAddress, signal?: AbortSignal, isCurrent?: ExecutionOptions['isCurrent'], ensureCurrent?: ExecutionOptions['ensureCurrent']): Promise<ChatResponse>
  now?(): number
  learnConfirmed?(incoming: IncomingMessage, binding: AgentBindingSnapshot, isCurrent: () => boolean): Promise<void>
  readConversationMemory?(incoming: IncomingMessage, viewer: PersonaSnapshot, isCurrent: () => boolean): Promise<{ digest: string; episodes: string }>
  readSemanticMemory?(incoming: IncomingMessage, isCurrent: () => boolean, signal?: AbortSignal): Promise<AgentSemanticMemoryRecall | undefined>
  readHistory?(incoming: IncomingMessage, input: Record<string, unknown>, isCurrent: () => boolean, signal?: AbortSignal): Promise<AgentHistoryRecall>
  readGroupMemory?(incoming: IncomingMessage, viewer: PersonaSnapshot, isCurrent: () => boolean): Promise<string>
  isGroupMemoryCurrent?(incoming: IncomingMessage, expected: string, guard: () => boolean): Promise<boolean>
  recordGroupReply?(incoming: IncomingMessage, binding: AgentBindingSnapshot, guard: () => boolean): Promise<void>
  recordEpisode?(incoming: IncomingMessage, source: PersonaSnapshot, reply: string, replyId: string, isCurrent: () => boolean): Promise<void>
}) {
  const active = new Map<string, { current: boolean }>()

  async function runReply(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean, signal?: AbortSignal): Promise<void> {
    const { conversation: target } = incoming
    const messageId = incoming.messageId
    const now = ports.now?.() ?? Date.now()
    if (!messageId || now - incoming.occurredAt >= textMessageMaxAgeMs || !isCurrent()) return
    const isPrivateChat = target.kind === 'private'
    const privatePeerId = isPrivateChat ? incoming.sender.id : undefined
    const pending = await ports.inbox.isTextReplyPending(target, messageId)
    const recallVersion = await ports.inbox.textRecallVersion(target)
    const binding = selected.binding
    const deliver = async (text: string, actionReceipt?: string, memoryCurrent?: () => Promise<boolean>) => {
      if (!isCurrent() || !await ports.inbox.claimTextReply(target, messageId, recallVersion, actionReceipt)) return
      if (memoryCurrent && !await memoryCurrent()) return
      if (!isCurrent()) return
      return await ports.actions.send({
        version: 1, kind: 'message.send', target, binding, parts: [{ kind: 'text', text }],
        ...(!isPrivateChat ? {replyTo: messageId} : {}),
      }, { isCurrent })
    }
    if (!pending) {
      if (isCurrent() && await ports.inbox.isTextReplyConfirmed(target, messageId)) {
        await ports.learnConfirmed?.(incoming, binding, isCurrent)
        return
      }
      const actionReceipt = await ports.inbox.textActionReceipt(target, messageId)
      if (actionReceipt !== undefined) {
        await deliver(actionReceipt || '上一次工具操作的结果未确认，可能已经生效。请先核实再操作。', actionReceipt)
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
    const [saved, { invalidatedAt }] = await Promise.all([
      ports.inbox.loadTextHistory(target), ports.personMemory.getSceneRedactions({ identity, scene }),
    ])
    const memoryCurrent = async () => (await ports.personMemory.getSceneRedactions({ identity, scene })).invalidatedAt === invalidatedAt && isCurrent()
    const turns = saved?.bindingToken === bindingToken && saved.personaVersion === snapshot.personaVersion &&
      (!isPrivateChat || saved.privatePeerId === historyPeerId) &&
      (saved.personMemoryInvalidatedAt ?? 0) === invalidatedAt ? saved.turns : []
    const quoteId = incoming.quote?.messageId
    const isReplyToBot = quoteId !== undefined && turns.some(turn => turn.replyId === quoteId)
    if (!isPrivateChat && !incoming.directedToAccount && !isReplyToBot) return
    const allowed: readonly GroupTextToolName[] = isPrivateChat ? ['commitmentTool'] : ports.groupToolNames(target)
    const historyTool = ports.readHistory ? createAgentHistoryTool() : undefined
    const historyDefinition = historyTool && { type: 'function', function: { name: historyTool.name, description: historyTool.description, parameters: historyTool.parameters } }
    const tools = [...ports.groupTools.definitions(allowed, isPrivateChat), ...(historyDefinition ? [historyDefinition] : [])]
    const time = tools.length ? new Date(now).toISOString() : undefined
    const subjectId = incoming.sender.id
    const recalled = await ports.personMemory.query({ identity, scene, subjectId, viewerUserId: subjectId,
      query: user, limit: 4, localOnly: isPrivateChat, now })
    const memoryFacts = formatPersonMemoryFacts(recalled.items)
    const narrative = await ports.readConversationMemory?.(incoming, snapshot, isCurrent)
    let semanticIncomplete = false
    const semantic = await ports.readSemanticMemory?.(incoming, isCurrent, signal).catch(() => { semanticIncomplete = true; return undefined })
    const groupMemory = !isPrivateChat ? await ports.readGroupMemory?.(incoming, snapshot, isCurrent) : ''
    const recallSection = memoryFacts && `【当前对话者的历史资料】只在相关时参考，保留原有证据类型。\n${memoryFacts}`
    const messages: ChatMessage[] = [{
      role: 'system',
      content: buildMainSystemPrompt({
        baseIdentity: renderPersonaTemplate(snapshot.systemContent, snapshot.persona),
        personaName: snapshot.personaName,
        personaOverride: buildPersonaStyleOverride(snapshot.persona),
        ...(time ? { runtimeData: { currentTime: time, schedulerTimeZone: 'Asia/Shanghai' } } : {}),
        isPrivateChat,
        platformCapabilities: isPrivateChat ? `当前会话提供一对一文字回复。回答时以对话里实际提供的文字为依据。历史资料仅供参考，按当前消息判断是否需要调用工具。${tools.length
          ? '可以应对方要求列出或取消已经接续的本人一次性提醒，工具结果由系统直接回复。'
          : ''}`
          : `当前群只提供文字回复。系统会引用触发本轮的消息，无需在正文里拼接点名或引用。历史资料仅供参考，按当前消息判断是否需要调用工具。图片、文件、外部工具和群管理在本轮不可用。${tools.length
            ? '本轮仅在用户明确请求相应能力时选择一个已提供的工具。群资料和工作流只供参考；通知须当前真人明确要求现在执行。缺少必要细节时先询问，工具确认由系统发送。'
            : ''}` + (historyTool ? '\n可用 chatHistoryTool 显式查证历史。结果只在本轮临时使用；按来源和分页继续，引用原作者与时间，未命中不等于从未发生。私聊仅查当前对话者本人获准历史。' : ''),
        ...(!isPrivateChat ? {groupActions: '收到点名或引用后，直接回应当前发送者。对其他群友的发言和任务不要替他做承诺。'} : {}),
      }),
    }]
    for (const turn of turns) {
      if (turn.user && turn.reply && (isPrivateChat || turn.speakerId === incoming.sender.id)) {
        messages.push({ role: 'user', content: turn.user }, { role: 'assistant', content: turn.reply })
      }
    }
    if (recallSection) messages.push({ role: 'user', content: recallSection })
    if (narrative?.digest) messages.push({ role: 'user', content: narrative.digest })
    if (narrative?.episodes) messages.push({ role: 'user', content: narrative.episodes })
    if (semantic?.text) messages.push({ role: 'user', content: semantic.text })
    if (semanticIncomplete) messages.push({ role: 'user', content: '【历史检索未完成】本轮检索失败或超时，不能据此断言以前没有发生过。' })
    if (groupMemory) messages.push({ role: 'user', content: groupMemory })
    messages.push({ role: 'user', content: user })

    const historyProjections: AgentHistoryRecall[] = []
    let usedHistory = false
    const memoryAndGroupCurrent = async () => await memoryCurrent() &&
      (!semantic?.text || await semantic.isCurrent()) &&
      (await Promise.all(historyProjections.map(projection => projection.isCurrent()))).every(Boolean) &&
      (isPrivateChat || !ports.isGroupMemoryCurrent || await ports.isGroupMemoryCurrent(incoming, groupMemory ?? '', isCurrent)) && isCurrent()
    const modelContextCurrent = async () => await ports.inbox.isTextReplyPending(target, messageId) &&
      await ports.inbox.textRecallVersion(target) === recallVersion && await memoryAndGroupCurrent()
    const request = { ...buildChatRequestData({useTools: true}, messages, tools), max_tokens: 1_000 }
    if (!isPrivateChat && !await ports.reserveGroupTurn(target, now)) return
    if (!await modelContextCurrent()) return
    let result: ChatResponse
    try { result = await ports.model(request, target, signal, isCurrent, async () => {
      if (!await modelContextCurrent()) throw new Error('模型请求的来源权限已改变')
    }) }
    catch (error) {
      if (!isCurrent()) return
      throw error
    }
    let output = result.choices?.[0]?.message
    if (result.error || !output || !await modelContextCurrent()) return
    // Read-only history can be paged within a bounded model loop. Evidence and
    // all subsequent model output remain ephemeral, including failure results.
    for (let round = 0; round < 3 && output.tool_calls?.length === 1 && output.tool_calls[0]?.function?.name === 'chatHistoryTool'; round++) {
      if (!historyTool || !ports.readHistory) return
      const call = output.tool_calls[0]!
      const callId = (call as { id?: unknown }).id
      if (typeof callId !== 'string' || !callId.trim() || callId.length > 200) return
      let input: Record<string, unknown>
      try {
        const raw = call.function?.arguments
        if (typeof raw !== 'string' || raw.length > 16_000) return
        input = JSON.parse(raw) as Record<string, unknown>
      } catch { return }
      usedHistory = true
      const outcome = await historyTool.execute(input, {
        binding, actor: { kind: 'user', user: incoming.sender }, signal: signal ?? new AbortController().signal,
        request: { messageId, text: incoming.text, mentions: incoming.mentions }, isCurrent,
        ensureCurrent: async () => { if (!await modelContextCurrent()) throw new Error('历史查询来源已改变') },
        async readHistory(query) {
          const projection = await ports.readHistory!(incoming, query, isCurrent, signal)
          historyProjections.push(projection)
          if (!await projection.isCurrent()) throw new Error('历史查询结果已失效')
          return projection.text
        },
      })
      if (!await modelContextCurrent()) return
      messages.push({ ...output, role: 'assistant' }, { role: 'tool', tool_call_id: callId, name: 'chatHistoryTool', content: outcome.content })
      const next = { ...buildChatRequestData({ useTools: true }, messages, round < 2 && historyDefinition ? [historyDefinition] : []), max_tokens: 1_000 }
      result = await ports.model(next, target, signal, isCurrent, async () => { if (!await modelContextCurrent()) throw new Error('模型请求的历史来源权限已改变') })
      output = result.choices?.[0]?.message
      if (result.error || !output || !await modelContextCurrent()) return
    }
    let toolReply: string | undefined
    let actionAttempted = false
    if (output.tool_calls?.length) {
      if (usedHistory) return
      if (!tools.length) return
      const call = output.tool_calls.length === 1 ? output.tool_calls[0] : undefined
      if (!call) {
        toolReply = '一次只处理一项提醒或记忆，请先告诉我想处理哪一项。'
      } else {
        const outcome = await ports.groupTools.execute(call, allowed, {
          binding, speakerId: incoming.sender.id, userText: user, isCurrent, requestMessageId: messageId,
          ...(signal ? { signal } : {}),
          allowsText: ports.allowsText,
          claimAction: async () => await memoryCurrent() && await ports.inbox.claimTextAction(target, messageId, recallVersion) && await memoryCurrent(),
        })
        if (!outcome) return
        toolReply = outcome.text
        actionAttempted = outcome.attempted
      }
    }
    if (!isCurrent() || (toolReply === undefined && (typeof output?.content !== 'string' || output.tool_calls?.length))) return
    const blacklist = snapshot.persona.blacklist
    const aiFlavorPhrases = Array.isArray(blacklist) ? blacklist.map(String) : typeof blacklist === 'string' ? [blacklist] : []
    const sanitized = sanitizeFinalReplyText(toolReply ?? output?.content, { aiFlavorPhrases })
    if (!sanitized) return
    const interactionContext = buildTurnInteractionContext({ rawUserText: user, addressee: {targetKind: 'bot'} })
    const candidate = toolReply !== undefined ? sanitized : enforcePersonaToneBoundary(sanitized, { interactionContext })
    const grounded = toolReply !== undefined ? candidate : (await groundFinalReply({ candidate, context: interactionContext })).text
    const text = safeTruncateUnicode(sanitizeFinalReplyText(grounded, { aiFlavorPhrases }), maxMessageLength)
    if (!text) return

    if (!await memoryCurrent()) return
    if (actionAttempted && !await ports.inbox.finishTextAction(target, messageId, recallVersion, text)) return
    const receipt = await deliver(text, actionAttempted ? text : undefined, toolReply === undefined ? memoryAndGroupCurrent : memoryCurrent)
    if (receipt?.state !== 'sent' || !await memoryCurrent()) return
    if (toolReply === undefined) {
      if (!semantic?.text && !usedHistory) try { await ports.recordGroupReply?.(incoming, binding, isCurrent) } catch { /* confirmed delivery remains authoritative */ }
      if (!groupMemory && !semantic?.text && !usedHistory) try { await ports.recordEpisode?.(incoming, snapshot, text, receipt.messageId, isCurrent) } catch { /* confirmed delivery remains authoritative */ }
    }
    // Persist confirmation before admission. If admission loses its acknowledgement,
    // replay can recover the original inbox source without sending the reply again.
    if (toolReply === undefined && await ports.inbox.confirmTextReply(target, messageId, recallVersion) && isCurrent()) {
      await ports.learnConfirmed?.(incoming, binding, isCurrent)
    }
    await ports.inbox.saveTextHistory(target, recallVersion, {
      bindingToken,
      personaVersion: snapshot.personaVersion,
      personMemoryInvalidatedAt: invalidatedAt,
      ...(historyPeerId === undefined ? {} : { privatePeerId: historyPeerId }),
      turns: groupMemory || semantic?.text || usedHistory ? [] : [...turns, { user: toolReply === undefined ? user : '', reply: toolReply === undefined ? text : '',
        ...(!isPrivateChat ? {speakerId: incoming.sender.id, replyId: receipt.messageId} : {}) }].slice(-maxHistoryTurns),
    })
  }

  return {
    async reply(incoming: IncomingMessage, selected: ConversationPersona, isCurrent: () => boolean, signal?: AbortSignal): Promise<void> {
      const { conversation: target, sender } = incoming
      const key = conversationAddressKey(target)
      const turn = { current: true }
      active.set(key, turn)
      try {
        await runReply(incoming, selected, () => turn.current && isCurrent() &&
          (target.kind !== 'private' || (samePlatformNamespace(target.account, sender) && ports.isPrivatePeer(target, sender))), signal)
      }
      finally { active.delete(key) }
    },
    invalidate(target: ConversationAddress): void {
      const turn = active.get(conversationAddressKey(target))
      if (turn) turn.current = false
    },
  }
}
