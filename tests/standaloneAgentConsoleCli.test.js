import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createForgetOperationStore } = await load('modules/runtime/infrastructure/forgetOperationStore.js')

// Real packaged CLI, HTTP, Redis and OneBot transport; every endpoint is local.
// No human messages, provider completions or native outbound QQ actions are used.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const MODEL_KEY = 'CONSOLE_CLI_MODEL_PRIVATE_20261117', QQ_TOKEN = 'CONSOLE_CLI_QQ_PRIVATE_20261117', CONSOLE_TOKEN = 'CONSOLE_CLI_ADMIN_PRIVATE_20261117'
const GROUP = '310911', accounts = ['19000911', '19000912'], names = ['main', 'extra']
async function waitFor(probe, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}
async function freePort() {
  const socket = createTcpServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port
}
async function readTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  return (await Promise.all(entries.map(async item => {
    const file = path.join(directory, item.name)
    return item.isDirectory() ? readTree(file) : item.isFile() ? readFile(file, 'utf8') : ''
  }))).join('\n')
}
async function fixture(t, enabled = true) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'console CLI verification requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-console-cli-')))
  const dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock'), instance = 'console-cli', prefix = `bl-agent:${instance}:`
  const consolePort = await freePort(), base = `http://127.0.0.1:${consolePort}`, errors = [], actions = [], responses = [], children = []
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit'), sockets = new WebSocketServer({ noServer: true })
  let reader, child, exited, log = '', modelRequests = 0, connected = 0
  const upstream = createServer((_request, response) => {
    modelRequests++; errors.push('unexpected provider HTTP request'); response.writeHead(500).end('{}')
  })
  upstream.on('upgrade', (request, socket, head) => {
    const index = names.indexOf(request.url?.slice('/onebot/'.length))
    if (index < 0 || !request.url?.startsWith('/onebot/') || request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => {
      connected++
      peer.on('message', raw => {
        let echo
        try {
          const request = JSON.parse(String(raw)); echo = request.echo; actions.push({ account: accounts[index], action: request.action })
          assert.equal(request.action, 'get_login_info', 'console administration must never invoke native outgoing actions')
          peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: Number(accounts[index]), nickname: '本地控制台验收机器人' } }))
        } catch (error) {
          errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null }))
        }
      })
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, modelRequests }))
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL')
      await item.exited
    }
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    upstream.closeAllConnections(); if (upstream.listening) await new Promise(resolve => upstream.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const port = upstream.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: names.map((id, index) => ({ id, platform: 'qq', namespace: 'global', accountId: accounts[index] })),
    bindings: names.map(connectionId => ({ connectionId, kind: 'group', conversationId: GROUP, agentId: 'daily' })) }
  await writeFile(bindingsFile, JSON.stringify(bindings))
  await writeFile(configFile, JSON.stringify({ version: 1, instance, dataDir,
    persona: { name: '控制台验收角色', identity: '本地合成测试' },
    model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'unused-console-model', apiKeyEnv: 'CONSOLE_CLI_MODEL_KEY' },
    simulation: { enabled: false, allGroups: false, groups: [], wake: { probability: 0, proactiveProbability: 0 },
      rhythm: { enabled: false }, reflection: { enabled: false } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    ...(enabled ? { console: { enabled: true, port: consolePort, tokenEnv: 'CONSOLE_CLI_TOKEN' } } : {}),
    connections: names.map(id => ({ id, url: `ws://127.0.0.1:${port}/onebot/${id}`, accessTokenEnv: 'CONSOLE_CLI_QQ_TOKEN' })),
  }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, CONSOLE_CLI_MODEL_KEY: MODEL_KEY, CONSOLE_CLI_QQ_TOKEN: QQ_TOKEN, CONSOLE_CLI_TOKEN: CONSOLE_TOKEN }
  function launch(check) {
    const offset = log.length
    child = spawn(process.execPath, [entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); children.push({ child, exited })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    return offset
  }
  async function request(route, { method = 'GET', body, token = true } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(token ? { 'x-console-token': CONSOLE_TOKEN } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
    const text = await response.text(); responses.push(text)
    return { status: response.status, response, text, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : null }
  }
  async function start() {
    const previous = connected, offset = launch(false)
    await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited before readiness: ${log}`); return connected >= previous + accounts.length && log.slice(offset).includes('[Agent] 已启动') }, 'standalone CLI readiness')
  }
  return { dataDir, reader, prefix, consolePort, base, request, start,
    async check() {
      const offset = launch(true); assert.deepEqual(await exited, [0, null], log)
      assert.equal(JSON.parse(log.slice(offset)).mode, 'check')
      assert.deepEqual(await reader.keys('*'), [])
      await assert.rejects(stat(dataDir), { code: 'ENOENT' })
      assert.equal(modelRequests, 0); assert.ok(actions.every(item => item.action === 'get_login_info'))
    },
    async rebind() { await writeFile(bindingsFile, JSON.stringify(bindings) + '\n') },
    async stop() {
      child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
      assert.equal(await reader.get(`${prefix}agent:host-lease`), null, 'shutdown releases the real Redis lease')
      const reuse = createTcpServer(); reuse.listen(consolePort, '127.0.0.1'); await once(reuse, 'listening'); await new Promise(resolve => reuse.close(resolve))
      assert.equal(modelRequests, 0); assert.deepEqual(errors, [])
      const output = log + responses.join('\n') + await readTree(dataDir)
      for (const secret of [MODEL_KEY, QQ_TOKEN, CONSOLE_TOKEN]) assert.equal(output.includes(secret), false, 'responses, persistent files and logs exclude credentials')
      if (enabled) {
        const journal = await readTree(path.join(dataDir, 'operations'))
        assert.ok(journal.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(row => row.operation === 'console_start' && row.outcome === 'succeeded'))
      }
    },
  }
}

test('packaged standalone console checks without writes, serves authenticated APIs and manages exact bound simulation targets', { timeout: 45_000 }, async t => {
  const f = await fixture(t); await f.check(); await f.start()
  assert.equal((await stat(path.join(f.dataDir, 'console'))).mode & 0o777, 0o700)
  await assert.rejects(stat(path.join(f.dataDir, 'console', 'users.json')), { code: 'ENOENT' })
  const page = await f.request('/', { token: false })
  assert.equal(page.status, 200); assert.match(page.text, /<html/iu); assert.match(page.text, /id="app"/u)
  const asset = page.text.match(/<script[^>]+src="([^"]+)"/u)?.[1]
  assert.ok(asset, 'the default packaged frontend references its compiled entry')
  assert.equal((await f.request(asset, { token: false })).status, 200)
  for (const route of ['/api/bindings', '/api/workspace', '/api/simulation/overview', '/api/tokens/summary']) {
    assert.equal((await f.request(route, { token: false })).status, 401)
  }
  assert.deepEqual((await f.request('/api/auth/state')).data, { hasUser: false, username: null, tokenWorks: true, via: 'token' })
  const bindings = await f.request('/api/bindings'); assert.equal(bindings.status, 200); assert.equal(bindings.data.bindings.length, 2)
  const entries = bindings.data.bindings, first = entries.find(item => item.binding.target.account.id === accounts[0]), second = entries.find(item => item.binding.target.account.id === accounts[1])
  assert.ok(first && second); assert.notEqual(first.scopeKey, second.scopeKey)
  const workspace = await f.request('/api/workspace')
  assert.equal(workspace.status, 200); assert.equal(workspace.data.mode, 'standalone')
  assert.equal(workspace.data.agents.length, 1); assert.equal(workspace.data.agents[0].id, 'daily')
  assert.equal(workspace.data.agents[0].name, '控制台验收角色')
  assert.deepEqual(new Set(workspace.data.agents[0].conversations.map(row => row.scopeKey)), new Set(entries.map(row => row.scopeKey)))
  assert.deepEqual(new Set(workspace.data.connections.map(row => row.account.id)), new Set(accounts))
  assert.ok(workspace.data.connections.every(row => row.state === 'connected' && row.conversationCount === 1))
  const capability = operation => workspace.data.capabilities.find(row => row.operation === operation)
  for (const operation of ['workspace.read', 'profiles.read', 'trusteeship.read', 'config-state.read', 'profiles.delete', 'commitments.cancel']) {
    assert.equal(capability(operation)?.status, 'available', operation)
  }
  assert.equal(capability('accounts.add')?.status, 'unavailable', 'a catalogue declaration is not an installed account handler')
  assert.equal(workspace.data.cognition.status, 'planned')
  assert.equal((await f.request('/api/person-profiles')).status, 200)
  assert.equal((await f.request('/api/trusteeship/overview')).status, 200)
  for (const item of entries) {
    assert.deepEqual(item.binding.target, { account: { platform: 'qq', namespace: 'global', id: item.binding.target.account.id }, kind: 'group', id: GROUP })
    assert.equal(item.binding.source, 'configured'); assert.equal(item.binding.agentId, 'daily')
  }
  const select = item => ({ scopeKey: item.scopeKey, bindingToken: item.bindingToken })
  const receiptStore = createForgetOperationStore({ redis: f.reader, prefix: `${f.prefix}agent:forget-operation:v1` })
  const created = await receiptStore.begin({ requestId: 'isolated-console-receipt', kind: 'person-profile', binding: first.binding, subject: { userId: 'fixture-person' } })
  const terminal = await receiptStore.fail(created.operationId, { state: 'unknown', errorCode: 'ISOLATED_RECEIPT_FIXTURE' })
  const receiptRoute = item => `/api/forgetting/${created.operationId}?${new URLSearchParams(select(item))}`
  const receipt = await f.request(receiptRoute(first))
  assert.equal(receipt.status, 200); assert.equal(receipt.data.operationId, terminal.operationId)
  assert.equal(receipt.data.phase, 'unknown'); assert.equal(receipt.data.usage, 'unknown')
  assert.equal((await f.request(receiptRoute(first), { token: false })).status, 401)
  assert.equal((await f.request(receiptRoute(second))).status, 409)
  assert.equal((await f.request(`/api/forgetting/00000000-0000-4000-8000-000000000000?${new URLSearchParams(select(first))}`)).status, 404)
  const detail = item => f.request('/api/simulation/group?' + new URLSearchParams(select(item)))
  const overview = await f.request('/api/simulation/overview')
  assert.equal(overview.status, 200); assert.equal(overview.data.enabled, false); assert.equal(overview.data.groups.length, 2)
  assert.deepEqual(new Set(overview.data.groups.map(item => item.scopeKey)), new Set(entries.map(item => item.scopeKey)))
  assert.equal((await f.request('/api/tokens/summary')).status, 200)
  const mutate = (body, item = first) => f.request('/api/simulation/group', { method: 'POST', body: { ...select(item), ...body } })
  for (const body of [{ action: 'reply-mode', mode: 'atOnly' }, { action: 'budget', cap: 12.34 }, { action: 'turns', cap: 7 }, { action: 'disable' }]) {
    assert.equal((await mutate(body)).status, 200)
  }
  const changed = await detail(first), untouched = await detail(second)
  assert.equal(changed.status, 200); assert.equal(changed.data.replyMode, 'atOnly')
  assert.equal(changed.data.budget.dailyCostCny, 12.34); assert.equal(changed.data.budget.maxTurnsPerDay, 7)
  assert.equal(changed.data.budget.capOverridden, true); assert.equal(changed.data.budget.turnsCapOverridden, true)
  assert.equal(untouched.status, 200); assert.equal(untouched.data.replyMode, 'auto')
  assert.equal(untouched.data.budget.capOverridden, false); assert.equal(untouched.data.budget.turnsCapOverridden, false)
  const storageKey = item => 'v2.' + Buffer.from(JSON.stringify(['qq', 'global', item.binding.target.account.id, 'group', GROUP])).toString('base64url')
  const overrides = JSON.parse(await f.reader.get(`${f.prefix}shiloh:sim:overrides`))
  assert.equal(overrides.budgetCaps[storageKey(first)], 12.34); assert.equal(overrides.turnCaps[storageKey(first)], 7)
  assert.ok(overrides.atOnly.includes(storageKey(first))); assert.ok(overrides.disabled.includes(storageKey(first)))
  assert.equal(overrides.budgetCaps[storageKey(second)], undefined)
  assert.equal((await mutate({ action: 'enable' })).status, 200)
  const enabled = JSON.parse(await f.reader.get(`${f.prefix}shiloh:sim:overrides`))
  assert.ok(enabled.explicitEnabled.includes(storageKey(first))); assert.equal(enabled.disabled.includes(storageKey(first)), false)
  const beforeRejected = await f.reader.get(`${f.prefix}shiloh:sim:overrides`)
  for (const route of [`/api/simulation/group?group=${GROUP}`, '/api/simulation/group?' + new URLSearchParams({ scopeKey: GROUP, bindingToken: first.bindingToken })]) {
    assert.equal((await f.request(route)).status, 400)
  }
  assert.equal((await f.request('/api/simulation/group', { method: 'POST', body: { groupId: GROUP, action: 'budget', cap: 99 } })).status, 400)
  const staleToken = JSON.parse(first.bindingToken); staleToken[2] = 'stale-binding-revision'
  assert.equal((await f.request('/api/simulation/group', { method: 'POST', body: { scopeKey: first.scopeKey, bindingToken: JSON.stringify(staleToken), action: 'budget', cap: 99 } })).status, 409)
  assert.equal((await mutate({ action: 'budget', cap: 99, groupId: '999999' })).status, 409)
  assert.equal(await f.reader.get(`${f.prefix}shiloh:sim:overrides`), beforeRejected)
  await f.rebind()
  assert.equal((await detail(first)).status, 409, 'a real binding file revision revokes previously issued selectors')
  assert.equal((await f.request('/api/bindings')).status, 409, 'a changed source read set retires the loaded execution')
  const retired = await f.request('/api/config-state')
  assert.equal(retired.status, 200); assert.equal(retired.data.requiresRestart, true)
  const retiredWorkspace = await f.request('/api/workspace')
  assert.equal(retiredWorkspace.status, 200); assert.equal(retiredWorkspace.data.configState.requiresRestart, true)
  assert.equal(retiredWorkspace.data.configState.loadedRevision, workspace.data.configState.loadedRevision)
  assert.notEqual(retiredWorkspace.data.configState.storedRevision, workspace.data.configState.storedRevision)
  assert.deepEqual(retiredWorkspace.data.agents[0].conversations, workspace.data.agents[0].conversations, 'retired workspace keeps its loaded binding versions')
  assert.equal(retiredWorkspace.data.capabilities.find(row => row.operation === 'profiles.read').status, 'restart-required')
  assert.equal((await f.request('/api/person-profiles')).status, 409)
  assert.equal((await f.request('/api/trusteeship/overview')).status, 409)
  await f.stop(); await f.start()
  const restarted = await f.request('/api/config-state')
  assert.equal(restarted.status, 200); assert.equal(restarted.data.requiresRestart, false)
  assert.notEqual(restarted.data.processEpoch, retired.data.processEpoch, 'restart creates a new process epoch')
  const freshBindings = await f.request('/api/bindings')
  assert.equal(freshBindings.status, 200)
  const refreshed = freshBindings.data.bindings.find(item => item.binding.target.account.id === accounts[0])
  assert.ok(refreshed); assert.notEqual(refreshed.bindingToken, first.bindingToken)
  assert.equal((await detail(first)).status, 409, 'the old selector remains revoked after restart')
  assert.equal((await detail(refreshed)).status, 200)
  await f.stop()
})

test('omitted standalone console configuration starts no HTTP listener or console user directory', { timeout: 30_000 }, async t => {
  const f = await fixture(t, false); await f.check(); await f.start()
  await assert.rejects(fetch(f.base + '/api/auth/state', { signal: AbortSignal.timeout(1000) }))
  await assert.rejects(stat(path.join(f.dataDir, 'console')), { code: 'ENOENT' })
  await f.stop()
})
