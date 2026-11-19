import type { AgentTool, AgentToolContext, AgentToolRegistry } from '../../../contracts/agentTool.js'
import { createAgentTools } from '../../tools/infrastructure/agentTools.js'

type Ports = Parameters<typeof createAgentTools>[1]
type Scope = NonNullable<ReturnType<Ports['context']>>
export const agentTextToolPorts: unique symbol = Symbol('agentTextToolPorts')
export type AgentTextToolPorts = Partial<Scope>
export type AgentTextToolContext = AgentToolContext & { readonly [agentTextToolPorts]?: AgentTextToolPorts }

/** Text turns use the same validation, definition fences and cancellation as simulation tools. */
export function createAgentTextRegistryTools(registry: AgentToolRegistry, ports: Omit<Ports, 'context'>) {
  const scopes = new WeakMap<object, Scope>(), cache = new WeakMap<AgentTool, AgentTool>()
  const tools = createAgentTools(registry, { ...ports, context: event => event && typeof event === 'object' ? scopes.get(event) : undefined })
  function wrapped(definition: AgentTool): AgentTool {
    const prior = cache.get(definition)
    if (prior) return prior
    const tool: AgentTool = { ...definition, async execute(input, context) {
      const event = { _agentBinding: context.binding, _agentToolSignal: context.signal }
      const { sendImage, sendBundle, sendVideoCard, sendMediaRelay, [agentTextToolPorts]: scopedPorts, ...rest } = context as AgentTextToolContext
      const guard = (isCurrent: () => boolean, signal = context.signal, ensureCurrent = context.ensureCurrent) => ({
        signal, isCurrent, ...(ensureCurrent ? { ensureCurrent } : {}),
      })
      scopes.set(event, { ...rest,
        ...(sendImage ? { sendImage: (image, current) => sendImage(image, guard(() => context.isCurrent() && current?.() !== false)) } : {}),
        ...(sendBundle ? { sendBundle: (items, current) => sendBundle(items, guard(() => context.isCurrent() && current?.() !== false)) } : {}),
        ...(sendVideoCard ? { sendVideoCard: (card, current, signal, ensure) => sendVideoCard(card, guard(current, signal, ensure)) } : {}),
        ...(sendMediaRelay ? { sendMediaRelay: (plan, current, signal, ensure) => sendMediaRelay(plan, guard(current, signal, ensure)) } : {}),
        ...scopedPorts,
      })
      try {
        const instance = tools.getExtraTools([definition.name])[0]
        if (!instance) return { status: 'failed', content: '本轮工具已不可用。' }
        const value = await instance.execute(input, event)
        if (typeof value === 'string' && value.startsWith('error:')) return { status: 'failed', content: value }
        const result = value as { kind?: unknown; status?: unknown; content?: unknown }
        if (result?.kind !== 'tool_outcome' || typeof result.content !== 'string') return { status: 'unknown', content: '工具结果尚未确认。' }
        return { status: result.status === 'success' ? 'succeeded' : result.status === 'error' ? 'failed' : 'unknown', content: result.content }
      } finally { scopes.delete(event) }
    } }
    cache.set(definition, tool)
    return tool
  }
  return { list() { return [...(registry.builtIn ?? []), ...(registry.custom ?? [])].map(wrapped) } }
}
