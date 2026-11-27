import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import { agentHostModuleUrl } from './helpers/bilibiliQualitySource.mjs'
import { readPersistedSemanticState } from './helpers/semanticMemoryStorage.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const sourceLoader = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
const [{ simulationAddressKey }, { simulationSessionKey, SIMULATION_OVERRIDES_KEY }] = await Promise.all([
  import(agentHostModuleUrl('modules/simulation/infrastructure/simulationAddress.js').href),
  import(agentHostModuleUrl('modules/simulation/infrastructure/simSessionStore.js').href),
])
function cliArgs(args) {
  return process.env.BL_CHAT_AGENT_SOURCE_TEST === '1' ? ['--import', sourceLoader, '--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(agentHostModuleUrl('bootstrap/standaloneAgent.js').href)}); await main(process.argv.slice(1))`, '--', ...args] : [entry, ...args]
}
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000051, groupId = 310501, otherGroupId = 310502, authorId = 330059
const mainKey = 'standalone-semantic-main-private-key'
const embeddingKey = 'standalone-semantic-embedding-private-key'
const rerankKey = 'standalone-semantic-rerank-private-key'
const oneBotToken = 'standalone-semantic-onebot-private-token'
const source = '小林周六下午去攀岩馆练习抱石。'
const distractor = '小吴决定星期日到美术馆看油画。'
const otherGroupSource = '另一个群确认绿松石密令只在那里使用。'
const quotedText = '转述中的紫鹭座标来自别人的话。'
const ownQuoteText = '这里是自己的简短回应。'
const forwardedText = '这是从另一位发言者转来的文字。'
const barrierText = '本次合成测试的收尾消息。'
const query = '休息日谁会参加室内登高运动？'
const reply = '已根据可见资料回答。'

async function waitFor(probe, description, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}
function completion(content) {
  return JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
    { id: 'semantic-finish', type: 'function', function: { name: 'simFinishTurn',
      arguments: JSON.stringify({ choice: 'chat', reason: '回复当前群消息', messages: [content] }) } },
  ] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
}
function vector(text) {
  if ([source, query, otherGroupSource].includes(text)) return [1, 0, 0]
  if (text === distractor) return [0.8, 0.6, 0]
  return [0, 1, 0]
}

async function fixture(t, { instance, enabled = true }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-semantic-memory-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], embeddings = [], rerankings = [], deliveries = [], fixtureErrors = [], unexpected = []
  let reader, child, childExit, websocket, epoch = 0, log = '', completeLog = ''
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      const received = { epoch, method: request.method, auth: request.headers.authorization, body }
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/embedding/custom/embeddings') {
        embeddings.push(received)
        response.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })) }))
        return
      }
      if (request.url === '/ranking/independent/rerank') {
        rerankings.push(received)
        response.end(JSON.stringify({ results: body.documents.map((text, index) => ({ index,
          relevance_score: text === source ? 0.99 : text === distractor ? 0.4 : 0.1 })) }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push(received)
        response.end(completion(reply))
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
        if (action === 'get_login_info') data = { user_id: botId, nickname: '语义历史合成验收账号' }
        else if (action === 'get_msg' && Number(params.message_id) === 88000) {
          data = { self_id: botId, message_type: 'group', group_id: groupId, message_id: 88000,
            time: Math.floor(Date.now() / 1000) - 60, sender: { user_id: authorId + 100, nickname: '被引用的发言者' },
            message: [{ type: 'text', data: { text: quotedText } }] }
        } else if (action.startsWith('send_')) {
          const messageId = 97400 + deliveries.length
          deliveries.push({ epoch, action, params, messageId })
          data = { message_id: messageId }
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
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated semantic-memory Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-semantic-main', apiKeyEnv: 'TEST_SEMANTIC_MAIN_KEY' },
    semanticMemory: { enabled, maxMessagesPerConversation: 50, topK: 1, minScore: 0.35, timeoutMs: 5000,
      embedding: { baseUrl: `http://127.0.0.1:${port}/embedding/custom/embeddings`, name: 'standalone-semantic-vector', apiKeyEnv: 'TEST_SEMANTIC_EMBEDDING_KEY' },
      rerank: { baseUrl: `http://127.0.0.1:${port}/ranking/independent/rerank`, name: 'standalone-semantic-rank', apiKeyEnv: 'TEST_SEMANTIC_RERANK_KEY' },
    },
    midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, memorySystem: { enabled: false }, groupMemory: { enabled: false },
    textGroups: [groupId, otherGroupId].map(id => ({ connectionId: 'qq-semantic', conversationId: String(id) })),
    connections: [{ id: 'qq-semantic', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_SEMANTIC_ONEBOT_TOKEN' }],
    simulation: { wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, wakeGate: { enabled: false },
      reflection: { enabled: false }, rhythm: { enabled: false },
      personProfile: { enabled: false }, turn: { minSendGapMs: 0 }, budget: { dailyCostCny: 0 } },
  }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-semantic', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [groupId, otherGroupId].map(id => ({ connectionId: 'qq-semantic', kind: 'group', conversationId: String(id), agentId: 'daily' })),
  }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_SEMANTIC_MAIN_KEY: mainKey,
    TEST_SEMANTIC_ONEBOT_TOKEN: oneBotToken,
    ...(enabled ? { TEST_SEMANTIC_EMBEDDING_KEY: embeddingKey, TEST_SEMANTIC_RERANK_KEY: rerankKey } : {}) }
  // Disabled fixtures deliberately have no semantic-service credentials.
  if (!enabled) { delete env.TEST_SEMANTIC_EMBEDDING_KEY; delete env.TEST_SEMANTIC_RERANK_KEY }
  const prefix = `bl-agent:${instance}:`
  const groupAddress = simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(botId) },
    kind: 'group', id: String(groupId) })
  const sessionKey = prefix + simulationSessionKey(groupAddress)
  const session = async () => JSON.parse(await reader.get(sessionKey) ?? 'null')
  async function resumeWithUnreadQuery(messageId) {
    assert.equal(child, undefined, 'stage a durable wake in the stopped fixture')
    const saved = await session()
    const unread = saved?.unread?.find(row => row.messageId === String(messageId))
    assert.ok(unread)
    // Model a restored session with the older messages already read.
    await reader.multi().set(prefix + SIMULATION_OVERRIDES_KEY, JSON.stringify({ proactive: { [groupAddress]: true } }))
      .set(sessionKey, JSON.stringify({ ...saved, unread: [unread], recent: [unread], lastReadThroughSeq: unread.seq - 1,
        queuedIngressWake: { kind: 'session', seq: unread.seq } })).exec()
  }
  async function states() {
    const keys = await reader.keys(`${prefix}agent:semantic-memory:v1:state:*`)
    return (await Promise.all(keys.map(key => readPersistedSemanticState(reader, prefix, key.split(':').at(-1))))).filter(Boolean)
  }
  async function state(id = groupId) { return (await states()).find(row => row.scope.target.id === String(id)) }
  async function start() {
    epoch++; log = ''; websocket = undefined
    child = spawn(process.execPath, cliArgs(['--config', configFile]), { cwd: directory, env })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    await waitFor(() => {
      if (child.exitCode !== null) assert.fail(`standalone exited before readiness: ${log}`)
      return log.includes('已启动') && websocket
    }, `semantic-memory process ${epoch} readiness`)
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null], completeLog)
    child = undefined; childExit = undefined
  }
  function send(text, messageId, { directed = false, group = groupId, author = authorId, segments = [], source: quoted } = {}) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
      group_id: group, user_id: author, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: author, nickname: '合成发言者' },
      message: [...(directed ? [{ type: 'at', data: { qq: String(botId) } }] : []), ...segments, { type: 'text', data: { text } }],
      ...(quoted ? { source: quoted } : {}),
    }))
  }
  function sources() {
    send(source, 88101)
    send(distractor, 88102)
    send(otherGroupSource, 88103, { group: otherGroupId })
    send(ownQuoteText, 88104, { segments: [{ type: 'reply', data: { id: '88000' } }],
      source: { message_id: 88000, user_id: authorId + 100, text: quotedText, message: [{ type: 'text', data: { text: quotedText } }] } })
    send(forwardedText, 88105, { segments: [{ type: 'forward', data: { id: 'synthetic-forward' } }] })
    send(barrierText, 88106)
  }
  async function disableForPrivateCleanup() {
    assert.equal(child, undefined, 'change only a stopped fixture')
    const host = JSON.parse(await readFile(configFile, 'utf8'))
    host.semanticMemory.enabled = false
    host.privateChat = { enabled: true }
    host.textGroups = host.textGroups.filter(row => row.conversationId !== String(groupId))
    await writeFile(configFile, JSON.stringify(host))
    delete env.TEST_SEMANTIC_EMBEDDING_KEY
    delete env.TEST_SEMANTIC_RERANK_KEY
    const bindingFile = path.join(directory, 'agent-bindings.yaml')
    const configured = JSON.parse(await readFile(bindingFile, 'utf8'))
    configured.bindings = configured.bindings.filter(row => row.conversationId !== String(groupId))
    configured.bindings.push({ connectionId: 'qq-semantic', kind: 'private', conversationId: String(authorId), agentId: 'daily' })
    await writeFile(bindingFile, JSON.stringify(configured))
  }
  function sendPrivate(text, messageId) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: botId,
      user_id: authorId, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: authorId, nickname: '合成发言者' }, message: [{ type: 'text', data: { text } }],
    }))
  }
  async function check() {
    const checking = spawn(process.execPath, cliArgs(['--config', configFile, '--check']), { cwd: directory, env })
    const exited = once(checking, 'exit')
    const timer = setTimeout(() => checking.kill('SIGKILL'), 8000)
    let output = '', error = ''
    checking.stdout.on('data', chunk => { output += chunk })
    checking.stderr.on('data', chunk => { error += chunk })
    try { assert.deepEqual(await exited, [0, null], error); return JSON.parse(output.trim().split('\n').at(-1)) }
    finally { clearTimeout(timer) }
  }
  function assertClean() {
    assert.deepEqual(fixtureErrors, [])
    assert.deepEqual(unexpected, [])
    for (const output of [completeLog, JSON.stringify(deliveries), ...mainRequests.map(row => JSON.stringify(row.body)),
      ...embeddings.map(row => JSON.stringify(row.body)), ...rerankings.map(row => JSON.stringify(row.body))]) {
      for (const secret of [mainKey, embeddingKey, rerankKey, oneBotToken]) assert.ok(!output.includes(secret))
    }
  }
  return { start, stop, send, sendPrivate, disableForPrivateCleanup, sources, state, states, check, session, resumeWithUnreadQuery,
    assertClean, mainRequests, embeddings, rerankings, deliveries,
    async catalog() { return JSON.parse(await reader.get(`${prefix}agent:semantic-memory:v1:catalog`) || '{"version":1,"entries":[]}') },
    diagnostics: async () => JSON.stringify({ entry, keys: await reader.keys(`${prefix}*`), states: await states(), inputs: embeddings.map(row => row.body.input), log: completeLog }) }
}

test('standalone CLI indexes undirected originals, preserves quote/forward attribution and recalls same-group semantic history after restart', {
  skip: !redisAvailable, timeout: 30000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-semantic-memory' })
  const checked = await run.check()
  assert.equal(checked.mode, 'check')
  assert.equal(checked.redis, 'reachable')
  assert.equal(checked.connections[0].loginVerified, true)
  assert.deepEqual(await run.states(), [])
  assert.equal(run.embeddings.length + run.rerankings.length + run.mainRequests.length, 0, '--check performs no provider work')
  await run.start()
  run.sources()
  const indexed = await waitFor(async () => {
    const current = await run.state(), other = await run.state(otherGroupId)
    return current?.rows.length === 4 && other?.rows.length === 1 &&
      [...current.rows, ...other.rows].every(row => row.vector?.length === 3) && current
  }, 'undirected originals and own quote response indexed without a reply', 12000).catch(async error => {
    throw new Error(`${error.message}; ${await run.diagnostics()}`)
  })
  assert.equal(run.mainRequests.length, 0)
  assert.equal(run.deliveries.length, 0)
  assert.deepEqual(indexed.rows.map(row => row.text), [source, distractor, ownQuoteText, barrierText])
  assert.ok(indexed.rows.every(row => row.authorId === String(authorId) && /^[a-f0-9]{64}$/u.test(row.providerId)))
  assert.equal(indexed.scope.target.id, String(groupId))
  assert.ok(!JSON.stringify(await run.states()).includes(quotedText))
  assert.ok(!JSON.stringify(await run.states()).includes(forwardedText))
  assert.ok(run.embeddings.length > 0)
  assert.ok(run.embeddings.every(row => row.method === 'POST' && row.auth === `Bearer ${embeddingKey}` && row.body.model === 'standalone-semantic-vector'))
  for (const request of run.embeddings) {
    assert.deepEqual(Object.keys(request.body).sort(), ['input', 'model'])
    assert.doesNotMatch(JSON.stringify(request.body), /agentId|personaId|connectionId|namespace|合成发言者/u)
  }
  run.send(query, 88107, { author: authorId + 1 })
  await waitFor(async () => (await run.session())?.unread?.some(row => row.messageId === '88107'), 'unread recall query persisted')
  await run.stop()
  await run.resumeWithUnreadQuery(88107)
  await run.start()
  assert.deepEqual((await run.state()).rows.slice(0, indexed.rows.length), indexed.rows, 'restart loads the same persisted source vectors')
  const bigrams = text => new Set([...text.replace(/[。？]/gu, '')].slice(1).map((_char, index) => text.slice(index, index + 2)))
  assert.deepEqual([...bigrams(source)].filter(term => bigrams(query).has(term)), [], 'query shares no lexical bigrams with the desired historical sentence')
  const requested = await waitFor(() => run.mainRequests.find(row => row.epoch === 2 &&
    row.body.messages.some(message => message.role === 'user' && message.content?.includes(query))), 'post-restart semantic recall in the main prompt')
  const section = requested.body.messages.find(row => row.content?.includes('【相关历史原文】'))
  assert.ok(section?.content.includes(source), 'the main model receives the original sentence for a synonym-only query')
  for (const excluded of [distractor, otherGroupSource, quotedText, forwardedText]) assert.ok(!JSON.stringify(requested.body.messages).includes(excluded))
  assert.ok(run.embeddings.some(row => row.epoch === 2 && row.body.input.includes(query)))
  const ranked = run.rerankings.find(row => row.epoch === 2 && row.body.query === query)
  assert.ok(ranked, 'explicit independent reranking endpoint receives an actual POST')
  assert.equal(ranked.method, 'POST')
  assert.equal(ranked.auth, `Bearer ${rerankKey}`)
  assert.equal(ranked.body.model, 'standalone-semantic-rank')
  assert.ok(ranked.body.documents.includes(source) && ranked.body.documents.includes(distractor))
  assert.ok(!ranked.body.documents.includes(otherGroupSource))
  assert.deepEqual(Object.keys(ranked.body).sort(), ['documents', 'model', 'query', 'top_n'])
  await waitFor(() => run.deliveries.length === 1, 'one confirmed same-group reply')
  assert.equal(run.deliveries[0].action, 'send_group_msg')
  assert.equal(run.deliveries[0].params.group_id, groupId)
  assert.ok(run.deliveries[0].params.message.some(segment => segment.type === 'text' && segment.data.text === reply))
  assert.ok(run.mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-semantic-main'))
  await run.stop()
  run.assertClean()
})

test('standalone disabled semantic memory and --check need no semantic credentials and never contact providers', {
  skip: !redisAvailable, timeout: 20000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-semantic-disabled', enabled: false })
  const checked = await run.check()
  assert.equal(checked.mode, 'check')
  assert.equal(checked.connections[0].loginVerified, true)
  await run.start()
  run.sources()
  run.send(query, 88107, { directed: true, author: authorId + 1 })
  const requested = await waitFor(() => run.mainRequests.find(row =>
    row.body.messages.some(message => message.role === 'user' && message.content?.includes(query))), 'ordinary reply while semantic memory is disabled')
  await waitFor(() => run.deliveries.length === 1, 'disabled semantic memory ordinary delivery')
  assert.ok(!requested.body.messages.some(row => row.content?.includes('【相关历史原文】')))
  assert.ok(!JSON.stringify(requested.body.messages).includes(source))
  await delay(1200)
  assert.deepEqual(await run.states(), [])
  assert.equal(run.embeddings.length, 0)
  assert.equal(run.rerankings.length, 0)
  assert.equal(run.mainRequests.length, 1)
  await run.stop()
  run.assertClean()
})

test('standalone private forgetting deletes disabled semantic sources and vectors from an unbound group without reviving them after restart', {
  skip: !redisAvailable, timeout: 40000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-semantic-forgetting' })
  await run.start()
  run.send(source, 88201)
  run.send(otherGroupSource, 88202, { group: otherGroupId })
  run.send(distractor, 88203, { group: otherGroupId, author: authorId + 1 })
  await waitFor(async () => {
    const first = await run.state(), second = await run.state(otherGroupId)
    return first?.rows.length === 1 && second?.rows.length === 2 &&
      [...first.rows, ...second.rows].every(row => row.vector?.length === 3)
  }, 'persisted source text and vectors before disabling', 12000)
  const retained = (await run.state(otherGroupId)).rows.find(row => row.authorId === String(authorId + 1))
  await run.stop()
  await run.disableForPrivateCleanup()
  const embedded = run.embeddings.length, reranked = run.rerankings.length
  await run.start()
  assert.equal((await run.state()).rows[0].text, source, 'old unbound corpus still exists before the command')
  run.sendPrivate('#清空我的记忆', 88204)
  await waitFor(() => run.deliveries.some(row => row.epoch === 2 && row.action === 'send_private_msg' && Number(row.params.user_id) === authorId),
    'private forgetting confirmation')
  await waitFor(async () => {
    const first = await run.state(), second = await run.state(otherGroupId)
    return first === undefined && second?.rows.length === 1 && second.rows[0].authorId === String(authorId + 1)
  }, 'raw Redis text/vector deletion in the disabled unbound partition')
  assert.deepEqual((await run.state(otherGroupId)).rows, [retained])
  assert.deepEqual((await run.catalog()).entries.map(entry => entry.scope.target.id), [String(otherGroupId)], 'the empty old partition is removed from the durable catalog')
  const rawAfter = await run.states()
  assert.ok(!JSON.stringify(rawAfter).includes(source) && !JSON.stringify(rawAfter).includes(otherGroupSource))
  await run.stop()
  await run.start()
  assert.deepEqual(await run.states(), rawAfter, 'restart retains only the other person and their existing vector')
  assert.equal(run.embeddings.length, embedded, 'disabled cleanup and restart perform no embedding requests')
  assert.equal(run.rerankings.length, reranked)
  assert.equal(run.mainRequests.length, 0, 'the privacy command never becomes a model request')
  await run.stop()
  run.assertClean()
})
