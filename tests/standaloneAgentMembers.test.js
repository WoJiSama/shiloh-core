import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'

// All behavior crosses the real CLI boundary. No repository dist imports are
// needed, so the same fixture can verify an installed/extracted release.
const repo = fileURLToPath(new URL('../', import.meta.url))
const entry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const botId = 19000151, groupId = 311501, userId = 330151
const targetId = 330152, guessedId = 330159, secondAdminId = 330153
const mainKey = 'standalone-members-synthetic-model-key', oneBotToken = 'standalone-members-synthetic-onebot-token'
const notification = '请在十点到会议室集合。'
const blockedFollowup = 'UNKNOWN-MEMBER-DELIVERY：这条补充消息不得发送。'
const inputText = '请查这位被@成员的群名片、等级和入群时间，再@这位通知：十点到会议室集合。'
const rows = [
  { user_id: botId, nickname: '合成工具机器人', card: '机器人名片', role: 'admin' },
  { user_id: userId, nickname: '合成请求者', card: '请求者名片', role: 'member' },
  { user_id: targetId, nickname: '目标昵称', card: '目标成员名片', role: 'admin' },
  { user_id: secondAdminId, nickname: '另一管理员', card: '另一管理员名片', role: 'admin' },
  { user_id: guessedId, nickname: '模型猜错的群主', card: '错误查询对象', role: 'owner' },
]
const member = row => ({ ...row, group_id: groupId, self_id: botId,
  ...(row.user_id === targetId ? { title: '目标专属头衔', level: 0, join_time: 1_600_000_000,
    last_sent_time: 1_700_000_000, sex: 'female', age: 28, area: '合成地区', unknown_private_field: 'UNRECOGNIZED-PROFILE-MUST-NOT-LEAK' } : {}),
})
const completion = message => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })
const toolCall = (name, input) => ({ content: '', tool_calls: [{ id: `members-fixture-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(input) } }] })

async function waitFor(probe, description, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, { instance, receipt = 'sent', adminCollection = false }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'standalone-agent-members-'))
  const socketPath = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const redisExit = once(redis, 'exit')
  const sockets = new WebSocketServer({ noServer: true })
  const mainRequests = [], platformRequests = [], deliveries = [], errors = [], unexpected = [], chosenTools = []
  let reader, child, childExit, websocket, log = '', mentionRequested = false, infoRequested = false, followupRequested = false, finishRequested = false
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      response.setHeader('Content-Type', 'application/json')
      if (request.url !== '/main/v1/chat/completions') {
        unexpected.push(request.url); response.writeHead(404).end('{}'); return
      }
      mainRequests.push({ auth: request.headers.authorization, body })
      const toolResult = name => body.messages.findLast(row => row.role === 'tool' && row.tool_call_id === `members-fixture-${name}`)
      const choose = (name, input) => { chosenTools.push(name); response.end(completion(toolCall(name, input))) }
      if (!adminCollection && !infoRequested) {
        infoRequested = true
        choose('memberInfoTool', { user_id: String(guessedId) })
      } else if (!mentionRequested && (adminCollection || toolResult('memberInfoTool'))) {
        mentionRequested = true
        choose(adminCollection ? 'mentionAdminsTool' : 'mentionMembersTool', adminCollection
          ? { message: notification } : { targets: [String(targetId)], message: notification })
      } else if (toolResult(adminCollection ? 'mentionAdminsTool' : 'mentionMembersTool') && receipt === 'unknown' && !followupRequested) {
        followupRequested = true
        choose('simSendMessage', { continuation: 'chat', messages: [blockedFollowup] })
      } else if (!finishRequested) {
        finishRequested = true
        choose('simFinishTurn', { choice: 'silent', reason: '本轮通知工具已经尝试发送，安静收尾；未知回执不重发' })
      } else choose('simDecide', { decision: 'silent', reason: '合成验收回合已结束' })
    } catch (error) { errors.push(String(error)); response.writeHead(500).end('{}') }
  })
  server.on('upgrade', (request, connection, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${oneBotToken}`) { connection.destroy(); return }
    sockets.handleUpgrade(request, connection, head, peer => sockets.emit('connection', peer))
  })
  sockets.on('connection', peer => {
    websocket = peer
    peer.on('message', message => {
      try {
        const { action, params, echo } = JSON.parse(String(message))
        platformRequests.push({ action, params })
        let data = {}, status = 'ok', retcode = 0
        if (action === 'get_login_info') data = { user_id: botId, nickname: '合成成员工具验收账号' }
        else if (action === 'get_group_member_info') {
          const found = rows.find(row => String(row.user_id) === String(params.user_id))
          if (String(params.group_id) !== String(groupId) || params.no_cache !== true || !found) {
            errors.push('member query escaped fixed group/no_cache/member contract'); status = 'failed'; retcode = 1
          } else data = member(found)
        } else if (action === 'get_group_member_list') {
          if (String(params.group_id) !== String(groupId)) { errors.push('member list escaped fixed group'); status = 'failed'; retcode = 1 }
          else data = rows.map(member)
        } else if (action.startsWith('send_')) {
          const messageId = 99800 + deliveries.length
          deliveries.push({ action, params, messageId })
          data = receipt === 'unknown' ? {} : { message_id: messageId }
        } else { unexpected.push(action); status = 'failed'; retcode = 1 }
        peer.send(JSON.stringify({ status, retcode, echo, self_id: botId, data }))
      } catch (error) { errors.push(String(error)) }
    })
  })
  t.after(async () => {
    if (t.error) {
      t.diagnostic(log)
      t.diagnostic(JSON.stringify({ errors, unexpected, chosenTools, platformRequests,
        toolResults: mainRequests.flatMap(row => row.body.messages.filter(message => message.role === 'tool')) }))
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
  await waitFor(() => stat(socketPath).catch(() => false), 'isolated members Redis socket')
  reader = createClient({ socket: { path: socketPath, reconnectStrategy: false } })
  reader.on('error', () => {})
  await reader.connect()
  const port = server.address().port
  const configFile = path.join(directory, 'agent-host.yaml')
  await writeFile(configFile, JSON.stringify({ version: 1, instance,
    model: { baseUrl: `http://127.0.0.1:${port}/main/v1`, name: 'standalone-members-main', apiKeyEnv: 'TEST_MEMBERS_MAIN_KEY' },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    connections: [{ id: 'qq-members', url: `ws://127.0.0.1:${port}/onebot`, accessTokenEnv: 'TEST_MEMBERS_ONEBOT_TOKEN' }],
    simulation: { wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false },
      reflection: { enabled: false }, personProfile: { enabled: false }, turn: { minSendGapMs: 0, maxSendsPerTurn: 1 },
      ...(adminCollection ? { toolPolicy: { mode: 'open', allowTools: ['mentionAdminsTool'] } } : {}),
    },
  }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'qq-members', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-members', kind: 'group', conversationId: String(groupId), agentId: 'daily' }],
  }))
  async function session() {
    for (const key of await reader.keys(`bl-agent:${instance}:shiloh:sim:g:*`)) {
      if (!/shiloh:sim:g:v2\.[A-Za-z0-9_-]+$/u.test(key)) continue
      const value = JSON.parse(await reader.get(key) || 'null')
      if (value && Array.isArray(value.sendTimes) && typeof value.seq === 'number') return value
    }
  }
  async function settled() { return (await reader.keys(`bl-agent:${instance}:shiloh:sim:busy:*`)).length === 0 }
  async function start() {
    child = spawn(process.execPath, [entry, '--config', configFile], { cwd: directory,
      env: { ...process.env, BL_AGENT_REDIS_URL: `unix://${socketPath}`, TEST_MEMBERS_MAIN_KEY: mainKey, TEST_MEMBERS_ONEBOT_TOKEN: oneBotToken },
    })
    childExit = once(child, 'exit')
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    await waitFor(() => {
      if (child.exitCode !== null) assert.fail(`standalone members host exited before readiness: ${log}`)
      return log.includes('已启动') && websocket
    }, 'standalone members host readiness')
  }
  async function stop() {
    child.kill('SIGTERM')
    assert.deepEqual(await childExit, [0, null], log)
    child = undefined; childExit = undefined
  }
  function trigger() {
    websocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: botId,
      group_id: groupId, user_id: userId, message_id: 95101, time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname: '合成请求者' }, message: [
        { type: 'at', data: { qq: String(botId) } },
        ...(!adminCollection ? [{ type: 'at', data: { qq: String(targetId) } }] : []),
        { type: 'text', data: { text: adminCollection ? '请通知所有管理员十点到会议室集合。' : inputText } },
      ],
    }))
  }
  const results = name => mainRequests.flatMap(row => row.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === `members-fixture-${name}`))
  async function assertClean() {
    assert.deepEqual(errors, [])
    assert.deepEqual(unexpected, [])
    assert.ok(mainRequests.every(request => request.auth === `Bearer ${mainKey}` && request.body.model === 'standalone-members-main'))
    const ledgerDir = path.join(directory, 'data', instance, 'token_usage')
    const files = await readdir(ledgerDir).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const ledger = (await Promise.all(files.map(file => readFile(path.join(ledgerDir, file), 'utf8')))).join('')
    for (const value of [log, ledger, JSON.stringify(deliveries), ...mainRequests.map(request => JSON.stringify(request.body))]) {
      for (const secret of [mainKey, oneBotToken]) assert.ok(!value.includes(secret))
      assert.ok(!value.includes('UNRECOGNIZED-PROFILE-MUST-NOT-LEAK'))
    }
  }
  return { start, stop, trigger, session, settled, assertClean, results, mainRequests, platformRequests, deliveries, chosenTools,
    get finishRequested() { return finishRequested }, get followupRequested() { return followupRequested } }
}

function assertNativeMention(delivery, expectedIds) {
  assert.equal(delivery.action, 'send_group_msg')
  assert.equal(String(delivery.params.group_id), String(groupId))
  const message = delivery.params.message
  assert.deepEqual(message.filter(part => part.type === 'at').map(part => String(part.data.qq)), expectedIds.map(String))
  assert.equal(message.filter(part => part.type === 'text').map(part => part.data.text).join(''), notification)
  assert.ok(message.every(part => ['at', 'text'].includes(part.type)), 'one native message contains only at/text parts')
  assert.ok(!JSON.stringify(message.filter(part => part.type === 'text')).includes('[CQ:at'))
}

test('standalone member tools use genuine incoming mentions over a guessed ID and count one native notification', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-members-grounded' })
  await run.start(); run.trigger()
  await waitFor(() => run.deliveries.length === 1 && run.finishRequested, 'member notification confirmed and consumed by the model')
  await waitFor(async () => (await run.session())?.sendTimes.length === 1 && await run.settled(), 'one native message consumes one send quota')
  await run.stop()
  assert.equal(run.deliveries.length, 1)
  assertNativeMention(run.deliveries[0], [targetId])
  const tools = new Set(run.mainRequests[0].body.tools.map(tool => tool.function.name))
  assert.ok(tools.has('memberInfoTool'))
  assert.ok(tools.has('mentionMembersTool'))
  assert.ok(!tools.has('mentionAdminsTool'), 'administrator collections are absent from the default capability surface')
  assert.deepEqual(run.chosenTools.slice(0, 3), ['memberInfoTool', 'mentionMembersTool', 'simFinishTurn'])
  const details = run.platformRequests.filter(request => request.action === 'get_group_member_info')
  assert.ok(details.length >= 2, 'query and final mention validation both read fresh member evidence')
  assert.ok(details.every(request => String(request.params.user_id) === String(targetId)), 'bot @ and guessed ID never replace the genuine target @')
  assert.ok(details.every(request => request.params.no_cache === true && String(request.params.group_id) === String(groupId)))
  assert.ok(run.platformRequests.some(request => request.action === 'get_group_member_list' && String(request.params.group_id) === String(groupId)))
  const result = run.results('memberInfoTool')
  assert.ok(result.length > 0)
  for (const item of result) {
    const outcome = JSON.parse(String(item.content).split('\n【运行时行动回执】', 1)[0])
    assert.equal(outcome.status, 'success')
    const data = JSON.parse(outcome.content).data
    assert.equal(data.user_id, String(targetId))
    assert.equal(data.displayName, '目标成员名片')
    assert.equal(data.title, '目标专属头衔')
    assert.equal(data.joinedAt, 1_600_000_000_000)
    assert.equal(data.level, '0')
    assert.match(item.content, /目标成员名片/u)
    assert.match(item.content, /目标专属头衔/u)
    assert.match(item.content, /1600000000000/u)
    assert.ok(!item.content.includes('错误查询对象'))
  }
  assert.ok(run.results('mentionMembersTool').some(item => String(item.content).includes('99800')))
  await run.assertClean()
})

test('standalone unknown member notification receipt freezes later sends and never retries the native mention', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-members-unknown', receipt: 'unknown' })
  await run.start(); run.trigger()
  await waitFor(() => run.followupRequested && run.finishRequested, 'unknown receipt followed by an attempted model followup')
  await waitFor(async () => await run.settled() && Boolean(await run.session()), 'unknown notification turn closes')
  await run.stop()
  assert.equal(run.deliveries.length, 1, 'no second native send or text fallback after uncertain delivery')
  assertNativeMention(run.deliveries[0], [targetId])
  assert.equal((await run.session()).sendTimes.length, 0, 'an unknown result does not fabricate a confirmed quota entry')
  assert.ok(run.results('mentionMembersTool').some(item => /unknown|未确认|核实/u.test(String(item.content))))
  assert.ok(run.results('simSendMessage').some(item => /未知|不再发送|核实/u.test(String(item.content))))
  assert.ok(!JSON.stringify(run.deliveries).includes(blockedFollowup))
  await run.assertClean()
})

test('standalone administrator collection needs an explicit allow and sends one role-verified native message', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const run = await fixture(t, { instance: 'standalone-members-admins', adminCollection: true })
  await run.start(); run.trigger()
  await waitFor(() => run.deliveries.length === 1 && run.finishRequested, 'explicitly allowed administrator notification')
  await waitFor(async () => (await run.session())?.sendTimes.length === 1 && await run.settled(), 'administrator batch consumes one quota')
  await run.stop()
  assert.equal(run.deliveries.length, 1)
  assertNativeMention(run.deliveries[0], [targetId, secondAdminId])
  assert.ok(run.mainRequests[0].body.tools.some(tool => tool.function.name === 'mentionAdminsTool'))
  assert.ok(run.platformRequests.some(request => request.action === 'get_group_member_list'))
  const ids = run.platformRequests.filter(request => request.action === 'get_group_member_info').map(request => String(request.params.user_id))
  assert.ok(ids.includes(String(targetId)) && ids.includes(String(secondAdminId)))
  assert.ok(!ids.includes(String(botId)) && !ids.includes(String(guessedId)), 'bot and owner are excluded from the administrator batch')
  assert.ok(run.results('mentionAdminsTool').some(item => String(item.content).includes('99800')))
  await run.assertClean()
})
