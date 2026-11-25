import { createHash } from 'node:crypto'
import type { AgentSemanticMemoryBackend } from '../../../contracts/semanticMemory.js'
import type { PersonProfileExtractionContext } from '../../../contracts/personProfileExtraction.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { EmbeddingGateway } from './EmbeddingGateway.js'
import { RerankGateway } from './RerankGateway.js'
import { AgentSemanticMemoryTimeoutError } from './agentSemanticRetrieval.js'

interface SemanticModel {
  readonly baseUrl: string
  readonly name: string
  readonly apiKey: string
}

export interface AgentSemanticBackendOptions {
  readonly embedding: SemanticModel
  readonly rerank?: SemanticModel
  readonly secrets?: readonly string[]
  readonly fetchFn?: typeof fetch
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
}

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 1024 * 1024
const FAILURE = '语义记忆请求失败：请求已取消、来源授权失效或服务响应无效。'

function fail(): never { throw new Error(FAILURE) }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function configured(model: SemanticModel, operation: 'embedding' | 'rerank'): SemanticModel {
  try {
    const endpoint = new URL(model.baseUrl)
    if (typeof model.baseUrl !== 'string' || model.baseUrl.length > 2048 || /[\s\\?#]/u.test(model.baseUrl) ||
        !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !endpoint.pathname.endsWith(operation === 'embedding' ? '/embeddings' : '/rerank') ||
        typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(model.name) ||
        typeof model.apiKey !== 'string' || !model.apiKey.trim() || model.apiKey.length > 8192 || /[\u0000-\u001f\u007f]/u.test(model.apiKey)) fail()
    return { baseUrl: endpoint.href, name: model.name.trim(), apiKey: model.apiKey.trim() }
  } catch { return fail() }
}
function hasSecret(text: string, secrets: readonly string[]): boolean {
  const decoded = text.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return secrets.some(secret => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')]
    .some(value => text.includes(value) || decoded.includes(value)))
}
function assertCurrent(context: PersonProfileExtractionContext, signal: AbortSignal): void {
  signal.throwIfAborted()
  context.signal.throwIfAborted()
  if (!context.isCurrent()) fail()
}
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
async function ensureCurrent(context: PersonProfileExtractionContext, signal: AbortSignal): Promise<void> {
  assertCurrent(context, signal)
  await abortable(Promise.resolve().then(() => {
    assertCurrent(context, signal)
    return context.ensureCurrent()
  }), signal)
  assertCurrent(context, signal)
}
async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) fail()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal)
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_RESPONSE_BYTES) fail()
      chunks.push(result.value)
    }
    signal.throwIfAborted()
    return object(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
  } finally {
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* A canceled injected stream may still hold a pending read. */ }
  }
}
function validatePayload(payload: Record<string, unknown>, operation: 'embedding' | 'rerank', count: number): void {
  if (payload.error) fail()
  const rows = operation === 'embedding' ? payload.data : payload.results
  if (!Array.isArray(rows) || rows.length !== count) fail()
  const seen = new Set<number>()
  let dimensions: number | undefined
  for (let offset = 0; offset < rows.length; offset++) {
    const row = object(rows[offset]), index = row.index === undefined && operation === 'embedding' ? offset : row.index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count || seen.has(index)) fail()
    seen.add(index)
    if (operation === 'embedding') {
      const vector = row.embedding
      if (!Array.isArray(vector) || vector.length < 2 || vector.length > 4096 ||
          !vector.every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
          !vector.some(value => Math.fround(value) !== 0) || dimensions !== undefined && vector.length !== dimensions) fail()
      dimensions = vector.length
    } else if (typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score) || row.relevance_score < 0 || row.relevance_score > 1) fail()
  }
}

/** Explicit standalone endpoints; no legacy config lookup, URL inference or key fallback. */
export function createAgentSemanticBackend(options: AgentSemanticBackendOptions): AgentSemanticMemoryBackend & { dispose(): void } {
  const embedding = configured(options.embedding, 'embedding')
  const rerank = options.rerank === undefined ? undefined : configured(options.rerank, 'rerank')
  const lifecycle = new AbortController()
  const secrets = [...new Set([embedding.apiKey, rerank?.apiKey, ...(options.secrets ?? [])].filter((value): value is string => typeof value === 'string' && !!value))]
  const id = createHash('sha256').update(JSON.stringify([embedding.baseUrl, embedding.name])).digest('hex')
  const fetchFn = options.fetchFn ?? fetch

  function inputs(texts: readonly string[]): void {
    if (!Array.isArray(texts) || texts.length > 2000 || texts.some(text => typeof text !== 'string' || !text.trim() || hasSecret(text, secrets)) ||
        Buffer.byteLength(JSON.stringify(texts), 'utf8') > MAX_INPUT_BYTES) fail()
  }
  function operationFetch(model: SemanticModel, operation: 'embedding' | 'rerank', context: PersonProfileExtractionContext,
    signal: AbortSignal, reportFailure: () => void): typeof fetch {
    return async (input, init) => {
      let response: Response | undefined
      let combined: AbortSignal | undefined, dispatched = false
      let step = 'request_prepare'
      let stepStarted = performance.now()
      const advance = (next: string) => { step = next; stepStarted = performance.now() }
      let failure: string | undefined
      const started = performance.now()
      try {
        const endpoint = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        // Each configured gateway gets only its exact endpoint and credentials.
        if (endpoint.href !== model.baseUrl || init?.method !== 'POST' || typeof init.body !== 'string') fail()
        const requestSignal = AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])])
        combined = requestSignal
        const body = object(JSON.parse(init.body))
        const count = operation === 'embedding' ? Array.isArray(body.input) ? body.input.length : 0
          : Array.isArray(body.documents) ? body.documents.length : 0
        if (!count) fail()
        advance('authorization')
        await ensureCurrent(context, requestSignal)
        // No authorization result survives across actual HTTP requests or batches.
        assertCurrent(context, requestSignal)
        advance('response_headers')
        const pending = Promise.resolve().then(() => {
          assertCurrent(context, requestSignal)
          dispatched = true
          return fetchFn(endpoint.href, { ...init, redirect: 'error', signal: requestSignal })
        })
        void pending.then(late => { if (requestSignal.aborted) void late.body?.cancel().catch(() => {}) }, () => {})
        response = await abortable(pending, requestSignal)
        assertCurrent(context, requestSignal)
        if (!response.ok) { failure = 'http_error'; fail() }
        if (response.redirected || response.url && new URL(response.url).href !== model.baseUrl) { failure = 'provider_redirected'; fail() }
        advance('response_body')
        const payload = await readResponse(response, requestSignal)
        advance('authorization')
        await ensureCurrent(context, requestSignal)
        advance('response_validation')
        validatePayload(payload, operation, count)
        // The legacy gateways only see validated JSON, never provider error bodies.
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      } catch (error) {
        reportFailure()
        const deadline = combined?.reason instanceof AgentSemanticMemoryTimeoutError ? combined.reason : undefined
        const providerTimedOut = !signal.aborted && combined?.reason instanceof DOMException && combined.reason.name === 'TimeoutError'
        const cancelled = combined?.aborted && !providerTimedOut
        const code = deadline ? 'semantic_provider_budget_elapsed' : providerTimedOut ? 'provider_timeout' :
          cancelled ? 'request_cancelled' : failure ?? (step === 'authorization' ? 'model_source_check_failed' :
            step === 'response_headers' ? 'provider_transport_error' : step === 'response_body'
              ? error instanceof SyntaxError ? 'model_response_body_invalid' : 'model_response_body_read_failed'
              : step === 'response_validation' ? 'model_response_envelope_invalid' : 'request_invalid')
        try {
          options.diagnostics?.emit({ stage: 'model', operation: operation === 'embedding' ? 'semantic_embedding_provider' : 'semantic_rerank_provider',
            outcome: cancelled ? 'cancelled' : 'failed', code, durationMs: performance.now() - started,
            ...(response ? { httpStatus: response.status } : {}), details: { step,
              stepMs: Math.round(performance.now() - stepStarted), dispatched,
              ...(step === 'authorization' ? { field: dispatched ? 'semantic_response_authorization' : 'semantic_request_authorization' } : {}),
              ...(deadline?.budgetMs === undefined ? {} : { limit: deadline.budgetMs }), result: dispatched ? 'discarded' : 'not_dispatched' } })
        } catch { /* Observation must not change the safe failure returned to the caller. */ }
        return fail()
      } finally {
        void response?.body?.cancel().catch(() => {})
      }
    }
  }

  return {
    id,
    async embed(texts, context) {
      let gateway: EmbeddingGateway | undefined
      try {
        const signal = AbortSignal.any([context.signal, lifecycle.signal])
        assertCurrent(context, signal)
        inputs(texts)
        if (!texts.length) return []
        let failed = false
        gateway = new EmbeddingGateway({ apiUrl: embedding.baseUrl, model: embedding.name, apiKey: embedding.apiKey,
          fetchFn: operationFetch(embedding, 'embedding', context, signal, () => { failed = true }) })
        const vectors = await abortable(gateway.embedBatch([...texts], { signal }), signal)
        assertCurrent(context, signal)
        if (failed || vectors.some(vector => vector === null)) fail()
        let dimensions: number | undefined
        return vectors.map(vector => {
          if (!vector || dimensions !== undefined && vector.length !== dimensions) fail()
          dimensions = vector.length
          return Array.from(vector)
        })
      } catch { return fail() }
      finally { gateway?.dispose() }
    },
    ...(rerank ? {
      async rerank(query: string, documents: readonly { readonly id: string; readonly text: string }[], context: PersonProfileExtractionContext) {
        let gateway: RerankGateway | undefined
        try {
          const signal = AbortSignal.any([context.signal, lifecycle.signal])
          assertCurrent(context, signal)
          inputs([query, ...documents.map(document => document.text)])
          if (documents.some(document => typeof document.id !== 'string' || !document.id || document.id.length > 256 || hasSecret(document.id, secrets)) ||
              new Set(documents.map(document => document.id)).size !== documents.length) fail()
          if (!documents.length) return null
          let failed = false
          gateway = new RerankGateway({ apiUrl: rerank.baseUrl, model: rerank.name, apiKey: rerank.apiKey,
            fetchFn: operationFetch(rerank, 'rerank', context, signal, () => { failed = true }) })
          const scores = await abortable(gateway.rerank(query, [...documents], { signal }), signal)
          assertCurrent(context, signal)
          if (failed || !scores) fail()
          return scores
        } catch { return fail() }
        finally { gateway?.dispose() }
      },
    } : {}),
    dispose() { lifecycle.abort() },
  }
}
