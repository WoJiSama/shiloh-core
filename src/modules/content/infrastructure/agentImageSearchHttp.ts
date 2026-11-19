import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { abortableAgentWeb, ensureAgentWebCurrent } from '../../tools/infrastructure/agentPublicWeb.js'

export interface AgentImageSearchHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array> | Uint8Array | string
  close?(): void | Promise<void>
}
export interface AgentImageSearchRequestPolicy {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly maxBytes: number
  readonly body?: string
}
export type AgentImageSearchRequest = (url: URL, address: LookupAddress, signal: AbortSignal,
  policy: AgentImageSearchRequestPolicy) => Promise<AgentImageSearchHttpResponse>
export interface AgentImageSearchHttpDependencies {
  lookup?(hostname: string): Promise<readonly LookupAddress[]>
  readonly request?: AgentImageSearchRequest
}
export type AgentImageSearchGuard = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
export const imageSearchFailure = () => new Error('图片搜索不可用：参数、来源、网络或内容未通过验证')

/** The connection uses exactly one already checked public DNS answer, without redirects or retries. */
export const nativeAgentImageSearchRequest: AgentImageSearchRequest = (url, address, signal, policy) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? https : http).request(url, { method: policy.method, agent: false, signal,
    family: address.family, maxHeaderSize: 16_384, headers: { ...policy.headers, 'Accept-Encoding': 'identity' },
    lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
    response.on('error', () => {})
    resolve({ status: response.statusCode ?? 0, headers: {
      'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
      'content-encoding': response.headers['content-encoding'], location: response.headers.location,
    }, body: response, close() { response.destroy(); request.destroy() } })
  })
  request.once('error', () => reject(imageSearchFailure()))
  request.end(policy.body)
})

export async function readImageSearchBody(response: AgentImageSearchHttpResponse, guard: AgentImageSearchGuard, maxBytes: number): Promise<Buffer> {
  const length = response.headers['content-length']
  if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity' ||
      length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw imageSearchFailure()
  const body = response.body, iterable = typeof body === 'string' || body instanceof Uint8Array
    ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw imageSearchFailure()
  const chunks: Buffer[] = [], iterator = iterable[Symbol.asyncIterator](); let size = 0
  try {
    for (;;) {
      await ensureAgentWebCurrent(guard)
      const part = await abortableAgentWeb(Promise.resolve().then(() => iterator.next()), guard.signal)
      await ensureAgentWebCurrent(guard)
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) throw imageSearchFailure()
      size += part.value.byteLength
      if (size > maxBytes) throw imageSearchFailure()
      chunks.push(Buffer.from(part.value))
    }
    if (!size || length !== undefined && Number(length) !== size) throw imageSearchFailure()
    return Buffer.concat(chunks, size)
  } finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {} }
}

const METADATA_ENDPOINTS = new Map([
  ['https://www.duitang.com/napi/blog/list/by_search/', 'GET'],
  ['https://wallpaper.soutushenqi.com/v1/wallpaper/list', 'POST'],
  ['https://cn.bing.com/images/vsasync', 'GET'],
])

/** Only a provider's fixed metadata operation is accepted; redirects cannot change that operation. */
export function createImageSearchJsonReader(dependencies: AgentImageSearchHttpDependencies, allows: (text: string) => boolean) {
  return async (url: URL, policy: AgentImageSearchRequestPolicy, guard: AgentImageSearchGuard): Promise<Record<string, unknown>> => {
    let response: AgentImageSearchHttpResponse | undefined
    try {
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
          METADATA_ENDPOINTS.get(url.origin + url.pathname) !== policy.method || !allows(url.href) ||
          policy.body !== undefined && (!allows(policy.body) || Buffer.byteLength(policy.body) > 4096)) throw imageSearchFailure()
      await ensureAgentWebCurrent(guard)
      const addresses = await abortableAgentWeb((dependencies.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname), guard.signal)
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address =>
        !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw imageSearchFailure()
      await ensureAgentWebCurrent(guard)
      const received = await abortableAgentWeb<AgentImageSearchHttpResponse>(Promise.resolve().then(() => {
        guard.signal.throwIfAborted()
        if (!guard.isCurrent()) throw imageSearchFailure()
        return (dependencies.request ?? nativeAgentImageSearchRequest)(url, addresses[0]!, guard.signal, policy)
      }).then(value => { if (guard.signal.aborted) { void Promise.resolve(value.close?.()).catch(() => {}); throw imageSearchFailure() } return value }), guard.signal)
      response = received
      await ensureAgentWebCurrent(guard)
      const type = (received.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase()
      // This fixed Bing endpoint serves JSON as text/plain. Keep the complete
      // JSON, byte, schema and secret checks below; no other provider gains it.
      const bingPlainJson = type === 'text/plain' && url.origin + url.pathname === 'https://cn.bing.com/images/vsasync'
      if (type !== 'application/json' && !type.endsWith('+json') && !bingPlainJson) throw imageSearchFailure()
      const bytes = await readImageSearchBody(received, guard, policy.maxBytes)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!allows(text)) throw imageSearchFailure()
      const result: unknown = JSON.parse(text)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw imageSearchFailure()
      const pending: { value: unknown; depth: number }[] = [{ value: result, depth: 0 }]; let visited = 0
      while (pending.length) {
        const next = pending.pop()!
        if (++visited > 40_000 || next.depth > 24) throw imageSearchFailure()
        if (typeof next.value === 'string') { if (!allows(next.value)) throw imageSearchFailure() }
        else if (Array.isArray(next.value)) for (const value of next.value) pending.push({ value, depth: next.depth + 1 })
        else if (next.value && typeof next.value === 'object') for (const [key, value] of Object.entries(next.value)) {
          if (!allows(key)) throw imageSearchFailure()
          pending.push({ value, depth: next.depth + 1 })
        }
      }
      await ensureAgentWebCurrent(guard)
      return result as Record<string, unknown>
    } catch { throw imageSearchFailure() }
    finally { try { await response?.close?.() } catch {} }
  }
}
