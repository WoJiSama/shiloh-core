import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import YAML from 'yaml'

// The actual source main, Redis and HTTP/WebSocket transports run here. All endpoints
// are local and no incoming QQ message or model generation is requested.
const sourceHelper = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
const sourceEntry = `const { importBilibiliHost: load } = await import(${JSON.stringify(sourceHelper)}); const { main } = await load('bootstrap/standaloneAgent.js'); await main(process.argv.slice(1));`
const MODEL_KEY = 'PERSIST_STARTUP_MODEL_PRIVATE_20261117', SECOND_KEY = 'PERSIST_STARTUP_NEXT_MODEL_PRIVATE_20261117',
  QQ_TOKEN = 'PERSIST_STARTUP_QQ_PRIVATE_20261117', ADMIN_TOKEN = 'PERSIST_STARTUP_ADMIN_PRIVATE_20261117', PASSWORD = 'PERSIST_STARTUP_LOGIN_PRIVATE_20261117'
const BOT = '19001917', GROUP = '310917'
async function waitFor(probe, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await probe()) return; await delay(20) }
  assert.fail(`timed out: ${label}`)
}
async function freePort() {
  const socket = createTcpServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port
}
async function readTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return (await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? readTree(file) : entry.isFile() ? readFile(file, 'utf8') : ''
  }))).join('\n')
}
async function fixture(t, enabled = true, { holdLogin = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'source persistence startup requires real Redis')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-persist-start-'))), dataDir = path.join(root, 'data'), socketPath = path.join(root, 'redis.sock')
  const port = await freePort(), base = `http://127.0.0.1:${port}`, instance = 'persist-startup', prefix = `bl-agent:${instance}:`
  const children = [], peers = new WebSocketServer({ noServer: true }), actions = [], errors = [], responses = [], heldLogins = []
  let child, exited, reader, connected = 0, modelRequests = 0, log = '', cookie = ''
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const upstream = createServer((_request, response) => { modelRequests++; errors.push('unexpected model HTTP'); response.writeHead(500).end('{}') })
  upstream.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { errors.push('unexpected OneBot upgrade'); socket.destroy(); return }
    peers.handleUpgrade(request, socket, head, peer => {
      connected++
      peer.on('message', data => {
        try {
          const request = JSON.parse(String(data)); actions.push(request.action)
          assert.ok(['get_login_info', 'get_group_list', 'get_group_info'].includes(request.action), 'configuration administration must not send native QQ actions')
          const result = request.action === 'get_login_info' ? { user_id: Number(BOT), nickname: '离线持久化验收' } :
            request.action === 'get_group_list' ? [{ group_id: Number(GROUP), group_name: '验收群' }] : { group_id: Number(GROUP), group_name: '验收群' }
          const reply = () => { if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: result })) }
          if (holdLogin && request.action === 'get_login_info') heldLogins.push(reply)
          else reply()
        } catch (error) { errors.push(String(error)) }
      })
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, modelRequests }))
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL')
      await item.exited.catch(() => {})
    }
    for (const peer of peers.clients) peer.terminate()
    await new Promise(resolve => peers.close(resolve))
    upstream.closeAllConnections(); if (upstream.listening) await new Promise(resolve => upstream.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit.catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upstreamPort = upstream.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const frontendDir = path.join(root, 'frontend'); await mkdir(frontendDir); await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><html><body>source persistence fixture</body></html>')
  const configFile = path.join(root, 'agent-host.yaml'), libraryFile = path.join(root, 'persona-library.yaml'), bindingsFile = path.join(root, 'agent-bindings.yaml')
  await writeFile(bindingsFile, '# preserved topology\n' + YAML.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: BOT }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: GROUP, agentId: 'daily' }] }))
  await writeFile(libraryFile, '# preserved library\npersonas:\n  - id: p-one\n    name: Local template\n    identity: original template\n    extensionOwned: retained-template\n    moods:\n      - name: calm\n        hint: quiet reply\n        probability: 0.12\n        extensionOwned: retained-mood\nextensionOwned: retained-library-root\n')
  await writeFile(configFile, '# preserved host\n' + YAML.stringify({ version: 1, instance, dataDir,
    persona: { name: '启动验收人设', identity: '本地合成测试' },
    model: { baseUrl: `http://127.0.0.1:${upstreamPort}/model/v1`, name: 'unused-original-model', apiKeyEnv: 'PERSIST_MODEL_KEY' },
    dice: { enabled: false, maxDiceCount: 100, maxDiceSides: 100000, maxRounds: 20 },
    simulation: { enabled: false, allGroups: false, groups: [], wake: { probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    privateChat: { enabled: false }, history: { enabled: false },
    ...(enabled ? { console: { enabled: true, port, frontendDir, tokenEnv: 'PERSIST_ADMIN_TOKEN', allowSetup: true } } : {}),
    connections: [{ id: 'main', url: `ws://127.0.0.1:${upstreamPort}/onebot`, accessTokenEnv: 'PERSIST_QQ_TOKEN' }],
  }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, PERSIST_MODEL_KEY: MODEL_KEY, PERSIST_SECOND_MODEL_KEY: SECOND_KEY,
    PERSIST_QQ_TOKEN: QQ_TOKEN, PERSIST_ADMIN_TOKEN: ADMIN_TOKEN }
  function launch(check = false) {
    const offset = log.length
    child = spawn(process.execPath, ['--input-type=module', '-e', sourceEntry, '--', '--config', configFile, ...(check ? ['--check'] : [])], { cwd: root, env })
    exited = once(child, 'exit'); children.push({ child, exited })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data })
    return offset
  }
  async function start({ waitForHostReady = true } = {}) {
    const previous = connected, offset = launch()
    cookie = ''
    await waitFor(async () => {
      if (child.exitCode !== null) assert.fail(`source main exited: ${log.slice(offset)}`)
      if (waitForHostReady) return connected > previous && log.slice(offset).includes('[Agent] 已启动')
      if (connected <= previous || heldLogins.length === 0) return false
      return fetch(base + '/api/auth/state', { headers: { 'x-console-token': ADMIN_TOKEN }, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false)
    }, 'source main readiness')
  }
  async function request(route, { method = 'GET', body, token = true, session = false } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(token ? { 'x-console-token': ADMIN_TOKEN } : {}), ...(session ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
    const text = await response.text(); responses.push(text)
    return { status: response.status, response, text, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : null }
  }
  async function login() {
    const state = await request('/api/auth/state'), action = state.data.hasUser ? 'login' : 'setup'
    const result = await request('/api/auth/' + action, { method: 'POST', body: { username: 'admin', password: PASSWORD } })
    assert.equal(result.status, 200, result.text)
    cookie = result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
    assert.ok(cookie)
  }
  async function stop() {
    child.kill('SIGTERM')
    let timeout
    let exit
    try { exit = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`source main did not stop: ${log}`)), 10000) })]) }
    finally { clearTimeout(timeout) }
    assert.deepEqual(exit, [0, null], log)
    assert.equal(await reader.get(`${prefix}agent:host-lease`), null, 'shutdown releases its actual Redis lease')
    assert.equal(modelRequests, 0); assert.deepEqual(errors, [])
  }
  return { root, dataDir, configFile, libraryFile, bindingsFile, base, reader, prefix, start, stop, login, request,
    releaseLogins() { for (const reply of heldLogins.splice(0)) reply() },
    async check() {
      const offset = launch(true); assert.deepEqual(await exited, [0, null], log.slice(offset))
      assert.equal(JSON.parse(log.slice(offset)).mode, 'check')
      assert.deepEqual(await reader.keys('*'), [])
      await assert.rejects(stat(dataDir), { code: 'ENOENT' })
    },
    async clean() {
      const output = log + responses.join('\n') + await readTree(dataDir)
      for (const value of [MODEL_KEY, SECOND_KEY, QQ_TOKEN, ADMIN_TOKEN, PASSWORD]) assert.equal(output.includes(value), false, 'persistent files, logs and HTTP responses exclude private credential values')
      assert.equal(modelRequests, 0); assert.deepEqual(errors, []); assert.ok(actions.every(action => ['get_login_info', 'get_group_list', 'get_group_info'].includes(action)))
    },
  }
}
const fieldValue = (view, key) => view.groups.flatMap(group => group.fields).find(field => field.field === key)?.value

test('source main persists each single-file family and reloads it under a genuinely new process epoch', { timeout: 45000 }, async t => {
  const f = await fixture(t); await f.check(); await f.start(); await f.login()
  const initial = await f.request('/api/config-state', { token: false, session: true })
  assert.equal(initial.status, 200, initial.text); assert.equal(initial.data.phase, 'active'); assert.equal(initial.data.requiresRestart, false)
  const dice = (await f.request('/api/config/dice', { token: false, session: true })).data
  const unchangedBytes = await readFile(f.configFile, 'utf8')
  const noChange = await f.request('/api/config/dice', { method: 'PUT', token: false, session: true, body: { revision: dice.revision, values: { 'dice.maxRounds': 20 } } })
  assert.equal(noChange.status, 200, noChange.text); assert.equal(noChange.data.changed, 0); assert.equal(noChange.data.requiresRestart, false)
  assert.equal(await readFile(f.configFile, 'utf8'), unchangedBytes)
  assert.equal((await f.request('/api/config-state', { token: false, session: true })).data.phase, 'active')
  let previous = initial.data
  const operations = [
    { route: '/api/config/dice', read: '/api/config/dice', body: view => ({ revision: view.revision, values: { 'dice.maxRounds': 27 } }), verify: view => assert.equal(fieldValue(view, 'dice.maxRounds'), 27) },
    { route: '/api/config/persona', read: '/api/config/persona', body: view => ({ revision: view.revision, values: { 'persona.identity': 'saved default identity', 'personaGuard.stripSelfDoubt': false } }), verify: view => { assert.equal(fieldValue(view, 'persona.identity'), 'saved default identity'); assert.equal(fieldValue(view, 'personaGuard.stripSelfDoubt'), false) } },
    { route: '/api/persona/library', read: '/api/persona/library', body: view => ({ revision: view.revision, personas: view.personas.map(persona => ({ ...persona, identity: 'saved template identity' })) }), verify: view => assert.equal(view.personas[0].identity, 'saved template identity') },
    { route: '/api/persona/assignments', read: '/api/persona/assignments', body: view => ({ revision: view.revision, agents: [{ agentId: view.agents[0].agentId, personaId: 'p-one' }] }), verify: view => assert.equal(view.agents[0].personaId, 'p-one') },
    { route: '/api/ai/config', read: '/api/ai/config', body: view => ({ revision: view.revisions.model, configKey: 'model', providers: [{ baseUrl: view.sections.model[0].baseUrl, name: 'unused-saved-model', apiKeyEnv: 'PERSIST_SECOND_MODEL_KEY' }] }), verify: view => { assert.equal(view.sections.model[0].name, 'unused-saved-model'); assert.equal(view.sections.model[0].apiKeyEnv, 'PERSIST_SECOND_MODEL_KEY'); assert.equal(view.sections.model[0].apiKeyConfigured, true) } },
  ]
  for (const operation of operations) {
    const loadedView = await f.request(operation.read, { token: false, session: true })
    assert.equal(loadedView.status, 200, loadedView.text)
    const saved = await f.request(operation.route, { method: 'PUT', body: operation.body(loadedView.data), token: false, session: true })
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.data.requiresRestart, true); assert.ok(saved.data.changed > 0)
    assert.equal(saved.data.processEpoch, previous.processEpoch); operation.verify(saved.data.view)
    const auth = await f.request('/api/auth/state', { token: false, session: true })
    assert.equal(auth.status, 200); assert.equal(auth.data.username, 'admin'); assert.equal(auth.data.via, 'session', 'own configuration commit does not revoke the authenticating session')
    const retired = await f.request('/api/config-state', { token: false, session: true })
    assert.equal(retired.status, 200, retired.text); assert.equal(retired.data.phase, 'restart-required'); assert.equal(retired.data.storedRevision, saved.data.committedRevision)
    assert.equal((await f.request(operation.read, { token: false, session: true })).status, 409)
    await f.stop(); await f.start(); await f.login()
    const fresh = await f.request('/api/config-state', { token: false, session: true })
    assert.equal(fresh.status, 200, fresh.text); assert.equal(fresh.data.phase, 'active'); assert.equal(fresh.data.requiresRestart, false)
    assert.notEqual(fresh.data.processEpoch, previous.processEpoch)
    assert.equal(fresh.data.loadedRevision, saved.data.committedRevision); assert.equal(fresh.data.loadedRevision, fresh.data.storedRevision)
    const reloaded = await f.request(operation.read, { token: false, session: true })
    assert.equal(reloaded.status, 200, reloaded.text); operation.verify(reloaded.data)
    previous = fresh.data
  }
  const binding = await f.request('/api/bindings')
  assert.equal(binding.status, 200); assert.equal(binding.data.bindings[0].binding.personaId, 'p-one')
  assert.match(await readFile(f.configFile, 'utf8'), /# preserved host/u)
  assert.equal(YAML.parse(await readFile(f.configFile, 'utf8')).persona.identity, 'saved default identity')
  assert.match(await readFile(f.libraryFile, 'utf8'), /# preserved library/u)
  const library = YAML.parse(await readFile(f.libraryFile, 'utf8'))
  assert.equal(library.extensionOwned, 'retained-library-root')
  assert.equal(library.personas[0].extensionOwned, 'retained-template')
  assert.equal(library.personas[0].moods[0].extensionOwned, 'retained-mood')
  assert.match(await readFile(f.bindingsFile, 'utf8'), /# preserved topology/u)
  await f.stop(); await f.clean()
})

test('source main with omitted console has no persistence HTTP entry point or console credential directory', { timeout: 45000 }, async t => {
  const f = await fixture(t, false), before = await Promise.all([f.configFile, f.libraryFile, f.bindingsFile].map(file => readFile(file, 'utf8')))
  await f.check(); await f.start()
  await assert.rejects(fetch(f.base + '/api/config-state', { signal: AbortSignal.timeout(1000) }))
  await assert.rejects(fetch(f.base + '/api/config/dice', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000) }))
  await assert.rejects(stat(path.join(f.dataDir, 'console')), { code: 'ENOENT' })
  assert.deepEqual(await Promise.all([f.configFile, f.libraryFile, f.bindingsFile].map(file => readFile(file, 'utf8'))), before)
  await f.stop(); await f.clean()
})

test('a save while initial OneBot login is pending retires execution without closing console or its Redis lease', { timeout: 45000 }, async t => {
  const f = await fixture(t, true, { holdLogin: true })
  await f.start({ waitForHostReady: false }); await f.login()
  const view = await f.request('/api/config/dice', { token: false, session: true })
  assert.equal(view.status, 200, view.text)
  const result = await f.request('/api/config/dice', { method: 'PUT', token: false, session: true, body: { revision: view.data.revision, values: { 'dice.maxRounds': 29 } } })
  assert.equal(result.status, 200, result.text); assert.equal(result.data.requiresRestart, true)
  // Let cancellation of adapter.start reach the real entry point before querying it again.
  await delay(100)
  const state = await f.request('/api/config-state', { token: false, session: true })
  assert.equal(state.status, 200, state.text); assert.equal(state.data.phase, 'restart-required')
  assert.equal(state.data.storedRevision, result.data.committedRevision)
  assert.notEqual(await f.reader.get(`${f.prefix}agent:host-lease`), null)
  const auth = await f.request('/api/auth/state', { token: false, session: true })
  assert.equal(auth.status, 200); assert.equal(auth.data.username, 'admin')
  assert.equal(YAML.parse(await readFile(f.configFile, 'utf8')).dice.maxRounds, 29)
  f.releaseLogins()
  assert.equal((await f.request('/api/config/dice', { token: false, session: true })).status, 409)
  await f.stop(); await f.clean()
})
