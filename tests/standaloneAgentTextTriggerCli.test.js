import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// These tests launch the actual release CLI with real isolated Redis, HTTP and
// OneBot WebSocket transports. QQ effects and model decisions are local fixtures.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const BOT = 19001117, USER = 331117, OTHER = 331118, GROUP = 311117, ANOTHER = 311118
const MAIN_KEY = 'TEXT_TRIGGER_MAIN_PRIVATE_123456', SIDE_KEY = 'TEXT_TRIGGER_SIDE_PRIVATE_123456', QQ_TOKEN = 'TEXT_TRIGGER_QQ_PRIVATE_123456'
const ANSWER = '本地验收的确认回复。'
const completion = content => JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
const textOf = message => typeof message === 'string' ? message : message.filter(part => part.type === 'text').map(part => part.data.text).join('')

async function waitFor(probe, label, timeout = 25_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(20) }
  assert.fail('timed out: ' + label)
}

async function fixture(t, { mode = 'smart', side = true, unknown = false, holdSide = false, tracking = false, mergeMs = 0 } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'text-trigger CLI requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'text-trigger-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const prefix = 'bl-agent:text-trigger-cli:', sources = new Map(), actions = [], main = [], gate = [], errors = [], sends = [], order = [], children = [], held = []
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  let reader, child, exited, websocket, log = '', phase = 'check', sourceSequence = 971100, configText
  const server = createServer(async (request, response) => {
    try {
      assert.equal(phase, 'run'); assert.equal(request.method, 'POST')
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); response.setHeader('content-type', 'application/json')
      if (request.url === '/side/v1/chat/completions') {
        assert.equal(side, true); assert.equal(request.headers.authorization, `Bearer ${SIDE_KEY}`)
        assert.equal(body.model, 'text-trigger-side'); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none'); assert.equal(body.stream, false)
        assert.deepEqual(body.messages.map(row => row.role), ['system', 'user'])
        const data = JSON.parse(body.messages[1].content), isTracking = String(body.messages[0].content).includes('判断用户是否在继续')
        const row = { body, data, isTracking }; gate.push(row); order.push('side')
        if (!isTracking) assert.equal(data.current.directedToAccount, false, 'ordinary smart sources retain their original mention state')
        const result = completion(JSON.stringify(isTracking ? { talking: true } : { decision: 'continue', reason: 'fixture' }))
        if (holdSide) { held.push({ response, result }); return }
        response.end(result); return
      }
      assert.equal(request.url, '/main/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${MAIN_KEY}`)
      assert.equal(body.model, 'text-trigger-main'); main.push(body); order.push('main')
      response.end(completion(ANSWER))
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
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '文本触发验收机器人' }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'source lookup must use a retained actual WebSocket source') }
      else if (action === 'get_group_member_info') {
        assert.ok([GROUP, ANOTHER].includes(Number(params.group_id))); assert.ok([USER, OTHER, BOT].includes(Number(params.user_id)))
        data = { group_id: Number(params.group_id), user_id: Number(params.user_id), nickname: '文本触发验收员', card: '', role: 'member' }
      } else if (action === 'get_group_member_list') {
        assert.ok([GROUP, ANOTHER].includes(Number(params.group_id)))
        data = [USER, OTHER, BOT].map(user_id => ({ group_id: Number(params.group_id), user_id, nickname: '文本触发验收员', card: '', role: 'member' }))
      } else if (action === 'send_group_msg') {
        assert.ok([GROUP, ANOTHER].includes(Number(params.group_id))); assert.equal(textOf(params.message).trim(), ANSWER)
        sends.push({ params, at: Date.now() }); order.push('send'); data = unknown ? {} : { message_id: 981100 + sends.length }
      } else assert.fail('unexpected OneBot action ' + action)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo })) }
  }) })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, main, gate, sends, order }))
    for (const item of children) { if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); await item.exited }
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const raw = { version: 1, instance: 'text-trigger-cli', dataDir,
    persona: { name: '文本触发验收角色', identity: '本地合成测试' },
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'text-trigger-main', apiKeyEnv: 'TEXT_TRIGGER_MAIN_KEY' },
    ...(side ? { textTriggerModel: { baseUrl: `http://127.0.0.1:${port}/side/v1`, name: 'text-trigger-side', apiKeyEnv: 'TEXT_TRIGGER_SIDE_KEY' } } : {}),
    textTrigger: { mode, tracking: { enabled: tracking, timeoutMs: 10000, throttleMs: 0, batchDelayMs: 50 },
      smart: { talkValue: 1, repeatJoinEnabled: false, idleCompensationEnabled: false, deferredGateEnabled: false,
        replyDebounceMs: 0, directTriggerMergeMs: mergeMs, toolRequestMergeMs: 20 } },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEXT_TRIGGER_QQ_TOKEN' }],
    textGroups: [GROUP, ANOTHER].map(id => ({ connectionId: 'main', conversationId: String(id), tools: [] })),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } }
  configText = JSON.stringify(raw)
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [GROUP, ANOTHER].map(id => ({ connectionId: 'main', kind: 'group', conversationId: String(id), agentId: 'daily' })) })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEXT_TRIGGER_MAIN_KEY: MAIN_KEY, TEXT_TRIGGER_SIDE_KEY: SIDE_KEY, TEXT_TRIGGER_QQ_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); children.push({ child, exited }); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  }
  const receiptKey = source => prefix + 'agent:inbox:receipt:' + createHash('sha256').update(JSON.stringify(['message',
    JSON.stringify(['qq', 'global', String(BOT), 'group', String(source.group_id)]), String(source.message_id)])).digest('hex')
  const healthy = () => { assert.deepEqual(errors, []); assert.equal(child.exitCode, null, log) }
  return { main, gate, sends, actions, order, held,
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(main.length + gate.length + sends.length, 0); assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' })
      phase = 'run'; await this.restart()
    },
    async restart() {
      websocket = undefined; log = ''; launch(false)
      await waitFor(() => { if (child.exitCode !== null) assert.fail('CLI exited early: ' + log); return log.includes('已启动') && websocket?.readyState === websocket.OPEN }, 'CLI readiness')
    },
    async send(text = '这是一条完整且独立的普通群聊话题消息', { direct = false, user = USER, group = GROUP } = {}) {
      const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: group, user_id: user,
        sender: { user_id: user, nickname: '文本触发验收员' }, message_id: ++sourceSequence, time: Math.floor(Date.now() / 1000),
        message: [...(direct ? [{ type: 'at', data: { qq: String(BOT) } }] : []), { type: 'text', data: { text } }], raw_message: text }
      sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source))
      await waitFor(() => reader.exists(receiptKey(source)), 'actual message admission'); healthy(); return source
    },
    async admittedAndDrained() {
      await waitFor(async () => {
        const queues = await reader.keys(prefix + 'agent:inbox:group-text:*')
        return (await Promise.all(queues.map(key => reader.lLen(key)))).every(count => count === 0)
      }, 'text inbox drained'); healthy()
    },
    async waitSends(count) { await waitFor(() => sends.length === count, 'text sends: ' + count); await this.admittedAndDrained(); healthy() },
    async receipt(source) { return reader.get(receiptKey(source)) },
    async revokeConfig() { raw.textTrigger.mode = 'strict'; configText = JSON.stringify(raw); await writeFile(configFile, configText) },
    async recall(source) {
      websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: source.group_id,
        user_id: source.user_id, operator_id: source.user_id, message_id: source.message_id, time: Math.floor(Date.now() / 1000) }))
      await waitFor(async () => (await reader.keys(prefix + 'agent:inbox:text-recall-receipt:*')).length > 0, 'actual recall admission')
    },
    releaseSide() { for (const item of held.splice(0)) if (!item.response.destroyed) item.response.end(item.result) },
    async replay(source) { websocket.send(JSON.stringify(source)); await delay(1000); await this.admittedAndDrained() },
    async quiet(ms = 800) { await delay(ms); await this.admittedAndDrained(); healthy() },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      for (const secret of [MAIN_KEY, SIDE_KEY, QQ_TOKEN]) assert.equal(log.includes(secret), false)
      assert.deepEqual(errors, [])
    },
  }
}

test('actual CLI smart ordinary group text uses a dedicated tool-free side gate then main reply without quote', { timeout: 45_000 }, async t => {
  const f = await fixture(t); await f.start(); const source = await f.send(); await f.waitSends(1)
  assert.deepEqual(f.order, ['side', 'main', 'send']); assert.equal(f.gate.length, 1); assert.equal(f.main.length, 1)
  assert.equal(f.gate[0].data.current.text, textOf(source.message)); assert.equal(f.gate[0].data.current.speakerId, String(USER))
  assert.equal(f.sends[0].params.message.some(part => part.type === 'reply' || part.type === 'at'), false)
  await waitFor(async () => await f.receipt(source) === 'confirmed-text', 'confirmed source receipt'); await f.stop(); await f.clean()
})

test('actual CLI strict direct reply establishes same-speaker tracking while another speaker stays silent', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { mode: 'strict', tracking: true }); await f.start()
  const direct = await f.send('这是明确发给机器人的第一条完整消息', { direct: true }); await f.waitSends(1)
  assert.equal(f.gate.length, 0); assert.ok(f.sends[0].params.message.some(part => part.type === 'reply' && String(part.data.id) === String(direct.message_id)))
  await f.send('这是另外一个人的独立且完整的新话题消息', { user: OTHER }); await f.quiet(300)
  assert.equal(f.gate.length, 0); assert.equal(f.sends.length, 1)
  await f.send('同一位对话者补充完整的后续话题消息'); await f.waitSends(2)
  assert.equal(f.gate.length, 1); assert.equal(f.gate[0].isTracking, true); assert.equal(f.gate[0].data.current.speakerId, String(USER))
  assert.ok(f.gate[0].data.history.length > 0); assert.ok(f.gate[0].data.history.every(turn => turn.user.includes('明确发给机器人')))
  assert.equal(f.main.length, 2); await f.stop(); await f.clean()
})

test('actual CLI smart mode without a side model keeps direct replies available and ordinary chatter silent', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { side: false }); await f.start(); await f.send(); await f.quiet()
  assert.equal(f.main.length, 0); assert.equal(f.sends.length, 0)
  await f.send('无需辅助模型的直接请求', { direct: true }); await f.waitSends(1)
  assert.equal(f.gate.length, 0); assert.equal(f.main.length, 1); await f.stop(); await f.clean()
})

test('actual CLI merges a direct burst without blocking another group on the same account inbox', { timeout: 45_000 }, async t => {
  const f = await fixture(t, { mergeMs: 2000 }); await f.start()
  const first = await f.send('同群连续消息的第一条原始文本', { direct: true })
  const second = await f.send('同群连续消息的第二条原始文本', { direct: true })
  await f.send('帮我搜索火星资料', { direct: true, group: ANOTHER })
  await waitFor(() => f.sends.length > 0, 'other group replies before the retained burst')
  assert.equal(String(f.sends[0].params.group_id), String(ANOTHER)); assert.equal(f.main.length, 1)
  await f.waitSends(2); assert.equal(String(f.sends[1].params.group_id), String(GROUP)); assert.equal(f.main.length, 2)
  const merged = JSON.stringify(f.main[1]); assert.ok(merged.includes('同群连续消息的第一条原始文本')); assert.ok(merged.includes('同群连续消息的第二条原始文本'))
  assert.ok(merged.includes(String(first.message_id))); assert.ok(f.sends[1].params.message.some(part => part.type === 'reply' && String(part.data.id) === String(second.message_id)))
  await f.quiet(300); assert.equal(f.sends.length, 2); await f.stop(); await f.clean()
})

for (const fence of ['configuration', 'recall']) test(`actual CLI ${fence} invalidation during side HTTP prevents the main model and native send`, { timeout: 45_000 }, async t => {
  const f = await fixture(t, { holdSide: true }); await f.start(); const source = await f.send()
  await waitFor(() => f.held.length === 1, 'held actual side HTTP request')
  if (fence === 'configuration') { await f.revokeConfig(); await delay(700) } else await f.recall(source)
  f.releaseSide(); await f.quiet(1000)
  assert.equal(f.gate.length, 1); assert.equal(f.main.length, 0); assert.equal(f.sends.length, 0)
  await f.stop(); await f.clean()
})

test('actual CLI unknown text delivery is never replayed after duplicate ingress or process restart', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); const source = await f.send(); await f.waitSends(1)
  await waitFor(async () => await f.receipt(source) === 'attempted', 'durable uncertain source claim')
  await f.replay(source); assert.equal(f.gate.length, 1); assert.equal(f.main.length, 1); assert.equal(f.sends.length, 1)
  await f.stop(); await f.restart(); await f.replay(source)
  assert.equal(f.gate.length, 1); assert.equal(f.main.length, 1); assert.equal(f.sends.length, 1); assert.equal(await f.receipt(source), 'attempted')
  await f.stop(); await f.clean()
})
