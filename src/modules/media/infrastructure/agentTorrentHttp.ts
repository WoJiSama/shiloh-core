import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { TORRENT_METADATA_BYTES } from './agentTorrentMetadata.js'
import { torrentFailure, torrentGuard } from './agentTorrentNative.js'

export interface AgentTorrentResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array> | Uint8Array
  close?(): void | Promise<void>
}
export type AgentTorrentRequest = (url: URL, address: LookupAddress, signal: AbortSignal, policy: { readonly maxBytes: number }) => Promise<AgentTorrentResponse>
export type AgentTorrentLookup = (hostname: string) => Promise<readonly LookupAddress[]>
export const nativeAgentTorrentRequest: AgentTorrentRequest = (url, address, signal) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'GET', agent: false, signal, family: address.family, maxHeaderSize: 16_384,
    headers: { Accept: 'application/x-bittorrent', 'Accept-Encoding': 'identity', 'User-Agent': 'bl-chat-agent' },
    lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
    response.on('error', () => {})
    resolve({ status: response.statusCode ?? 0, headers: { 'content-length': response.headers['content-length'], 'content-encoding': response.headers['content-encoding'], location: response.headers.location },
      body: response, close() { response.destroy(); request.destroy() } })
  })
  request.once('error', () => reject(torrentFailure())); request.end()
})
export function torrentCacheUrls(hash: string) {
  if (!/^[A-F\d]{40}$/u.test(hash)) throw torrentFailure()
  return [`https://itorrents.net/torrent/${hash}.torrent`, `https://torrage.info/torrent.php?h=${hash}`]
}
function officialUrl(input: string, hash: string): URL {
  if (typeof input !== 'string' || !torrentCacheUrls(hash).includes(input)) throw torrentFailure()
  return new URL(input)
}
/** Fixed cache hosts only. Every redirect is checked again and each connection pins a public DNS answer. */
export function createTorrentHttp(options: { readonly lookup?: AgentTorrentLookup; readonly request?: AgentTorrentRequest }) {
  return async (input: string, hash: string, guard: ReturnType<typeof torrentGuard>, maxBytes = TORRENT_METADATA_BYTES): Promise<Buffer> => {
    let url = officialUrl(input, hash)
    for (let hop = 0; hop <= 4; hop++) {
      await guard.ensure()
      const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw torrentFailure()
      await guard.ensure()
      const response = await guard.wait((options.request ?? nativeAgentTorrentRequest)(url, addresses[0]!, guard.signal, { maxBytes }), late => late.close?.())
      let closed = false
      const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status)) throw torrentFailure()
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(location) ||
            !torrentCacheUrls(hash).includes(location) && location !== url.pathname + url.search) throw torrentFailure()
          url = officialUrl(new URL(location, url).href, hash); await close(); continue
        }
        if (response.status < 200 || response.status >= 300 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw torrentFailure()
        const declared = response.headers['content-length']
        if (declared !== undefined && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) throw torrentFailure()
        const iterable = response.body instanceof Uint8Array ? (async function* () { yield response.body as Uint8Array })() : response.body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw torrentFailure()
        const iterator = iterable[Symbol.asyncIterator](), chunks: Buffer[] = []; let size = 0
        try {
          while (true) {
            await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next()))
            if (next.done) break
            if (!(next.value instanceof Uint8Array)) throw torrentFailure()
            size += next.value.byteLength; if (size > maxBytes) throw torrentFailure()
            chunks.push(Buffer.from(next.value))
          }
        } finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {} }
        if (!size || declared !== undefined && size !== Number(declared)) throw torrentFailure()
        await guard.ensure(); return Buffer.concat(chunks, size)
      } finally { await close() }
    }
    throw torrentFailure()
  }
}
