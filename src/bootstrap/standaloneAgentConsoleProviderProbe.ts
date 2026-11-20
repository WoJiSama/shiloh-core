import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext } from '../contracts/agentConsole.js'
import { createProviderProbe } from '../modules/models/application/aiProviderProbe.js'
import type { ConsoleModelView } from './standaloneAgentConsolePersistence.js'

const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 512 * 1024

async function responseText(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  try {
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('probe_response_limit')
    const decoder = new TextDecoder()
    let bytes = 0, text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('probe_response_limit')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}

export function createStandaloneAgentConsoleProviderProbe(env: NodeJS.ProcessEnv, executionSignal: AbortSignal) {
  let pending = false
  return async (model: ConsoleModelView, name: string, context: AgentConsoleContext, ensure: () => void) => {
    ensure()
    if (pending) throw new AgentConsoleError('conflict')
    const key = model.apiKeyConfigured ? env[model.apiKeyEnv]?.trim() : undefined
    if (!key) return { results: [{ name, ok: false, ms: 0, detail: '该渠道的服务器凭据尚未配置' }] }
    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    const signal = AbortSignal.any([context.signal, executionSignal, deadline])
    const { probeProvider } = createProviderProbe(async (url, request) => {
      ensure()
      const response = await fetch(url, { ...request, signal, redirect: 'error' })
      return { status: response.status, ok: response.ok, text: () => responseText(response) }
    })
    pending = true
    try {
      const outcome = await probeProvider({ apiUrl: model.baseUrl, model: name, name, apiKey: key }, 'chat', { timeoutMs: TIMEOUT_MS })
      ensure()
      const status = outcome.detail.match(/^HTTP [1-5]\d\d/u)?.[0]
      const detail = outcome.ok ? '模型已响应' : deadline.aborted ? '模型请求超时' : status || '模型未返回有效响应'
      return { results: [{ name, ok: outcome.ok, ms: outcome.ms, detail }] }
    } finally {
      pending = false
    }
  }
}
