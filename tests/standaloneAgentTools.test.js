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
const botId = 19000001
const groupId = 310001
const userId = 330019
const instance = 'standalone-tools-test'
const mainKey = 'standalone-main-private-key'
const searchKey = 'standalone-search-private-key'
const oneBotToken = 'standalone-onebot-private-token'
const query = '公开活动的开始时间'
const material = '公开活动在周六上午十点开始'
const reply = `查到公开资料：${material}。`
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }
const address = simulationAddressKey(target)
const prefix = `bl-agent:${instance}:`

async function waitFor(probe, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function completion(message, usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return JSON.stringify({ choices: [{ message }], usage })
}

function call(name, input) {
  return { content: '', tool_calls: [{ id: `tools-fixture-${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(input) } }] }
}

test('standalone QQ uses configured search and web tools through the installed host and records scoped usage', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-agent-tools-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = []
  const searches = []
  const deliveries = []
  const unexpected = []
  const fixtureErrors = []
  let client, reader, child, exited, log = '', finishRequested = false
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/search/v1/chat/completions') {
        searches.push({ path: request.url, auth: request.headers.authorization, body })
        response.end(completion({ content: material }, { prompt_tokens: 31, completion_tokens: 11, total_tokens: 42 }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ auth: request.headers.authorization, body })
        const result = body.messages.findLast(row => row.role === 'tool' && String(row.content).includes(material))
        if (result && !finishRequested) {
          finishRequested = true
          response.end(completion(call('simFinishTurn', { choice: 'chat', reason: '已获得本轮公开资料', messages: [reply] })))
        } else if (finishRequested) {
          response.end(completion(call('simDecide', { decision: 'silent', reason: '本轮已经处理完成' })))
        } else {
          response.end(completion(call('searchInformationTool', { query })))
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
      if (action !== 'get_login_info') deliveries.push({ action, params })
      websocket.send(JSON.stringify({ status: 'ok', retcode: 0, echo,
        data: action === 'get_login_info' ? { user_id: botId, nickname: '工具验收账号' } : { message_id: 93100 + deliveries.length },
      }))
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(log)
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
  const config = {
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-main-fixture', apiKeyEnv: 'TEST_AGENT_TOOLS_MAIN_KEY' },
    tools: {
      search: { baseUrl: `http://127.0.0.1:${port}/search/v1`, name: 'standalone-search-fixture', apiKeyEnv: 'TEST_AGENT_TOOLS_SEARCH_KEY', webSearch: 'off' },
      web: { enabled: true },
    },
    connections: [{ id: 'qq-tools', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_AGENT_TOOLS_ONEBOT_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1_000, proactiveProbability: 0, probability: 0 },
      rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } },
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-tools', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-tools', kind: 'group', conversationId: String(groupId), agentId: 'daily' }],
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
    env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_AGENT_TOOLS_MAIN_KEY: mainKey,
      TEST_AGENT_TOOLS_SEARCH_KEY: searchKey, TEST_AGENT_TOOLS_ONEBOT_TOKEN: oneBotToken },
  })
  exited = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  await waitFor(() => log.includes('已启动'), 'standalone host readiness')
  client.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    message_id: 83101, time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: '验收群友' },
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: '请查公开活动的开始时间。本群线索 GROUP-ONLY 不需要交给搜索。' } }],
  }))
  await waitFor(() => deliveries.length === 1, 'reply from search result')
  await waitFor(async () => {
    const state = JSON.parse(await reader.get(prefix + simulationSessionKey(address)) || 'null')
    return state?.sendTimes?.length === 1 && !await reader.exists(prefix + simulationBusyKey(address))
  }, 'confirmed delivery and finished simulation turn')
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])

  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(unexpected, [])
  assert.equal(searches.length, 1)
  assert.deepEqual(searches[0], { path: '/search/v1/chat/completions', auth: `Bearer ${searchKey}`, body: {
    model: 'standalone-search-fixture', messages: [{ role: 'user', content: query }], stream: false, max_tokens: 2000,
  } })
  const tools = new Set(mainRequests[0].body.tools.map(tool => tool.function.name))
  assert.ok(tools.has('searchInformationTool'))
  assert.ok(tools.has('webParserTool'))
  assert.ok(mainRequests.every(request => request.auth === `Bearer ${mainKey}` && request.body.model === 'standalone-main-fixture'))
  assert.ok(mainRequests.some(request => request.body.messages.some(row => row.role === 'tool' && String(row.content).includes(material))))
  assert.equal(deliveries[0].action, 'send_group_msg')
  assert.equal(deliveries[0].params.group_id, groupId)
  assert.ok(deliveries[0].params.message.some(part => part.type === 'text' && part.data.text === reply))
  const ledgerDir = path.join(directory, 'data', instance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
  const rows = ledgerText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.filter(row => row.stage === 'agent-tool').map(row => [row.scope, row.model, row.u.total]),
    [[address, 'standalone-search-fixture', 42]])
  assert.deepEqual(rows.filter(row => row.stage === 'api' && row.model === 'standalone-search-fixture').map(row => [row.scope, row.u.total]),
    [['global', 42]])
  for (const value of [log, ledgerText, JSON.stringify(deliveries), ...mainRequests.map(request => JSON.stringify(request.body)), JSON.stringify(searches[0].body)]) {
    for (const secret of [mainKey, searchKey, oneBotToken]) assert.ok(!value.includes(secret))
  }
  assert.ok(!JSON.stringify(searches[0].body).includes('GROUP-ONLY'))
})
