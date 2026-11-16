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
import { createGroupMemoryStore, groupMemoryId } from '../dist/backend/modules/memory/infrastructure/groupMemoryStore.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000031, groupId = 310301, authorId = 330049, memberId = 330050
const mainKey = 'standalone-group-main-private-key'
const groupKey = 'standalone-group-extraction-private-key'
const oneBotToken = 'standalone-group-onebot-private-token'
const sourceText = '周末群里统一收集展览素材。'
const factText = '周末群里统一收集展览素材'
const teachingText = '记住绘图组是小吴。'
const target = { account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(groupId) }

async function waitFor(probe, description, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}
function completion(content, total = 23) {
  return JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: total - 5, completion_tokens: 5, total_tokens: total } })
}

async function fixture(t, { instance, enabled = true, backend = true }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-group-memory-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], extractions = [], deliveries = [], memberCalls = [], unexpected = [], fixtureErrors = []
  let reader, child, childExit, websocket, epoch = 0, log = '', completeLog = '', unknownNext = false
  const member = id => ({ group_id: groupId, user_id: id, nickname: id === authorId ? '小林' : id === memberId ? '小吴' : '测试账号',
    card: '', role: 'member' })
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/group/v1/chat/completions') {
        const material = JSON.parse(body.messages[1].content)
        extractions.push({ epoch, auth: request.headers.authorization, body, material })
        const index = material.messages.findIndex(row => row.text === (material.mode === 'teaching' ? teachingText : sourceText))
        const result = index < 0 ? [] : [{ sourceIndex: index + 1, excerpt: material.messages[index].text,
          ...(material.mode === 'teaching'
            ? { kind: 'member_definition', subject: '绘图组', targetUserIds: [String(memberId)] }
            : { kind: 'fact', text: factText }) }]
        response.end(completion(JSON.stringify(result), material.mode === 'teaching' ? 31 : 37))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ epoch, auth: request.headers.authorization, body })
        response.end(completion('已收到这次消息。'))
        return
      }
      unexpected.push(request.url)
      response.writeHead(404).end('{}')
    } catch (error) { fixtureErrors.push(String(error)); response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, connection, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${oneBotToken}`) { connection.destroy(); return }
    sockets.handleUpgrade(request, connection, head, client => sockets.emit('connection', client))
  })
  sockets.on('connection', client => {
    websocket = client
    client.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message))
        let data = {}
        if (action === 'get_login_info') data = { user_id: botId, nickname: '群资料验收账号' }
        else if (action === 'get_group_member_list') {
          memberCalls.push({ epoch, action, params })
          data = [member(authorId), member(memberId), member(botId)]
        } else if (action === 'get_group_member_info') {
          memberCalls.push({ epoch, action, params })
          data = member(Number(params.user_id))
        } else if (action.startsWith('send_')) {
          const messageId = unknownNext ? undefined : 96300 + deliveries.length
          unknownNext = false
          deliveries.push({ epoch, action, params, messageId })
          data = messageId === undefined ? {} : { message_id: messageId }
        } else unexpected.push(action)
        client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data }))
      } catch (error) { fixtureErrors.push(String(error)) }
    })
  })
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (childExit) await childExit
    for (const client of sockets.clients) client.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated group-memory Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const config = {
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-group-main', apiKeyEnv: 'TEST_GROUP_MAIN_KEY' },
    ...(backend ? { groupMemoryExtraction: { baseUrl: `http://127.0.0.1:${port}/group/v1`, name: 'standalone-group-extractor', apiKeyEnv: 'TEST_GROUP_BACKEND_KEY' } } : {}),
    groupMemory: { enabled, groupExtractMinIntervalMinutes: 0, groupExtractMaxBatchMessages: 12 },
    midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, memorySystem: { enabled: false },
    textGroups: [{ connectionId: 'qq-group', conversationId: String(groupId) }],
    connections: [{ id: 'qq-group', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_GROUP_ONEBOT_TOKEN' }],
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false },
      rhythm: { enabled: false }, personProfile: { enabled: false }, turn: { minSendGapMs: 0 }, budget: { dailyCostCny: 0 } },
  }
  async function bind(agentId = 'daily') {
    await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
      version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'work', personaId: 'default' }],
      connections: [{ id: 'qq-group', platform: 'qq', namespace: 'global', accountId: String(botId) }],
      bindings: [{ connectionId: 'qq-group', kind: 'group', conversationId: String(groupId), agentId }],
    }))
  }
  await bind()
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_GROUP_MAIN_KEY: mainKey,
    TEST_GROUP_ONEBOT_TOKEN: oneBotToken, ...(backend ? { TEST_GROUP_BACKEND_KEY: groupKey } : {}) }
  const prefix = `bl-agent:${instance}:`
  const store = createGroupMemoryStore({ get: key => reader.get(prefix + key),
    eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }) })
  async function start() {
    epoch++; log = ''; websocket = undefined
    child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory, env })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    await waitFor(() => {
      if (child.exitCode !== null) assert.fail(`standalone exited before readiness: ${log}`)
      return log.includes('已启动') && websocket
    }, `group-memory process ${epoch} readiness`)
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null], completeLog)
    child = undefined; childExit = undefined
  }
  function send(text, messageId, { directed = false, author = authorId, mentions = [] } = {}) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
      group_id: groupId, user_id: author, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: author, nickname: author === authorId ? '小林' : '小吴' },
      message: [...(directed ? [{ type: 'at', data: { qq: String(botId) } }] : []),
        { type: 'text', data: { text } }, ...mentions.map(id => ({ type: 'at', data: { qq: String(id) } }))],
    }))
  }
  async function ledgerRows() {
    const folder = path.join(directory, 'data', instance, 'token_usage')
    const files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const text = (await Promise.all(files.map(file => readFile(path.join(folder, file), 'utf8')))).join('')
    return { text, rows: text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] }
  }
  function assertClean() {
    assert.deepEqual(fixtureErrors, [])
    assert.deepEqual(unexpected, [])
    for (const output of [completeLog, JSON.stringify(deliveries), ...extractions.map(row => JSON.stringify(row.body)), ...mainRequests.map(row => JSON.stringify(row.body))]) {
      for (const secret of [mainKey, groupKey, oneBotToken]) assert.ok(!output.includes(secret))
    }
  }
  return { start, stop, bind, send, ledgerRows, assertClean, mainRequests, extractions, deliveries, memberCalls,
    state: () => store.load(groupMemoryId(target)), states: () => store.list(), unknownNext() { unknownNext = true } }
}

test('standalone persists human teaching before an unknown reply, learns facts only after confirmed delivery and separates Agent facts across restart', {
  skip: !redisAvailable, timeout: 30000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-group-memory' })
  await run.start()
  run.send(sourceText, 87101)
  await waitFor(async () => (await run.state())?.agents[0]?.records.some(row => row.messageId === '87101'), 'ordinary group source captured')
  assert.equal(run.extractions.length, 0)
  assert.equal(run.mainRequests.length, 0)
  assert.equal(run.memberCalls.length, 0)

  run.unknownNext()
  run.send(teachingText, 87102, { directed: true, mentions: [memberId] })
  const taught = await waitFor(async () => (await run.state())?.entries.find(row => row.subject === '绘图组'), 'explicit human teaching persisted')
  await waitFor(() => run.deliveries.length === 1, 'unknown receipt without message id')
  assert.equal(run.deliveries[0].messageId, undefined)
  assert.equal(taught.kind, 'member_definition')
  assert.deepEqual(taught.targetUserIds, [String(memberId)])
  assert.equal(taught.createdBy, String(authorId))
  assert.equal(taught.source.messageId, '87102')
  assert.equal(taught.persona.personaId, 'agent:daily')
  run.send('送达结果之后的顺序核验。', 87103)
  await waitFor(async () => (await run.state())?.agents[0]?.records.some(row => row.messageId === '87103'), 'unknown delivery inbox barrier')
  assert.ok(run.extractions.every(row => row.material.mode === 'teaching'))
  assert.deepEqual((await run.state()).agents[0].entries, [])
  const firstTeaching = run.extractions[0]
  assert.equal(firstTeaching.auth, `Bearer ${groupKey}`)
  assert.equal(firstTeaching.body.model, 'standalone-group-extractor')
  assert.deepEqual(firstTeaching.body.messages.map(row => row.role), ['system', 'user'])
  assert.equal(firstTeaching.body.tools, undefined)
  assert.deepEqual(firstTeaching.material.members.map(row => row.id).sort(), [String(authorId), String(memberId), String(botId)].sort())
  assert.doesNotMatch(JSON.stringify(firstTeaching.body), /agentId|personaId|connectionId|qq-group|binding|namespace/u)
  assert.ok(run.memberCalls.some(row => row.action === 'get_group_member_list'))
  assert.ok(run.memberCalls.some(row => row.action === 'get_group_member_info' && String(row.params.user_id) === String(authorId)))
  assert.ok(run.memberCalls.some(row => row.action === 'get_group_member_info' && String(row.params.user_id) === String(memberId)))
  assert.ok(run.memberCalls.every(row => String(row.params.group_id) === String(groupId)))
  assert.ok(run.memberCalls.filter(row => row.action === 'get_group_member_info').every(row => row.params.no_cache === true))

  const beforeDuplicate = run.extractions.length
  run.send(teachingText, 87102, { directed: true, mentions: [memberId] })
  run.send('重复入口之后的顺序核验。', 87104)
  await waitFor(async () => (await run.state())?.agents[0]?.records.some(row => row.messageId === '87104'), 'duplicate inbox barrier')
  assert.equal(run.extractions.length, beforeDuplicate)
  assert.equal(run.deliveries.length, 1)
  run.send('请确认素材安排。', 87105, { directed: true })
  const fact = await waitFor(async () => (await run.state())?.agents[0]?.entries.find(row => row.text === factText), 'fact committed after a confirmed reply')
  assert.equal(run.deliveries[1].messageId, 96301)
  assert.equal(fact.kind, 'fact')
  assert.equal(fact.source.messageId, '87101')
  assert.equal(fact.source.authorId, String(authorId))
  assert.equal(fact.persona.personaId, 'agent:daily')
  const consensus = run.extractions.find(row => row.material.mode === 'consensus')
  assert.ok(consensus)
  assert.deepEqual(consensus.material.members, [])
  assert.ok(consensus.material.messages.some(row => row.text === sourceText))
  await run.stop()

  await run.bind('work')
  await run.start()
  const query = '现在的绘图组成员是谁？'
  run.send(query, 87106, { directed: true, author: memberId })
  const workPrompt = await waitFor(() => run.mainRequests.find(row => row.epoch === 2 && row.body.messages.at(-1).content === query), 'different Agent reads shared teaching')
  const knowledge = workPrompt.body.messages.find(row => row.content?.includes('【本群已保存资料】'))
  assert.ok(knowledge?.content.includes('绘图组'))
  assert.ok(knowledge.content.includes(String(memberId)))
  assert.ok(!JSON.stringify(workPrompt.body.messages).includes(factText), 'the new Agent cannot read the previous Agent automatic fact or chat history')
  await waitFor(() => run.deliveries.length === 3, 'post-restart confirmed reply')
  await waitFor(async () => (await run.state())?.agents.find(row => row.agentId === 'work')?.consensusDone.includes('87106'), 'post-restart group extraction completed')
  await run.stop()
  const state = await run.state()
  assert.equal(state.entries[0].id, taught.id)
  assert.equal(state.agents.find(row => row.agentId === 'daily').entries[0].id, fact.id)
  assert.deepEqual(state.agents.find(row => row.agentId === 'work').entries, [])
  assert.ok(run.mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-group-main'))
  const ledger = await run.ledgerRows()
  for (const [mode, stage, total] of [['teaching', 'group-teaching', 31], ['consensus', 'group-memory', 37]]) {
    const count = run.extractions.filter(row => row.material.mode === mode).length
    assert.ok(count > 0)
    assert.equal(ledger.rows.filter(row => row.scope === simulationAddressKey(target) && row.stage === stage && row.model === 'standalone-group-extractor' && row.u.total === total).length, count)
    assert.equal(ledger.rows.filter(row => row.scope === 'global' && row.stage === 'api' && row.model === 'standalone-group-extractor' && row.u.total === total).length, count)
  }
  for (const secret of [mainKey, groupKey, oneBotToken]) assert.ok(!ledger.text.includes(secret))
  run.assertClean()
})

test('standalone group learning stays off without its switch or explicit backend and never falls back to the main model', {
  skip: !redisAvailable, timeout: 20000,
}, async t => {
  const runs = await Promise.all([
    fixture(t, { instance: 'standalone-group-disabled', enabled: false }),
    fixture(t, { instance: 'standalone-group-backend-omitted', backend: false }),
  ])
  await Promise.all(runs.map(async run => {
    await run.start()
    run.send(sourceText, 87201)
    run.send(teachingText, 87202, { directed: true, mentions: [memberId] })
    await waitFor(() => run.deliveries.length === 1, 'ordinary reply with group learning unavailable')
    await run.stop()
    assert.equal(run.extractions.length, 0)
    assert.equal(run.memberCalls.length, 0)
    assert.equal(run.mainRequests.length, 1)
    assert.equal(run.mainRequests[0].body.model, 'standalone-group-main')
    assert.deepEqual(await run.states(), [])
    const ledger = await run.ledgerRows()
    assert.equal(ledger.rows.filter(row => ['group-memory', 'group-teaching'].includes(row.stage)).length, 0)
    run.assertClean()
  }))
})
