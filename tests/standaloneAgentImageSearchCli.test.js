import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const preload = fileURLToPath(new URL('./helpers/imageSearchPreload.mjs', import.meta.url))
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const BOT = 19000931, USER = 330931, GROUP = 310931, OTHER_GROUP = 310932
const KEY = 'IMAGE_SEARCH_MODEL_PRIVATE_KEY_20261119', TOKEN = 'IMAGE_SEARCH_QQ_PRIVATE_TOKEN_20261119'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const scopeFor = group => simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(group) })
const completion = (name, args, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 15 } })
async function waitFor(probe, label, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(25) }
  assert.fail('timed out: ' + label)
}

test('real CLI searches fixed image sources and delivers one bound image or one unknown bundle without retry', { timeout: 90000 }, async t => {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0)
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-image-search-cli-')), socketPath = path.join(directory, 'redis.sock')
  const instance = 'image-search-cli', prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), sources = new Map(), external = [], models = [], results = [], deliveries = [], errors = []
  let child, exited, reader, peer, log = '', epoch = 0, turn, finished = false
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const part of req) chunks.push(part)
      if (req.url === '/provider') {
        const url = new URL(decodeURIComponent(req.headers['x-image-source-url'])), body = Buffer.concat(chunks).toString()
        assert.equal(req.headers['x-image-pinned'], '93.184.216.34'); assert.equal(req.headers.authorization, undefined)
        for (const secret of [KEY, TOKEN, 'GROUP_ONLY_CONTEXT']) assert.equal((url.href + body + JSON.stringify(req.headers)).includes(secret), false)
        external.push({ url: url.href, method: req.method })
        if (url.hostname === 'images.example.test') {
          assert.equal(req.method, 'GET'); const bytes = Buffer.from(PNG, 'base64')
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) }).end(bytes); return
        }
        let payload
        if (url.hostname === 'www.duitang.com') {
          assert.equal(url.searchParams.get('kw'), '合成表情'); assert.equal(req.method, 'GET')
          payload = { data: { object_list: [{ photo: { path: 'https://images.example.test/emoji.png' } }] } }
        } else if (url.hostname === 'wallpaper.soutushenqi.com') {
          assert.equal(req.method, 'POST'); assert.equal(new URLSearchParams(body).get('search_word'), '合成风景')
          payload = { data: [{ largeUrl: 'https://images.example.test/first.png' }, { largeUrl: 'https://images.example.test/second.png' }] }
        } else assert.fail('unexpected metadata origin')
        const bytes = Buffer.from(JSON.stringify(payload))
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length) }).end(bytes); return
      }
      assert.equal(req.url, '/model/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${KEY}`)
      const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body); assert.ok(turn)
      const names = body.tools.map(row => row.function.name)
      for (const name of ['emojiSearchTool', 'bingImageSearchTool']) assert.ok(names.includes(name))
      const tool = id => body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `${epoch}-${id}`)
      const first = tool('first'), retry = tool('retry')
      for (const result of [first, retry]) if (result && !results.some(row => row.tool_call_id === result.tool_call_id)) results.push(result)
      if (finished) { res.end(completion('simDecide', { decision: 'silent', reason: '本轮已结束' }, `${epoch}-decide`)); return }
      if (retry || first && !turn.unknown) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '图片回执已读取' }, `${epoch}-finish`)); return }
      res.end(completion(turn.tool, turn.input, `${epoch}-${first ? 'retry' : 'first'}`))
    } catch (error) { errors.push(String(error)); if (!res.destroyed) res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, client => sockets.emit('connection', client))
  })
  sockets.on('connection', client => {
    peer = client
    client.on('message', frame => {
      let echo
      try {
        const request = JSON.parse(String(frame)); echo = request.echo
        const { action, params } = request; let data
        if (action === 'get_login_info') data = { user_id: BOT, nickname: '找图验收账号' }
        else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data) }
        else if (action === 'send_group_msg' || action === 'send_group_forward_msg') {
          assert.equal(Number(params.group_id), turn.group); deliveries.push({ action, params, epoch })
          if (turn.unknown) { client.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
          data = { message_id: 98800 + deliveries.length }
        } else assert.fail('unexpected QQ action: ' + action)
        client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo) client.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, external, results, deliveries })) }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const client of sockets.clients) client.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const configText = JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'image-search-fixture', apiKeyEnv: 'IMAGE_SEARCH_MODEL_KEY' },
    tools: { imageSearch: { emoji: { enabled: true }, bing: { enabled: true } } },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'IMAGE_SEARCH_QQ_TOKEN' }],
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } },
  })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [GROUP, OTHER_GROUP].map(group => ({ connectionId: 'main', kind: 'group', conversationId: String(group), agentId: 'daily' })),
  })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(release, 'scripts/start-agent.mjs'), '--config', configFile], {
    cwd: directory, env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, IMAGE_SEARCH_MODEL_KEY: KEY, IMAGE_SEARCH_QQ_TOKEN: TOKEN,
      IMAGE_SEARCH_AUDIT_ORIGIN: `http://127.0.0.1:${port}` },
  })
  exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  await waitFor(() => { if (child.exitCode !== null) assert.fail('CLI exited early: ' + log); return peer && log.includes('已启动') }, 'CLI readiness')
  async function run(next) {
    turn = next; finished = false; epoch++
    const original = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: next.group, user_id: USER,
      message_id: 98900 + epoch, time: Math.floor(Date.now() / 1000), sender: { user_id: USER, nickname: '找图验收员' },
      message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: '找图验收，GROUP_ONLY_CONTEXT 不得交给图片服务。' } }],
    }
    sources.set(String(original.message_id), original); peer.send(JSON.stringify(original))
    await waitFor(() => finished, 'model reads image result')
    await waitFor(async () => {
      const scope = scopeFor(next.group), state = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
      return state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope))
    }, 'turn drained')
    assert.deepEqual(errors, [])
  }
  await run({ group: GROUP, tool: 'emojiSearchTool', input: { keyword: '合成表情', count: 1 } })
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].action, 'send_group_msg')
  assert.deepEqual(deliveries[0].params.message, [{ type: 'image', data: { file: 'base64://' + PNG } }])
  assert.match(results.find(row => row.tool_call_id === '1-first').content, /已确认.*1.*图片/u)
  await run({ group: OTHER_GROUP, tool: 'bingImageSearchTool', input: { query: '合成风景', count: 2 }, unknown: true })
  assert.equal(deliveries.length, 2); assert.equal(deliveries[1].action, 'send_group_forward_msg')
  assert.equal(deliveries[1].params.messages.length, 2)
  for (const node of deliveries[1].params.messages) assert.deepEqual(node.data.content, [{ type: 'image', data: { file: 'base64://' + PNG } }])
  assert.match(results.find(row => row.tool_call_id === '2-first').content, /unknown|尚未确认/u)
  assert.match(results.find(row => row.tool_call_id === '2-retry').content, /结果未知.*禁止重复/u)
  assert.equal(external.filter(row => new URL(row.url).hostname === 'wallpaper.soutushenqi.com').length, 1, 'unknown cannot rerun search or delivery')
  assert.equal(external.filter(row => new URL(row.url).hostname === 'images.example.test').length, 3)
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
  assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
  for (const secret of [KEY, TOKEN]) assert.equal((log + JSON.stringify(models) + JSON.stringify(results) + JSON.stringify(deliveries)).includes(secret), false)
  assert.equal(JSON.stringify(results).includes('images.example.test'), false)
  assert.deepEqual(errors, [])
})
