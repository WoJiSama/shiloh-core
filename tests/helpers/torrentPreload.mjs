// Synthetic CLI acceptance seam only: fixed public metadata sockets go to a
// local audit server, aria2 writes a known payload, and ZIP remains the real
// system command. No tracker, peer or DHT traffic is opened by this fixture.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

const local = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)
const official = host => ['itorrents.net', 'torrage.info'].includes(host)
const pinned = { address: '93.184.216.34', family: 4 }, lookup = dns.lookup, request = http.request, nativeFetch = globalThis.fetch
dns.lookup = async (hostname, options) => {
  if (official(hostname)) return options?.all ? [pinned] : pinned
  if (local(hostname)) return lookup(hostname, options)
  throw Error('Unexpected external DNS denied by torrent fixture')
}
https.request = function (input, options, callback) {
  const url = input instanceof URL ? input : new URL(input)
  assert.ok(official(url.hostname)); assert.equal(options.agent, false); assert.equal(options.family, 4)
  assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.equal(options.headers.Accept, 'application/x-bittorrent')
  let selected
  options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); selected = { address, family } })
  assert.deepEqual(selected, pinned)
  return request(new URL(process.env.TORRENT_CLI_AUDIT_URL + '/metadata'), { ...options, family: 4, lookup: undefined, servername: undefined,
    headers: { ...options.headers, 'x-torrent-source-url': encodeURIComponent(url.href), 'x-torrent-pinned': selected.address } }, callback)
}
const audit = async value => {
  const response = await nativeFetch(process.env.TORRENT_CLI_AUDIT_URL + '/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal(response.status, 200)
}
const spawn = childProcess.spawn
childProcess.spawn = function (command, args, options) {
  if (command !== 'aria2c') {
    assert.equal(command, 'zip', 'only real ZIP may execute in torrent CLI fixture')
    void audit({ command: 'zip', synthetic: false, args }).catch(() => {})
    return spawn.call(this, command, args, options)
  }
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  let done = false
  const close = code => { if (done) return; done = true; child.emit('close', code) }
  child.kill = () => { close(null); return true }
  void Promise.resolve().then(async () => {
    assert.equal(options.shell, false); assert.equal(args.includes('--bt-metadata-only=false'), true, 'fixed metadata cache must succeed before synthetic payload')
    for (const required of ['--no-conf=true', '--daemon=false', '--enable-rpc=false', '--seed-time=0', '--seed-ratio=0', '--check-integrity=true', '--allow-overwrite=false']) assert.ok(args.includes(required))
    const directory = args.find(value => value.startsWith('--dir=')).slice(6)
    assert.equal(directory, options.cwd)
    const indexes = args.filter(value => value.startsWith('--index-out=')); assert.deepEqual(indexes, ['--index-out=1=./cli-payload.txt'])
    const source = await readFile(args.at(-1)); assert.equal(source.subarray(0, 7).toString(), 'd4:info')
    const payload = Buffer.from(process.env.TORRENT_CLI_PAYLOAD_BASE64, 'base64')
    if (done) return
    await writeFile(path.join(directory, 'cli-payload.txt'), payload, { flag: 'wx', mode: 0o600 })
    await audit({ command: 'aria2c', synthetic: true, bytes: payload.length, args })
    if (!done) close(0)
  }).catch(error => { if (!done) { child.emit('error', error); close(1) } })
  return child
}
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) throw Error('Unexpected external fetch denied by torrent fixture')
  return nativeFetch(input, init)
}
syncBuiltinESMExports()
