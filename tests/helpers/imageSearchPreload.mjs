// Fixed public provider responses for the real CLI. Production DNS checks,
// request construction, bounded readers and image validation still execute.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const lookup = dns.lookup, originalFetch = globalThis.fetch
const pinned = { address: '93.184.216.34', family: 4 }
const hosts = new Set(['www.duitang.com', 'wallpaper.soutushenqi.com', 'cn.bing.com', 'images.example.test'])
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
dns.lookup = async (host, options) => {
  if (hosts.has(host)) return options?.all ? [pinned] : pinned
  if (local(host)) return lookup(host, options)
  throw new Error('unexpected image search DNS request')
}
https.request = (input, options, callback) => {
  const url = input instanceof URL ? input : new URL(input)
  assert.ok(hosts.has(url.hostname)); assert.equal(options.agent, false)
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers['Accept-Encoding'], 'identity')
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, pinned.address); assert.equal(family, 4)
  })
  return http.request(new URL(process.env.IMAGE_SEARCH_AUDIT_ORIGIN + '/provider'), { ...options, family: 4, lookup,
    headers: { ...options.headers, 'x-image-source-url': encodeURIComponent(url.href), 'x-image-pinned': pinned.address },
  }, callback)
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw new Error('unexpected image search global fetch')
  return originalFetch(input, init)
}
syncBuiltinESMExports()
