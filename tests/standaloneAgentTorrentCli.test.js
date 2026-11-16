import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/torrentPreload.mjs', import.meta.url))
const botId = 19000941, userId = 330941, groupId = 319401, modelKey = 'torrent-cli-model-private-key', qqToken = 'torrent-cli-onebot-private-token'
const payload = Buffer.from('Synthetic aria2 payload for CLI acceptance. This is not a real peer download.\n'.repeat(64))
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(value.length + ':'), value])
  if (typeof value === 'string') return bencode(Buffer.from(value))
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
}
const info = bencode({ length: payload.length, name: 'cli-payload.txt', 'piece length': 16384, pieces: createHash('sha1').update(payload).digest() })
const metadata = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]), infoHash = createHash('sha1').update(info).digest('hex').toUpperCase()
const magnet = `magnet:?xt=urn:btih:${infoHash}`
async function waitFor(probe, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(25) }
  assert.fail(`Timed out: ${label}`)
}
async function files(directory) {
  const values = []
  for (const file of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    if (file.isDirectory()) values.push(await files(path.join(directory, file.name)))
    else if (file.isFile()) values.push(await readFile(path.join(directory, file.name), 'utf8'))
  }
  return values.join('\n')
}
async function redisContents(reader, prefix) {
  const values = []
  for (const key of await reader.keys(`${prefix}*`)) {
    const type = await reader.type(key), value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key)
      : type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key)
        : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : type === 'stream' ? await reader.xRange(key, '-', '+') : null
    values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}

test('actual CLI checks without torrent effects, then uses fixed metadata, synthetic aria2, real ZIP, private bridge upload and confirmed group receipt', { timeout: 45000 }, async t => {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'CLI acceptance requires real Redis')
  assert.equal(spawnSync('zip', ['-v'], { stdio: 'ignore' }).status, 0, 'CLI acceptance requires real ZIP')
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-torrent-cli-')), socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true }), requests = [], metadataRequests = [], commands = [], uploads = [], groupReplies = [], errors = []
  let child, exited, reader, websocket, log = '', modelRequests = 0, messageSequence = 94200, nativeUrl
  const instance = 'torrent-cli', prefix = `bl-agent:${instance}:`, now = Math.floor(Date.now() / 1000)
  const source = { post_type: 'message', message_type: 'group', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '磁链合成验收员' }, message_id: 94101, time: now,
    message: [{ type: 'text', data: { text: magnet } }], raw_message: magnet }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/audit/metadata') {
        assert.equal(req.method, 'GET'); assert.equal(req.headers['x-torrent-pinned'], '93.184.216.34')
        const url = new URL(decodeURIComponent(req.headers['x-torrent-source-url']))
        assert.equal(url.href, `https://itorrents.net/torrent/${infoHash}.torrent`)
        metadataRequests.push(url.href)
        for (const forbidden of [modelKey, qqToken, String(groupId), String(userId), '磁链合成验收员']) assert.equal(JSON.stringify(req.headers).includes(forbidden), false)
        res.writeHead(200, { 'Content-Type': 'application/x-bittorrent', 'Content-Length': String(metadata.length) }); res.end(metadata)
      } else if (req.url === '/audit/command') {
        let text = ''; for await (const chunk of req) text += chunk
        commands.push(JSON.parse(text)); res.writeHead(200).end('{}')
      } else { modelRequests++; res.writeHead(500).end('{}') }
    } catch (error) { errors.push(String(error)); res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${qqToken}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', async frame => {
      let echo
      try {
        const request = JSON.parse(String(frame)), { action, params } = request; echo = request.echo; requests.push({ action, params })
        let data
        if (action === 'get_login_info') data = { user_id: botId, nickname: '磁链合成机器人' }
        else if (action === 'get_msg') { assert.equal(Number(params.message_id), source.message_id); data = source }
        else if (action === 'send_group_msg') {
          assert.equal(String(params.group_id), String(groupId)); groupReplies.push(params.message); data = { message_id: ++messageSequence }
        } else if (action === 'upload_private_file') {
          assert.deepEqual(Object.keys(params), ['user_id', 'file', 'name']); assert.equal(String(params.user_id), String(userId))
          assert.equal(params.name, `磁链内容-${infoHash.slice(0, 12)}.zip`); nativeUrl = params.file
          assert.match(nativeUrl, /^http:\/\/127\.0\.0\.1:\d+\/qq-requester-archive\/[a-f\d]{64}$/u)
          const response = await fetch(nativeUrl); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip')
          const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, Number(response.headers.get('content-length')))
          assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.equal(bytes.readUInt16LE(8), 0)
          const nameLength = bytes.readUInt16LE(26), extraLength = bytes.readUInt16LE(28), size = bytes.readUInt32LE(18)
          assert.equal(bytes.subarray(30, 30 + nameLength).toString(), 'cli-payload.txt')
          assert.equal(size, payload.length); assert.deepEqual(bytes.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + size), payload)
          assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50)
          uploads.push({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); data = { file_id: 'torrent-cli-native-file-17' }
        } else assert.fail(`Unexpected OneBot action: ${action}`)
        if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, requests: requests.map(row => row.action), metadataRequests, commands, uploads, groupReplies }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const apiPort = server.address().port
  const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
  const bridgePort = allocator.address().port; await new Promise(resolve => allocator.close(resolve))
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis socket')
  reader = createClient({ socket: { path: socketPath } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data')
  const configText = JSON.stringify({ version: 1, instance, dataDir,
    model: { baseUrl: `http://127.0.0.1:${apiPort}/model/v1`, name: 'torrent-fixture', apiKeyEnv: 'TORRENT_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${apiPort}/onebot`, accessTokenEnv: 'TORRENT_QQ_TOKEN' }],
    torrentDownload: { enabled: true, autoDetect: true, bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort },
      advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] })
  await writeFile(configFile, configText); await writeFile(path.join(directory, 'agent-bindings.yaml'), bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TORRENT_MODEL_KEY: modelKey, TORRENT_QQ_TOKEN: qqToken,
    TORRENT_CLI_AUDIT_URL: `http://127.0.0.1:${apiPort}/audit`, TORRENT_CLI_PAYLOAD_BASE64: payload.toString('base64') }
  const launch = check => {
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  }
  launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
  assert.deepEqual(requests.map(row => row.action), ['get_login_info']); assert.deepEqual(metadataRequests, []); assert.deepEqual(commands, [])
  assert.equal(modelRequests, 0); await assert.rejects(lstat(dataDir), { code: 'ENOENT' })
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(await reader.keys(`${prefix}*`), [])
  log = ''; launch(false)
  await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI ready')
  websocket.send(JSON.stringify(source))
  const records = async () => Promise.all((await reader.keys(`${prefix}agent:torrent:v1:job:*`)).map(async key => JSON.parse(await reader.get(key))))
  await waitFor(async () => (await records()).some(record => record.state === 'completed'), 'completed torrent job')
  const record = (await records())[0]
  assert.deepEqual(record.stages.map(row => [row.stage, row.state]), [['notice', 'sent'], ['archive', 'uploaded'], ['confirmation', 'sent']])
  assert.deepEqual(record.stages.find(row => row.stage === 'archive').receipt, { state: 'uploaded', fileId: 'torrent-cli-native-file-17' })
  assert.equal(uploads.length, 1); assert.equal(groupReplies.length, 2); assert.ok(JSON.stringify(groupReplies[1]).includes('已私发给发起人'))
  assert.equal(modelRequests, 0); assert.equal(metadataRequests.length, 1)
  await waitFor(() => commands.length === 2, 'both command audits')
  assert.deepEqual(commands.map(row => [row.command, row.synthetic]), [['aria2c', true], ['zip', false]])
  assert.equal(commands[0].bytes, payload.length)
  const nativeResponse = await fetch(nativeUrl); assert.equal(nativeResponse.status, 404)
  websocket.send(JSON.stringify(source)); await delay(1200); assert.equal(uploads.length, 1); assert.equal(metadataRequests.length, 1)
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(errors, [])
  const torrentRoot = (await readdir(dataDir)).find(name => name.startsWith('.agent-torrent-'))
  assert.ok(torrentRoot); assert.deepEqual(await readdir(path.join(dataDir, torrentRoot)), ['.owner.json'])
  assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(path.join(directory, 'agent-bindings.yaml'), 'utf8'), bindingsText)
  for (const content of [log, await redisContents(reader, prefix), await files(dataDir)]) for (const secret of [modelKey, qqToken, nativeUrl, payload.toString('base64'), metadata.toString('base64'), 'base64://']) {
    assert.equal(content.includes(secret), false, 'logs, Redis and persisted host files exclude secrets and native capabilities')
  }
})
