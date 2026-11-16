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
import { deflateSync } from 'node:zlib'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/pixivRelayPreload.mjs', import.meta.url))
const botId = 19000981, userId = 330981, groupId = 319801, workId = '123456789'
const modelKey = 'pixiv-cli-model-private-key', qqToken = 'pixiv-cli-onebot-private-token'
const pageUrl = `https://www.pixiv.net/artworks/${workId}`, metadataUrl = `https://www.pixiv.net/ajax/illust/${workId}`
const cookieValue = 'pixiv-cli-cookie-private-value', authCookie = `PHPSESSID=${cookieValue}`
const imageUrls = [0, 1, 2].map(index => `https://i.pximg.net/img-master/img/2026/11/16/00/00/00/${workId}_p${index}_master1200.png?sign=PIXIV_CLI_UPSTREAM_PRIVATE_${index}`)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function png(red) {
  const crc = bytes => {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1 }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), header = Buffer.alloc(4), trailer = Buffer.alloc(4)
    header.writeUInt32BE(data.length); trailer.writeUInt32BE(crc(Buffer.concat([name, data])))
    return Buffer.concat([header, name, data, trailer])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 60, 120, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const images = [png(40), png(80), png(120)]
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

for (const scenario of [{ kind: 'gallery', unknown: false }, { kind: 'partial', unknown: false }, { kind: 'restricted', unknown: false }, { kind: 'gallery', unknown: true }]) {
  test(`actual Pixiv CLI ${scenario.kind} ${scenario.unknown ? 'freezes an unknown receipt without retry' : 'completes one native forward'} through verified source and ordered owned resources`, { timeout: 45000 }, async t => {
    assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'CLI acceptance requires real Redis')
    const directory = await mkdtemp(path.join(tmpdir(), 'standalone-pixiv-cli-')), socketPath = path.join(directory, 'redis.sock')
    const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
    const sockets = new WebSocketServer({ noServer: true }), requests = [], downloads = [], deliveries = [], resources = [], capabilities = [], errors = [], events = []
    let child, exited, reader, websocket, log = '', modelRequests = 0
    const now = Math.floor(Date.now() / 1000), instance = 'pixiv-cli', prefix = `bl-agent:${instance}:`
    const description = 'Pixiv actual CLI synthetic metadata.<br>Each page keeps its original index.'
    const metadata = { id: workId, title: 'CLI合成Pixiv多页作品', description, userName: '合成画师', pageCount: 3,
      xRestrict: scenario.kind === 'restricted' ? 1 : 0, width: 1024, height: 1536, tags: { tags: [{ tag: '合成标签' }] },
      urls: { regular: imageUrls[0] }, viewCount: 1200, likeCount: 80, bookmarkCount: 30, commentCount: 2 }
    const source = { post_type: 'message', message_type: 'group', self_id: botId, group_id: groupId, user_id: userId,
      sender: { user_id: userId, nickname: 'Pixiv合成验收员' }, message_id: 97101, time: now,
      message: [{ type: 'text', data: { text: `分享Pixiv ${pageUrl}?utm_source=discarded-tracking` } }], raw_message: `分享Pixiv ${pageUrl}?utm_source=discarded-tracking` }
    const expectedIndices = scenario.kind === 'restricted' ? [] : scenario.kind === 'partial' ? [0, 2] : [0, 1, 2]
    const server = createServer(async (req, res) => {
      try {
        if (req.url !== '/audit/request') { modelRequests++; res.writeHead(500).end('{}'); return }
        const url = new URL(decodeURIComponent(req.headers['x-pixiv-source-url']))
        assert.equal(req.method, 'GET'); assert.equal(req.headers['x-pixiv-pinned'], '93.184.216.34')
        assert.equal(req.headers['x-pixiv-agent'], 'owned-pinned-socket'); assert.equal(req.headers['x-pixiv-signal'], 'true')
        assert.equal(req.headers['accept-encoding'], 'identity'); assert.equal(req.headers.referer, 'https://www.pixiv.net/'); assert.equal(req.headers.authorization, undefined)
        for (const forbidden of [modelKey, qqToken, String(groupId), String(userId), 'Pixiv合成验收员']) assert.equal(JSON.stringify(req.headers).includes(forbidden), false)
        downloads.push(url.href); events.push(url.hostname === 'www.pixiv.net' ? 'metadata' : 'image')
        let bytes, mime
        if ([metadataUrl, metadataUrl + '/pages'].includes(url.href)) {
          assert.equal(req.headers.cookie, authCookie); assert.equal(req.headers.accept, 'application/json')
          bytes = Buffer.from(JSON.stringify({ error: false, body: url.href === metadataUrl ? metadata : imageUrls.map(regular => ({ urls: { regular } })) })); mime = 'application/json'
        } else {
          assert.equal(url.hostname, 'i.pximg.net'); assert.equal(req.headers.cookie, undefined)
          assert.equal(JSON.stringify(req.headers).includes(cookieValue), false)
          const index = imageUrls.indexOf(url.href); assert.ok(index >= 0, 'only exact target page URL is downloaded')
          if (scenario.kind === 'restricted') assert.fail('restricted artwork must not request any CDN image')
          if (scenario.kind === 'partial' && index === 1) { res.writeHead(503).end(); return }
          bytes = images[index]; mime = 'image/png'
        }
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(bytes.length) }); res.end(bytes)
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
          const request = JSON.parse(String(frame)), { action, params } = request; echo = request.echo; requests.push({ action, params }); events.push(action)
          let data
          if (action === 'get_login_info') data = { user_id: botId, nickname: 'Pixiv合成机器人' }
          else if (action === 'get_msg') { assert.equal(Number(params.message_id), source.message_id); data = source }
          else if (action === 'send_group_forward_msg') {
            deliveries.push({ action, params }); assert.equal(String(params.group_id), String(groupId)); assert.equal(params.messages.length, 1 + expectedIndices.length)
            assert.deepEqual(params.messages.map(node => node.data.content.map(part => part.type)), [['text'], ...expectedIndices.map(() => ['image'])])
            const info = params.messages[0].data.content[0].data.text
            assert.ok(info.includes(pageUrl)); assert.ok(info.includes('合成画师')); assert.ok(info.includes('合成标签')); assert.ok(info.includes('页数:3'))
            assert.ok(info.includes(description.replace(/<br>/gu, ' ')))
            if (scenario.kind === 'restricted') assert.ok(info.includes('受限内容'))
            if (scenario.kind === 'partial') assert.ok(info.includes('第2页图片暂时获取失败'))
            for (const [index, node] of params.messages.entries()) {
              assert.equal(node.type, 'node'); assert.equal(String(node.data.uin), String(botId))
              if (!index) continue
              const segment = node.data.content[0]; capabilities.push(segment.data.file)
              assert.match(segment.data.file, /^http:\/\/127\.0\.0\.1:\d+\/agent-media-relay\/[a-f\d]{64}$/u)
              const response = await fetch(segment.data.file); assert.equal(response.status, 200)
              const bytes = Buffer.from(await response.arrayBuffer()), expected = images[expectedIndices[index - 1]]
              assert.deepEqual(bytes, expected); assert.equal(Number(response.headers.get('content-length')), expected.length)
              resources.push({ index: expectedIndices[index - 1], sha256: sha(bytes), bytes: bytes.length })
            }
            if (scenario.unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo, message: 'handler acknowledgement lost' })); return }
            data = { message_id: 97201 }
          } else assert.fail(`Unexpected OneBot action: ${action}`)
          if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
        } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null })) }
      })
    })
    t.after(async () => {
      if (t.error) t.diagnostic(JSON.stringify({ log, errors, events, downloads, resources }))
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
      model: { baseUrl: `http://127.0.0.1:${apiPort}/model/v1`, name: 'pixiv-fixture', apiKeyEnv: 'PIXIV_MODEL_KEY' },
      connections: [{ id: 'main', url: `ws://127.0.0.1:${apiPort}/onebot`, accessTokenEnv: 'PIXIV_QQ_TOKEN' }],
      mediaRelay: { enabled: true, pixiv: { enabled: true, cookieEnv: 'PIXIV_COOKIE' }, bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort },
        advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
      memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
      simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } })
    const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(botId) }],
      bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] })
    await writeFile(configFile, configText); await writeFile(path.join(directory, 'agent-bindings.yaml'), bindingsText)
    const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, PIXIV_MODEL_KEY: modelKey, PIXIV_QQ_TOKEN: qqToken,
      PIXIV_COOKIE: authCookie, PIXIV_RELAY_AUDIT_URL: `http://127.0.0.1:${apiPort}/audit` }
    const launch = check => {
      child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    }
    launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
    assert.deepEqual(requests.map(row => row.action), ['get_login_info']); assert.deepEqual(downloads, []); assert.equal(modelRequests, 0)
    await assert.rejects(lstat(dataDir), { code: 'ENOENT' }); await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(await reader.keys(`${prefix}*`), [])
    log = ''; launch(false)
    await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI ready')
    websocket.send(JSON.stringify(source))
    const records = async () => Promise.all((await reader.keys(`${prefix}agent:media-outbox:v1:job:*`)).map(async key => JSON.parse(await reader.get(key))))
    await waitFor(async () => (await records()).some(record => record.state === (scenario.unknown ? 'unknown' : 'completed')), 'terminal media outbox')
    assert.deepEqual(errors, []); assert.equal(deliveries.length, 1)
    assert.deepEqual(resources, expectedIndices.map(index => ({ index, sha256: sha(images[index]), bytes: images[index].length })))
    assert.deepEqual((await records())[0].effects.map(row => [row.effect, row.state]), [['forward', scenario.unknown ? 'unknown' : 'sent']])
    assert.ok(requests.filter(row => row.action === 'get_msg').length >= 2)
    const sendAt = events.indexOf('send_group_forward_msg'), prepareAt = events.indexOf('metadata')
    assert.ok(events.slice(0, prepareAt).includes('get_msg')); assert.ok(events.slice(prepareAt + 1, sendAt).includes('get_msg'), 'source is revalidated after preparation')
    assert.equal(modelRequests, 0)
    assert.deepEqual(downloads.filter(url => new URL(url).hostname === 'www.pixiv.net').sort(), [metadataUrl, metadataUrl + '/pages'].sort())
    assert.deepEqual(downloads.filter(url => new URL(url).hostname === 'i.pximg.net'), scenario.kind === 'restricted' ? [] : imageUrls)
    for (const capability of capabilities) assert.equal((await fetch(capability)).status, 404)
    websocket.send(JSON.stringify(source)); await delay(1400); assert.equal(deliveries.length, 1); assert.equal(downloads.length, scenario.kind === 'restricted' ? 2 : 5)
    child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(errors, [])
    const mediaRoot = (await readdir(dataDir)).find(name => name.startsWith('.agent-media-relay-')); assert.ok(mediaRoot)
    assert.deepEqual(await readdir(path.join(dataDir, mediaRoot)), ['.owner.json'])
    assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(path.join(directory, 'agent-bindings.yaml'), 'utf8'), bindingsText)
    const privateValues = [cookieValue, authCookie, modelKey, qqToken]
    const variants = privateValues.flatMap(value => [value, encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value)), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')])
    for (const content of [log, await redisContents(reader, prefix), await files(dataDir)]) for (const forbidden of [metadataUrl, ...imageUrls,
      'PIXIV_CLI_UPSTREAM_PRIVATE', 'i.pximg.net', ...variants, ...images.map(value => value.toString('base64')), 'base64://', ...capabilities]) {
      assert.equal(content.includes(forbidden), false, 'logs, Redis and persisted files exclude credentials, upstream URLs, bytes and capabilities')
    }
  })
}

