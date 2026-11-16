import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { ChatResponseMessage, ChatTool } from '../../../contracts/modelGateway.js'
import type { createCommitmentRuntime } from '../../commitments/infrastructure/commitmentTool.js'
import type { createDelegateMemoryRuntime } from '../../memory/infrastructure/delegateMemoryTool.js'
import type { ToolParameters } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import type { createGroupKnowledgeTool } from '../../memory/infrastructure/groupKnowledgeTool.js'

export const groupTextToolNames = ['commitmentTool', 'delegateMemoryTool', 'groupKnowledgeTool'] as const
export type GroupTextToolName = typeof groupTextToolNames[number]

export interface GroupTextToolContext {
  binding: AgentBindingSnapshot
  speakerId: string
  userText: string
  requestMessageId?: string
  signal?: AbortSignal
  isCurrent(): boolean
  allowsText(text: string): boolean
  claimAction(): Promise<boolean>
}

type GroupTextToolResult = { text: string; attempted: boolean }

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
    const reply = (text: string, attempted = false): GroupTextToolResult => ({text, attempted})
    const name = allowed.find(tool => tool === call.function?.name)
    const tool = name && tools.get(name)
    const privateChat = context.binding.target.kind === 'private'
    if (!name || !tool || (call.type !== undefined && call.type !== 'function')) return reply('这项工具在当前会话没有开放。')
    const args = call.function?.arguments || '{}'
    let params: Record<string, unknown>
    try {
      if (typeof args !== 'string' || args.length > 4_096) return reply(unavailable)
      const parsed: unknown = JSON.parse(args)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply(unavailable)
      params = parsed as Record<string, unknown>
    } catch { return reply(unavailable) }
    if (Object.keys(params).some(key => !Object.hasOwn(tool.parameters.properties, key))) return reply(unavailable)
    if (Object.values(params).some(value => typeof value !== 'string')) return reply(unavailable)
    const validation = tool.instance.validateParameters(params)
    if (validation !== true) return reply(String(validation))
    const action = params.action
    if (typeof action !== 'string' || !tool.parameters.properties.action?.enum?.includes(action)) return reply(unavailable)
    if (privateChat && (name !== 'commitmentTool' || !privateActions.includes(action) || Object.keys(params).some(key => !['action', 'commitment_id'].includes(key)))) {
      return reply(unavailable)
    }
    if (name === 'groupKnowledgeTool') {
      if (!options.knowledge || !context.requestMessageId || !context.signal || !context.isCurrent()) return reply(unavailable)
      const attempted = action !== 'list'
      if (attempted && (!await context.claimAction() || !context.isCurrent())) return undefined
      const result = await options.knowledge.executeForRequest(params, {
        binding: context.binding, actor: { kind: 'user', user: { ...context.binding.target.account, id: context.speakerId } },
        signal: context.signal, requestMessageId: context.requestMessageId, userText: context.userText,
        isCurrent: context.isCurrent, allowsText: context.allowsText,
        ensureCurrent: async () => { if (!context.isCurrent() || context.signal?.aborted) throw new Error('群资料请求已失效') },
      })
      return context.isCurrent() ? reply(context.allowsText(result) ? result : unavailable, attempted) : undefined
    }
    const lookup = action === 'recall' || action === 'list'
    const event = {
      group_id: context.binding.target.id, user_id: context.speakerId, self_id: context.binding.target.account.id,
      _agentBinding: context.binding, _isAgentBindingCurrent: context.isCurrent,
    }
    if (!context.isCurrent()) return undefined

    const runCommitment = () => privateChat ? options.commitment.managePrivateReminder(params, event)
      : options.commitment.executeWithReceipt(params, event)
    if (lookup) {
      try {
        const result = name === 'delegateMemoryTool' ? await options.memory.executeForOwner(params, event) : await runCommitment()
        if (!context.isCurrent()) return undefined
        if (typeof result !== 'string') return reply(unavailable)
        return reply(context.allowsText(result) ? result : unavailable)
      } catch { return reply(unavailable) }
    }

    if (name === 'commitmentTool' && action === 'create') {
      const text = String(params.static_message || '').trim()
      if (!text || text.length > 300 || !context.allowsText(text)) return reply('请提供可以在群里发送的提醒文字，最多 300 字。')
      params = {...params, intent: context.userText, static_message: text, deliver: 'static'}
    }
    if (name === 'delegateMemoryTool' && action === 'remember') {
      const content = String(params.content || '').trim()
      if (!content || content.length > 300 || !context.userText.includes(content)) return reply('请指出你想让我原样记住的那句话。')
      params = {...params, content}
    }
    if (!context.isCurrent() || !await context.claimAction() || !context.isCurrent()) return undefined
    try {
      if (name === 'commitmentTool') {
        const result = await runCommitment()
        if (typeof result !== 'string') return reply(result.confirmation, true)
        return reply(result, true)
      }
      return reply(await options.memory.executeForOwner(params, event), true)
    } catch { return reply(uncertain, true) }
  }

  return {
    definitions: (allowed: readonly GroupTextToolName[], privateChat = false) => privateChat
      ? allowed.includes('commitmentTool') ? [privateDefinition] : []
      : allowed.flatMap(name => tools.get(name)?.definition ?? []),
    execute,
  }
}
