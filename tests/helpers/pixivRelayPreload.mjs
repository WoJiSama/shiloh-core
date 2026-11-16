// Synthetic Pixiv CLI acceptance: fixed official metadata and image sockets
// use local responses. URL/DNS/pinning/HTTP streams stay real; TLS is synthetic.
// Dedicated network tests own TLS/CONNECT proof. No public network runs.
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '93.184.216.34', family: 4 }
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => ['www.pixiv.net', 'i.pximg.net'].includes(host)
const lookup = dns.lookup, request = http.request, nativeFetch = globalThis.fetch
const connect = net.connect, fixtureSockets = new WeakSet()
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw Error('Unexpected external DNS denied by Pixiv CLI fixture')
}
net.connect = function (options, ...args) {
  if (options && typeof options === 'object' && options.host === pinned.address) {
    assert.equal(options.port, 443); assert.equal(options.family, pinned.family)
    const audit = new URL(process.env.PIXIV_RELAY_AUDIT_URL)
    const socket = connect({ ...options, host: audit.hostname, port: Number(audit.port) }, ...args)
    fixtureSockets.add(socket); return socket
  }
  const host = options && typeof options === 'object' ? options.host : undefined
  assert.ok(host && local(host), 'synthetic metadata/media cannot dial any other external socket')
  return connect(options, ...args)
}
tls.connect = function (options) {
  assert.ok(fixtureSockets.has(options.socket)); assert.ok(official(options.servername)); assert.equal(options.rejectUnauthorized, true)
  const socket = options.socket
  queueMicrotask(() => socket.emit('secureConnect')); return socket
}
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
  assert.ok(url && ['www.pixiv.net', 'i.pximg.net'].includes(url.hostname), 'only fixed official Pixiv media uses synthetic local responses')
  assert.equal(options.method, 'GET'); assert.equal(options.agent.maxSockets, 1)
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false); assert.equal(options.headers['Accept-Encoding'], 'identity')
  const socket = options.agent.createConnection(); assert.ok(fixtureSockets.has(socket), 'actual native request reuses the socket opened for the validated public IP')
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 }); agent.createConnection = () => socket
  return request(new URL(process.env.PIXIV_RELAY_AUDIT_URL + '/request'), { ...options, agent,
    headers: { ...options.headers, 'x-pixiv-source-url': encodeURIComponent(url.href), 'x-pixiv-pinned': pinned.address,
      'x-pixiv-agent': 'owned-pinned-socket', 'x-pixiv-signal': String(!!options.signal) } }, callback)
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('Unexpected external fetch denied by Pixiv CLI fixture')
  return nativeFetch(input, init)
}
syncBuiltinESMExports()
