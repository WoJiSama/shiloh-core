import type { AgentTool, AgentToolResult } from '../../../contracts/agentTool.js'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { CommitmentSourceMessage } from '../../../contracts/commitments.js'
import { validateAgentToolInput } from './agentToolSchema.js'

export interface CoreCapabilityOrigin {
  readonly key: string
  readonly revision: string
  readonly message?: CommitmentSourceMessage
}

export interface CoreCapabilityContext {
  readonly agentId: string
  readonly origin?: CoreCapabilityOrigin
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent?(): Promise<void>
  protect?(check: () => Promise<boolean>): void
  allowsMutation?(): boolean
}

export interface CoreCapability extends Pick<AgentTool, 'name' | 'description' | 'parameters'> {
  readonly mutates?: boolean
  available(context: CoreCapabilityContext): boolean
  execute(input: Record<string, unknown>, context: CoreCapabilityContext): Promise<AgentToolResult>
}

export type CoreCapabilityToolFactory = (binding: AgentBindingSnapshot, source: CommitmentSourceMessage | undefined,
  current: () => boolean, protect: (check: () => Promise<boolean>) => void, allowsMutation?: () => boolean) => AgentTool | undefined

export const coreCapabilityToolName = 'coreCapabilities'

export function createAgentCoreCapabilities(allowsInput: (text: string) => boolean) {
  const registry = new Map<string, CoreCapability>()
  const available = (context: CoreCapabilityContext) =>
    context.isCurrent() && !context.signal.aborted ? [...registry.values()].filter(capability =>
      (!capability.mutates || context.allowsMutation?.() !== false) && capability.available(context)) : []
  const describe = ({ name, description, parameters }: CoreCapability) => ({ name, description, parameters })
  const signal = new AbortController().signal
  const failed = (content: string): AgentToolResult => ({ status: 'failed', content })

  async function call(name: unknown, input: unknown, context: CoreCapabilityContext): Promise<AgentToolResult> {
    await context.ensureCurrent?.()
    const capability = available(context).find(item => item.name === name)
    if (!capability) return failed('当前任务或会话未获此能力授权')
    if (!validateAgentToolInput(capability, input) || !allowsInput(JSON.stringify(input))) return failed('能力参数无效')
    return capability.execute(input, context)
  }

  return {
    register(capabilities: readonly CoreCapability[]) {
      for (const capability of capabilities) {
        if (registry.has(capability.name)) throw new Error('Core 能力重复登记：' + capability.name)
        registry.set(capability.name, capability)
      }
    },
    list: (context: CoreCapabilityContext) => available(context).map(describe),
    call,
    tool(context: Omit<CoreCapabilityContext, 'signal'>): AgentTool | undefined {
      const offered = available({ ...context, signal })
      if (!offered.length) return undefined
      const gateway: AgentTool = {
        name: coreCapabilityToolName,
        description: '查询或调用 Core 的本人能力。先用 action=list 查看参数，再用 action=call 和 name/input 调用。根据真实回执说明任务进度。可用能力：' +
          offered.map(item => item.name + '（' + item.description + '）').join('、'),
        effect: 'read',
        parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
          action: { type: 'string', enum: ['list', 'call'] },
          name: { type: 'string', maxLength: 80 },
          input: { type: 'object', additionalProperties: true },
        } },
        async execute(input, turn) {
          if (!validateAgentToolInput(gateway, input)) return failed('能力入口参数无效')
          const view: CoreCapabilityContext = {
            ...context, signal: turn.signal,
            isCurrent: () => context.isCurrent() && turn.isCurrent(),
            async ensureCurrent() {
              await turn.ensureCurrent?.()
              await context.ensureCurrent?.()
            },
          }
          if (input.action === 'list' && input.name === undefined && input.input === undefined) {
            await view.ensureCurrent?.()
            return { status: 'succeeded', content: JSON.stringify(available(view).map(describe)) }
          }
          if (input.action === 'call' && typeof input.name === 'string') return call(input.name, input.input ?? {}, view)
          return failed('请用 list 查看能力，或用 call 提供能力名称及参数')
        },
      }
      return gateway
    },
  }
}

export type AgentCoreCapabilities = ReturnType<typeof createAgentCoreCapabilities>
