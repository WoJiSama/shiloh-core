import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { bilibiliGuard, nativeAgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest, AgentBilibiliResponse } from './agentBilibiliRelayHttp.js'
import { bilibiliAuthCancelled, bilibiliAuthDiagnostic, bilibiliAuthFailure } from './agentBilibiliAuthVault.js'

const MAX_BYTES = 32_768
export function createAgentBilibiliAuthHttp(options: { lookup?: AgentBilibiliLookup; request?: AgentBilibiliRequest; diagnostics?: Pick<AgentDiagnostics, 'emit'> }) {
  return async (kind: 'generate' | 'poll', guard: ReturnType<typeof bilibiliGuard>, key?: string): Promise<Record<string, unknown>> => {
    let phase: 'input' | 'dns' | 'request' | 'headers' | 'body' | 'parse' = 'input', reported = false
    const diagnose = (at: typeof phase, error: unknown) => {
      reported = true
      const outcome = bilibiliAuthCancelled(guard.context) ? 'cancelled' : 'failed'
      bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_http', outcome, `auth_http_${kind}_${at}_${outcome}`, error)
    }
    // Observe provider exceptions before the guard replaces them with a public static failure.
    const observe = <T>(at: typeof phase, operation: () => Promise<T>): Promise<T> => {
      try { return Promise.resolve(operation()).catch(error => { diagnose(at, error); throw error }) }
      catch (error) { diagnose(at, error); return Promise.reject(error) }
    }
    const close = async (value: AgentBilibiliResponse | undefined, code: 'auth_http_response_close_failed' | 'auth_http_late_response_close_failed') => {
      try { await value?.close?.() } catch (error) { bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_cleanup', 'failed', code, error) }
    }
    let response: AgentBilibiliResponse | undefined
    try {
      const url = new URL(`https://passport.bilibili.com/x/passport-login/web/qrcode/${kind}`)
      if (kind === 'poll') { if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/u.test(key)) throw bilibiliAuthFailure(); url.searchParams.set('qrcode_key', key) }
      else if (key !== undefined) throw bilibiliAuthFailure()
      await guard.ensure(); phase = 'dns'
      const addresses = await guard.wait(observe('dns', () => (options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname)))
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw bilibiliAuthFailure()
      await guard.ensure(); phase = 'request'
      response = await guard.wait(observe('request', () => (options.request ?? nativeAgentBilibiliRequest)(url, addresses[0]!, guard.signal, { maxBytes: MAX_BYTES, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://www.bilibili.com/' } })), late => close(late, 'auth_http_late_response_close_failed'))
      await guard.ensure()
      phase = 'headers'
      const mime = (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase(), length = response.headers['content-length']
      if (response.status !== 200 || mime !== 'application/json' && !mime?.endsWith('+json') || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' ||
        length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_BYTES)) throw bilibiliAuthFailure()
      phase = 'body'
      const body = response.body, iterable = typeof body === 'string' || body instanceof Uint8Array ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw bilibiliAuthFailure()
      const iterator = iterable[Symbol.asyncIterator](), chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          await guard.ensure(); const next = await guard.wait(observe('body', () => Promise.resolve(iterator.next())))
          if (next.done) break
          if (!(next.value instanceof Uint8Array) || (size += next.value.byteLength) > MAX_BYTES) throw bilibiliAuthFailure()
          chunks.push(Buffer.from(next.value))
        }
      } finally {
        const failed = (error: unknown) => bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_cleanup', 'failed', 'auth_http_iterator_return_failed', error)
        try { void Promise.resolve(iterator.return?.()).catch(failed) } catch (error) { failed(error) }
      }
      if (!size || length !== undefined && Number(length) !== size) throw bilibiliAuthFailure()
      phase = 'parse'
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bilibiliAuthFailure()
      await guard.ensure(); return parsed as Record<string, unknown>
    } catch (error) { if (!reported) diagnose(phase, error); throw bilibiliAuthFailure() } finally { await close(response, 'auth_http_response_close_failed') }
  }
}
