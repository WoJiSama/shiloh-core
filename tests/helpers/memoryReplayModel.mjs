import { resolveChatCompletionUrl } from '../../utils/chatCompletionUrl.js'

const TIMEOUT_MS = 25_000
const MAX_HTTP_CALLS = 30
const MAX_OUTPUT_TOKENS = 512

const failureMessages = {
  invalid_request: 'Invalid memory replay model request',
  authorization: 'Memory replay source authorization was not granted',
  call_limit: 'Memory replay HTTP call limit reached',
  network: 'Memory replay model request failed during transport',
  http: 'Memory replay model provider returned an unsuccessful HTTP status',
  provider: 'Memory replay model provider returned an error',
  invalid_response: 'Invalid memory replay model response',
  aborted: 'Memory replay model request was cancelled',
  timeout: 'Memory replay model request timed out',
}

function chatCompletionEndpoint(baseUrl) {
  const url = typeof baseUrl === 'string' ? URL.parse(baseUrl.trim()) : null
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Memory replay requires an HTTP(S) base URL without credentials')
  }

  url.pathname = resolveChatCompletionUrl(url.pathname) || '/v1/chat/completions'
  url.hash = ''
  return url
}

async function awaitAuthorization(ensureCurrent, signal) {
  signal.throwIfAborted()
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([Promise.resolve().then(ensureCurrent), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// The replay runner supplies credentials and calls this adapter with synthetic request data.
export function createMemoryReplayModel({ model, apiKey, baseUrl = 'https://api.openai.com/v1' }) {
  if (typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new TypeError('Memory replay requires an explicit model and API key')
  }
  const modelName = model.trim()
  const authorization = `Bearer ${apiKey.trim()}`
  const endpoint = chatCompletionEndpoint(baseUrl)
  const calls = []
  const metadata = { model: modelName, hostname: endpoint.hostname }
  let httpCalls = 0

  async function generate(request, signal, ensureCurrent) {
    const started = performance.now()
    const call = { responseModel: null, usage: null, elapsedMs: null, status: null, error: null }
    calls.push(call)
    const fail = code => {
      call.error = code
      return { error: { code, message: failureMessages[code], status: call.status } }
    }

    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS)
    let stage = 'invalid_request'
    try {
      const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
      requestSignal.throwIfAborted()
      if (!Array.isArray(request?.messages)) return fail('invalid_request')
      const body = JSON.stringify({
        model: modelName,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.tool_choice,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
      })

      stage = 'authorization'
      if (typeof ensureCurrent !== 'function') return fail('authorization')
      await awaitAuthorization(ensureCurrent, requestSignal)
      requestSignal.throwIfAborted()
      if (httpCalls >= MAX_HTTP_CALLS) return fail('call_limit')
      httpCalls += 1

      stage = 'network'
      const response = await fetch(endpoint.href, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: requestSignal,
      })
      call.status = response.status
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        return fail('http')
      }

      stage = 'invalid_response'
      const result = await response.json()
      requestSignal.throwIfAborted()
      if (result?.error) return fail('provider')
      const message = result?.choices?.[0]?.message
      if (!Array.isArray(result?.choices) || !message || typeof message !== 'object' || Array.isArray(message)) {
        return fail('invalid_response')
      }

      call.responseModel = typeof result.model === 'string' ? result.model : null
      if (result.usage) call.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
        .filter(key => Number.isSafeInteger(result.usage[key])).map(key => [key, result.usage[key]]))
      return result
    } catch {
      if (signal?.aborted) return fail('aborted')
      if (deadline.signal.aborted) return fail('timeout')
      return fail(stage)
    } finally {
      clearTimeout(timer)
      call.elapsedMs = Math.round(performance.now() - started)
    }
  }

  return { generate, calls, metadata }
}
