import type { PersonProfileExtractionContext, PersonProfileExtractor } from '../../../contracts/personProfileExtraction.js'
import { resolveChatCompletionUrl } from '../../models/domain/chatCompletionUrl.js'
import { buildPersonProfileExtractPrompt } from '../../simulation/domain/personProfile.js'

export interface AgentPersonExtractorOptions {
  readonly baseUrl: string
  readonly name: string
  readonly apiKey: string
  readonly fetchImpl?: typeof fetch
  readonly secrets?: readonly string[]
  /** May shorten the fixed 40 second deadline, never increase it. */
  readonly timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_RESULT_CHARS = 64_000
const FAILURE = '人物事实抽取失败：请求已取消、授权失效或模型服务不可用。'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hasSecret(text: string, secrets: readonly string[]): boolean {
  const decoded = text.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return secrets.some(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
    .some(value => text.includes(value) || decoded.includes(value)))
}

function assertCurrent(context: PersonProfileExtractionContext, signal: AbortSignal, isCurrent?: () => boolean): void {
  signal.throwIfAborted()
  context.signal.throwIfAborted()
  if (!context.isCurrent() || isCurrent?.() === false) throw new Error(FAILURE)
}

/** Observe late failures even when an injected operation ignores cancellation. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(FAILURE))
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function ensureCurrent(context: PersonProfileExtractionContext, signal: AbortSignal, isCurrent?: () => boolean): Promise<void> {
  assertCurrent(context, signal, isCurrent)
  await abortable(Promise.resolve().then(() => {
    assertCurrent(context, signal, isCurrent)
    return context.ensureCurrent()
  }), signal)
  assertCurrent(context, signal, isCurrent)
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) throw new Error(FAILURE)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal)
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error(FAILURE)
      chunks.push(result.value)
    }
    signal.throwIfAborted()
    return object(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createAgentPersonExtractor(options: AgentPersonExtractorOptions): PersonProfileExtractor {
  const secrets = [...new Set([options.apiKey, ...(options.secrets ?? [])].filter(value => typeof value === 'string' && !!value))]
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(40_000, Math.floor(options.timeoutMs!))) : 40_000
  return async (messages, isCurrent, context) => {
    let response: Response | undefined
    const lifecycle = new AbortController()
    try {
      if (!context) throw new Error(FAILURE)
      const signal = AbortSignal.any([context.signal, lifecycle.signal, AbortSignal.timeout(timeoutMs)])
      assertCurrent(context, signal, isCurrent)
      const endpoint = new URL(options.baseUrl)
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          !options.name.trim() || !options.apiKey.trim()) throw new Error(FAILURE)
      const url = resolveChatCompletionUrl(endpoint.href)
      if (!Array.isArray(messages) || messages.some(message => !message || typeof message.userId !== 'string' ||
          typeof message.name !== 'string' || typeof message.text !== 'string' ||
          [message.userId, message.name, message.text].some(value => hasSecret(value, secrets)))) throw new Error(FAILURE)
      if (!messages.length) return '[]'
      // Construct author/text records explicitly; no host scope or native event is serialized.
      const prompt = buildPersonProfileExtractPrompt(messages.map(({ userId, name, text }) => ({ userId, name, text })))
      if (context.target.kind === 'private') prompt.system += '\n本次资料来自一对一会话，所有候选只保留在本会话，portable 必须为 false。'
      await ensureCurrent(context, signal, isCurrent)
      response = await abortable((options.fetchImpl ?? fetch)(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: options.name, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], stream: false, max_tokens: 2000 }),
      }), signal)
      assertCurrent(context, signal, isCurrent)
      if (response.redirected) throw new Error(FAILURE)
      const result = await readResponse(response, signal)
      const usage = object(result.usage)
      const counts = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
        .filter(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
        .map(key => [key, usage[key]]))
      if (Object.keys(counts).length) context.recordUsage?.(options.name, counts)
      await ensureCurrent(context, signal, isCurrent)
      const message = object(object(Array.isArray(result.choices) ? result.choices[0] : undefined).message)
      const content = message.content
      if (!response.ok || result.error || 'tool_calls' in message || 'function_call' in message ||
          typeof content !== 'string' || !content.trim() || hasSecret(content, secrets) || content.length > MAX_RESULT_CHARS ||
          !Array.isArray(JSON.parse(content))) throw new Error(FAILURE)
      await ensureCurrent(context, signal, isCurrent)
      return content
    } catch { throw new Error(FAILURE) }
    finally {
      lifecycle.abort()
      void response?.body?.cancel().catch(() => {})
    }
  }
}
