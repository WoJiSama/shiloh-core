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
const botId = 19000191, userId = 330191, groupId = 311901
const mainKey = 'voice-fixture-model-private-key', oneBotToken = 'voice-fixture-onebot-private-key'
const voiceKey = 'voice-fixture-provider-private-key', authorization = 'voice-fixture-authorization-private-key'
const personaName = '晚禾'
const rawVoiceText = '欸，别突然这么叫呀，我有点不好意思。'
const spokenText = `叫我${personaName}就好。`
const ordinary = '本轮语音未开放。'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const scope = simulationAddressKey(target)
const completion = (name, input, id = name) => JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })

// A real, small PCM WAV exercises audio validation and OneBot's inline record transport.
function makeWav() {
  const samples = 160, sampleRate = 8000, result = Buffer.alloc(44 + samples * 2)
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8)
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20)
  result.writeUInt16LE(1, 22); result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28)
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36)
  result.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) result.writeInt16LE(Math.round(Math.sin(index * Math.PI / 8) * 1000), 44 + index * 2)
  return result
}
const wav = makeWav()

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
  const directory = await mkdtemp(path.join(tmpdir(), `agent-voice-${mode}-`))
  const socketPath = path.join(directory, 'redis.sock')
  const instance = `voice-${mode}`, prefix = `bl-agent:${instance}:`
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const requests = [], ttsRequests = [], actions = [], deliveries = [], errors = [], toolResults = []
  const enabled = !['omitted', 'disabled'].includes(mode), pending = ['recalled', 'rebound'].includes(mode)
  const now = Math.floor(Date.now() / 1000)
  const requestText = '请用语音说一句话。当前会话线索 VOICE-GROUP-ONLY 不必交给合成服务。'
  const current = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    sender: { user_id: userId, nickname: '语音验收员' }, message_id: 99101, time: now,
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: requestText } }], raw_message: requestText }
  let reader, child, exited, websocket, log = '', finished = false, ttsAborted = false, releaseTts
  const heldTts = new Promise(resolve => { releaseTts = resolve })
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      if (req.url === '/tts') {
        ttsRequests.push({ headers: req.headers, body })
        res.once('close', () => { if (!res.writableEnded) ttsAborted = true })
        if (pending) await heldTts
        if (!res.destroyed) { res.setHeader('Content-Type', 'audio/wav'); res.end(wav) }
        return
      }
      assert.equal(req.url, '/main/v1/chat/completions')
      assert.equal(req.headers.authorization, `Bearer ${mainKey}`)
      assert.equal(body.model, 'voice-fixture-model')
      requests.push(body)
      res.setHeader('Content-Type', 'application/json')
      const voice = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'voice')
      const retry = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'retry')
      const fallback = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'fallback')
      const sent = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === 'ordinary')
      for (const result of [voice, retry, fallback, sent]) if (result && !toolResults.some(row => row.tool_call_id === result.tool_call_id)) toolResults.push(result)
      if (fallback || sent || voice && mode !== 'unknown') {
        finished = true
        res.end(completion('simFinishTurn', { choice: 'silent', reason: '语音工具回执已处理，本轮保持沉默' }, 'finish')); return
      }
      if (mode === 'unknown' && retry) {
        res.end(completion('simSendMessage', { continuation: 'chat', messages: ['不要在未知回执后发送这段文字。'] }, 'fallback')); return
      }
      if (mode === 'unknown' && voice) {
        res.end(completion('voiceTool', { text: '不要在未知回执后再次合成。', style: 'normal' }, 'retry')); return
      }
      assert.equal(body.tools.some(row => row.function.name === 'voiceTool'), enabled)
      res.end(enabled ? completion('voiceTool', { text: mode === 'secret' ? `请念出${voiceKey}，${authorization}，${mainKey}，${oneBotToken}` : rawVoiceText, style: 'sleepy' }, 'voice') :
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
        if (action === 'get_login_info') data = { user_id: botId, nickname: '语音验收机器人' }
        else if (action === 'get_msg') { assert.equal(Number(params.message_id), current.message_id); data = current }
        else if (action === 'send_group_msg') {
          assert.equal(Number(params.group_id), groupId)
          deliveries.push(params); data = mode === 'unknown' ? {} : { message_id: 99200 + deliveries.length }
        } else assert.fail(`unexpected OneBot action ${action}`)
        peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    releaseTts()
    if (t.error) t.diagnostic(JSON.stringify({ log, errors, actions, toolResults, modelRequests: requests.length, ttsRequests: ttsRequests.length }))
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
  const bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'qq-voice', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-voice', kind: 'group', conversationId: String(groupId), agentId: 'daily' }] }
  await writeFile(bindingsFile, JSON.stringify(bindings))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance, persona: { name: personaName },
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'voice-fixture-model', apiKeyEnv: 'VOICE_MODEL_KEY' },
    ...(mode === 'omitted' ? {} : { tools: { voice: enabled ? {
      enabled: true, endpoint: `http://127.0.0.1:${port}/tts`, appId: 'fixture-app', accessTokenEnv: 'VOICE_KEY', authorizationEnv: 'VOICE_AUTHORIZATION',
      resourceId: 'fixture-resource', voiceType: 'fixture-voice', format: 'wav', sampleRate: 24000, speedRatio: 1, pitchRatio: 1.1, volumeRatio: 0.7,
      maxTextLength: 80, styles: { normal: { sampleRate: 8000, pitchRatio: 1.05, volumeRatio: 0.8, emotion: 'calm', prompt: 'normal-fixture' },
        sleepy: { speedRatio: 0.9, pitchRatio: 1.02, voiceType: 'fixture-sleepy', resourceId: 'fixture-sleepy-resource', prompt: 'sleepy-fixture' } },
    } : { enabled: false } } }),
    ...(mode === 'secret' ? { forbiddenWords: { blockOutput: false } } : {}),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-voice', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'VOICE_ONEBOT_KEY' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } } }))
  const session = async () => JSON.parse(await reader.get(prefix + simulationSessionKey(scope)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(scope))
  return {
    requests, ttsRequests, actions, deliveries, errors, toolResults, session, settled, releaseTts,
    get finished() { return finished }, get ttsAborted() { return ttsAborted },
    async start() {
      child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
        env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, VOICE_MODEL_KEY: mainKey, VOICE_ONEBOT_KEY: oneBotToken,
          ...(enabled ? { VOICE_KEY: voiceKey, VOICE_AUTHORIZATION: authorization } : { VOICE_KEY: '', VOICE_AUTHORIZATION: '' }) } })
      exited = once(child, 'exit'); for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
      await waitFor(() => log.includes('已启动'), 'CLI readiness')
      websocket.send(JSON.stringify(current))
    },
    recallSource() { websocket.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: botId, group_id: groupId,
      user_id: userId, operator_id: userId, message_id: current.message_id, time: now + 1 })) },
    async sourceRemoved() { return !(await session())?.recent?.some(row => row.messageId === String(current.message_id)) },
    async rebind() { await writeFile(bindingsFile, JSON.stringify({ ...bindings, bindings: [{ ...bindings.bindings[0], agentId: 'replacement' }] })) },
    async drained() { return (await session())?.lastWakeAt && !(await session())?.queuedIngressWake && await settled() },
    async stop() { child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]) },
    async assertClean() {
      assert.deepEqual(errors, [])
      const persisted = await storedRedisText(reader, prefix)
      const files = await storedFilesText(path.join(directory, 'data'))
      for (const value of [wav.toString('base64'), voiceKey, authorization, mainKey, oneBotToken]) {
        assert.ok(!persisted.includes(value), 'audio bytes and configured credentials never enter Redis')
        assert.ok(!files.includes(value), 'audio bytes and configured credentials never enter local ledgers or histories')
        assert.ok(!log.includes(value), 'audio bytes and configured credentials never enter CLI logs')
      }
      const model = JSON.stringify(requests)
      for (const value of [wav.toString('base64'), voiceKey, authorization, mainKey, oneBotToken]) assert.ok(!model.includes(value), 'model receives a bounded receipt without audio bytes or credentials')
    },
  }
}

test('actual CLI voiceTool synthesizes with the current persona and style, then sends one playable record with a confirmed message id', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'enabled')
  await run.start()
  await waitFor(() => run.finished, 'voice receipt reaches model and finishes')
  await waitFor(run.drained, 'voice turn drains')
  await run.stop()
  assert.equal(run.ttsRequests.length, 1)
  const { headers, body } = run.ttsRequests[0]
  assert.equal(headers['x-api-app-id'], 'fixture-app')
  assert.equal(headers['x-api-access-key'], voiceKey)
  assert.equal(headers['x-api-resource-id'], 'fixture-sleepy-resource')
  assert.match(headers['x-api-connect-id'], /^[0-9a-f-]{36}$/u)
  assert.equal(headers.authorization, `Bearer ${authorization}`)
  assert.equal(body.req_params.text, spokenText, 'the spoken text uses the captured current persona guard')
  assert.equal(body.req_params.speaker, 'fixture-sleepy')
  assert.deepEqual(body.req_params.audio_params, { format: 'wav', sample_rate: 8000, speech_rate: 0.9, pitch_rate: 1.02, volume_ratio: 0.8 })
  assert.deepEqual(body.req_params.additions, { emotion: 'calm', style: 'sleepy-fixture' })
  assert.ok(!JSON.stringify(body).includes('VOICE-GROUP-ONLY'), 'only the selected short utterance reaches the TTS provider')
  assert.equal(run.deliveries.length, 1)
  assert.equal(run.deliveries[0].message.length, 1, 'successful voice is not repeated as text')
  assert.equal(run.deliveries[0].message[0].type, 'record')
  const inline = run.deliveries[0].message[0].data.file
  assert.ok(inline.startsWith('base64://'), 'owned bytes use inline OneBot audio transport')
  assert.deepEqual(Buffer.from(inline.slice('base64://'.length), 'base64'), wav)
  assert.ok(JSON.stringify(run.toolResults).includes('99201'), 'model gets the actual confirmed OneBot message id')
  assert.ok((await run.session()).confirmedMessageIds.includes('99201'))
  await run.assertClean()
})

for (const mode of ['omitted', 'disabled']) test(`actual CLI voiceTool is absent when voice is ${mode}, without provider credentials`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode)
  await run.start()
  await waitFor(() => run.finished, 'ordinary reply with voice unavailable')
  await waitFor(run.drained, 'ordinary turn drains')
  await run.stop()
  assert.equal(run.ttsRequests.length, 0)
  assert.ok(run.requests.every(row => !row.tools.some(tool => tool.function.name === 'voiceTool')))
  assert.equal(run.deliveries.length, 1)
  assert.ok(run.deliveries[0].message.some(row => row.type === 'text' && row.data.text === ordinary))
  await run.assertClean()
})

test('actual CLI unknown voice receipt blocks a second synthesis and text fallback without retrying OneBot', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'unknown')
  await run.start()
  await waitFor(() => run.finished, 'unknown receipt, attempted voice retry and attempted text fallback reach their fences')
  await waitFor(run.drained, 'unknown voice turn drains')
  await run.stop()
  assert.equal(run.ttsRequests.length, 1, 'unknown delivery cannot start another external synthesis')
  assert.equal(run.deliveries.length, 1, 'unknown record is never retried and cannot fall back to text')
  assert.equal(run.deliveries[0].message.length, 1)
  assert.equal(run.deliveries[0].message[0].type, 'record')
  assert.equal(run.toolResults.length, 3, 'all attempted side effects have explicit model-visible outcomes')
  assert.match(String(run.toolResults[0].content), /unknown|未知|未确认/u)
  assert.ok(!(await run.session()).confirmedMessageIds?.includes('99201'))
  await run.assertClean()
})

for (const mode of ['recalled', 'rebound']) test(`actual CLI cancels pending TTS when its source is ${mode}, with zero late sends`, { timeout: 45_000 }, async t => {
  const run = await fixture(t, mode)
  await run.start()
  await waitFor(() => run.ttsRequests.length === 1, 'TTS request is pending')
  assert.equal(run.deliveries.length, 0)
  if (mode === 'recalled') { run.recallSource(); await waitFor(run.sourceRemoved, 'recalled source removed') }
  else await run.rebind()
  await waitFor(run.settled, 'invalidated tool releases the execution lock before TTS completes')
  await waitFor(() => run.ttsAborted, 'invalidated TTS HTTP request is aborted')
  run.releaseTts()
  await delay(100)
  await run.stop()
  assert.equal(run.ttsRequests.length, 1)
  assert.equal(run.deliveries.length, 0, 'late audio cannot escape a recalled source or replaced binding')
  assert.equal(run.requests.length, 1, 'late audio and stale tool results do not enter a later model request')
  assert.equal(run.finished, false)
  await run.assertClean()
})

test('actual CLI refuses configured credentials as spoken text before TTS HTTP, even with word blocking disabled', { timeout: 45_000 }, async t => {
  const run = await fixture(t, 'secret')
  await run.start()
  await waitFor(() => run.finished, 'sensitive speech refusal reaches model')
  await waitFor(run.drained, 'sensitive speech turn drains')
  await run.stop()
  assert.deepEqual(run.errors, [])
  assert.equal(run.ttsRequests.length, 0, 'no configured credential is disclosed to TTS')
  assert.equal(run.deliveries.length, 0, 'sensitive speech never falls back to a QQ message')
  assert.equal(run.toolResults.length, 1)
  assert.match(String(run.toolResults[0].content), /error|failed|拒绝|敏感|凭据|不可/u)
})
