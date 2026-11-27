import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import WebSocket, { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const token = 'reverse-local-token'
const headers = { Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' }
const event = id => ({ post_type: 'message', message_type: 'group', self_id: account.id,
  group_id: '315320', user_id: '324152', message_id: id, time: Math.floor(Date.now() / 1000), message: '反向入站' })

async function address() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return `ws://127.0.0.1:${port}/onebot`
}

function adapterAt(url, callbacks = {}) {
  return createOneBotConnection({
    connection: { id: 'reverse', account }, url, transport: 'reverse-websocket', accessToken: token,
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {}, ...callbacks,
  })
}

async function waitFor(probe, description, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function peerAt(t, url, handleRequest, timeoutMs) {
  let peer
  await waitFor(async () => {
    peer = new WebSocket(url, { headers })
    const client = peer
    if (handleRequest) client.on('message', frame => handleRequest(client, JSON.parse(frame)))
    try { await once(peer, 'open'); return true }
    catch { peer.terminate(); return false }
  }, 'reverse listener', timeoutMs)
  peer.on('error', () => {})
  t.after(() => peer.terminate())
  return peer
}

function rejectUpgrade(url, suppliedHeaders = headers) {
  return new Promise((resolve, reject) => {
    const peer = new WebSocket(url, { headers: suppliedHeaders })
    peer.on('error', () => {})
    peer.on('unexpected-response', (_request, response) => {
      response.resume()
      peer.terminate()
      resolve(response.statusCode)
    })
    peer.once('open', () => { peer.terminate(); reject(new Error('unexpected upgrade')) })
  })
}

const login = (peer, request, userId = account.id) => peer.send(JSON.stringify({
  status: 'ok', retcode: 0, echo: request.echo, data: { user_id: userId, nickname: '反向测试' },
}))

test('reverse OneBot authenticates upgrades and login before events and shares guarded delivery', { timeout: 15_000 }, async t => {
  const url = await address()
  const received = [], requests = []
  const adapter = adapterAt(url)
  t.after(() => adapter.stop())
  const started = adapter.start(async incoming => { received.push(incoming) })
  // Attach a handler before any assertion can interrupt initial authentication.
  void started.catch(() => {})
  let pendingLogin
  const peer = await peerAt(t, url, (client, request) => {
    requests.push(request)
    if (request.action === 'get_login_info') pendingLogin = request
    else client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: 'sent-17' } }))
  })
  await waitFor(() => pendingLogin, 'login request')
  peer.send(JSON.stringify(event('before-login')))
  assert.equal(adapter.isReady(), false)
  for (const [candidate, supplied, status] of [
    [url + '?token=wrong', headers, 404],
    [url + '/other', headers, 404],
    [url, { ...headers, Authorization: 'Bearer wrong' }, 401],
    [url, { ...headers, 'X-Self-ID': '987654321' }, 401],
    [url, { ...headers, 'X-Client-Role': 'Event' }, 401],
    [url, headers, 409],
  ]) assert.equal(await rejectUpgrade(candidate, supplied), status)
  login(peer, pendingLogin)
  await started
  peer.send(JSON.stringify(event('after-login')))
  await waitFor(() => received.length === 1, 'verified inbound message')
  assert.equal(received[0].message.messageId, 'after-login')
  assert.equal(adapter.botName, '反向测试')
  const action = { version: 1, kind: 'message.send', target: { account, kind: 'group', id: '315320' },
    parts: [{ kind: 'text', text: '反向回复' }] }
  assert.equal((await adapter.actions.send(action, { isCurrent: () => false })).state, 'failed')
  const receipt = await adapter.actions.send(action, { isCurrent: () => true })
  assert.equal(receipt.state, 'sent')
  assert.equal(receipt.messageId, 'sent-17')
  assert.deepEqual(requests.map(row => row.action), ['get_login_info', 'send_group_msg'])
  const status = await new Promise((resolve, reject) => {
    const request = get(url.replace('ws:', 'http:'), response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
  })
  assert.equal(status, 404)
})

test('OneBot backpressure preserves ordinary FIFO and admits recall and privacy control during a QQ API read', { timeout: 15_000 }, async t => {
  const url = await address()
  const admitted = [], failures = []
  const first = Promise.withResolvers()
  let pressures = 0, heldRead
  const adapter = adapterAt(url, {
    onAdmissionPressure() { pressures++ },
    onEventError(error, code) { failures.push({ error, code }) },
  })
  t.after(() => { first.resolve(); adapter.stop() })
  const started = adapter.start(async incoming => {
    if (incoming.kind === 'recall') { admitted.push('recall'); return }
    const { messageId, text } = incoming.message
    if (messageId === '1') await first.promise
    admitted.push(text === '#禁用我的记忆' ? 'privacy' : messageId)
  })
  void started.catch(() => {})
  const peer = await peerAt(t, url, (client, request) => {
    if (request.action === 'get_login_info') login(client, request)
    else heldRead = () => client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: 'sent-during-pressure' } }))
  })
  await started
  for (let id = 1; id <= 350; id++) peer.send(JSON.stringify(event(String(id))))
  await waitFor(() => pressures > 0, 'backpressure begins while the first message is blocked')
  const send = adapter.actions.send({ version: 1, kind: 'message.send', target: { account, kind: 'group', id: '315320' }, parts: [{ kind: 'text', text: '测试' }] })
  await waitFor(() => heldRead, 'outstanding OneBot API request')
  peer.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_recall', self_id: account.id, group_id: '315320', message_id: '350' }))
  peer.send(JSON.stringify({ ...event('351'), message: '#禁用我的记忆' }))
  await waitFor(() => admitted.length === 2 && pressures > 0, 'controls bypass the blocked message lane')
  assert.deepEqual(admitted, ['recall', 'privacy'])
  heldRead()
  assert.equal((await send).state, 'sent')
  first.resolve()
  await waitFor(() => admitted.length === 352, 'ordinary backlog drains')
  assert.deepEqual(admitted.slice(2), Array.from({ length: 350 }, (_, index) => String(index + 1)))
  assert.deepEqual(failures, [])
})

test('reverse OneBot reconnect rechecks identity and never replays an uncertain send', { timeout: 15_000 }, async t => {
  const url = await address()
  let disconnected = 0, reconnected = 0, fatal = 0
  const adapter = adapterAt(url, {
    onDisconnect() { disconnected++ }, onReconnect() { reconnected++ }, onError() { fatal++ },
  })
  t.after(() => adapter.stop())
  const started = adapter.start(async () => {})
  void started.catch(() => {})
  let sends = 0
  const first = await peerAt(t, url, (client, request) => {
    if (request.action === 'get_login_info') login(client, request)
    else { sends++; client.terminate() }
  })
  await started
  const action = { version: 1, kind: 'message.send', target: { account, kind: 'group', id: '315320' },
    parts: [{ kind: 'text', text: '结果未知的回复' }] }
  assert.equal((await adapter.actions.send(action)).state, 'unknown')
  await waitFor(() => disconnected === 1, 'disconnect callback')
  assert.equal(adapter.isReady(), false)
  const second = await peerAt(t, url, (client, request) => {
    assert.equal(request.action, 'get_login_info')
    login(client, request)
  })
  await waitFor(() => reconnected === 1, 'reverified connection')
  assert.equal(adapter.isReady(), true)
  assert.equal(sends, 1)
  second.terminate()
  await waitFor(() => disconnected === 2, 'second disconnect')
  await peerAt(t, url, (client, request) => login(client, request, '987654321'))
  await waitFor(() => fatal === 1, 'wrong login account stops connection')
  assert.equal(adapter.isReady(), false)
  assert.equal((await adapter.actions.send(action)).state, 'failed')
})

test('reverse OneBot stop cancels initial verification and releases the listening address', { timeout: 10_000 }, async t => {
  const url = await address()
  const adapter = adapterAt(url)
  t.after(() => adapter.stop())
  const started = adapter.start(async () => {})
  const failed = assert.rejects(started, /未能验证 QQ 账号|连接已停止/)
  await peerAt(t, url)
  adapter.stop()
  assert.equal(adapter.isReady(), false)
  await failed
  const server = createServer()
  t.after(() => server.close())
  server.listen(Number(new URL(url).port), '127.0.0.1')
  await once(server, 'listening')
})

test('a retired socket cannot disconnect an immediately restarted OneBot adapter', { timeout: 10_000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  t.after(async () => {
    for (const peer of server.clients) peer.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  let disconnected = 0
  server.on('connection', peer => peer.on('message', frame => login(peer, JSON.parse(frame))))
  const adapter = adapterAt(`ws://127.0.0.1:${server.address().port}`, {
    transport: 'forward-websocket', onDisconnect() { disconnected++ },
  })
  t.after(() => adapter.stop())
  await adapter.start(async () => {})
  adapter.stop()
  assert.equal(adapter.isReady(), false)
  await adapter.start(async () => {})
  assert.equal(adapter.isReady(), true)
  assert.equal(disconnected, 0)
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} keeps two valid inline images within their binary size limit`, { timeout: 15_000 }, async t => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
    const image = marker => {
      const bytes = Buffer.alloc(2 * 1024 * 1024)
      png.copy(bytes)
      bytes[bytes.length - 1] = marker
      return bytes.toString('base64')
    }
    const images = [image(1), image(2)]
    const url = await address()
    let sourceImages = images
    const respond = (peer, request) => {
      if (request.action === 'get_login_info') return login(peer, request)
      assert.equal(request.action, 'get_msg')
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: {
        message_type: 'group', group_id: '315320', message_id: 17, time: Math.floor(Date.now() / 1000),
        sender: { user_id: '324152' },
        message: sourceImages.map(base64 => ({ type: 'image', data: { file: `base64://${base64}` } })),
      } }))
    }
    let server
    if (transport === 'forward-websocket') {
      server = new WebSocketServer({ port: Number(new URL(url).port), host: '127.0.0.1' })
      await once(server, 'listening')
      server.on('connection', peer => peer.on('message', frame => respond(peer, JSON.parse(frame))))
      t.after(async () => {
        for (const peer of server.clients) peer.terminate()
        await new Promise(resolve => server.close(resolve))
      })
    }
    // Exercise the public transport selector rather than a private session helper.
    const selected = adapterAt(url, { transport })
    t.after(() => selected.stop())
    const started = selected.start(async () => {})
    void started.catch(() => {})
    if (transport === 'reverse-websocket') await peerAt(t, url, respond)
    await started
    const target = { account, kind: 'group', id: '315320' }
    const guard = { isCurrent: () => true, allowsSource: async () => true }
    const result = await selected.readMessageImages(target, '17', guard)
    assert.equal(result?.length, 2)
    assert.deepEqual(result.map(row => row.base64), images)
    assert.equal(selected.isReady(), true)
    sourceImages = [Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 1 - png.length)]).toString('base64')]
    assert.equal(await selected.readMessageImages(target, '17', guard), undefined)
    assert.equal(selected.isReady(), true)
  })
}

test('reverse OneBot host configuration requires a token reference and a plain WS listener', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-reverse-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = {
    version: 1, instance: 'reverse-check', dataDir: 'ledger',
    model: { baseUrl: 'http://127.0.0.1:1/v1', name: 'fixture', apiKeyEnv: 'REVERSE_MODEL_KEY' },
    connections: [{ id: 'reverse', transport: 'reverse-websocket', url: await address(), accessTokenEnv: 'REVERSE_QQ_TOKEN' }],
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'reverse', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'reverse', kind: 'private', conversationId: '324152', agentId: 'role' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = async (connection, env = { REVERSE_MODEL_KEY: 'fake-key', REVERSE_QQ_TOKEN: token }, options) => {
    await writeFile(file, JSON.stringify({ ...config, connections: [connection] }))
    return readStandaloneAgentConfig(file, env, options)
  }
  const connection = config.connections[0]
  const actual = await read(connection)
  assert.equal(actual.connections[0].transport, 'reverse-websocket')
  assert.equal(actual.connections[0].accessToken, token)
  const { accessTokenEnv, ...missingToken } = connection
  await assert.rejects(read(missingToken), /必须声明 accessTokenEnv/)
  await assert.rejects(read(connection, { REVERSE_MODEL_KEY: 'fake-key' }), /缺少 OneBot access token/)
  assert.equal((await read(connection, {}, { requireCredentials: false })).connections[0].transport, 'reverse-websocket')
  await assert.rejects(read({ ...connection, transport: 'http' }), /connections.transport/)
  await assert.rejects(read({ ...connection, url: connection.url.replace('ws:', 'wss:') }), /须使用 ws:\/\//)
})

test('reverse OneBot CLI preflight validates login and exits without event, model or storage work', {
  skip: !redisAvailable, timeout: 25_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-reverse-preflight-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { url: redisUrl, reader, prefix } = await createAgentRedisFixture(t, 'reverse-check')
  const url = await address()
  const config = {
    version: 1, instance: 'reverse-check', dataDir: 'ledger',
    model: { baseUrl: 'http://127.0.0.1:1/v1', name: 'fixture', apiKeyEnv: 'REVERSE_MODEL_KEY' },
    connections: [{ id: 'reverse', transport: 'reverse-websocket', url, accessTokenEnv: 'REVERSE_QQ_TOKEN' }],
  }
  await writeFile(path.join(directory, 'agent-host.yaml'), JSON.stringify(config))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'reverse', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'reverse', kind: 'group', conversationId: '315320', agentId: 'role' }],
  }))
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
  const check = promisify(execFile)(process.execPath, [entry, '--config', path.join(directory, 'agent-host.yaml'), '--check'], {
    env: { ...process.env, BL_AGENT_REDIS_URL: redisUrl, REVERSE_MODEL_KEY: 'fake-key', REVERSE_QQ_TOKEN: token },
    cwd: directory, timeout: 20_000,
  })
  void check.catch(() => {})
  const requests = []
  await peerAt(t, url, (peer, request) => {
    requests.push(request.action)
    peer.send(JSON.stringify(event('check-before-login')))
    login(peer, request)
    peer.send(JSON.stringify(event('check-after-login')))
  }, 15_000)
  const result = await check
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.mode, 'check')
  assert.equal(report.connections[0].loginVerified, true)
  assert.deepEqual(requests, ['get_login_info'])
  assert.deepEqual(await reader.keys(prefix + '*'), [prefix + 'agent:host-lease'])
  await assert.rejects(stat(path.join(directory, 'ledger')), { code: 'ENOENT' })
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
})

test('standalone reverse OneBot carries a bound private turn through model and confirmed delivery', {
  skip: !redisAvailable, timeout: 25_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-reverse-turn-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { url: redisUrl, reader } = await createAgentRedisFixture(t, 'reverse-turn-fixture')
  const requests = [], deliveries = []
  const model = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { content: '反向宿主已收到。' } }] }))
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  t.after(() => new Promise(resolve => model.close(resolve)))
  const url = await address()
  await writeFile(path.join(directory, 'agent-host.yaml'), JSON.stringify({
    version: 1, instance: 'reverse-turn', dataDir: 'ledger', privateChat: { enabled: true },
    model: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, name: 'fixture', apiKeyEnv: 'REVERSE_MODEL_KEY' },
    connections: [{ id: 'reverse', transport: 'reverse-websocket', url, accessTokenEnv: 'REVERSE_QQ_TOKEN' }],
  }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'reverse', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'reverse', kind: 'private', conversationId: '324152', agentId: 'role' }],
  }))
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
  const child = spawn(process.execPath, [entry, '--config', path.join(directory, 'agent-host.yaml')], {
    env: { ...process.env, BL_AGENT_REDIS_URL: redisUrl, REVERSE_MODEL_KEY: 'fake-key', REVERSE_QQ_TOKEN: token },
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let log = ''
  child.stdout.on('data', bytes => { log += bytes })
  child.stderr.on('data', bytes => { log += bytes })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited })
  try {
    const peer = await peerAt(t, url, (client, request) => {
      if (request.action === 'get_login_info') return login(client, request)
      deliveries.push(request)
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: 'reply-17' } }))
    }, 15_000)
    await waitFor(() => log.includes('已启动'), 'standalone reverse host readiness')
    peer.send(JSON.stringify({
      ...event('private-17'), message_type: 'private', sub_type: 'friend', group_id: undefined, message: '反向独立回合',
    }))
    await waitFor(() => deliveries.length === 1, 'confirmed private delivery')
    assert.equal(requests.length, 1)
    assert.ok(JSON.stringify(requests[0].messages).includes('反向独立回合'))
    assert.equal(deliveries[0].action, 'send_private_msg')
    assert.equal(String(deliveries[0].params.user_id), '324152')
    assert.ok(JSON.stringify(deliveries[0].params.message).includes('反向宿主已收到'))
    await waitFor(async () => {
      const [key] = await reader.keys('bl-agent:reverse-turn:agent:private-history:*')
      const history = key && JSON.parse(await reader.get(key))
      return history?.turns.some(turn => turn.user.includes('反向独立回合') && turn.reply.includes('反向宿主已收到'))
    }, 'confirmed private history saved')
  } finally {
    child.kill('SIGTERM')
    const [code] = await exited
    assert.equal(code, 0, log)
  }
})
