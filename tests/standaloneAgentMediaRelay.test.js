import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { openStandaloneMediaRelay, readStandaloneMediaRelayConfig } = await importBilibiliHost('bootstrap/standaloneMediaRelay.js')
const account = { platform: 'qq', namespace: 'global', id: '123456001' }
const rootFor = (directory, instance) => path.join(directory, `.agent-media-relay-${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`)
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function fixture(t, instance = 'media-lifecycle') {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-media-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const connections = [{ id: 'main', account }, { id: 'alt', account: { ...account, id: '123456002' } }]
  const ports = [await port(), await port()]
  const config = readStandaloneMediaRelayConfig({ enabled: true, bridges: connections.map((connection, i) => ({ connectionId: connection.id,
    listen: { host: '127.0.0.1', port: ports[i] }, advertisedOrigin: `http://127.0.0.1:${ports[i]}`, allowedPeers: ['127.0.0.1'] })) }, connections, {})
  const options = { config, dataDir: directory, instance, secrets: [], isLeaseCurrent: () => true, allowsText: () => true }
  return { directory, config, options, root: rootFor(directory, instance), ports }
}

test('one leased host shares one artifact store/provider and opens an independent private bridge per connection', async t => {
  const f = await fixture(t), host = await openStandaloneMediaRelay(f.options)
  t.after(() => host.close())
  assert.equal(typeof host.provider.prepare, 'function')
  assert.ok(host.bridgeFor('main')); assert.ok(host.bridgeFor('alt'))
  assert.notEqual(host.bridgeFor('main'), host.bridgeFor('alt'))
  assert.equal(host.bridgeFor('missing'), undefined)
  assert.equal((await lstat(f.root)).mode & 0o077, 0)
  const runs = (await readdir(f.root)).filter(name => name.startsWith('run-'))
  assert.equal(runs.length, 1)
  const run = path.join(f.root, runs[0]), children = await readdir(run)
  assert.equal(children.filter(name => name.startsWith('agent-media-')).length, 1)
  assert.equal(children.filter(name => name.startsWith('bridge-')).length, 2)
  assert.ok(children.includes('provider'))
  for (const selected of f.ports) assert.equal((await fetch(`http://127.0.0.1:${selected}/missing`)).status, 404)
  const closing = host.close(); assert.equal(host.close(), closing); await closing
  assert.deepEqual(await readdir(f.root), ['.owner.json'])
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('Pixiv tools own a separate preparation provider and bridge while all automatic providers remain disabled', async t => {
  const f = await fixture(t), host = await openStandaloneMediaRelay({ ...f.options,
    config: { ...f.config, enabled: false, pixiv: { enabled: true, allowRestricted: true }, douyin: { enabled: true } },
    pixivTools: { enabled: true, allowRestricted: false },
  })
  t.after(() => host.close())
  assert.equal(typeof host.pixivToolProvider?.prepare, 'function')
  assert.ok(host.bridgeFor('main')); assert.ok(host.bridgeFor('alt'))
  const context = { signal: new AbortController().signal, isCurrent: () => true }
  for (const share of [{ provider: 'bilibili', reference: { kind: 'bv', id: 'BV1H7Gq6zEiC' } },
    { provider: 'pixiv', reference: { kind: 'artwork', id: '123456789' } },
    { provider: 'douyin', reference: { kind: 'video', id: '7482233445566778899' } }]) {
    await assert.rejects(host.provider.prepare(share, context))
  }
  const run = (await readdir(f.root)).find(name => name.startsWith('run-')), children = await readdir(path.join(f.root, run))
  assert.ok(children.includes('pixiv-tools-provider'))
  assert.equal(children.includes('pixiv-provider'), false); assert.equal(children.includes('douyin-provider'), false)
  const cancel = new AbortController(); cancel.abort()
  await assert.rejects(host.pixivToolProvider.prepare({ provider: 'pixiv', reference: { kind: 'artwork', id: '123456789' } },
    { ...context, signal: cancel.signal }))
  await host.close(); assert.deepEqual(await readdir(f.root), ['.owner.json'])
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('video search attachments alone open an anonymous provider and shared bridges without enabling automatic or HQ providers', async t => {
  const f = await fixture(t), events = [], host = await openStandaloneMediaRelay({ ...f.options, videoSearchAttachments: true,
    config: { ...f.config, enabled: false, bilibili: { authCookie: 'UNUSED_AUTOMATIC_COOKIE', autoAuthorizedRetry: true } },
    diagnostics: { emit: event => events.push(event) },
  })
  t.after(() => host.close())
  assert.equal(typeof host.videoSearchAttachmentProvider?.prepare, 'function'); assert.equal(host.pixivToolProvider, undefined)
  assert.equal(host.qualityProviderFor({}), undefined); assert.ok(host.bridgeFor('main')); assert.ok(host.bridgeFor('alt'))
  const cancel = new AbortController(); cancel.abort()
  const share = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1H7Gq6zEiC' } }
  await assert.rejects(host.provider.prepare(share, { signal: cancel.signal, isCurrent: () => true }))
  await assert.rejects(host.videoSearchAttachmentProvider.prepare(share, { signal: cancel.signal, isCurrent: () => true }))
  const run = (await readdir(f.root)).find(name => name.startsWith('run-')), children = await readdir(path.join(f.root, run))
  assert.ok(children.includes('video-search-attachment-provider')); assert.equal(children.includes('bilibili-quality-provider'), false)
  await host.close(); assert.deepEqual(await readdir(f.root), ['.owner.json'])
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('HQ-only host opens shared artifacts and bridges while resolving each request from its owned binding and live authorization', async t => {
  const f = await fixture(t), credentials = [], authService = { async credential(binding, context) {
    assert.equal(context.isCurrent(), true); credentials.push(binding); return undefined
  } }
  let current = true
  const host = await openStandaloneMediaRelay({ ...f.options, config: { ...f.config, enabled: false, bilibili: { authCookie: 'AUTOMATIC_COOKIE_MUST_NOT_BE_USED', autoAuthorizedRetry: true } },
    bilibiliQuality: { enabled: true, authService }, isLeaseCurrent: () => current })
  t.after(() => { current = true; return host.close() })
  assert.ok(host.bridgeFor('main')); assert.ok(host.bridgeFor('alt')); assert.equal(host.pixivToolProvider, undefined)
  const snapshot = { source: 'configured', id: 'one', revision: 'revision-one', agentId: 'daily', personaId: 'default', connectionId: 'main', target: { account: { ...account }, kind: 'group', id: '90001' } }
  const first = host.qualityProviderFor(snapshot), second = host.qualityProviderFor({ ...snapshot, agentId: 'another' })
  snapshot.target.account.id = 'changed'; snapshot.agentId = 'changed'
  const context = { signal: new AbortController().signal, isCurrent: () => true }, share = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1H7Gq6zEiC' } }
  await assert.rejects(first.prepare({ quality: 80, share }, context)); await assert.rejects(second.prepare({ quality: 64, share }, context))
  assert.deepEqual(credentials.map(binding => [binding.target.account.id, binding.agentId]), [[account.id, 'daily'], [account.id, 'another']])
  assert.notEqual(credentials[0], snapshot); await assert.rejects(host.provider.prepare(share, context))
  const run = (await readdir(f.root)).find(name => name.startsWith('run-')), children = await readdir(path.join(f.root, run))
  assert.ok(children.includes('bilibili-quality-provider')); assert.equal(children.filter(name => name.startsWith('agent-media-')).length, 1)
  current = false; assert.throws(() => host.qualityProviderFor(snapshot)); await assert.rejects(first.prepare({ quality: 80, share }, context)); assert.equal(credentials.length, 2)
  current = true; await host.close(); assert.throws(() => host.qualityProviderFor(snapshot)); assert.deepEqual(await readdir(f.root), ['.owner.json'])
})

test('an automatic host exposes no HQ provider unless explicitly enabled', async t => {
  const f = await fixture(t), host = await openStandaloneMediaRelay(f.options); t.after(() => host.close())
  assert.equal(host.qualityProviderFor({}), undefined)
})

for (const provider of ['douyin', 'xiaohongshu']) test(`host dispatch refuses disabled ${provider} and creates its isolated preparation directory only when opted in`, async t => {
  const share = { provider, reference: provider === 'douyin' ? { kind: 'video', id: '7482233445566778899' } : { kind: 'note', id: '66aabbccddeeff0011223344' } }
  const context = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
  const f = await fixture(t), host = await openStandaloneMediaRelay(f.options)
  try {
    await assert.rejects(host.provider.prepare(share, context))
    const run = (await readdir(f.root)).find(name => name.startsWith('run-'))
    assert.equal((await readdir(path.join(f.root, run))).includes(`${provider}-provider`), false)
  } finally { await host.close() }
  const config = { ...f.config, [provider]: { enabled: true } }, enabled = await openStandaloneMediaRelay({ ...f.options, config })
  try {
    const run = (await readdir(f.root)).find(name => name.startsWith('run-'))
    assert.equal((await lstat(path.join(f.root, run, `${provider}-provider`))).mode & 0o077, 0)
    const cancel = new AbortController(); cancel.abort()
    await assert.rejects(enabled.provider.prepare(share, { ...context, signal: cancel.signal }))
  } finally { await enabled.close() }
  assert.deepEqual(await readdir(f.root), ['.owner.json'])
})

test('only precisely marked old runs for the same instance are removed after acquiring its lease', async t => {
  const f = await fixture(t), first = await openStandaloneMediaRelay(f.options)
  await first.close()
  const staleName = `run-${'a'.repeat(32)}`, stale = path.join(f.root, staleName)
  await mkdir(stale, { mode: 0o700 }); await writeFile(path.join(stale, '.owner.json'), JSON.stringify({ version: 1, instance: f.options.instance, run: staleName }), { mode: 0o600 })
  await writeFile(path.join(stale, 'owned-residue'), 'old bytes')
  const foreign = path.join(f.root, `run-${'b'.repeat(32)}`)
  await mkdir(foreign, { mode: 0o700 }); await writeFile(path.join(foreign, '.owner.json'), JSON.stringify({ version: 1, instance: 'other-instance', run: path.basename(foreign) }))
  await writeFile(path.join(foreign, 'preserved'), 'foreign')
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'preserved'), 'outside')
  const link = path.join(f.root, `run-${'c'.repeat(32)}`); await symlink(outside, link)
  await writeFile(path.join(f.root, 'unrelated.txt'), 'unrelated')
  const second = await openStandaloneMediaRelay(f.options); t.after(() => second.close())
  await assert.rejects(lstat(stale), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(foreign, 'preserved'), 'utf8'), 'foreign')
  assert.equal(await readFile(path.join(outside, 'preserved'), 'utf8'), 'outside')
  assert.equal((await lstat(link)).isSymbolicLink(), true)
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'unrelated')
})

test('missing lease, unowned root, permissive root and symlink roots never start listeners or remove foreign data', async t => {
  const f = await fixture(t)
  await assert.rejects(openStandaloneMediaRelay({ ...f.options, isLeaseCurrent: () => false }))
  await assert.rejects(lstat(f.root), { code: 'ENOENT' })
  await mkdir(f.root, { mode: 0o700 }); await writeFile(path.join(f.root, 'preserved'), 'foreign')
  await assert.rejects(openStandaloneMediaRelay(f.options))
  assert.equal(await readFile(path.join(f.root, 'preserved'), 'utf8'), 'foreign')
  await writeFile(path.join(f.root, '.owner.json'), JSON.stringify({ version: 1, instance: f.options.instance }), { mode: 0o600 })
  await chmod(f.root, 0o755)
  await assert.rejects(openStandaloneMediaRelay(f.options))
  await rm(f.root, { recursive: true }); const outside = path.join(f.directory, 'other'); await mkdir(outside)
  await writeFile(path.join(outside, 'preserved'), 'outside'); await symlink(outside, f.root)
  await assert.rejects(openStandaloneMediaRelay(f.options))
  assert.equal(await readFile(path.join(outside, 'preserved'), 'utf8'), 'outside')
  for (const selected of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${selected}/missing`))
})

test('partial bridge startup failure closes already-open listeners and releases this run', async t => {
  const f = await fixture(t), occupied = createServer()
  occupied.listen(f.ports[1], '127.0.0.1'); await once(occupied, 'listening')
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  await assert.rejects(openStandaloneMediaRelay(f.options))
  assert.deepEqual(await readdir(f.root), ['.owner.json'])
  await assert.rejects(fetch(`http://127.0.0.1:${f.ports[0]}/missing`))
})
