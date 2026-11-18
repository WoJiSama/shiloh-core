import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { ChatResponseMessage, ChatTool } from '../../../contracts/modelGateway.js'
import type { createCommitmentRuntime } from '../../commitments/infrastructure/commitmentTool.js'
import type { createDelegateMemoryRuntime } from '../../memory/infrastructure/delegateMemoryTool.js'
import type { ToolParameters } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { createGroupKnowledgeTool } from '../../memory/infrastructure/groupKnowledgeTool.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { classifyToolResult, isUnknownToolResult } from '../../tools/domain/toolResultGrounding.js'

export const groupTextVideoToolNames = ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'] as const
export const groupTextInteractionToolNames = ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool'] as const
export const groupTextQqActionToolNames = ['sendGiftTool', 'grabRedBagTool', 'qqZoneTool'] as const
export const groupTextScopedToolNames = [...groupTextVideoToolNames, 'searchMagnetTool', ...groupTextInteractionToolNames, ...groupTextQqActionToolNames] as const
export const groupTextToolNames = ['commitmentTool', 'delegateMemoryTool', 'groupKnowledgeTool', ...groupTextScopedToolNames] as const
export type GroupTextToolName = typeof groupTextToolNames[number]

export interface GroupTextToolContext {
  binding: AgentBindingSnapshot
  speakerId: string
  userText: string
  requestMessageId?: string
  signal?: AbortSignal
  isCurrent(): boolean
  /** Rechecks asynchronous source/binding fences after waits before external I/O. */
  ensureCurrent?(): Promise<void>
  allowsText(text: string): boolean
  claimAction(): Promise<boolean>
}

type GroupTextToolResult = { text: string; attempted: boolean; failure?: 'failed' | 'unknown'; deliveryUnknown?: boolean }

type ModelCall = NonNullable<ChatResponseMessage['tool_calls']>[number] & { type?: unknown }

const unavailable = '本轮没有可用的调用结果。'
const uncertain = '这次工具操作的结果未确认，可能已经生效。请先核实再操作。'

function propertiesFor(name: GroupTextToolName, parameters: ToolParameters): ToolParameters {
  const properties = { ...parameters.properties }
  if (name === 'commitmentTool') {
    delete properties.deliver
    delete properties.intent
  } else if (name === 'delegateMemoryTool') {
    delete properties.due_time
    properties.content = {type: 'string', description: '用户本条消息中要记住的原文，最多 300 字'}
  }
  return {...parameters, properties}
}

export function createGroupTextTools(options: {
  commitment: InstanceType<ReturnType<typeof createCommitmentRuntime>['CommitmentTool']>
  memory: InstanceType<ReturnType<typeof createDelegateMemoryRuntime>['DelegateMemoryTool']>
  knowledge?: ReturnType<typeof createGroupKnowledgeTool>
  diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
}) {
  const instances: Partial<Record<GroupTextToolName, AbstractTool>> = { commitmentTool: options.commitment, delegateMemoryTool: options.memory,
    ...(options.knowledge ? { groupKnowledgeTool: options.knowledge } : {}) }
  const tools = new Map(groupTextToolNames.flatMap(name => {
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
  const privateActions = ['list', 'cancel']
  const privateDefinition: ChatTool = { type: 'function', function: {
    name: 'commitmentTool', description: '查看或取消已接续到此私聊的本人一次性提醒。',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: privateActions, description: 'list 查看，cancel 取消' },
        commitment_id: { type: 'string', description: '取消时填 list 返回的提醒编号' },
      }, required: ['action'], additionalProperties: false,
    },
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
    if (!name || !tool || (call.type !== undefined && call.type !== 'function')) return rejected('这项工具在当前会话没有开放。')
    try { await ensureContextCurrent() } catch { return undefined }
    const args = call.function?.arguments || '{}'
    let params: Record<string, unknown>
    try {
      if (typeof args !== 'string' || args.length > 4_096) return rejected()
      const parsed: unknown = JSON.parse(args)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected()
      params = parsed as Record<string, unknown>
    } catch (error) { log('failed', 'invalid_tool_arguments', error); return rejected() }
    if (Object.keys(params).some(key => !Object.hasOwn(tool.parameters.properties, key))) return rejected()
    if (Object.values(params).some(value => typeof value !== 'string')) return rejected()
    const validation = tool.instance.validateParameters(params)
    if (validation !== true) return rejected(String(validation))
    const action = params.action
    if (typeof action !== 'string' || !tool.parameters.properties.action?.enum?.includes(action)) return rejected()
    immediateDelivery = name === 'groupKnowledgeTool' && action === 'notify'
    if (privateChat && (name !== 'commitmentTool' || !privateActions.includes(action) || Object.keys(params).some(key => !['action', 'commitment_id'].includes(key)))) {
      return rejected()
    }
    if (name === 'groupKnowledgeTool') {
      if (!options.knowledge || !context.requestMessageId || !context.signal || !context.isCurrent()) return rejected()
      const attempted = action !== 'list'
      if (attempted && (!await context.claimAction() || !context.isCurrent())) return undefined
      try { await ensureContextCurrent() } catch { return undefined }
      log('started', 'tool_execution_started')
      try {
        const result = await options.knowledge.executeForRequest(params, {
        binding: context.binding, actor: { kind: 'user', user: { ...context.binding.target.account, id: context.speakerId } },
        signal: context.signal, requestMessageId: context.requestMessageId, userText: context.userText,
        isCurrent: context.isCurrent, allowsText: context.allowsText,
        ensureCurrent: ensureContextCurrent,
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
      group_id: context.binding.target.id, user_id: context.speakerId, self_id: context.binding.target.account.id,
      _agentBinding: context.binding, _isAgentBindingCurrent: context.isCurrent,
      _ensureAgentToolCurrent: ensureContextCurrent,
    }
    if (!context.isCurrent()) return undefined

    const runCommitment = () => privateChat ? options.commitment.managePrivateReminder(params, event)
      : options.commitment.executeWithReceipt(params, event)
    if (lookup) {
      log('started', 'tool_execution_started')
      try {
        const result = name === 'delegateMemoryTool' ? await options.memory.executeForOwner(params, event) : await runCommitment()
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
    if (!context.isCurrent() || !await context.claimAction() || !context.isCurrent()) return undefined
    try { await ensureContextCurrent() } catch { return undefined }
    log('started', 'tool_execution_started')
    try {
      if (name === 'commitmentTool') {
        const result = await runCommitment()
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
