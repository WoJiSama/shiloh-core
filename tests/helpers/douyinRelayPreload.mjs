// Synthetic CLI acceptance only. Real production URL, public DNS, pinning,
// stream and resource checks remain active; fixed official HTTPS sockets are
// redirected to a local audit server. Thumbnail bytes are explicitly synthetic.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '93.184.216.34', family: 4 }
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => ['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com',
  'v3.douyinvod.com', 'p3.douyinpic.com'].includes(host)
const lookup = dns.lookup, request = http.request, nativeFetch = globalThis.fetch
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw Error('Unexpected external DNS denied by Douyin CLI fixture')
}
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
  assert.ok(url && official(url.hostname), 'only fixed official Douyin HTTPS uses local synthetic responses')
  assert.equal(options.agent, false); assert.equal(options.family, pinned.family)
  assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false)
  assert.equal(options.headers['Accept-Encoding'], 'identity')
  let selected
  options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); selected = { address, family } })
  assert.deepEqual(selected, pinned, 'actual native HTTPS lookup pins the validated public DNS address')
  return request(new URL(process.env.DOUYIN_RELAY_AUDIT_URL + '/request'), { ...options, family: 4, lookup: undefined, servername: undefined,
    headers: { ...options.headers, 'x-douyin-source-url': encodeURIComponent(url.href), 'x-douyin-pinned': selected.address,
      'x-douyin-agent': String(options.agent), 'x-douyin-signal': String(!!options.signal) } }, callback)
}
childProcess.execFile = function (file, args, options, callback) {
  assert.equal(file, 'ffmpeg', 'static video/gallery acceptance must not launch a browser or arbitrary native process')
  const child = new EventEmitter()
  void Promise.resolve().then(async () => {
    assert.equal(options.signal.aborted, false); assert.equal(options.killSignal, 'SIGKILL')
    assert.ok(options.timeout > 0 && options.timeout <= 60000)
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
    const input = args[args.indexOf('-i') + 1], output = args.at(-1)
    assert.equal((await readFile(input)).subarray(4, 8).toString(), 'ftyp')
    await writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
    const response = await nativeFetch(process.env.DOUYIN_RELAY_AUDIT_URL + '/native', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'thumbnail', synthetic: true }) })
    assert.equal(response.status, 200); callback(null, '', ''); setImmediate(() => child.emit('close', 0))
  }).catch(error => { callback(error, '', ''); setImmediate(() => child.emit('close', 1)) })
  return child
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('Unexpected external fetch denied by Douyin CLI fixture')
  return nativeFetch(input, init)
}
syncBuiltinESMExports()
