import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { openStandaloneTorrent, readStandaloneTorrentConfig } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneTorrent.js')).href)
const account = { platform: 'qq', namespace: 'global', id: '123456001' }, connections = [{ id: 'main', account }]
const declaration = { connectionId: 'main', listen: { host: '127.0.0.1', port: 31581 }, advertisedOrigin: 'http://127.0.0.1:31581', allowedPeers: ['127.0.0.1'] }
const enabled = extra => ({ enabled: true, bridges: [structuredClone(declaration)], ...extra })
const rootFor = (directory, instance) => path.join(directory, `.agent-torrent-${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`)
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result }
async function fixture(t, instance = 'torrent-lifecycle') {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-torrent-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const connections = [{ id: 'main', account }, { id: 'alt', account: { ...account, id: '123456002' } }], ports = [await port(), await port()]
  const config = readStandaloneTorrentConfig({ enabled: true, bridges: connections.map((connection, index) => ({ connectionId: connection.id,
    listen: { host: '127.0.0.1', port: ports[index] }, advertisedOrigin: `http://127.0.0.1:${ports[index]}`, allowedPeers: ['127.0.0.1'] })) }, connections)
  return { directory, config, ports, root: rootFor(directory, instance), options: { config, dataDir: directory, instance, secrets: [], isLeaseCurrent: () => true, allowsText: () => true } }
}
function archive() {
  const local = Buffer.alloc(30), directory = Buffer.alloc(46), end = Buffer.alloc(22), name = Buffer.from('a'), data = Buffer.from('abc')
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(0x352441c2, 14); local.writeUInt32LE(3, 18); local.writeUInt32LE(3, 22); local.writeUInt16LE(1, 26)
  directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(0x352441c2, 16); directory.writeUInt32LE(3, 20); directory.writeUInt32LE(3, 24); directory.writeUInt16LE(1, 28)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(47, 12); end.writeUInt32LE(34, 16)
  return { name: 'owned.zip', mime: 'application/zip', base64: Buffer.concat([local, name, data, directory, name, end]).toString('base64') }
}
const scope = () => ({ signal: new AbortController().signal, isCurrent: () => true })

test('torrent declarations are independently opt-in, closed and pure, with the original thirty-minute selection lifetime', () => {
  assert.deepEqual(readStandaloneTorrentConfig(undefined, connections), { enabled: false, autoDetect: true, selectionTtlSeconds: 1800, bridges: [] })
  const config = readStandaloneTorrentConfig(enabled({ autoDetect: false, selectionTtlSeconds: 60, proxyUrl: 'http://127.0.0.1:7890' }), connections)
  assert.equal(config.autoDetect, false); assert.equal(config.selectionTtlSeconds, 60); assert.equal(config.proxyUrl, 'http://127.0.0.1:7890/')
  for (const item of [config, config.bridges, config.bridges[0], config.bridges[0].listen, config.bridges[0].allowedPeers]) assert.ok(Object.isFrozen(item))
  let touched = false
  assert.throws(() => readStandaloneTorrentConfig({ enabled: false, get proxyUrl() { touched = true; return 'http://127.0.0.1:7890' } }, connections)); assert.equal(touched, false)
  for (const input of [null, [], {}, { enabled: 1 }, enabled({ ignored: true }), enabled({ aria2Binary: '/tmp/evil' }), enabled({ zipBinary: '/tmp/evil' }),
    enabled({ metadataHttpSources: ['http://127.0.0.1'] }), enabled({ downloadDir: '/tmp/public' }), enabled({ selectionTtlSeconds: 59 }), enabled({ selectionTtlSeconds: 1801 }),
    enabled({ selectionTtlSeconds: '1800' }), enabled({ proxyUrl: 'file:///etc/passwd' }), enabled({ proxyUrl: 'http://127.0.0.1:7890/path' }), enabled({ proxyUrl: 'http://127.0.0.1:7890/?secret=1' }),
    enabled({ bridges: [] }), enabled({ bridges: [declaration, declaration] }), enabled({ bridges: [{ ...declaration, listen: { host: 'localhost', port: 31581 } }] }),
    enabled({ bridges: [{ ...declaration, listen: { host: '127.0.0.1', port: 0 } }] }), enabled({ bridges: [{ ...declaration, allowedPeers: ['napcat.local'] }] }),
    enabled({ bridges: [{ ...declaration, advertisedOrigin: 'http://8.8.8.8' }] })]) assert.throws(() => readStandaloneTorrentConfig(input, connections))
  assert.throws(() => readStandaloneTorrentConfig(enabled(), [{ id: 'main', account: { ...account, platform: 'wx' } }]))
})

test('a leased instance opens one Core provider and independent ZIP-only listeners without starting native P2P', async t => {
  const f = await fixture(t), host = await openStandaloneTorrent(f.options); t.after(() => host.close())
  assert.equal(typeof host.provider.prepare, 'function'); assert.ok(host.bridgeFor('main')); assert.ok(host.bridgeFor('alt')); assert.notEqual(host.bridgeFor('main'), host.bridgeFor('alt')); assert.equal(host.bridgeFor('missing'), undefined)
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700)
  const runs = (await readdir(f.root)).filter(name => /^run-/u.test(name)); assert.equal(runs.length, 1)
  const run = path.join(f.root, runs[0]), children = await readdir(run)
  assert.equal(children.filter(name => name.startsWith('bridge-')).length, 2); assert.ok(children.includes('provider')); assert.equal((await lstat(path.join(run, 'provider'))).mode & 0o777, 0o700)
  const staged = await host.bridgeFor('main').stage(archive(), scope()), response = await fetch(staged.nativeUrl)
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(archive().base64, 'base64'))
  assert.equal((await fetch(staged.nativeUrl.replace(`:${f.ports[0]}/`, `:${f.ports[1]}/`))).status, 404)
  await staged.release(); const closing = host.close(); assert.equal(host.close(), closing); await closing
  assert.deepEqual(await readdir(f.root), ['.owner.json']); assert.equal(host.bridgeFor('main'), undefined)
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('only exactly marked stale runs belonging to this instance are reclaimed', async t => {
  const f = await fixture(t), initial = await openStandaloneTorrent(f.options); await initial.close()
  const staleName = `run-${'a'.repeat(32)}`, stale = path.join(f.root, staleName)
  await mkdir(stale, { mode: 0o700 }); await writeFile(path.join(stale, '.owner.json'), JSON.stringify({ version: 1, instance: f.options.instance, run: staleName }), { mode: 0o600 }); await writeFile(path.join(stale, 'owned-residue'), 'old bytes')
  const foreignName = `run-${'b'.repeat(32)}`, foreign = path.join(f.root, foreignName)
  await mkdir(foreign, { mode: 0o700 }); await writeFile(path.join(foreign, '.owner.json'), JSON.stringify({ version: 1, instance: 'other-instance', run: foreignName }), { mode: 0o600 }); await writeFile(path.join(foreign, 'preserved'), 'foreign')
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'preserved'), 'outside')
  const link = path.join(f.root, `run-${'c'.repeat(32)}`); await symlink(outside, link); await writeFile(path.join(f.root, 'unrelated.txt'), 'unrelated')
  const second = await openStandaloneTorrent(f.options); t.after(() => second.close())
  await assert.rejects(lstat(stale), { code: 'ENOENT' }); assert.equal(await readFile(path.join(foreign, 'preserved'), 'utf8'), 'foreign'); assert.equal(await readFile(path.join(outside, 'preserved'), 'utf8'), 'outside'); assert.ok((await lstat(link)).isSymbolicLink()); assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'unrelated')
})

test('lease loss blocks provider and ZIP stages and leaves marked leftovers for the next owner', async t => {
  const f = await fixture(t); let leased = true
  const options = { ...f.options, isLeaseCurrent: () => leased }, host = await openStandaloneTorrent(options), bridge = host.bridgeFor('main'); t.after(() => host.close())
  const staged = await bridge.stage(archive(), scope()); leased = false
  await assert.rejects(host.provider.prepare('magnet:?xt=urn:btih:' + 'A'.repeat(40), undefined, scope()))
  await assert.rejects(bridge.stage(archive(), scope()))
  assert.equal((await fetch(staged.nativeUrl)).status, 404); await host.close()
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('run-')).length, 1)
  leased = true; const next = await openStandaloneTorrent(options); await next.close(); assert.deepEqual(await readdir(f.root), ['.owner.json'])
})

test('an absent lease, unmarked root, permissive root or symlink never opens listeners or removes foreign files', async t => {
  const f = await fixture(t)
  await assert.rejects(openStandaloneTorrent({ ...f.options, isLeaseCurrent: () => false })); await assert.rejects(lstat(f.root), { code: 'ENOENT' })
  await mkdir(f.root, { mode: 0o700 }); await writeFile(path.join(f.root, 'preserved'), 'foreign'); await assert.rejects(openStandaloneTorrent(f.options)); assert.equal(await readFile(path.join(f.root, 'preserved'), 'utf8'), 'foreign')
  await writeFile(path.join(f.root, '.owner.json'), JSON.stringify({ version: 1, instance: f.options.instance }), { mode: 0o600 }); await chmod(f.root, 0o755); await assert.rejects(openStandaloneTorrent(f.options))
  await rm(f.root, { recursive: true }); const outside = path.join(f.directory, 'other'); await mkdir(outside); await writeFile(path.join(outside, 'preserved'), 'outside'); await symlink(outside, f.root)
  await assert.rejects(openStandaloneTorrent(f.options)); assert.equal(await readFile(path.join(outside, 'preserved'), 'utf8'), 'outside')
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('a partially occupied listener configuration closes the listeners already started and cleans this run', async t => {
  const f = await fixture(t), occupied = createServer(); occupied.listen(f.ports[1], '127.0.0.1'); await once(occupied, 'listening'); t.after(() => new Promise(resolve => occupied.close(resolve)))
  await assert.rejects(openStandaloneTorrent(f.options)); assert.deepEqual(await readdir(f.root), ['.owner.json']); await assert.rejects(fetch(`http://127.0.0.1:${f.ports[0]}/missing`))
})
