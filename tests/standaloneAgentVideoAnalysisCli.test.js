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
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/videoAnalysisPreload.mjs', import.meta.url))
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const BOT = 19000231, USER = 330231, GROUP = 312301
const MODEL_KEY = 'video-cli-main-model-private-key', VIDEO_KEY = 'video-cli-independent-provider-private-key', QQ_TOKEN = 'video-cli-onebot-private-key'
const marker = 'VIDEO_ANALYSIS_TEMPORARY_MARKER_20261116', byteMarker = 'VIDEO_NATIVE_OWNED_BYTES_PRIVATE_20261116'
const prompt = '只概括当前视频画面。', ordinary = '本轮视频分析工具未开放。'
const nativeUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin&rkey=VIDEO_NATIVE_SIGNED_PRIVATE_20261116'
const nativeFileId = '8a376bb6414a2a77bb0b5c66ecaf29d2.mp4'
const ftyp = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'), mdat = Buffer.alloc(8)
mdat.writeUInt32BE(8 + Buffer.byteLength(byteMarker), 0); mdat.write('mdat', 4)
const bytes = Buffer.concat([ftyp, mdat, Buffer.from(byteMarker)])
const target = { account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(GROUP) }
const scope = simulationAddressKey(target)
const completion = (name, input, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function',
  function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
const video = () => ({ type: 'video', data: { file: nativeFileId, url: nativeUrl, file_size: bytes.length } })
const text = value => ({ type: 'text', data: { text: value } })

async function waitFor(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}
async function redisText(reader, prefix) {
  const values = []
  for await (const page of reader.scanIterator({ MATCH: `${prefix}*` })) for (const key of Array.isArray(page) ? page : [page]) {
    const type = await reader.type(key)
    const value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : type === 'list' ? await reader.lRange(key, 0, -1) :
      type === 'set' ? await reader.sMembers(key) : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : type === 'stream' ? await reader.xRange(key, '-', '+') : undefined
    if (value === undefined) assert.equal(type, 'none', 'inspect every stored Redis type')
    values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}
async function filesText(directory) {
  const rows = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const name = path.join(directory, item.name)
    if (item.isDirectory()) rows.push(await filesText(name))
    else if (item.isFile()) rows.push(await readFile(name, 'utf8'))
  }
  return rows.join('\n')
}

async function fixture(t, { enabled = true, hold = '' } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'video CLI verification requires real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-cli-')), socketPath = path.join(directory, 'redis.sock'), dataDir = path.join(directory, 'data')
  const instance = 'video-cli', prefix = `bl-agent:${instance}:`, sources = new Map()
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), models = [], videos = [], downloads = [], actions = [], deliveries = [], errors = [], results = []
  let child, exited, reader, websocket, log = '', epoch = 0, turn, finished = false, phase = 'check', videoAborted = 0, mainAborted = 0, releaseVideo, releaseMain
  const heldVideo = new Promise(resolve => { releaseVideo = resolve }), heldMain = new Promise(resolve => { releaseMain = resolve })
  const now = Math.floor(Date.now() / 1000)
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/native-video') {
        assert.equal(phase, 'run'); assert.equal(decodeURIComponent(req.headers['x-video-source-url']), nativeUrl)
        assert.equal(req.headers['x-video-pinned-address'], '8.8.8.8'); assert.equal(req.headers['x-video-pinned-family'], '4')
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); assert.equal(req.headers['accept-encoding'], 'identity')
        downloads.push({ epoch, headers: req.headers }); res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }); res.end(bytes); return
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      assert.equal(phase, 'run'); assert.ok(turn)
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/video/v1/chat/completions') {
        assert.equal(req.headers.authorization, `Bearer ${VIDEO_KEY}`); assert.equal(body.model, 'video-model'); assert.equal(body.stream, false)
        assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: prompt },
          { type: 'video_url', video_url: { url: `data:video/mp4;base64,${bytes.toString('base64')}` } }] }])
        assert.equal(body.tools, undefined); assert.equal(JSON.stringify(body).includes('VIDEO_GROUP_CONTEXT_ONLY'), false)
        videos.push({ epoch, body, headers: req.headers }); res.once('close', () => { if (!res.writableEnded) videoAborted++ })
        if (hold === 'video') await heldVideo
        if (!res.destroyed) res.end(JSON.stringify({ choices: [{ message: { content: `${marker}-${epoch}：画面是一段本地合成视频。` } }],
          usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 } }))
        return
      }
      assert.equal(req.url, '/main/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${MODEL_KEY}`); assert.equal(body.model, 'main-video-fixture')
      for (let previous = 1; previous < epoch; previous++) assert.equal(JSON.stringify(body).includes(`${marker}-${previous}`), false, 'prior video analysis never reaches a later human turn')
      models.push({ epoch, body }); res.once('close', () => { if (!res.writableEnded) mainAborted++ })
      const tool = body.tools.find(item => item.function.name === 'videoAnalysisTool')
      assert.equal(!!tool, enabled)
      if (tool) {
        assert.deepEqual(Object.keys(tool.function.parameters.properties), ['prompt']); assert.equal(tool.function.parameters.additionalProperties, false)
        assert.deepEqual(tool.function.parameters.required, [])
      }
      const send = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `${epoch}-send`)
      const analysis = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `${epoch}-analysis`)
      if (finished) { res.end(completion('simDecide', { decision: 'silent', reason: '当前视频回合已结束' }, `${epoch}-decide`)); return }
      if (send) { finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '视频结果已答复，本轮不保存分析' }, `${epoch}-finish`)); return }
      if (analysis) {
        assert.ok(String(analysis.content).includes(`${marker}-${epoch}`), 'independent analysis reaches only this main-model continuation')
        results.push(analysis)
        if (hold === 'main') await heldMain
        if (!res.destroyed) res.end(completion('simSendMessage', { continuation: 'chat', messages: [`${marker}-${epoch}：这段视频展示了合成画面。`] }, `${epoch}-send`))
        return
      }
      res.end(enabled ? completion('videoAnalysisTool', { prompt }, `${epoch}-analysis`) :
        completion('simSendMessage', { continuation: 'chat', messages: [ordinary] }, `${epoch}-send`))
    } catch (error) { errors.push(String(error)); if (!res.destroyed) res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', raw => {
      let echo
      try {
        const request = JSON.parse(String(raw)); echo = request.echo; const { action, params } = request
        actions.push({ epoch, action, params }); let data
        if (action === 'get_login_info') data = { user_id: BOT, nickname: '视频分析验收机器人' }
        else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'read only recorded source messages') }
        else if (action === 'get_forward_msg') {
          const id = params.id ?? params.message_id
          assert.ok(['video-root-3', 'video-nested-3'].includes(id)); const nested = id === 'video-root-3'
          data = { id, messages: [{ type: 'node', data: { user_id: USER + (nested ? 10 : 11), time: now + epoch - (nested ? 1 : 2),
            content: nested ? [{ type: 'forward', data: { id: 'video-nested-3' } }] : [video()] } }] }
        } else if (action === 'send_group_msg') {
          assert.equal(Number(params.group_id), GROUP); assert.ok(params.message.every(part => part.type === 'text'), 'normal text reply after analysis')
          const value = params.message.filter(part => part.type === 'text').map(part => part.data.text).join('')
          assert.equal(value, enabled ? `${marker}-${epoch}：这段视频展示了合成画面。` : ordinary)
          deliveries.push({ epoch, params }); data = { message_id: 98200 + deliveries.length }
        } else assert.fail(`unexpected OneBot action ${action}`)
        if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null })) }
    })
  })
  t.after(async () => {
    releaseVideo(); releaseMain()
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, actions, models: models.length, videos: videos.length, downloads: downloads.length, deliveries: deliveries.length, results,
      storage: reader?.isOpen ? await redisText(reader, prefix) : 'closed' })) }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const configText = JSON.stringify({ version: 1, instance, dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'main-video-fixture', apiKeyEnv: 'VIDEO_MAIN_KEY' },
    tools: { videoAnalysis: { enabled, baseUrl: `http://127.0.0.1:${port}/video/v1`, name: 'video-model', apiKeyEnv: enabled ? 'VIDEO_KEY' : 'MISSING_VIDEO_KEY', inputMode: 'inline' } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'VIDEO_QQ_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  let currentConfigText = configText
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, VIDEO_MAIN_KEY: MODEL_KEY, VIDEO_QQ_TOKEN: QQ_TOKEN,
    VIDEO_ANALYSIS_AUDIT_URL: `http://127.0.0.1:${port}/native-video`, ...(enabled ? { VIDEO_KEY } : {}) }
  delete env.MISSING_VIDEO_KEY; if (!enabled) delete env.VIDEO_KEY
  const launch = check => {
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  }
  const session = async () => JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(scope))
  const drained = async () => { const value = await session(); return value?.lastWakeAt && !value.queuedIngressWake && await settled() }
  const ingress = kind => {
    epoch++; finished = false
    const messageId = 98100 + epoch, requestText = `请分析${kind}视频。VIDEO_GROUP_CONTEXT_ONLY-${epoch}`
    const content = kind === 'current' ? [{ type: 'at', data: { qq: String(BOT) } }, video()] : kind === 'reply' ? [{ type: 'reply', data: { id: '98101' } }, { type: 'at', data: { qq: String(BOT) } }, text(requestText)] :
      [{ type: 'at', data: { qq: String(BOT) } }, text(requestText), { type: 'forward', data: { id: `video-root-${epoch}` } }]
    turn = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
      sender: { user_id: USER, nickname: '视频分析验收员' }, message_id: messageId, time: now + epoch, message: content, raw_message: kind === 'current' ? '' : requestText }
    sources.set(String(messageId), turn); websocket.send(JSON.stringify(turn)); return turn
  }
  return { models, videos, downloads, actions, deliveries, errors, results, reader, prefix, session, settled, drained, ingress, releaseVideo, releaseMain,
    get finished() { return finished }, get videoAborted() { return videoAborted }, get mainAborted() { return mainAborted },
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
      assert.equal(videos.length, 0); assert.equal(models.length, 0); assert.equal(downloads.length, 0); assert.equal(actions.filter(row => row.action !== 'get_login_info').length, 0)
      assert.deepEqual(await reader.keys(`${prefix}*`), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' })
      log = ''; phase = 'run'; launch(false)
      await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness')
    },
    async run(kind) { const source = ingress(kind); await waitFor(() => finished, `${kind} video analysis reaches final send`); await waitFor(drained, `${kind} turn drains`); assert.deepEqual(errors, []); return source },
    async pureVideo() {
      const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER + 99,
        sender: { user_id: USER + 99, nickname: '仅发送视频的其他群友' }, message_id: 98099, time: now, message: [video()], raw_message: '' }
      sources.set(String(source.message_id), source); const before = { models: models.length, videos: videos.length, deliveries: deliveries.length }
      websocket.send(JSON.stringify(source))
      await waitFor(async () => (await session())?.recent?.some(row => row.messageId === String(source.message_id) && row.videoCount === 1), 'non-directed pure video retained as bounded metadata')
      await delay(1200)
      assert.deepEqual({ models: models.length, videos: videos.length, deliveries: deliveries.length }, before, 'pure video arrival preserves existing wake and actor permissions')
      return source
    },
    recall() { websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: GROUP,
      user_id: USER, operator_id: USER, message_id: turn.message_id, time: now + epoch + 1 })) },
    async sourceRemoved() { return !(await session())?.recent?.some(row => row.messageId === String(turn.message_id)) },
    async invalidateConfig() { currentConfigText = `${configText}\n# video CLI fixture changes the captured host revision\n`; await writeFile(configFile, currentConfigText) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(configFile, 'utf8'), currentConfigText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const privateValues = [marker, byteMarker, bytes.toString('base64'), nativeUrl, nativeFileId, 'VIDEO_NATIVE_SIGNED_PRIVATE_20261116', MODEL_KEY, VIDEO_KEY, QQ_TOKEN]
      for (const stored of [log, await redisText(reader, prefix), await filesText(dataDir)]) for (const value of privateValues) assert.equal(stored.includes(value), false,
        'video bytes, platform URLs/ids, analysis, derived reply and credentials stay out of Redis, files and logs')
      for (const request of models) for (const value of privateValues.filter(value => value !== marker)) assert.equal(JSON.stringify(request.body).includes(value), false,
        'main model receives prompt arguments and analysis text without video bytes, URLs, ids or credentials')
    },
  }
}

test('actual CLI directed current video without text, verified reply and nested forward use an independent exact-byte video model and ephemeral normal replies', { timeout: 90000 }, async t => {
  const run = await fixture(t); await run.start()
  const current = await run.run('current')
  assert.deepEqual(current.message.map(part => part.type), ['at', 'video']); assert.equal(current.raw_message, '')
  assert.equal((await run.session()).recent.find(row => row.messageId === String(current.message_id)).videoCount, 1, 'pure video is retained as bounded metadata')
  await run.run('reply'); await run.run('forward')
  assert.equal(run.videos.length, 3); assert.equal(run.downloads.length, 3); assert.equal(run.results.length, 3); assert.equal(run.deliveries.length, 3)
  assert.deepEqual(run.videos.map(row => row.epoch), [1, 2, 3]); assert.ok(run.actions.some(row => row.action === 'get_forward_msg' && row.params.id === 'video-nested-3'))
  assert.ok(run.models.filter(row => row.body.messages.some(message => message.role === 'tool' && message.tool_call_id.endsWith('-analysis'))).length >= 3)
  await run.pureVideo()
  await run.stop(); await run.clean()
})

test('actual CLI disabled video analysis reads no missing credential and makes zero video provider or native downloads', { timeout: 45000 }, async t => {
  const run = await fixture(t, { enabled: false }); await run.start(); await run.run('current')
  assert.equal(run.videos.length, 0); assert.equal(run.downloads.length, 0); assert.equal(run.results.length, 0); assert.equal(run.deliveries.length, 1)
  assert.ok(run.models.every(row => !row.body.tools.some(tool => tool.function.name === 'videoAnalysisTool')))
  await run.stop(); await run.clean()
})

test('actual CLI recalled video aborts the pending independent model socket with zero late send or continuation', { timeout: 45000 }, async t => {
  const run = await fixture(t, { hold: 'video' }); await run.start(); run.ingress('current')
  await waitFor(() => run.videos.length === 1, 'independent video request is held'); run.recall()
  await waitFor(run.sourceRemoved, 'recalled root removed'); await waitFor(() => run.videoAborted === 1, 'independent video HTTP socket aborted')
  await waitFor(run.settled, 'recalled video execution lock released'); run.releaseVideo(); await delay(150)
  assert.equal(run.deliveries.length, 0); assert.equal(run.models.length, 1); assert.equal(run.finished, false)
  await run.stop(); await run.clean()
})

test('actual CLI host revision change aborts a pending video-derived main continuation and permits zero late sends', { timeout: 45000 }, async t => {
  const run = await fixture(t, { hold: 'main' }); await run.start(); run.ingress('current')
  await waitFor(() => run.results.length === 1, 'video analysis is held at the main continuation'); await run.invalidateConfig()
  await waitFor(() => run.mainAborted === 1, 'video-derived main HTTP socket aborted'); await waitFor(run.settled, 'changed revision releases the execution lock')
  run.releaseMain(); await delay(150)
  assert.equal(run.videos.length, 1); assert.equal(run.deliveries.length, 0); assert.equal(run.models.length, 2); assert.equal(run.finished, false)
  await run.stop(); await run.clean()
})
