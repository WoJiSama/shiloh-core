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
type SideLLMFailureCode = 'model_configuration_invalid' | 'provider_transport_unavailable' | 'provider_cancelled' |
  'model_source_changed' | 'http_error' | 'provider_timeout' | 'provider_transport_error' | 'model_response_body_read_failed' |
  'model_response_body_invalid' | 'model_response_envelope_invalid' | 'model_response_truncated' |
  'model_response_refused' | 'model_response_empty'
export type SideLLMResult = { ok: true; content: string; usage?: unknown } |
  { ok: false; code: SideLLMFailureCode; error: string; status?: number; limit?: number }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
/** Transport errors are values so each caller retains its own fallback policy. */
export async function sideLLMCall({ url, apikey, model, messages, temperature = 0.2, maxTokens,
  timeoutMs = 30000, signal = null, isCurrent, fetchImpl = null }: SideLLMOptions = {}): Promise<SideLLMResult> {
  // 调用方给的多是渠道基址(如 .../api/coding/paas/v4),统一补全 /chat/completions;
  // 已经是完整地址的保持不变。曾因裸 POST 到 /v4 导致梗提取/表达学习全线 404。
  const endpoint = resolveChatCompletionUrl(url)
  if (!endpoint || !apikey || !model || !Array.isArray(messages) || !messages.length) {
    return { ok: false, code: 'model_configuration_invalid', error: 'sideLLMCall 缺少 url/apikey/model/messages' }
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (!doFetch) return { ok: false, code: 'provider_transport_unavailable', error: 'fetch 不可用' }
  const body: { model: string; messages: SideLLMOptions['messages']; temperature: number; max_tokens?: number } = { model, messages, temperature }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens)
  const controller = new AbortController()
  let timedOut = false
  let status: number | undefined
  const onAbort = () => controller.abort(signal?.reason)
  const deadline = Math.max(1000, Number(timeoutMs) || 30000)
  const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException('模型请求超时', 'TimeoutError')) }, deadline)
  signal?.addEventListener('abort', onAbort, { once: true })
  const revoked = { ok: false, code: 'model_source_changed', error: '角色绑定已改变，模型请求已停止' } as const
  try {
    signal?.throwIfAborted()
    const payload = JSON.stringify(body)
    if (!isModelRequestCurrent(isCurrent)) return revoked
    const response = await doFetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${apikey}`, 'Content-Type': 'application/json' },
      body: payload, signal: controller.signal
    })
    signal?.throwIfAborted()
    controller.signal.throwIfAborted()
    status = response.status
    if (!response.ok) {
      await response.text().catch(() => '')
      signal?.throwIfAborted()
      if (!isModelRequestCurrent(isCurrent)) return revoked
      return { ok: false, code: 'http_error', error: `模型请求失败（HTTP ${status}）`, status }
    }
    const data = record(await response.json())
    signal?.throwIfAborted()
    controller.signal.throwIfAborted()
    if (!isModelRequestCurrent(isCurrent)) return revoked
    const first = Array.isArray(data.choices) ? record(data.choices[0]) : {}
    const message = record(first.message)
    const content = typeof message.content === 'string' ? message.content.trim() : ''
    if (first.finish_reason === 'content_filter' || typeof message.refusal === 'string' && message.refusal.trim()) {
      return { ok: false, code: 'model_response_refused', error: '模型拒绝返回正文', status }
    }
    if (!content) {
      if (first.finish_reason === 'length') return { ok: false, code: 'model_response_truncated', error: '模型在输出上限内未返回正文', status,
        ...(body.max_tokens === undefined ? {} : { limit: body.max_tokens }) }
      if (!Object.hasOwn(message, 'content') || (message.content !== null && typeof message.content !== 'string')) {
        return { ok: false, code: 'model_response_envelope_invalid', error: '模型响应结构无效', status }
      }
      return { ok: false, code: 'model_response_empty', error: '模型返回空', status }
    }
    return { ok: true, content, ...(data.usage !== undefined ? { usage: data.usage } : {}) }
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: 'provider_cancelled', error: '模型请求已取消' }
    if (!isModelRequestCurrent(isCurrent)) return revoked
    if (timedOut) return { ok: false, code: 'provider_timeout', error: `模型请求超时（${deadline}ms）`,
      ...(status === undefined ? {} : { status }), limit: deadline }
    if (status !== undefined) return error instanceof SyntaxError
      ? { ok: false, code: 'model_response_body_invalid', error: '模型响应不是有效的 JSON', status }
      : { ok: false, code: 'model_response_body_read_failed', error: '模型响应体读取失败', status }
    return { ok: false, code: 'provider_transport_error', error: '模型请求发生传输错误' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
