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
const { simulationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simulationAddress.js')).href)
const { simulationBusyKey, simulationSessionKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/simulation/infrastructure/simSessionStore.js')).href)
const botId = 19000181, userId = 330181, groupId = 311801
const mainKey = 'filetext-fixture-model-key', oneBotToken = 'filetext-fixture-onebot-key'
const fileId = 'FILETEXT-PLATFORM-REFERENCE-MUST-STAY-PRIVATE'
const marker = '仅存在于TXT源字节的专用标记紫竹'
const extracted = `${marker}\n测试资料说明：本次活动安排在周六上午十点。\n`
const derived = '根据刚才文件得出的专用回答银杏：活动安排在周六上午十点。'
const ordinary = '本轮未开放文件读取，请提供需要讨论的文字。'
const bytes = Buffer.from(extracted)
const unverifiedUrl = 'https://unverified.example/file-segment-url-must-not-be-used'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const scope = simulationAddressKey(target)
const completion = (name, input, id = name) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })

async function waitFor(probe, description, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(25) }
  assert.fail(`timed out: ${description}`)
}

async function storedRedisText(reader, prefix) {
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

async function storedFilesText(directory) {
  const values = []
  for (const item of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
    const filename = path.join(directory, item.name)
    if (item.isDirectory()) values.push(await storedFilesText(filename))
    else if (item.isFile()) values.push(await readFile(filename, 'utf8'))
  }
  return values.join('\n')
}

async function fixture(t, mode) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'this CLI acceptance needs real Redis')
  const directory = await mkdtemp(path.join(tmpdir(), `agent-filetext-${mode}-`))
  const socketPath = path.join(directory, 'redis.sock')
  const instance = `filetext-${mode}`, prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const requests = [], actions = [], deliveries = [], errors = [], downloaded = []
  const now = Math.floor(Date.now() / 1000)
  const original = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '文本文件验收员' }, message_id: 98101, time: now,
    message: [{ type: 'file', data: { name: '验收.txt', file_id: fileId, file: 'display-name-must-not-shadow-file-id', busid: 102, url: unverifiedUrl } }], raw_message: '' }
  const requestText = '请阅读我刚上传的验收.txt，告诉我活动时间。'
  const current = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '文本文件验收员' }, message_id: 98102, time: now + 1,
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: requestText } }], raw_message: requestText }
  let reader, child, exited, websocket, log = '', finished = false, readReached = false, fileUrl, releaseModel
  const heldModel = new Promise(resolve => { releaseModel = resolve })
  const enabled = !['omitted', 'disabled'].includes(mode)
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/attachment.txt') {
        downloaded.push(req.url)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(bytes); return
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      assert.equal(req.url, '/main/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${mainKey}`)
      assert.equal(body.model, 'filetext-fixture-model')
      requests.push(body)
      res.setHeader('Content-Type', 'application/json')
      const sent = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'send')
      const read = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'read')
      if (sent) {
        finished = true
        res.end(completion('simFinishTurn', { choice: 'silent', reason: '本轮查询已处理，不保存资料' }, 'finish')); return
      }
      if (mode === 'secret-output') {
        res.end(completion('simSendMessage', { continuation: 'chat', messages: [`服务返回的正文：${mainKey}，${oneBotToken}`] }, 'send')); return
      }
      if (read) {
        assert.ok(enabled, 'disabled tools never produce a file read result')
        assert.ok(String(read.content).includes(marker), 'real parser output reached the model')
        assert.ok(String(read.content).includes('周六上午十点'), 'the extracted answer comes from TXT bytes')
        assert.ok(String(read.content).length <= 12_000, 'file projection is bounded')
        readReached = true
        if (mode === 'recalled') await heldModel
        res.end(completion('simSendMessage', { continuation: 'chat', messages: [derived] }, 'send')); return
      }
      assert.equal(body.tools.some(row => row.function.name === 'fileTextTool'), enabled)
      res.end(enabled ? completion('fileTextTool', { fileName: '验收.txt', offset: 0, limit: 2048 }, 'read') :
        completion('simSendMessage', { continuation: 'chat', messages: [ordinary] }, 'send'))
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
        if (action === 'get_login_info') data = { user_id: botId, nickname: '文件文字验收机器人' }
        else if (action === 'get_msg') {
          assert.ok([original.message_id, current.message_id].includes(Number(params.message_id)), 'only this conversation source is reloaded')
          data = Number(params.message_id) === original.message_id ? original : current
        } else if (action === 'get_group_root_files') data = { files: [], folders: [] }
        else if (action === 'get_group_file_url') {
          assert.equal(params.file_id, fileId); assert.equal(String(params.group_id), String(groupId)); assert.equal(Number(params.busid), 102)
          data = { url: fileUrl }
        } else if (action === 'send_group_msg') {
          assert.equal(Number(params.group_id), groupId)
          deliveries.push(params); data = { message_id: 98200 + deliveries.length }
        } else assert.fail(`unexpected OneBot action ${action}`)
        peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    releaseModel()
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, requests: requests.map(row => row.messages.filter(item => item.role === 'tool')) }))
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
  await waitFor(() => stat(socketPath).catch(() => false), 'Redis readiness')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect()
  const port = server.address().port
  fileUrl = `http://files.example:${port}/attachment.txt`
  // Route only this synthetic public host locally; keep the real downloader's DNS/pinning checks active.
  const preload = path.join(directory, 'file-network-fixture.mjs')
  await writeFile(preload, `import dns from 'node:dns/promises'; import http from 'node:http'; import {syncBuiltinESMExports} from 'node:module';\nconst lookup=dns.lookup; dns.lookup=async(host,...args)=>host==='files.example'?[{address:'8.8.8.8',family:4}]:lookup(host,...args);\nconst request=http.request; http.request=function(url,opts,...args){if(url instanceof URL&&url.hostname==='files.example'){const local=new URL(url);local.hostname='127.0.0.1';return request.call(this,local,{...opts,family:4,lookup:(_h,_o,cb)=>cb(null,'127.0.0.1',4)},...args)}return request.call(this,url,opts,...args)};syncBuiltinESMExports();\n`)
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-files', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-files', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance, model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'filetext-fixture-model', apiKeyEnv: 'FILETEXT_MODEL_KEY' },
    ...(mode === 'omitted' ? {} : { tools: { files: { enabled } } }),
    ...(mode === 'secret-output' ? { forbiddenWords: { blockOutput: false } } : {}),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-files', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'FILETEXT_ONEBOT_KEY' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } }))
  const session = async () => JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(scope))
  return {
    requests, actions, deliveries, downloaded, errors, session, settled, releaseModel,
    get finished() { return finished }, get readReached() { return readReached },
    async start() {
      child = spawn(process.execPath, ['--import', preload, entry, '--config', configFile], { cwd: directory,
        env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, FILETEXT_MODEL_KEY: mainKey, FILETEXT_ONEBOT_KEY: oneBotToken } })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
      await waitFor(() => log.includes('已启动'), 'CLI readiness')
      websocket.send(JSON.stringify(original))
      await waitFor(async () => (await session())?.recent?.some(row => row.messageId === String(original.message_id)), 'pure TXT attachment retained as filename metadata')
      assert.equal(requests.length, 0, 'file arrival alone does not invoke the parser or model')
      assert.equal(downloaded.length, 0)
    },
    trigger() { websocket.send(JSON.stringify(current)) },
    recallSource() { websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: botId, group_id: groupId,
      user_id: userId, operator_id: userId, message_id: original.message_id, time: now + 2 })) },
    async sourceRemoved() { return !(await session())?.recent?.some(row => row.messageId === String(original.message_id)) },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]) },
    async assertClean() {
      assert.deepEqual(errors, [])
      const persisted = await storedRedisText(reader, prefix)
      const files = await storedFilesText(path.join(directory, 'data'))
      for (const value of [marker, extracted, derived, bytes.toString('base64'), fileUrl, fileId, unverifiedUrl]) {
        assert.ok(!persisted.includes(value), 'source content, derived answer and platform references never enter Redis')
        assert.ok(!files.includes(value), 'temporary file data never enters local ledgers or histories')
        assert.ok(!log.includes(value), 'temporary file data never enters CLI logs')
      }
      const model = JSON.stringify(requests)
      for (const value of [bytes.toString('base64'), fileUrl, fileId, unverifiedUrl, oneBotToken, mainKey]) assert.ok(!model.includes(value), 'model receives text without source bytes or credentials')
    },
  }
}

test('actual CLI fileTextTool reads a recent TXT using the real parser and keeps source and derived reply temporary', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'enabled')
  await run.start(); run.trigger()
  await waitFor(() => run.finished, 'TXT read and derived send')
  await waitFor(async () => (await run.session())?.lastWakeAt && !(await run.session())?.queuedIngressWake && await run.settled(), 'file turn drains')
  await run.stop()
  assert.equal(run.readReached, true)
  assert.equal(run.deliveries.length, 1)
  assert.ok(run.deliveries[0].message.some(part => part.type === 'text' && part.data.text === derived))
  assert.equal(run.downloaded.length, 1, 'source reauthorization does not download a second copy')
  assert.ok(run.actions.some(row => row.action === 'get_msg' && Number(row.params.message_id) === 98101))
  assert.ok(run.actions.some(row => row.action === 'get_group_file_url'))
  await run.assertClean()
})

for (const mode of ['omitted', 'disabled']) test(`actual CLI fileTextTool is absent when files are ${mode}`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode)
  await run.start(); run.trigger()
  await waitFor(() => run.finished, 'ordinary reply with file tool disabled')
  await waitFor(async () => (await run.session())?.lastWakeAt && !(await run.session())?.queuedIngressWake && await run.settled(), 'ordinary turn drains')
  await run.stop()
  assert.equal(run.readReached, false)
  assert.equal(run.downloaded.length, 0)
  assert.equal(run.actions.some(row => row.action === 'get_group_file_url'), false)
  assert.ok(run.requests.every(row => !row.tools.some(tool => tool.function.name === 'fileTextTool')))
  assert.equal(run.deliveries.length, 1)
  assert.ok(run.deliveries[0].message.some(part => part.type === 'text' && part.data.text === ordinary))
  await run.assertClean()
})

test('actual CLI discards a pending file-derived reply when the recent TXT source is recalled', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'recalled')
  await run.start(); run.trigger()
  await waitFor(() => run.readReached, 'real TXT extraction reaches a pending model continuation')
  assert.equal(run.deliveries.length, 0)
  run.recallSource()
  await waitFor(run.sourceRemoved, 'recalled file metadata removed')
  run.releaseModel()
  await waitFor(run.settled, 'recalled file turn releases its execution lock')
  await delay(100)
  await run.stop()
  assert.equal(run.downloaded.length, 1)
  assert.equal(run.deliveries.length, 0, 'recalled file cannot produce a late derived answer')
  assert.equal(run.finished, false)
  assert.equal(run.requests.length, 2, 'cancelled source cannot enter a later provider request')
  await run.assertClean()
})

test('actual CLI rejects model-generated text containing its configured model and OneBot credentials even with word blocking disabled', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'secret-output')
  await run.start(); run.trigger()
  await waitFor(() => run.finished, 'unsafe model reply is rejected and closes safely')
  await waitFor(async () => (await run.session())?.lastWakeAt && !(await run.session())?.queuedIngressWake && await run.settled(), 'unsafe output turn drains')
  await run.stop()
  assert.deepEqual(run.errors, [])
  assert.equal(run.deliveries.length, 0, 'literal host credentials never reach QQ transport')
  assert.equal(run.actions.some(row => row.action === 'send_group_msg'), false)
  assert.equal(run.actions.some(row => row.action === 'get_group_file_url'), false)
  assert.equal(run.downloaded.length, 0)
  assert.match(String(run.requests[1].messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'send')?.content), /^error: 工具参数包含宿主禁止外发的内容，未执行$/u)
})
