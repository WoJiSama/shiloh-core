// Synthetic official sockets and thumbnail process only. The built provider keeps
// its production URL, all-public DNS, numeric pin, streaming and cancellation checks.
// This does not establish real TLS, ffmpeg decoding, QQ appearance or public reachability.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '93.184.216.34', family: 4 }, lookup = dns.lookup, localRequest = http.request
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => ['passport.bilibili.com', 'api.bilibili.com', 'www.bilibili.com', 'b23.tv', 'cn-quality.bilivideo.com', 'i0.hdslb.com'].includes(host)
dns.lookup = async (host, options) => {
  if (official(host)) { assert.equal(options?.all, true); return [pinned] }
  if (local(host)) return lookup(host, options)
  throw Error('Unexpected Bilibili quality fixture DNS request')
}
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : typeof input === 'string' ? new URL(input) : undefined
  assert.ok(url && official(url.hostname)); assert.equal(url.protocol, 'https:'); assert.equal(options.method, 'GET')
  assert.equal(options.agent, false); assert.equal(options.family, 4); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers['Accept-Encoding'], 'identity')
  let address
  options.lookup(url.hostname, {}, (error, value, family) => { assert.equal(error, null); address = { address: value, family } }); assert.deepEqual(address, pinned)
  return localRequest(new URL(process.env.BILIBILI_QUALITY_AUDIT_URL), { ...options, family: 4, lookup: undefined, servername: undefined,
    headers: { ...options.headers, 'x-bilibili-source-url': encodeURIComponent(url.href), 'x-bilibili-pinned': pinned.address } }, callback)
}
const execFile = childProcess.execFile
childProcess.execFile = function (file, args, options, callback) {
  if (file !== 'ffmpeg') return execFile.call(this, file, args, options, callback)
  const child = new EventEmitter()
  void Promise.resolve().then(async () => {
    assert.equal(options.signal.aborted, false); assert.equal(options.timeout, 30000); assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe'); assert.equal(args[args.indexOf('-f') + 1], 'mov')
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
  if (!local(url.hostname)) throw Error('Unexpected external Bilibili quality fixture fetch request')
  return fetch(input, init)
}
syncBuiltinESMExports()
