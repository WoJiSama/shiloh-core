import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import type { AgentMagnetSearchProvider } from '../../../contracts/agentMagnetSearch.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { abortableAgentWeb, ensureAgentWebCurrent } from '../../tools/infrastructure/agentPublicWeb.js'
import { MagnetSearchClient, buildMagnetFromInfoHash, normalizeMagnetSearchConfig } from './MagnetSearchClient.js'
import { nativeAgentBilibiliRequest, type AgentBilibiliRequest, type AgentBilibiliResponse } from './agentBilibiliRelayHttp.js'

const MAX_BYTES = 1024 * 1024
const failure = () => new Error('磁力搜索失败：公开索引、网络或授权不可用')
type ProxyFetch = (url: string, options: { readonly method: 'GET'; readonly redirect: 'error'; readonly signal: AbortSignal; readonly headers: Record<string, string> }) => Promise<Response>

/** Reuses the existing source merge/parser; anonymous CSV stays direct, only supplementary sources use the declared proxy. */
export function createAgentMagnetSearchProvider(config: ReturnType<typeof normalizeMagnetSearchConfig>, options: {
  readonly lookup?: (hostname: string) => Promise<readonly LookupAddress[]>
  readonly request?: AgentBilibiliRequest
  readonly proxyFetchImpl?: ProxyFetch
  readonly secrets?: readonly string[]
  allowsText?(text: string): boolean
} = {}): AgentMagnetSearchProvider {
  const proxy = config.proxyUrl ? new URL(config.proxyUrl) : undefined
  const secrets = [...options.secrets ?? [], ...[proxy?.username, proxy?.password].filter((value): value is string => !!value).flatMap(value => [value, decodeURIComponent(value)])]
  const safe = createAgentSecretTextCheck(secrets)
  const allows = (text: string) => safe(text) && options.allowsText?.(text) !== false
  return Object.freeze<AgentMagnetSearchProvider>({ async search(input, context) {
    let agent: { destroy(): Promise<void> } | undefined
    const cancel = new AbortController()
    // Each source owns its deadline. A sibling timing out must still allow the
    // client's allSettled merge to preserve already completed sources.
    const signal = AbortSignal.any([context.signal, cancel.signal])
    const scope: AgentMediaResourceContext = { ...context, signal }
    try {
      if (!config.enabled || typeof input.keyword !== 'string' || !input.keyword.trim() || input.keyword.length > 300 ||
          /[\u0000-\u001f\u007f]/u.test(input.keyword) || !allows(input.keyword) ||
          input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20)) throw failure()
      await ensureAgentWebCurrent(scope)
      let proxyFetch: ProxyFetch | undefined = options.proxyFetchImpl
      let openingProxy: Promise<ProxyFetch> | undefined
      const getProxyFetch = () => openingProxy ??= (async () => {
        if (proxyFetch) return proxyFetch
        const undici = await import('undici')
        await ensureAgentWebCurrent(scope)
        const dispatcher = new undici.ProxyAgent(config.proxyUrl); agent = dispatcher
        proxyFetch = async (url, init) => undici.fetch(url, { ...init, dispatcher }) as unknown as Promise<Response>
        return proxyFetch
      })()
      const transport = (useProxy: boolean) => async (inputUrl: string, init: { signal?: AbortSignal } = {}) => {
        const sourceSignal = AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])])
        const sourceScope = { ...scope, signal: sourceSignal }, url = new URL(inputUrl)
        const declared = new URL(useProxy ? url.origin === new URL(config.bitsearchUrl).origin && url.pathname === new URL(config.bitsearchUrl).pathname ? config.bitsearchUrl : config.solidSearchUrl : config.searchUrl)
        if (url.protocol !== 'https:' || url.username || url.password || url.origin !== declared.origin || url.pathname !== declared.pathname || !allows(url.href)) throw failure()
        await ensureAgentWebCurrent(sourceScope)
        const addresses = await abortableAgentWeb((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname), sourceSignal)
        if (!addresses.length || addresses.length > 32 || addresses.some(value => isIP(value.address) !== value.family || !isPublicAddress(value.address))) throw failure()
        await ensureAgentWebCurrent(sourceScope)
        const headers = { Accept: 'application/json,text/html', 'User-Agent': 'shiloh-agent-magnet-search', 'Accept-Encoding': 'identity' }
        const request = useProxy ? (async (): Promise<AgentBilibiliResponse> => {
          if (!config.proxyUrl) throw failure()
          const fetchProxy = await getProxyFetch()
          await ensureAgentWebCurrent(sourceScope)
          const response = await fetchProxy(url.href, { method: 'GET', redirect: 'error', signal: sourceSignal, headers })
          return { status: response.status, headers: Object.fromEntries(response.headers.entries()),
            body: response.body as unknown as AsyncIterable<Uint8Array>, close: () => response.body?.cancel().catch(() => {}) }
        })() : (options.request ?? nativeAgentBilibiliRequest)(url, addresses[0]!, sourceSignal, { maxBytes: MAX_BYTES, headers })
        const observed = request.then(response => { if (sourceSignal.aborted) void Promise.resolve(response.close?.()).catch(() => {}); return response })
        const response = await abortableAgentWeb(observed, sourceSignal)
        try {
          await ensureAgentWebCurrent(sourceScope)
          if (response.status < 200 || response.status >= 300 || Number(response.headers['content-length']) > MAX_BYTES ||
              response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw failure()
          const content = response.body
          const iterable = typeof content === 'string' || content instanceof Uint8Array ? (async function* () { yield typeof content === 'string' ? Buffer.from(content) : content })() : content
          if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw failure()
          const iterator = iterable[Symbol.asyncIterator](), chunks: Uint8Array[] = []
          let bytes = 0
          try {
            for (;;) {
              await ensureAgentWebCurrent(sourceScope)
              const next = await abortableAgentWeb(Promise.resolve().then(() => iterator.next()), sourceSignal)
              if (next.done) break
              if (!(next.value instanceof Uint8Array) || (bytes += next.value.byteLength) > MAX_BYTES) throw failure()
              chunks.push(next.value)
            }
          } finally { void Promise.resolve(iterator.return?.()).catch(() => {}) }
          const raw = Buffer.concat(chunks, bytes).toString('utf8')
          if (!allows(raw)) throw failure()
          await ensureAgentWebCurrent(sourceScope)
          return { ok: true, status: response.status, text: async () => raw }
        } finally { await response.close?.() }
      }
      const client = new MagnetSearchClient({ ...config }, { fetchImpl: transport(false), proxyFetchImpl: transport(true) })
      const result = await abortableAgentWeb(client.search({ keyword: input.keyword.trim(), limit: input.limit ?? 10 }), signal)
      await ensureAgentWebCurrent(scope)
      const rows = result.torrents.map((row, index) => {
        const name = row.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240)
        const magnet = buildMagnetFromInfoHash(row.infoHash, name)
        if (!magnet || !allows(name) || !allows(magnet)) throw failure()
        return `${index + 1}. ${name}｜${String(row.size).slice(0, 64)}｜做种 ${row.seeders}｜下载 ${row.leechers}\n磁链：${magnet}`
      })
      const content = rows.length ? `磁力搜索：${input.keyword.trim()}（${rows.length} 条；公开索引未经核实，只展示清单，不会自动下载）\n${rows.join('\n')}` : `没有找到「${input.keyword.trim()}」相关的磁力资源。`
      if (content.length > 32768 || !allows(content)) throw failure()
      await ensureAgentWebCurrent(scope)
      return content
    } catch { throw failure() }
    finally { cancel.abort(); await agent?.destroy() }
  } })
}
