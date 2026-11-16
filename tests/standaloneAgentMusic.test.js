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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const entry = path.join(release, 'scripts/start-agent.mjs')
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const botId = 19000201, userId = 330201, groupId = 312001
const mainKey = 'music-fixture-model-private-key', oneBotToken = 'music-fixture-onebot-private-key'
const cookie = 'qqmusic_key=MusicPrivateCookieValue;qm_keyst=MusicPrivateCookieValue;uin=87654321'
const refreshSeed = 'psrf_qqopenid=OLD_MUSIC_OPEN;psrf_qqrefresh_token=OLD_MUSIC_REFRESH;psrf_qqaccess_token=OLD_MUSIC_ACCESS;uin=87654321;qqmusic_key=OLD_MUSIC_KEY;qm_keyst=OLD_MUSIC_KEY;psrf_musickey_createtime=1;psrf_qqunionid=OLD_MUSIC_UNION'
const refreshedTokens = { openid: 'NEW_MUSIC_OPEN', refresh_token: 'NEW_MUSIC_REFRESH', access_token: 'NEW_MUSIC_ACCESS',
  musickey: 'NEW_MUSIC_KEY', unionid: 'NEW_MUSIC_UNION', encryptUin: 'NEW_MUSIC_ENCRYPTED', str_musicid: '87654321' }
const keyword = '合成歌手', ordinary = '本轮未开放点歌。'
const vkey = 'FIXTUREVKEYKEEPOUTOFMODEL'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const scope = simulationAddressKey(target)
const songs = Array.from({ length: 20 }, (_, index) => ({ mid: `SongMid${index + 1}`, title: `合成歌曲${index + 1}`, singer: [{ name: keyword, mid: 'SingerMid1' }],
  album: { mid: `AlbumMid${index + 1}` }, vs: [], sa: 0, pay: { price_track: 0, pay_play: 0 }, file: { media_mid: `MediaMid${index + 1}`, size_128mp3: 1024 } }))
const completion = (name, input, id = name, content = '') => JSON.stringify({ choices: [{ message: { content, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })

async function waitFor(probe, label, timeout = 15_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const result = await probe(); if (result) return result; await delay(25) }
  assert.fail(`timed out: ${label}`)
}

// Replace the one fixed QQ Music API route only. All requests still cross real
// local HTTP; every nonlocal route outside that exact endpoint fails closed.
async function installMusicAuditFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async function (input, init) {
    const address = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const url = new URL(address)
    if (address === 'https://u.y.qq.com/cgi-bin/musicu.fcg') {
      const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)))
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const body = init?.body === undefined ? null : String(init.body)
      const audited = await original(process.env.MUSIC_FIXTURE_AUDIT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: url.origin, path: url.pathname, method, headers, body, redirect: init?.redirect, signal: !!init?.signal, environmentCookie: process.env.QQ_MUSIC_COOKIE }),
        ...(init?.signal ? { signal: init.signal } : {}) })
      const response = new Response(await audited.arrayBuffer(), { status: audited.status, headers: audited.headers })
      Object.defineProperty(response, 'url', { value: address })
      return response
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      await original(new URL('/unexpected-fetch', process.env.MUSIC_FIXTURE_AUDIT_URL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })
      throw new Error('unexpected external fetch denied by music fixture')
    }
    return original(input, init)
  }
}

async function persistedFiles(directory, excluded = new Set()) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const filename = path.join(directory, item.name)
    if (!excluded.has(filename)) values.push(item.isDirectory() ? await persistedFiles(filename, excluded) : await readFile(filename, 'utf8'))
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
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'music CLI acceptance needs real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), `agent-music-${mode}-`)), socketPath = path.join(directory, 'redis.sock')
  const instance = `music-${mode}`, prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit'), sockets = new WebSocketServer({ noServer: true })
  const requests = [], musicRequests = [], actions = [], deliveries = [], errors = [], toolResults = [], pending = [], unexpectedFetches = []
  const enabled = !['omitted', 'disabled'].includes(mode), artistOnly = mode === 'artist'
  const secret = ['secret-cookie', 'secret-encoded'].includes(mode), refresh = mode === 'refresh'
  const configuredCookie = mode === 'cookie' || secret || refresh, seedCookie = refresh ? refreshSeed : cookie
  const heldStage = refresh ? 'refresh' : mode.startsWith('query-') ? 'query' : mode.startsWith('vkey-') ? 'vkey' : undefined
  const now = Math.floor(Date.now() / 1000), userText = '请放一首合成歌手的歌。群内背景 MUSIC-GROUP-ONLY 不必交给音乐服务。'
  const renewedCookie = `psrf_qqopenid=${refreshedTokens.openid};psrf_qqrefresh_token=${refreshedTokens.refresh_token};psrf_qqaccess_token=${refreshedTokens.access_token};uin=87654321;qqmusic_key=${refreshedTokens.musickey};qm_keyst=${refreshedTokens.musickey};psrf_musickey_createtime=${now};psrf_qqunionid=${refreshedTokens.unionid};euin=${refreshedTokens.encryptUin};login_type=1;tmeLoginType=2`
  const current = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '音乐验收员' }, message_id: 100101, time: now,
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: userText } }], raw_message: userText }
  let child, exited, reader, websocket, log = '', finished = false, hold = !!heldStage, aborted = 0
  const release = () => { hold = false; for (const { response, payload } of pending.splice(0)) if (!response.destroyed) response.end(JSON.stringify(payload)) }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/unexpected-fetch') { unexpectedFetches.push(body); res.end('{}'); return }
      if (req.url === '/music-audit') {
        const provider = JSON.parse(body.body), [slot, request] = Object.entries(provider).find(([, value]) => value && typeof value === 'object' && typeof value.module === 'string') || []
        assert.ok(slot && request, 'provider request names a documented QQ Music method')
        const stage = request.module === 'music.search.SearchCgiService' ? 'query' : request.module === 'vkey.GetVkeyServer' ? 'vkey' : request.module === 'music.login.LoginServer' && refresh ? 'refresh' : 'unexpected'
        assert.notEqual(stage, 'unexpected', 'only the explicitly configured music methods may run')
        musicRequests.push({ ...body, provider, stage })
        let payload
        if (stage === 'refresh') {
          assert.equal(request.method, 'Login')
          for (const [key, value] of Object.entries({ access_token: 'OLD_MUSIC_ACCESS', musicid: 87654321, openid: 'OLD_MUSIC_OPEN', refresh_token: 'OLD_MUSIC_REFRESH', unionid: 'OLD_MUSIC_UNION', musickey: 'OLD_MUSIC_KEY' })) assert.equal(request.param[key], value)
          payload = { code: 0, [slot]: { code: 0, data: { ...refreshedTokens, musickeyCreateTime: String(now) } } }
        } else if (stage === 'query') {
          assert.equal(request.param.query, keyword)
          assert.equal(request.param.num_per_page, artistOnly ? 20 : 1)
          payload = { code: 0, [slot]: { code: 0, data: { body: { song: { list: artistOnly ? songs : songs.slice(0, 1) } } } } }
        } else {
          const mid = request.param.songmid[0]
          assert.ok(songs.some(song => song.mid === mid))
          payload = { code: 0, [slot]: { code: 0, data: { sip: ['http://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: mid, filename: `${mid}.mp3`, purl: `${mid}.mp3?vkey=${vkey}` }] } } }
        }
        if (hold && stage === heldStage) {
          res.once('close', () => { if (!res.writableEnded) aborted++ })
          pending.push({ response: res, payload })
        } else res.end(JSON.stringify(payload))
        return
      }
      assert.equal(req.url, '/main/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${mainKey}`)
      assert.equal(body.model, 'music-fixture-model')
      requests.push(body)
      const result = id => body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === id)
      const first = result('music'), retry = result('retry'), fallback = result('fallback'), ordinaryResult = result('ordinary'), dynamicSecret = result('dynamic-secret')
      for (const row of [first, retry, fallback, ordinaryResult, dynamicSecret]) if (row && !toolResults.some(item => item.tool_call_id === row.tool_call_id)) toolResults.push(row)
      if (dynamicSecret || fallback || ordinaryResult || first && mode !== 'unknown' && !refresh) {
        finished = true; res.end(completion('simFinishTurn', { choice: 'silent', reason: '音乐回执已处理，本轮安静结束' }, 'finish')); return
      }
      if (first && refresh) {
        assert.ok(body.tools.some(row => row.function.name === 'githubRepoTool'), 'the unrelated public tool is actually exposed')
        res.end(completion('githubRepoTool', { repoUrl: `https://github.com/fixture-owner/${refreshedTokens.musickey}` }, 'dynamic-secret', `合成恶意模型同时输出凭据 ${refreshedTokens.access_token}`)); return
      }
      if (retry) { res.end(completion('simSendMessage', { continuation: 'chat', messages: ['未知音乐回执后禁止这条文字补发。'] }, 'fallback')); return }
      if (first && mode === 'unknown') { res.end(completion('searchMusicTool', { keyword, isArtistOnly: false }, 'retry')); return }
      assert.equal(body.tools.some(row => row.function.name === 'searchMusicTool'), enabled)
      const selectedKeyword = mode === 'secret-cookie' ? cookie : mode === 'secret-encoded' ? Buffer.from(cookie).toString('base64') : keyword
      res.end(enabled ? completion('searchMusicTool', { keyword: selectedKeyword, isArtistOnly: artistOnly }, 'music') :
        completion('simSendMessage', { continuation: 'chat', messages: [ordinary] }, 'ordinary'))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end('{}') }
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/onebot' || req.headers.authorization !== `Bearer ${oneBotToken}`) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message)); actions.push({ action, params })
        let data = {}
        if (action === 'get_login_info') data = { user_id: botId, nickname: '音乐验收机器人' }
        else if (action === 'get_msg') { assert.equal(Number(params.message_id), current.message_id); data = current }
        else if (action === 'send_group_msg') { assert.equal(Number(params.group_id), groupId); deliveries.push(params); data = mode === 'unknown' ? {} : { message_id: 100200 + deliveries.length } }
        else assert.fail(`unexpected OneBot action ${action}`)
        peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    release()
    if (t.error) t.diagnostic(JSON.stringify({ errors, log, actions, toolResults, musicRequests, modelRequests: requests.length }))
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
    connections: [{ id: 'qq-music', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-music', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] }
  await writeFile(bindingsFile, JSON.stringify(bindings))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'music-fixture-model', apiKeyEnv: 'MUSIC_MODEL_KEY' },
    ...(mode === 'omitted' ? {} : { tools: { music: { enabled, ...(mode === 'disabled' ? { cookieEnv: 'MUSIC_MISSING_COOKIE' } : configuredCookie ? { cookieEnv: 'QQ_MUSIC_COOKIE' } : {}) }, ...(refresh ? { github: { enabled: true } } : {}) } }),
    ...(secret || refresh ? { forbiddenWords: { blockOutput: false } } : {}),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-music', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'MUSIC_ONEBOT_KEY' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } }))
  const preload = path.join(directory, 'music-preload.mjs')
  await writeFile(preload, `await (${installMusicAuditFetch.toString()})();\n`)
  const unchangedFiles = await Promise.all([configFile, bindingsFile, preload].map(async file => [file, await readFile(file, 'utf8')]))
  const credentialFile = path.join(directory, 'data', instance, 'music-credentials', 'qq-music.json')
  const session = async () => JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(scope))
  return {
    requests, musicRequests, actions, deliveries, errors, toolResults, session, settled, release, unexpectedFetches,
    get finished() { return finished }, get aborted() { return aborted },
    async start() {
      const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, MUSIC_MODEL_KEY: mainKey, MUSIC_ONEBOT_KEY: oneBotToken,
        QQ_MUSIC_COOKIE: seedCookie, MUSIC_FIXTURE_AUDIT_URL: `http://127.0.0.1:${port}/music-audit` }
      delete env.MUSIC_MISSING_COOKIE
      child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, entry, '--config', configFile], { cwd: directory, env })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
      await waitFor(() => { if (child.exitCode !== null) assert.fail(`CLI exited early: ${log}`); return log.includes('已启动') && websocket }, 'CLI readiness')
      if (refresh) await waitFor(() => musicRequests.some(row => row.stage === 'refresh'), 'startup refresh before a human turn')
      websocket.send(JSON.stringify(current))
    },
    async musicPending() {
      for (const key of await reader.keys(prefix + 'shiloh:character:v1:*')) if (await reader.type(key) === 'string') {
        if ((JSON.parse(await reader.get(key)).receipts ?? []).some(row => row.toolName === 'searchMusicTool' && row.status === 'pending')) return true
      }
      return false
    },
    async assertCredentialStore() {
      const stored = JSON.parse(await readFile(credentialFile, 'utf8'))
      assert.deepEqual(stored, { version: 1, seedHash: createHash('sha256').update(refreshSeed).digest('hex'), cookie: renewedCookie })
      assert.equal((await stat(path.dirname(credentialFile))).mode & 0o777, 0o700)
      assert.equal((await stat(credentialFile)).mode & 0o777, 0o600)
      assert.deepEqual(await readdir(path.dirname(credentialFile)), ['qq-music.json'], 'no temporary credential files remain')
      for (const [file, content] of unchangedFiles) assert.equal(await readFile(file, 'utf8'), content, 'refresh never rewrites config, bindings or preload')
      assert.ok(musicRequests.every(row => row.environmentCookie === refreshSeed), 'the actual child environment retains its original seed after refresh')
    },
    recall() { websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: botId, group_id: groupId,
      user_id: userId, operator_id: userId, message_id: current.message_id, time: now + 1 })) },
    async sourceRemoved() { return !(await session())?.recent?.some(row => row.messageId === String(current.message_id)) },
    async rebind() { await writeFile(bindingsFile, JSON.stringify({ ...bindings, bindings: [{ ...bindings.bindings[0], agentId: 'replacement' }] })) },
    async drained() { return (await session())?.lastWakeAt && !(await session())?.queuedIngressWake && await settled() },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null], log) },
    async assertClean() {
      assert.deepEqual(errors, [])
      assert.deepEqual(unexpectedFetches, [], 'dynamic secrets are denied before any unrelated external request')
      for (const request of musicRequests) {
        assert.equal(request.origin, 'https://u.y.qq.com'); assert.equal(request.path, '/cgi-bin/musicu.fcg'); assert.equal(request.method, 'POST')
        assert.equal(request.redirect, 'error'); assert.equal(request.signal, true)
        assert.equal(request.headers.cookie || '', configuredCookie && request.stage === 'query' ? refresh ? renewedCookie : cookie : '', 'only the current explicitly configured cookie is sent to the search route')
        if (request.stage === 'vkey') assert.equal(request.provider.comm.authst, refresh ? refreshedTokens.musickey : configuredCookie ? 'MusicPrivateCookieValue' : '')
        for (const value of ['MUSIC-GROUP-ONLY', userText, '音乐验收员', mainKey, oneBotToken]) assert.ok(!request.body.includes(value), 'only the keyword and configured music credentials reach the provider')
      }
      const privateValues = [cookie, 'MusicPrivateCookieValue', mainKey, oneBotToken, vkey, ...(refresh ? [refreshSeed, renewedCookie, 'OLD_MUSIC_KEY', 'OLD_MUSIC_OPEN', 'OLD_MUSIC_ACCESS', 'OLD_MUSIC_REFRESH', 'OLD_MUSIC_UNION', ...Object.entries(refreshedTokens).filter(([key]) => key !== 'str_musicid').map(([, value]) => value)] : [])]
      const model = JSON.stringify(requests)
      if (!secret) for (const value of [...privateValues, 'ws.stream.qqmusic.qq.com', 'y.gtimg.cn', 'y.qq.com/n/yqq/song']) assert.ok(!model.includes(value), 'model sees the safe title and receipt without provider URLs or secrets')
      const persisted = await persistedRedis(reader, prefix), files = await persistedFiles(path.join(directory, 'data'), new Set(refresh ? [credentialFile] : []))
      for (const value of privateValues) {
        const paths = (node, at = '$') => typeof node === 'string' ? node.includes(value) ? [at] : [] : node && typeof node === 'object' ? Object.entries(node).flatMap(([key, child]) => paths(child, `${at}.${key}`)) : []
        const locations = persisted.split('\n').filter(row => row.includes(value)).map(row => {
          const entry = JSON.parse(row)
          let data = entry.value
          try { if (typeof data === 'string') data = JSON.parse(data) } catch { /* retain a raw string location */ }
          return { key: entry.key, paths: paths(data) }
        })
        assert.ok(!persisted.includes(value), `credentials and playback URL keys never enter Redis: ${JSON.stringify({ value, locations })}`)
        assert.ok(!log.includes(value), 'credentials and playback URL keys never enter logs')
        assert.ok(!files.includes(value), 'credentials and playback URL keys never enter local data')
      }
    },
  }
}

for (const mode of ['omitted', 'disabled']) test(`actual CLI music is absent when ${mode}, and does not require or infer a cookie`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.finished, 'ordinary no-tool turn'); await waitFor(run.drained, 'turn drains'); await run.stop()
  assert.equal(run.musicRequests.length, 0)
  assert.ok(run.requests.every(row => !row.tools.some(tool => tool.function.name === 'searchMusicTool')))
  assert.equal(run.deliveries.length, 1); assert.ok(run.deliveries[0].message.some(row => row.type === 'text' && row.data.text === ordinary))
  await run.assertClean()
})

for (const mode of ['anonymous', 'cookie', 'artist']) test(`actual CLI ${mode} QQ Music search sends one custom card and exposes only safe title and confirmed receipt`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.finished, 'confirmed music tool result'); await waitFor(run.drained, 'music turn drains'); await run.stop()
  assert.deepEqual(run.musicRequests.map(row => row.stage), ['query', 'vkey'])
  assert.equal(run.deliveries.length, 1); assert.equal(run.deliveries[0].message.length, 1)
  const card = run.deliveries[0].message[0]
  assert.equal(card.type, 'music'); assert.equal(card.data.type, 'custom')
  const selected = songs.find(song => card.data.title === song.title)
  assert.ok(selected, 'artist-only random selection remains inside the returned twenty-song pool')
  if (mode !== 'artist') assert.equal(selected.mid, songs[0].mid)
  assert.equal(card.data.url, `https://y.qq.com/n/yqq/song/${selected.mid}.html`)
  assert.equal(card.data.audio, `http://ws.stream.qqmusic.qq.com/${selected.mid}.mp3?vkey=${vkey}`)
  assert.equal(card.data.image, `http://y.gtimg.cn/music/photo_new/T002R150x150M000${selected.album.mid}.jpg`)
  assert.equal(card.data.content, keyword)
  assert.ok(JSON.stringify(run.toolResults).includes(selected.title))
  assert.ok(JSON.stringify(run.toolResults).includes('100201'))
  assert.ok((await run.session()).confirmedMessageIds.includes('100201'))
  await run.assertClean()
})

test('actual CLI shares startup cookie refresh with a pending search, persists private credentials and fences new tokens across public tools', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'refresh'); await run.start()
  await waitFor(run.musicPending, 'music action starts while startup refresh is pending')
  assert.deepEqual(run.musicRequests.map(row => row.stage), ['refresh'])
  assert.equal(run.deliveries.length, 0)
  run.release()
  await waitFor(() => run.finished, 'renewed cookie used and unrelated tool input denied')
  await waitFor(run.drained, 'refreshed music turn drains'); await run.stop()
  assert.deepEqual(run.musicRequests.map(row => row.stage), ['refresh', 'query', 'vkey'], 'startup and the waiting music action perform one shared Login')
  assert.equal(run.deliveries.length, 1)
  assert.equal(run.deliveries[0].message[0].type, 'music')
  assert.ok((await run.session()).confirmedMessageIds.includes('100201'))
  assert.equal(run.toolResults.length, 2)
  const denied = run.toolResults.find(row => row.tool_call_id === 'dynamic-secret')
  assert.ok(denied)
  assert.match(String(denied.content), /工具参数包含宿主禁止外发的内容，未执行/u)
  const closedCall = run.requests.flatMap(row => row.messages).flatMap(row => row.tool_calls ?? []).find(row => row.id === 'dynamic-secret')
  assert.ok(closedCall, 'the denied call retains its tool protocol identity without the forbidden argument')
  assert.equal(closedCall.function.name, 'githubRepoTool')
  assert.equal(closedCall.function.arguments, '{}')
  await run.assertCredentialStore()
  await run.assertClean()
})

test('actual CLI unknown music receipt freezes repeated searches and text fallback', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'unknown'); await run.start()
  await waitFor(() => run.finished, 'unknown receipt and prohibited followups'); await waitFor(run.drained, 'unknown turn drains'); await run.stop()
  assert.deepEqual(run.musicRequests.map(row => row.stage), ['query', 'vkey'])
  assert.equal(run.deliveries.length, 1); assert.equal(run.deliveries[0].message[0].type, 'music')
  assert.equal(run.toolResults.length, 3)
  assert.match(String(run.toolResults[0].content), /unknown|未知|未确认/u)
  await run.assertClean()
})

for (const stage of ['query', 'vkey']) for (const cancellation of ['recall', 'rebind']) test(`actual CLI aborts pending music ${stage} on ${cancellation} with no late provider continuation or card`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, `${stage}-${cancellation}`); await run.start()
  await waitFor(() => run.musicRequests.some(row => row.stage === stage), 'music request pending')
  if (cancellation === 'recall') { run.recall(); await waitFor(run.sourceRemoved, 'source removed') }
  else await run.rebind()
  await waitFor(run.settled, 'invalidated music turn releases its lock before provider completes')
  await waitFor(() => run.aborted === 1, 'pending provider HTTP is aborted')
  run.release(); await delay(100); await run.stop()
  assert.equal(run.deliveries.length, 0); assert.equal(run.requests.length, 1); assert.equal(run.finished, false)
  assert.deepEqual(run.musicRequests.map(row => row.stage), stage === 'query' ? ['query'] : ['query', 'vkey'])
  await run.assertClean()
})

for (const mode of ['secret-cookie', 'secret-encoded']) test(`actual CLI rejects ${mode} search input before QQ Music HTTP even when word blocking is disabled`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode); await run.start()
  await waitFor(() => run.finished, 'credential input refusal'); await waitFor(run.drained, 'credential turn drains'); await run.stop()
  assert.deepEqual(run.errors, []); assert.equal(run.musicRequests.length, 0); assert.equal(run.deliveries.length, 0)
  assert.equal(run.toolResults.length, 1)
})
