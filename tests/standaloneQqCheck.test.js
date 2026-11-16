import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '123456001' }
const modelKey = 'preflight-local-model-key'
const qqToken = 'preflight-local-onebot-key'
const repo = fileURLToPath(new URL('../', import.meta.url))
const agentEntry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const runNode = promisify(execFile)

async function createOneBotServer(t) {
  const server = createServer()
  const ws = new WebSocketServer({ noServer: true })
  let httpRequests = 0
  server.on('request', (_request, response) => { httpRequests++; response.writeHead(500).end() })
  server.on('upgrade', (request, socket, head) => {
    ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client, request))
  })
  t.after(async () => {
    for (const client of ws.clients) client.terminate()
    const closed = new Promise(resolve => ws.close(resolve))
    await new Promise(resolve => server.close(resolve))
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { ws, port: server.address().port, get httpRequests() { return httpRequests } }
}

test('standalone preflight checks hosted bindings and QQ login without starting conversation processing', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-preflight-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // The active lease marker makes an accidental normal host start fail before touching OneBot.
  const { reader, url, prefix } = await createAgentRedisFixture(t, 'preflight')
  const oneBot = await createOneBotServer(t)
  const logins = new Map([['/main', account.id], ['/alt', '123456002']])
  const requests = []
  let onLogin
  oneBot.ws.on('connection', (client, upgrade) => client.on('message', async frame => {
    const request = JSON.parse(frame)
    requests.push({ url: upgrade.url, action: request.action, authorization: upgrade.headers.authorization })
    await onLogin?.(upgrade.url)
    if (client.readyState !== client.OPEN) return
    const id = logins.get(upgrade.url)
    // Events from before or after get_login_info must never start a preflight turn.
    const inbound = JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: id,
      user_id: 90001, message_id: 91, time: Math.floor(Date.now() / 1000), message: '不会进入模型' })
    client.send(inbound)
    client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: id } }))
    client.send(inbound)
  }))

  const bindings = {
    version: 1,
    agents: [{ id: 'daily', personaId: 'default' }, { id: 'work', personaId: 'default' }, { id: 'other', personaId: 'unused' }],
    connections: [
      { id: 'main', platform: 'qq', namespace: 'global', accountId: account.id },
      { id: 'alt', platform: 'qq', namespace: 'global', accountId: '123456002' },
      { id: 'other', platform: 'qq', namespace: 'global', accountId: '123456003' },
    ],
    bindings: [
      { connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' },
      { connectionId: 'main', kind: 'group', conversationId: '90002', agentId: 'work' },
      { connectionId: 'main', kind: 'private', conversationId: '90001', agentId: 'daily' },
      { connectionId: 'alt', kind: 'group', conversationId: '90001', agentId: 'daily' },
      { connectionId: 'other', kind: 'group', conversationId: '90001', agentId: 'other' },
    ],
  }
  const config = {
    version: 1, instance: 'preflight', dataDir: 'ledger',
    model: { baseUrl: `http://127.0.0.1:${oneBot.port}/any`, name: 'test', apiKeyEnv: 'TEST_PREFLIGHT_MODEL_KEY' },
    connections: [
      { id: 'main', url: `ws://127.0.0.1:${oneBot.port}/main`, accessTokenEnv: 'TEST_PREFLIGHT_QQ_TOKEN' },
      { id: 'alt', url: `ws://127.0.0.1:${oneBot.port}/alt` },
    ],
    textGroups: [{ connectionId: 'main', conversationId: '90002' }],
    privateChat: { enabled: true },
  }
  const file = path.join(directory, 'agent-host.yaml')
  const bindingsFile = path.join(directory, 'agent-bindings.yaml')
  const writeBindings = () => writeFile(bindingsFile, JSON.stringify(bindings))
  await writeBindings()
  await writeFile(file, JSON.stringify(config))
  const options = { env: { ...process.env, BL_AGENT_REDIS_URL: url, TEST_PREFLIGHT_MODEL_KEY: modelKey, TEST_PREFLIGHT_QQ_TOKEN: qqToken }, timeout: 9_000 }
  const check = (...args) => runNode(process.execPath, [agentEntry, '--config', file, '--check', ...args], options)
  const lease = await reader.get(`${prefix}agent:host-lease`)
  assert.ok(lease)

  const { stdout, stderr } = await check()
  assert.equal(stderr, '')
  assert.deepEqual(JSON.parse(stdout), {
    mode: 'check', instance: 'preflight', redis: 'reachable', simulationEnabled: true, privateChatEnabled: true,
    connections: [
      { id: 'main', accountId: account.id, loginVerified: true, simulationGroups: 1, textGroups: 1, friends: 1 },
      { id: 'alt', accountId: '123456002', loginVerified: true, simulationGroups: 1, textGroups: 0, friends: 0 },
    ],
  })
  assert.deepEqual(requests.splice(0).sort((a, b) => a.url.localeCompare(b.url)), [
    { url: '/alt', action: 'get_login_info', authorization: undefined },
    { url: '/main', action: 'get_login_info', authorization: `Bearer ${qqToken}` },
  ])
  assert.equal(await reader.get(`${prefix}agent:host-lease`), lease)
  assert.deepEqual(await reader.keys(`${prefix}*`), [`${prefix}agent:host-lease`])
  assert.ok(!(await readdir(directory)).includes('ledger'))

  await assert.rejects(check('--migrate-qq-state'), { stderr: /须分别运行/u })
  await assert.rejects(runNode(process.execPath, [agentEntry, '--config', file, '--check'], {
    ...options, env: { ...options.env, BL_AGENT_REDIS_URL: `unix://${path.join(directory, 'missing.sock')}` },
  }), { stderr: /独立宿主无法连接 Redis/u })
  bindings.agents[1].personaId = 'missing'
  await writeBindings()
  await assert.rejects(check(), { stderr: /人设不存在/u })
  assert.deepEqual(requests, [])
  bindings.agents[1].personaId = 'default'
  await writeBindings()
  logins.set('/alt', '123456999')
  await assert.rejects(check(), error => error.code === 1 && error.stdout === '' &&
    /未能验证 QQ 账号（alt）/u.test(error.stderr) && ![modelKey, qqToken, '123456999'].some(value => error.stderr.includes(value)))
  assert.equal(requests.length, 2)
  logins.set('/alt', '123456002')
  onLogin = async urlPath => {
    if (urlPath === '/main') {
      bindings.bindings = bindings.bindings.filter(binding => binding.conversationId !== '90002')
      await writeBindings()
    }
  }
  await assert.rejects(check(), { stderr: /检查期间角色绑定文件已改变/u })
  assert.equal(oneBot.httpRequests, 0)
  assert.equal(await reader.get(`${prefix}agent:host-lease`), lease)
  assert.deepEqual(await reader.keys(`${prefix}*`), [`${prefix}agent:host-lease`])
})

test('OneBot retains reply presence and rejects messages without a transport timestamp', { timeout: 8_000 }, async t => {
  const { ws, port } = await createOneBotServer(t)
  const connected = once(ws, 'connection')
  ws.on('connection', client => client.on('message', frame => {
    const { action, echo } = JSON.parse(frame)
    if (action === 'get_login_info') client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: account.id } }))
  }))
  const adapter = createOneBotConnection({ connection: { id: 'qq', account }, url: `ws://127.0.0.1:${port}`,
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(() => adapter.stop())
  const received = []
  await adapter.start(async event => { received.push(event.message) })
  const [socket] = await connected
  const time = Math.floor(Date.now() / 1000)
  const base = { post_type: 'message', self_id: account.id, message_type: 'group', group_id: 90001, user_id: 90002 }
  const text = '#禁用我的记忆'
  const send = (message_id, message, occurredAt) => socket.send(JSON.stringify({ ...base, message_id, message, time: occurredAt }))
  send(1, text, undefined)
  send(2, text, [time])
  send(3, `[CQ:reply]${text}`, time)
  send(4, [{ type: 'reply', data: { qq: '90002' } }, { type: 'text', data: { text } }], time)
  send(5, `[CQ:reply,id=42]${text}`, String(time))
  send(6, text, time)
  for (let attempt = 0; attempt < 100 && received.length < 4; attempt++) await delay(15)
  assert.deepEqual(received.map(message => [message.messageId, message.text, message.quote]), [
    ['3', text, { parts: [] }], ['4', text, { parts: [] }], ['5', text, { messageId: '42', parts: [] }], ['6', text, undefined],
  ])
})
