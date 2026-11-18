// Test-only native transport seam. Keep the production QQ DNS policy, numeric
// pin, headers and cancellation, then deliver that request to a local fixture.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '8.8.8.8', family: 4 }
const local = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
const native = host => host === 'multimedia.nt.qq.com.cn'
const lookup = dns.lookup
dns.lookup = async (host, options) => {
  if (native(host)) { assert.equal(options?.all, true); return [pinned] }
  if (local(host)) return lookup(host, options)
  throw new Error('unexpected video fixture DNS request')
}
const localRequest = http.request
for (const transport of [http, https]) {
  const original = transport.request
  transport.request = function (input, options, callback) {
    const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
    const host = url?.hostname ?? input?.hostname ?? input?.host
    if (native(host)) {
      assert.ok(url); assert.equal(url.protocol, 'https:'); assert.equal(options.method, 'GET')
      assert.equal(options.agent, false); assert.equal(options.family, 4); assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined)
      let address
      options.lookup(host, {}, (error, selected, family) => { assert.equal(error, null); address = { address: selected, family } })
      assert.deepEqual(address, pinned)
      return localRequest(new URL(process.env.VIDEO_ANALYSIS_AUDIT_URL), { ...options, family: 4, lookup: undefined, servername: undefined,
        headers: { ...options.headers, 'x-video-source-url': encodeURIComponent(url.href), 'x-video-pinned-address': address.address,
          'x-video-pinned-family': String(address.family) } }, callback)
    }
    if (!local(host)) throw new Error('unexpected external video fixture HTTP request')
    return original.call(this, input, options, callback)
  }
}
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw new Error('unexpected external video fixture fetch request')
  return fetch(input, init)
}
syncBuiltinESMExports()
