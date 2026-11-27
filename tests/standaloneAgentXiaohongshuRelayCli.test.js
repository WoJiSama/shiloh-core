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
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/xiaohongshuRelayPreload.mjs', import.meta.url))
const botId = 19000961, userId = 330961, groupId = 319601, workId = '6ad4a9c200000000290162d4'
const modelKey = 'xiaohongshu-cli-model-private-key', qqToken = 'xiaohongshu-cli-onebot-private-token'
const upstream = 'https://sns-video-qc.xhscdn.com/stream/main.mp4?sign=XHS_CLI_UPSTREAM_PRIVATE'
const liveUpstream = 'https://sns-video-qc.xhscdn.com/stream/live.mp4?sign=XHS_CLI_LIVE_PRIVATE'
const shareToken = 'Xhs_Cli_Access+Private/=', cookieValue = 'xhs-cli-cookie-private-value', authCookie = `web_session=${cookieValue}`
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const MP4 = Buffer.alloc(128, 0x21); MP4.writeUInt32BE(24); MP4.write('ftyp', 4); MP4.write('isom', 8); MP4.write('isom', 16); MP4.write('isom', 20)
const LIVE = Buffer.from(MP4); LIVE[100] = 0x32
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
const images = [png(40), png(80), png(120)], cover = png(160)
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

for (const scenario of [{ kind: 'video', unknown: false }, { kind: 'note', unknown: false }, { kind: 'video', unknown: true }]) {
  test(`actual Xiaohongshu CLI ${scenario.kind} ${scenario.unknown ? 'unknown receipt freezes without retry' : 'completes one native forward'} through verified source, owned resources and HTTP bridge`, { timeout: 45000 }, async t => {
    assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'CLI acceptance requires real Redis')
    const directory = await mkdtemp(path.join(tmpdir(), 'standalone-xiaohongshu-cli-')), socketPath = path.join(directory, 'redis.sock')
    const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
    const sockets = new WebSocketServer({ noServer: true }), requests = [], downloads = [], native = [], deliveries = [], resources = [], capabilities = [], errors = [], events = []
    let child, exited, reader, websocket, log = '', modelRequests = 0
    const now = Math.floor(Date.now() / 1000), instance = 'xiaohongshu-cli', prefix = `bl-agent:${instance}:`, pageUrl = `https://www.xiaohongshu.com/explore/${workId}`
    const accessPage = `${pageUrl}?xsec_token=${encodeURIComponent(shareToken)}&xsec_source=app_share&type=${scenario.kind === 'video' ? 'video' : 'normal'}`
    const description = `完整正文第一段：小红书实际CLI合成验收。\n第二段：保留段落、统计和图片对应的实况。`
    const source = { post_type: 'message', message_type: 'group', self_id: botId, group_id: groupId, user_id: userId,
      sender: { user_id: userId, nickname: '小红书合成验收员' }, message_id: 95101, time: now,
      message: [{ type: 'text', data: { text: `分享小红书 ${accessPage}` } }], raw_message: `分享小红书 ${accessPage}` }
    const item = { noteId: workId, title: scenario.kind === 'video' ? 'CLI合成视频' : 'CLI图集与实况', desc: description,
      type: scenario.kind === 'video' ? 'video' : 'normal', user: { nickname: '合成作者' }, interactInfo: { liked: '1.2万', collected: '8', commentCount: '2' },
      ...(scenario.kind === 'video' ? { video: { image: { firstFrameUrl: 'https://sns-webpic-qc.xhscdn.com/cover.png' },
        media: { stream: { h264: [{ masterUrl: upstream, duration: 16 }] } } }, imageList: [] }
        : { video: { media: { stream: { h264: [{ masterUrl: upstream, duration: 2 }] } } },
          imageList: images.map((_bytes, index) => ({ url: `https://sns-webpic-qc.xhscdn.com/${index + 1}.png`,
            ...(index === 1 ? { livePhoto: true, stream: { h264: [{ masterUrl: liveUpstream, duration: 2 }] } } : {}) })) }) }
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [workId]: { note: item } } } })}</script>`
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/audit/native') {
          let text = ''; for await (const chunk of req) text += chunk
          native.push(JSON.parse(text)); res.writeHead(200).end('{}'); return
        }
        if (req.url !== '/audit/request') { modelRequests++; res.writeHead(500).end('{}'); return }
        const url = new URL(decodeURIComponent(req.headers['x-xiaohongshu-source-url']))
        assert.equal(req.method, 'GET'); assert.equal(req.headers['x-xiaohongshu-pinned'], '93.184.216.34')
        assert.equal(req.headers['x-xiaohongshu-agent'], 'false'); assert.equal(req.headers['x-xiaohongshu-signal'], 'true')
        assert.equal(req.headers['accept-encoding'], 'identity'); assert.equal(req.headers.referer, 'https://www.xiaohongshu.com/')
        for (const forbidden of [modelKey, qqToken, String(groupId), String(userId), '小红书合成验收员']) assert.equal(JSON.stringify(req.headers).includes(forbidden), false)
        downloads.push(url.href); events.push('download')
        let bytes, mime
        if (url.hostname === 'www.xiaohongshu.com') {
          assert.equal(url.pathname, `/explore/${workId}`); assert.equal(url.searchParams.get('xsec_token'), shareToken)
          assert.equal(url.searchParams.get('xsec_source'), 'app_share'); assert.equal(url.searchParams.get('type'), scenario.kind === 'video' ? 'video' : 'normal')
          assert.equal(req.headers.cookie, authCookie); bytes = Buffer.from(html); mime = 'text/html'
        }
        else if (url.href === upstream && scenario.kind === 'video') { bytes = MP4; mime = 'video/mp4' }
        else if (url.href === liveUpstream && scenario.kind === 'note') { bytes = LIVE; mime = 'video/mp4' }
        else if (url.href === 'https://sns-webpic-qc.xhscdn.com/cover.png' && scenario.kind === 'video') { bytes = cover; mime = 'image/png' }
        else if (scenario.kind === 'note' && /^https:\/\/sns-webpic-qc\.xhscdn\.com\/[1-3]\.png$/u.test(url.href)) { bytes = images[Number(url.pathname.slice(1, 2)) - 1]; mime = 'image/png' }
        else assert.fail(`Unexpected Xiaohongshu endpoint: ${url.hostname}${url.pathname}`)
        if (url.hostname !== 'www.xiaohongshu.com') { assert.equal(req.headers.cookie, undefined); assert.equal(url.href.includes(shareToken), false); assert.equal(url.href.includes(encodeURIComponent(shareToken)), false) }
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
          if (action === 'get_login_info') data = { user_id: botId, nickname: '小红书合成机器人' }
          else if (action === 'get_msg') { assert.equal(Number(params.message_id), source.message_id); data = source }
          else if (action === 'send_group_forward_msg') {
            deliveries.push({ action, params }); assert.equal(String(params.group_id), String(groupId))
            assert.equal(params.messages.length, scenario.kind === 'video' ? 3 : 5)
            assert.equal(JSON.stringify(params).includes('xsec_token'), false)
            assert.equal(params.messages.at(-1).data.content.map(part => part.data.text ?? '').join(''), description)
            assert.deepEqual(params.messages.map(node => node.data.content.map(part => part.type)), scenario.kind === 'video'
              ? [['image'], ['video'], ['text']] : [['image'], ['image'], ['video'], ['image'], ['text']])
            for (const [index, node] of params.messages.entries()) {
              assert.equal(node.type, 'node'); assert.equal(String(node.data.uin), String(botId))
              for (const segment of node.data.content) {
                if (segment.type !== 'image' && segment.type !== 'video') { assert.equal(segment.type, 'text'); continue }
                capabilities.push(segment.data.file)
                assert.match(segment.data.file, /^http:\/\/127\.0\.0\.1:\d+\/agent-media-relay\/[a-f\d]{64}$/u)
                const response = await fetch(segment.data.file); assert.equal(response.status, 200)
                const bytes = Buffer.from(await response.arrayBuffer())
                if (index === 0) {
                  assert.equal(response.headers.get('content-type'), 'image/png')
                  assert.equal(bytes.readUInt32BE(16), 920, 'the note starts with a rendered image card')
                  resources.push({ type: 'card' })
                  continue
                }
                const expected = scenario.kind === 'video' ? MP4 : segment.type === 'video' ? LIVE : images[index === 1 ? 0 : 2]
                assert.deepEqual(bytes, expected); assert.equal(Number(response.headers.get('content-length')), expected.length)
                resources.push({ type: segment.type, sha256: sha(bytes), bytes: bytes.length })
                if (segment.type === 'video') {
                  capabilities.push(segment.data.thumb); const thumbnail = await fetch(segment.data.thumb); assert.equal(thumbnail.status, 200)
                  const jpeg = Buffer.from(await thumbnail.arrayBuffer()); assert.deepEqual(jpeg, JPEG)
                  resources.push({ type: 'thumbnail', sha256: sha(jpeg), bytes: jpeg.length })
                }
              }
            }
            if (scenario.unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo, message: 'handler acknowledgement lost', wording: 'handler acknowledgement lost' })); return }
            data = { message_id: 95201 }
          } else assert.fail(`Unexpected OneBot action: ${action}`)
          if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
        } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, echo, data: null })) }
      })
    })
    t.after(async () => {
      if (t.error) t.diagnostic(JSON.stringify({ log, errors, events, downloads, native, resources }))
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
      model: { baseUrl: `http://127.0.0.1:${apiPort}/model/v1`, name: 'xiaohongshu-fixture', apiKeyEnv: 'XIAOHONGSHU_MODEL_KEY' },
      connections: [{ id: 'main', url: `ws://127.0.0.1:${apiPort}/onebot`, accessTokenEnv: 'XIAOHONGSHU_QQ_TOKEN' }],
      mediaRelay: { enabled: true, xiaohongshu: { enabled: true, cookieEnv: 'XIAOHONGSHU_COOKIE' }, bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort },
        advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
      memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
      simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false } } })
    const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(botId) }],
      bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] })
    await writeFile(configFile, configText); await writeFile(path.join(directory, 'agent-bindings.yaml'), bindingsText)
    const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, XIAOHONGSHU_MODEL_KEY: modelKey, XIAOHONGSHU_QQ_TOKEN: qqToken, XIAOHONGSHU_COOKIE: authCookie,
      XIAOHONGSHU_RELAY_AUDIT_URL: `http://127.0.0.1:${apiPort}/audit` }
    const launch = check => {
      child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    }
    launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check')
    assert.deepEqual(requests.map(row => row.action), ['get_login_info']); assert.deepEqual(downloads, []); assert.deepEqual(native, [])
    assert.equal(modelRequests, 0); await assert.rejects(lstat(dataDir), { code: 'ENOENT' })
    await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(await reader.keys(`${prefix}*`), [])
    log = ''; launch(false)
    await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI ready')
    websocket.send(JSON.stringify(source))
    const records = async () => Promise.all((await reader.keys(`${prefix}agent:media-outbox:v1:job:*`)).map(async key => JSON.parse(await reader.get(key))))
    await waitFor(async () => (await records()).some(record => record.state === (scenario.unknown ? 'unknown' : 'completed')), 'terminal media outbox')
    assert.deepEqual(errors, []); assert.equal(deliveries.length, 1)
    const expected = scenario.kind === 'video' ? [{ type: 'video', sha256: sha(MP4), bytes: MP4.length },
      { type: 'thumbnail', sha256: sha(JPEG), bytes: JPEG.length }] : [{ type: 'image', sha256: sha(images[0]), bytes: images[0].length },
      { type: 'video', sha256: sha(LIVE), bytes: LIVE.length }, { type: 'thumbnail', sha256: sha(JPEG), bytes: JPEG.length },
      { type: 'image', sha256: sha(images[2]), bytes: images[2].length }]
    assert.deepEqual(resources, [{ type: 'card' }, ...expected])
    assert.deepEqual((await records())[0].effects.map(row => [row.effect, row.state]), [['forward', scenario.unknown ? 'unknown' : 'sent']])
    assert.ok(requests.filter(row => row.action === 'get_msg').length >= 2, 'Core rereads the original source before delivery')
    const sendAt = events.indexOf('send_group_forward_msg'), downloadAt = events.indexOf('download')
    assert.ok(events.slice(0, downloadAt).includes('get_msg')); assert.ok(events.slice(downloadAt + 1, sendAt).includes('get_msg'), 'source revalidated after preparation')
    assert.equal(modelRequests, 0)
    assert.deepEqual(native, [{ operation: 'thumbnail', synthetic: true }])
    assert.deepEqual(downloads.slice().sort(), (scenario.kind === 'video' ? [accessPage, upstream, 'https://sns-webpic-qc.xhscdn.com/cover.png']
      : [accessPage, 'https://sns-webpic-qc.xhscdn.com/1.png', liveUpstream, 'https://sns-webpic-qc.xhscdn.com/3.png']).sort())
    for (const capability of capabilities) assert.equal((await fetch(capability)).status, 404)
    websocket.send(JSON.stringify(source)); await delay(1400); assert.equal(deliveries.length, 1); assert.equal(downloads.length, scenario.kind === 'video' ? 3 : 4)
    child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log)
    await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)); assert.deepEqual(errors, [])
    const mediaRoot = (await readdir(dataDir)).find(name => name.startsWith('.agent-media-relay-'))
    assert.ok(mediaRoot); assert.deepEqual(await readdir(path.join(dataDir, mediaRoot)), ['.owner.json'])
    assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(path.join(directory, 'agent-bindings.yaml'), 'utf8'), bindingsText)
    const privateValues = [shareToken, cookieValue, authCookie, modelKey, qqToken]
    const variants = privateValues.flatMap(value => [value, encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value)),
      Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')])
    for (const content of [log, await redisContents(reader, prefix), await files(dataDir)]) for (const forbidden of [upstream, liveUpstream, accessPage,
      'XHS_CLI_UPSTREAM_PRIVATE', 'XHS_CLI_LIVE_PRIVATE', 'sns-video-qc.xhscdn.com', 'sns-webpic-qc.xhscdn.com', 'xsecToken', 'xsec_token',
      ...variants, MP4.toString('base64'), cover.toString('base64'), 'base64://', ...capabilities]) {
      assert.equal(content.includes(forbidden), false, 'logs, Redis and persisted host files exclude secrets, resource bytes and capability URLs')
    }
  })
}
