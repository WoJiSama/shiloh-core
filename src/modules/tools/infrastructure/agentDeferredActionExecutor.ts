import type {
  AgentDeferredActionDefinition, AgentDeferredActionExecutionContext, AgentDeferredActionExecutor,
  AgentDeferredFrozenAction, AgentDeferredParams,
} from '../../../contracts/agentDeferredAction.js'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import { agentBindingIdentity, agentConversationKey } from '../../runtime/domain/agentBindings.js'
import { assertDeferredGrant, freezeDeferredAction } from '../../commitments/infrastructure/agentDeferredActionData.js'
import { authorizeAgentToolContext } from './agentToolAuthorization.js'
import { validateAgentToolInput } from './agentToolSchema.js'

const failed = (): AgentToolResult => ({ status: 'failed', content: '延期工具在调用前不可用或授权已失效，未执行。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '延期工具结果未知，已停止后续调用；核实前不重复执行。' })
const success = (): AgentToolResult => ({ status: 'succeeded', content: '延期工具已确认完成。' })
const rejected = (): AgentToolResult => ({ status: 'failed', content: '延期工具明确返回失败。' })
const sideEffectCapabilities = new Set(['sendImage', 'sendFile', 'sendAudio', 'sendVideo', 'sendMusic', 'sendVideoCard',
  'sendMediaRelay', 'interact', 'sendBundle', 'sendMessage'])

function unknownCapabilityResult(name: string, result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return true
  const receipt = result as Record<string, unknown>
  if (receipt.state === 'unknown' || receipt.status === 'unknown') return true
  if (receipt.state === 'failed') return false
  if (name === 'interact') return receipt.state !== 'confirmed' || !Number.isSafeInteger(receipt.completed) || !Number.isSafeInteger(receipt.requested) ||
    Number(receipt.completed) <= 0 || receipt.completed !== receipt.requested
  if (name === 'sendFile') return receipt.state !== 'uploaded' || typeof receipt.fileId !== 'string' || !receipt.fileId.trim()
  return receipt.state !== 'sent' || typeof receipt.messageId !== 'string' || !receipt.messageId.trim()
}

function deadline(value: number | undefined): number {
  const selected = value ?? 45_000
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 240_000) throw new Error('延期工具时限无效')
  return selected
}

function safeCurrent(check: () => boolean): boolean { try { return check() === true } catch { return false } }

function matches(definition: AgentDeferredActionDefinition | undefined, action: AgentDeferredFrozenAction): definition is AgentDeferredActionDefinition {
  return !!definition && definition.name === action.tool && definition.executor === action.executor &&
    definition.definitionId === action.definitionId && safeCurrent(() => definition.isCurrent())
}

/** This executor makes one attempt only. The commitment ledger owns durable deduplication. */
export function createAgentDeferredActionExecutor(ports: { getDefinitions(): readonly AgentDeferredActionDefinition[] }): AgentDeferredActionExecutor {
  function resolve(name: string): AgentDeferredActionDefinition | undefined {
    try {
      const definitions = ports.getDefinitions().filter(item => item.name === name)
      const definition = definitions.length === 1 ? definitions[0] : undefined
      return definition && safeCurrent(() => definition.isCurrent()) ? definition : undefined
    } catch { return undefined }
  }
  return {
    resolve,
    async execute(input, context) {
      let action: AgentDeferredFrozenAction, definition: AgentDeferredActionDefinition, timeoutMs: number
      try {
        action = freezeDeferredAction(input)
        const found = resolve(action.tool)
        if (context.kind !== 'deferred' || !matches(found, action) || !found.validate(action.params)) return failed()
        assertDeferredGrant(context.delegation, action, agentBindingIdentity(context.binding), context.creator, agentConversationKey(context.binding))
        definition = found
        timeoutMs = deadline(definition.timeoutMs)
      } catch { return failed() }
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal])
      const isCurrent = () => !signal.aborted && safeCurrent(context.isCurrent) && matches(resolve(action.tool), action)
      const scoped: AgentDeferredActionExecutionContext = {
        ...context, signal, isCurrent,
        async ensureCurrent() {
          if (!isCurrent()) throw new Error('延期工具授权失效')
          await context.ensureCurrent()
          if (!isCurrent()) throw new Error('延期工具授权失效')
        },
      }
      let dispatched = false, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('延期工具等待中断'))
          signal.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => controller.abort(), timeoutMs)
          if (signal.aborted) abort()
        })
        const operation = Promise.resolve().then(async () => {
          await scoped.ensureCurrent()
          if (!isCurrent() || !definition.validate(action.params)) return failed()
          dispatched = true
          const result = await definition.execute(action.params, scoped)
          await scoped.ensureCurrent()
          if (!isCurrent()) return unknown()
          if (result?.status === 'succeeded') return success()
          if (result?.status === 'failed') return rejected()
          return unknown()
        })
        return await Promise.race([operation, interrupted])
      } catch { return dispatched ? unknown() : failed() }
      finally {
        if (timer) clearTimeout(timer)
        if (abort) signal.removeEventListener('abort', abort)
        controller.abort()
      }
    },
  }
}

export type AgentDeferredToolCapabilities = Omit<AgentToolContext, 'binding' | 'actor' | 'request' | 'signal' | 'isCurrent' | 'ensureCurrent'>

/** Explicitly selected built-ins can reuse their neutral implementation with a commitment actor.
 * Tools that require a present human still refuse execution. No prior request or native event is reconstructed. */
export function createAgentDeferredToolDefinition(ports: {
  readonly tool: AgentTool
  readonly executor: 'builtin'
  readonly definitionId: string
  isCurrent(): boolean
  validate(params: AgentDeferredParams): boolean
  capabilities?(context: AgentDeferredActionExecutionContext): AgentDeferredToolCapabilities
}): AgentDeferredActionDefinition {
  const validate = (params: AgentDeferredParams) => validateAgentToolInput(ports.tool, params) && ports.validate(params)
  return {
    name: ports.tool.name, executor: 'builtin', definitionId: ports.definitionId,
    timeoutMs: deadline(ports.tool.timeoutMs), isCurrent: ports.isCurrent, validate,
    async execute(params, context) {
      if (!validate(params)) return failed()
      await context.ensureCurrent()
      if (!context.isCurrent() || !safeCurrent(ports.isCurrent)) return failed()
      let uncertain = false
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal])
      const isCurrent = () => !uncertain && !signal.aborted && context.isCurrent() && safeCurrent(ports.isCurrent)
      const ensureCurrent = async () => {
        if (!isCurrent()) throw new Error('延期工具已冻结或授权失效')
        await context.ensureCurrent()
        if (!isCurrent()) throw new Error('延期工具已冻结或授权失效')
      }
      const scoped: AgentDeferredActionExecutionContext = { ...context, signal, isCurrent, ensureCurrent }
      const freeze = () => { uncertain = true; controller.abort() }
      const supplied = ports.capabilities?.(scoped) ?? {}, capabilities: Record<string, unknown> = {}
      // Copy only documented optional capabilities; identity, request and actor cannot be injected.
      for (const key of ['botUserId', 'privatePeer', 'persona'] as const) {
        if (supplied[key] !== undefined) capabilities[key] = supplied[key]
      }
      if (supplied.recordUsage) capabilities.recordUsage = (model: string, usage: unknown) => {
        if (isCurrent()) supplied.recordUsage?.(model, usage)
      }
      for (const key of ['sendImage', 'sendFile', 'sendAudio', 'sendVideo', 'sendMusic', 'sendVideoCard',
        'sendMediaRelay', 'interact', 'isSourceAvailable', 'sendBundle', 'readImages', 'readMember', 'listMembers',
        'sendMessage', 'readHistory', 'readFile', 'readVideo', 'listFiles'] as const) {
        const operation = supplied[key]
        if (typeof operation !== 'function') continue
        capabilities[key] = async (...args: unknown[]) => {
          await ensureCurrent()
          const sideEffect = sideEffectCapabilities.has(key)
          try {
            const result: unknown = await (operation as (...values: unknown[]) => unknown)(...args)
            if (sideEffect && unknownCapabilityResult(key, result)) { freeze(); return result }
            await ensureCurrent()
            return result
          } catch (error) { if (sideEffect) freeze(); throw error }
        }
      }
      const toolContext: AgentToolContext = {
        ...capabilities, binding: context.binding, actor: { kind: 'commitment' }, signal, isCurrent, ensureCurrent,
      }
      try {
        const authorized = authorizeAgentToolContext(ports.tool, params, toolContext)
        if (!authorized || !isCurrent()) return failed()
        const result = await ports.tool.execute({ ...params }, authorized)
        return uncertain ? unknown() : result
      } catch (error) { if (uncertain) return unknown(); throw error }
      finally { controller.abort() }
    },
  }
}

export interface AgentDeferredMcpCallPort {
  (request: { name: string; arguments: Record<string, unknown> }, options: { signal: AbortSignal; timeout: number }): Promise<unknown>
}

/** Build only from an explicitly delegated, currently discovered MCP generation.
 * Wire callTool directly to that generation's SDK client; do not call the human-only AgentTool wrapper. */
export function createAgentDeferredMcpDefinition(ports: {
  readonly name: string
  readonly remoteName: string
  readonly definitionId: string
  readonly timeoutMs?: number
  readonly secrets?: readonly string[]
  isCurrent(): boolean
  /** Validate against the discovered original input schema, before model-schema adaptation. */
  validate(params: AgentDeferredParams): boolean
  readonly callTool: AgentDeferredMcpCallPort
}): AgentDeferredActionDefinition {
  const timeoutMs = deadline(ports.timeoutMs)
  const hasSecret = (text: string) => {
    const decoded = text.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    return (ports.secrets ?? []).filter(Boolean).some(secret =>
      [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
        .some(value => text.includes(value) || decoded.includes(value)))
  }
  const validate = (params: AgentDeferredParams) => {
    try {
      const serialized = JSON.stringify(params)
      return Buffer.byteLength(serialized) <= 16_000 && !hasSecret(serialized) && ports.validate(params)
    } catch { return false }
  }
  return {
    name: ports.name, executor: 'mcp', definitionId: ports.definitionId, timeoutMs, isCurrent: ports.isCurrent, validate,
    async execute(params, context) {
      if (!validate(params)) return failed()
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
      const current = () => !signal.aborted && context.isCurrent() && safeCurrent(ports.isCurrent)
      let dispatched = false, abort: (() => void) | undefined
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('MCP延期调用中断'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
        const operation = Promise.resolve().then(async () => {
          await context.ensureCurrent()
          if (!current()) return undefined
          dispatched = true
          return ports.callTool({ name: ports.remoteName, arguments: { ...params } }, { signal, timeout: timeoutMs })
        })
        const result = await Promise.race([operation, interrupted])
        if (!dispatched) return failed()
        if (!current()) return unknown()
        await Promise.race([context.ensureCurrent(), interrupted])
        if (!current()) return unknown()
        const raw = JSON.stringify(result)
        if (!raw || Buffer.byteLength(raw) > 1024 * 1024 || hasSecret(raw)) return unknown()
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknown()
        const value = parsed as Record<string, unknown>
        if (!Array.isArray(value.content) || value.isError !== undefined && typeof value.isError !== 'boolean' ||
          !value.content.every(block => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return false
            const part = block as Record<string, unknown>
            if (part.type === 'text') return typeof part.text === 'string'
            if (part.type === 'image' || part.type === 'audio') return typeof part.data === 'string' && typeof part.mimeType === 'string'
            if (part.type === 'resource_link') return typeof part.uri === 'string' && typeof part.name === 'string'
            return part.type === 'resource' && !!part.resource && typeof part.resource === 'object' && !Array.isArray(part.resource)
          })) return unknown()
        return value.isError === true ? rejected() : success()
      } catch { return dispatched ? unknown() : failed() }
      finally { if (abort) signal.removeEventListener('abort', abort) }
    },
  }
}
