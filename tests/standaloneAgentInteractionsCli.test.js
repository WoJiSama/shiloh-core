import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// Actual CLI, Redis, WebSocket and HTTP model transport; native QQ and model
// behavior are local fixtures. This does not prove real QQ effects or display.
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), BOT = 19000417, USER = 330417, GROUP = 310417, QUOTED = 95417, OWN = 98417, MANAGED = 330419
const MODEL_KEY = 'INTERACTION_MODEL_PRIVATE_123456', QQ_TOKEN = 'INTERACTION_QQ_PRIVATE_123456'
const tools = ['pokeTool', 'likeTool', 'reactionTool'], nativeNames = ['send_group_poke', 'send_like', 'set_msg_emoji_like']
const nativeEffects = [...nativeNames, 'delete_msg', 'set_group_ban', 'set_group_whole_ban', 'set_group_card']
const managementCases = {
  mute: { tool: 'jinyanTool', text: `禁言${MANAGED}一分钟。`, args: { target: [String(MANAGED)], time: 60 } },
  unmute: { tool: 'jinyanTool', text: `解除${MANAGED}的禁言。`, args: { target: [String(MANAGED)], time: 0 } },
  whole: { tool: 'jinyanTool', text: '确认开启全体禁言。', args: { target: 'all', time: 300, confirm: true } },
  'whole-off': { tool: 'jinyanTool', text: '解除全体禁言。', args: { target: 'all', time: 0, confirm: true } },
  card: { tool: 'changeCardTool', text: `把${MANAGED}的群名片改成测试名片。`, args: { target: String(MANAGED), cardName: '测试名片' } },
  'clear-card': { tool: 'changeCardTool', text: `清空${MANAGED}的群名片。`, args: { target: String(MANAGED), cardName: '' } },
}
const completion = (name, args) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `interaction-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 8 } })
async function waitFor(probe, label, timeout = 25000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await probe()) return; await delay(25) }; assert.fail(`timed out: ${label}`) }
async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).map(item => {
    const file = path.join(directory, item.name); return item.isDirectory() ? files(file) : item.isFile() ? readFile(file, 'utf8') : ''
  }))).join('\n')
}
async function fixture(t, { enabled = true, unknown = false, revoke = false, grant = true, privateMode = false, friendRevoke = false, management = false, roleRevoke = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'interaction CLI requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'interaction-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const prefix = 'bl-agent:interaction-cli:', sources = new Map(), actions = [], models = [], errors = [], sockets = new WebSocketServer({ noServer: true })
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  let reader, child, exited, websocket, log = '', phase = 'check', active = 'poke', caseModels = 0, held, source, configText, friendCurrent = true, requesterCurrent = true
  const grantedTools = management ? [...tools, 'jinyanTool', 'changeCardTool'] : tools
  const args = () => managementCases[active]?.args ?? (active === 'poke' ? { times: unknown ? 3 : 1 } : active === 'like' ? { count: 3 } : active === 'recall' ? { message_id: String(OWN) } : { count: 1 })
  const tool = () => managementCases[active]?.tool ?? (active === 'recall' ? 'recallTool' : tools[['poke', 'like', 'reaction'].indexOf(active)])
  const member = id => ({ group_id: GROUP, user_id: id, nickname: id === USER ? '互动验收员' : id === BOT ? '互动验收机器人' : '管理目标', card: '',
    role: management && (id === BOT || id === USER && requesterCurrent) ? 'admin' : 'member' })
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/model/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${MODEL_KEY}`); assert.equal(phase, 'run')
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body)
      const names = (body.tools ?? []).map(item => item.function.name)
      if (++caseModels > 1) {
        assert.equal(roleRevoke, true, 'an interaction terminal result must not cause another model call or text confirmation')
        assert.equal(caseModels, 2); assert.deepEqual(names, [])
        response.end(JSON.stringify({ choices: [{ message: { content: '当前请求者已失去管理员权限，未执行。' } }] })); return
      }
      for (const name of [...tools, 'recallTool', 'jinyanTool', 'changeCardTool']) assert.equal(names.includes(name), enabled && grant && (privateMode ? ['likeTool', 'recallTool'].includes(name) : grantedTools.includes(name)), name)
      if (active === 'seed') { response.end(JSON.stringify({ choices: [{ message: { content: '这是一条稍后撤回的已确认消息。' } }] })); return }
      if (!enabled || !grant) { response.end(JSON.stringify({ choices: [{ message: { content: '本轮未启用互动工具。' } }] })); return }
      if (revoke) { held = response; return }
      if (friendRevoke) friendCurrent = false
      if (roleRevoke) requesterCurrent = false
      response.end(completion(tool(), args()))
    } catch (error) { errors.push(String(error)); if (!response.destroyed) response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', frame => {
    let echo
    try {
      const request = JSON.parse(String(frame)); echo = request.echo; const { action, params } = request; actions.push({ action, params }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '互动验收机器人' }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'source lookup must identify an owned group message') }
      else if (action === 'get_friend_list') { assert.equal(privateMode, true); data = friendCurrent ? [{ user_id: USER, nickname: '好友验收员' }] : [] }
      else if (action === 'get_group_member_list') {
        assert.equal(String(params.group_id), String(GROUP)); data = [member(USER), member(BOT), ...(management ? [member(MANAGED)] : [])]
      }
      else if (action === 'get_group_member_info') {
        assert.equal(String(params.group_id), String(GROUP)); assert.ok((management ? [USER, BOT, MANAGED] : [USER]).map(String).includes(String(params.user_id))); assert.equal(params.no_cache, true)
        data = member(Number(params.user_id))
      } else if (nativeEffects.includes(action)) {
        assert.equal(phase, 'run'); assert.equal(enabled && grant && !revoke && friendCurrent && requesterCurrent, true)
        if (action === 'send_group_poke') assert.deepEqual(params, { group_id: String(GROUP), user_id: String(USER) })
        else if (action === 'send_like') assert.deepEqual(params, { user_id: String(USER), times: 3 })
        else if (action === 'delete_msg') { assert.equal(privateMode, true); assert.deepEqual(params, { message_id: OWN }) }
        else if (action === 'set_group_ban') assert.deepEqual(params, { group_id: String(GROUP), user_id: String(MANAGED), duration: active === 'unmute' ? 0 : 60 })
        else if (action === 'set_group_whole_ban') assert.deepEqual(params, { group_id: String(GROUP), enable: active !== 'whole-off' })
        else if (action === 'set_group_card') assert.deepEqual(params, { group_id: String(GROUP), user_id: String(MANAGED), card: active === 'clear-card' ? '' : '测试名片' })
        else { assert.deepEqual(Object.keys(params).sort(), ['emoji_id', 'message_id']); assert.equal(params.message_id, String(QUOTED)); assert.match(params.emoji_id, /^\d+$/u) }
        if (unknown && (!privateMode || action === 'delete_msg')) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        // A non-message operation confirms without returning or inventing an ID.
        data = {}
      } else if (action === 'send_group_msg') {
        assert.ok(!enabled || !grant || roleRevoke, 'successful or uncertain interactions must not send extra text')
        assert.equal(String(params.group_id), String(GROUP)); data = { message_id: 98000 + actions.length }
      } else if (action === 'send_private_msg') {
        assert.equal(privateMode, true); assert.equal(String(params.user_id), String(USER)); assert.equal(Object.hasOwn(params, 'group_id'), false)
        assert.equal(active === 'seed' || !enabled || !grant, true, 'private interactions cannot send confirmation or uncertain-result text')
        data = { message_id: active === 'seed' ? OWN : 98000 + actions.length }
        if (active === 'seed') sources.set(String(OWN), { message_type: 'private', sub_type: 'friend', post_type: 'message_sent', message_sent_type: 'self',
          self_id: BOT, target_id: USER, user_id: BOT, sender: { user_id: BOT }, message_id: OWN, time: Math.floor(Date.now() / 1000), message: params.message })
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, echo })) }
  }) })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, models }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const file = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const raw = { version: 1, instance: 'interaction-cli', dataDir, model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'interaction-fixture', apiKeyEnv: 'INTERACTION_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'INTERACTION_QQ_TOKEN' }], ...(enabled ? { tools: { interactions: { enabled: true } } } : {}),
    textGroups: [{ connectionId: 'main', conversationId: String(GROUP), tools: grant ? grantedTools : [] }],
    ...(privateMode ? { privateChat: { enabled: true, allowTools: grant ? ['likeTool', 'recallTool'] : [] } } : {}),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } }
  configText = JSON.stringify(raw)
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' },
      ...(privateMode ? [{ connectionId: 'main', kind: 'private', conversationId: String(USER), agentId: 'daily' }] : [])] })
  await writeFile(file, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, INTERACTION_MODEL_KEY: MODEL_KEY, INTERACTION_QQ_TOKEN: QQ_TOKEN }
  const launch = check => { child = spawn(process.execPath, [entry, '--config', file, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes }) }
  const records = async () => Promise.all((await reader.keys(prefix + 'agent:interaction:v1:*')).map(async key => JSON.parse(await reader.get(key))))
  const queueEmpty = async () => {
    const queues = (await Promise.all(['group-text', 'private'].map(kind => reader.keys(prefix + `agent:inbox:${kind}:*`)))).flat()
    return (await Promise.all(queues.map(key => reader.lLen(key)))).every(count => count === 0)
  }
  const native = () => actions.filter(row => nativeEffects.includes(row.action))
  const admitQuoted = async () => {
    const before = models.length, quoted = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
      sender: { user_id: USER, nickname: '引用作者' }, message_id: QUOTED, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '可核验的当前群引用。' } }] }
    sources.set(String(QUOTED), quoted); websocket.send(JSON.stringify(quoted))
    const conversationKey = JSON.stringify(['qq', 'global', String(BOT), 'group', String(GROUP)])
    const receipt = prefix + 'agent:inbox:receipt:' + createHash('sha256').update(JSON.stringify(['message', conversationKey, String(QUOTED)])).digest('hex')
    await waitFor(() => reader.exists(receipt), 'quoted source admitted through WebSocket')
    await waitFor(queueEmpty, 'quoted source inbox drained')
    assert.equal(models.length, before, 'the non-directed quoted source must not wake the model'); assert.deepEqual(errors, [])
  }
  return { actions, models, records, native,
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check'); assert.equal(models.length, 0); assert.deepEqual(await reader.keys(prefix + '*'), [])
      await assert.rejects(stat(dataDir), { code: 'ENOENT' }); phase = 'run'; await this.restart()
    },
    async restart() { log = ''; websocket = undefined; launch(false); await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness') },
    async run(kind = 'poke') {
      if (management && models.length) await delay(900)
      active = kind; caseModels = 0; if (kind === 'reaction') await admitQuoted(); const before = (await records()).length
      source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER, sender: { user_id: USER, nickname: '互动验收员', ...(management ? { role: 'admin' } : {}) },
        message_id: 96000 + models.length, time: Math.floor(Date.now() / 1000), message: [...(kind === 'reaction' ? [{ type: 'reply', data: { id: String(QUOTED) } }] : []),
          { type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: managementCases[kind]?.text ?? (kind === 'poke' ? `请戳我${unknown ? 3 : 1}下。` : kind === 'like' ? '给我点3个赞。' : '给引用的消息贴一个表情。') } }] }
      sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source))
      if (revoke) {
        await waitFor(() => held, 'held model request'); raw.tools.interactions.enabled = false; configText = JSON.stringify(raw); await writeFile(file, configText)
        held.end(completion(tool(), args())); await delay(500)
      } else if (roleRevoke) await waitFor(() => actions.some(row => row.action === 'get_group_member_info' && String(row.params.user_id) === String(USER)), 'fresh requester revocation evidence')
      else if (enabled && grant) await waitFor(async () => (await records()).slice(before).some(row => row.state === (unknown ? 'unknown' : 'confirmed')), 'durable native result')
      else await waitFor(() => actions.some(row => row.action === 'send_group_msg'), 'disabled feature text response')
      await waitFor(queueEmpty, 'text inbox drained'); assert.deepEqual(errors, [])
    },
    async runPrivate(kind = 'like') {
      assert.equal(privateMode, true); active = kind; caseModels = 0
      const before = (await records()).length, modelBefore = models.length, sentBefore = actions.filter(row => row.action === 'send_private_msg').length
      const text = kind === 'seed' ? '先发一句稍后可撤回的话。' : kind === 'like' ? '给我点3个赞。' : `撤回你发的消息ID ${OWN}。`
      source = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: BOT, user_id: USER, sender: { user_id: USER, nickname: '好友验收员' },
        message_id: 96000 + models.length, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }
      sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source))
      await waitFor(() => models.length > modelBefore, 'private model request')
      if (kind === 'seed' || !enabled || !grant) await waitFor(() => actions.filter(row => row.action === 'send_private_msg').length > sentBefore, 'confirmed private text')
      else if (!friendRevoke) await waitFor(async () => {
        const rows = await records(); return rows.length > before && rows.every(row => row.state !== 'pending') && rows.some(row => row.state === (unknown && kind === 'recall' ? 'unknown' : 'confirmed'))
      }, 'durable private native result')
      const conversationKey = JSON.stringify(['qq', 'global', String(BOT), 'private', String(USER)])
      const receipt = prefix + 'agent:inbox:receipt:' + createHash('sha256').update(JSON.stringify(['message', conversationKey, String(source.message_id)])).digest('hex')
      await waitFor(() => reader.exists(receipt), 'private source admission'); await waitFor(queueEmpty, 'private inbox drained'); assert.deepEqual(errors, [])
    },
    async replay() { websocket.send(JSON.stringify(source)); await delay(1200); await waitFor(queueEmpty, 'replayed text inbox drained'); assert.deepEqual(errors, []) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(file, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const strings = []; for (const key of await reader.keys(prefix + '*')) if (await reader.type(key) === 'string') strings.push(await reader.get(key))
      const stored = log + await files(dataDir) + strings.join('\n') + JSON.stringify(models)
      for (const secret of [MODEL_KEY, QQ_TOKEN]) for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(stored.includes(value), false)
      for (const record of await records()) assert.equal(Object.hasOwn(record, 'messageId'), false)
    },
  }
}

test('actual CLI group text performs three native interactions with exact parameters and no message ID or extra text', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.start()
  for (const kind of ['poke', 'like', 'reaction']) await f.run(kind)
  assert.deepEqual(f.native().map(row => row.action), nativeNames); assert.equal(f.models.length, 3)
  assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false); assert.equal((await f.records()).length, 3)
  assert.ok((await f.records()).every(row => row.state === 'confirmed'))
  await f.stop(); await f.clean()
})

test('actual CLI uncertain interaction freezes the remaining plan and same source across replay and restart', { timeout: 60000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); await f.run()
  assert.equal(f.native().length, 1); assert.equal(f.models.length, 1)
  assert.equal((await f.records())[0].state, 'unknown'); assert.equal((await f.records())[0].requested, 3)
  await f.replay(); await f.stop(); await f.restart(); await f.replay()
  assert.equal(f.native().length, 1); assert.equal(f.models.length, 1); assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false)
  await f.stop(); await f.clean()
})

for (const options of [{ enabled: false }, { grant: false }]) test(`actual CLI interactions stay unavailable for ${options.enabled === false ? 'default-off feature' : 'ungranted text group'}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, options); await f.start(); await f.run()
  assert.deepEqual(f.native(), []); assert.deepEqual(await f.records(), []); assert.equal(f.models.length, 1)
  await f.stop(); await f.clean()
})

test('actual CLI interaction is cancelled when host configuration revokes authority during the model request', { timeout: 60000 }, async t => {
  const f = await fixture(t, { revoke: true }); await f.start(); await f.run()
  assert.deepEqual(f.native(), []); assert.equal(f.models.length, 1); assert.equal((await f.records()).some(row => row.state === 'confirmed'), false)
  await f.stop(); await f.clean()
})

test('actual CLI current friend likes and recalls a previously confirmed self message without extra text', { timeout: 60000 }, async t => {
  const f = await fixture(t, { privateMode: true }); await f.start(); await f.runPrivate('seed'); await f.runPrivate('like'); await f.runPrivate('recall')
  assert.deepEqual(f.native().map(row => row.action), ['send_like', 'delete_msg']); assert.equal(f.models.length, 3)
  assert.equal(f.actions.filter(row => row.action === 'send_private_msg').length, 1)
  assert.ok(f.actions.filter(row => row.action === 'get_msg').some(row => String(row.params.message_id) === String(OWN)))
  assert.ok(f.actions.some(row => row.action === 'get_friend_list')); assert.ok((await f.records()).every(row => row.state === 'confirmed'))
  await f.replay(); await f.stop(); await f.restart(); await f.replay()
  assert.equal(f.native().length, 2); assert.equal(f.models.length, 3); await f.stop(); await f.clean()
})

test('actual CLI unknown self recall freezes its current friend source across replay and restart', { timeout: 60000 }, async t => {
  const f = await fixture(t, { privateMode: true, unknown: true }); await f.start(); await f.runPrivate('seed'); await f.runPrivate('recall')
  assert.deepEqual(f.native().map(row => row.action), ['delete_msg']); assert.equal((await f.records())[0].state, 'unknown')
  await f.replay(); await f.stop(); await f.restart(); await f.replay()
  assert.equal(f.native().length, 1); assert.equal(f.models.length, 2); assert.equal(f.actions.filter(row => row.action === 'send_private_msg').length, 1)
  await f.stop(); await f.clean()
})

test('actual CLI private tools remain absent without explicit friend grants', { timeout: 60000 }, async t => {
  const f = await fixture(t, { privateMode: true, grant: false }); await f.start(); await f.runPrivate('like')
  assert.deepEqual(f.native(), []); assert.deepEqual(await f.records(), []); assert.equal(f.models.length, 1)
  await f.stop(); await f.clean()
})

test('actual CLI a removed friend cannot authorize a like after the model response', { timeout: 60000 }, async t => {
  const f = await fixture(t, { privateMode: true, friendRevoke: true }); await f.start(); await f.runPrivate('like')
  assert.deepEqual(f.native(), []); assert.equal(f.models.length, 1); assert.equal(f.actions.some(row => row.action === 'send_private_msg'), false)
  assert.equal((await f.records()).some(row => row.state === 'confirmed'), false); await f.stop(); await f.clean()
})

test('actual CLI group management confirms mute, unmute, whole switch and card edit or clear without extra messages', { timeout: 90000 }, async t => {
  const f = await fixture(t, { management: true }); await f.start()
  for (const kind of ['mute', 'unmute', 'whole', 'whole-off', 'card', 'clear-card']) await f.run(kind)
  assert.deepEqual(f.native().map(row => row.action), ['set_group_ban', 'set_group_ban', 'set_group_whole_ban', 'set_group_whole_ban', 'set_group_card', 'set_group_card'])
  assert.equal(f.models.length, 6); assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false)
  assert.equal((await f.records()).length, 6); assert.ok((await f.records()).every(row => row.state === 'confirmed' && row.completed === 1))
  await f.stop(); await f.clean()
})

test('actual CLI a stale ingress admin cannot manage the group after fresh requester demotion', { timeout: 60000 }, async t => {
  const f = await fixture(t, { management: true, roleRevoke: true }); await f.start(); await f.run('mute')
  assert.deepEqual(f.native(), []); assert.ok(f.models.length >= 1 && f.models.length <= 2)
  assert.equal((await f.records()).some(row => row.state === 'confirmed'), false)
  await f.stop(); await f.clean()
})

test('actual CLI unknown group mute is frozen across source replay and restart without fallback text', { timeout: 60000 }, async t => {
  const f = await fixture(t, { management: true, unknown: true }); await f.start(); await f.run('mute')
  assert.deepEqual(f.native().map(row => row.action), ['set_group_ban']); assert.equal((await f.records())[0].state, 'unknown')
  await f.replay(); await f.stop(); await f.restart(); await f.replay()
  assert.equal(f.native().length, 1); assert.equal(f.models.length, 1); assert.equal(f.actions.some(row => row.action === 'send_group_msg'), false)
  await f.stop(); await f.clean()
})

for (const options of [{ enabled: false }, { grant: false }]) test(`actual CLI group management stays absent for ${options.enabled === false ? 'default-off' : 'missing explicit group grant'}`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { management: true, ...options }); await f.start(); await f.run('mute')
  assert.deepEqual(f.native(), []); assert.deepEqual(await f.records(), [])
  await f.stop(); await f.clean()
})
