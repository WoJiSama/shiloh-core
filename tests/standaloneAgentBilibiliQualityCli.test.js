import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs'), preload = fileURLToPath(new URL('./helpers/bilibiliQualityPreload.mjs', import.meta.url))
const BOT = 19000317, MASTER = 330317, GROUP = 310317, BV = 'BV1H7Gq6zEiC'
const MODEL_KEY = 'BILIBILI_HQ_MODEL_PRIVATE_123456', QQ_TOKEN = 'BILIBILI_HQ_QQ_PRIVATE_123456', QR_KEY = 'BILIBILI_HQ_QR_PRIVATE_123456789012345'
const SESS = 'BILIBILI_HQ_SESSION_PRIVATE_123,1700000000,abc*11', JCT = 'fedcba9876543210fedcba9876543210', UID = '8765432109', BUVID = 'BILIBILI_HQ_BUVID_PRIVATE_123'
const COOKIE = `SESSDATA=${SESS}; bili_jct=${JCT}; DedeUserID=${UID}`, QR_URL = `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${QR_KEY}&from=main_web`
const CALLBACK = `https://passport.biligame.com/crossDomain?SESSDATA=${encodeURIComponent(SESS)}&bili_jct=${JCT}&DedeUserID=${UID}&DedeUserID__ckMd5=123abc&Expires=0&gourl=https%3A%2F%2Fwww.bilibili.com`
const UPSTREAM = 'https://cn-quality.bilivideo.com/synthetic.mp4?token=BILIBILI_HQ_CDN_PRIVATE_123'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const MP4 = Buffer.alloc(128, 0x21); MP4.writeUInt32BE(24); MP4.write('ftyp', 4); MP4.write('isom', 8); MP4.write('isom', 16); MP4.write('isom', 20)
const textOf = segments => segments.filter(part => part.type === 'text').map(part => part.data.text).join('')
async function waitFor(probe, label, timeout = 20000) { const until = Date.now() + timeout; while (Date.now() < until) { const result = await probe(); if (result) return result; await delay(25) }; assert.fail(`timed out: ${label}`) }
async function diskText(directory, excludeVault = false) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (excludeVault && item.name.startsWith('.agent-bilibili-auth-')) continue
    const file = path.join(directory, item.name); if (item.isDirectory()) values.push(await diskText(file, excludeVault)); else if (item.isFile()) values.push(await readFile(file, 'utf8'))
  }
  return values.join('\n')
}
async function redisText(reader, prefix) {
  const values = []
  for (const key of await reader.keys(prefix + '*')) {
    const type = await reader.type(key), value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : type === 'list' ? await reader.lRange(key, 0, -1) : type === 'set' ? await reader.sMembers(key) : type === 'zset' ? await reader.zRangeWithScores(key, 0, -1) : type === 'stream' ? await reader.xRange(key, '-', '+') : undefined
    if (value === undefined) assert.equal(type, 'none'); values.push(JSON.stringify({ key, value }))
  }
  return values.join('\n')
}
async function fixture(t, { qrUnknown = false, mediaUnknown = false, holdQr = false, privateSource = false } = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'Bilibili HQ CLI requires real Redis')
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'bilibili-hq-cli-'))), dataDir = path.join(directory, 'data'), socketPath = path.join(directory, 'redis.sock')
  const instance = 'bilibili-hq-cli', prefix = `bl-agent:${instance}:`, sources = new Map(), external = [], actions = [], forwards = [], resources = [], modelBodies = [], errors = [], qrImages = []
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  let child, exited, reader, websocket, log = '', phase = 'check', epoch = 0, qrConfirmed = false, groupConfirmed = false, polls = 0, releaseQr
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== '/bilibili-audit') {
        assert.equal(req.url, '/model/v1/chat/completions'); assert.equal(phase, 'run'); assert.equal(req.headers.authorization, `Bearer ${MODEL_KEY}`)
        const chunks = []; for await (const chunk of req) chunks.push(chunk); modelBodies.push(JSON.parse(Buffer.concat(chunks).toString()))
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'B站操作未完成，请稍后核对。' } }], usage: { total_tokens: 1 } })); return
      }
      assert.equal(phase, 'run'); assert.equal(req.method, 'GET'); assert.equal(req.headers['x-bilibili-pinned'], '93.184.216.34'); assert.equal(req.headers.authorization, undefined)
      assert.equal(req.headers['accept-encoding'], 'identity'); const url = new URL(decodeURIComponent(req.headers['x-bilibili-source-url']))
      for (const privateValue of [MODEL_KEY, QQ_TOKEN, String(BOT), String(GROUP), String(MASTER), '群内私密']) assert.equal(JSON.stringify(req.headers).includes(privateValue), false)
      external.push({ epoch, host: url.hostname, path: url.pathname, requestedQuality: url.searchParams.get('qn'), authorized: req.headers.cookie?.includes(SESS) === true })
      let payload, mime = 'application/json'
      if (url.hostname === 'passport.bilibili.com') {
        assert.equal(req.headers.cookie, undefined)
        if (url.pathname.endsWith('/generate')) payload = { code: 0, data: { qrcode_key: QR_KEY, url: QR_URL } }
        else { assert.equal(url.pathname, '/x/passport-login/web/qrcode/poll'); assert.equal(url.searchParams.get('qrcode_key'), QR_KEY); assert.equal(qrConfirmed, true); if (!privateSource) assert.equal(groupConfirmed, true); polls++
          payload = { code: 0, data: { code: polls === 1 ? 86101 : 0, message: '', url: polls === 1 ? '' : CALLBACK, refresh_token: polls === 1 ? '' : 'BILIBILI_HQ_REFRESH_PRIVATE_123', timestamp: 0 } } }
      } else if (url.pathname.endsWith('/finger/spi')) { assert.equal(req.headers.cookie, undefined); payload = { code: 0, data: { b_3: BUVID } } }
      else if (url.pathname.endsWith('/web-interface/view')) {
        assert.equal(url.searchParams.get('bvid'), BV); assert.equal(req.headers.cookie, `buvid3=${BUVID}`)
        payload = { code: 0, data: { bvid: BV, cid: 11, title: 'CLI授权完整合成视频', desc: '公开合成介绍', duration: 60, videos: 1, owner: { name: '合成作者' }, pages: [{ page: 1, cid: 11, part: '第一P', duration: 60 }], pic: 'https://i0.hdslb.com/cover.png', stat: { view: 12 } } }
      } else if (url.pathname.endsWith('/player/playurl')) {
        assert.equal(url.searchParams.get('qn'), '80'); assert.equal(url.searchParams.get('cid'), '11'); assert.equal(url.searchParams.get('fnval'), '0'); assert.equal(url.searchParams.get('fourk'), '0'); assert.equal(req.headers.cookie, COOKIE + `; buvid3=${BUVID}`)
        payload = { code: 0, data: { quality: 64, is_preview: 0, timelength: 60000, support_formats: [{ quality: 64, new_description: '720P' }], durl: [{ order: 1, url: UPSTREAM, length: 60000, size: MP4.length }] } }
      } else if (url.hostname === 'i0.hdslb.com') { assert.equal(req.headers.cookie, undefined); payload = PNG; mime = 'image/png' }
      else if (url.hostname === 'cn-quality.bilivideo.com') { assert.equal(url.href, UPSTREAM); assert.equal(req.headers.cookie, COOKIE); payload = MP4; mime = 'video/mp4' }
      else assert.fail('unexpected Bilibili quality endpoint')
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)); res.writeHead(200, { 'content-type': mime, 'content-length': String(bytes.length) }).end(bytes)
    } catch (error) { errors.push(String(error)); if (!res.destroyed) res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => { if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${QQ_TOKEN}`) { socket.destroy(); return }; sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer)) })
  sockets.on('connection', peer => { websocket = peer; peer.on('message', async frame => {
    let echo
    try {
      const request = JSON.parse(String(frame)); echo = request.echo; const { action, params } = request; actions.push({ epoch, action, params }); let data
      if (action === 'get_login_info') data = { user_id: BOT, nickname: '高清授权合成机器人' }
      else if (action === 'get_friend_list') { assert.equal(privateSource, true); data = [{ user_id: MASTER, nickname: '高清合成验收员' }] }
      else if (action === 'get_msg') { data = sources.get(String(params.message_id)); assert.ok(data, 'read an actual recorded source') }
      else if (action === 'send_private_msg') {
        assert.equal(String(params.user_id), String(MASTER)); if (privateSource) assert.equal(Object.hasOwn(params, 'group_id'), false); else assert.equal(String(params.group_id), String(GROUP))
        assert.equal(Object.hasOwn(params, 'temp_source'), false)
        if (params.message[0].type === 'image') {
          const encoded = params.message[0].data.file; assert.ok(encoded.startsWith('base64://')); const bytes = Buffer.from(encoded.slice(9), 'base64'); assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(bytes.length <= 2 * 1024 * 1024); qrImages.push(encoded.slice(9))
          if (qrUnknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
          if (holdQr) await new Promise(resolve => { releaseQr = resolve })
          qrConfirmed = true
        } else { assert.ok(params.message.every(part => ['text', 'reply'].includes(part.type))); assert.ok(['B站授权已成功保存到当前绑定。', '当前绑定尚无B站授权。', '当前绑定已保存B站授权。'].includes(textOf(params.message))) }
        data = { message_id: 91000 + actions.length }
      } else if (action === 'send_group_msg') {
        assert.equal(String(params.group_id), String(GROUP)); const content = textOf(params.message)
        assert.equal(params.message.some(part => part.type === 'image'), false, 'QR never enters the group')
        if (content.includes('二维码已确认私发')) { assert.equal(qrConfirmed, true); groupConfirmed = true }
        data = { message_id: 92000 + actions.length }
      } else if (action === 'send_group_forward_msg') {
        assert.equal(String(params.group_id), String(GROUP)); forwards.push({ epoch, params }); assert.equal(params.messages.length, 2)
        const text = params.messages.flatMap(node => node.data.content).filter(part => part.type === 'text').map(part => part.data.text).join('\n')
        assert.match(text, /请求清晰度:qn=80；实际清晰度:qn=64/u); assert.match(text, /720P/u)
        for (const node of params.messages) for (const part of node.data.content) if (['image', 'video'].includes(part.type)) {
          const response = await fetch(part.data.file); assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual(bytes, part.type === 'video' ? MP4 : PNG); resources.push({ epoch, kind: part.type, bytes: bytes.length })
          if (part.type === 'video') { const thumb = await fetch(part.data.thumb); assert.equal(thumb.status, 200); assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), JPEG); resources.push({ epoch, kind: 'thumbnail', bytes: JPEG.length }) }
        }
        if (mediaUnknown) { peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo })); return }
        data = { message_id: 93000 + actions.length }
      } else assert.fail(`unexpected OneBot action ${action}`)
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
    } catch (error) { errors.push(String(error)); if (echo && peer.readyState === peer.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1400, echo, data: null })) }
  }) })
  t.after(async () => {
    releaseQr?.(); if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions: actions.map(row => row.action), external, forwards: forwards.length, polls, models: modelBodies.length }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exited) await exited
    for (const peer of sockets.clients) peer.terminate(); await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close(); if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM'); await redisExit; await rm(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port
  const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening'); const bridgePort = allocator.address().port; await new Promise(resolve => allocator.close(resolve))
  await waitFor(() => stat(socketPath).then(() => true, () => false), 'Redis readiness'); reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const configFile = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const configText = JSON.stringify({ version: 1, instance, dataDir, model: { baseUrl: `http://127.0.0.1:${port}/model/v1`, name: 'bilibili-quality-fixture', apiKeyEnv: 'BILIBILI_QUALITY_MODEL_KEY' },
    connections: [{ id: 'main', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'BILIBILI_QUALITY_QQ_TOKEN' }], bilibiliQuality: { enabled: true, masters: [{ platform: 'qq', namespace: 'global', id: String(MASTER) }] },
    mediaRelay: { enabled: false, bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: bridgePort }, advertisedOrigin: `http://127.0.0.1:${bridgePort}`, allowedPeers: ['127.0.0.1'] }] },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    ...(privateSource ? { privateChat: { enabled: true } } : {}),
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } })
  const bindingsText = JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: String(BOT) }], bindings: [{ connectionId: 'main', kind: privateSource ? 'private' : 'group', conversationId: String(privateSource ? MASTER : GROUP), agentId: 'daily' }] })
  await writeFile(configFile, configText); await writeFile(bindingsFile, bindingsText)
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, BILIBILI_QUALITY_MODEL_KEY: MODEL_KEY, BILIBILI_QUALITY_QQ_TOKEN: QQ_TOKEN, BILIBILI_QUALITY_AUDIT_URL: `http://127.0.0.1:${port}/bilibili-audit` }
  const launch = check => { child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile, ...(check ? ['--check'] : [])], { cwd: directory, env }); exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes }) }
  const records = async () => Promise.all((await reader.keys(prefix + 'agent:bilibili-quality:v1:command:*')).map(async key => JSON.parse(await reader.get(key))))
  const ingress = (text, sender = MASTER) => { epoch++; const source = { post_type: 'message', message_type: privateSource ? 'private' : 'group', sub_type: privateSource ? 'friend' : 'normal', self_id: BOT,
    ...(privateSource ? { target_id: BOT } : { group_id: GROUP }), user_id: sender, sender: { user_id: sender, nickname: '高清合成验收员' }, message_id: 94000 + epoch, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], raw_message: text }; sources.set(String(source.message_id), source); websocket.send(JSON.stringify(source)); return source }
  return { directory, dataDir, external, actions, forwards, resources, modelBodies, qrImages, records, ingress, get polls() { return polls },
    releaseQr() { assert.equal(typeof releaseQr, 'function'); releaseQr() },
    async start() {
      launch(true); assert.deepEqual(await exited, [0, null], log); assert.equal(JSON.parse(log).mode, 'check'); assert.deepEqual(external, []); assert.deepEqual(modelBodies, []); assert.ok(actions.every(row => row.action === 'get_login_info')); assert.deepEqual(await reader.keys(prefix + '*'), []); await assert.rejects(stat(dataDir), { code: 'ENOENT' }); await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/missing`))
      log = ''; phase = 'run'; launch(false); await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness')
    },
    async settled(count) { await waitFor(async () => { const values = await records(); return values.length === count && values.every(row => row.state !== 'pending') }, 'all quality commands settled'); assert.deepEqual(errors, []) },
    async authorize() { const source = ingress('.B站授权 登录'); await waitFor(() => actions.some(row => row.action === 'send_private_msg' && row.params.message[0].type === 'text'), 'authorization result notice'); await this.settled(1); assert.equal(polls, 2); assert.equal(qrImages.length, 1); assert.deepEqual((await records())[0].effects, { operation: 'sent', qr: 'sent', confirmation: 'sent', result: 'sent' }); return source },
    async replay(source) { websocket.send(JSON.stringify(source)); await delay(1200); assert.deepEqual(errors, []) },
    async credentialFiles() { const authRoot = (await readdir(dataDir)).find(name => name.startsWith('.agent-bilibili-auth-')); return authRoot ? { directory: path.join(dataDir, authRoot), files: await readdir(path.join(dataDir, authRoot)) } : undefined },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log); assert.deepEqual(errors, []) },
    async clean() {
      assert.equal(await readFile(configFile, 'utf8'), configText); assert.equal(await readFile(bindingsFile, 'utf8'), bindingsText)
      const surfaces = [log, await redisText(reader, prefix), JSON.stringify(modelBodies), await diskText(dataDir, true)]
      for (const secret of [MODEL_KEY, QQ_TOKEN, QR_KEY, QR_URL, CALLBACK, COOKIE, SESS, JCT, UID, BUVID, 'BILIBILI_HQ_REFRESH_PRIVATE_123', UPSTREAM, 'BILIBILI_HQ_CDN_PRIVATE_123', MP4.toString('base64'), ...qrImages]) for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) for (const content of surfaces) assert.equal(content.includes(encoded), false, 'logs, Redis, models and ordinary files exclude credentials and QR/native capabilities')
    },
  }
}

test('actual CLI master authorization waits for private QR confirmation, persists privately and delivers requested versus actual HQ artifacts', { timeout: 60000 }, async t => {
  const f = await fixture(t, { holdQr: true }); await f.start(); f.ingress('.B站授权 登录')
  await waitFor(() => f.qrImages.length === 1, 'private QR request'); assert.equal(f.polls, 0); assert.equal(f.actions.filter(row => row.action === 'send_group_msg').length, 0)
  f.releaseQr(); await waitFor(() => f.actions.some(row => row.action === 'send_private_msg' && row.params.message[0].type === 'text'), 'authorized private result'); await f.settled(1); assert.equal(f.polls, 2)
  const vault = await f.credentialFiles(); assert.ok(vault); assert.equal(vault.files.length, 1); assert.equal((await lstat(vault.directory)).mode & 0o7777, 0o700)
  const file = path.join(vault.directory, vault.files[0]), stored = JSON.parse(await readFile(file, 'utf8')); assert.equal((await lstat(file)).mode & 0o7777, 0o600); assert.equal((await lstat(file)).nlink, 1); assert.equal(stored.cookie, COOKIE); assert.equal(stored.owner, JSON.stringify(['qq', 'global', String(BOT), 'daily']))
  f.ingress(`.高清搬运 1080P ${BV}`); await f.settled(2); assert.equal(f.forwards.length, 1)
  assert.deepEqual(f.resources.map(row => [row.kind, row.bytes]), [['image', PNG.length], ['video', MP4.length], ['thumbnail', JPEG.length]])
  assert.deepEqual((await f.records()).find(row => row.effects.media).effects, { media: 'sent' }); assert.equal(f.external.find(row => row.path.endsWith('/playurl')).requestedQuality, '80'); assert.ok(f.external.filter(row => row.path.endsWith('/playurl') || row.host.endsWith('.bilivideo.com')).every(row => row.authorized))
  assert.equal(f.modelBodies.length, 0); await f.stop(); await f.clean()
})

test('actual CLI unconfirmed QR freezes the durable command, never polls or publishes group confirmation and rejects source replay', { timeout: 45000 }, async t => {
  const f = await fixture(t, { qrUnknown: true }); await f.start(); const source = f.ingress('.B站授权 登录'); await f.settled(1)
  const record = (await f.records())[0]; assert.equal(record.state, 'unknown'); assert.deepEqual(record.effects, { operation: 'sent', qr: 'unknown' }); assert.equal(f.qrImages.length, 1); assert.equal(f.polls, 0)
  assert.equal(f.actions.filter(row => row.action === 'send_group_msg').length, 0); await f.replay(source); assert.equal(f.qrImages.length, 1); assert.equal(f.external.length, 1); assert.equal(f.modelBodies.length, 0)
  assert.deepEqual((await f.credentialFiles()).files, []); await f.stop(); await f.clean()
})

test('actual CLI HQ unknown retains one native attempt without replay, anonymous retry or explanatory fallback', { timeout: 60000 }, async t => {
  const f = await fixture(t, { mediaUnknown: true }); await f.start(); await f.authorize(); const source = f.ingress(`.高清搬运 1080P ${BV}`); await f.settled(2)
  const media = (await f.records()).find(row => row.effects.media); assert.equal(media.state, 'unknown'); assert.deepEqual(media.effects, { media: 'unknown' })
  const before = { external: f.external.length }; await f.replay(source)
  assert.equal(f.forwards.length, 1); assert.equal(f.actions.filter(row => row.action.startsWith('send_') && row.epoch === 2).length, 1); assert.equal(f.external.length, before.external); assert.equal(f.modelBodies.length, 0)
  assert.equal(f.external.filter(row => row.path.endsWith('/playurl')).length, 1); await f.stop(); await f.clean()
})

test('actual CLI private friend master status and login retain verified private source and fixed recipient without TEMP fields', { timeout: 60000 }, async t => {
  const f = await fixture(t, { privateSource: true }); await f.start(); const status = f.ingress('.B站授权 状态'); await f.settled(1)
  assert.equal(status.sub_type, 'friend'); assert.equal(Object.hasOwn(status, 'group_id'), false); assert.equal(Object.hasOwn(status, 'temp_source'), false)
  assert.equal(f.external.length, 0); assert.equal(textOf(f.actions.find(row => row.action === 'send_private_msg').params.message), '当前绑定尚无B站授权。')
  const login = f.ingress('.B站授权 登录'); await f.settled(2); assert.equal(f.polls, 2); assert.equal(f.qrImages.length, 1)
  assert.ok(f.actions.filter(row => row.action === 'get_msg').some(row => String(row.params.message_id) === String(status.message_id)))
  assert.ok(f.actions.filter(row => row.action === 'get_msg').some(row => String(row.params.message_id) === String(login.message_id)))
  for (const row of f.actions.filter(row => row.action === 'send_private_msg')) { assert.equal(String(row.params.user_id), String(MASTER)); assert.equal(Object.hasOwn(row.params, 'group_id'), false); assert.equal(Object.hasOwn(row.params, 'temp_source'), false) }
  assert.equal(f.actions.some(row => row.action.startsWith('send_group')), false)
  assert.deepEqual((await f.records()).find(row => row.effects.qr).effects, { operation: 'sent', qr: 'sent', result: 'sent' })
  f.ingress('.B站授权 状态'); await f.settled(3)
  assert.equal(textOf(f.actions.findLast(row => row.action === 'send_private_msg').params.message), '当前绑定已保存B站授权。')
  assert.equal(f.modelBodies.length, 0); await f.stop(); await f.clean()
})
