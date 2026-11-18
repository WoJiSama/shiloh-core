import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { readStandaloneGroupLogConfig, openStandaloneGroupLog } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneGroupLog.js')).href)
const { readStandaloneAgentConfig } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneAgentConfig.js')).href)
const account = { platform: 'qq', namespace: 'global', id: '19000731' }, connections = [{ id: 'main', account }]
const master = { platform: 'qq', namespace: 'global', id: '330731' }
const declaration = { connectionId: 'main', listen: { host: '127.0.0.1', port: 31731 }, advertisedOrigin: 'http://127.0.0.1:31731', allowedPeers: ['127.0.0.1'] }
const enabled = extra => ({ enabled: true, masters: [master], bridges: [structuredClone(declaration)], ...extra })
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const rootFor = (directory, instance) => path.join(directory, `.agent-group-log-${digest(instance)}`)
const artifact = { name: '团录.txt', mime: 'text/plain', base64: Buffer.from('合成团录完整正文。').toString('base64') }
const scope = () => ({ signal: new AbortController().signal, isCurrent: () => true })
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-group-log-')), instance = 'group-log-lifecycle'
  t.after(() => rm(directory, { recursive: true, force: true }))
  const connections = [{ id: 'main', account }, { id: 'alt', account: { ...account, id: '19000732' } }], ports = [await port(), await port()]
  const config = readStandaloneGroupLogConfig(enabled({ bridges: connections.map((connection, index) => ({ ...declaration,
    connectionId: connection.id, listen: { host: '127.0.0.1', port: ports[index] }, advertisedOrigin: `http://127.0.0.1:${ports[index]}` })) }), connections)
  return { directory, ports, root: rootFor(directory, instance), options: { config, dataDir: directory, instance, isLeaseCurrent: () => true } }
}

test('group-log declarations default off, use only fixed trusted QQ masters and validate disabled declarations without effects', () => {
  assert.deepEqual(readStandaloneGroupLogConfig(undefined, connections), { enabled: false, maxBytes: 8 * 1024 * 1024, masters: [], bridges: [] })
  const input = enabled(), config = readStandaloneGroupLogConfig(input, connections)
  input.masters[0] = { ...master, id: '999999' }; input.bridges[0].allowedPeers[0] = '10.0.0.1'
  assert.deepEqual(config.masters, [master]); assert.deepEqual(config.bridges[0].allowedPeers, ['127.0.0.1'])
  for (const item of [config, config.masters, config.masters[0], config.bridges, config.bridges[0], config.bridges[0].listen, config.bridges[0].allowedPeers]) assert.ok(Object.isFrozen(item))
  for (const maxBytes of [1024 * 1024, 100 * 1024 * 1024]) assert.equal(readStandaloneGroupLogConfig(enabled({ maxBytes }), connections).maxBytes, maxBytes)
  assert.equal(readStandaloneGroupLogConfig({ enabled: false, masters: [master], bridges: [declaration] }, connections).enabled, false)
  assert.deepEqual(readStandaloneGroupLogConfig({ enabled: true, bridges: [declaration] }, connections).masters, [], 'without host masters only verified group roles can manage logs')
  let touched = false
  assert.throws(() => readStandaloneGroupLogConfig({ enabled: false, get masters() { touched = true; return [] } }, connections)); assert.equal(touched, false)
})

test('group-log configuration rejects unknown fields, unbounded bytes, forged master scopes and public or duplicate bridge declarations', () => {
  for (const input of [null, [], {}, { enabled: null }, { enabled: 1 }, enabled({ secret: 'no' }), enabled({ maxBytes: null }),
    enabled({ maxBytes: '8388608' }), enabled({ maxBytes: 1024 * 1024 - 1 }), enabled({ maxBytes: 100 * 1024 * 1024 + 1 }),
    enabled({ maxBytes: 1024 * 1024 + 0.5 }), enabled({ masters: null }), enabled({ masters: [master, master] }),
    enabled({ masters: [{ ...master, namespace: 'onebot' }] }), enabled({ masters: [{ ...master, platform: 'wx' }] }),
    enabled({ masters: [{ ...master, id: '0330731' }] }), enabled({ masters: [{ ...master, id: 330731 }] }),
    enabled({ masters: [{ ...master, role: 'owner' }] }), enabled({ masters: Array.from({ length: 65 }, (_, i) => ({ ...master, id: String(330731 + i) })) }),
    enabled({ bridges: [] }), enabled({ bridges: null }), enabled({ bridges: [declaration, declaration] }),
    enabled({ bridges: [{ ...declaration, connectionId: 'missing' }] }), enabled({ bridges: [{ ...declaration, allowedPeers: [] }] }),
    enabled({ bridges: [{ ...declaration, allowedPeers: ['8.8.8.8'] }] }), enabled({ bridges: [{ ...declaration, allowedPeers: ['napcat.local'] }] }),
    enabled({ bridges: [{ ...declaration, listen: { host: '0.0.0.0', port: 31731 } }] }), enabled({ bridges: [{ ...declaration, listen: { host: '8.8.8.8', port: 31731 } }] }),
    enabled({ bridges: [{ ...declaration, advertisedOrigin: 'https://public.example' }] }), enabled({ bridges: [{ ...declaration, advertisedOrigin: 'https://8.8.8.8' }] }),
    enabled({ bridges: [{ ...declaration, advertisedOrigin: 'http://user:pass@127.0.0.1:31731' }] }),
    { enabled: false, masters: [{ ...master, namespace: 'forged' }] }, { enabled: false, bridges: [{ ...declaration, listen: { host: '127.0.0.1', port: 0 } }] }]) {
    assert.throws(() => readStandaloneGroupLogConfig(input, connections), undefined, JSON.stringify(input))
  }
  assert.throws(() => readStandaloneGroupLogConfig(enabled(), [{ id: 'main', account: { ...account, platform: 'wx' } }]))
  const both = [...connections, { id: 'alt', account: { ...account, id: '19000732' } }]
  assert.throws(() => readStandaloneGroupLogConfig(enabled({ bridges: [declaration, { ...declaration, connectionId: 'alt', listen: { host: '127.0.0.2', port: 31731 } }] }), both), 'different addresses cannot reuse a group-log port')
})

test('standalone host parses group-log settings read-only and rejects active media, torrent and group-log port collisions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'group-log-host-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '310731', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), raw = { version: 1, instance: 'group-log-config', dataDir: 'owned-data',
    model: { baseUrl: 'https://model.example/v1', name: 'fixture', apiKeyEnv: 'GROUP_LOG_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], groupLog: enabled() }
  const read = async extra => { await writeFile(file, JSON.stringify({ ...raw, ...extra })); return readStandaloneAgentConfig(file, { GROUP_LOG_MODEL_KEY: 'host-private-key' }) }
  const config = await read({})
  assert.deepEqual(config.groupLog.masters, [master]); assert.equal(config.groupLog.enabled, true); assert.equal(config.isConfigCurrent(), true)
  for (const name of ['mediaRelay', 'torrentDownload']) await assert.rejects(read({ [name]: { enabled: true, bridges: [declaration] } }), /独立监听端口/u)
  assert.equal((await read({ mediaRelay: { enabled: false, bridges: [declaration] } })).groupLog.enabled, true)
  await writeFile(file, JSON.stringify({ ...raw, groupLog: { enabled: false } }))
  assert.equal(config.isConfigCurrent(), false)
  await assert.rejects(lstat(path.join(directory, 'owned-data')), { code: 'ENOENT' }, 'reading configuration never creates journal, group-log storage or listeners')
})

test('a leased standalone group-log host stages independent per-connection files and releases all listeners and private runs on close', async t => {
  const f = await fixture(t), host = await openStandaloneGroupLog(f.options); t.after(() => host.close())
  const first = host.bridgeFor('main'), second = host.bridgeFor('alt')
  assert.ok(first); assert.ok(second); assert.notEqual(first, second); assert.equal(host.bridgeFor('missing'), undefined)
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700)
  const runs = (await readdir(f.root)).filter(name => /^run-/u.test(name)); assert.equal(runs.length, 1)
  const children = await readdir(path.join(f.root, runs[0])); assert.equal(children.filter(name => /^bridge-/u.test(name)).length, 2)
  const resource = await first.stage(artifact, scope()), response = await fetch(resource.nativeUrl)
  assert.equal(response.status, 200); assert.equal(await response.text(), Buffer.from(artifact.base64, 'base64').toString())
  assert.equal((await fetch(resource.nativeUrl.replace(`:${f.ports[0]}/`, `:${f.ports[1]}/`))).status, 404)
  await resource.release()
  const closing = host.close(); assert.equal(host.close(), closing); await closing
  assert.deepEqual(await readdir(f.root), ['.owner.json']); assert.equal(host.bridgeFor('main'), undefined)
  for (const port of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/missing`))
})

test('partial bridge startup failure closes every listener already opened and leaves only the marked root', async t => {
  const f = await fixture(t), occupied = createServer(); occupied.listen(f.ports[1], '127.0.0.1'); await once(occupied, 'listening')
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  await assert.rejects(openStandaloneGroupLog(f.options))
  assert.deepEqual(await readdir(f.root), ['.owner.json']); await assert.rejects(fetch(`http://127.0.0.1:${f.ports[0]}/missing`))
})

test('normal close cancels a pending authorization without converting the cancelled stage into a cleanup failure', async t => {
  const f = await fixture(t), host = await openStandaloneGroupLog(f.options)
  let entered
  const reached = new Promise(resolve => { entered = resolve })
  const staging = host.bridgeFor('main').stage(artifact, { ...scope(), ensureCurrent() { entered(); return new Promise(() => {}) } })
  const cancelled = assert.rejects(staging)
  await reached; await host.close(); await cancelled
  assert.deepEqual(await readdir(f.root), ['.owner.json'])
})

test('lease loss revokes staged files and next authorized startup reclaims only exact marked runs while preserving foreign data', async t => {
  const f = await fixture(t); let leased = true
  const options = { ...f.options, isLeaseCurrent: () => leased }, host = await openStandaloneGroupLog(options); t.after(() => host.close())
  const bridge = host.bridgeFor('main'), resource = await bridge.stage(artifact, scope()); leased = false
  await assert.rejects(bridge.stage(artifact, scope())); assert.equal((await fetch(resource.nativeUrl)).status, 404)
  await host.close(); assert.equal((await readdir(f.root)).filter(name => name.startsWith('run-')).length, 1)
  const foreign = path.join(f.root, `run-${'b'.repeat(32)}`); await mkdir(foreign, { mode: 0o700 })
  await writeFile(path.join(foreign, '.owner.json'), JSON.stringify({ version: 1, instance: 'other-instance', run: path.basename(foreign) }), { mode: 0o600 })
  await writeFile(path.join(foreign, 'preserved'), 'foreign bytes')
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'preserved'), 'outside bytes')
  await symlink(outside, path.join(f.root, `run-${'c'.repeat(32)}`))
  leased = true; const next = await openStandaloneGroupLog(options); await next.close()
  assert.equal(await readFile(path.join(foreign, 'preserved'), 'utf8'), 'foreign bytes'); assert.equal(await readFile(path.join(outside, 'preserved'), 'utf8'), 'outside bytes')
  assert.equal((await readdir(f.root)).filter(name => name.startsWith('run-')).length, 2, 'only foreign and symlink runs remain')
})

test('missing lease or foreign root never opens a group-log listener or removes unrelated files', async t => {
  const f = await fixture(t)
  await assert.rejects(openStandaloneGroupLog({ ...f.options, isLeaseCurrent: () => false })); await assert.rejects(lstat(f.root), { code: 'ENOENT' })
  await mkdir(f.root, { mode: 0o700 }); await writeFile(path.join(f.root, 'preserved'), 'foreign')
  await assert.rejects(openStandaloneGroupLog(f.options)); assert.equal(await readFile(path.join(f.root, 'preserved'), 'utf8'), 'foreign')
  for (const port of f.ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/missing`))
})
