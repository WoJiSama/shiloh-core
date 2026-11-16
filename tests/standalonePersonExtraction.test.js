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
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { createTextPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/textPersonMemoryStore.js'
import { agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000011, sourceGroup = 310101, sharedGroup = 310102, isolatedGroup = 310103, userId = 330029
const instance = 'standalone-person-extraction-test'
const prefix = `bl-agent:${instance}:`
const mainKey = 'standalone-person-main-private-key'
const extractionKey = 'standalone-person-extract-private-key'
const oneBotToken = 'standalone-person-onebot-private-token'
const portableFact = '长期喜欢爵士乐'
const localFact = '周四承担午班'
const sourceText = '我一直很喜欢爵士乐。这周我的午班安排在周四。'
const target = group => ({ account: { platform: 'qq', namespace: 'global', id: String(botId) }, kind: 'group', id: String(group) })
const address = group => simulationAddressKey(target(group))

async function waitFor(probe, description, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}
function completion(message, usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return JSON.stringify({ choices: [{ message }], usage })
}

test('standalone extracts real inbound sources, persists them across restart and enforces scene/agent visibility', {
  skip: !redisAvailable, timeout: 90_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-person-extraction-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], extractions = [], deliveries = [], fixtureErrors = [], unexpected = []
  let reader, child, childExit, websocket, epoch = 0, log = '', completeLog = ''
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/extract/v1/chat/completions') {
        extractions.push({ path: request.url, auth: request.headers.authorization, body })
        const source = JSON.parse(body.messages.at(-1).content).find(row => row.text === sourceText)
        assert.ok(source, 'the extractor receives a real author/source row')
        const candidate = (category, fact, excerpt, portable, sensitivity) => ({ category, text: fact, sourceIndex: source.sourceIndex, sourceExcerpt: excerpt, portable, sensitivity })
        response.end(completion({ content: JSON.stringify([
          { userId: String(userId), entries: [
            candidate('interest', portableFact, '我一直很喜欢爵士乐', true, 'ordinary'),
            candidate('fact', localFact, '这周我的午班安排在周四', false, 'personal'),
          ] },
          { userId: String(userId + 1), entries: [candidate('interest', '伪造作者的爱好', '我一直很喜欢爵士乐', true, 'ordinary')] },
        ]) }, { prompt_tokens: 26, completion_tokens: 11, total_tokens: 37 }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ epoch, auth: request.headers.authorization, body })
        response.end(completion({ content: '', tool_calls: [{ id: 'person-fixture-finish', type: 'function',
          function: { name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '人物记忆验收不需要群内回复' }) } }] }))
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
      const { action, params, echo } = JSON.parse(String(message))
      if (action.startsWith('send_')) deliveries.push({ action, params })
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo,
        data: action === 'get_login_info' ? { user_id: botId, nickname: '人物事实验收账号' } : { message_id: 93200 + deliveries.length },
      }))
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(completeLog)
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
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const config = {
    version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-person-main', apiKeyEnv: 'TEST_PERSON_MAIN_KEY' },
    personMemoryExtraction: { baseUrl: `http://127.0.0.1:${port}/extract/v1`, name: 'standalone-person-extractor', apiKeyEnv: 'TEST_PERSON_EXTRACTION_KEY' },
    connections: [{ id: 'qq-person', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_PERSON_ONEBOT_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1_000, probability: 0, proactiveProbability: 0 },
      mood: { enabled: false }, rhythm: { enabled: false }, reflection: { enabled: false }, userStyle: { enabled: false },
      meme: { enabled: false }, lifeThreads: { enabled: false }, personProfile: { enabled: true }, turn: { minSendGapMs: 0 } },
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'isolated', personaId: 'default' }],
    connections: [{ id: 'qq-person', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [sourceGroup, sharedGroup, isolatedGroup].map(group => ({ connectionId: 'qq-person', kind: 'group', conversationId: String(group), agentId: group === isolatedGroup ? 'isolated' : 'daily' })),
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  async function start() {
    epoch++; log = ''; websocket = undefined
    child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
      env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_PERSON_MAIN_KEY: mainKey,
        TEST_PERSON_EXTRACTION_KEY: extractionKey, TEST_PERSON_ONEBOT_TOKEN: oneBotToken },
    })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    await waitFor(() => log.includes('已启动') && websocket, `standalone process ${epoch} readiness`)
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null])
    child = undefined; childExit = undefined
  }
  function send(group, text, index, directed = false) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
      group_id: group, user_id: userId, message_id: 84100 + index, time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname: '仅来源群使用的名片' },
      message: [...(directed ? [{ type: 'at', data: { qq: String(botId) } }] : []), { type: 'text', data: { text } }],
    }))
  }
  const stateOf = async group => JSON.parse(await reader.get(prefix + simulationSessionKey(address(group))) || 'null')
  const people = createPersonMemoryStore({ redis: {
    get: key => reader.get(prefix + key), set: (key, value, options) => reader.set(prefix + key, value, options),
    del: (...keys) => reader.del(keys.map(key => prefix + key)),
  } })
  const query = (group, agent = 'daily', subjectId = String(userId)) => people.query({
    identity: { botId: String(botId), personaId: agentPersonaScopeId(agent) }, subjectId,
    scene: { kind: 'group', id: String(group) }, viewerUserId: subjectId,
  })

  await start()
  for (let index = 0; index < 20; index++) send(sourceGroup, index === 0 ? sourceText : `本人闲聊记录第${index + 1}条`, index)
  await waitFor(async () => (await stateOf(sourceGroup))?.seq === 20, 'twenty durable inbound sources')
  await waitFor(async () => (await stateOf(sourceGroup))?.personProfileCursor?.seq === 20, 'scheduled independent person extraction', 45_000)
  assert.equal(extractions.length, 1)
  assert.deepEqual((await query(sourceGroup)).items.map(item => item.text).sort(), [localFact, portableFact].sort())
  assert.deepEqual((await query(sharedGroup)).items.map(item => item.text), [portableFact])
  assert.deepEqual((await query(sourceGroup, 'isolated')).items, [])
  assert.deepEqual((await query(sourceGroup, 'daily', String(userId + 1))).items, [], 'a mismatched source author cannot create another person profile')
  const persisted = (await query(sourceGroup)).items
  for (const item of persisted) {
    assert.equal(item.source.messageId, '84100')
    assert.deepEqual(item.source.scene, { kind: 'group', id: String(sourceGroup) })
    assert.equal(item.source.authorId, String(userId))
    assert.equal(item.evidenceKind, 'self')
    assert.ok(sourceText.includes(item.source.excerpt))
  }
  await stop()
  await start()
  assert.deepEqual((await query(sourceGroup)).items.map(item => item.id).sort(), persisted.map(item => item.id).sort())
  const prompts = []
  for (const [index, group] of [sourceGroup, sharedGroup, isolatedGroup].entries()) {
    const marker = `重启后的记忆可见性验收${index}`
    send(group, marker, 30 + index, true)
    const request = await waitFor(() => mainRequests.find(row => row.epoch === 2 && JSON.stringify(row.body.messages).includes(marker)), `post-restart memory prompt ${group}`)
    prompts.push(JSON.stringify(request.body.messages))
    await waitFor(async () => !await reader.exists(prefix + simulationBusyKey(address(group))), `finished visibility turn ${group}`)
  }
  assert.match(prompts[0], /【本群人物记忆】/u)
  assert.ok(prompts[0].includes(portableFact))
  assert.ok(prompts[0].includes(localFact))
  assert.ok(prompts[1].includes(portableFact))
  assert.ok(!prompts[1].includes(localFact))
  assert.ok(!prompts[2].includes(portableFact))
  assert.ok(!prompts[2].includes(localFact))
  await stop()

  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(unexpected, [])
  assert.deepEqual(deliveries, [])
  assert.equal(extractions.length, 1, 'the completed extraction cursor survives restart')
  const extraction = extractions[0]
  assert.equal(extraction.auth, `Bearer ${extractionKey}`)
  assert.equal(extraction.body.model, 'standalone-person-extractor')
  assert.equal(extraction.body.max_tokens, 2000)
  assert.equal(extraction.body.stream, false)
  assert.equal(extraction.body.tools, undefined)
  assert.deepEqual(extraction.body.messages.map(row => row.role), ['system', 'user'])
  const sources = JSON.parse(extraction.body.messages[1].content)
  assert.equal(sources.length, 20)
  for (const source of sources) assert.deepEqual(Object.keys(source), ['sourceIndex', 'userId', 'name', 'text'])
  assert.doesNotMatch(JSON.stringify(extraction.body), /private-|qq-person|agentId|personaId|connectionId|binding|scope/u)
  assert.ok(mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-person-main'))
  const ledgerDir = path.join(directory, 'data', instance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
  const rows = ledgerText.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.filter(row => row.stage === 'person-profile' && row.u?.total).map(row => [row.scope, row.model, row.u.total]),
    [[address(sourceGroup), 'standalone-person-extractor', 37]])
  assert.deepEqual(rows.filter(row => row.stage === 'api' && row.model === 'standalone-person-extractor').map(row => [row.scope, row.u.total]), [['global', 37]])
  for (const location of [completeLog, ledgerText, JSON.stringify(deliveries), JSON.stringify(extraction.body), ...mainRequests.map(row => JSON.stringify(row.body))]) {
    for (const secret of [mainKey, extractionKey, oneBotToken]) assert.ok(!location.includes(secret))
  }
})

test('standalone learns confirmed private and group text utterances through its independent extractor across restart', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-text-person-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], extractions = [], deliveries = [], fixtureErrors = [], unexpected = []
  const textInstance = 'standalone-text-person-test'
  const textPrefix = `bl-agent:${textInstance}:`
  const privateTarget = { account: target(sourceGroup).account, kind: 'private', id: String(userId) }
  const privateText = '我一直喜欢用周末时间拼木质模型。'
  const privateFact = '喜欢拼木质模型'
  const groupText = '这周我负责周六展览的签到。'
  const groupFact = '周六负责展览签到'
  let reader, child, childExit, websocket, epoch = 0, log = '', completeLog = ''
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/extract/v1/chat/completions') {
        const sources = JSON.parse(body.messages.at(-1).content)
        assert.equal(sources.length, 1, 'max batch size one preserves the confirmed utterance')
        assert.ok(deliveries.length >= extractions.length + 1, 'learning starts after a confirmed text reply')
        extractions.push({ epoch, auth: request.headers.authorization, body })
        const source = sources[0]
        const fact = source.text === privateText ? privateFact : source.text === groupText ? groupFact : undefined
        response.end(completion({ content: JSON.stringify(fact ? [{ userId: source.userId, entries: [{
          category: source.text === privateText ? 'interest' : 'fact', text: fact, sourceIndex: 1,
          sourceExcerpt: source.text, portable: source.text === privateText, sensitivity: source.text === privateText ? 'ordinary' : 'personal',
        }] }] : []) }, { prompt_tokens: 26, completion_tokens: 11, total_tokens: 37 }))
        return
      }
      if (request.url === '/main/v1/chat/completions') {
        mainRequests.push({ epoch, auth: request.headers.authorization, body })
        response.end(completion({ content: '嗯，知道啦。' }))
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
      const { action, params, echo } = JSON.parse(String(message))
      if (action.startsWith('send_')) deliveries.push({ action, params })
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo,
        data: action === 'get_login_info' ? { user_id: botId, nickname: '文字学习验收账号' } : { message_id: 94200 + deliveries.length },
      }))
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(completeLog)
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
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated text-learning Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const config = {
    version: 1, instance: textInstance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-text-main', apiKeyEnv: 'TEST_PERSON_MAIN_KEY' },
    personMemoryExtraction: { baseUrl: `http://127.0.0.1:${port}/extract/v1`, name: 'standalone-text-extractor', apiKeyEnv: 'TEST_PERSON_EXTRACTION_KEY' },
    memorySystem: { enabled: true, userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 1 },
    privateChat: { enabled: true },
    textGroups: [{ connectionId: 'qq-person', conversationId: String(sourceGroup) }],
    connections: [{ id: 'qq-person', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_PERSON_ONEBOT_TOKEN' }],
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false }, rhythm: { enabled: false }, turn: { minSendGapMs: 0 } },
  }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq-person', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [privateTarget, target(sourceGroup)].map(target => ({ connectionId: 'qq-person', kind: target.kind, conversationId: target.id, agentId: 'daily' })),
  }))
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify(config))
  async function start() {
    epoch++; log = ''; websocket = undefined
    child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
      env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_PERSON_MAIN_KEY: mainKey,
        TEST_PERSON_EXTRACTION_KEY: extractionKey, TEST_PERSON_ONEBOT_TOKEN: oneBotToken },
    })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    await waitFor(() => log.includes('已启动') && websocket, `text-learning process ${epoch} readiness`)
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null])
    child = undefined; childExit = undefined
  }
  function send(kind, text, messageId) {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: kind, sub_type: kind === 'private' ? 'friend' : 'normal', self_id: botId,
      ...(kind === 'group' ? { group_id: sourceGroup } : {}), user_id: userId, message_id: messageId,
      time: Math.floor(Date.now() / 1000), sender: { user_id: userId, nickname: '真实文字作者' },
      message: [...(kind === 'group' ? [{ type: 'at', data: { qq: String(botId) } }] : []), { type: 'text', data: { text } }],
    }))
  }
  const storage = {
    get: key => reader.get(textPrefix + key),
    set: (key, value, options) => reader.set(textPrefix + key, value, options),
    del: key => reader.del(textPrefix + key),
    eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => textPrefix + key), arguments: options.arguments }),
  }
  const people = createPersonMemoryStore({ redis: storage })
  const learning = createTextPersonMemoryStore(storage)
  const read = scene => people.query({ identity: { botId: String(botId), personaId: agentPersonaScopeId('daily') },
    subjectId: String(userId), scene, viewerUserId: String(userId), localOnly: true })
  const privateScene = { kind: 'private', id: String(userId) }, groupScene = { kind: 'group', id: String(sourceGroup) }

  await start()
  send('private', privateText, 85101)
  await waitFor(() => deliveries.some(row => row.action === 'send_private_msg'), 'confirmed private reply')
  await waitFor(async () => (await read(privateScene)).items.some(row => row.text === privateFact), 'single private utterance learned')
  send('group', groupText, 85102)
  await waitFor(() => deliveries.some(row => row.action === 'send_group_msg'), 'confirmed group text reply')
  await waitFor(async () => (await read(groupScene)).items.some(row => row.text === groupFact), 'single group text utterance learned')
  await waitFor(async () => {
    const batches = await learning.list()
    return batches.length === 2 && batches.every(row => row.messages.length === 0 && row.completedMessageIds?.length === 1)
  }, 'completed learning ledgers')
  assert.equal(extractions.length, 2)
  const privateEntry = (await read(privateScene)).items[0], groupEntry = (await read(groupScene)).items[0]
  assert.equal(privateEntry.portable, false, 'private evidence never becomes portable')
  assert.equal(privateEntry.source.messageId, '85101')
  assert.equal(privateEntry.source.excerpt, privateText)
  assert.equal(groupEntry.source.messageId, '85102')
  assert.equal(groupEntry.source.excerpt, groupText)
  assert.equal(privateEntry.source.authorId, String(userId))
  assert.equal(groupEntry.source.authorId, String(userId))
  await stop()
  await start()
  assert.equal((await read(privateScene)).items[0].id, privateEntry.id)
  assert.equal((await read(groupScene)).items[0].id, groupEntry.id)
  for (const [kind, marker, messageId, expected, excluded] of [
    ['private', '重启私聊记忆验收', 85103, privateFact, groupFact],
    ['group', '重启群文字记忆验收', 85104, groupFact, privateFact],
  ]) {
    send(kind, marker, messageId)
    const request = await waitFor(() => mainRequests.find(row => row.epoch === 2 && row.body.messages.at(-1).content === marker), `${kind} post-restart recall`)
    const prompt = JSON.stringify(request.body.messages)
    assert.ok(prompt.includes(expected))
    assert.ok(!prompt.includes(excluded))
  }
  await waitFor(async () => (await learning.list()).every(row => row.messages.length === 0 && row.completedMessageIds?.length === 2), 'post-restart learning ledgers')
  await stop()

  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(unexpected, [])
  assert.equal(deliveries.filter(row => row.action === 'send_private_msg').length, 2)
  assert.equal(deliveries.filter(row => row.action === 'send_group_msg').length, 2)
  assert.equal(extractions.length, 4)
  assert.deepEqual(extractions.slice(0, 2).map(row => JSON.parse(row.body.messages[1].content)[0].text), [privateText, groupText])
  for (const request of extractions) {
    assert.equal(request.auth, `Bearer ${extractionKey}`)
    assert.equal(request.body.model, 'standalone-text-extractor')
    assert.equal(request.body.tools, undefined)
    assert.equal(request.body.max_tokens, 2000)
    assert.deepEqual(request.body.messages.map(row => row.role), ['system', 'user'])
    const [source] = JSON.parse(request.body.messages[1].content)
    assert.equal(source.userId, String(userId))
    assert.deepEqual(Object.keys(source), ['sourceIndex', 'userId', 'name', 'text'])
    assert.doesNotMatch(JSON.stringify(request.body), /private-|qq-person|agentId|personaId|connectionId|binding|scope/u)
  }
  assert.ok(mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-text-main'))
  const ledgerDir = path.join(directory, 'data', textInstance, 'token_usage')
  const ledgerText = (await Promise.all((await readdir(ledgerDir)).map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
  const rows = ledgerText.trim().split('\n').map(line => JSON.parse(line))
  const usage = rows.filter(row => row.stage === 'person-profile' && row.model === 'standalone-text-extractor')
  assert.equal(usage.length, 4)
  assert.deepEqual(usage.map(row => row.u.total), [37, 37, 37, 37])
  assert.equal(usage.filter(row => row.scope === simulationAddressKey(privateTarget)).length, 2)
  assert.equal(usage.filter(row => row.scope === address(sourceGroup)).length, 2)
  assert.equal(rows.filter(row => row.stage === 'api' && row.model === 'standalone-text-extractor' && row.u.total === 37).length, 4)
  for (const location of [completeLog, ledgerText, JSON.stringify(deliveries), ...extractions.map(row => JSON.stringify(row.body)), ...mainRequests.map(row => JSON.stringify(row.body))]) {
    for (const secret of [mainKey, extractionKey, oneBotToken]) assert.ok(!location.includes(secret))
  }
})
