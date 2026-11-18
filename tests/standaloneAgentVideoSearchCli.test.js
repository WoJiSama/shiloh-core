import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/videoSearchPreload.mjs', import.meta.url))
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const BOT = 19000831, USER = 330831, GROUP = 310831, UNKNOWN_GROUP = 310832, BV = 'BV1xx411c7mD', BV2 = 'BV1xx411c7mE'
const KEY = 'VIDEO_SEARCH_CLI_MODEL_PRIVATE_12345', TOKEN = 'VIDEO_SEARCH_CLI_ONEBOT_PRIVATE_12345', BUVID = 'VIDEO_SEARCH_CLI_BUVID_PRIVATE_12345'
const PAGE = `https://www.bilibili.com/video/${BV}`
const scopeFor = group => simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(group) })
const completion = (name, input, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { total_tokens: 15 } })
async function waitFor(probe, label, timeout = 25000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await probe()) return; await delay(25) }; assert.fail(`timed out: ${label}`) }
async function files(directory) { const result = []; for (const item of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) { const file = path.join(directory, item.name); if (item.isDirectory()) result.push(await files(file)); else if (item.isFile()) result.push(await readFile(file, 'utf8')) }; return result.join('\n') }
async function redisText(reader, prefix) { const result = []; for (const key of await reader.keys(prefix + '*')) { const type = await reader.type(key), value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key) : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : null; result.push(JSON.stringify({ key, value })) }; return result.join('\n') }
async function fixture(t, enabled, { holdSearch = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'video search CLI requires real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-search-cli-')), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const instance = 'video-search-cli-' + (enabled ? 'on' : 'off'), prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), external = [], sources = new Map(), lookups = [], deliveries = [], models = [], toolResults = [], errors = []
  let child, exited, reader, websocket, log = '', phase = 'check', epoch = 0, turn, finished = false, configCurrent = true, cancelledSearches = 0
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/audit/request') {
        const url = new URL(decodeURIComponent(req.headers['x-video-source-url'])); external.push(url.href)
        assert.equal(enabled, true); assert.equal(req.method, 'GET'); assert.equal(req.headers['x-video-pinned'], '93.184.216.34'); assert.equal(req.headers.authorization, undefined)
        assert.equal(req.headers.referer, 'https://www.bilibili.com/'); assert.equal(url.hostname, 'api.bilibili.com')
        for (const value of [KEY, TOKEN, String(BOT), String(GROUP), String(UNKNOWN_GROUP), '群内隐私']) assert.equal(JSON.stringify(req.headers).includes(value), false)
        let payload
        if (url.pathname === '/x/frontend/finger/spi') { assert.equal(req.headers.cookie, undefined); payload = { code: 0, data: { b_3: BUVID } } }
        else {
          assert.equal(req.headers.cookie, `buvid3=${BUVID}`)
          assert.equal(url.pathname, '/x/web-interface/search/type'); assert.equal(url.searchParams.get('keyword'), '合成视频'); assert.equal(url.searchParams.get('order'), 'totalrank')
          assert.equal(url.searchParams.get('search_type'), 'video'); assert.equal(url.searchParams.get('page'), '1')
          if (holdSearch) { res.once('close', () => { if (!res.writableEnded) cancelledSearches++ }); return }
          payload = { code: 0, data: { result: [
            { bvid: BV, title: '<em class="keyword">合成</em>视频首选', author: '合成作者', duration: '02:03' },
            { bvid: BV2, title: '合成视频次选', author: '另一作者', duration: '00:45' },
          ] } }
        }
        const bytes = Buffer.from(JSON.stringify(payload)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length) }).end(bytes); return
      }
      assert.equal(req.url, '/model/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${KEY}`)
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body); assert.equal(phase, 'run'); assert.ok(turn)
      if (!configCurrent) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '配置修订后结束本轮' }, `${epoch}-cancelled`)); return }
      const names = body.tools.map(row => row.function.name); for (const name of ['searchVideoTool', 'videoShareTool']) assert.equal(names.includes(name), enabled)
      const result = id => body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `${epoch}-${id}`), first = result('first'), retry = result('retry'), fallback = result('fallback')
      for (const value of [first, retry, fallback]) if (value && !toolResults.some(row => row.tool_call_id === value.tool_call_id)) toolResults.push(value)
      if (finished) { res.end(completion('simDecide', { decision: 'silent', reason: '本轮已完成' }, `${epoch}-decide`)); return }
      if (fallback || first && !turn.unknown) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '视频工具结果已读取' }, `${epoch}-finish`)); return }
      if (retry) { res.end(completion('simSendMessage', { continuation: 'chat', messages: ['未知发送后的补发必须禁止。'] }, `${epoch}-fallback`)); return }
      if (first && turn.unknown) { res.end(completion('videoShareTool', turn.input, `${epoch}-retry`)); return }
      assert.ok(body.messages.some(row => row.role === 'user' && String(row.content).includes(turn.text)))
      res.end(completion(enabled ? turn.tool : 'simSendMessage', enabled ? turn.input : { continuation: 'chat', messages: ['本轮未开放视频搜索。'] }, `${epoch}-first`))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => { if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${TOKEN}`) { socket.destroy(); return }; sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer)) })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', frame => {
    let echo
    try {
      const { action, params, echo: tag } = JSON.parse(String(frame)); echo = tag; let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '视频搜索验收机器人' }
      else if (action === 'get_msg') { lookups.push(String(params.message_id)); data = sources.get(String(params.message_id)); assert.ok(data) }
      else if (action === 'send_group_msg') {
        assert.equal(String(params.group_id), String(turn.group ?? GROUP)); deliveries.push({ epoch, params })
        if (enabled) {
          assert.equal(params.message.length, 1); assert.equal(params.message[0].type, 'json'); const card = JSON.parse(params.message[0].data.data)
          assert.equal(card.app, 'com.bilibili.app'); assert.equal(card.view, 'min'); assert.equal(card.meta.detail_1.qqdocurl, PAGE); assert.equal(card.meta.detail_1.desc, '合成视频首选'); assert.equal(card.meta.detail_1.author, '合成作者'); assert.equal(card.meta.detail_1.duration, 123)
          assert.equal(JSON.stringify(card).includes('preview'), false)
        } else assert.ok(params.message.some(row => row.type === 'text' && row.data.text === '本轮未开放视频搜索。'))
        if (turn.unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        data = { message_id: 98000 + deliveries.length }
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
  }) })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, external, lookups, deliveries, toolResults, modelRequests: models.length })) }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness'); reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const configText = JSON.stringify({ version: 1, instance, dataDir, model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'video-search-fixture', apiKeyEnv: 'VIDEO_SEARCH_MODEL_KEY' }, connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'VIDEO_SEARCH_QQ_TOKEN' }], tools: { videoSearch: { enabled } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false }, simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }], bindings: [GROUP, UNKNOWN_GROUP].map(group => ({ connectionId: 'main', kind: 'group', conversationId: String(group), agentId: 'daily' })) })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, VIDEO_SEARCH_MODEL_KEY: KEY, VIDEO_SEARCH_QQ_TOKEN: TOKEN, VIDEO_SEARCH_AUDIT_URL: `http://127.0.0.1:${port}/audit` }
  const launch = check => { child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes }) }
  const drained = async () => { const scope = scopeFor(turn?.group ?? GROUP), state = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null'); return state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope)) }
  const ingress = next => { epoch++; turn = next; finished = false; const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: next.group ?? GROUP, user_id: USER, sender: { user_id: USER, nickname: '视频搜索验收员' }, message_id: 98100 + epoch, time: Math.floor(Date.now() / 1000), message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: next.text } }], raw_message: next.text }; sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source)); return source }
  let currentConfigText = configText
  return { external, deliveries, models, toolResults, lookups, reader, prefix, ingress, get cancelledSearches() { return cancelledSearches },
    async start() { launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check'); assert.deepEqual(external, []); assert.equal(models.length, 0); assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' }); log = ''; phase = 'run'; launch(false); await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness') },
    async run(next) { const source = ingress(next); await waitFor(() => finished, 'model consumed video result'); await waitFor(drained, 'simulation drained'); assert.deepEqual(errors, []); return source },
    async invalidate() { configCurrent = false; currentConfigText = configText + '\n# active revision invalidated\n'; await writeFile(configFile, currentConfigText) },
    async settled() { return !await reader.exists(prefix + simulationBusyKey(scopeFor(turn?.group ?? GROUP))) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() { assert.equal(await readFile(configFile, 'utf8'), currentConfigText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText); const content = log + await files(dataDir) + await redisText(reader, prefix) + JSON.stringify(models); for (const secret of [KEY, TOKEN, BUVID]) for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) assert.equal(content.includes(value), false, 'diagnostics, storage and models exclude credentials and anonymous cookies') },
  }
}

test('actual CLI video search returns source-backed relevance order then a separate request shares one card and freezes unknown retry/fallback', { timeout: 90000 }, async t => {
  const f = await fixture(t, true); await f.start()
  const original = await f.run({ tool: 'searchVideoTool', input: { keyword: '合成视频' }, text: '请搜索B站合成视频。群内隐私不要发送给外部。' })
  assert.equal(f.deliveries.length, 0, 'search does not share a native card'); const result = f.toolResults.find(row => row.tool_call_id === '1-first').content
  assert.ok(result.indexOf(BV) < result.indexOf(BV2), result); assert.ok(result.includes('合成视频首选')); assert.equal(result.includes('<em'), false)
  await f.run({ tool: 'videoShareTool', input: { index: 1 }, text: '请发送刚才搜索列表的第1项视频卡片。' }); assert.equal(f.deliveries.length, 1); assert.ok(f.lookups.includes(String(original.message_id)))
  // The prior group's confirmed card is still under its real 20 minute cooldown.
  // A separately bound conversation exercises an actual uncertain native send.
  await f.run({ group: UNKNOWN_GROUP, tool: 'videoShareTool', input: { query: '合成视频' }, unknown: true, text: '请按关键词合成视频直接分享首选视频卡片。' })
  assert.equal(f.deliveries.length, 2); assert.equal(f.toolResults.filter(row => row.tool_call_id.startsWith('3-')).length, 3)
  assert.deepEqual(f.deliveries.map(row => [row.epoch, String(row.params.group_id), row.params.message[0].type]), [[2, String(GROUP), 'json'], [3, String(UNKNOWN_GROUP), 'json']])
  assert.equal(JSON.parse(f.toolResults.find(row => row.tool_call_id === '3-first').content.split('\n')[0]).status, 'unknown')
  for (const id of ['3-retry', '3-fallback']) assert.match(f.toolResults.find(row => row.tool_call_id === id).content, /^error: .*结果未知.*禁止重复提交或发送/u)
  assert.ok(f.toolResults.filter(row => row.tool_call_id.startsWith('3-')).every(row => /unknown|未知|未确认|尚未确认|重发|补发/u.test(String(row.content))))
  await f.stop(); await f.clean()
})
test('actual CLI disabled video search exposes no tools and performs no public metadata request', { timeout: 60000 }, async t => {
  const f = await fixture(t, false); await f.start(); await f.run({ text: '只确认本轮没有开放视频搜索。' }); assert.deepEqual(f.external, []); assert.equal(f.deliveries.length, 1); await f.stop(); await f.clean()
})
test('actual CLI host revision revokes a pending video search socket before any card can be sent', { timeout: 60000 }, async t => {
  const f = await fixture(t, true, { holdSearch: true }); await f.start(); f.ingress({ tool: 'searchVideoTool', input: { keyword: '合成视频' }, text: '请搜索B站合成视频，测试配置变更取消。' })
  await waitFor(() => f.external.some(value => new URL(value).pathname.endsWith('/search/type')), 'pending official search')
  await f.invalidate(); await waitFor(() => f.cancelledSearches === 1, 'native HTTP cancelled'); await waitFor(f.settled, 'cancelled turn settles'); assert.equal(f.deliveries.length, 0); await f.stop(); await f.clean()
})
