import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import sharp from 'sharp'
import { WebSocketServer } from 'ws'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const preload = fileURLToPath(new URL('./helpers/lifeEmojiPreload.mjs', import.meta.url))
const sourceLoader = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationBusyKey, simulationSessionKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const BOT = 19000941, USER = 330941, GROUP = 310941, OTHER_GROUP = 310942
const KEY = 'LIFE_EMOJI_MODEL_PRIVATE_KEY_20261119', TOKEN = 'LIFE_EMOJI_QQ_PRIVATE_TOKEN_20261119'
const hash = value => createHash('sha256').update(value).digest('hex')
const scopeFor = group => simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(group) })
const completion = (name, args, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 15 } })
async function waitFor(probe, label, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(25) }
  assert.fail('timed out: ' + label)
}
async function fixture(t, { emoji = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0)
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-life-emoji-cli-')), socketPath = path.join(directory, 'redis.sock')
  const instance = 'life-emoji-cli', prefix = `bl-agent:${instance}:`, dataDir = path.join(directory, 'data')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), sources = new Map(), external = [], models = [], emojiModels = [], results = [], deliveries = [], reads = [], errors = []
  const pixels = Buffer.from(Array.from({ length: 128 * 128 * 3 }, (_, index) => (index * 73 + Math.floor(index / 97) * 31) % 256))
  const image = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer(), base64 = image.toString('base64')
  let child, exited, reader, monitor, peer, log = '', epoch = 0, turn, finished = false
  const redisTrace = []
  const respond = (res, payload) => { const bytes = Buffer.from(JSON.stringify(payload)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.length) }).end(bytes) }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const part of req) chunks.push(part)
      if (req.url === '/provider') {
        const url = new URL(decodeURIComponent(req.headers['x-life-source-url']))
        assert.equal(req.method, 'GET'); assert.equal(url.origin, 'https://api.bilibili.com')
        assert.equal(req.headers['x-life-pinned'], '93.184.216.34'); assert.equal(req.headers.authorization, undefined)
        for (const secret of [KEY, TOKEN, 'GROUP_ONLY_CONTEXT']) assert.equal((url.href + JSON.stringify(req.headers)).includes(secret), false)
        external.push({ url: url.href, cookie: req.headers.cookie })
        if (url.pathname === '/x/frontend/finger/spi') { assert.equal(req.headers.cookie, undefined); respond(res, { code: 0, data: { b_3: 'FIXTURE_BUVID_3', b_4: 'FIXTURE_BUVID_4' } }); return }
        assert.equal(req.headers.cookie, 'buvid3=FIXTURE_BUVID_3; buvid4=FIXTURE_BUVID_4')
        if (url.pathname === '/x/web-interface/search/type') {
          assert.deepEqual(Object.fromEntries(url.searchParams), { keyword: '真实番剧', search_type: 'media_bangumi' })
          respond(res, { code: 0, data: { result: [{ season_id: 12345, title: '真实番剧' }] } }); return
        }
        if (url.pathname === '/pgc/view/web/season') {
          assert.equal(url.searchParams.get('season_id'), '12345')
          respond(res, { code: 0, result: { season_id: 12345, episodes: [{ title: '12', long_title: '向着明天', pub_time: 1795014000, aid: 1234567 }] } }); return
        }
        assert.equal(url.pathname, '/x/v2/reply'); assert.deepEqual(Object.fromEntries(url.searchParams), { type: '1', oid: '1234567', sort: '1', ps: '5' })
        respond(res, { code: 0, data: { replies: [{ like: 27, content: { message: '真实观众意见' } }] } }); return
      }
      assert.equal(req.headers.authorization, `Bearer ${KEY}`)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (req.url.startsWith('/emoji/')) {
        emojiModels.push({ path: req.url, body })
        if (req.url === '/emoji/v1/embeddings') { assert.equal(body.model, 'emoji-embedding'); respond(res, { data: [{ embedding: [0.1, 0.4, 0.8] }] }); return }
        assert.equal(req.url, '/emoji/v1/chat/completions'); assert.equal(body.model, 'emoji-analysis')
        assert.ok(body.messages[0].content.some(part => part.type === 'image_url'))
        const verdict = body.messages[0].content[0].text.includes('判定一')
        respond(res, { choices: [{ message: { content: JSON.stringify(verdict ? { is_emoji: true, safe: true, confidence: 0.99, reason: '本地图可收藏' }
          : { description: '猫猫开心大笑', tags: ['开心', '笑死'], use_cases: ['分享快乐', '接梗吐槽'] }) } }] }); return
      }
      assert.equal(req.url, '/model/v1/chat/completions'); assert.ok(turn); models.push(body)
      const owned = body.messages.filter(row => row.role === 'tool' && row.tool_call_id?.startsWith(`${epoch}-`))
      for (const result of owned) if (!results.some(row => row.tool_call_id === result.tool_call_id)) results.push(result)
      const first = owned.find(row => row.tool_call_id === `${epoch}-0`)
      let index = owned.length
      if (turn.unknown && first && !owned.some(row => row.tool_call_id === `${epoch}-1`)) index = 1
      const script = turn.script
      if (index >= script.length) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '真实工具回执已读取' }, `${epoch}-finish`)); return }
      const next = script[index]
      assert.ok(body.tools.some(row => row.function.name === next.name), next.name)
      const args = next.name === 'simCollectSticker' ? { seq: turn.seq } : next.args
      res.end(completion(next.name, args, `${epoch}-${index}`))
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
        if (action === 'get_login_info') data = { user_id: BOT, nickname: '生活线表情验收账号' }
        else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data); reads.push(String(params.message_id)) }
        else if (action === 'send_group_msg' || action === 'send_group_forward_msg') {
          assert.equal(Number(params.group_id), turn.group); deliveries.push({ action, params, epoch })
          if (turn.unknown) { client.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
          data = { message_id: 98700 + deliveries.length }
        } else assert.fail('unexpected QQ action: ' + action)
        client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo) client.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, external, results, redisTrace,
      deliveries: deliveries.map(({ action, params, epoch }) => ({ action, group: params.group_id, epoch })),
      emojiModels: emojiModels.map(row => ({ path: row.path, model: row.body.model })) })) }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const client of sockets.clients) client.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (monitor?.isOpen) monitor.destroy()
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  monitor = reader.duplicate(); monitor.on('error', () => {}); await monitor.connect()
  await monitor.monitor(line => {
    const args = String(line).match(/"(?:\\.|[^"\\])*"/gu) ?? []
    redisTrace.push(args[0] === '"EVAL"' ? 'EVAL' : args.slice(0, 2).join(' '))
    if (redisTrace.length > 48) redisTrace.shift()
  })
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const localEmoji = { enabled: true, config: { autoCollect: true, contentFiltration: true, visionTagOnAdd: true, useEmbedding: true,
    doReplace: false, sendAsSticker: true, avoidRecentEnabled: false, rateLimitEnabled: false, followUpDelayMinMs: 0, followUpDelayMaxMs: 0 },
    analysis: { baseUrl: `http://127.0.0.1:${port}/emoji/v1`, name: 'emoji-analysis', apiKeyEnv: 'LIFE_EMOJI_MODEL_KEY' },
    embedding: { baseUrl: `http://127.0.0.1:${port}/emoji/v1/embeddings`, name: 'emoji-embedding', apiKeyEnv: 'LIFE_EMOJI_MODEL_KEY' } }
  const configText = JSON.stringify({ version: 1, instance, dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'life-emoji-fixture', apiKeyEnv: 'LIFE_EMOJI_MODEL_KEY' },
    tools: emoji ? { localEmoji } : {}, connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'LIFE_EMOJI_QQ_TOKEN' }],
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0, maxWakePerMinute: 30, maxWakePerHour: 100 },
      reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false },
      userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false }, lifeThreads: { enabled: !emoji },
      turn: { minSendGapMs: 0, maxToolRounds: 8, maxTurnsPerDay: 100 }, toolPolicy: { mode: 'open' } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [GROUP, OTHER_GROUP].map(group => ({ connectionId: 'main', kind: 'group', conversationId: String(group), agentId: 'daily' })) })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const source = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
  const entry = source ? ['--input-type=module', '--eval', `const {importBilibiliHost:load}=await import(${JSON.stringify(sourceLoader)});const {main}=await load('bootstrap/standaloneAgent.js');await main(process.argv.slice(1));`, '--']
    : [path.join(release, 'scripts/start-agent.mjs')]
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...entry, '--config', configFile], { cwd: directory,
    env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, LIFE_EMOJI_MODEL_KEY: KEY, LIFE_EMOJI_QQ_TOKEN: TOKEN,
      LIFE_EMOJI_AUDIT_ORIGIN: `http://127.0.0.1:${port}`, LIFE_EMOJI_AUDIT_TRACE: '1' } })
  exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  await waitFor(() => { if (child.exitCode !== null) assert.fail('CLI exited early: ' + log); return peer && log.includes('已启动') }, 'CLI readiness')
  return { directory, dataDir, reader, prefix, image, base64, external, models, emojiModels, results, deliveries, reads, errors,
    async items() { return (await readFile(path.join(dataDir, 'emoji', 'agents', hash('daily'), 'emoji-packs.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) },
    async lifeThreads() { const keys = await reader.keys(prefix + '*:life-threads'); return keys.length ? JSON.parse(await reader.get(keys[0])) : [] },
    async run(next) {
      turn = { group: GROUP, ...next }; finished = false; epoch++
      const scope = scopeFor(turn.group), before = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
      turn.seq = (before?.seq ?? 0) + 1
      const original = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: turn.group, user_id: USER,
        message_id: 98600 + epoch, time: Math.floor(Date.now() / 1000), sender: { user_id: USER, nickname: '生活线表情验收员' },
        message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: '按当前授权验证。GROUP_ONLY_CONTEXT 只属于群聊。' } },
          ...(turn.image ? [{ type: 'image', data: { file: 'base64://' + base64 } }] : [])] }
      sources.set(String(original.message_id), original); peer.send(JSON.stringify(original))
      await waitFor(() => { if (child.exitCode !== null) assert.fail('CLI exited during turn: ' + log); return finished }, 'model reads tool result')
      await waitFor(async () => { const state = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null');
        return state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope)) }, 'turn drained')
      assert.deepEqual(errors, []); return { epoch, messageId: String(original.message_id) }
    },
    async close() {
      child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
      assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      for (const secret of [KEY, TOKEN]) assert.equal((log + JSON.stringify(models) + JSON.stringify(results) + JSON.stringify(deliveries)).includes(secret), false)
      assert.deepEqual(errors, [])
    } }
}

test('standalone CLI proves a QQ image, collects through VLM and embeddings, then sends sticker bundles once even after unknown', { timeout: 90000 }, async t => {
  const f = await fixture(t, { emoji: true })
  const automatic = await f.run({ image: true, script: [] })
  await waitFor(async () => { try { return (await f.items()).length === 1 } catch { return false } }, 'automatic QQ ingress collection')
  assert.ok(f.reads.includes(automatic.messageId)); assert.equal(f.deliveries.length, 0)
  const collected = await f.run({ image: true, script: [{ name: 'simCollectSticker' }] })
  assert.ok(f.reads.includes(collected.messageId))
  assert.match(f.results.find(row => row.tool_call_id === `${collected.epoch}-0`).content, /"ok":true/u)
  const [item] = await f.items(); assert.equal(item.hash, hash(f.image)); assert.deepEqual(item.tags, ['开心', '笑死'])
  assert.deepEqual(item.useCases, ['分享快乐', '接梗吐槽']); assert.deepEqual(item.embedding, [0.1, 0.4, 0.8]); assert.equal(item.usedCount, 0)
  const partition = path.join(f.dataDir, 'emoji', 'agents', hash('daily'))
  assert.deepEqual(await readdir(path.join(f.dataDir, 'emoji', 'agents')), [hash('daily')])
  assert.deepEqual(await readFile(path.join(partition, item.file)), f.image)
  assert.equal(f.emojiModels.length, 3); assert.equal(f.emojiModels.filter(row => row.path.endsWith('/embeddings')).length, 1)
  const input = { tags: ['开心'], useCases: ['分享快乐'], leadText: '一起开心', followUpText: '下次见' }
  await f.run({ script: [{ name: 'sendLocalEmojiTool', args: input }] })
  assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].action, 'send_group_forward_msg')
  assert.deepEqual(f.deliveries[0].params.messages[0].data.content, [
    { type: 'text', data: { text: '一起开心' } }, { type: 'image', data: { file: 'base64://' + f.base64, sub_type: 1 } }, { type: 'text', data: { text: '下次见' } },
  ])
  assert.equal((await f.items())[0].usedCount, 1)
  const uncertain = await f.run({ group: OTHER_GROUP, unknown: true, script: [{ name: 'sendLocalEmojiTool', args: input }, { name: 'sendLocalEmojiTool', args: input }] })
  assert.equal(f.deliveries.length, 2); assert.equal(f.deliveries[1].action, 'send_group_forward_msg')
  assert.match(f.results.find(row => row.tool_call_id === `${uncertain.epoch}-0`).content, /unknown|未知/u)
  assert.match(f.results.find(row => row.tool_call_id === `${uncertain.epoch}-1`).content, /结果未知.*禁止重复|表情包冷却中/u)
  assert.equal((await f.items())[0].usedCount, 1); assert.equal(f.emojiModels.length, 3)
  await f.close()
})

test('standalone CLI follows, lists, synchronizes and drops through the real fixed Bilibili provider', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const initial = await f.run({ script: [{ name: 'simLifeThread', args: { action: 'follow', title: '真实番剧' } }, { name: 'simLifeThread', args: { action: 'list' } }] })
  assert.match(f.results.find(row => row.tool_call_id === `${initial.epoch}-0`).content, /已开始追.*真实番剧/u)
  assert.match(f.results.find(row => row.tool_call_id === `${initial.epoch}-1`).content, /真实番剧.*在追/u)
  assert.equal((await f.lifeThreads())[0].sourceId, '12345')
  await waitFor(async () => (await f.lifeThreads())[0]?.lastEpisode === 12, 'scheduled provider sync', 45000)
  const [thread] = await f.lifeThreads()
  assert.ok(thread.lastSyncAt > 0); assert.ok(thread.notes.some(note => note.startsWith('〔官方〕第12集')))
  assert.ok(thread.notes.some(note => note === '〔观众·27赞〕真实观众意见'))
  const dropped = await f.run({ script: [{ name: 'simLifeThread', args: { action: 'drop', title: '真实番剧' } }, { name: 'simLifeThread', args: { action: 'list' } }] })
  assert.match(f.results.find(row => row.tool_call_id === `${dropped.epoch}-1`).content, /真实番剧.*已弃/u)
  assert.equal((await f.lifeThreads())[0].status, 'dropped'); assert.deepEqual(f.deliveries, [])
  const paths = f.external.map(row => new URL(row.url).pathname)
  for (const expected of ['/x/frontend/finger/spi', '/x/web-interface/search/type', '/pgc/view/web/season', '/x/v2/reply']) assert.ok(paths.includes(expected), expected)
  assert.equal(f.external.filter(row => new URL(row.url).pathname === '/x/web-interface/search/type').length, 1)
  await f.close()
})
