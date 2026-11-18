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

const repo = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const preload = fileURLToPath(new URL('./helpers/musicExtractionPreload.mjs', import.meta.url))
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const botId = 19000291, userId = 330291, groupId = 312901
const mainKey = 'music-extraction-fixture-model-private-key', oneBotToken = 'music-extraction-fixture-onebot-private-key'
const downloadUrl = 'https://m8.music.126.net/EXTRACTION_PRIVATE_DOWNLOAD_MARKER/song.wav'
const nativeShare = [{ type: 'music', data: { type: '163', id: '123456' } }]
const jsonShare = [{ type: 'json', data: { data: JSON.stringify({ meta: { music: {
  tag: '网易云音乐', title: '合成完整音频', desc: '合成艺术家', musicUrl: downloadUrl,
} } }) } }]
const WAV = Buffer.alloc(204)
WAV.write('RIFF'); WAV.writeUInt32LE(196, 4); WAV.write('WAVEfmt ', 8); WAV.writeUInt32LE(16, 16)
WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22); WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28)
WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(160, 40)
const base64 = WAV.toString('base64')

async function waitFor(probe, description, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(25) }
  assert.fail(`timed out: ${description}`)
}

async function persistedFiles(directory) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const filename = path.join(directory, item.name)
    if (item.isDirectory()) values.push(await persistedFiles(filename))
    else if (item.isFile()) values.push(await readFile(filename, 'utf8'))
  }
  return values.join('\n')
}

async function persistedRedis(reader, prefix) {
  const values = []
  for await (const page of reader.scanIterator({ MATCH: `${prefix}*` })) for (const key of Array.isArray(page) ? page : [page]) {
    const type = await reader.type(key)
    let value
    if (type === 'string') value = await reader.get(key)
    else if (type === 'hash') value = await reader.hGetAll(key)
    else if (type === 'list') value = await reader.lRange(key, 0, -1)
    else if (type === 'set') value = await reader.sMembers(key)
    else if (type === 'zset') value = await reader.zRangeWithScores(key, 0, -1)
    else if (type === 'stream') value = await reader.xRange(key, '-', '+')
    else assert.equal(type, 'none', `inspect every persisted Redis type: ${type}`)
    values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}

async function fixture(t, mode) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'extraction CLI acceptance needs real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), `agent-extract-${mode}-`)), socketPath = path.join(directory, 'redis.sock')
  const instance = `extract-${mode}`, prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit'), sockets = new WebSocketServer({ noServer: true })
  const requests = [], downloads = [], actions = [], deliveries = [], errors = [], held = []
  const enabled = !['omitted', 'disabled'].includes(mode), privateChat = mode.startsWith('private-')
  const quoted = privateChat || mode === 'group-quote', now = Math.floor(Date.now() / 1000)
  const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: privateChat ? 'private' : 'group', id: String(privateChat ? userId : groupId) }
  const scope = simulationAddressKey(target)
  const common = { post_type: 'message', message_type: target.kind, sub_type: privateChat ? 'friend' : 'normal', self_id: botId,
    ...(privateChat ? { target_id: botId } : { group_id: groupId }), user_id: userId, sender: { user_id: userId, nickname: '提取验收员' } }
  const source = { ...common, message_id: 29101, time: now, message: mode === 'auto-json' ? jsonShare : nativeShare, raw_message: '' }
  const ordinaryText = '请安静结束这一轮验收。'
  const current = quoted ? { ...common, message_id: 29102, time: now + 1,
    message: [{ type: 'reply', data: { id: String(source.message_id) } }, { type: 'text', data: { text: '.音乐提取' } }], raw_message: '.音乐提取' } :
    enabled ? source : { ...source, message: [...source.message, { type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: ordinaryText } }], raw_message: ordinaryText }
  let child, exited, reader, websocket, log = '', aborted = 0, holding = ['recall', 'rebind'].includes(mode)
  const releaseDownload = () => { holding = false; for (const response of held.splice(0)) if (!response.destroyed) response.end(WAV) }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/music-audit') {
        const url = new URL(decodeURIComponent(req.headers['x-extraction-source-url']))
        assert.equal(req.method, 'GET'); assert.equal(req.headers['x-extraction-pinned'], '93.184.216.34')
        assert.equal(req.headers['x-extraction-family'], '4'); assert.equal(req.headers['x-extraction-agent'], 'false')
        assert.equal(req.headers['x-extraction-signal'], 'true'); assert.equal(req.headers['accept-encoding'], 'identity')
        assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined)
        downloads.push({ url: url.href, headers: { ...req.headers } })
        if (url.pathname === '/api/song/detail/') {
          assert.equal(url.hostname, 'music.163.com'); assert.equal(url.searchParams.get('ids'), '[123456]')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ code: 200, songs: [{ id: 123456, name: '合成完整音频', artists: [{ name: '合成艺术家' }] }] })); return
        }
        if (url.hostname === 'music.163.com') {
          assert.equal(url.pathname, '/song/media/outer/url'); assert.equal(url.searchParams.get('id'), '123456')
        } else assert.equal(url.href, downloadUrl)
        res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Content-Length', String(WAV.length))
        if (holding) { res.once('close', () => { if (!res.writableEnded) aborted++ }); held.push(res) }
        else res.end(WAV)
        return
      }
      assert.equal(req.url, '/main/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${mainKey}`)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.model, 'extraction-fixture-model'); requests.push(body)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '验收结束' }),
      } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${oneBotToken}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', message => {
      let echo
      try {
        const request = JSON.parse(String(message)), { action, params } = request
        echo = request.echo; actions.push({ action, params })
        let data = {}
        if (action === 'get_login_info') data = { user_id: botId, nickname: '提取验收机器人' }
        else if (action === 'get_msg') {
          assert.ok([source.message_id, current.message_id].includes(Number(params.message_id)))
          data = Number(params.message_id) === source.message_id ? source : current
        } else if (action === 'get_friend_list') {
          assert.equal(privateChat, true); data = mode === 'private-not-friend' ? [] : [{ user_id: userId, nickname: '提取验收员' }]
        } else if (['upload_group_file', 'upload_private_file', 'send_group_forward_msg', 'send_private_forward_msg', 'send_group_msg', 'send_private_msg'].includes(action)) {
          assert.equal(action.includes('private'), privateChat)
          assert.equal(Number(privateChat ? params.user_id : params.group_id), privateChat ? userId : groupId)
          deliveries.push({ action, params })
          if (action.startsWith('upload_')) data = mode === 'upload-unknown' ? {} : { file_id: 'confirmed-extraction-file-id' }
          else data = mode === 'intro-unknown' && action.includes('forward') ? {} : { message_id: 29200 + deliveries.length }
        } else assert.fail(`unexpected OneBot action ${action}`)
        peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo) peer.send(JSON.stringify({ status: 'failed', retcode: 1, echo, data: {} })) }
    })
  })
  t.after(async () => {
    releaseDownload()
    if (t.error) t.diagnostic(JSON.stringify({ errors, log, actions: actions.map(({ action }) => action), downloads: downloads.map(({ url }) => new URL(url).pathname), modelRequests: requests.length }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (exited) await exited
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const port = server.address().port, bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'qq-extraction', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-extraction', kind: target.kind, conversationId: target.id, agentId: 'daily' }] }
  const configFile = path.join(directory, 'agent-host.yaml')
  const configText = JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'extraction-fixture-model', apiKeyEnv: 'EXTRACTION_MODEL_KEY' },
    ...(mode === 'omitted' ? {} : { musicExtraction: { enabled, operators: [{ platform: 'qq', namespace: 'global', id: String(userId) }] } }),
    privateChat: { enabled: true }, memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-extraction', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'EXTRACTION_ONEBOT_KEY' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } })
  let expectedBindings = JSON.stringify(bindings)
  await writeFile(bindingsFile, expectedBindings); await writeFile(configFile, configText)
  const records = async () => {
    const keys = await reader.keys(prefix + 'agent:music-extraction:v1:*')
    return Promise.all(keys.map(async key => JSON.parse(await reader.get(key))))
  }
  return {
    requests, downloads, actions, deliveries, errors, releaseDownload, records,
    get aborted() { return aborted },
    async start() {
      child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile], { cwd: directory,
        env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, EXTRACTION_MODEL_KEY: mainKey, EXTRACTION_ONEBOT_KEY: oneBotToken,
          MUSIC_EXTRACTION_AUDIT_URL: `http://127.0.0.1:${port}/music-audit` } })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
      await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness')
      websocket.send(JSON.stringify(current))
    },
    replay() { websocket.send(JSON.stringify(current)) },
    async terminal(state) { return (await records()).some(record => record.state === state) },
    recall() { websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: botId,
      group_id: groupId, user_id: userId, operator_id: userId, message_id: source.message_id, time: now + 2 })) },
    async rebind() {
      expectedBindings = JSON.stringify({ ...bindings, bindings: [{ ...bindings.bindings[0], agentId: 'replacement' }] })
      await writeFile(bindingsFile, expectedBindings)
    },
    async drained() {
      const session = JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
      return session?.lastWakeAt && !session.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(scope))
    },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log) },
    async assertClean() {
      assert.deepEqual(errors, [])
      assert.equal(await readFile(configFile, 'utf8'), configText)
      assert.equal(await readFile(bindingsFile, 'utf8'), expectedBindings)
      const surfaces = { log, model: JSON.stringify(requests), redis: await persistedRedis(reader, prefix),
        files: await persistedFiles(path.join(directory, 'data')), config: await readFile(configFile, 'utf8'), bindings: await readFile(bindingsFile, 'utf8') }
      for (const [surface, content] of Object.entries(surfaces)) for (const forbidden of [downloadUrl, 'EXTRACTION_PRIVATE_DOWNLOAD_MARKER',
        'music.126.net', '/song/media/outer/url', base64, 'base64://', mainKey, oneBotToken]) {
        assert.equal(content.includes(forbidden), false, `${surface} excludes download references, audio bytes and host secrets`)
      }
      if (mode === 'private-not-friend') {
        const notice = deliveries[0]?.params.message[0]?.data.text
        assert.equal(typeof notice, 'string')
        for (const surface of ['log', 'redis', 'files']) assert.equal(surfaces[surface].includes(notice), false, `${surface} excludes the derived failure notice body`)
      }
      for (const request of downloads) {
        const outgoing = JSON.stringify(request.headers)
        for (const value of [mainKey, oneBotToken, '提取验收员', String(userId), String(groupId)]) assert.equal(outgoing.includes(value), false, 'provider gets no conversation context or host credentials')
      }
    },
  }
}

function assertDelivery(run, privateChat = false) {
  const suffix = privateChat ? 'private' : 'group'
  assert.deepEqual(run.deliveries.map(row => row.action), [`upload_${suffix}_file`, `send_${suffix}_forward_msg`, `send_${suffix}_msg`])
  const [file, intro, preview] = run.deliveries.map(row => row.params)
  assert.equal(file.file, `base64://${base64}`); assert.equal(file.name, '合成完整音频-合成艺术家.wav')
  assert.equal(intro.messages.length, 1)
  const text = intro.messages[0].data.content.find(segment => segment.type === 'text').data.text
  assert.match(text, /^网易云音乐\n合成完整音频 - 合成艺术家\n可下载文件：合成完整音频-合成艺术家.wav\n文件大小：0\.00 MiB$/u)
  assert.equal(preview.message.length, 1); assert.equal(preview.message[0].type, 'record')
  assert.equal(preview.message[0].data.file, file.file, 'playable record and downloadable file use the same complete bytes')
  assert.equal(run.requests.length, 0, 'deterministic extraction makes zero model calls')
}

for (const mode of ['auto-native', 'auto-json']) test(`actual CLI ${mode} group extraction uploads file then introduction and playable record without model calls`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.terminal('completed'), 'completed extraction ledger'); await run.stop()
  assertDelivery(run)
  assert.equal(run.downloads.length, mode === 'auto-json' ? 1 : 2)
  assert.ok(run.actions.filter(row => row.action === 'get_msg').length >= 4, 'source is reloaded between deliveries')
  assert.deepEqual((await run.records())[0].stages.map(row => row.state), ['uploaded', 'sent', 'sent'])
  await run.assertClean()
})

for (const mode of ['group-quote', 'private-quote']) test(`actual CLI operator ${mode} command resolves quoted native source and delivers in the original conversation`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.terminal('completed'), 'quoted extraction completes'); await run.stop()
  assertDelivery(run, mode === 'private-quote')
  const reads = run.actions.filter(row => row.action === 'get_msg')
  assert.ok(reads.length >= 4); assert.ok(reads.every(row => Number(row.params.message_id) === 29101))
  assert.equal(run.actions.filter(row => row.action === 'get_friend_list').length, mode === 'private-quote' ? reads.length : 0, 'each private read verifies actual friend membership')
  await run.assertClean()
})

test('actual CLI refuses private quote extraction when get_friend_list does not prove the peer is a friend', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'private-not-friend'); await run.start()
  await waitFor(() => run.terminal('failed'), 'unproven private source is refused')
  run.replay(); await delay(150); await run.stop()
  assert.equal(run.downloads.length, 0); assert.equal(run.requests.length, 1, 'only one failure explanation request is allowed, including duplicate ingress')
  const explanation = run.requests[0]
  assert.ok(!explanation.tools?.length, 'failure explanation cannot execute or retry a tool')
  assert.ok(explanation.messages.some(row => row.role === 'system' && String(row.content).includes('你只负责为当前真人请求写一条')))
  assert.equal(run.actions.filter(row => row.action === 'get_friend_list').length, 1)
  assert.equal(run.deliveries.length, 1); assert.equal(run.deliveries[0].action, 'send_private_msg')
  assert.match(run.deliveries[0].params.message[0].data.text, /^这次服务暂时异常，暂时无法确认结果。请先核实操作状态。 查询编号：[a-f0-9-]{36}$/u,
    'invalid model explanation falls back to one brief service notice with its query reference')
  await run.assertClean()
})

for (const mode of ['upload-unknown', 'intro-unknown']) test(`actual CLI ${mode} receipt stops every later delivery and duplicate input`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.terminal('unknown'), 'unknown receipt freezes ledger')
  run.replay(); await delay(150); await run.stop()
  assert.deepEqual(run.deliveries.map(row => row.action), mode === 'upload-unknown' ? ['upload_group_file'] : ['upload_group_file', 'send_group_forward_msg'])
  assert.equal(run.downloads.length, 2); assert.equal(run.requests.length, 0)
  await run.assertClean()
})

for (const mode of ['recall', 'rebind']) test(`actual CLI ${mode} aborts pending complete-audio HTTP and prevents late delivery`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.downloads.length === 2, 'complete audio download is pending')
  if (mode === 'recall') run.recall(); else await run.rebind()
  await waitFor(() => run.aborted === 1, 'real HTTP socket abort is observed')
  await waitFor(() => run.terminal('cancelled'), 'cancelled workflow is committed')
  run.releaseDownload(); await delay(150); await run.stop()
  assert.equal(run.deliveries.length, 0); assert.equal(run.requests.length, 0)
  assert.equal(run.downloads.length, 2)
  await run.assertClean()
})

for (const mode of ['omitted', 'disabled']) test(`actual CLI ${mode} extraction configuration performs ordinary ingress without extraction`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.requests.length > 0, 'ordinary model turn proves ingress was consumed')
  await waitFor(run.drained, 'ordinary turn drains'); await run.stop()
  assert.equal(run.downloads.length, 0); assert.equal(run.deliveries.length, 0); assert.deepEqual(await run.records(), [])
  await run.assertClean()
})
