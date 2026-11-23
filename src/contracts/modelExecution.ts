import type { ChatMessage, ChatRequestData, ChatResponse } from './modelGateway.js'
import type { AgentDiagnosticEvent } from './agentDiagnostics.js'
export interface Backend {
 apiUrl?: string | undefined; model?: string | undefined; apiKey?: string | string[] | undefined; label?: string | undefined
 reasoningEffort?: string | undefined; maxTokensField?: string | undefined; maxOutputTokens?: number | undefined
 complexity?: { score: number; signals: string[] }
}
export interface ChatBackendConfig { chatApiUrl?: string | undefined; chatApiModel?: string | undefined; chatApiKey?: string | string[] | undefined; chatReasoningEffort?: string; label?: string | undefined }
export interface ExecutionConfig {
 providers?: string; useTools?: boolean; chatAiConfig?: ChatBackendConfig
 toolsAiConfig?: { toolsAiUrl?: string; toolsAiModel?: string; toolsAiApikey?: string; toolsReasoningEffort?: string }
 trackAiConfig?: { trackAiUrl?: string; trackAiModel?: string; trackAiApikey?: string | string[] }
 searchAiConfig?: { searchApiUrl?: string; searchApiModel?: string; searchApiKey?: string | string[] }
 memoryAiConfig?: { memoryAiUrl?: string; memoryAiModel?: string; memoryAiApikey?: string | string[] }
 taskAiConfig?: Record<string, Backend>; [field: string]: unknown
}
export interface ExecutionOptions {
 taskBackend?: string; forceChatBackend?: boolean; toolsBackendFallback?: boolean; textBackendFallback?: boolean; routeLabel?: string
 /** A host-owned, synchronous authorization check before every provider dispatch. */
 isCurrent?: () => boolean
 /** Host-owned source authorization, awaited before every actual provider request, including retries and fallbacks. Reject to revoke the request. */
 ensureCurrent?: () => Promise<void>
 signal?: AbortSignal; generation?: { temperature?: number; topP?: number; maxOutputTokens?: number; maxTokensField?: string; reasoningEffort?: string }
}
export function isModelRequestCurrent(check?: () => boolean): boolean {
  if (check === undefined) return true
  try { return check() === true } catch { return false }
}
/** Cancel local authorization waiting without allowing a late grant to dispatch. */
export function awaitModelRequestAuthority(check: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const abort = () => finish(signal?.reason ?? new Error('模型请求已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(check).then(() => finish(), error => finish(error ?? new Error('模型请求授权失败')))
  })
}
export interface ModelExecutionPorts {
 fetch: typeof fetch
 logger: { info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void }
 observe?(event: Pick<AgentDiagnosticEvent, 'operation' | 'outcome' | 'code' | 'httpStatus' | 'details'> & { error?: unknown }): void
 removeToolPromptsFromMessages(messages: ChatMessage[]): ChatMessage[]
 resolveChatCompletionUrl(url?: string): string
 resolveAgentBackend(config: ExecutionConfig, request: ChatRequestData): Backend
 shouldAcceptPlannerTextResponse(response: ChatResponse): boolean
 summarizeToolResultForAgent(name: string, content: unknown): string
}
