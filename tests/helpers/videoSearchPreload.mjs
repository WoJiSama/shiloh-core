// Synthetic official Bilibili HTTP responses; URL, DNS pinning and streams remain
// in the production provider. TLS and public-network availability are not proved here.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const pinned = { address: '93.184.216.34', family: 4 }, lookup = dns.lookup, fetch = globalThis.fetch
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
dns.lookup = async (host, options) => {
  if (['api.bilibili.com', 'b23.tv', 'www.bilibili.com'].includes(host)) return options?.all ? [pinned] : pinned
  if (local(host)) return lookup(host, options)
  throw Error('Unexpected public video DNS request')
}
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : new URL(input)
  assert.ok(['api.bilibili.com', 'b23.tv', 'www.bilibili.com'].includes(url.hostname)); assert.equal(options.method, 'GET'); assert.equal(options.agent, false)
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers['Accept-Encoding'], 'identity')
  options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, pinned.address); assert.equal(family, 4) })
  return http.request(new URL(process.env.VIDEO_SEARCH_AUDIT_URL + '/request'), { ...options, family: 4, lookup,
    headers: { ...options.headers, 'x-video-source-url': encodeURIComponent(url.href), 'x-video-pinned': pinned.address },
  }, callback)
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('Unexpected public video fetch request')
  return fetch(input, init)
}
syncBuiltinESMExports()
