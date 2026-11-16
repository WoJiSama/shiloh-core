import { resolveChatCompletionUrl } from '../modules/models/domain/chatCompletionUrl.js'
import { isModelRequestCurrent } from '../contracts/modelExecution.js'

export interface SideLLMOptions {
  url?: string
  apikey?: string
  model?: string
  messages?: readonly { role: string; content: unknown }[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal | null
  isCurrent?: () => boolean
  fetchImpl?: typeof fetch | null
}
export type SideLLMResult = { ok: true; content: string; usage?: unknown } | { ok: false; error: string; status?: number }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
/** Transport errors are values so each caller retains its own fallback policy. */
export async function sideLLMCall({ url, apikey, model, messages, temperature = 0.2, maxTokens,
  timeoutMs = 30000, signal = null, isCurrent, fetchImpl = null }: SideLLMOptions = {}): Promise<SideLLMResult> {
  // 调用方给的多是渠道基址(如 .../api/coding/paas/v4),统一补全 /chat/completions;
  // 已经是完整地址的保持不变。曾因裸 POST 到 /v4 导致梗提取/表达学习全线 404。
  const endpoint = resolveChatCompletionUrl(url)
  if (!endpoint || !apikey || !model || !Array.isArray(messages) || !messages.length) {
    return { ok: false, error: 'sideLLMCall 缺少 url/apikey/model/messages' }
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (!doFetch) return { ok: false, error: 'fetch 不可用' }
  const body: { model: string; messages: SideLLMOptions['messages']; temperature: number; max_tokens?: number } = { model, messages, temperature }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens)
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1000, Number(timeoutMs) || 30000))
  signal?.addEventListener('abort', onAbort, { once: true })
  const revoked = { ok: false, error: '角色绑定已改变，模型请求已停止' } as const
  try {
    signal?.throwIfAborted()
    const payload = JSON.stringify(body)
    if (!isModelRequestCurrent(isCurrent)) return revoked
    const response = await doFetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${apikey}`, 'Content-Type': 'application/json' },
      body: payload, signal: controller.signal
    })
    signal?.throwIfAborted()
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (!isModelRequestCurrent(isCurrent)) return revoked
      return { ok: false, error: `模型请求失败: ${response.status} ${String(text).slice(0, 160)}`, status: response.status }
    }
    const data = record(await response.json())
    if (!isModelRequestCurrent(isCurrent)) return revoked
    const first = Array.isArray(data.choices) ? record(data.choices[0]) : {}
    const content = String(record(first.message).content || '').trim()
    if (!content) return { ok: false, error: '模型返回空', status: response.status }
    return { ok: true, content, ...(data.usage !== undefined ? { usage: data.usage } : {}) }
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: '模型请求已取消' }
    if (!isModelRequestCurrent(isCurrent)) return revoked
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: timedOut || /abort|timeout/i.test(message) ? `模型请求超时(${timeoutMs}ms)` : `模型请求异常: ${message}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
