// Synthetic CLI acceptance only: the actual metadata runner still prepares its
// fixed arguments, private auth files and bounded proxy. Only native results and
// fixed official media sockets use local audit responses; TLS is synthetic here.
// Dedicated network tests own real TLS/CONNECT proof. No public network runs.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { readFile, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'

const pinned = { address: '93.184.216.34', family: 4 }
const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => ['www.youtube.com', 'i.ytimg.com', 'rr1---sn-test.googlevideo.com'].includes(host)
const lookup = dns.lookup, request = http.request, nativeFetch = globalThis.fetch
const connect = net.connect, fixtureSockets = new WeakSet()
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw Error('Unexpected external DNS denied by YouTube CLI fixture')
}
net.connect = function (options, ...args) {
  if (options && typeof options === 'object' && options.host === pinned.address) {
    assert.equal(options.port, 443); assert.equal(options.family, pinned.family)
    const audit = new URL(process.env.YOUTUBE_RELAY_AUDIT_URL)
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
  assert.ok(url && ['i.ytimg.com', 'rr1---sn-test.googlevideo.com'].includes(url.hostname), 'only fixed official YouTube media uses synthetic local responses')
  assert.equal(options.method, 'GET'); assert.equal(options.agent.maxSockets, 1)
  assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false); assert.equal(options.headers['Accept-Encoding'], 'identity')
  const socket = options.agent.createConnection(); assert.ok(fixtureSockets.has(socket), 'actual native request reuses the socket opened for the validated public IP')
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 }); agent.createConnection = () => socket
  return request(new URL(process.env.YOUTUBE_RELAY_AUDIT_URL + '/request'), { ...options, agent,
    headers: { ...options.headers, 'x-youtube-source-url': encodeURIComponent(url.href), 'x-youtube-pinned': pinned.address,
      'x-youtube-agent': 'owned-pinned-socket', 'x-youtube-signal': String(!!options.signal) } }, callback)
}
childProcess.execFile = function (file, args, options, callback) {
  assert.ok(['yt-dlp', 'ffmpeg'].includes(file), 'only metadata extraction or a local thumbnail is allowed')
  const child = new EventEmitter()
  void Promise.resolve().then(async () => {
    assert.equal(options.signal.aborted, false); assert.equal(options.killSignal, 'SIGKILL')
    assert.ok(options.timeout > 0 && options.timeout <= 30000)
    if (file === 'yt-dlp') {
      assert.ok(args.includes('--skip-download')); assert.ok(args.includes('--no-playlist'))
      assert.ok(args.includes('--ignore-config')); assert.ok(args.includes('--no-cache-dir'))
      assert.ok(args.includes('--dump-single-json') || args.includes('--dump-json'))
      assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      const proxy = args[args.indexOf('--proxy') + 1]; assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/u)
      assert.equal((await nativeFetch(proxy)).status, 405, 'the actual job-owned metadata proxy is listening')
      for (const value of [process.env.YOUTUBE_COOKIE, process.env.YOUTUBE_PO_TOKEN, process.env.YOUTUBE_MODEL_KEY, process.env.YOUTUBE_QQ_TOKEN]) {
        assert.equal(JSON.stringify(args).includes(value), false, 'secrets never enter native argv')
        assert.equal(JSON.stringify(options.env ?? {}).includes(value), false, 'unrelated host credentials never enter the native child environment')
      }
      const authFiles = []
      for (const flag of ['--cookies', '--config-locations']) if (args.includes(flag)) {
        const file = args[args.indexOf(flag) + 1], mode = (await stat(file)).mode & 0o777, content = await readFile(file, 'utf8')
        assert.equal(mode, 0o600); authFiles.push(file)
        if (flag === '--cookies') { assert.ok(content.startsWith('# Netscape HTTP Cookie File')); assert.ok(content.includes('youtube-cli-cookie-private-value')) }
        else assert.ok(content.includes(process.env.YOUTUBE_PO_TOKEN))
      }
      assert.equal(authFiles.length, 2, 'cookie and PO token use separate private files')
      const response = await nativeFetch(process.env.YOUTUBE_RELAY_AUDIT_URL + '/metadata', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'metadata', synthetic: true, authFiles, proxy }) })
      assert.equal(response.status, 200); const stdout = await response.text(); callback(null, stdout, ''); setImmediate(() => child.emit('close', 0)); return
    }
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
    const input = args[args.indexOf('-i') + 1], output = args.at(-1)
    assert.equal((await readFile(input)).subarray(4, 8).toString(), 'ftyp')
    await writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]))
    const response = await nativeFetch(process.env.YOUTUBE_RELAY_AUDIT_URL + '/native', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'thumbnail', synthetic: true }) })
    assert.equal(response.status, 200); callback(null, '', ''); setImmediate(() => child.emit('close', 0))
  }).catch(error => { callback(error, '', ''); setImmediate(() => child.emit('close', 1)) })
  return child
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('Unexpected external fetch denied by YouTube CLI fixture')
  return nativeFetch(input, init)
}
syncBuiltinESMExports()
