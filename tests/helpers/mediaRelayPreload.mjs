// Synthetic CLI acceptance only. Production still validates official hosts,
// public DNS pinning, streams and cancellation; these official sockets go to
// a local audit server. The thumbnail process is a synthetic JPEG fixture.
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
const official = host => host === 'api.bilibili.com' || host === 'b23.tv' || host.endsWith('.bilivideo.com') || host.endsWith('.hdslb.com')
const lookup = dns.lookup
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw new Error('unexpected DNS lookup denied by media relay fixture')
}
const request = http.request
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
  assert.ok(url && official(url.hostname), 'only fixed official Bilibili requests use synthetic HTTPS')
  assert.equal(options.agent, false); assert.equal(options.family, pinned.family)
  assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.headers['Accept-Encoding'], 'identity')
  let selected
  options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); selected = { address, family } })
  assert.deepEqual(selected, pinned)
  return request(new URL(process.env.MEDIA_RELAY_AUDIT_URL), { ...options, family: 4, lookup: undefined, servername: undefined,
    headers: { ...options.headers, 'x-media-source-url': encodeURIComponent(url.href), 'x-media-pinned': selected.address,
      'x-media-signal': String(!!options.signal), 'x-media-agent': String(options.agent) } }, callback)
}
const execFile = childProcess.execFile
childProcess.execFile = function (file, args, options, callback) {
  if (file !== 'ffmpeg') return execFile.call(this, file, args, options, callback)
  const child = new EventEmitter()
  void Promise.resolve().then(async () => {
    assert.equal(options.signal.aborted, false)
    assert.equal(options.timeout, 30_000); assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
    assert.equal(args[args.indexOf('-f') + 1], 'mov')
    const input = args[args.indexOf('-i') + 1], output = args.at(-1)
    assert.equal((await readFile(input)).subarray(4, 8).toString(), 'ftyp')
    await writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
    callback(null, '', '')
  }).catch(error => callback(error, '', ''))
  return child
}
const fetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw new Error('unexpected external fetch denied by media relay fixture')
  return fetch(input, init)
}
syncBuiltinESMExports()
