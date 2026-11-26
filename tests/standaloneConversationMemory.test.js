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
import { agentHostModuleUrl, importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createConversationMemoryStore }, { simulationAddressKey }, { simulationSessionKey, SIMULATION_OVERRIDES_KEY }] = await Promise.all([
  load('modules/memory/infrastructure/conversationMemoryStore.js'), load('modules/simulation/infrastructure/simulationAddress.js'),
  load('modules/simulation/infrastructure/simSessionStore.js'),
])

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const sourceLoader = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
function cliArgs(args) {
  return process.env.BL_CHAT_AGENT_SOURCE_TEST === '1' ? ['--import', sourceLoader, '--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(agentHostModuleUrl('bootstrap/standaloneAgent.js').href)}); await main(process.argv.slice(1))`, '--', ...args] : [entry, ...args]
}
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000021, groupId = 310201, userId = 330039
const mainKey = 'standalone-summary-main-private-key'
const summaryKey = 'standalone-summary-backend-private-key'
const oneBotToken = 'standalone-summary-onebot-private-token'
const digest = '周末展览正在筹备：小林负责折叠桌，小吴准备白色海报，大家等待确认场地。'
const sourceTexts = ['周末展览安排在周六下午。', '小林负责准备折叠桌。', '小吴负责制作白色海报。', '场地还在等社区确认。']
const unknownProbe = '请确认下一步安排。'
const confirmedProbe = '折叠桌和白色海报已经列在物资清单。'
const unknownReply = '下一步的接驳口令是蓝鲸九号。'
const confirmedReply = '物资清单里有折叠桌和白色海报。'
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

function completion(content, usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return JSON.stringify({ choices: [{ message: { content } }], usage })
}
function wakeContains(body, text) {
  return body.messages.some(row => row.role === 'user' && typeof row.content === 'string' &&
    row.content.includes('【唤醒原因】') && row.content.includes(text))
}
function finishReply(text, callId) {
  const args = text ? { choice: 'chat', reason: '回复当前群消息', messages: [text] } : { choice: 'silent', reason: '本次回复已尝试' }
  return JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
    { id: callId, type: 'function', function: { name: 'simFinishTurn', arguments: JSON.stringify(args) } },
  ] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
}

async function fixture(t, { instance, backend = true, enabled = true, cleanup = false, startupTimeoutMs = 8000 }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-conversation-memory-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], summaries = [], deliveries = [], fixtureErrors = [], unexpected = []
  let reader, child, childExit, websocket, epoch = 0, log = '', completeLog = '', unknownNext = false
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/summary/v1/chat/completions') {
        summaries.push({ epoch, at: Date.now(), auth: request.headers.authorization, body })
        response.end(completion(digest, { prompt_tokens: 26, completion_tokens: 11, total_tokens: 37 }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ epoch, auth: request.headers.authorization, body })
        assert.ok(body.tools?.some(tool => tool.function?.name === 'simFinishTurn'))
        const attempted = body.messages.some(row => row.role === 'tool')
        const reply = attempted ? undefined : wakeContains(body, confirmedProbe) ? confirmedReply :
          wakeContains(body, unknownProbe) ? unknownReply : '嗯，安排已经收到。'
        response.end(finishReply(reply, `summary-finish-${mainRequests.length}`))
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
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${oneBotToken}`) { connection.destroy(); return }
    sockets.handleUpgrade(request, connection, head, client => sockets.emit('connection', client))
  })
  sockets.on('connection', client => {
    websocket = client
    client.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message))
        let data = {}
        if (action === 'get_login_info') data = { user_id: botId, nickname: '会话主线验收账号' }
        else if (action.startsWith('send_')) {
          const messageId = unknownNext ? undefined : 95200 + deliveries.length
          unknownNext = false
          deliveries.push({ epoch, action, params, messageId })
          data = messageId === undefined ? {} : { message_id: messageId }
        }
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
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated conversation-memory Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const config = {
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-summary-main', apiKeyEnv: 'TEST_SUMMARY_MAIN_KEY' },
    ...(backend ? { midtermSummary: { baseUrl: `http://127.0.0.1:${port}/summary/v1`, name: 'standalone-summary-backend', apiKeyEnv: 'TEST_SUMMARY_BACKEND_KEY' } } : {}),
    midtermMemory: { enabled, minMessages: 4, debounceMs: 5000, maxSummaryChars: 500 },
    episodicMemory: { enabled: true, proactiveEnabled: true },
    textGroups: [groupId, ...(cleanup ? [groupId + 1] : [])].map(id => ({ connectionId: 'qq-summary', conversationId: String(id) })),
    connections: [{ id: 'qq-summary', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_SUMMARY_ONEBOT_TOKEN' }],
    simulation: { wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, wakeGate: { enabled: false }, reflection: { enabled: false },
      rhythm: { enabled: false }, personProfile: { enabled: false }, turn: { minSendGapMs: 0 }, budget: { dailyCostCny: 0 } },
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-summary', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [groupId, ...(cleanup ? [groupId + 1] : [])].map(id => ({ connectionId: 'qq-summary', kind: 'group', conversationId: String(id), agentId: 'daily' })),
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_SUMMARY_MAIN_KEY: mainKey,
    TEST_SUMMARY_ONEBOT_TOKEN: oneBotToken, ...(backend ? { TEST_SUMMARY_BACKEND_KEY: summaryKey } : {}) }
  const prefix = `bl-agent:${instance}:`
  const memory = createConversationMemoryStore({
    get: key => reader.get(prefix + key),
    eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }),
  })
  async function state() { return (await memory.list()).find(row => row.scope.target.id === String(groupId)) }
  async function rawStates() {
    const keys = await reader.keys(`${prefix}agent:conversation-memory:v1:state:*`)
    const values = await Promise.all(keys.map(async key => JSON.parse(await reader.get(key))))
    return values.sort((left, right) => left.id.localeCompare(right.id))
  }
  async function start() {
    epoch++; log = ''; websocket = undefined
    child = spawn(process.execPath, cliArgs(['--config', configFile]), { cwd: directory, env })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    try {
      await waitFor(() => {
        if (child.exitCode !== null) assert.fail(`standalone exited before readiness: ${log}`)
        return log.includes('已启动') && websocket
      }, `conversation-memory process ${epoch} readiness`, startupTimeoutMs)
    } catch (error) { assert.fail(`${error.message}; process exit=${child.exitCode}; output=${log}`) }
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null], completeLog)
    child = undefined; childExit = undefined
  }
  function send(text, messageId, { directed = false, authorId = userId, group = groupId } = {}) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
      group_id: group, user_id: authorId, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: authorId, nickname: authorId === userId ? '小林' : '小吴' },
      message: [...(directed ? [{ type: 'at', data: { qq: String(botId) } }] : []), { type: 'text', data: { text } }],
    }))
  }
  function sendPrivate(text, messageId) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: botId,
      user_id: userId, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname: '小林' }, message: [{ type: 'text', data: { text } }],
    }))
  }
  async function disableForPrivateCleanup() {
    assert.equal(child, undefined, 'change only a stopped fixture')
    const host = JSON.parse(await readFile(configFile, 'utf8'))
    host.midtermMemory.enabled = false
    host.episodicMemory.enabled = false
    delete host.midtermSummary
    delete env.TEST_SUMMARY_BACKEND_KEY
    host.privateChat = { enabled: true }
    host.textGroups = host.textGroups.filter(row => row.conversationId !== String(groupId))
    await writeFile(configFile, JSON.stringify(host))
    const file = path.join(directory, 'agent-bindings.yaml'), bindings = JSON.parse(await readFile(file, 'utf8'))
    bindings.bindings = bindings.bindings.filter(row => row.conversationId !== String(groupId))
    bindings.bindings.push({ connectionId: 'qq-summary', kind: 'private', conversationId: String(userId), agentId: 'daily' })
    await writeFile(file, JSON.stringify(bindings))
  }
  async function resumeWithSessionWake(messageId) {
    assert.equal(child, undefined, 'stage the durable wake in the stopped fixture')
    const group = simulationAddressKey(target), key = prefix + simulationSessionKey(group)
    const saved = JSON.parse(await reader.get(key))
    const source = saved.recent.find(row => row.messageId === String(messageId))
    assert.ok(source)
    await reader.multi().set(prefix + SIMULATION_OVERRIDES_KEY, JSON.stringify({ proactive: { [group]: true } }))
      .set(key, JSON.stringify({ ...saved, unread: [source], recent: [source], lastReadThroughSeq: source.seq - 1,
        queuedIngressWake: { kind: 'session', seq: source.seq } })).exec()
  }
  async function feedSources() {
    for (const [index, text] of sourceTexts.entries()) send(text, 86101 + index)
    return await waitFor(async () => {
      const saved = await state()
      return saved?.records.length === 4 && saved
    }, 'four real group utterances captured')
  }
  async function check() {
    const checking = spawn(process.execPath, cliArgs(['--config', configFile, '--check']), { cwd: directory, env })
    const exited = once(checking, 'exit')
    const timer = setTimeout(() => checking.kill('SIGKILL'), 8000)
    let output = '', error = ''
    checking.stdout.on('data', chunk => { output += chunk })
    checking.stderr.on('data', chunk => { error += chunk })
    try {
      assert.deepEqual(await exited, [0, null], error)
      return JSON.parse(output.trim().split('\n').at(-1))
    } finally { clearTimeout(timer) }
  }
  async function ledgerRows() {
    const directoryName = path.join(directory, 'data', instance, 'token_usage')
    const files = await readdir(directoryName).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const text = (await Promise.all(files.map(file => readFile(path.join(directoryName, file), 'utf8')))).join('')
    return { text, rows: text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] }
  }
  function assertClean() {
    assert.deepEqual(fixtureErrors, [])
    assert.deepEqual(unexpected, [])
    for (const output of [completeLog, JSON.stringify(deliveries), ...summaries.map(row => JSON.stringify(row.body)), ...mainRequests.map(row => JSON.stringify(row.body))]) {
      for (const secret of [mainKey, summaryKey, oneBotToken]) assert.ok(!output.includes(secret))
    }
  }
  return { start, stop, send, sendPrivate, disableForPrivateCleanup, rawStates,
    diagnostics() { return { log: completeLog, summaries: summaries.length, mainRequests: mainRequests.length, errors: fixtureErrors } },
    async rawCatalog() { return JSON.parse(await reader.get(`${prefix}agent:conversation-memory:v1:catalog`)) },
    feedSources, resumeWithSessionWake, state, check, ledgerRows, assertClean, mainRequests, summaries, deliveries,
    unknownNext() { unknownNext = true } }
}

test('standalone uses its summary service after a real debounce, injects the result and recalls only confirmed episodes across restart', {
  skip: !redisAvailable, timeout: 35000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-conversation-memory' })
  await run.start()
  const pending = await run.feedSources()
  assert.ok(pending.dueAt > Date.now())
  assert.equal(run.mainRequests.length, 0, 'ordinary group utterances are captured without a reply model call')
  const summaryRequest = await waitFor(() => run.summaries[0], 'dedicated summary request after five seconds', 10000)
  assert.ok(summaryRequest.at >= pending.dueAt, 'the summary waits for the real five second debounce')
  await waitFor(async () => (await run.state())?.summary?.text === digest, 'summary persisted')
  assert.equal(run.summaries.length, 1)
  assert.equal(summaryRequest.auth, `Bearer ${summaryKey}`)
  assert.equal(summaryRequest.body.model, 'standalone-summary-backend')
  assert.equal(summaryRequest.body.tools, undefined)
  assert.deepEqual(summaryRequest.body.messages.map(row => row.role), ['system', 'user'])
  const material = JSON.parse(summaryRequest.body.messages[1].content)
  assert.equal(material.previous, '')
  assert.equal(material.maxChars, 500)
  assert.deepEqual(material.messages.map(row => row.text), sourceTexts)
  assert.ok(material.messages.every(row => row.authorId === String(userId)))
  assert.doesNotMatch(JSON.stringify(summaryRequest.body), /agentId|personaId|connectionId|qq-summary|binding|namespace/u)

  run.unknownNext()
  run.send(unknownProbe, 86105, { directed: true })
  const ordinaryRequest = await waitFor(() => run.mainRequests.find(row => wakeContains(row.body, unknownProbe)), 'ordinary group prompt after summarization')
  assert.ok(!ordinaryRequest.body.messages.some(row => row.content?.includes('【近期群聊主线】')),
    'a directed turn keeps the context of its own source')
  await waitFor(() => run.deliveries.length === 1, 'unknown OneBot delivery without message id')
  assert.equal(run.deliveries[0].messageId, undefined)
  // A following real inbox item proves the preceding unknown delivery has completed.
  const recall = '上次物资清单里提到了什么？'
  run.send(recall, 86106, { authorId: userId + 1 })
  await waitFor(async () => (await run.state())?.records.some(row => row.messageId === '86106'), 'post-delivery inbox barrier')
  assert.deepEqual((await run.state()).episodes, [], 'no episode is created from an unknown delivery')

  run.send(confirmedProbe, 86107, { directed: true })
  const confirmed = await waitFor(async () => (await run.state())?.episodes.find(row => row.messageIds.includes('86107')), 'confirmed episode persisted')
  assert.equal(confirmed.reply, confirmedReply)
  assert.deepEqual(confirmed.replyIds, [String(run.deliveries[1].messageId)])
  assert.equal(confirmed.source.botId, String(botId))
  assert.equal(confirmed.source.personaId, 'agent:daily')
  await run.stop()
  await run.resumeWithSessionWake(86106)
  await run.start()
  assert.equal((await run.state()).summary.text, digest)
  assert.equal((await run.state()).episodes[0].id, confirmed.id)
  const recalled = await waitFor(() => run.mainRequests.find(row => row.epoch === 2 && wakeContains(row.body, recall)), 'restored session wake recalls confirmed history')
  assert.ok(recalled.body.messages.some(row => row.content?.includes('【近期群聊主线】') && row.content.includes(digest)))
  const episodeSection = recalled.body.messages.find(row => row.content?.includes('【近期情节】'))
  assert.ok(episodeSection?.content.includes(confirmedReply), 'the session wake receives the persisted confirmed episode')
  assert.ok(!JSON.stringify(recalled.body.messages).includes(unknownReply))
  await waitFor(() => run.deliveries.length === 3, 'post-restart reply')
  await run.stop()
  assert.equal(run.summaries.length, 1)
  assert.ok(run.mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-summary-main'))
  const ledger = await run.ledgerRows()
  assert.deepEqual(ledger.rows.filter(row => row.stage === 'midterm-summary').map(row => [row.scope, row.model, row.u.total]),
    [[simulationAddressKey(target), 'standalone-summary-backend', 37]])
  assert.equal(ledger.rows.filter(row => row.scope === 'global' && row.stage === 'api' && row.model === 'standalone-summary-backend' && row.u.total === 37).length, 1)
  for (const secret of [mainKey, summaryKey, oneBotToken]) assert.ok(!ledger.text.includes(secret))
  run.assertClean()
})

test('standalone keeps local episodes when summary is disabled or its backend is omitted and never summarizes with the main model', {
  skip: !redisAvailable, timeout: 25000,
}, async t => {
  const runs = await Promise.all([
    fixture(t, { instance: 'standalone-summary-disabled', enabled: false }),
    fixture(t, { instance: 'standalone-summary-omitted', backend: false }),
  ])
  await Promise.all(runs.map(async run => {
    await run.start()
    const state = await run.feedSources()
    assert.equal(state.dueAt, 0)
    await delay(6500)
    assert.equal(run.summaries.length, 0)
    assert.equal(run.mainRequests.length, 0, 'no summary request falls back to the main model')
    assert.equal((await run.state()).summary, undefined)
    run.send(confirmedProbe, 86107, { directed: true })
    await waitFor(async () => (await run.state())?.episodes.some(row => row.messageIds.includes('86107') && row.reply === confirmedReply), 'local episode without a summary backend')
    assert.equal(run.mainRequests.length, 1)
    assert.ok(wakeContains(run.mainRequests[0].body, confirmedProbe))
    assert.ok(!run.mainRequests[0].body.messages.some(row => row.content?.includes('【近期群聊主线】')))
    await run.stop()
    assert.equal((await run.ledgerRows()).rows.filter(row => row.stage === 'midterm-summary').length, 0)
    run.assertClean()
  }))
})

test('standalone --check verifies connections without executing an already due summary', {
  skip: !redisAvailable, timeout: 25000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-summary-check' })
  await run.start()
  const pending = await run.feedSources()
  await run.stop()
  assert.equal(run.summaries.length, 0)
  await delay(Math.max(0, pending.dueAt - Date.now() + 100))
  const before = await run.state()
  assert.ok(before.dueAt <= Date.now())
  const checked = await run.check()
  assert.equal(checked.mode, 'check')
  assert.equal(checked.redis, 'reachable')
  assert.equal(checked.connections[0].loginVerified, true)
  assert.equal(run.summaries.length, 0)
  assert.equal(run.mainRequests.length, 0)
  assert.deepEqual(await run.state(), before, 'readiness checks do not consume or rewrite pending summary work')
  run.assertClean()
})

test('standalone private forgetting physically deletes disabled conversation records and mixed aggregates from an unbound group across restart', {
  skip: !redisAvailable, timeout: 150000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-conversation-forgetting', cleanup: true, startupTimeoutMs: 45000 })
  await run.start()
  await run.feedSources()
  try { await waitFor(async () => (await run.state())?.summary?.text === digest, 'real summary before cleanup', 12000) }
  catch (error) { assert.fail(`${error.message}; ${JSON.stringify({ ...run.diagnostics(), states: await run.rawStates() })}`) }
  run.send('小林之前在另一场景分享了绿色场地口令。', 86301, { group: groupId + 1 })
  run.send(confirmedProbe, 86302, { group: groupId + 1, directed: true, authorId: userId + 1 })
  const before = await waitFor(async () => {
    const states = await run.rawStates(), mixed = states.find(state => state.scope.target.id === String(groupId + 1))
    return states.length === 2 && mixed?.records.length === 2 && mixed.episodes.length === 1 && states
  }, 'mixed-author raw state and a confirmed episode')
  const mixed = before.find(state => state.scope.target.id === String(groupId + 1))
  assert.equal(mixed.episodes[0].userId, String(userId + 1), 'an episode responder is not proof that no earlier author contributed')
  const retained = mixed.records.filter(row => row.authorId === String(userId + 1))
  assert.equal(retained.length, 1)
  await run.stop()
  await run.disableForPrivateCleanup()
  const summaryCalls = run.summaries.length, mainCalls = run.mainRequests.length
  await run.start()
  assert.deepEqual(await run.rawStates(), before, 'disabled and unbound state remains present until an authorized command')
  run.sendPrivate('#清空我的记忆', 86303)
  await waitFor(() => run.deliveries.some(row => row.epoch === 2 && row.action === 'send_private_msg' && Number(row.params.user_id) === userId),
    'private forgetting confirmation')
  const after = await waitFor(async () => {
    const states = await run.rawStates()
    return states.length === 1 && states[0].scope.target.id === String(groupId + 1) &&
      states[0].records.length === 1 && states[0].records[0].authorId === String(userId + 1) &&
      !states[0].summary && states[0].episodes.length === 0 && states
  }, 'raw Redis deletion of the forgotten author and all old aggregates')
  assert.deepEqual(after[0].records, retained, 'the other author original stays byte-for-byte equivalent')
  assert.deepEqual((await run.rawCatalog()).ids, [after[0].id], 'the empty unbound state and catalog entry are retired')
  assert.ok(!JSON.stringify(after).includes(digest))
  assert.ok(!JSON.stringify(after).includes(confirmedReply))
  await run.stop()
  await run.start()
  assert.deepEqual(await run.rawStates(), after, 'restart cannot restore the erased raw records, summary or episode')
  assert.equal(run.summaries.length, summaryCalls, 'cleanup does not call a disabled or absent summary provider')
  assert.equal(run.mainRequests.length, mainCalls, 'the privacy command does not call the main model')
  await run.stop()
  run.assertClean()
})
