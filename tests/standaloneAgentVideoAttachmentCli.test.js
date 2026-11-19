import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
// The CLI, Redis, WebSocket and resource HTTP bridge really run. The preload
// substitutes official TLS sockets and ffmpeg, so these checks prove bounded
// container/byte delivery rather than external availability or video playback.
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/bilibiliQualityPreload.mjs', import.meta.url))
const BOT = 19000319, USER = 330319, GROUP = 310319, BV = 'BV1H7Gq6zEiC'
const MODEL_KEY = 'VIDEO_ATTACHMENT_MODEL_PRIVATE_123456', QQ_TOKEN = 'VIDEO_ATTACHMENT_QQ_PRIVATE_123456', BUVID = 'VIDEO_ATTACHMENT_BUVID_PRIVATE_123456'
const UPSTREAM = 'https://cn-quality.bilivideo.com/attachment.mp4?token=VIDEO_ATTACHMENT_CDN_PRIVATE_123456'
const UPSTREAM_SECOND = 'https://cn-quality.bilivideo.com/attachment-second.mp4?token=VIDEO_ATTACHMENT_SECOND_CDN_PRIVATE_123456'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const MP4 = Buffer.alloc(128, 0x23); MP4.writeUInt32BE(24); MP4.write('ftyp', 4); MP4.write('isom', 8); MP4.write('isom', 16); MP4.write('isom', 20)
const MP4_SECOND = Buffer.from(MP4); MP4_SECOND.fill(0x24, 24)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const completion = (name, input, id) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { total_tokens: 15 } })
async function waitFor(probe, label, timeout = 25000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await probe()) return; await delay(25) }; assert.fail(`timed out: ${label}`) }
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const file = path.join(directory, item.name); if (item.isDirectory()) result.push(await files(file)); else if (item.isFile()) result.push(await readFile(file, 'utf8'))
  }
  return result.join('\n')
}
async function redisText(reader, prefix) {
  const values = []
  for (const key of await reader.keys(prefix + '*')) {
    const type = await reader.type(key), value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key) : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : null
    values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}
async function fixture(t, { unknown = false, attachments = true } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'attachment CLI requires actual Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'video-attachment-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const instance = 'video-attachment-cli', prefix = `bl-agent:${instance}:`, sources = new Map(), external = [], actions = [], forwards = [], resources = [], models = [], errors = []
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  let child, exited, reader, websocket, log = '', phase = 'check'
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/bilibili-audit') {
        assert.equal(phase, 'run'); assert.equal(attachments, true); assert.equal(req.method, 'GET'); assert.equal(req.headers['x-bilibili-pinned'], '93.184.216.34')
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['accept-encoding'], 'identity')
        const url = new URL(decodeURIComponent(req.headers['x-bilibili-source-url'])); external.push({ host: url.hostname, path: url.pathname, qn: url.searchParams.get('qn') })
        for (const secret of [MODEL_KEY, QQ_TOKEN, String(BOT), String(USER), String(GROUP), '群内隐私']) assert.equal(JSON.stringify(req.headers).includes(secret), false)
        let payload, mime = 'application/json'
        if (url.pathname === '/x/frontend/finger/spi') { assert.equal(req.headers.cookie, undefined); payload = { code: 0, data: { b_3: BUVID } } }
        else if (url.pathname === '/x/web-interface/search/type') {
          assert.equal(url.hostname, 'api.bilibili.com'); assert.equal(req.headers.cookie, `buvid3=${BUVID}`); assert.equal(url.searchParams.get('keyword'), '完整合成视频')
          assert.equal(url.searchParams.get('order'), 'totalrank'); assert.equal(url.searchParams.get('search_type'), 'video'); assert.equal(url.searchParams.get('page'), '1')
          payload = { code: 0, data: { result: [{ bvid: BV, title: '完整合成视频首选', author: '公开作者', duration: '01:00' }] } }
        } else if (url.pathname === '/x/web-interface/view') {
          assert.equal(url.searchParams.get('bvid'), BV); assert.equal(req.headers.cookie, `buvid3=${BUVID}`)
          payload = { code: 0, data: { bvid: BV, cid: 11, title: '完整合成视频首选', desc: '完整公开介绍', duration: 60, videos: 1, owner: { name: '公开作者' },
            pages: [{ page: 1, cid: 11, part: '第一P', duration: 60 }], pic: 'https://i0.hdslb.com/cover.png', stat: { view: 12 } } }
        } else if (url.pathname === '/x/player/playurl') {
          assert.equal(url.searchParams.get('bvid'), BV); assert.equal(url.searchParams.get('cid'), '11'); assert.equal(url.searchParams.get('qn'), '16'); assert.equal(url.searchParams.get('fnval'), '0'); assert.equal(url.searchParams.get('fourk'), '0')
          assert.equal(req.headers.cookie, `buvid3=${BUVID}`, 'anonymous attachments never inherit authorized cookies')
          payload = { code: 0, data: { quality: 16, is_preview: 0, timelength: 60000, support_formats: [{ quality: 16, new_description: '360P' }], durl: [
            { order: 1, url: UPSTREAM, length: 30000, size: MP4.length }, { order: 2, url: UPSTREAM_SECOND, length: 30000, size: MP4_SECOND.length },
          ] } }
        } else if (url.hostname === 'i0.hdslb.com') { assert.equal(req.headers.cookie, undefined); payload = PNG; mime = 'image/png' }
        else if (url.hostname === 'cn-quality.bilivideo.com') { assert.ok([UPSTREAM, UPSTREAM_SECOND].includes(url.href)); assert.equal(req.headers.cookie, undefined); payload = url.href === UPSTREAM ? MP4 : MP4_SECOND; mime = 'video/mp4' }
        else assert.fail('unexpected attachment endpoint')
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)); res.writeHead(200, { 'content-type': mime, 'content-length': String(bytes.length) }).end(bytes); return
      }
      assert.equal(req.url, '/model/v1/chat/completions'); assert.equal(req.headers.authorization, `Bearer ${MODEL_KEY}`); assert.equal(phase, 'run')
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); models.push(body)
      const names = (body.tools ?? []).map(tool => tool.function.name)
      assert.equal(names.includes('searchVideoTool'), true); assert.equal(names.includes('videoShareTool'), true); assert.equal(names.includes('videoDownloadTool'), attachments)
      assert.ok(body.messages.some(row => row.role === 'user' && String(row.content).includes('群内隐私')))
      const found = body.messages.findLast(row => row.role === 'tool' && row.name === 'searchVideoTool')
      if (!attachments) { res.end(JSON.stringify({ choices: [{ message: { content: '本轮没有启用视频附件。' } }], usage: { total_tokens: 1 } })); return }
      if (!found) { assert.equal(forwards.length, 0); res.end(completion('searchVideoTool', { keyword: '完整合成视频' }, 'attachment-search')); return }
      assert.match(found.content, /完整合成视频首选/u); assert.ok(found.content.includes(BV)); assert.equal(forwards.length, 0, 'metadata search never sends a native message')
      // If the host incorrectly continues after an uncertain media send, this
      // malicious next request would attempt to retry. The host must never call it.
      assert.equal(models.length, 2, 'one search follow-up model call only')
      res.end(completion('videoDownloadTool', { index: 1 }, 'attachment-download'))
    } catch (error) { errors.push(String(error)); if (!res.destroyed) res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => { if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }; sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer)) })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', async frame => {
    let echo
    try {
      const request = JSON.parse(String(frame)); echo = request.echo; const { action, params } = request; actions.push({ action, params }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '视频附件验收机器人' }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'native source lookup stays in the original group and message') }
      else if (action === 'send_group_forward_msg') {
        assert.equal(attachments, true); assert.equal(String(params.group_id), String(GROUP)); assert.equal(models.length, 2); forwards.push(params)
        assert.equal(params.messages.length, 3)
        const text = params.messages.flatMap(node => node.data.content).filter(part => part.type === 'text').map(part => part.data.text).join('\n')
        assert.match(text, /完整合成视频首选/u); assert.match(text, /完整公开介绍/u); assert.equal(text.includes('群内隐私'), false)
        let videoIndex = 0
        for (const node of params.messages) for (const part of node.data.content) if (['image', 'video'].includes(part.type)) {
          const response = await fetch(part.data.file); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()), expected = part.type === 'video' ? [MP4, MP4_SECOND][videoIndex++] : PNG
          assert.equal(sha(bytes), sha(expected)); assert.deepEqual(bytes, expected); resources.push({ kind: part.type, size: bytes.length, sha256: sha(bytes), url: part.data.file })
          if (part.type === 'video') { assert.ok(bytes.length <= 30 * 1024 * 1024); const thumbnail = await fetch(part.data.thumb); assert.equal(thumbnail.status, 200); const owned = Buffer.from(await thumbnail.arrayBuffer()); assert.deepEqual(owned, JPEG); resources.push({ kind: 'thumbnail', size: owned.length, sha256: sha(owned), url: part.data.thumb }) }
        }
        if (unknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        data = { message_id: 96000 + actions.length }
      } else if (action === 'send_group_msg') {
        assert.equal(attachments, false, 'video delivery has no extra text confirmation or fallback'); assert.equal(String(params.group_id), String(GROUP))
        assert.equal(params.message.filter(part => part.type === 'text').map(part => part.data.text).join(''), '本轮没有启用视频附件。'); data = { message_id: 97000 + actions.length }
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
  }) })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions: actions.map(row => row.action), external, forwards: forwards.length, models }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening'); const bridgePort = allocator.address().port; await new Promise(resolve => allocator.close(resolve))
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness'); reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const configText = JSON.stringify({ version: 1, instance, dataDir, model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'video-attachment-fixture', apiKeyEnv: 'VIDEO_ATTACHMENT_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'VIDEO_ATTACHMENT_QQ_TOKEN' }], tools: { videoSearch: { enabled: true, ...(attachments ? { attachments: true } : {}) } },
    textGroups: [{ connectionId: 'main', conversationId: String(GROUP), tools: ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'] }],
    mediaRelay: { enabled: false, ...(attachments ? { bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort }, advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] } : {}) },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: String(GROUP), agentId: 'daily' }] })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, VIDEO_ATTACHMENT_MODEL_KEY: MODEL_KEY, VIDEO_ATTACHMENT_QQ_TOKEN: QQ_TOKEN, BILIBILI_QUALITY_AUDIT_URL: `http://127.0.0.1:${port}/bilibili-audit` }
  const launch = check => { child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes }) }
  const records = async () => Promise.all((await reader.keys(prefix + 'agent:video-search:v1:share:*')).map(async key => JSON.parse(await reader.get(key))))
  const queueEmpty = async () => (await Promise.all((await reader.keys(prefix + 'agent:inbox:group-text:*')).map(key => reader.lLen(key)))).every(count => count === 0)
  const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: BOT, group_id: GROUP, user_id: USER, sender: { user_id: USER, nickname: '视频附件验收员' },
    message_id: 95001, time: Math.floor(Date.now() / 1000), message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text: '请搜索完整合成视频并下载第1项视频附件。群内隐私不要发送给外部。' } }] }
  sources.set(String(source.message_id), source)
  return { actions, external, forwards, resources, models, records, get log() { return log },
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check'); assert.deepEqual(external, []); assert.equal(models.length, 0)
      assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' }); await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
      phase = 'run'; await this.restart()
      if (attachments) assert.equal((await fetch(`http://127.0.0.1:${bridgePort}/missing`)).status, 404); else await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
    },
    async restart() { log = ''; websocket = undefined; launch(false); await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness') },
    async run() {
      websocket.send(JSON.stringify(source))
      // The attachment tool owns a 240-second business deadline. Observe its
      // native outcome instead of killing an active download after 25 seconds.
      await waitFor(async () => attachments ? (await records()).some(row => row.state === (unknown ? 'unknown' : 'sent')) : actions.some(row => row.action === 'send_group_msg'), 'native video result', attachments ? 240_000 : 25_000)
      await waitFor(queueEmpty, 'text inbox drained'); assert.deepEqual(errors, [])
    },
    async replay() { websocket.send(JSON.stringify(source)); await delay(1200); await waitFor(queueEmpty, 'replayed text inbox drained'); assert.deepEqual(errors, []) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []); for (const resource of resources) await assert.rejects(fetch(resource.url)); await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`)) },
    async clean() {
      assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const content = log + await files(dataDir) + await redisText(reader, prefix) + JSON.stringify(models)
      for (const secret of [MODEL_KEY, QQ_TOKEN, BUVID, UPSTREAM, UPSTREAM_SECOND, 'VIDEO_ATTACHMENT_CDN_PRIVATE_123456', 'VIDEO_ATTACHMENT_SECOND_CDN_PRIVATE_123456', MP4.toString('base64'), MP4_SECOND.toString('base64'), ...resources.map(row => row.url)]) for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) assert.equal(content.includes(encoded), false, 'credentials, signed upstream references, bridge capabilities and bytes stay out of logs/models/persistent data')
      const root = (await readdir(dataDir)).find(name => name.startsWith('.agent-media-relay-')); if (root) assert.deepEqual(await readdir(path.join(dataDir, root)), ['.owner.json'])
    },
  }
}

test('actual CLI group text searches then sends one owned anonymous video attachment forward, without extra text and source replay', { timeout: 300000 }, async t => {
  const f = await fixture(t); await f.start(); await f.run()
  assert.equal(f.models.length, 2); assert.equal(f.forwards.length, 1); assert.deepEqual(f.resources.map(row => [row.kind, row.size]), [['image', PNG.length], ['video', MP4.length], ['thumbnail', JPEG.length], ['video', MP4_SECOND.length], ['thumbnail', JPEG.length]])
  assert.equal(f.external.filter(row => row.path.endsWith('/playurl')).length, 1); assert.equal(f.external.find(row => row.path.endsWith('/playurl')).qn, '16')
  const before = { requests: f.external.length, models: f.models.length }; await f.replay(); assert.equal(f.forwards.length, 1); assert.equal(f.external.length, before.requests); assert.equal(f.models.length, before.models)
  assert.equal(f.actions.filter(row => row.action.startsWith('send_')).length, 1); await f.stop(); await f.clean()
})

test('actual CLI uncertain video attachment freezes one native attempt across replay and restart without retry or text fallback', { timeout: 300000 }, async t => {
  const f = await fixture(t, { unknown: true }); await f.start(); await f.run(); assert.equal((await f.records())[0].state, 'unknown')
  assert.equal(f.forwards.length, 1); const before = { requests: f.external.length, models: f.models.length }; await f.replay(); await f.stop(); await f.restart(); await f.replay()
  assert.equal(f.forwards.length, 1); assert.equal(f.external.length, before.requests); assert.equal(f.models.length, before.models); assert.equal(f.actions.filter(row => row.action.startsWith('send_')).length, 1)
  await f.stop(); await f.clean()
})

test('actual CLI attachments default off grants metadata tools only and opens no media bridge or public download', { timeout: 60000 }, async t => {
  const f = await fixture(t, { attachments: false }); await f.start(); await f.run(); assert.deepEqual(f.external, []); assert.equal(f.forwards.length, 0); assert.deepEqual(await f.records(), [])
  assert.equal(f.models.length, 1); await f.stop(); await f.clean()
})
