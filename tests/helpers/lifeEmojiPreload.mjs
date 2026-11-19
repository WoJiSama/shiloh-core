// Substitute only the public transport. The CLI still constructs provider
// URLs, validates public DNS, pins requests and reads bounded HTTP responses.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const lookup = dns.lookup, originalFetch = globalThis.fetch
const pinned = { address: '93.184.216.34', family: 4 }
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
dns.lookup = async (host, options) => {
  if (host === 'api.bilibili.com') return options?.all ? [pinned] : pinned
  if (local(host)) return lookup(host, options)
  throw new Error('unexpected life/emoji fixture DNS request')
}
https.request = (input, options, callback) => {
  const url = input instanceof URL ? input : new URL(input)
  assert.equal(url.origin, 'https://api.bilibili.com'); assert.equal(options.agent, false)
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers['Accept-Encoding'], 'identity')
  options.lookup(url.hostname, {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, pinned.address); assert.equal(family, 4)
  })
  const request = http.request(new URL(process.env.LIFE_EMOJI_AUDIT_ORIGIN + '/provider'), { ...options, family: 4, lookup,
    headers: { ...options.headers, 'x-life-source-url': encodeURIComponent(url.href), 'x-life-pinned': pinned.address },
  }, callback)
  if (process.env.LIFE_EMOJI_AUDIT_TRACE === '1') request.once('response', response => {
    const trace = stage => process.stderr.write(`[life-provider-fixture] ${stage} ${url.pathname}\n`)
    trace('response'); response.once('end', () => trace('end')); response.once('close', () => trace('close'))
  })
  return request
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw new Error('unexpected life/emoji global fetch')
  return originalFetch(input, init)
}
syncBuiltinESMExports()
