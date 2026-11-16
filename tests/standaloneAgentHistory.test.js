import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// Exercise only the public CLI, including an extracted/installed agent release.
const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000161, otherBotId = 19000162, authorId = 330161, otherAuthorId = 330162
const groupA = 311601, groupB = 311602, deniedGroup = 311603, otherAgentGroup = 311604
const groups = [groupA, groupB, deniedGroup, otherAgentGroup]
const mainKey = 'standalone-history-synthetic-main-key', oneBotToken = 'standalone-history-synthetic-onebot-token'
const ownA = '我周六下午去攀岩馆练习抱石。'
const ownB = '我周日早晨预约了翡翠馆的抱石线路。'
const otherAuthor = '另一位群友抱石后打开锦鲤保险柜。'
const ownDenied = '我在已撤权限群安排抱石，暗号紫松。'
const ownOtherAgent = '我在另一个角色分区抱石，暗号铜锚。'
const ownOtherAccount = '我在另一个QQ账号的同号群抱石，暗号白鲸。'
const originals = [ownA, ownB, otherAuthor, ownDenied, ownOtherAgent, ownOtherAccount]
const excluded = [otherAuthor, ownDenied, ownOtherAgent, ownOtherAccount]
const question = '请查聊天记录：我在各群说过哪些抱石安排？按原文给我。'
const nextQuestion = '请按上一页偏移继续查我在各群说过的抱石原文。'
const replyPrefix = '查到的抱石原文：'
const completion = message => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })

async function waitFor(probe, description, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function historyResult(message) {
  const raw = JSON.parse(String(message.content).split('\n【运行时行动回执】', 1)[0])
  return raw.kind === 'tool_outcome' ? JSON.parse(raw.content) : raw
}

async function fixture(t, { instance, revokeOnEvidence = false }) {
  assert.equal(redisAvailable, true, 'actual CLI history acceptance requires redis-server; it must not silently skip')
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-agent-history-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const peers = new Map(), membership = new Map(groups.map(group => [`${botId}:${group}`, true]))
  const mainRequests = [], chosenQueries = [], pages = [], deliveries = [], memberReads = [], errors = [], unexpected = []
  let reader, child, childExit, epoch = 0, phase = 'capture', log = '', completeLog = '', nextOffset, revokedGroup
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url !== '/main/v1/chat/completions') {
        unexpected.push(request.url); response.writeHead(404).end('{}'); return
      }
      const toolMessage = body.messages.findLast(message => message.role === 'tool')
      const currentQuestion = body.messages.findLast(message => message.role === 'user')?.content
      const record = { epoch, phase, auth: request.headers.authorization, body, hasEvidence: !!toolMessage }
      mainRequests.push(record)
      if (!toolMessage) {
        assert.ok([question, nextQuestion].includes(currentQuestion), 'the model chooses history from the actual private request')
        assert.ok(body.tools.some(tool => tool.function.name === 'chatHistoryTool'), 'history is registered in the real private tool list')
        const input = { question: currentQuestion, source: 'archive', user_id: String(authorId), keywords: ['抱石'], limit: 1,
          ...(currentQuestion === nextQuestion ? { offset: nextOffset } : {}) }
        if (currentQuestion === nextQuestion) assert.equal(typeof nextOffset, 'number', 'the continuation uses the prior structured cursor')
        chosenQueries.push(input)
        response.end(completion({ content: '', tool_calls: [{ id: `history-cli-${chosenQueries.length}`, type: 'function',
          function: { name: 'chatHistoryTool', arguments: JSON.stringify(input) } }] }))
        return
      }
      const result = historyResult(toolMessage)
      assert.equal(result.status, 'found')
      assert.equal(result.messages.length, 1)
      assert.equal(result.messages[0].user_id, String(authorId))
      assert.ok([ownA, ownB].includes(result.messages[0].content))
      pages.push(result)
      nextOffset = result.next_offsets.archive
      if (revokeOnEvidence) {
        revokedGroup = Number(result.messages[0].group_id)
        assert.ok([groupA, groupB].includes(revokedGroup))
        membership.set(`${botId}:${revokedGroup}`, false)
        response.writeHead(400).end(JSON.stringify({ error: { message: 'unsupported max_tokens' } }))
        return
      }
      response.end(completion({ content: `${replyPrefix}${result.messages[0].content}` }))
    } catch (error) { errors.push(String(error)); response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, connection, head) => {
    const account = request.url === '/onebot/main' ? botId : request.url === '/onebot/other' ? otherBotId : undefined
    if (!account || request.headers.authorization !== `Bearer ${oneBotToken}`) { connection.destroy(); return }
    sockets.handleUpgrade(request, connection, head, peer => sockets.emit('connection', peer, account))
  })
  sockets.on('connection', (peer, account) => {
    peers.set(account, peer)
    peer.on('close', () => { if (peers.get(account) === peer) peers.delete(account) })
    peer.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message))
        let data = {}, status = 'ok', retcode = 0
        if (action === 'get_login_info') data = { user_id: account, nickname: '合成原文历史验收账号' }
        else if (action === 'get_group_member_info') {
          const group = Number(params.group_id), allowed = membership.get(`${account}:${group}`) === true
          memberReads.push({ epoch, phase, account, params, allowed })
          if (allowed && Number(params.user_id) === account && params.no_cache === true) {
            data = { group_id: group, user_id: account, nickname: '合成机器人', card: '', role: 'member' }
          } else { status = 'failed'; retcode = 100; data = null }
        } else if (action.startsWith('send_')) {
          const messageId = 99700 + deliveries.length
          deliveries.push({ epoch, phase, account, action, params, messageId })
          data = { message_id: messageId }
        } else { unexpected.push(action); status = 'failed'; retcode = 100 }
        peer.send(JSON.stringify({ status, retcode, echo, self_id: account, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    if (t.error) {
      t.diagnostic(completeLog)
      t.diagnostic(JSON.stringify({ errors, unexpected, chosenQueries, pages, memberReads, mainRequests }))
    }
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (childExit) await childExit
    for (const peer of sockets.clients) peer.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await redisExit
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated history Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port, configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({
    version: 1, instance, privateChat: { enabled: true }, history: { enabled: true, maxMessagesPerConversation: 50 },
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-history-main', apiKeyEnv: 'TEST_HISTORY_MAIN_KEY' },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    textGroups: [...groups.map(group => ({ connectionId: 'qq-history', conversationId: String(group) })),
      { connectionId: 'qq-history-other', conversationId: String(groupA) }],
    connections: [
      { id: 'qq-history', url: `ws://127.0.0.1:${port}/onebot/main`, accessTokenEnv: 'TEST_HISTORY_ONEBOT_TOKEN' },
      { id: 'qq-history-other', url: `ws://127.0.0.1:${port}/onebot/other`, accessTokenEnv: 'TEST_HISTORY_ONEBOT_TOKEN' },
    ],
    simulation: { wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false }, rhythm: { enabled: false },
      personProfile: { enabled: false }, turn: { minSendGapMs: 0 }, budget: { dailyCostCny: 0 } },
  }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'work', personaId: 'default' }],
    connections: [
      { id: 'qq-history', platform: 'qq', namespace: 'global', accountId: String(botId) },
      { id: 'qq-history-other', platform: 'qq', namespace: 'global', accountId: String(otherBotId) },
    ],
    bindings: [
      ...groups.map(group => ({ connectionId: 'qq-history', kind: 'group', conversationId: String(group), agentId: group === otherAgentGroup ? 'work' : 'daily' })),
      { connectionId: 'qq-history', kind: 'private', conversationId: String(authorId), agentId: 'daily' },
      { connectionId: 'qq-history-other', kind: 'group', conversationId: String(groupA), agentId: 'daily' },
    ],
  }))
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_HISTORY_MAIN_KEY: mainKey, TEST_HISTORY_ONEBOT_TOKEN: oneBotToken }
  const prefix = `bl-agent:${instance}:`
  async function rawStates() {
    const keys = await reader.keys(`${prefix}agent:history:v1:state:*`)
    return await Promise.all(keys.map(async key => JSON.parse(await reader.get(key))))
  }
  async function privateDrained() {
    const queues = await reader.keys(`${prefix}agent:inbox:private:*`)
    return (await Promise.all(queues.map(key => reader.lLen(key)))).every(length => length === 0)
  }
  async function start() {
    epoch++; log = ''; peers.clear()
    child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory, env })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; completeLog += chunk })
    await waitFor(() => {
      if (child.exitCode !== null) assert.fail(`standalone history host exited before readiness: ${log}`)
      return log.includes('已启动') && peers.size === 2
    }, `history CLI process ${epoch} readiness`)
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null], completeLog)
    child = undefined; childExit = undefined
  }
  function sendGroup(text, messageId, group, author = authorId, account = botId) {
    peers.get(account).send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: account,
      group_id: group, user_id: author, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: author, nickname: author === authorId ? '真实本人' : '其他群友' }, message: [{ type: 'text', data: { text } }],
    }))
  }
  function sendPrivate(text, messageId) {
    peers.get(botId).send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: botId,
      user_id: authorId, message_id: messageId, time: Math.floor(Date.now() / 1000),
      sender: { user_id: authorId, nickname: '真实本人' }, message: [{ type: 'text', data: { text } }],
    }))
  }
  async function captureAndRestart() {
    await start()
    sendGroup(ownA, 96101, groupA)
    sendGroup(otherAuthor, 96102, groupA, otherAuthorId)
    sendGroup(ownB, 96103, groupB)
    sendGroup(ownDenied, 96104, deniedGroup)
    sendGroup(ownOtherAgent, 96105, otherAgentGroup)
    sendGroup(ownOtherAccount, 96106, groupA, authorId, otherBotId)
    await waitFor(async () => {
      const states = await rawStates()
      return states.length === 5 && states.reduce((count, state) => count + state.rows.length, 0) === 6
    }, 'six original group utterances durably captured across five account/agent scopes')
    assert.equal(mainRequests.length, 0, 'undirected original capture requires no model HTTP')
    assert.equal(deliveries.length, 0)
    await stop()
    await start()
    membership.set(`${botId}:${deniedGroup}`, false)
    phase = 'private'
  }
  async function assertOriginalsWithoutDerivedEvidence() {
    const states = await rawStates(), raw = JSON.stringify(states)
    for (const text of originals) assert.ok(raw.includes(text), 'original source retention is allowed')
    assert.ok(states.every(state => state.rows.every(row => !Object.hasOwn(row, 'vector'))))
    assert.ok(!raw.includes(replyPrefix), 'derived model replies are not original history sources')
    const keys = (await reader.keys(`${prefix}*`)).filter(key => /private-history|group-text-history|agent:conversation-memory:/u.test(key))
    const derived = []
    for (const key of keys) if (await reader.type(key) === 'string') derived.push(await reader.get(key))
    for (const text of [...originals, replyPrefix]) assert.ok(!derived.join('\n').includes(text), 'recalled evidence and derived replies do not enter text history or episodes')
  }
  function assertClean() {
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [], 'no embedding, rerank, summary or unexpected HTTP/OneBot route is used')
    assert.ok(mainRequests.every(row => row.auth === `Bearer ${mainKey}` && row.body.model === 'standalone-history-main'))
    for (const record of memberReads) {
      assert.equal(record.account, botId, 'other connected accounts cannot become archive sources')
      assert.equal(Number(record.params.user_id), botId, 'the connected bot membership is rechecked')
      assert.equal(record.params.no_cache, true)
    }
    for (const record of mainRequests) for (const text of excluded) assert.ok(!JSON.stringify(record.body).includes(text))
    for (const value of [completeLog, JSON.stringify(deliveries), ...mainRequests.map(record => JSON.stringify(record.body))]) {
      for (const secret of [mainKey, oneBotToken]) assert.ok(!value.includes(secret))
    }
  }
  return { captureAndRestart, sendPrivate, privateDrained, stop, assertOriginalsWithoutDerivedEvidence, assertClean,
    mainRequests, chosenQueries, pages, deliveries, memberReads, get revokedGroup() { return revokedGroup } }
}

test('standalone explicit history survives restart and pages only the real private peer authorized same-agent/account group originals without vectors', {
  timeout: 30000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-history-pages' })
  await run.captureAndRestart()
  run.sendPrivate(question, 96201)
  await waitFor(() => run.deliveries.length === 1, 'first evidence-based private reply')
  await waitFor(run.privateDrained, 'first private history request drains')
  assert.equal(run.pages[0].next_offsets.archive, 1)
  run.sendPrivate(nextQuestion, 96202)
  await waitFor(() => run.deliveries.length === 2, 'second page evidence-based private reply')
  await waitFor(run.privateDrained, 'second private history request drains')
  assert.equal(run.pages.length, 2)
  assert.equal(run.chosenQueries[1].offset, run.pages[0].next_offsets.archive)
  assert.equal(run.pages[1].next_offsets.archive, undefined)
  assert.deepEqual(new Set(run.pages.flatMap(page => page.messages.map(message => message.content))), new Set([ownA, ownB]))
  assert.equal(run.mainRequests.length, 4, 'each actual user query chooses the tool then reads structured evidence')
  assert.equal(run.mainRequests.filter(row => row.hasEvidence).length, 2)
  for (const row of run.mainRequests.filter(row => !row.hasEvidence)) {
    for (const text of originals) assert.ok(!JSON.stringify(row.body.messages).includes(text), 'history evidence is supplied only after explicit model tool selection')
  }
  assert.ok(run.deliveries.every(row => row.account === botId && row.action === 'send_private_msg' && Number(row.params.user_id) === authorId))
  assert.ok(run.memberReads.some(row => Number(row.params.group_id) === deniedGroup && !row.allowed))
  for (const group of [groupA, groupB]) assert.ok(run.memberReads.some(row => Number(row.params.group_id) === group && row.allowed))
  await run.stop()
  await run.assertOriginalsWithoutDerivedEvidence()
  run.assertClean()
})

test('standalone history rechecks source membership before a provider compatibility retry and persists no revoked evidence or reply', {
  timeout: 30000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-history-revoked', revokeOnEvidence: true })
  await run.captureAndRestart()
  run.sendPrivate(question, 96301)
  await waitFor(() => run.mainRequests.some(row => row.hasEvidence), 'the first model request containing explicit tool evidence')
  await waitFor(() => run.memberReads.some(row => Number(row.params.group_id) === run.revokedGroup && !row.allowed), 'fresh source denial before compatibility retry')
  await waitFor(run.privateDrained, 'revoked history request drains without delivery')
  assert.equal(run.pages.length, 1)
  assert.equal(run.mainRequests.length, 2, 'only tool selection and the first evidence-containing HTTP request are allowed')
  assert.equal(run.mainRequests.filter(row => row.hasEvidence).length, 1, 'no retry may resend revoked evidence')
  assert.equal(run.mainRequests.find(row => row.hasEvidence).body.max_tokens, 1000, 'the synthetic provider rejects a real generation compatibility field')
  assert.equal(run.deliveries.length, 0, 'no QQ send follows evidence permission loss')
  await run.stop()
  await run.assertOriginalsWithoutDerivedEvidence()
  run.assertClean()
})
