import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
import sharp from 'sharp'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/mediaRelayPreload.mjs', import.meta.url))
const botId = 19000931, userId = 330931, groupId = 319301, BV = 'BV1H7Gq6zEiC'
const modelKey = 'media-cli-model-private-key', qqToken = 'media-cli-onebot-private-token', biliCookie = 'SESSDATA=MEDIA_CLI_PRIVATE_SESSION; bili_jct=MEDIA_CLI_PRIVATE_JCT'
const DOUYIN_ID = '7651971027728274617'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const coverColor = { r: 41, g: 148, b: 184 }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const MP4 = Buffer.alloc(128, 0x21); MP4.writeUInt32BE(24); MP4.write('ftyp', 4); MP4.write('isom', 8); MP4.write('isom', 16); MP4.write('isom', 20)
async function waitFor(probe, description, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(25) }
  assert.fail(`timed out: ${description}`)
}
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const filename = path.join(directory, item.name)
    if (item.isDirectory()) result.push(...await files(filename))
    else if (item.isFile()) result.push(await readFile(filename, 'utf8'))
  }
  return result.join('\n')
}
async function redisContents(reader, prefix) {
  const values = []
  for await (const page of reader.scanIterator({ MATCH: `${prefix}*` })) for (const key of Array.isArray(page) ? page : [page]) {
    const type = await reader.type(key)
    const value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key)
      : type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key)
        : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : type === 'stream' ? await reader.xRange(key, '-', '+') : null
    values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}

for (const provider of ['bilibili', 'douyin']) test(`actual CLI relays ${provider} through the owned store, bridge HTTP and one native image-first forward`, { timeout: 45_000 }, async t => {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'media CLI acceptance requires real Redis')
  const bili = provider === 'bilibili'
  const upstream = `https://${bili ? 'cn-media.bilivideo.com' : 'v3.douyinvod.com'}/synthetic.mp4?token=MEDIA_UPSTREAM_PRIVATE`
  const cover = await sharp({ create: { width: bili ? 1200 : 640, height: bili ? 640 : 1200, channels: 3, background: coverColor } }).png().toBuffer()
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-media-cli-')), socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit'), sockets = new WebSocketServer({ noServer: true })
  const requests = [], downloads = [], deliveries = [], resources = [], errors = []
  let child, exited, reader, websocket, log = '', modelRequests = 0
  const now = Math.floor(Date.now() / 1000), instance = 'media-cli', prefix = `bl-agent:${instance}:`
  const source = { post_type: 'message', message_type: 'group', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '媒体合成验收员' }, message_id: 93101, time: now,
    message: bili ? [{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: {
      title: '哔哩哔哩', desc: '合成视频', qqdocurl: `https://www.bilibili.com/video/${BV}?share_source=qq`, host: { uin: '999999' },
    } } }) } }] : [{ type: 'text', data: { text: `https://www.douyin.com/video/${DOUYIN_ID}` } }], raw_message: '' }
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== '/bili-audit') { modelRequests++; res.writeHead(500).end('{}'); return }
      const url = new URL(decodeURIComponent(req.headers['x-media-source-url']))
      assert.equal(req.method, 'GET'); assert.equal(req.headers['x-media-pinned'], '93.184.216.34')
      assert.equal(req.headers['x-media-agent'], 'false'); assert.equal(req.headers['x-media-signal'], 'true')
      assert.equal(req.headers['accept-encoding'], 'identity')
      const headers = JSON.stringify(req.headers)
      for (const secret of [modelKey, qqToken, 'MEDIA_CLI_PRIVATE_SESSION', 'MEDIA_CLI_PRIVATE_JCT', String(groupId), String(userId), '媒体合成验收员']) {
        assert.equal(headers.includes(secret), false, 'Bili request has no host secrets or conversation context')
      }
      downloads.push({ url: url.href, headers: { ...req.headers } })
      let body, mime = 'application/json'
      if (url.pathname.endsWith('/finger/spi')) body = { code: 0, data: { b_3: 'CLI_BUVID_PRIVATE', b_4: 'CLI_BUVID4_PRIVATE' } }
      else if (url.pathname.endsWith('/web-interface/view')) {
        assert.equal(url.searchParams.get('bvid'), BV)
        body = { code: 0, data: { bvid: BV, cid: 11, title: 'CLI合成视频', desc: '完整合成简介', duration: 60, videos: 1,
          owner: { name: '合成UP' }, pages: [{ page: 1, cid: 11, part: 'P1', duration: 60 }], pic: 'https://i0.hdslb.com/cover.png', stat: { view: 12 } } }
      } else if (url.pathname.endsWith('/player/playurl')) {
        assert.equal(url.searchParams.get('qn'), '6'); assert.equal(url.searchParams.get('fnval'), '0')
        body = { code: 0, data: { quality: 6, support_formats: [{ quality: 6, new_description: '240P' }],
          durl: [{ url: upstream, length: 60000, size: MP4.length }] } }
      } else if (url.hostname === 'www.douyin.com') {
        assert.equal(url.pathname, `/video/${DOUYIN_ID}`)
        const data = { items: [{ aweme_id: DOUYIN_ID, desc: 'CLI合成抖音视频', duration: 60, author: { nickname: '合成作者' },
          video: { play_addr: { url_list: [upstream] }, cover: { url_list: ['https://p3.douyinpic.com/cover.png'] } } }] }
        body = Buffer.from(`<script>window._ROUTER_DATA = ${JSON.stringify(data)}</script>`); mime = 'text/html'
      } else if (url.hostname.endsWith('.hdslb.com') || url.hostname.endsWith('.douyinpic.com')) { body = cover; mime = 'image/png' }
      else if (url.hostname.endsWith('.bilivideo.com') || url.hostname.endsWith('.douyinvod.com')) { assert.equal(url.href, upstream); body = MP4; mime = 'video/mp4' }
      else assert.fail(`unexpected official endpoint: ${url.hostname}${url.pathname}`)
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
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
        const request = JSON.parse(String(frame)), { action, params } = request
        echo = request.echo; requests.push({ action, params })
        let data
        if (action === 'get_login_info') data = { user_id: botId, nickname: '媒体合成机器人' }
        else if (action === 'get_msg') { assert.equal(Number(params.message_id), source.message_id); data = source }
        else if (action === 'send_group_forward_msg') {
          deliveries.push({ action, params })
          assert.equal(String(params.group_id), String(groupId)); assert.equal(params.messages.length, 2)
          const [intro, video] = params.messages.map(node => node.data.content)
          assert.deepEqual(intro.map(part => part.type), ['image'])
          assert.deepEqual(video.map(part => part.type), ['video'])
          for (const node of params.messages) {
            assert.equal(node.type, 'node'); assert.equal(String(node.data.uin), String(botId))
            for (const segment of node.data.content) {
              if (segment.type === 'image' || segment.type === 'video') {
                const response = await fetch(segment.data.file)
                assert.equal(response.status, 200)
                const bytes = Buffer.from(await response.arrayBuffer())
                if (segment.type === 'video') assert.deepEqual(bytes, MP4)
                else {
                  assert.deepEqual(bytes.subarray(0, 8), PNG.subarray(0, 8))
                  assert.equal(bytes.readUInt32BE(16), 920, 'the first node contains a rendered card')
                  const pixel = await sharp(bytes).extract({ left: 460, top: 210, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
                  assert.deepEqual([...pixel], Object.values(coverColor), 'the first node embeds the actual official cover')
                }
                resources.push({ type: segment.type, bytes: bytes.length })
                if (segment.type === 'video') {
                  const thumbnail = await fetch(segment.data.thumb); assert.equal(thumbnail.status, 200)
                  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), JPEG); resources.push({ type: 'thumbnail', bytes: JPEG.length })
                }
              } else assert.equal(segment.type, 'text')
            }
          }
          data = { message_id: 93201 }
        } else assert.fail(`unexpected OneBot action: ${action}`)
        if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1, echo, data: null })) }
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, requests: requests.map(item => item.action), downloads: downloads.map(item => item.url), resources }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (exited) await exited
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
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
    model: { baseUrl: `http://127.0.0.1:${apiPort}/model/v1`, name: 'media-fixture', apiKeyEnv: 'MEDIA_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${apiPort}/onebot`, accessTokenEnv: 'MEDIA_QQ_TOKEN' }],
    mediaRelay: { enabled: true, bilibili: { cookieEnv: 'MEDIA_BILI_COOKIE', autoAuthorizedRetry: true }, douyin: { enabled: !bili }, bridges: [{ connectionId: 'main',
      listen: { host: '127.0.0.1', port: bridgePort }, advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] })
  await writeFile(configFile, configText); await writeFile(path.join(directory, 'agent-bindings.yaml'), bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, MEDIA_MODEL_KEY: modelKey, MEDIA_QQ_TOKEN: qqToken,
    MEDIA_BILI_COOKIE: biliCookie, MEDIA_RELAY_AUDIT_URL: `http://127.0.0.1:${apiPort}/bili-audit` }
  const launch = check => {
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
    exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  }
  launch(true)
  assert.deepEqual(await exited, [0, null], log)
  assert.equal(JSON.parse(log).mode, 'check')
  assert.deepEqual(requests.map(item => item.action), ['get_login_info'])
  assert.equal(downloads.length, 0); assert.equal(modelRequests, 0)
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' })
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
  assert.deepEqual(await reader.keys(`${prefix}*`), [])
  log = ''; launch(false)
  await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI ready')
  websocket.send(JSON.stringify(source))
  const records = async () => Promise.all((await reader.keys(`${prefix}agent:media-outbox:v1:job:*`)).map(async key => JSON.parse(await reader.get(key))))
  await waitFor(async () => (await records()).some(record => record.state === 'completed'), 'completed media outbox')
  assert.equal(deliveries.length, 1)
  assert.deepEqual(requests.filter(item => item.action.startsWith('send_')).map(item => item.action), ['send_group_forward_msg'])
  assert.deepEqual(resources.map(resource => resource.type), ['image', 'video', 'thumbnail'])
  assert.deepEqual((await records())[0].effects.map(row => [row.effect, row.state]), [['forward', 'sent']])
  assert.equal(modelRequests, 0)
  assert.deepEqual(downloads.map(item => new URL(item.url).hostname).sort(), bili
    ? ['api.bilibili.com', 'api.bilibili.com', 'api.bilibili.com', 'cn-media.bilivideo.com', 'i0.hdslb.com']
    : ['p3.douyinpic.com', 'v3.douyinvod.com', 'www.douyin.com'])
  websocket.send(JSON.stringify(source)); await delay(1200); assert.equal(deliveries.length, 1)
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
  assert.deepEqual(errors, [])
  const mediaRoot = (await readdir(dataDir)).find(name => name.startsWith('.agent-media-relay-'))
  assert.ok(mediaRoot); assert.deepEqual(await readdir(path.join(dataDir, mediaRoot)), ['.owner.json'])
  assert.equal(await readFile(configFile, 'utf8'), configText)
  assert.equal(await readFile(path.join(directory, 'agent-bindings.yaml'), 'utf8'), bindingsText)
  const surfaces = [log, await redisContents(reader, prefix), await files(dataDir)]
  for (const content of surfaces) for (const forbidden of [upstream, 'MEDIA_UPSTREAM_PRIVATE', '.bilivideo.com', '.douyinvod.com', modelKey, qqToken,
    biliCookie, 'MEDIA_CLI_PRIVATE_SESSION', 'MEDIA_CLI_PRIVATE_JCT', 'CLI_BUVID_PRIVATE', 'CLI_BUVID4_PRIVATE', MP4.toString('base64'), 'base64://']) {
    assert.equal(content.includes(forbidden), false, 'logs, Redis and persisted files exclude native resources and secrets')
  }
})
