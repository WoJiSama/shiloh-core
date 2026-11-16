import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const botId = 19000002, groupId = 310002, userId = 330029
const mainKey = 'standalone-images-main-private-key'
const imageKey = 'standalone-images-provider-private-key'
const oneBotToken = 'standalone-images-onebot-private-token'
const prompt = '画一把蓝色雨伞'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const address = simulationAddressKey(target)

async function waitFor(probe, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function completion(message) {
  return JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
}

function call(name, input) {
  return { content: '', tool_calls: [{ id: `images-fixture-${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(input) } }] }
}

async function exerciseImageHost(t, { receipt = 'sent', edit = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-agent-images-'))
  const instance = `images-${edit ? 'edit' : 'generation'}-${receipt}`
  const prefix = `bl-agent:${instance}:`
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], providerRequests = [], deliveries = [], lookups = [], unexpected = [], fixtureErrors = []
  const toolName = edit ? 'googleImageEditTool' : 'bananaTool'
  let client, reader, child, exited, log = '', finishRequested = false, sourceSeq
  const original = {
    message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    message_id: 83201, time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: '图片验收群友' },
    message: [{ type: 'at', data: { qq: String(botId) } },
      { type: 'text', data: { text: '图片工具验收：请画一把蓝色雨伞。本群线索 GROUP-ONLY 不需要交给图片服务。' } },
      ...(edit ? [{ type: 'image', data: { file: `base64://${png}` } }] : [])],
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/image/v1/images/generations' || request.url === '/image/v1/images/edits') {
        let body, image
        if (request.headers['content-type']?.startsWith('multipart/form-data;')) {
          const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData()
          const file = form.get('image')
          image = { type: file.type, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }
          body = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string'))
        } else body = JSON.parse(bytes.toString())
        providerRequests.push({ path: request.url, auth: request.headers.authorization, body, image })
        response.end(JSON.stringify({ data: [{ b64_json: png }], usage: { input_tokens: 33, output_tokens: 11, total_tokens: 44 } }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        const body = JSON.parse(bytes.toString())
        mainRequests.push({ auth: request.headers.authorization, body })
        const result = body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `images-fixture-${toolName}`)
        if (result && !finishRequested) {
          finishRequested = true
          response.end(completion(call('simFinishTurn', { choice: 'silent', reason: '本轮图片工具回执已核实，保持沉默' })))
        } else if (finishRequested) {
          response.end(completion(call('simDecide', { decision: 'silent', reason: '本轮已经处理完成' })))
        } else {
          if (edit) {
            const visible = body.messages.filter(row => row.role === 'user').map(row => String(row.content)).join('\n')
            sourceSeq = Number([...visible.matchAll(/^#(\d+)[^\n]*图片工具验收[^\n]*$/gmu)].at(-1)?.[1] ?? 0)
          }
          response.end(completion(call(toolName, { prompt, ...(edit ? { sourceSeq } : {}) })))
        }
        return
      }
      unexpected.push(request.url)
      response.writeHead(404).end('{}')
    } catch (error) {
      fixtureErrors.push(String(error))
      response.writeHead(500).end('{}')
    }
  })
  server.on('upgrade', (request, connection, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${oneBotToken}`) {
      connection.destroy()
      return
    }
    sockets.handleUpgrade(request, connection, head, websocket => sockets.emit('connection', websocket))
  })
  sockets.on('connection', websocket => {
    client = websocket
    websocket.on('message', message => {
      const { action, params, echo } = JSON.parse(String(message))
      let data
      if (action === 'get_login_info') data = { user_id: botId, nickname: '图片工具验收账号' }
      else if (action === 'get_msg') { lookups.push(params); data = original }
      else if (action === 'send_group_msg') {
        deliveries.push({ action, params })
        data = receipt === 'sent' ? { message_id: 93200 + deliveries.length } : {}
      } else { unexpected.push(action); data = {} }
      websocket.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
    })
  })
  t.after(async () => {
    if (t.error) {
      t.diagnostic(log)
      t.diagnostic(JSON.stringify({ sourceSeq, lookups, providers: providerRequests.length, deliveries: deliveries.length, fixtureErrors,
        results: mainRequests.flatMap(item => item.body.messages.filter(row => row.role === 'tool')) }))
    }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (exited) await exited
    for (const websocket of sockets.clients) websocket.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const imageBaseUrl = `http://127.0.0.1:${port}/image/v1`
  const config = {
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-images-main', apiKeyEnv: 'TEST_AGENT_IMAGES_MAIN_KEY' },
    tools: { images: { [edit ? 'edit' : 'generation']: { baseUrl: imageBaseUrl, name: 'standalone-images-provider',
      apiKeyEnv: 'TEST_AGENT_IMAGES_PROVIDER_KEY', size: '1024x1024', quality: 'high' } } },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-images', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_AGENT_IMAGES_ONEBOT_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1_000, proactiveProbability: 0, probability: 0 },
      rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } },
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-images', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-images', kind: 'group', conversationId: String(groupId), agentId: 'daily' }],
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
    env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_AGENT_IMAGES_MAIN_KEY: mainKey,
      TEST_AGENT_IMAGES_PROVIDER_KEY: imageKey, TEST_AGENT_IMAGES_ONEBOT_TOKEN: oneBotToken },
  })
  exited = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  await waitFor(() => log.includes('已启动'), 'standalone image host readiness')
  client.send(JSON.stringify({ post_type: 'message', ...original }))
  await waitFor(() => finishRequested, 'image tool result consumed by the model')
  await waitFor(async () => {
    const state = JSON.parse(await reader.get(prefix + simulationSessionKey(address)) || 'null')
    return state?.lastWakeAt && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(address))
  }, 'silent image turn finished')
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])

  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(unexpected, [])
  assert.equal(providerRequests.length, 1, 'unknown delivery must not regenerate or resend')
  assert.equal(deliveries.length, 1, 'silent finish must not add text or duplicate images')
  const provider = providerRequests[0]
  assert.equal(provider.path, `/image/v1/images/${edit ? 'edits' : 'generations'}`)
  assert.equal(provider.auth, `Bearer ${imageKey}`)
  assert.deepEqual(provider.body, { model: 'standalone-images-provider', prompt, n: edit ? '1' : 1,
    response_format: 'b64_json', size: '1024x1024', quality: 'high' })
  if (edit) {
    assert.ok(sourceSeq > 0)
    assert.deepEqual(lookups, [{ message_id: original.message_id }])
    assert.equal(provider.image.type, 'image/png')
    assert.deepEqual(provider.image.bytes, Buffer.from(png, 'base64'))
  } else assert.deepEqual(lookups, [])
  const tools = new Set(mainRequests[0].body.tools.map(tool => tool.function.name))
  assert.ok(tools.has(toolName))
  assert.ok(!tools.has(edit ? 'bananaTool' : 'googleImageEditTool'))
  assert.ok(!tools.has('simGetMessageImages'), 'attachment editing does not require a vision model')
  assert.ok(mainRequests.every(request => request.auth === `Bearer ${mainKey}` && request.body.model === 'standalone-images-main'))
  const results = mainRequests.flatMap(request => request.body.messages.filter(row => row.role === 'tool' && row.tool_call_id === `images-fixture-${toolName}`))
  assert.ok(results.length > 0)
  for (const result of results) {
    if (receipt === 'sent') assert.match(String(result.content), /已确认发送到当前会话/u)
    else { assert.match(String(result.content), /尚未确认|没有确认|核实前/u); assert.doesNotMatch(String(result.content), /已确认发送|已发送到/u) }
    assert.ok(!String(result.content).includes(png))
    assert.ok(!String(result.content).includes(imageBaseUrl))
  }
  assert.deepEqual(deliveries[0], { action: 'send_group_msg', params: { group_id: groupId,
    message: [{ type: 'image', data: { file: `base64://${png}` } }] } })
  const ledgerDir = path.join(directory, 'data', instance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
  const rows = ledgerText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.filter(row => row.stage === 'agent-tool').map(row => [row.scope, row.model, row.u.total]),
    [[address, 'standalone-images-provider', 44]])
  assert.deepEqual(rows.filter(row => row.stage === 'api' && row.model === 'standalone-images-provider').map(row => [row.scope, row.u.total]),
    [['global', 44]])
  for (const value of [log, ledgerText, JSON.stringify(deliveries), ...mainRequests.map(request => JSON.stringify(request.body)), JSON.stringify(provider.body)]) {
    for (const secret of [mainKey, imageKey, oneBotToken]) assert.ok(!value.includes(secret))
  }
  assert.ok(!JSON.stringify(provider.body).includes('GROUP-ONLY'))
}

test('standalone bananaTool delivers provider image bytes once and silently finishes after a confirmed QQ receipt', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => exerciseImageHost(t))

test('standalone bananaTool keeps a QQ response without a message ID unknown and does not regenerate, resend, or claim success', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => exerciseImageHost(t, { receipt: 'unknown' }))

test('standalone googleImageEditTool reads a visible sourceSeq original through OneBot without vision and sends edited bytes', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => exerciseImageHost(t, { edit: true }))
