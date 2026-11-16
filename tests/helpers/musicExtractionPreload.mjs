// Test-only transport seam: preserve production DNS policy, pinned connector,
// response streaming and cancellation while sending official music traffic over
// real localhost HTTP. No production endpoint override is introduced.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '93.184.216.34', family: 4 }
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => host === 'music.163.com' || host.endsWith('.music.163.com') || host.endsWith('.music.126.net')
const lookup = dns.lookup
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw new Error('unexpected DNS lookup denied by music extraction fixture')
}
const request = http.request
for (const transport of [http, https]) {
  const original = transport.request
  transport.request = function (input, options, callback) {
    const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
    const hostname = url?.hostname ?? input?.hostname ?? input?.host
    if (official(hostname)) {
      assert.ok(url, 'official requests use the production URL connector')
      assert.equal(options.agent, false); assert.equal(options.family, pinned.family)
      assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.headers['Accept-Encoding'], 'identity')
      assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined)
      let selected
      options.lookup(hostname, {}, (error, address, family) => {
        assert.equal(error, null); selected = { address, family }
      })
      assert.deepEqual(selected, pinned)
      const target = new URL(process.env.MUSIC_EXTRACTION_AUDIT_URL)
      return request(target, { ...options, family: 4, lookup: undefined, servername: undefined,
        headers: { ...options.headers, 'x-extraction-source-url': encodeURIComponent(url.href),
          'x-extraction-pinned': selected.address, 'x-extraction-family': String(options.family),
          'x-extraction-signal': String(!!options.signal), 'x-extraction-agent': String(options.agent) } }, callback)
    }
    if (!local(hostname)) throw new Error('unexpected external HTTP denied by music extraction fixture')
    return original.call(this, input, options, callback)
  }
}
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw new Error('unexpected external fetch denied by music extraction fixture')
  return fetch(input, init)
}
syncBuiltinESMExports()
