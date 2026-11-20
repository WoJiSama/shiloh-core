import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// Actual release CLI, isolated Redis, WebSocket and HTTP. Native QQ and model
// responses are local fixtures; this does not establish live extension support.
// Run only after the coordinating session freezes/builds the current sources.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), BOT = 19000425, USER = 330425, GROUP = 310425, WALLET = 95425
const MODEL_KEY = 'QQ_ACTIONS_MODEL_PRIVATE_123456', QQ_TOKEN = 'QQ_ACTIONS_SOCKET_PRIVATE_123456'
const PC_BODY = 'QQ_ACTIONS_PC_BODY_PRIVATE_123456', PACKET_INDEX = 'QQ_ACTIONS_INDEX_PRIVATE_123456'
const PASSWORD = '红包原生口令[CQ:at,qq=all]', POST = 'post-qq-actions-425', POST_TEXT = '今天想记录一段自己的日常。'
const qqTools = ['sendGiftTool', 'grabRedBagTool', 'qqZoneTool'], writes = ['send_packet', 'send_qzone_msg', 'delete_qzone_msg', 'grab_red_bag']
const names = body => (body.tools ?? []).map(value => value.function.name)
const textOf = value => typeof value === 'string' ? value : (value ?? []).filter(part => part.type === 'text').map(part => part.data.text).join('')
const hash = value => createHash('sha256').update(value).digest('hex')
const toolFor = kind => kind === 'gift' ? 'sendGiftTool' : kind === 'qzone' ? 'qqZoneTool' : 'grabRedBagTool'
const toolArgs = (kind, confirm) => kind === 'gift' ? { targetQQ: '我', giftType: 'champagne' } : kind === 'qzone' ? { text: POST_TEXT } : confirm === false ? { confirm: false } : {}
const completion = (kind, confirm) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'qq-actions-call', type: 'function',
  function: { name: toolFor(kind), arguments: JSON.stringify(toolArgs(kind, confirm)) } }] } }], usage: { total_tokens: 8 } })
// Observe the existing 45s business deadline plus durable settlement. This does
// not extend a tool/provider deadline or permit replay of an uncertain effect.
const nativeOutcomeObservationMs = 55000
async function waitFor(probe, label, timeout = 20000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) result.push(await files(file)); else if (item.isFile()) result.push(await readFile(file, 'utf8'))
  }
  return result.join('\n')
}

async function fixture(t, { enabled = true, declared = true, flags = true, grant = true, explicit = true, unknown = false, revokeModel = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'QQ action CLI verification requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'qqa-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'r.sock')
  const prefix = 'bl-agent:qq-actions-cli:', conversationKey = JSON.stringify(['qq', 'global', String(BOT), 'group', String(GROUP)])
  const sources = new Map(), actions = [], models = [], errors = [], sockets = new WebSocketServer({ noServer: true })
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  let reader, child, exited, websocket, log = '', phase = 'check', active = 'gift', confirm, held, source, sequence = 96425, caseModels = 0, configText
  const allowed = name => enabled && declared && flags && grant && (name !== 'grabRedBagTool' || explicit)
  const member = user_id => ({ group_id: GROUP, user_id, nickname: user_id === BOT ? 'QQ动作合成机器人' : 'QQ动作合成验收员', card: '', role: 'member' })
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/model/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${MODEL_KEY}`); assert.equal(phase, 'run')
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body)
      assert.equal(++caseModels, 1, 'an attempted QQ action must terminate the turn without another model call')
      for (const name of qqTools) assert.equal(names(body).includes(name), allowed(name) && name === toolFor(active), name)
      assert.equal(names(body).includes('simQzoneInteract'), false, 'a text-group grant must not expose simulation visits')
      response.setHeader('content-type', 'application/json')
      if (!allowed(toolFor(active))) { response.end(JSON.stringify({ choices: [{ message: { content: '本轮未开放对应QQ动作。' } }] })); return }
      if (revokeModel) { held = response; return }
      response.end(completion(active, confirm))
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
      const { action, params } = request; actions.push({ action, params, at: performance.now() }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: 'QQ动作合成机器人' }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'fresh source reads must remain inside this group fixture') }
      else if (action === 'get_group_member_list') { assert.equal(String(params.group_id), String(GROUP)); data = [member(USER), member(BOT)] }
      else if (action === 'get_group_member_info') {
        assert.equal(String(params.group_id), String(GROUP)); assert.ok([USER, BOT].map(String).includes(String(params.user_id))); assert.equal(params.no_cache, true)
        data = member(Number(params.user_id))
      } else if (action === 'send_packet') {
        assert.equal(phase, 'run'); assert.equal(active, 'gift'); assert.equal(allowed('sendGiftTool') && !revokeModel, true)
        assert.equal(params.cmd, 'MessageSvc.PbSendMsg'); assert.match(params.data, /^(?:[a-f0-9]{2})+$/u)
        const encoded = Buffer.from(params.data, 'hex').toString('utf8')
        assert.ok(encoded.includes('QQ动作合成验收员')); assert.ok(encoded.includes('QQ动作合成机器人')); assert.ok(encoded.includes('香槟'))
        if (unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        data = {} // packet acceptance is a non-message receipt, with no invented message_id
      } else if (action === 'send_qzone_msg') {
        assert.equal(phase, 'run'); assert.equal(active, 'qzone'); assert.equal(allowed('qqZoneTool') && !revokeModel, true)
        assert.deepEqual(params, { content: POST_TEXT }); data = unknown ? {} : { tid: POST }
      } else if (action === 'grab_red_bag') {
        assert.equal(phase, 'run'); assert.equal(['password', 'packet'].includes(active), true); assert.equal(allowed('grabRedBagTool') && !revokeModel, true)
        assert.deepEqual(params, { recv_uin: String(GROUP), recv_type: 2, peer_uid: String(GROUP), name: 'QQ动作合成机器人',
          pc_body: PC_BODY, wishing: PASSWORD, msg_seq: '702', index: PACKET_INDEX })
        data = { result: { grabRedBagRsp: { result: 0, recvdOrder: { amount: '567' } } } }
      } else if (action === 'send_group_msg') {
        assert.equal(phase, 'run'); assert.equal(String(params.group_id), String(GROUP))
        const password = textOf(params.message) === PASSWORD
        if (password) {
          assert.equal(active, 'password'); assert.equal(confirm === false, false); assert.equal(allowed('grabRedBagTool') && !revokeModel, true)
          assert.deepEqual(params.message, [{ type: 'text', data: { text: PASSWORD } }]); data = unknown ? {} : { message_id: -98425 }
        } else {
          assert.equal(allowed(toolFor(active)), false, 'successful, cancelled or unknown actions must not append text')
          data = { message_id: 98425 + actions.length }
        }
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo })) }
  }) })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, modelTools: models.map(names) }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const file = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const raw = { version: 1, instance: 'qq-actions-cli', dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'qq-actions-fixture', apiKeyEnv: 'QQ_ACTIONS_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'QQ_ACTIONS_TOKEN',
      ...(declared ? { qqActions: { driver: 'napcat', giftDisplay: flags, redPackets: flags, qzone: flags } } : {}) }],
    ...(enabled ? { tools: { qqActions: { gift: { enabled: true }, qzone: { enabled: true },
      redPackets: { enabled: true, allowExplicit: explicit, allowPasswordSend: true } } } } : {}),
    textGroups: [{ connectionId: 'main', conversationId: String(GROUP), tools: grant ? qqTools : [] }],
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } }
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] })
  configText = JSON.stringify(raw); await writeFile(file, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, QQ_ACTIONS_MODEL_KEY: MODEL_KEY, QQ_ACTIONS_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', file, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  }
  const recordPatterns = { gift: 'agent:gift-display:v1:*', packet: 'agent:red-packet:v1:*', password: 'agent:red-packet:v1:*', qzone: 'agent:qzone:v1:source:*' }
  const records = async kind => Promise.all((await reader.keys(prefix + recordPatterns[kind])).map(async key => JSON.parse(await reader.get(key))))
  const receipt = message => prefix + 'agent:inbox:receipt:' + hash(JSON.stringify(['message', conversationKey, String(message.message_id)]))
  const queueEmpty = async () => {
    const keys = await reader.keys(prefix + 'agent:inbox:*'), queues = []
    for (const key of keys) if (await reader.type(key) === 'list') queues.push(key)
    return (await Promise.all(queues.map(key => reader.lLen(key)))).every(count => count === 0)
  }
  const effects = () => actions.filter(row => writes.includes(row.action) || row.action === 'send_group_msg' && textOf(row.params.message) === PASSWORD)
  const events = async () => (await files(path.join(dataDir, 'operations'))).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const drained = async message => { await waitFor(() => reader.exists(receipt(message)), 'human source admission'); await waitFor(queueEmpty, 'text inbox drained'); assert.deepEqual(errors, []) }
  const f = { actions, models, records, effects, events, drained, reader,
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(models.length, 0); assert.ok(actions.every(row => row.action === 'get_login_info')); assert.deepEqual(await reader.keys(prefix + '*'), [])
      await assert.rejects(stat(dataDir), { code: 'ENOENT' }); phase = 'run'; await this.restart()
    },
    async restart() {
      log = ''; websocket = undefined; launch(false)
      await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket?.readyState === websocket.OPEN }, 'CLI readiness')
    },
    emit(kind = 'gift', input = {}) {
      active = kind; confirm = input.confirm; caseModels = 0; held = undefined
      if ((kind === 'packet' || kind === 'password') && !sources.has(String(WALLET))) sources.set(String(WALLET), { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP,
        user_id: USER, sender: { user_id: USER, nickname: '真实红包作者' }, message_id: WALLET, time: Math.floor(Date.now() / 1000), message_seq: 702,
        message: [{ type: 'wallet', data: { pc_body: PC_BODY, string_index: PACKET_INDEX, msg_seq: '702', red_type: 2,
          ...(kind === 'password' ? { red_channel: 32 } : {}), title: PASSWORD } }] })
      const text = kind === 'gift' ? '请送给我一个香槟礼物。' : kind === 'qzone' ? '请发布一条你自己的空间说说，记录自己的日常。' : '请领取这个红包。'
      source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
        sender: { user_id: USER, nickname: 'QQ动作合成验收员', role: 'member' }, message_id: ++sequence, time: Math.floor(Date.now() / 1000),
        message: [...(kind === 'packet' || kind === 'password' ? [{ type: 'reply', data: { id: String(WALLET) } }] : []),
          { type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text } }] }
      sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source)); return source
    },
    async run(kind = 'gift', input = {}) {
      if (models.length) await delay(900) // the normal text-group 800ms throttle remains active
      const before = (await records(kind)).length, modelBefore = models.length, textBefore = actions.filter(row => row.action === 'send_group_msg').length
      const readyBefore = (await events()).filter(row => row.operation === 'text_qq_action' && row.code === 'tool_result_ready').length
      const message = this.emit(kind, input)
      await waitFor(() => models.length > modelBefore, 'one human model request')
      if (!allowed(toolFor(kind))) await waitFor(() => actions.filter(row => row.action === 'send_group_msg').length > textBefore, 'unavailable capability text')
      else if (input.confirm === false) await waitFor(async () => (await events()).filter(row => row.operation === 'text_qq_action' && row.code === 'tool_result_ready').length > readyBefore, 'local cancellation completes')
      else await waitFor(async () => (await records(kind)).slice(before).some(row => row.state === (unknown ? 'unknown' : 'confirmed')), 'durable native outcome', nativeOutcomeObservationMs)
      await drained(message); assert.equal(models.length, modelBefore + 1); assert.deepEqual(errors, []); return message
    },
    async cancelHeldModel() {
      await waitFor(() => held, 'held model response'); raw.tools.qqActions.gift.enabled = false; configText = JSON.stringify(raw); await writeFile(file, configText)
      if (!held.destroyed) held.end(completion(active, confirm)); await drained(source); await delay(300); assert.deepEqual(errors, [])
    },
    async revokeAfterPassword() {
      await waitFor(async () => (await records('password')).some(row => row.phase === 'password_confirmed' && row.passwordConfirmed), 'durable confirmed password', nativeOutcomeObservationMs)
      raw.tools.qqActions.redPackets.allowPasswordSend = false
      configText = JSON.stringify(raw)
      await writeFile(file + '.next', configText)
      await rename(file + '.next', file)
      await waitFor(async () => (await records('password')).some(row => row.state === 'cancelled'), 'confirmed password cancellation', nativeOutcomeObservationMs)
      await drained(source); assert.deepEqual(errors, [])
    },
    async replay(message = source) { websocket.send(JSON.stringify(message)); await delay(1000); await drained(message); assert.deepEqual(errors, []) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(file, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const stored = []; for (const key of await reader.keys(prefix + '*')) if (await reader.type(key) === 'string') stored.push(await reader.get(key))
      const permanent = log + await files(dataDir) + stored.join('\n') + JSON.stringify(models)
      for (const secret of [MODEL_KEY, QQ_TOKEN, PC_BODY, PACKET_INDEX]) for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(permanent.includes(value), false, 'native credentials must never reach logs, models or persistence')
      for (const kind of ['gift', 'packet']) for (const row of await records(kind)) { assert.equal(Object.hasOwn(row, 'messageId'), false); assert.equal(JSON.stringify(row).includes(PC_BODY), false) }
      assert.deepEqual(errors, [])
    },
  }
  return f
}

for (const [label, options] of [['host defaults off', { enabled: false, declared: false }], ['missing connection declaration', { declared: false }],
  ['connection booleans all false', { flags: false }], ['missing explicit group grant', { grant: false }]]) {
  test(`actual QQ actions CLI hides capabilities with ${label}`, { timeout: 60000 }, async t => {
    const f = await fixture(t, options); await f.start(); await f.run('gift')
    assert.deepEqual(f.effects(), []); for (const kind of ['gift', 'packet', 'qzone']) assert.deepEqual(await f.records(kind), [])
    await f.stop(); await f.clean()
  })
}

test('actual QQ actions CLI keeps explicit red-packet grant independent of enabled tool and native connection declaration', { timeout: 150_000 }, async t => {
  const f = await fixture(t, { explicit: false }); await f.start(); await f.run('packet')
  assert.deepEqual(f.effects(), []); assert.deepEqual(await f.records('packet'), []); assert.equal(names(f.models[0]).includes('grabRedBagTool'), false)
  await f.run('gift'); await f.run('qzone')
  assert.deepEqual(f.effects().map(row => row.action), ['send_packet', 'send_qzone_msg'])
  assert.equal(names(f.models[1]).includes('sendGiftTool'), true); assert.equal(names(f.models[2]).includes('qqZoneTool'), true)
  await f.stop(); await f.clean()
})

test('actual QQ actions CLI performs one gift display, own Qzone publish and two-phase password grab without extra messages', { timeout: 210000 }, async t => {
  const f = await fixture(t); await f.start()
  for (const kind of ['gift', 'qzone', 'password']) await f.run(kind)
  assert.deepEqual(f.effects().map(row => row.action), ['send_packet', 'send_qzone_msg', 'send_group_msg', 'grab_red_bag'])
  assert.equal(f.models.length, 3)
  const password = f.effects().find(row => row.action === 'send_group_msg'), grabbed = f.effects().find(row => row.action === 'grab_red_bag')
  assert.ok(grabbed.at - password.at >= 490, 'password must be confirmed before the 500ms grab barrier')
  assert.equal((await f.records('gift'))[0].state, 'confirmed'); assert.equal((await f.records('qzone'))[0].state, 'confirmed')
  const record = (await f.records('password'))[0]; assert.equal(record.state, 'confirmed'); assert.equal(record.passwordMessageId, '-98425'); assert.equal(record.amountFen, 567)
  assert.equal(f.actions.filter(row => row.action === 'send_group_msg').length, 1)
  await f.stop(); await f.clean()
})

for (const kind of ['gift', 'qzone']) test(`actual QQ actions CLI ${kind} unknown is single-shot and frozen after source replay and restart`, { timeout: 90_000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); const source = await f.run(kind)
  assert.equal(f.effects().length, 1); assert.equal((await f.records(kind))[0].state, 'unknown'); assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false)
  await f.replay(source); await f.stop(); await f.restart(); await f.replay(source)
  assert.equal(f.effects().length, 1); assert.equal(f.models.length, 1); assert.equal((await f.records(kind))[0].state, 'unknown')
  await f.stop(); await f.clean()
})

test('actual QQ actions CLI missing password messageId freezes the real packet for different human triggers and restart', { timeout: 120_000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); const source = await f.run('password')
  assert.deepEqual(f.effects().map(row => row.action), ['send_group_msg']); assert.equal((await f.records('password'))[0].phase, 'password_pending')
  const unknownResults = async () => (await f.events()).filter(row => row.operation === 'text_qq_action' &&
    row.code === 'tool_result_ready' && row.outcome === 'unknown').length
  const requestSamePacket = async () => {
    await delay(900) // let the prior turn clear the regular group throttle
    const previousResults = await unknownResults()
    const another = f.emit('password')
    await waitFor(async () => await unknownResults() > previousResults, 'unknown wallet result for a new request', nativeOutcomeObservationMs)
    await f.drained(another)
    assert.deepEqual(f.effects().map(row => row.action), ['send_group_msg'])
    const rows = await f.records('password')
    assert.equal(rows.length, 1); assert.equal(rows[0].state, 'unknown')
  }
  await requestSamePacket(); assert.equal(f.models.length, 2)
  await f.stop(); await f.restart(); await f.replay(source)
  assert.equal(f.effects().length, 1); assert.equal(f.models.length, 2)
  await requestSamePacket(); assert.equal(f.models.length, 3)
  await f.stop(); await f.clean()
})

test('actual QQ actions CLI confirm false cancels locally with no wallet reads, claim or native dispatch', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.start(); await f.run('password', { confirm: false })
  assert.deepEqual(f.effects(), []); assert.deepEqual(await f.records('password'), []); assert.equal(f.models.length, 1)
  assert.equal(f.actions.some(row => row.action === 'get_msg' && String(row.params.message_id) === String(WALLET)), false)
  assert.equal(f.actions.some(row => row.action === 'get_group_msg_history'), false)
  await f.stop(); await f.clean()
})

test('actual QQ actions CLI config withdrawal while the model is pending fences its late gift request', { timeout: 60000 }, async t => {
  const f = await fixture(t, { revokeModel: true }); await f.start(); f.emit('gift'); await f.cancelHeldModel()
  assert.deepEqual(f.effects(), []); assert.deepEqual(await f.records('gift'), []); assert.equal(f.models.length, 1)
  assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false)
  await f.stop(); await f.clean()
})

test('actual QQ actions CLI stops between a durably confirmed password and grab when its grant is revoked', { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.start(); f.emit('password'); await f.revokeAfterPassword()
  const row = (await f.records('password'))[0]; assert.equal(row.passwordConfirmed, true); assert.equal(row.grabbed, false); assert.equal(row.phase, 'password_confirmed')
  assert.deepEqual(f.effects().map(row => row.action), ['send_group_msg']); assert.equal(f.models.length, 1)
  await f.stop(); await f.clean()
})
