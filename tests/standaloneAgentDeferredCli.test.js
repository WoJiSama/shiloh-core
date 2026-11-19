import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// The actual CLI and its built output run against real isolated Redis plus
// local OneBot/model servers. No external QQ or model service is exercised.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const { createAgentBindingDirectory, agentBindingIdentity, agentConversationKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const BOT = 19000917, USER = 330917, GROUP = 310917, SOURCE = 96917
const MODEL_KEY = 'DEFERRED_CLI_MODEL_PRIVATE_123456', QQ_TOKEN = 'DEFERRED_CLI_QQ_PRIVATE_123456'
const BODY = '去喝水，休息一下。'
const completion = (name, args, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 8 } })
const textOf = message => typeof message === 'string' ? message : message.filter(part => part.type === 'text').map(part => part.data.text).join('')

async function waitFor(probe, label, timeout = 25_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(20) }
  assert.fail('timed out: ' + label)
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  return (await Promise.all(entries.map(item => {
    const file = path.join(directory, item.name)
    return item.isDirectory() ? files(file) : item.isFile() ? readFile(file, 'utf8') : ''
  }))).join('\n')
}

async function fixture(t, { enabled = true, grant = true, unknown = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'deferred CLI requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'deferred-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const prefix = 'bl-agent:deferred-cli:', sources = new Map(), actions = [], models = [], toolResults = [], errors = [], pokes = [], texts = [], order = []
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  let reader, child, exited, websocket, log = '', phase = 'check', dueAt = 0, finished = false, source, configText
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/model/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${MODEL_KEY}`); assert.equal(phase, 'run')
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body)
      const names = (body.tools ?? []).map(tool => tool.function.name)
      assert.equal(names.includes('reminderTool'), enabled)
      for (const row of body.messages.filter(row => row.role === 'tool')) if (!toolResults.some(existing => existing.tool_call_id === row.tool_call_id)) toolResults.push(row)
      assert.ok(models.length <= (enabled ? 2 : 1), 'fixed due reminders cannot invoke a model')
      if (!dueAt) {
        // Generate after startup, so process startup time cannot move the
        // scheduled ISO timestamp into the past before tool registration.
        dueAt = Date.now() + 3000
        if (enabled) {
          response.end(completion('reminderTool', { action: 'create', reminder_time: new Date(dueAt).toISOString(), content: '喝水', reminder_message: BODY,
            extra_action: { tool: 'pokeTool', params: {} } }, 'deferred-create')); return
        }
      }
      finished = true
      response.end(completion('simFinishTurn', { choice: 'silent', reason: '提醒登记结果已核对。' }, 'deferred-finish'))
    } catch (error) { errors.push(String(error)); if (!response.destroyed) response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', frame => {
    let echo
    try {
      const request = JSON.parse(String(frame)); echo = request.echo
      const { action, params } = request; actions.push({ action, params }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '延期验收机器人' }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'the original source must be available for fresh verification') }
      else if (action === 'get_group_member_info') {
        assert.equal(String(params.group_id), String(GROUP)); assert.equal(String(params.user_id), String(USER)); assert.equal(params.no_cache, true)
        data = { group_id: GROUP, user_id: USER, nickname: '延期验收员', card: '', role: 'member' }
      } else if (action === 'get_group_member_list') {
        assert.equal(String(params.group_id), String(GROUP))
        data = [USER, BOT].map(user_id => ({ group_id: GROUP, user_id, nickname: user_id === USER ? '延期验收员' : '延期验收机器人', card: '', role: 'member' }))
      } else if (action === 'send_group_poke') {
        assert.equal(phase, 'run'); assert.equal(enabled && grant, true); assert.ok(Date.now() >= dueAt)
        assert.deepEqual(params, { group_id: String(GROUP), user_id: String(USER) })
        pokes.push(params); order.push('extra')
        if (unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        data = {}
      } else if (action === 'send_group_msg') {
        assert.equal(String(params.group_id), String(GROUP)); assert.equal(textOf(params.message).trim(), BODY)
        assert.equal(unknown, false); assert.equal(pokes.length, 1); assert.ok(params.message.some(part => part.type === 'at' && String(part.data.qq) === String(USER)))
        assert.equal(params.message.some(part => part.type === 'reply'), false)
        texts.push(params); order.push('text'); data = { message_id: 98917 + texts.length }
      } else assert.fail('unexpected OneBot action ' + action)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo })) }
  }) })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, models, toolResults }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const account = { platform: 'qq', namespace: 'global', id: String(BOT) }, target = { account, kind: 'group', id: String(GROUP) }
  const bindingDocument = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] }
  const binding = createAgentBindingDirectory(bindingDocument, 'fixture').resolve(target), scope = simulationAddressKey(target)
  const rule = { id: 'cli-self-poke', revision: 'v1', bindingIdentity: agentBindingIdentity(binding), scopeKey: agentConversationKey(binding),
    creatorIds: [String(USER)], tool: 'pokeTool', executor: 'builtin', definitionId: 'core:deferred-poke:v1', maxDelayMs: 60_000 }
  const raw = { version: 1, instance: 'deferred-cli', dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'deferred-fixture', apiKeyEnv: 'DEFERRED_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'DEFERRED_QQ_TOKEN' }],
    tools: { interactions: { enabled: true }, ...(enabled ? { deferredActions: { enabled: true, rules: grant ? [rule] : [] } } : {}) },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false },
      consistency: { enabled: false }, turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'open', allowTools: ['reminderTool', 'pokeTool'] } } }
  configText = JSON.stringify(raw); const bindingsText = JSON.stringify(bindingDocument)
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, DEFERRED_MODEL_KEY: MODEL_KEY, DEFERRED_QQ_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  }
  const records = async () => Promise.all((await reader.keys(prefix + 'bl-chat:commitment:detail:dfr_*')).map(async key => JSON.parse(await reader.get(key))))
  const drained = async () => {
    const state = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
    return !!state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope))
  }
  const assertHealthy = () => { assert.deepEqual(errors, []); assert.equal(child.exitCode, null, log) }
  return { actions, models, toolResults, pokes, texts, order, records,
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(models.length, 0); assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' })
      phase = 'run'; await this.restart()
    },
    async restart() {
      websocket = undefined; log = ''; launch(false)
      await waitFor(() => { if (child.exitCode !== null) assert.fail('CLI exited early: ' + log); return log.includes('已启动') && websocket?.readyState === websocket.OPEN }, 'CLI readiness')
    },
    async run() {
      const text = '三秒后提醒我喝水，并戳我一下。'
      source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
        sender: { user_id: USER, nickname: '延期验收员' }, message_id: SOURCE, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text } }], raw_message: text }
      sources.set(String(SOURCE), source); websocket.send(JSON.stringify(source))
      await waitFor(() => finished, 'model consumes registration result'); await waitFor(drained, 'simulation turn drains')
      assertHealthy()
      if (enabled && grant) {
        const saved = await records(); assert.equal(saved.length, 1); assert.equal(saved[0].status, 'active')
        assert.equal(saved[0].deferredAction.state, 'pending'); assert.equal(saved[0].schedule.time, dueAt)
        assert.deepEqual(saved[0].deferredAction.action.params, { target: [String(USER)] })
        assert.ok(toolResults.some(row => /延期提醒已登记/u.test(row.content)))
      } else {
        assert.deepEqual(await records(), [])
        if (enabled) assert.ok(toolResults.some(row => /未登记/u.test(row.content)))
      }
    },
    async terminal(state) {
      await waitFor(async () => (await records())[0]?.status === state, 'durable deferred ' + state)
      assertHealthy(); return (await records())[0]
    },
    async beyondDue() { await waitFor(() => Date.now() >= dueAt + 1300, 'scheduler passes due time'); assertHealthy() },
    async revoke() {
      assert.ok(Date.now() < dueAt, 'configuration is revoked before the scheduled deadline')
      raw.tools.deferredActions.enabled = false; configText = JSON.stringify(raw); await writeFile(configFile, configText)
      assert.ok(Date.now() < dueAt, 'revoked configuration is saved before the scheduled deadline')
    },
    recall() { sources.delete(String(SOURCE)); websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: GROUP,
      user_id: USER, operator_id: USER, message_id: SOURCE, time: Math.floor(Date.now() / 1000) })) },
    async replay() { websocket.send(JSON.stringify(source)); await delay(1200); assertHealthy() },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const stored = []; for (const key of await reader.keys(prefix + '*')) if (await reader.type(key) === 'string') stored.push(await reader.get(key))
      const content = log + await files(dataDir) + stored.join('\n') + JSON.stringify(models)
      for (const secret of [MODEL_KEY, QQ_TOKEN]) for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(content.includes(value), false)
      assert.deepEqual(errors, [])
    },
  }
}

test('actual CLI exact deferred rule registers one native poke then fixed body without a due model or restart replay', { timeout: 60_000 }, async t => {
  const f = await fixture(t); await f.start(); await f.run()
  assert.deepEqual(f.pokes, []); assert.deepEqual(f.texts, [])
  const modelCalls = f.models.length, saved = await f.terminal('completed')
  assert.equal(saved.deferredAction.state, 'succeeded'); assert.equal(f.pokes.length, 1); assert.equal(f.texts.length, 1)
  assert.deepEqual(f.order, ['extra', 'text']); assert.equal(f.models.length, modelCalls)
  await f.stop(); await f.restart(); await f.replay(); await f.beyondDue()
  assert.equal(f.pokes.length, 1); assert.equal(f.texts.length, 1); assert.equal(f.models.length, modelCalls)
  await f.stop(); await f.clean()
})

for (const options of [{ enabled: false }, { grant: false }]) test(`actual CLI ${options.enabled === false ? 'default-off deferred actions' : 'missing exact rule'} never schedules a native extra`, { timeout: 60_000 }, async t => {
  const f = await fixture(t, options); await f.start(); await f.run(); await f.beyondDue()
  assert.deepEqual(await f.records(), []); assert.deepEqual(f.pokes, []); assert.deepEqual(f.texts, [])
  await f.stop(); await f.clean()
})

test('actual CLI unknown native extra remains fenced without fixed body across host restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); await f.run()
  const saved = await f.terminal('unknown'), modelCalls = f.models.length
  assert.equal(saved.deferredAction.state, 'unknown'); assert.equal(f.pokes.length, 1); assert.deepEqual(f.texts, [])
  await f.stop(); await f.restart(); await f.replay(); await f.beyondDue()
  assert.equal((await f.records())[0].status, 'unknown'); assert.equal(f.pokes.length, 1); assert.deepEqual(f.texts, []); assert.equal(f.models.length, modelCalls)
  await f.stop(); await f.clean()
})

for (const fence of ['configuration', 'recall']) test(`actual CLI ${fence} revocation before due time prevents native extra and fixed body`, { timeout: 60_000 }, async t => {
  const f = await fixture(t); await f.start(); await f.run()
  if (fence === 'configuration') {
    const registered = await f.records(), modelCalls = f.models.length
    await f.revoke(); await f.beyondDue()
    assert.deepEqual(f.pokes, []); assert.deepEqual(f.texts, [])
    assert.deepEqual(await f.records(), registered, 'a stale host cannot settle a pending task after its configuration changes')
    // Host configuration changes retire execution. Only a fresh process may
    // reconcile the saved task against the now-disabled delegation policy.
    await f.stop(); await f.restart()
    const saved = await f.terminal('cancelled')
    assert.equal(saved.deferredAction.state, 'pending'); assert.equal(saved.deferredAction.attemptedAt, 0)
    await f.replay(); await f.beyondDue()
    assert.equal((await f.records())[0].status, 'cancelled'); assert.equal(f.models.length, modelCalls)
  } else {
    f.recall(); await f.terminal('cancelled'); await f.beyondDue()
  }
  assert.deepEqual(f.pokes, []); assert.deepEqual(f.texts, [])
  await f.stop(); await f.clean()
})
