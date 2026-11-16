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
import { WebSocketServer } from 'ws'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

const botId = 123456789
const userId = 324152
const groupId = 315320
const reviewKey = 'local-review-key-fake'
const mainKey = 'local-main-key-fake'
const upstreamFailure = 'review upstream error must stay private'
const bindings = {
  version: 1,
  agents: [{ id: 'fixture', personaId: 'default' }],
  connections: [{ id: 'qq-local', platform: 'qq', namespace: 'global', accountId: String(botId) }],
  bindings: [{ connectionId: 'qq-local', kind: 'group', conversationId: String(groupId), agentId: 'fixture' }],
}
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const builtAgent = fileURLToPath(new URL('../dist/backend/bootstrap/standaloneAgent.js', import.meta.url))
const releaseAgent = process.env.BL_CHAT_AGENT_RELEASE_DIR && path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR, 'scripts/start-agent.mjs')

function hostConfig(port = 9999) {
  return {
    version: 1, instance: 'standalone-consistency-test',
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'main-test', apiKeyEnv: 'TEST_AGENT_MAIN_KEY' },
    characterConsistency: { baseUrl: `http://127.0.0.1:${port}/review/v1`, name: 'review-test', apiKeyEnv: 'TEST_AGENT_REVIEW_KEY' },
    connections: [{ id: 'qq-local', url: `ws://127.0.0.1:${port}` }],
    simulation: { wake: { batchWindowMs: 1_000, proactiveProbability: 0, probability: 0 },
      rhythm: { enabled: false }, reflection: { enabled: false }, turn: { minSendGapMs: 0 } },
  }
}
async function writeConfig(directory, config) {
  const file = path.join(directory, 'agent-host.yaml')
  await writeFile(file, JSON.stringify(config))
  return file
}

test('standalone review configuration is explicit, isolated and optional by default', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-review-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings))
  const config = hostConfig()
  const mainEnv = { TEST_AGENT_MAIN_KEY: mainKey }
  const credentials = { ...mainEnv, TEST_AGENT_REVIEW_KEY: reviewKey }
  const read = async (input, env = credentials, options) => readStandaloneAgentConfig(await writeConfig(directory, input), env, options)

  assert.equal((await read(config, mainEnv)).characterConsistency, undefined)
  config.simulation.consistency = { enabled: true }
  const { characterConsistency, ...missing } = config
  await assert.rejects(read(missing), /需要配置 characterConsistency/u)
  await assert.rejects(read(config, mainEnv), /环境变量 TEST_AGENT_REVIEW_KEY 缺少/u)
  const preview = await read(config, {}, { requireCredentials: false })
  assert.equal(preview.characterConsistency.apiKey, '')
  const actual = await read(config)
  assert.equal(actual.characterConsistency.model, 'review-test')
  assert.equal(actual.execution.chatAiConfig.chatApiKey, mainKey)
  assert.equal(actual.execution.taskAiConfig, undefined)
  assert.equal((await read(config, { ...mainEnv, TEST_AGENT_REVIEW_KEY: mainKey })).characterConsistency.apiKey, mainKey)

  for (const [input, expected] of [
    [{ apiKey: reviewKey }, /仅支持 baseUrl、name 和 apiKeyEnv/u],
    [{ baseUrl: `https://user:${reviewKey}@review.invalid/v1` }, /baseUrl 不支持凭据/u],
    [{ baseUrl: `https://review.invalid/v1?secret=${reviewKey}` }, /baseUrl 不支持凭据/u],
    [{ baseUrl: 'file:///tmp/config' }, /baseUrl 不支持凭据/u],
    [{ name: ' ' }, /characterConsistency.name/u],
    [{ apiKeyEnv: 'TEST_AGENT_MAIN_KEY' }, /apiKeyEnv 必须与 model.apiKeyEnv 分开声明/u],
  ]) {
    await assert.rejects(read({ ...config, characterConsistency: { ...characterConsistency, ...input } }), error =>
      expected.test(error.message) && !error.message.includes(reviewKey))
  }
})

function completion(message) {
  return JSON.stringify({
    model: 'untrusted-model-label', choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  })
}

async function waitFor(probe, description, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}

test('standalone QQ confirms isolated reviews without retries, tool execution or secret disclosure', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-review-'))
  const redisSocket = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', redisSocket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const socketServer = new WebSocketServer({ noServer: true })
  const deliveries = []
  const requests = []
  let websocket, child, childExit, aborted = false, log = '', redirectProbeCount = 0
  const accepted = '{"verdict":"accept","issues":[]}'
  const cases = ['已通过审核', '提供方拒绝参数', '提供方违规重定向', '提供方返回工具', '提供方回显密钥', '提供方等待关闭']
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text || 'null')
    if (request.url === '/review/v1/chat/completions') {
      const input = JSON.parse(body.messages.at(-1).content)
      const command = input.candidate.messages[0]
      requests.push({ path: request.url, auth: request.headers.authorization, body, command })
      if (command === cases[1]) {
        return response.writeHead(400).end(`unsupported max_tokens, ${upstreamFailure}: ${reviewKey}`)
      }
      if (command === cases[2]) return response.writeHead(307, { location: '/redirect-probe' }).end()
      if (command === cases[3]) {
        return response.end(completion({ content: accepted, tool_calls: [{ function: { name: 'simSendMessage', arguments: '{}' } }] }))
      }
      if (command === cases[4]) {
        const echoed = JSON.stringify({ verdict: 'revise', issues: [{ code: 'state_claim', reason: reviewKey }] })
          .replace(reviewKey, '\\u006c' + reviewKey.slice(1))
        return response.end(completion({ content: echoed }))
      }
      if (command === cases[5]) {
        response.on('close', () => { aborted = !response.writableEnded })
        return
      }
      return response.end(completion({ content: accepted }))
    }
    if (request.url === '/main/v1/chat/completions') {
      const wake = body.messages.findLastIndex(row => typeof row.content === 'string' && row.content.includes('【执行主体】'))
      const command = [...cases].reverse().find(label => String(body.messages[wake]?.content).includes(label))
      const retry = body.messages.slice(wake + 1).some(row => row.role === 'tool')
      requests.push({ path: request.url, auth: request.headers.authorization, body, command, retry })
      return response.end(completion({ content: '', tool_calls: [{
        id: 'fixture-finish', type: 'function', function: { name: 'simFinishTurn',
          arguments: JSON.stringify(!retry && command ? { choice: 'chat', reason: '测试审核', messages: [command] } : { choice: 'silent', reason: '测试结束' }),
        },
      }] }))
    }
    redirectProbeCount++
    response.writeHead(404).end()
  })
  server.on('upgrade', (request, connection, head) => socketServer.handleUpgrade(request, connection, head,
    client => socketServer.emit('connection', client)))
  socketServer.on('connection', client => {
    websocket = client
    client.on('message', message => {
      const { action, params, echo } = JSON.parse(String(message))
      if (action !== 'get_login_info') deliveries.push({ action, params })
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo,
        data: action === 'get_login_info' ? { user_id: botId, nickname: '审核测试' } : { message_id: 93111 },
      }))
    })
  })
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await childExit
    for (const client of socketServer.clients) client.terminate()
    await new Promise(resolve => socketServer.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(redisSocket).catch(() => false), 'isolated Redis socket')
  const config = hostConfig(server.address().port)
  config.simulation.consistency = { enabled: true }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings))
  const configFile = await writeConfig(directory, config)
  const args = releaseAgent ? [releaseAgent, '--config', configFile] : ['--input-type=module', '-e',
    `import { main } from ${JSON.stringify(builtAgent)}; await main(['--config', process.argv[1]])`, configFile]
  child = spawn(process.execPath, args, { env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${redisSocket}`,
    TEST_AGENT_MAIN_KEY: mainKey, TEST_AGENT_REVIEW_KEY: reviewKey } })
  childExit = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  await waitFor(() => log.includes('已启动'), 'standalone readiness')

  const send = (label, index) => websocket.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId, group_id: groupId, user_id: userId,
    message_id: 83000 + index, time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: '验收群友' },
    message: [{ type: 'at', data: { qq: String(botId) } }, { type: 'text', data: { text: label } }],
  }))
  const reviews = () => requests.filter(row => row.path.startsWith('/review/'))
  const toolError = label => requests.find(row => row.command === label && row.retry)
  send(cases[0], 0)
  await waitFor(() => deliveries.length === 1, 'accepted reply')
  for (const [index, label] of cases.slice(1, -1).entries()) {
    send(label, index + 1)
    await waitFor(() => toolError(label), `rejected reply for ${label}`)
    assert.match(JSON.stringify(toolError(label).body), /一致性检查未通过/u)
    assert.equal(deliveries.length, 1)
  }
  send(cases.at(-1), cases.length - 1)
  await waitFor(() => reviews().some(row => row.command === cases.at(-1)), 'in-flight review')
  child.kill('SIGTERM')
  assert.deepEqual(await childExit, [0, null])
  await waitFor(() => aborted, 'review HTTP request cancelled on shutdown')

  assert.deepEqual(reviews().map(row => row.command), cases)
  assert.equal(redirectProbeCount, 0)
  assert.equal(deliveries[0].action, 'send_group_msg')
  assert.equal(deliveries[0].params.group_id, groupId)
  assert.ok(deliveries[0].params.message.some(part => part.type === 'text' && part.data.text === cases[0]))
  for (const { body, auth } of reviews()) {
    assert.equal(auth, `Bearer ${reviewKey}`)
    assert.equal(body.model, 'review-test')
    assert.equal(body.max_tokens, 900)
    assert.equal(body.temperature, 0)
    assert.equal(body.stream, false)
    assert.equal(body.tools, undefined)
    assert.equal(body.tool_choice, undefined)
    assert.deepEqual(body.messages.map(row => row.role), ['system', 'user'])
    assert.ok(JSON.parse(body.messages[1].content).sources.messages.length > 0)
  }
  const mainRequests = requests.filter(row => row.path.startsWith('/main/'))
  assert.ok(mainRequests.every(row => row.body.model === 'main-test' && row.auth === `Bearer ${mainKey}`))
  const ledgerDir = path.join(directory, 'data', config.instance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
  const rows = ledgerText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.filter(row => row.stage === 'character-consistency').map(row => [row.model, row.u.total]),
    Array.from({ length: 3 }, () => ['review-test', 15]))
  assert.equal(rows.filter(row => row.stage === 'api' && row.model === 'review-test' && row.u.total === 15).length, 3)
  for (const location of [log, ledgerText, ...requests.map(row => JSON.stringify(row.body)), JSON.stringify(deliveries)]) {
    assert.ok(!location.includes(reviewKey))
    assert.ok(!location.includes(mainKey))
    assert.ok(!location.includes(upstreamFailure))
  }
})
