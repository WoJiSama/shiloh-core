import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const BOT = 19000731, USER = 330731, GROUP = 310731
const MODEL_KEY = 'group-log-cli-private-model-key', QQ_TOKEN = 'group-log-cli-private-onebot-key'
const TITLE = '合成CLI团录', BODY = 'SYNTHETIC_GROUP_LOG_BODY_' + '完整长消息'.repeat(200) + '_COMPLETE_END'
async function waitFor(probe, label, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(25) }
  assert.fail(`timed out: ${label}`)
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function filesText(directory) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) values.push(await filesText(file)); else if (item.isFile()) values.push(await readFile(file, 'utf8'))
  }
  return values.join('\n')
}
async function redisText(reader, prefix) {
  const values = []
  for (const key of await reader.keys(prefix + '*')) {
    const type = await reader.type(key), value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) :
      type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key) :
        type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : type === 'stream' ? await reader.xRange(key, '-', '+') : null
    assert.ok(value !== null || type === 'none'); values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}

test('actual CLI checks group-log bridges without writes, then trusted host master starts, records and uploads complete TXT and HTML to the original group', { timeout: 90000 }, async t => {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'group-log CLI acceptance requires real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-group-log-cli-')), socketPath = path.join(directory, 'redis.sock'), dataDir = path.join(directory, 'data')
  const instance = 'group-log-cli', prefix = `bl-agent:${instance}:`, bridgePort = await freePort()
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), sources = new Map(), actions = [], replies = [], uploads = [], errors = [], children = []
  let child, exited, reader, websocket, log = '', modelRequests = 0, sequence = 73100
  const server = createServer((_req, res) => { modelRequests++; res.writeHead(503).end(MODEL_KEY) })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', async raw => {
      let echo
      try {
        const { action, params, echo: value } = JSON.parse(String(raw)); echo = value; actions.push({ action, params })
        let data
        if (action === 'get_login_info') data = { user_id: BOT, nickname: '团录合成验收机器人' }
        else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'only the recorded command source may be read') }
        else if (action === 'get_group_member_info') {
          assert.equal(Number(params.group_id), GROUP); assert.equal(Number(params.user_id), USER)
          data = { group_id: GROUP, user_id: USER, role: 'member', nickname: '团录验收员' }
        } else if (action === 'send_group_msg') {
          assert.equal(Number(params.group_id), GROUP); replies.push(params)
          data = { message_id: 73900 + replies.length }
        } else if (action === 'upload_group_file') {
          assert.deepEqual(Object.keys(params), ['group_id', 'file', 'name']); assert.equal(Number(params.group_id), GROUP)
          assert.match(params.file, new RegExp(`^http://127\\.0\\.0\\.1:${bridgePort}/qq-group-log/[a-f0-9]{64}$`, 'u'))
          const response = await fetch(params.file); assert.equal(response.status, 200)
          const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, Number(response.headers.get('content-length')))
          assert.ok(bytes.toString('utf8').includes(BODY), 'the whole message survives complete-file export')
          uploads.push({ ...params, bytes, mime: response.headers.get('content-type') })
          data = { file_id: `confirmed-group-log-${uploads.length}`, group_id: GROUP }
        } else assert.fail(`unexpected OneBot action ${action}`)
        if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) { t.diagnostic(log); t.diagnostic(JSON.stringify({ errors, actions: actions.map(row => row.action), modelRequests, uploads: uploads.map(row => row.name) })) }
    for (const item of children) { if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); await item.exited }
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance, dataDir,
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, name: 'group-log-model', apiKeyEnv: 'GROUP_LOG_MODEL_KEY' },
    groupLog: { enabled: true, maxBytes: 8 * 1024 * 1024, masters: [{ platform: 'qq', namespace: 'global', id: String(USER) }],
      bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort }, advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'GROUP_LOG_QQ_TOKEN' }] }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, GROUP_LOG_MODEL_KEY: MODEL_KEY, GROUP_LOG_QQ_TOKEN: QQ_TOKEN }
  const launch = check => {
    child = spawn(process.execPath, [entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); children.push({ child, exited }); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  }
  launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
  assert.equal(modelRequests, 0); assert.ok(actions.every(row => row.action === 'get_login_info'))
  assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' })
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`), undefined, 'check never opens the bridge listener')
  log = ''; launch(false)
  await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket?.readyState === websocket.OPEN }, 'normal CLI readiness')
  assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/missing`)).status, 404)
  const accountKey = JSON.stringify(['qq', 'global', String(BOT)]), conversationKey = JSON.stringify(['qq', 'global', String(BOT), 'group', String(GROUP)])
  const send = text => {
    const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER,
      sender: { user_id: USER, nickname: '团录验收员', role: 'member' }, message_id: ++sequence, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text } }], raw_message: text }
    sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source)); return source
  }
  const drained = async source => {
    const receipt = prefix + 'agent:inbox:receipt:' + createHash('sha256').update(JSON.stringify(['message', conversationKey, String(source.message_id)])).digest('hex')
    await waitFor(() => reader.exists(receipt), 'incoming command receipt')
    await waitFor(async () => await reader.lLen(`${prefix}agent:inbox:group-log:${accountKey}`) === 0, 'group-log front queue drains')
  }
  const start = send(`.log new ${TITLE}`); await waitFor(() => replies.length > 0, 'trusted configured master starts a log despite native member role'); await drained(start)
  await drained(send(BODY))
  const end = send('.log end ignored-title html'); await waitFor(() => uploads.length === 1, 'end uploads its complete current TXT'); await drained(end)
  assert.match(uploads[0].name, /\.txt$/u); assert.equal(uploads[0].mime, 'text/plain')
  const html = send('.log export html'); await waitFor(() => uploads.length === 2, 'explicit HTML upload'); await drained(html)
  assert.match(uploads[1].name, /\.html$/u); assert.equal(uploads[1].mime, 'text/html'); assert.match(uploads[1].bytes.toString(), /<!doctype html>/iu)
  websocket.send(JSON.stringify(html)); await delay(1200); assert.equal(uploads.length, 2, 'duplicate export command never uploads twice')
  assert.equal(modelRequests, 0, 'deterministic group-log workflow uses no model call')
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, [])
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
  const root = path.join(dataDir, `.agent-group-log-${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`)
  assert.deepEqual(await readdir(root), ['.owner.json'], 'shutdown closes and removes all temporary bridge runs')
  const journal = await filesText(path.join(dataDir, 'operations'))
  for (const value of [BODY, TITLE, MODEL_KEY, QQ_TOKEN, ...uploads.map(upload => upload.file)]) assert.equal((log + journal).includes(value), false, 'diagnostics exclude transcript bodies, titles, credentials and private native URLs')
  const persisted = await redisText(reader, prefix) + await filesText(dataDir)
  for (const value of [MODEL_KEY, QQ_TOKEN, ...uploads.map(upload => upload.file)]) assert.equal(persisted.includes(value), false, 'credentials and bridge capabilities never enter durable state')
})
