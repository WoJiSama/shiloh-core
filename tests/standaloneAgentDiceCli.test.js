import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// Actual packaged CLI, Redis and WebSocket transport; OneBot and the model are
// local fixtures. These checks establish host wiring, not real QQ display.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), BOT = 19000421, USER = 330421, GROUP = 310421
const MODEL_KEY = 'DICE_MODEL_PRIVATE_123456', QQ_TOKEN = 'DICE_QQ_PRIVATE_123456', NAME = '骰子合成验收员'
const hash = value => createHash('sha256').update(value).digest('hex')
const textOf = message => typeof message === 'string' ? message : message.filter(part => part.type === 'text').map(part => part.data.text).join('')
async function waitFor(probe, label, timeout = 20000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function files(directory) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) values.push(await files(file)); else if (item.isFile()) values.push(await readFile(file, 'utf8'))
  }
  return values.join('\n')
}
async function fixture(t, { enabled = true, logging = false, unknownAt = 0, missingId = false, revoke = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'dice CLI verification requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dice-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const prefix = 'bl-agent:dice-cli:', conversationKey = JSON.stringify(['qq', 'global', String(BOT), 'group', String(GROUP)])
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), actions = [], replies = [], diceSends = [], sources = new Map(), errors = []
  let child, exited, reader, websocket, log = '', modelRequests = 0, sequence = 96420, held, configText, phase = 'check'
  const server = createServer((_request, response) => { modelRequests++; response.writeHead(503).end('{}') })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', frame => {
    let echo
    try {
      const request = JSON.parse(String(frame)); echo = request.echo; const { action, params } = request; actions.push({ action, params }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '骰子合成验收机器人' }
      else if (action === 'get_msg') {
        data = sources.get(String(params.message_id)); assert.ok(data, 'source lookup must stay within this group fixture')
        if (revoke && /^\.(?:r|roll)\b/iu.test(textOf(data.message)) && !held) { held = () => peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo })); return }
      } else if (action === 'get_group_member_info') {
        assert.equal(String(params.group_id), String(GROUP)); assert.ok([USER, BOT].map(String).includes(String(params.user_id)))
        data = { group_id: GROUP, user_id: Number(params.user_id), nickname: Number(params.user_id) === USER ? NAME : '骰子合成验收机器人', card: '', role: 'member' }
      } else if (action === 'get_group_member_list') {
        assert.equal(String(params.group_id), String(GROUP)); data = [USER, BOT].map(user_id => ({ group_id: GROUP, user_id, nickname: user_id === USER ? NAME : '骰子合成验收机器人', card: '', role: 'member' }))
      } else if (action === 'send_group_msg') {
        assert.equal(phase, 'run'); assert.equal(String(params.group_id), String(GROUP)); const text = textOf(params.message)
        const messageId = String(88420 + replies.length); replies.push({ text, messageId })
        if (text.includes(' 掷骰：')) {
          assert.equal(enabled && !revoke, true); diceSends.push({ text, messageId })
          if (diceSends.length === unknownAt) {
            peer.send(JSON.stringify(missingId ? { status: 'ok', retcode: 0, data: {}, echo } : { status: 'failed', retcode: 1200, data: null, echo })); return
          }
        }
        data = { message_id: Number(messageId) }
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo })) }
  }) })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, actions, diceSends, modelRequests })) }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port, bridgePort = logging ? await freePort() : undefined
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const file = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const raw = { version: 1, instance: 'dice-cli', dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, name: 'dice-fixture', apiKeyEnv: 'DICE_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'DICE_QQ_TOKEN' }],
    ...(enabled ? { dice: { enabled: true, maxDiceCount: 100, maxDiceSides: 100_000, maxRounds: 20 } } : {}),
    ...(logging ? { groupLog: { enabled: true, maxBytes: 8 * 1024 * 1024, masters: [{ platform: 'qq', namespace: 'global', id: String(USER) }],
      bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort }, advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] } } : {}),
    textGroups: [{ connectionId: 'main', conversationId: String(GROUP) }],
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } }
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] })
  configText = JSON.stringify(raw); await writeFile(file, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, DICE_MODEL_KEY: MODEL_KEY, DICE_QQ_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', file, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  }
  const receipt = source => prefix + 'agent:inbox:receipt:' + hash(JSON.stringify(['message', conversationKey, String(source.message_id)]))
  const operationKey = source => prefix + 'agent:dice:v1:operation:' + hash(JSON.stringify([conversationKey, String(source.message_id)]))
  const operation = async source => { const saved = await reader.get(operationKey(source)); return saved ? JSON.parse(saved) : undefined }
  const records = async () => Promise.all((await reader.keys(prefix + 'agent:dice:v1:operation:*')).map(async key => JSON.parse(await reader.get(key))))
  const rows = async () => (await Promise.all((await reader.keys(prefix + 'agent:group-log:v1:*:rows')).map(async key =>
    Object.values(await reader.hGetAll(key)).map(value => JSON.parse(value))))).flat()
  const drained = async source => {
    await waitFor(() => reader.exists(receipt(source)), 'source admission receipt')
    await waitFor(async () => {
      const keys = await reader.keys(prefix + 'agent:inbox:*'), queues = []
      for (const key of keys) if (await reader.type(key) === 'list') queues.push(key)
      return (await Promise.all(queues.map(key => reader.lLen(key)))).every(count => count === 0)
    }, 'all source inboxes drained')
    assert.deepEqual(errors, [])
  }
  const f = { actions, replies, diceSends, records, rows, operation, drained,
    get modelRequests() { return modelRequests },
    async rejectedDice(source) {
      // Disabled dice is fenced before the ordinary text command filter drops
      // it. Rejection deliberately has no inbox admission receipt to drain.
      const digest = hash(JSON.stringify([conversationKey, String(source.message_id)]))
      await waitFor(async () => await reader.hGet(prefix + 'agent:dice:v1:recalls', digest) === '1', 'disabled dice source fence')
      assert.equal(await reader.exists(receipt(source)), 0)
      assert.deepEqual(errors, [])
    },
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(modelRequests, 0); assert.ok(actions.every(row => row.action === 'get_login_info')); assert.deepEqual(await reader.keys(prefix + '*'), [])
      await assert.rejects(stat(dataDir), { code: 'ENOENT' }); phase = 'run'; await this.restart()
    },
    async restart() {
      log = ''; websocket = undefined; launch(false)
      await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket?.readyState === websocket.OPEN }, 'CLI readiness')
    },
    emit(text) {
      const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
        sender: { user_id: USER, nickname: NAME, role: 'member' }, message_id: ++sequence, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text } }], raw_message: text }
      sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source)); return source
    },
    async terminal(source, state = 'confirmed') {
      await waitFor(async () => (await operation(source))?.state === state, `durable dice ${state} receipt`); await drained(source)
      assert.equal((await operation(source)).version, 1); assert.equal(modelRequests, 0)
      assert.equal(JSON.stringify(await operation(source)).includes(' 掷骰：'), false, 'terminal dice records discard generated output')
    },
    async replay(source) {
      // Re-admit through the real inbox to establish the durable dice fence too.
      await reader.del(receipt(source)); websocket.send(JSON.stringify(source)); await drained(source); await delay(900)
      assert.deepEqual(errors, [])
    },
    async replayRevoked(source) {
      await reader.del(receipt(source)); websocket.send(JSON.stringify(source))
      await this.rejectedDice(source); await delay(900)
      assert.equal(await reader.exists(receipt(source)), 0)
      assert.deepEqual(errors, [])
    },
    async revoke(source) {
      await waitFor(() => held, 'held fresh source read')
      const queue = prefix + 'agent:inbox:group-log:' + JSON.stringify(['qq', 'global', String(BOT)])
      const pending = await reader.lRange(queue, 0, -1); assert.equal(pending.length, 1)
      raw.dice.enabled = false; configText = JSON.stringify(raw); await writeFile(file, configText)
      held()
      const digest = hash(JSON.stringify([conversationKey, String(source.message_id)]))
      await waitFor(async () => await reader.hGet(prefix + 'agent:dice:v1:recalls', digest) === '1', 'revoked dice source fence')
      await delay(300)
      // The old host retires after the configuration changes. It fences the
      // interrupted source but leaves its exact inbox entry for the next host.
      assert.deepEqual(await reader.lRange(queue, 0, -1), pending)
      assert.equal(await reader.exists(receipt(source)), 1)
      assert.deepEqual(errors, [])
    },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(file, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const saved = []; for (const key of await reader.keys(prefix + '*')) if (await reader.type(key) === 'string') saved.push(await reader.get(key))
      const persisted = saved.join('\n') + await files(dataDir)
      for (const secret of [MODEL_KEY, QQ_TOKEN]) assert.equal((log + persisted).includes(secret), false)
      assert.equal(modelRequests, 0); assert.deepEqual(errors, [])
    },
  }
  return f
}

test('actual CLI leaves public dice disabled when the host omits dice authorization', { timeout: 60000 }, async t => {
  const f = await fixture(t, { enabled: false }); await f.start()
  const source = f.emit('.r 1d6'); await f.rejectedDice(source); await delay(300)
  assert.deepEqual(f.diceSends, []); assert.deepEqual(await f.records(), []); assert.equal(f.modelRequests, 0)
  await f.stop(); await f.clean()
})

test('actual CLI executes ordered public .r and .roll with no group log and no model', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.start()
  const source = f.emit('.r 1d6\n.roll 1d8'); await f.terminal(source)
  assert.equal(f.diceSends.length, 2)
  assert.match(f.diceSends[0].text, new RegExp(`^${NAME} 掷骰：1d6=.+=[1-6]$`, 'iu'))
  assert.match(f.diceSends[1].text, new RegExp(`^${NAME} 掷骰：1d8=.+=[1-8]$`, 'iu'))
  assert.deepEqual(await f.rows(), []); assert.equal((await f.operation(source)).completed, 2)
  await f.replay(source); assert.equal(f.diceSends.length, 2)
  await f.stop(); await f.restart(); await f.replay(source); assert.equal(f.diceSends.length, 2)
  await f.stop(); await f.clean()
})

test('actual CLI rolls while group-log AI is silent and records one source plus confirmed typed results', { timeout: 60000 }, async t => {
  const f = await fixture(t, { logging: true }); await f.start()
  const on = f.emit('.log on 骰子合成团录'); await waitFor(() => f.replies.length > 0, 'trusted master enables silent logging'); await f.drained(on)
  const source = f.emit('.r 1d6\n.roll 1d8'); await f.terminal(source)
  await waitFor(async () => (await f.rows()).filter(row => row.type === 'dice_result').length === 2, 'two confirmed typed dice rows')
  const rows = (await f.rows()).filter(row => row.messageId === String(source.message_id))
  assert.equal(rows.filter(row => row.type === 'message' && row.content === source.raw_message).length, 1)
  const results = rows.filter(row => row.type === 'dice_result'); assert.equal(results.length, 2)
  for (const sent of f.diceSends) assert.ok(results.some(row => row.content === sent.text && row.deliveryMessageId === sent.messageId))
  await f.replay(source); assert.equal(f.diceSends.length, 2)
  assert.equal((await f.rows()).filter(row => row.messageId === String(source.message_id)).length, 3)
  await f.stop(); await f.clean()
})

for (const missingId of [false, true]) test(`actual CLI stops after an uncertain public roll and freezes repeats across restart; missingId=${missingId}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { logging: true, unknownAt: 2, missingId }); await f.start()
  const on = f.emit('.log on'); await waitFor(() => f.replies.length > 0, 'silent log readiness'); await f.drained(on)
  const source = f.emit('.r 1d6\n.roll 1d8\n.r 1d10'); await f.terminal(source, 'unknown')
  assert.equal(f.diceSends.length, 2, 'the third command must not be sent after the second result becomes uncertain')
  const record = await f.operation(source); assert.equal(record.completed, 1); assert.equal(record.requested, 3)
  await waitFor(async () => (await f.rows()).filter(row => row.type === 'dice_result').length === 1, 'only the confirmed result enters the log')
  assert.equal((await f.rows()).filter(row => row.type === 'dice_result')[0].deliveryMessageId, f.diceSends[0].messageId)
  await f.replay(source); assert.equal(f.diceSends.length, 2); assert.deepEqual(await f.operation(source), record)
  await f.stop(); await f.restart(); await f.replay(source)
  assert.equal(f.diceSends.length, 2); assert.deepEqual(await f.operation(source), record)
  assert.equal((await f.rows()).filter(row => row.type === 'dice_result').length, 1)
  await f.stop(); await f.clean()
})

test('actual CLI fences a late source read when host dice authorization is revoked', { timeout: 60000 }, async t => {
  const f = await fixture(t, { revoke: true }); await f.start()
  const source = f.emit('.r 1d6'); await f.revoke(source)
  assert.deepEqual(f.diceSends, []); assert.deepEqual(await f.records(), []); assert.equal(f.modelRequests, 0)
  await f.stop(); await f.restart(); await f.drained(source)
  await f.replayRevoked(source)
  assert.deepEqual(f.diceSends, []); assert.deepEqual(await f.records(), []); assert.equal(f.modelRequests, 0)
  await f.stop(); await f.clean()
})
