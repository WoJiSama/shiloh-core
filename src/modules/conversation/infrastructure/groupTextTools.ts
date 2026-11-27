import type { AgentTool, AgentToolContext } from '../../../contracts/agentTool.js'
import type { ChatResponseMessage, ChatTool } from '../../../contracts/modelGateway.js'
import type { createCommitmentRuntime } from '../../commitments/infrastructure/commitmentTool.js'
import type { createDelegateMemoryRuntime } from '../../memory/infrastructure/delegateMemoryTool.js'
import type { ToolParameters } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { createGroupKnowledgeTool } from '../../memory/infrastructure/groupKnowledgeTool.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { classifyToolResult, isUnknownToolResult } from '../../tools/domain/toolResultGrounding.js'
import { authorizeAgentToolContext } from '../../tools/infrastructure/agentToolAuthorization.js'
import { parseAgentToolArguments, validateAgentToolInput } from '../../tools/infrastructure/agentToolSchema.js'

export const groupTextVideoToolNames = ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'] as const
export const groupTextInteractionToolNames = ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool'] as const
export const groupTextQqActionToolNames = ['sendGiftTool', 'grabRedBagTool', 'qqZoneTool'] as const
export const groupTextScopedToolNames = [...groupTextVideoToolNames, 'searchMagnetTool', ...groupTextInteractionToolNames, ...groupTextQqActionToolNames] as const
export const groupTextToolNames = ['commitmentTool', 'delegateMemoryTool', 'groupKnowledgeTool', ...groupTextScopedToolNames] as const
export const textRegistryToolNames = ['searchInformationTool', 'webParserTool', 'emojiSearchTool', 'bingImageSearchTool', 'sendLocalEmojiTool',
  'bananaTool', 'googleImageEditTool', 'textImageTool', 'aiMindMapTool', 'excelWorkbookTool', 'fileTextTool', 'searchMusicTool', 'voiceTool',
  'githubRepoTool', 'modrinthTool', 'deltaForceTool', 'pixivSearchTool', 'pixivDownloadTool', 'videoAnalysisTool'] as const
export function isTextRegistryToolName(value: unknown): value is string {
  return typeof value === 'string' && (textRegistryToolNames.some(name => name === value) || /^mcp_[A-Za-z0-9_-]{1,60}$/u.test(value))
}
export type GroupTextToolName = string

export interface GroupTextToolContext extends Pick<AgentToolContext, 'binding' | 'actor' | 'request' | 'isCurrent' | 'ensureCurrent'> {
  userText: string
  requestMessageId?: string
  requestAt?: number
  signal?: AbortSignal
  allowsText(text: string): boolean
  allowsToolInput?(text: string): boolean
  claimAction(): Promise<boolean>
}

type GroupTextToolResult = { text: string; attempted: boolean; failure?: 'failed' | 'unknown'; deliveryUnknown?: boolean }

type ModelCall = NonNullable<ChatResponseMessage['tool_calls']>[number] & { type?: unknown }

const unavailable = '本轮没有可用的调用结果。'
const uncertain = '这次工具操作的结果未确认，可能已经生效。请先核实再操作。'

function propertiesFor(name: GroupTextToolName, parameters: ToolParameters): AgentTool['parameters'] {
  const properties = { ...parameters.properties }
  if (name === 'commitmentTool') {
    delete properties.deliver
    delete properties.intent
  } else if (name === 'delegateMemoryTool') {
    delete properties.due_time
    properties.content = {type: 'string', description: '用户本条消息中要记住的原文，最多 300 字'}
  }
  return { ...parameters, type: 'object', properties, additionalProperties: false }
}

export function createGroupTextTools(options: {
  commitment: InstanceType<ReturnType<typeof createCommitmentRuntime>['CommitmentTool']>
  memory: InstanceType<ReturnType<typeof createDelegateMemoryRuntime>['DelegateMemoryTool']>
  knowledge?: ReturnType<typeof createGroupKnowledgeTool>
  diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  privateScheduling?: boolean
}) {
  const instances: Partial<Record<GroupTextToolName, AbstractTool>> = { commitmentTool: options.commitment, delegateMemoryTool: options.memory,
    ...(options.knowledge ? { groupKnowledgeTool: options.knowledge } : {}) }
  const tools = new Map<string, { instance: AbstractTool; parameters: AgentTool['parameters']; definition: ChatTool }>(groupTextToolNames.flatMap(name => {
    const instance = instances[name]
    if (!instance) return []
    const parameters = propertiesFor(name, instance.parameters)
    const definition: ChatTool = {
      type: 'function', function: {
        name, parameters,
        description: name === 'commitmentTool'
          ? '创建、查看、取消或续期自己的固定文字提醒。仅响应明确请求。提醒时间不明确就追问，并使用北京时间换算。'
          : name === 'delegateMemoryTool' ? '仅在用户明确要求时保存原话、查询本人记录或删除本人记录。写入的内容须来自本条原文，查询无命中时如实说明。'
            : instance.description,
      },
    }
    return [[name, {instance, parameters, definition}] as const]
  }))
  const privateSchema: Pick<AgentTool, 'parameters'> = { parameters: {
    type: 'object', properties: {
      action: { type: 'string', enum: options.privateScheduling ? ['create', 'list', 'cancel'] : ['list', 'cancel'], description: 'create 登记，list 查看，cancel 取消' },
      commitment_id: { type: 'string', description: '取消时填 list 返回的提醒编号' },
      ...(options.privateScheduling ? {
        schedule_kind: { type: 'string', enum: ['once'] },
        schedule_time: { type: 'string', description: '一次性发送时间，ISO 8601 带北京时间 +08:00' },
        target_group_id: { type: 'string', description: '两人同在的已绑定 QQ 群的群号，缺省时发回本私聊' },
        static_message: { type: 'string', description: '此次请求明确指定要发送的原文，最多 300 字' },
      } : {}),
    }, required: ['action'], additionalProperties: false,
  } }
  const privateDefinition: ChatTool = { type: 'function', function: {
    name: 'commitmentTool', description: options.privateScheduling
      ? '接受明确的定时文字托付时，可登记、查看或取消本人任务。可在本私聊提醒，也可将指定的原文发到共同所在的已绑定群。群号、时间或原文有歧义就先问清。登记成功后再承诺。'
      : '查看或取消已接续到此私聊的本人一次性提醒。',
    parameters: privateSchema.parameters,
  } }

  async function execute(call: ModelCall, allowed: readonly GroupTextToolName[], context: GroupTextToolContext): Promise<GroupTextToolResult | undefined> {
    const name = allowed.find(tool => tool === call.function?.name)
    const tool = name && tools.get(name)
    let immediateDelivery = false
    let guardRejected = false
    const ensureContextCurrent = async () => {
      try {
        if (!context.isCurrent() || context.signal?.aborted) throw new Error('群文字工具来源已失效')
        await context.ensureCurrent?.()
        if (!context.isCurrent() || context.signal?.aborted) throw new Error('群文字工具来源已失效')
      } catch (error) {
        guardRejected = true
        throw error
      }
    }
    const log = (outcome: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string, error?: unknown) => {
      try { options.diagnostics?.emit({ stage: 'tool', operation: name ?? 'group_text_tool', outcome, code, ...(error === undefined ? {} : { error }) }) }
      catch { /* Optional observers cannot affect tool execution or its receipt. */ }
    }
    const reply = (text: string, attempted = false, failure?: 'failed' | 'unknown'): GroupTextToolResult => {
      if (!context.allowsText(text)) { text = unavailable; failure = attempted ? 'unknown' : 'failed' }
      const state = classifyToolResult(text)
      failure ??= isUnknownToolResult(text) || /^(?:这次工具操作的结果未确认|本次操作未获有效确认|本次通知结果未确认)/u.test(text)
        ? 'unknown' : ['error', 'empty'].includes(state.kind) || text === unavailable || text === '本次通知未发送成功。' ? 'failed' : undefined
      const deliveryUnknown = immediateDelivery && failure === 'unknown'
      log(failure ?? 'succeeded', failure ? 'tool_result_unconfirmed' : 'tool_result_ready')
      return { text, attempted, ...(failure ? { failure } : {}), ...(deliveryUnknown ? { deliveryUnknown: true } : {}) }
    }
    const rejected = (text = unavailable) => reply(text, false, 'failed')
    const privateChat = context.binding.target.kind === 'private'
    if (!name || !tool || (privateChat && name !== 'commitmentTool') || (call.type !== undefined && call.type !== 'function')) {
      return rejected('这项工具在当前会话没有开放。')
    }
    let params = parseAgentToolArguments(call.function?.arguments, 4_096)
    if (!validateAgentToolInput(privateChat ? privateSchema : tool, params) || context.allowsToolInput?.(JSON.stringify(params)) === false) {
      log('failed', 'invalid_tool_arguments')
      return rejected()
    }
    if (!authorizeAgentToolContext({ effect: { actor: 'user', metadata: ['request'] } }, params, context)) return rejected()
    const { request, actor } = context
    if (!request || !actor.user) return rejected()
    const validation = privateChat ? true : tool.instance.validateParameters(params)
    if (validation !== true) return rejected(String(validation))
    const action = params.action
    immediateDelivery = name === 'groupKnowledgeTool' && action === 'notify'
    const begin = async (mutating: boolean) => {
      try { await ensureContextCurrent() } catch { return false }
      if (!context.isCurrent()) return false
      if (mutating) {
        if (!await context.claimAction()) return false
        try { await ensureContextCurrent() } catch { return false }
      }
      return context.isCurrent()
    }
    if (name === 'groupKnowledgeTool') {
      const knowledge = options.knowledge
      if (typeof knowledge?.executeForRequest !== 'function' || !context.signal) return rejected()
      const attempted = action !== 'list'
      if (!await begin(attempted) || !context.isCurrent()) return undefined
      log('started', 'tool_execution_started')
      try {
        const result = await knowledge.executeForRequest(params, {
          binding: context.binding, actor, signal: context.signal, requestMessageId: request.messageId, userText: context.userText,
          isCurrent: context.isCurrent, allowsText: context.allowsText, ensureCurrent: ensureContextCurrent,
        })
        await ensureContextCurrent()
        return reply(result, attempted)
      } catch (error) {
        log(attempted ? 'unknown' : 'failed', 'tool_execution_failed', error)
        if (guardRejected || !context.isCurrent() || context.signal?.aborted) return undefined
        return reply(attempted ? uncertain : unavailable, attempted, attempted ? 'unknown' : 'failed')
      }
    }
    const lookup = action === 'recall' || action === 'list'
    const event = {
      group_id: context.binding.target.id, user_id: actor.user.id, self_id: context.binding.target.account.id,
      _agentBinding: context.binding, _isAgentBindingCurrent: context.isCurrent,
      _ensureAgentToolCurrent: ensureContextCurrent,
      _agentToolRequest: { messageId: request.messageId, occurredAt: request.occurredAt ?? context.requestAt },
    }
    const owner = name === 'delegateMemoryTool' ? options.memory : options.commitment
    const execute = name === 'delegateMemoryTool' ? options.memory.executeForOwner
      : privateChat ? options.commitment.managePrivateReminder : options.commitment.executeWithReceipt
    if (typeof execute !== 'function') return rejected()
    if (lookup) {
      if (!await begin(false) || !context.isCurrent()) return undefined
      log('started', 'tool_execution_started')
      try {
        const result = await execute.call(owner, params, event, request.messageId)
        await ensureContextCurrent()
        if (typeof result !== 'string') return rejected()
        return reply(result)
      } catch (error) { log('failed', 'tool_execution_failed', error); return guardRejected || !context.isCurrent() ? undefined : rejected() }
    }

    if (name === 'commitmentTool' && action === 'create') {
      const text = String(params.static_message || '').trim()
      if (!text || text.length > 300 || !context.allowsText(text)) return rejected('请提供可以在群里发送的提醒文字，最多 300 字。')
      params = {...params, intent: context.userText, static_message: text, deliver: 'static'}
    }
    if (name === 'delegateMemoryTool' && action === 'remember') {
      const content = String(params.content || '').trim()
      if (!content || content.length > 300 || !context.userText.includes(content)) return rejected('请指出你想让我原样记住的那句话。')
      params = {...params, content}
    }
    if (!await begin(true) || !context.isCurrent()) return undefined
    log('started', 'tool_execution_started')
    try {
      if (name === 'commitmentTool') {
        const result = await execute.call(owner, params, event, request.messageId)
        await ensureContextCurrent()
        if (typeof result !== 'string') return reply(result.confirmation, true)
        return reply(result, true, action === 'create' ? 'failed' : undefined)
      }
      const result = await options.memory.executeForOwner(params, event)
      await ensureContextCurrent()
      return reply(result, true)
    } catch (error) { log('unknown', 'tool_execution_failed', error); return guardRejected || !context.isCurrent() ? undefined : reply(uncertain, true, 'unknown') }
  }

  return {
    definitions: (allowed: readonly GroupTextToolName[], privateChat = false) => privateChat
      ? allowed.includes('commitmentTool') ? [privateDefinition] : []
      : allowed.flatMap(name => tools.get(name)?.definition ?? []),
    execute,
  }
}
