import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, describe } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createClient } from '@redis/client'
import { WebSocketServer } from 'ws'
import YAML from 'yaml'
import { readQqMessageImage } from '../dist/backend/adapters/qqMessageImage.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { runStandaloneQqMigration } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { agentBindingIdentity, agentBindingToken, agentConversationKey, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentBindingConfig } from '../dist/backend/modules/runtime/infrastructure/agentBindingConfig.js'
import { createCommitmentRuntime } from '../dist/backend/modules/commitments/infrastructure/commitmentTool.js'
import { createDelegateMemoryRuntime } from '../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { createReminderRuntime } from '../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
import { characterReflectionKey } from '../dist/backend/modules/simulation/infrastructure/characterReflection.js'
import { characterWorkspaceKey, createCharacterWorkspace } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'
import { simulationInitialPromptKey } from '../dist/backend/modules/simulation/infrastructure/simInitialPrompt.js'
import { characterKey, createEmptyCharacterState, validateCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createDefaultSimSession, dayKey } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { createSimSessionStore, SIMULATION_KNOWN_GROUPS_KEY, SIMULATION_OVERRIDES_KEY, simulationBudgetCarryoverKey, simulationBusyKey,
  simulationNotebookKey, simulationRhythmKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const runNode = promisify(execFile)
const agentEntry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const BOT = 3094088525
const USER = 40001
const GROUP = 10086
const FIRST = 71501
const SECOND = 71502
const REMOVED = 71503
const auth = 'local-onebot-fixture'
const prefix = 'bl-agent:standalone-test:'
const forwardText = '修订后的公开活动流程'
const recalledForwardText = '读取时撤回的转发正文'
const fixturePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const key = prefix + 'shiloh:sim:g:' + simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(GROUP) })

async function waitUntil(predicate, what, timeout = 8_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await delay(30)
  }
  assert.fail(`等待超时：${what}`)
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

test('QQ image downloads pin a public QQ CDN address and reject other resources', async () => {
  const calls = []
  const guard = { signal: AbortSignal.timeout(5_000), isCurrent: () => true, authorize: async () => true }
  const publicAddress = { address: '8.8.8.8', family: 4 }
  const dependencies = {
    lookup: async host => { calls.push({ host }); return [publicAddress] },
    request: async (url, address) => { calls.push({ url: url.href, address }); return Buffer.from(fixturePng, 'base64') },
  }
  const signedUrl = 'http://multimedia.nt.qq.com.cn/download?appid=1406&fileid=image&rkey=fixture'
  const image = await readQqMessageImage({ kind: 'url', value: signedUrl }, guard, dependencies)
  assert.deepEqual(image, { mime: 'image/png', base64: fixturePng })
  assert.deepEqual(calls.splice(0), [{ host: 'multimedia.nt.qq.com.cn' }, { url: signedUrl.replace('http:', 'https:'), address: publicAddress }])
  for (const url of ['https://127.0.0.1/image', 'https://multimedia.nt.qq.com.cn.evil.test/download',
    'https://gchat.qpic.cn:8443/download', 'https://x@gchat.qpic.cn/download', 'https://gchat.qpic.cn/api']) {
    assert.equal(await readQqMessageImage({ kind: 'url', value: url }, guard, dependencies), undefined)
  }
  assert.equal(await readQqMessageImage({ kind: 'reference', value: '/tmp/private.png' }, guard, dependencies), undefined)
  assert.equal(await readQqMessageImage({ kind: 'reference', value: 'base64://AAAA' }, guard, dependencies), undefined)
  assert.deepEqual(calls, [])
  const resource = { kind: 'url', value: signedUrl }
  assert.equal(await readQqMessageImage(resource, guard, {
    ...dependencies, lookup: async () => [publicAddress, { address: '127.0.0.1', family: 4 }],
  }), undefined)
  assert.equal(await readQqMessageImage(resource, guard, {
    ...dependencies, lookup: async () => [{ address: '2::1', family: 6 }],
  }), undefined)
  assert.equal(await readQqMessageImage(resource, { ...guard, authorize: async () => false }, dependencies), undefined)
  assert.deepEqual(calls.splice(0), [{ host: 'multimedia.nt.qq.com.cn' }])
  for (const bytes of [Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from(fixturePng, 'base64')]) {
    if (bytes.length < 1024) bytes.writeUInt32BE(32_000, 16)
    assert.equal(await readQqMessageImage(resource, guard, { ...dependencies, request: async () => bytes }), undefined)
  }
})

describe('standalone QQ recovery and migration checkpoints', { skip: redisAvailable ? false : 'redis-server unavailable', concurrency: false }, () => {
  let directory, socket, redisProcess, redis, config, bindingFile, hostConfig, env
  const children = []
  const hostLogs = []
  const hostStartTimes = []
  const migrationTimes = []
  let checkpointReady = true
  const backend = createServer()
  const platform = new WebSocketServer({ noServer: true })
  const deliveries = []
  const requestedMessageIds = []
  const readableMessages = new Map()
  const requestedForwards = []
  const readableForwards = new Map()
  const requests = []
  const directRequests = []
  const groupTextRequests = []
  const groupToolRequests = []
  const failureNotices = []
  const modelGates = new Map()
  const toolCalls = new Map()
  const privateEvents = new EventEmitter()
  let loginId = BOT
  let confirmations = 0
  let websocket
  let upgrades = 0
  let repliedToModelTurn = false
  let loseNextPrivateReceipt = false
  const compatibilityGates = new Map()
  after(async () => {
    await Promise.allSettled(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => {
      const ended = once(child, 'exit')
      child.kill('SIGKILL')
      return ended
    }))
    for (const client of platform.clients) client.terminate()
    await new Promise(resolve => platform.close(resolve))
    backend.closeAllConnections()
    await new Promise(resolve => backend.close(resolve))
    if (redis?.isOpen) await redis.close()
    if (redisProcess && redisProcess.exitCode === null && redisProcess.signalCode === null) {
      const ended = once(redisProcess, 'exit')
      redisProcess.kill('SIGTERM')
      await ended
    }
    if (directory) await fs.rm(directory, { force: true, recursive: true })
  })

  backend.on('upgrade', (request, connection, head) => {
    if (request.url !== '/' || request.headers.authorization !== `Bearer ${auth}`) { connection.destroy(); return }
    platform.handleUpgrade(request, connection, head, client => platform.emit('connection', client))
  })
  platform.on('connection', client => {
    websocket = client
    upgrades++
    client.on('message', raw => {
      const request = JSON.parse(String(raw))
      if (request.action === 'get_login_info') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: loginId, nickname: '独立 QQ' } }))
        return
      }
      if (request.action === 'get_msg') {
        requestedMessageIds.push(request.params.message_id)
        const data = readableMessages.get(request.params.message_id)
        client.send(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 100, echo: request.echo, data }))
        return
      }
      if (request.action === 'get_forward_msg') {
        const id = request.params.id
        const data = readableForwards.get(id)
        requestedForwards.push({ params: request.params, respond: () => {
          if (client.readyState === client.OPEN) client.send(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 100, echo: request.echo, data }))
        } })
        if (id !== 'waiting-forward') requestedForwards.at(-1).respond()
        return
      }
      deliveries.push(request)
      if (request.action === 'send_private_msg' && loseNextPrivateReceipt) {
        loseNextPrivateReceipt = false
        privateEvents.emit('receipt-lost')
        return
      }
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: 88000 + ++confirmations } }))
    })
  })
  backend.on('request', async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    if (body.messages[0]?.content.includes('你只负责为当前真人请求写一条简短、自然的失败说明')) {
      failureNotices.push(body)
      const fact = JSON.parse(body.messages.at(-1).content)
      const content = fact.outcome === 'unknown' ? '这次操作结果未确认，请先核实。' : fact.detail ?? '这次请求没有成功。'
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'local-test', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
      return
    }
    const retryProbe = [...compatibilityGates.entries()].find(([text]) => body.messages.some(row => String(row.content).includes(text)))?.[1]
    if (retryProbe) {
      retryProbe.calls.push(body)
      response.writeHead(400).write('unsupported generation parameter')
      await retryProbe.complete.promise
      response.end()
      return
    }
    const direct = body.messages[0]?.content.includes('【私聊场景】')
    const groupText = body.messages[0]?.content.includes('当前群提供文字回复')
    if (direct || groupText) {
      const chatRequests = direct ? directRequests : body.tools?.length ? groupToolRequests : groupTextRequests
      chatRequests.push(body)
      const query = body.messages.at(-1)?.content
      await modelGates.get(query)
      const content = direct ? '独立私聊已收到' : query === '给我创建明早的提醒' ? '已经设置好了，明早会提醒你。' : '独立群聊已收到'
      const tools = toolCalls.get(query)
      const message = tools ? { role: 'assistant', content: null, tool_calls: tools } : { role: 'assistant', content }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'local-test', choices: [{ message, finish_reason: tools ? 'tool_calls' : 'stop' }],
      }))
      return
    }
    const lastWake = body.messages.findLastIndex(row => row.role === 'user' && String(row.content).includes('【执行主体】'))
    const wakeText = String(body.messages[lastWake]?.content)
    const forwardCommand = wakeText.match(/^#(\d+) [^\n]*\[@你\][^\n]*(?:同群|越群|不匹配|撤回)转发验收[^\n]*\[合并转发，可用 simGetForward 查看\]/gmu)?.at(-1)
    if (forwardCommand) {
      const calls = body.messages.slice(lastWake).filter(row => row.role === 'tool')
      const forwardSeq = Number(forwardCommand.match(/^#(\d+)/u)?.[1])
      const sequence = forwardCommand.includes('同群转发验收') ? [{ seq: 1 }] : []
      const callPrefix = `forward-test-${forwardSeq}`
      let message
      if (!calls.length) {
        message = { role: 'assistant', content: '', tool_calls: [...sequence, { seq: forwardSeq }, { forwardId: 'unseen-forward' }].map((args, index) => ({
          id: `${callPrefix}-${index}`, type: 'function', function: { name: 'simGetForward', arguments: JSON.stringify(args) },
        })) }
      } else {
        const read = calls.some(row => row.tool_call_id === `${callPrefix}-${sequence.length}` && String(row.content).includes(forwardText))
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'forward-test-finish', type: 'function', function: {
          name: 'simFinishTurn', arguments: JSON.stringify({ choice: read ? 'chat' : 'silent', reason: '合并转发读取验收',
            ...(read ? { messages: ['合并转发已读到公开活动安排。'], replyToSeq: forwardSeq } : {}) }),
        } }] }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'local-test', choices: [{ message, finish_reason: 'tool_calls' }],
      }))
      return
    }
    const nudge = wakeText.includes('戳了戳你')
    const scheduled = wakeText.includes('验收迁入的仿真承诺')
    const timeout = wakeText.includes('【唤醒原因】timeout')
    const message = scheduled
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'scheduled-finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'chat', reason: '兑现到期承诺', messages: ['迁入的仿真承诺已完成'] }),
      } }] }
      : timeout
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'timeout-finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '定时观察已结束' }),
      } }] }
      : repliedToModelTurn
      ? { role: 'assistant', content: '' }
      : { role: 'assistant', content: '', tool_calls: [{
        id: `send-${requests.length}`, type: 'function', function: {
          name: 'simSendMessage', arguments: JSON.stringify({ continuation: 'chat', messages: [`恢复回复 ${confirmations + 1}`],
            ...(!nudge ? { replyToSeq: confirmations + 1 } : {}), atUserIds: [String(USER)] }),
        },
      }] }
    repliedToModelTurn = true
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      model: 'local-test', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }))
  })
  const bindingConfig = {
    version: 1, agents: [{ id: 'local-agent', personaId: 'default' }, { id: 'another-agent', personaId: 'default' }],
    connections: [{ id: 'qq-local', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: [
      { connectionId: 'qq-local', kind: 'group', conversationId: String(GROUP), agentId: 'local-agent' },
      { connectionId: 'qq-local', kind: 'private', conversationId: String(USER), agentId: 'local-agent' },
    ],
  }
  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bl-agent-qq-'))
    socket = path.join(directory, 'redis.sock')
    redisProcess = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
    await waitUntil(() => fs.stat(socket).then(() => true, () => false), 'fixture Redis socket')
    redis = createClient({ socket: { path: socket, reconnectStrategy: false } })
    redis.on('error', () => {})
    await redis.connect()
    const port = await listen(backend)
    config = path.join(directory, 'agent-host.yaml')
    bindingFile = path.join(directory, 'agent-bindings.yaml')
    hostConfig = {
      version: 1, instance: 'standalone-test', dataDir: 'data',
      persona: { name: '独立群聊角色', identity: '仅用于本地端到端验收' },
      model: { baseUrl: `http://127.0.0.1:${port}`, name: 'local-test', apiKeyEnv: 'TEST_AGENT_MODEL_KEY' },
      simulation: { wake: { batchWindowMs: 4_000, probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 5 } },
      privateChat: { enabled: true },
      forbiddenWords: { words: ['禁止输入样本'] },
      connections: [{ id: 'qq-local', url: `ws://127.0.0.1:${port}/`, accessTokenEnv: 'TEST_AGENT_ONEBOT_TOKEN' }],
    }
    await fs.writeFile(config, YAML.stringify(hostConfig))
    await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socket}`, TEST_AGENT_MODEL_KEY: 'isolated-key', TEST_AGENT_ONEBOT_TOKEN: auth }
  })
  function launch() {
    const startedAt = performance.now()
    const startup = { readyMs: null }
    hostStartTimes.push(startup)
    const child = spawn(process.execPath, [agentEntry, '--config', config], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => {
      log += value
      if (startup.readyMs === null && log.includes('已启动')) startup.readyMs = Math.round(performance.now() - startedAt)
    })
    hostLogs.push(() => log)
    return { child, get log() { return log } }
  }
  async function stop(app, signal) {
    const done = once(app.child, 'exit')
    app.child.kill(signal)
    return await done
  }
  async function session() { return JSON.parse(await redis.get(key) ?? 'null') }
  const emit = value => websocket.send(JSON.stringify(value))
  const legacyInbox = prefix + 'agent:inbox'
  const simulationInbox = prefix + `agent:inbox:simulation:${JSON.stringify(['qq', 'global', String(BOT)])}`
  const inboxLength = () => redis.lLen(simulationInbox)
  const noticeTime = Math.floor(Date.now() / 1000)
  const groupMessage = (messageId, text, extra = {}) => ({
    post_type: 'message', message_type: 'group', self_id: BOT, user_id: USER, group_id: GROUP,
    time: Math.floor(Date.now() / 1000), message_id: messageId, sender: { nickname: '验收群友' },
    message: [{ type: 'at', data: { qq: String(BOT) } }, { type: 'text', data: { text } }], ...extra,
  })
  const poke = {
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: BOT,
    group_id: GROUP, user_id: USER, target_id: BOT, time: noticeTime,
  }

  // Keep one isolated persistence chain: each yield is a durable recovery or
  // cutover checkpoint. A stage has its own bounded deadline; later stages are
  // skipped if a prerequisite fails, and suite cleanup still closes everything.
  const checkpointNames = [
    'restores simulation ingress, reconnects, and acknowledges a recovered nudge',
    'restores private turns and retires recalled, rebound, or uncertain sends',
    'switches a persisted simulation source to group text and restores confirmed context',
    'scopes group tools and restores action receipts without replaying side effects',
    'prepares legacy reminders, memory provenance, and protected source facts',
    'previews migration and rejects active, conflicting, or unwritable destinations',
    'atomically migrates group and friend state and preserves retry semantics',
    'runs migrated state with scoped memory, recall, budgets, and uncertain reminders',
    'migrates timeout policy and due simulation commitments',
    'migrates character goals, workspace, and reflection schedules',
    'resumes migrated timers and goals and verifies original QQ reply sources',
    'reads authorized forwards and retires recalled or rebound model work',
    'rejects an unexpected QQ account and keeps fixture credentials out of logs',
  ]
  const checkpoints = recoveryCheckpoints()
  let nextCheckpointIndex = 0
  for (const [index, name] of checkpointNames.entries()) {
    test(name, { timeout: 90_000 }, async phase => {
      if (!checkpointReady) { phase.skip('the preceding persistence checkpoint did not complete'); return }
      if (index !== nextCheckpointIndex) {
        phase.skip('the preceding persistence checkpoint was not selected')
        return
      }
      checkpointReady = false
      const hostStart = hostStartTimes.length
      const migrationStart = migrationTimes.length
      try {
        const { done } = await checkpoints.next()
        assert.equal(done, index === checkpointNames.length - 1, 'each scenario ends at its expected persistence checkpoint')
        nextCheckpointIndex = index + 1
        checkpointReady = true
      } finally {
        const startups = hostStartTimes.slice(hostStart).flatMap(item => item.readyMs === null ? [] : [item.readyMs])
        const migrations = migrationTimes.slice(migrationStart)
        phase.diagnostic(`host readiness ms: ${startups.join(', ') || 'none'}; migration CLI ms: ${migrations.join(', ') || 'none'}`)
        if (!checkpointReady) for (const getLog of hostLogs) phase.diagnostic(getLog())
      }
    })
  }

  async function* recoveryCheckpoints() {
    const first = launch()
    await waitUntil(() => first.log.includes('已启动'), 'first standalone process online', 15_000)
    const duplicate = launch()
    const [duplicateCode] = await once(duplicate.child, 'exit')
    assert.equal(duplicateCode, 1)
    assert.match(duplicate.log, /host\/host_run failed host_exception/)
    assert.match(duplicate.log, /独立宿主启动或检查失败/)
    assert.equal(upgrades, 1)

    emit(groupMessage(9991, '未授权群', { group_id: GROUP + 1 }))
    emit(groupMessage(9992, '错误账号', { self_id: BOT + 1 }))
    emit(groupMessage(9993, '机器人自身', { user_id: BOT }))
    repliedToModelTurn = false
    emit(groupMessage(FIRST, '等待恢复的 QQ 消息'))
    emit(groupMessage(FIRST, '重复投递'))
    await waitUntil(async () => (await session())?.queuedIngressWake, 'wake written before the model call')
    assert.equal(requests.length, 0)
    assert.equal((await session()).seq, 1)
    assert.equal(await redis.get(`shiloh:sim:g:${GROUP}`), null)
    assert.deepEqual(await stop(first, 'SIGTERM'), [0, null])
    assert.equal(await redis.get(prefix + 'agent:host-lease'), null)

    const second = launch()
    await waitUntil(() => second.log.includes('已启动'), 'second standalone process online', 15_000)
    await waitUntil(() => deliveries.length === 1, 'OneBot message after restart')
    assert.equal(deliveries[0].action, 'send_group_msg')
    assert.equal(deliveries[0].params.group_id, GROUP)
    assert.deepEqual(deliveries[0].params.message.slice(0, 2), [
      { type: 'reply', data: { id: String(FIRST) } }, { type: 'at', data: { qq: String(USER) } },
    ])
    assert.ok(requests[0].messages.some(row => String(row.content).includes('等待恢复的 QQ 消息')))
    assert.ok(requests[0].messages.some(row => String(row.content).includes('独立群聊角色')))
    assert.ok(requests.every(item => item.messages.every(row => !/未授权群|错误账号|机器人自身|重复投递/u.test(String(row.content)))))
    await waitUntil(async () => (await session())?.confirmedMessageIds?.includes('88001'), 'confirmed message receipt persisted')
    await waitUntil(async () => !await redis.get(prefix + 'shiloh:sim:busy:' + key.slice((prefix + 'shiloh:sim:g:').length)), 'first restored turn finished')

    websocket.terminate()
    await waitUntil(() => second.log.includes('host/onebot_recovery succeeded'), 'OneBot reconnect verifies account again')
    const literalMention = `[CQ:at,qq=${BOT}]`
    repliedToModelTurn = false
    emit(groupMessage(SECOND, '', {
      message: `[CQ:reply,id=88001]引用 &#91;CQ:at,qq=${BOT}&#93; &amp; &amp;#91;`
        + '[CQ:image,file=example.png,url=https://example.invalid/image.png?name=a&#44;b&amp;size=1]',
    }))
    await waitUntil(() => deliveries.length === 2, 'reply-to-bot wakes the matching QQ group')
    assert.equal(deliveries[1].params.message[0].data.id, String(SECOND))
    const reply = (await session()).recent.find(message => message.messageId === String(SECOND))
    assert.equal(reply.quoteToSelf, true)
    assert.equal(reply.atSelf, false)
    assert.equal(reply.text, `引用 ${literalMention} & &#91;`)
    assert.equal(reply.imageCount, 1)
    assert.equal(reply.imageUrls, undefined, 'image-capable adapters retain the source identity and reload bytes instead of persisting image URLs')
    await waitUntil(async () => (await session())?.confirmedMessageIds?.includes('88002') && !(await session())?.queuedIngressWake,
      'reply turn consumed its wake')
    emit(groupMessage(REMOVED, '撤回前的最后一条'))
    emit({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: GROUP, message_id: REMOVED })
    await waitUntil(async () => {
      const state = await session()
      const receipts = await redis.keys(prefix + 'agent:inbox:receipt:*')
      return state.seq >= 2 && !state.recent.some(message => String(message.messageId) === String(REMOVED))
        && receipts.length === 4 && await inboxLength() === 0
    }, 'recalled message removed or rejected on intake')
    await waitUntil(async () => !await redis.get(prefix + 'shiloh:sim:busy:' + key.slice((prefix + 'shiloh:sim:g:').length)), 'reply turn finished')

    emit({ ...poke, target_id: BOT + 1 })
    emit({ ...poke, group_id: GROUP + 1 })
    emit({ ...poke, self_id: BOT + 1 })
    emit({ ...poke, user_id: BOT })
    emit({ ...poke, group_id: undefined })
    emit(poke)
    const wake = await waitUntil(async () => {
      const state = await session()
      const nudges = state.recent.filter(message => message.kind === 'poke')
      return nudges.length === 1 && state.queuedIngressWake?.seq === nudges[0].seq && await inboxLength() === 0 ? nudges[0] : false
    }, 'only the addressed nudge is durably queued', 4_000)
    assert.equal(wake.userId, String(USER))
    assert.equal(wake.messageId, null)
    assert.equal(wake.at, noticeTime * 1000)
    assert.equal(deliveries.length, 2)
    assert.deepEqual(await stop(second, 'SIGTERM'), [0, null])
    // Simulate a crash after saving the interaction and before acknowledging its queue item.
    const savedNudge = await session()
    await redis.rPush(legacyInbox, JSON.stringify({
      event: {
        kind: 'nudge', target: { account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(GROUP) },
        sender: { platform: 'qq', namespace: 'global', id: String(USER) }, occurredAt: wake.at,
      },
      bindingToken: savedNudge.bindingToken, ingressId: wake.ingressId,
    }))

    repliedToModelTurn = false
    const third = launch()
    await waitUntil(() => third.log.includes('已启动'), 'third standalone process online', 15_000)
    assert.equal(await redis.lLen(legacyInbox), 0)
    assert.equal(await inboxLength(), 0)
    assert.equal((await session()).recent.filter(message => message.kind === 'poke').length, 1)
    await waitUntil(() => requests.some(request => request.messages.some(row => String(row.content).includes('戳了戳你'))), 'model received restored nudge')
    await waitUntil(() => deliveries.length === 3 || third.log.includes('回合完成'), 'nudge turn ended')
    assert.equal(deliveries.length, 3, JSON.stringify({
      messages: requests.at(-1)?.messages.slice(-3).map(row => ({role: row.role, tools: row.tool_calls?.map(call => call.function.name)})),
      logs: third.log,
    }))
    assert.equal(deliveries[2].params.group_id, GROUP)
    assert.deepEqual(deliveries[2].params.message[0], { type: 'at', data: { qq: String(USER) } })
    await waitUntil(async () => (await session())?.confirmedMessageIds?.includes('88003'), 'nudge reply confirmed')
    yield

    const privateMessage = (message_id, message, overrides = {}) => ({
      post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: BOT, user_id: USER,
      message_id, time: Math.floor(Date.now() / 1000), message, ...overrides,
    })
    const recall = (message_id, overrides = {}) => ({ post_type: 'notice', notice_type: 'friend_recall', self_id: BOT, user_id: USER, message_id, ...overrides })
    const privateAddress = JSON.stringify(['qq', 'global', String(BOT), 'private', String(USER)])
    const privateQueue = prefix + `agent:inbox:private-conversation:${privateAddress}`
    const privateHistory = prefix + `agent:private-history:${privateAddress}`
    const getPrivateHistory = async () => JSON.parse(await redis.get(privateHistory) ?? 'null')
    const lastPromptContains = text => directRequests.at(-1)?.messages.some(row => row.content.includes(text))

    emit(privateMessage(95002, '未绑定的好友', { user_id: USER + 1 }))
    emit(privateMessage(95003, '已绑定好友的群临时会话', { sub_type: 'group' }))
    emit(privateMessage(95004, '账号错误的私聊', { self_id: BOT + 1 }))
    emit(privateMessage(95005, '伪装成好友的临时会话', { group_id: GROUP }))
    emit(privateMessage(95006, '#tool 普通插件命令'))
    emit(privateMessage(95007, '禁止输入样本'))
    emit(privateMessage(95008, '已过期的私聊', { time: Math.floor(Date.now() / 1000) - 7200 }))
    emit(privateMessage(95001, 'QQ 好友私聊'))
    emit(privateMessage(95001, '重投的 QQ 好友私聊'))
    await waitUntil(() => deliveries.length === 4, 'standalone replies to an explicitly bound QQ friend')
    assert.deepEqual({ action: deliveries[3].action, params: deliveries[3].params }, {
      action: 'send_private_msg', params: { user_id: USER, message: [{ type: 'text', data: { text: '独立私聊已收到' } }] },
    })
    assert.equal(directRequests.length, 1)
    assert.deepEqual(directRequests[0].tools.map(item => item.function.name), ['commitmentTool'])
    assert.ok(lastPromptContains('独立群聊角色'))
    assert.ok(!lastPromptContains('等待恢复的 QQ 消息'))
    await waitUntil(async () => (await getPrivateHistory())?.turns[0]?.user === 'QQ 好友私聊' && await redis.lLen(privateQueue) === 0, 'private receipt and history persisted')
    const lifetime = await redis.pTTL(privateHistory)
    assert.ok(lifetime > 0 && lifetime <= 3_600_000)
    assert.deepEqual(await stop(third, 'SIGTERM'), [0, null])

    const fourth = launch()
    await waitUntil(() => fourth.log.includes('已启动'), 'fourth standalone process online', 15_000)
    emit(recall(95001, { user_id: USER + 1 }))
    emit(privateMessage(95009, '重启后的私聊'))
    await waitUntil(() => deliveries.length === 5, 'private reply after restart')
    assert.ok(lastPromptContains('QQ 好友私聊'))
    assert.ok(lastPromptContains('独立私聊已收到'))
    await waitUntil(async () => (await getPrivateHistory())?.turns.at(-1).user === '重启后的私聊', 'second private turn committed')

    const held = Promise.withResolvers()
    modelGates.set('撤回后不应送出的回复', held.promise)
    emit(privateMessage(95010, [
      { type: 'reply', data: { id: 95001 } },
      { type: 'text', data: { text: '撤回后不应送出的回复' } },
      { type: 'image', data: { file: 'fixture.png', url: 'https://example.invalid/private-media' } },
    ]))
    await waitUntil(() => lastPromptContains('撤回后不应送出的回复'), 'private model starts before a prior source is recalled')
    const queuedPrivate = JSON.parse(await redis.lIndex(privateQueue, 0)).event.message
    assert.deepEqual(queuedPrivate.parts, [{ kind: 'text', text: '撤回后不应送出的回复' }])
    assert.equal(queuedPrivate.quote, undefined)
    assert.equal(lastPromptContains('https://example.invalid/private-media'), false)
    emit(recall(95001))
    await waitUntil(() => redis.get(prefix + `agent:private-recall:${privateAddress}`), 'private recall accepted while model is pending')
    assert.equal(await getPrivateHistory(), null)
    held.resolve()
    await waitUntil(async () => await redis.lLen(privateQueue) === 0, 'private recall invalidates the running turn')
    assert.equal(deliveries.length, 5)

    emit(privateMessage(95011, '撤回后的新消息'))
    await waitUntil(() => deliveries.length === 6, 'new private turn after recall')
    assert.equal(lastPromptContains('QQ 好友私聊'), false)
    assert.equal(lastPromptContains('重启后的私聊'), false)
    assert.ok(!lastPromptContains('撤回后不应送出的回复'))

    const changing = Promise.withResolvers()
    modelGates.set('等待换绑的私聊', changing.promise)
    emit(privateMessage(95012, '等待换绑的私聊'))
    await waitUntil(() => lastPromptContains('等待换绑的私聊'), 'private model starts under the old role')
    bindingConfig.bindings[1].agentId = 'another-agent'
    await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    changing.resolve()
    await waitUntil(async () => await redis.lLen(privateQueue) === 0, 'obsolete private binding drained')
    assert.equal(deliveries.length, 6)

    loseNextPrivateReceipt = true
    const lost = once(privateEvents, 'receipt-lost')
    emit(privateMessage(95013, '换绑后的第一条私聊'))
    await lost
    assert.equal(lastPromptContains('撤回后的新消息'), false)
    assert.equal(deliveries.length, 7)
    assert.deepEqual(await stop(fourth, 'SIGKILL'), [null, 'SIGKILL'])
    assert.equal(await redis.lLen(privateQueue), 1)
    // Let the next process acquire the fixture lease immediately after the old process died.
    await redis.del(prefix + 'agent:host-lease')
    const fifth = launch()
    await waitUntil(() => fifth.log.includes('已启动'), 'standalone restarts after uncertain private delivery', 15_000)
    await waitUntil(async () => await redis.lLen(privateQueue) === 0, 'attempted private send is consumed without retry')
    assert.equal(deliveries.length, 7)
    assert.equal(directRequests.filter(item => item.messages.at(-1).content === '换绑后的第一条私聊').length, 1)
    emit(privateMessage(95014, '不应看到未确认的回复'))
    await waitUntil(() => deliveries.length === 8, 'private conversation remains usable after an uncertain send')
    assert.equal(lastPromptContains('换绑后的第一条私聊'), false)
    await waitUntil(async () => (await getPrivateHistory())?.turns.at(-1)?.user === '不应看到未确认的回复' && await redis.lLen(privateQueue) === 0,
      'confirmed private turn is saved and acknowledged before the next restart fixture')
    assert.deepEqual(await stop(fifth, 'SIGTERM'), [0, null])

    const target = { account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'private', id: String(USER) }
    const inbox = createAgentInbox({ get: name => redis.get(prefix + name), eval: (script, options) => redis.eval(script, { ...options, keys: options.keys.map(name => prefix + name) }) })
    const savedHistory = await getPrivateHistory()
    assert.equal(savedHistory.turns.at(-1).user, '不应看到未确认的回复')
    await inbox.accept({
      event: { kind: 'message', message: { version: 1, conversation: target, sender: { ...target.account, id: target.id },
        messageId: '95015', occurredAt: Date.now(), text: '进程重启前已收件', parts: [], mentions: [], directedToAccount: true } },
      bindingToken: savedHistory.bindingToken,
    })
    assert.equal(await redis.lLen(privateQueue), 1)
    const sixth = launch()
    await waitUntil(() => sixth.log.includes('已启动'), 'standalone restarts with an unattempted private message', 15_000)
    await waitUntil(() => deliveries.length === 9, 'saved private message is answered after restart')
    assert.ok(lastPromptContains('进程重启前已收件'))
    assert.ok(lastPromptContains('不应看到未确认的回复'))
    await waitUntil(async () => (await getPrivateHistory())?.turns.at(-1)?.user === '进程重启前已收件' && await redis.lLen(privateQueue) === 0,
      'recovered private receipt and queue acknowledgement finish before disabling private chat')
    assert.deepEqual(await stop(sixth, 'SIGTERM'), [0, null])

    delete hostConfig.privateChat
    await fs.writeFile(config, YAML.stringify(hostConfig))
    const disabled = launch()
    await waitUntil(() => disabled.log.includes('已启动'), 'standalone starts with the default private switch', 15_000)
    const requestCount = directRequests.length
    emit(privateMessage(95016, '默认关闭的私聊'))
    await delay(200)
    assert.equal(directRequests.length, requestCount)
    assert.equal(await redis.lLen(privateQueue), 0)
    // A bindings-file revision retires the earlier simulation context, including
    // its recent messages. Capture a genuine current source before changing modes.
    const pendingSimulationId = '95999'
    const modelCountBeforeModeChange = requests.length
    emit(groupMessage(Number(pendingSimulationId), '切换文字模式前已收件'))
    const groupState = await waitUntil(async () => {
      const state = await session()
      const source = state?.recent.find(message => message.messageId === pendingSimulationId)
      return source && state.queuedIngressWake?.kind === 'atMention' && state.queuedIngressWake.seq === source.seq &&
        await inboxLength() === 0 ? state : null
    }, 'current simulation source and wake are persisted before changing modes')
    assert.deepEqual(await stop(disabled, 'SIGTERM'), [0, null])
    assert.equal(requests.length, modelCountBeforeModeChange)
    assert.equal(deliveries.length, 9)
    yield

    const groupTarget = { account: target.account, kind: 'group', id: String(GROUP) }
    const groupAddress = JSON.stringify(['qq', 'global', String(BOT), 'group', String(GROUP)])
    const groupTextQueue = prefix + `agent:inbox:group-text:${JSON.stringify(['qq', 'global', String(BOT)])}`
    const groupTextHistory = prefix + `agent:group-text-history:${groupAddress}`
    const groupMessageReceipt = id => prefix + 'agent:inbox:receipt:' + createHash('sha256')
      .update(JSON.stringify(['message', groupAddress, String(id)])).digest('hex')
    const textState = async () => JSON.parse(await redis.get(groupTextHistory) ?? 'null')
    const whenTextSettles = id => waitUntil(async () => {
      const state = await textState()
      return state?.turns.at(-1).replyId === String(id) && await redis.lLen(groupTextQueue) === 0 ? state : null
    }, 'group text reply and receipt persisted')
    const textOptions = [{ connectionId: 'qq-local', conversationId: String(GROUP) }]
    const current = readStandaloneAgentConfig(config, env).resolvePersona(groupTarget).binding
    assert.equal(groupState.bindingToken, agentBindingToken(current))
    assert.deepEqual(await session(), groupState)
    hostConfig.textGroups = textOptions
    await fs.writeFile(config, YAML.stringify(hostConfig))
    const textHost = launch()
    await waitUntil(() => textHost.log.includes('已启动'), 'standalone launches one configured group in text mode', 15_000)
    const groupText = (id, text, segments = [], extra = {}) => groupMessage(id, text, {
      message: [...segments, {type: 'text', data: {text}}], ...extra,
    })
    const at = [{type: 'at', data: {qq: String(BOT)}}]
    const quoteOf = id => [{type: 'reply', data: {id}}]
    const groupRecall = id => ({post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: GROUP, message_id: id})

    emit(poke)
    emit(groupText(96001, '普通群消息'))
    emit(groupText(96002, '引用仿真模式的回复', quoteOf(88003)))
    emit(groupText(96003, '#tool 不该进入独立文字模式', at))
    emit(groupText(96004, '其他账号的群消息', at, {self_id: BOT + 1}))
    emit(groupText(96005, '其他群的消息', at, {group_id: GROUP + 1}))
    emit(groupText(96006, '群里第一次点名', at))
    emit(groupText(96006, '重复投递', at))
    await waitUntil(() => deliveries.length === 10, 'group mention receives a text reply')
    assert.deepEqual(deliveries.at(-1).params, {
      group_id: GROUP, message: [{ type: 'reply', data: { id: '96006' } }, { type: 'text', data: { text: '独立群聊已收到' } }],
    })
    assert.equal(deliveries.at(-1).action, 'send_group_msg')
    assert.equal(groupTextRequests.length, 1)
    assert.equal(groupTextRequests[0].tools, undefined)
    assert.ok(groupTextRequests[0].messages.some(row => String(row.content).includes('独立群聊角色')))
    assert.equal((await session()).seq, groupState.seq)
    const firstTextReply = confirmations + 88000
    await whenTextSettles(firstTextReply)
    assert.deepEqual(await stop(textHost, 'SIGTERM'), [0, null])

    const restoredText = launch()
    await waitUntil(() => restoredText.log.includes('已启动'), 'standalone restores group text mode and confirmed context', 15_000)
    emit(groupText(96007, '同一位群友继续问', quoteOf(firstTextReply)))
    await waitUntil(() => deliveries.length === 11, 'confirmed group quote triggers after restart')
    assert.ok(groupTextRequests.at(-1).messages.some(row => row.content === '群里第一次点名'))
    await whenTextSettles(confirmations + 88000)
    emit(groupText(96008, '另一位群友问同一件事', quoteOf(firstTextReply), {user_id: USER + 1}))
    await waitUntil(() => deliveries.length === 12, 'a second speaker can address the account by quote')
    assert.equal(groupTextRequests.at(-1).messages.some(row => /群里第一次点名|同一位群友继续问/u.test(String(row.content))), false)
    await whenTextSettles(confirmations + 88000)

    const revoked = Promise.withResolvers()
    modelGates.set('即将撤回的群消息', revoked.promise)
    emit(groupText(96009, '即将撤回的群消息', at))
    await waitUntil(() => groupTextRequests.at(-1)?.messages.at(-1)?.content === '即将撤回的群消息', 'group text model starts before recall')
    const recallKey = prefix + `agent:group-text-recall:${groupAddress}`
    const beforeRecall = await redis.get(recallKey)
    emit(groupRecall(96009))
    await waitUntil(async () => await redis.get(recallKey) !== beforeRecall, 'group recall recorded before finishing model')
    revoked.resolve()
    await waitUntil(async () => await redis.lLen(groupTextQueue) === 0, 'recalled group reply is discarded')
    assert.equal(await textState(), null)
    assert.equal(deliveries.length, 12)

    emit(groupText(96010, '给我创建明早的提醒', at))
    await waitUntil(() => deliveries.length === 13, 'an unsupported reminder promise gets a grounded text response')
    assert.doesNotMatch(deliveries.at(-1).params.message.at(-1).data.text, /已经设置|会提醒你/u)
    await whenTextSettles(confirmations + 88000)
    const obsoleteTextToken = (await textState()).bindingToken
    assert.deepEqual(await stop(restoredText, 'SIGTERM'), [0, null])

    await inbox.accept({
      event: {kind: 'message', message: {version: 1, conversation: groupTarget, sender: {...target.account, id: String(USER)},
        messageId: '96011', occurredAt: Date.now(), text: '旧模式排队的群消息', parts: [], mentions: [], directedToAccount: true}},
      bindingToken: obsoleteTextToken,
    }, {kind: 'group', account: groupTarget.account})
    await fs.writeFile(config, YAML.stringify(hostConfig) + '\n# 保存后的新运行配置\n')
    const textReconfigured = launch()
    await waitUntil(() => textReconfigured.log.includes('已启动'), 'standalone restarts with a new text mode revision', 15_000)
    await waitUntil(async () => await redis.lLen(groupTextQueue) === 0, 'old text-mode inbox entries are retired')
    assert.ok(groupTextRequests.every(body => body.messages.at(-1).content !== '旧模式排队的群消息'))
    emit(groupText(96012, '当日回合额度耗尽后的群消息', at))
    await waitUntil(async () => await redis.get(groupMessageReceipt(96012)) === '1' && await redis.lLen(groupTextQueue) === 0, 'quota check retires the next group message')
    assert.equal(deliveries.length, 13)
    assert.equal(groupTextRequests.length, 5)
    assert.deepEqual(await stop(textReconfigured, 'SIGTERM'), [0, null])
    yield

    hostConfig.simulation.turn.maxTurnsPerDay = 40
    hostConfig.textGroups = [{ ...textOptions[0], tools: ['commitmentTool', 'delegateMemoryTool'] }]
    hostConfig.privateChat = { enabled: true }
    await fs.writeFile(config, YAML.stringify(hostConfig))
    const toolHost = launch()
    await waitUntil(() => toolHost.log.includes('已启动'), 'standalone starts configured group tools', 15_000)
    const call = (name, args) => [{ id: 'fixture-tool-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    const textDelivery = () => deliveries.at(-1)?.params.message.at(-1).data.text
    async function callGroup(id, text, name, args, extra, failure = false) {
      toolCalls.set(text, call(name, args))
      const nextDelivery = deliveries.length + 1
      const previousHistory = await redis.get(groupTextHistory)
      const previousFailures = failureNotices.length
      emit(groupText(id, text, at, extra))
      await waitUntil(() => deliveries.length === nextDelivery, text)
      if (failure) {
        await waitUntil(async () => await redis.lLen(groupTextQueue) === 0, 'failed group tool reply is acknowledged')
        assert.equal(await redis.get(groupTextHistory), previousHistory, 'a failure explanation does not enter successful conversation history')
        assert.equal(failureNotices.length, previousFailures + 1)
        assert.equal(failureNotices.at(-1).tools?.length ?? 0, 0)
      } else await whenTextSettles(confirmations + 88000)
      return textDelivery()
    }
    const reminderText = '群里提醒我带纸质报告'
    const reminderRequest = `请明天中午${reminderText}`
    const reminderAt = new Date(Date.now() + 60 * 60_000).toISOString()
    const reminderArgs = { action: 'create', schedule_kind: 'once', schedule_time: reminderAt, static_message: reminderText }
    assert.match(await callGroup(97001, reminderRequest, 'commitmentTool', reminderArgs), /已登记.*文字提醒/)
    const pendingKey = prefix + 'bl-chat:commitment:pending:list'
    const [scheduled] = JSON.parse(await redis.get(pendingKey))
    const taskKey = prefix + `bl-chat:commitment:detail:${scheduled.id}`
    const task = JSON.parse(await redis.get(taskKey))
    assert.equal(task.creator_id, String(USER))
    assert.equal(task.bot_id, String(BOT))
    assert.equal(task.intent, reminderRequest)
    assert.equal(task.deliver, 'static')
    assert.equal(task.static_message, reminderText)
    assert.deepEqual(JSON.parse(task.scopeKey), ['local-agent', 'qq', 'global', String(BOT), 'group', String(GROUP)])
    const advertised = groupToolRequests[0].tools
    assert.deepEqual(advertised.map(item => item.function.name), ['commitmentTool', 'delegateMemoryTool'])
    assert.equal(advertised[0].function.parameters.properties.deliver, undefined)
    assert.equal(advertised[1].function.parameters.properties.due_time, undefined)

    const memory = '周五带一份纸质签字报告'
    assert.match(await callGroup(97002, `帮我记住${memory}`, 'delegateMemoryTool', { action: 'remember', content: memory }), /记下了/)
    const [memoryKey] = await redis.keys(prefix + 'bl-chat:delegated:v2:*')
    const [entry] = JSON.parse(await redis.get(memoryKey))
    assert.equal(entry.owner, String(USER))
    assert.equal(entry.content, memory)
    const recallArgs = { action: 'recall', query: '报告' }
    assert.doesNotMatch(await callGroup(97003, '告诉我那份报告的托付', 'delegateMemoryTool', recallArgs, { user_id: USER + 1 }), new RegExp(memory))
    assert.match(await callGroup(97004, '我刚才托付的报告是什么', 'delegateMemoryTool', recallArgs), new RegExp(memory))
    assert.ok(groupToolRequests.at(-1).messages.every(row => !String(row.content).includes(memory)))
    assert.ok((await textState()).turns.every(turn => !turn.user && !turn.reply))

    const forbidden = await callGroup(97005, '把提醒发到其他群', 'commitmentTool', { ...reminderArgs, action: 'create', group_id: GROUP + 2 }, undefined, true)
    assert.match(forbidden, /没有可用的调用结果/)
    assert.equal(JSON.parse(await redis.get(pendingKey)).length, 1)
    const beforePrivate = directRequests.length
    const beforePrivateDelivery = deliveries.length
    const privateQuery = '在私聊里帮我记住不能保存的句子'
    toolCalls.set(privateQuery, call('delegateMemoryTool', { action: 'remember', content: '不能保存的句子' }))
    emit(privateMessage(97006, privateQuery))
    await waitUntil(async () => directRequests.length > beforePrivate && deliveries.length > beforePrivateDelivery && await redis.lLen(privateQueue) === 0, 'private mode rejects a returned group tool call')
    assert.deepEqual(directRequests.at(-1).tools.map(item => item.function.name), ['commitmentTool'])
    assert.match(textDelivery(), /当前会话没有开放/)
    assert.equal(JSON.parse(await redis.get(memoryKey)).length, 1)

    const oldBindingReply = Promise.withResolvers()
    const oldBindingText = '帮我记住换绑前尚未执行的待办'
    modelGates.set(oldBindingText, oldBindingReply.promise)
    toolCalls.set(oldBindingText, call('delegateMemoryTool', { action: 'remember', content: '换绑前尚未执行的待办' }))
    emit(groupText(97007, oldBindingText, at))
    await waitUntil(() => groupToolRequests.at(-1)?.messages.at(-1)?.content === oldBindingText, 'model starts under the old binding')
    bindingConfig.bindings[0].agentId = 'another-agent'
    await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    oldBindingReply.resolve()
    await waitUntil(async () => await redis.lLen(groupTextQueue) === 0, 'old tool call is retired after rebinding')
    assert.equal(deliveries.length, beforePrivateDelivery + 1)
    assert.equal(JSON.parse(await redis.get(memoryKey)).length, 1)
    assert.equal((await redis.keys(prefix + 'bl-chat:delegated:v2:*')).length, 1)

    const retryText = '换绑时停止文字模型的兼容重试'
    const retryProbe = { calls: [], complete: Promise.withResolvers() }
    compatibilityGates.set(retryText, retryProbe)
    try {
      emit(groupText(97020, retryText, at))
      await waitUntil(() => retryProbe.calls.length === 1, 'old text binding has reached the provider')
      assert.equal(typeof retryProbe.calls[0].max_tokens, 'number')
      // Saving the same role again still retires the previous route revision.
      await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    } finally { retryProbe.complete.resolve() }
    await waitUntil(async () => await redis.lLen(groupTextQueue) === 0, 'revoked text provider response is discarded')
    assert.equal(retryProbe.calls.length, 1)
    assert.equal(deliveries.length, beforePrivateDelivery + 1)

    bindingConfig.bindings[0].agentId = 'local-agent'
    await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    assert.match(await callGroup(97008, '重新绑定后列出我的托付', 'delegateMemoryTool', { action: 'list' }), new RegExp(memory))
    assert.match(await callGroup(97009, '忘掉这条托付记录', 'delegateMemoryTool', { action: 'forget', memory_id: entry.id }), /已忘掉/)
    assert.deepEqual(JSON.parse(await redis.get(memoryKey)), [])
    assert.deepEqual(await stop(toolHost, 'SIGTERM'), [0, null])

    const actionBeforeRestart = 97010
    const actionText = '请再创建一条定时提醒'
    const earlierInput = { kind: 'message', message: { version: 1, conversation: groupTarget, sender: { ...target.account, id: String(USER) },
      messageId: String(actionBeforeRestart), occurredAt: Date.now(), text: actionText, parts: [], mentions: [], directedToAccount: true } }
    await inbox.accept({ event: earlierInput, bindingToken: (await textState()).bindingToken }, { kind: 'group', account: groupTarget.account })
    const recallVersion = await inbox.textRecallVersion(groupTarget)
    assert.equal(await inbox.claimTextAction(groupTarget, String(actionBeforeRestart), recallVersion), true)
    const actionWithReceipt = '97011'
    await inbox.accept({ event: {kind: 'message', message: {...earlierInput.message, messageId: actionWithReceipt}},
      bindingToken: (await textState()).bindingToken }, { kind: 'group', account: groupTarget.account })
    assert.equal(await inbox.claimTextAction(groupTarget, actionWithReceipt, recallVersion), true)
    const knownReceipt = `已登记定时文字提醒，编号 ${scheduled.id}。`
    assert.equal(await inbox.finishTextAction(groupTarget, actionWithReceipt, recallVersion, knownReceipt), true)
    toolCalls.set(actionText, call('commitmentTool', reminderArgs))
    const dueAt = Date.now() - 1_000
    const recoveryDelivery = deliveries.length
    await redis.set(taskKey, JSON.stringify({ ...task, next_run_at: dueAt }))
    await redis.set(pendingKey, JSON.stringify([{ ...scheduled, next_run_at: dueAt }]))
    const recoveredTools = launch()
    await waitUntil(() => recoveredTools.log.includes('已启动'), 'standalone restarts with an attempted tool and scheduled reminder', 15_000)
    await waitUntil(() => deliveries.length === recoveryDelivery + 2, 'sends the owned action receipt and persisted due reminder')
    const recovered = deliveries.slice(recoveryDelivery)
    const notice = recovered.find(item => item.params.message[0]?.data.id === String(actionBeforeRestart))
    assert.equal(notice, undefined, 'an unconfirmed attempted action cannot authorize an extra message after restart')
    const known = recovered.find(item => item.params.message[0]?.data.id === actionWithReceipt)
    assert.equal(known.params.message.at(-1).data.text, knownReceipt)
    const due = recovered.find(item => item.params.message[0]?.type === 'at')
    assert.equal(due.params.group_id, GROUP)
    assert.deepEqual(due.params.message, [{type: 'at', data: {qq: String(USER)}}, {type: 'text', data: {text: ` ${reminderText}`}}])
    await waitUntil(async () => JSON.parse(await redis.get(taskKey)).status === 'completed' && await redis.lLen(groupTextQueue) === 0, 'due task settles once')
    assert.ok(groupToolRequests.every(body => body.messages.at(-1).content !== actionText))
    assert.deepEqual(JSON.parse(await redis.get(pendingKey)), [])
    yield

    const pluginBindings = path.join(directory, 'yunzai-bindings.yaml')
    await fs.writeFile(pluginBindings, YAML.stringify(bindingConfig))
    const migrationInstance = 'standalone-cutover'
    const migrationPrefix = `bl-agent:${migrationInstance}:`
    const migrationConfig = { ...hostConfig, instance: migrationInstance, dataDir: 'cutover-data' }
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    const sourceBinding = createAgentBindingConfig(pluginBindings)().resolve(groupTarget)
    const sourceEvent = { user_id: USER, group_id: GROUP, self_id: BOT, _agentBinding: sourceBinding, _isAgentBindingCurrent: () => true }
    const time = Date.now()
    const today = dayKey(time)
    const groupId = String(GROUP)
    const groupKey = simulationAddressKey(groupTarget)
    const otherAccount = simulationAddressKey({ ...groupTarget, account: { ...groupTarget.account, id: String(BOT + 1) } })
    const oldSession = { ...createDefaultSimSession(time), botId: String(BOT), personaId: agentPersonaScopeId(sourceBinding.agentId),
      bindingToken: agentBindingToken(sourceBinding), budget: { day: today, turns: 1, tokens: 18 },
      seq: 9, queuedIngressWake: { kind: 'atMention', seq: 9 }, agentHistory: [{ role: 'user', content: '只能留在源会话的文字' }],
      wakeTimes: [time - 80_000, time - 3_600_001], sendTimes: [time - 80_000] }
    oldSession.wakeConfig.confirmedBy = 'agent'
    oldSession.wakeConfig.triggers.keywords = ['原群自选词']
    const rawLegacy = JSON.stringify(oldSession)
    const sourceControls = JSON.stringify({
      explicitEnabled: [], disabled: [otherAccount], atOnly: [groupId],
      playAlongUntil: { [otherAccount]: time + 60_000 },
      budgetCaps: { [otherAccount]: 12 }, turnCaps: { [groupId]: 3, [otherAccount]: 9 },
    })
    const destinationControls = { explicitEnabled: [], disabled: [otherAccount], budgetCaps: { [otherAccount]: 1 }, turnCaps: {} }
    const destinationControlsBefore = JSON.stringify(destinationControls)
    const targetState = migrationPrefix + simulationSessionKey(groupKey)
    const targetControls = migrationPrefix + SIMULATION_OVERRIDES_KEY
    const carryoverKey = migrationPrefix + simulationBudgetCarryoverKey(groupKey)
    const sourceConfig = path.join(directory, 'plugin-message.yaml')
    const sourceData = path.join(directory, 'source-token-data')
    const sourceControlFlags = ['--source-config', sourceConfig, '--source-data-dir', sourceData]
    const roleScope = { botId: String(BOT), personaId: agentPersonaScopeId(sourceBinding.agentId), groupId }
    const roleKey = characterKey(roleScope)
    const originalRole = JSON.stringify({ ...createEmptyCharacterState(roleScope), paused: true, revision: 4 })
    await Promise.all([
      redis.set(simulationSessionKey(groupId), rawLegacy),
      redis.set(SIMULATION_OVERRIDES_KEY, sourceControls),
      redis.set(targetControls, destinationControlsBefore),
      redis.set(roleKey, originalRole),
      fs.writeFile(sourceConfig, YAML.stringify({ pluginSettings: { simulation: { budget: { dailyCostCny: 0.6 } } } })),
      fs.mkdir(path.join(sourceData, 'token_usage'), { recursive: true }),
    ])
    const usage = (scope, cny, t = time) => JSON.stringify({ t, scope, stage: 'sim', u: { total: 1 }, cny })
    await fs.writeFile(path.join(sourceData, 'token_usage', `${today}.ndjson`),
      [usage(groupId, 0.2), usage(groupId, 0.15), usage(otherAccount, 3), usage(groupId, 5, time - 86_400_000), '{incomplete'].join('\n'))
    const logger = { info() {}, warn() {}, error() {} }
    const originalCommitments = createCommitmentRuntime({
      redis, logger, getBot: () => null, resolveBinding: () => sourceBinding, isSimulationGroup: () => true,
      wakeSim: async () => { throw new Error('fixture only registers tasks') }, loadConfig: () => ({}),
    })
    const originalMemories = createDelegateMemoryRuntime({ redis, logger, loadConfig: () => ({}) })
    const originalReminders = createReminderRuntime({ redis, logger, getBot: () => undefined, mcpManager: { isMCPTool: () => false } })
    const migratedMemory = '下回开会前准备议程😀'
    const migratedReminder = '开会前核对议程😀'
    assert.match(await new originalMemories.DelegateMemoryTool().func({ action: 'remember', content: migratedMemory }, sourceEvent), /记下了/)
    const originalScheduler = new originalCommitments.CommitmentTool()
    assert.match(await originalScheduler.func({ ...reminderArgs, deliver: 'static', static_message: migratedReminder, intent: '开会前提醒我核对议程' }, sourceEvent), /已记下/)
    const [originalTask] = await originalCommitments.store.listActiveCommitments()
    const originalTaskKey = `bl-chat:commitment:detail:${originalTask.id}`
    const originalPendingKey = 'bl-chat:commitment:pending:list'
    const originalMemoryKey = `bl-chat:delegated:v2:${encodeURIComponent(agentConversationKey(sourceBinding))}`
    const originalMemory = await redis.get(originalMemoryKey)
    const otherScope = { ...sourceBinding, agentId: 'another-agent' }
    const otherAddress = { ...sourceBinding, target: { ...groupTarget, account: { ...groupTarget.account, id: String(BOT + 1) } } }
    const untouchedMemoryKeys = [`bl-chat:delegated:${GROUP}`, ...[otherScope, otherAddress].map(scope => `bl-chat:delegated:v2:${encodeURIComponent(agentConversationKey(scope))}`)]
    await Promise.all(untouchedMemoryKeys.map(name => redis.set(name, originalMemory)))
    const unchanged = ['legacy', 'other-role', 'other-account', 'changed-identity', 'in-flight', 'requires-tools'].map(id => ({ id, next_run_at: originalTask.next_run_at }))
    const originalData = JSON.parse(await redis.get(originalTaskKey))
    const blockedTask = Object.fromEntries(unchanged.map(item => [item.id, { ...originalData, id: item.id }]))
    delete blockedTask.legacy.scopeKey
    delete blockedTask.legacy.bindingIdentity
    blockedTask['other-role'].scopeKey = agentConversationKey(otherScope)
    blockedTask['other-account'].scopeKey = agentConversationKey(otherAddress)
    blockedTask['other-account'].bot_id = otherAddress.target.account.id
    blockedTask['changed-identity'].bindingIdentity = agentBindingIdentity({ ...sourceBinding, personaId: 'old-persona' })
    Object.assign(blockedTask['in-flight'], { run_id: 'pending-result', lease_until: originalTask.next_run_at, execution_state: 'executing' })
    blockedTask['requires-tools'].deliver = 'agent'
    await Promise.all(Object.entries(blockedTask).map(([id, data]) => redis.set(`bl-chat:commitment:detail:${id}`, JSON.stringify(data))))
    const dueBeforeCutover = Date.now() - 1_000
    const dueOriginalTask = { ...originalData, next_run_at: dueBeforeCutover }
    const originalPending = JSON.stringify([{ id: originalTask.id, next_run_at: dueBeforeCutover }, ...unchanged])
    await redis.set(originalTaskKey, JSON.stringify(dueOriginalTask))
    await redis.set(originalPendingKey, originalPending)

    const privateSourceBinding = readStandaloneAgentConfig(config, env).resolvePersona({ ...groupTarget, kind: 'private', id: String(USER) }).binding
    const privateSourceEvent = { ...sourceEvent, group_id: null, _agentBinding: privateSourceBinding, message_id: '440002' }
    const reminderTool = new originalReminders.ReminderTool()
    const legacyPendingKey = 'bl-chat:reminder:pending:list'
    const legacyDetailKey = id => `bl-chat:reminder:detail:${id}`
    const legacyGroupText = '提醒你：迁来的群提醒'
    const legacyFriendText = '迁来的好友提醒不会被群看到'
    async function seedReminder(event, content, text = '', extra = null) {
      const result = await reminderTool.createReminder(event, reminderAt, content, text, extra)
      assert.match(result, /提醒已创建/)
      return result.match(/提醒ID: (.+)$/u)[1]
    }
    const legacyGroup = await seedReminder({ ...sourceEvent, message_id: '440001' }, '迁来的群提醒')
    const legacyFriend = await seedReminder(privateSourceEvent, '对话内提醒', legacyFriendText)
    const cancelFriend = await seedReminder(privateSourceEvent, '留给原好友取消的待发提醒')
    const oldPersonaFriend = await seedReminder(privateSourceEvent, '更换角色后应停止的提醒')
    const unknownFriend = await seedReminder(privateSourceEvent, '没有投递回执的好友提醒')
    const attached = await seedReminder(sourceEvent, '附带旧工具的提醒', '', { tool: 'voiceTool' })
    const unscoped = await seedReminder({ ...sourceEvent, _agentBinding: undefined }, '旧版无归属提醒')
    const ambiguous = await seedReminder(sourceEvent, '已开始投递的旧提醒')
    const orphan = await seedReminder(sourceEvent, '已离开旧调度索引的提醒')
    const oldBinding = await seedReminder({ ...sourceEvent, _agentBinding: { ...sourceBinding, personaId: 'old-persona' } }, '其他人设留下的旧提醒')
    const rejected = await seedReminder(sourceEvent, '旧宿主明确拒绝过的提醒')
    const beforeAmbiguous = JSON.parse(await redis.get(legacyDetailKey(ambiguous)))
    await redis.set(legacyDetailKey(ambiguous), JSON.stringify({ ...beforeAmbiguous, status: 'sending' }))
    const originalReminderIndex = JSON.parse(await redis.get(legacyPendingKey)).filter(item => item.id !== orphan)
    for (const item of originalReminderIndex) {
      if (item.id !== legacyGroup && item.id !== legacyFriend && item.id !== rejected) continue
      item.trigger_time = dueBeforeCutover
      const raw = JSON.parse(await redis.get(legacyDetailKey(item.id)))
      await redis.set(legacyDetailKey(item.id), JSON.stringify({ ...raw, trigger_time: dueBeforeCutover,
        ...(item.id === rejected ? { retry_count: 2, delivery: { state: 'failed', code: 'previous_rejection' } } : {}),
      }))
    }
    await redis.set(legacyPendingKey, JSON.stringify(originalReminderIndex))

    const memoryIdentity = { botId: String(BOT), personaId: agentPersonaScopeId(sourceBinding.agentId) }
    const privateMemoryIdentity = { botId: String(BOT), personaId: agentPersonaScopeId(privateSourceBinding.agentId) }
    const memoryScene = { kind: 'group', id: String(GROUP) }
    const oldPeople = createPersonMemoryStore({ redis })
    const oldNotebook = createSimSessionStore({ redis, characterScope: { ...memoryIdentity, groupId: String(GROUP) }, memoryScope: sourceBinding })
    const notesAt = Date.now() - 30_000
    const makeNote = (id, content, extra = {}) => ({ id, kind: 'note', content, source: 'agent', done: false,
      createdAt: notesAt, updatedAt: notesAt, ...extra })
    const rememberFact = async (id, content, draft = {}, scene = memoryScene, authorId = String(USER), subjectId = String(USER)) => {
      const source = { scene, messageId: id, authorId, at: notesAt, excerpt: content }
      const result = await oldPeople.remember({ identity: memoryIdentity, subjectId, category: 'fact', text: content, source,
        evidenceKind: authorId === subjectId ? 'self' : 'reported', sensitivity: 'personal', portable: false, ...draft })
      assert.ok(result.saved, result.reason)
      return result.entry
    }
    const rememberPerson = async (id, content, authorId = String(USER), scene = memoryScene, subjectId = String(USER)) => {
      const entry = await rememberFact(id, content, {}, scene, authorId, subjectId)
      return makeNote(id, content, { aboutUser: subjectId, memorySource: entry.source, memoryIdentity, personMemoryId: entry.id })
    }
    const verifiedNote = await rememberPerson('99021', '群笔记记着蓝色文件夹在二楼')
    const recallBeforeChat = await rememberPerson('99022', '独立宿主首条聊天之前撤回的来源')
    const revokedNote = await rememberPerson('99023', '从原群撤回过的展会安排')
    const erasedNote = await rememberPerson('99024', '已明确删除的群人物笔记')
    const disabledAuthor = String(USER + 9)
    const authorNote = await rememberPerson('99025', '已停用记忆的原发言者留下的笔记', disabledAuthor)
    const otherGroupNote = await rememberPerson('99026', '其他群的排班不得随本群迁移', String(USER), { kind: 'group', id: String(GROUP + 1) })
    const followupNote = { ...await rememberPerson('99027', '后来可自然接续的展览话题'), kind: 'pendingEvent', dueAt: Date.now() + 60_000, proactiveSourceSeq: 1 }
    const missingNote = { ...verifiedNote, id: 'missing-detail', content: '缺少人物详情的旧笔记', personMemoryId: 'missing-detail' }
    const expiredNote = makeNote('expired', '早已结束的话题', { kind: 'activeTopic', expiresAt: notesAt + 1 })
    const safetyNote = makeNote('unproven', '没有来源的旧群体印象')
    const sourceNotes = [verifiedNote, recallBeforeChat, revokedNote, erasedNote, authorNote, otherGroupNote, followupNote, missingNote, expiredNote, safetyNote]
    await oldNotebook.saveMemories(String(GROUP), sourceNotes)
    const staleFact = await rememberFact('99010', '蓝色文件夹原先交给了东区档案员')
    const currentFact = await rememberFact('99011', '蓝色文件夹要交给西区档案员', { supersedes: staleFact.id })
    const portableFact = await rememberFact('99012', '喜欢收集老地图', { category: 'interest', sensitivity: 'ordinary', portable: true })
    const relatedFact = await rememberFact('99013', '与已停用记忆的群友有一班交接', { relatedUserIds: [disabledAuthor] })
    const privateScene = { kind: 'private', id: String(USER) }
    const privateFact = await rememberFact('99014', '私聊里交代的保密地址', { identity: privateMemoryIdentity }, privateScene)
    const privateOtherPerson = await rememberFact('99016', '私聊发言者提到的朋友住址', { identity: privateMemoryIdentity }, privateScene, String(USER), String(USER + 1))
    const otherFriendFact = await rememberFact('99017', '另一位好友的私聊地址', { identity: privateMemoryIdentity }, { kind: 'private', id: String(USER + 1) }, String(USER + 1), String(USER + 1))
    const otherSpeakerFact = await rememberFact('99018', '同群另一位发言者的展会安排', {}, memoryScene, String(USER + 1), String(USER + 1))
    const expiredFact = await rememberFact('99015', '很早就结束的代班', { validUntil: notesAt + 1 })
    const plainNote = makeNote('plain', '迁入的公开群笔记', { aboutUser: undefined, createdAt: Date.now() + 30, updatedAt: Date.now() + 30 })
    await oldPeople.revokeSource({ identity: memoryIdentity, scene: memoryScene, messageId: revokedNote.memorySource.messageId })
    await oldPeople.forget({ identity: memoryIdentity, subjectId: String(USER), scene: memoryScene, id: erasedNote.personMemoryId })
    await oldPeople.setEnabled({ identity: memoryIdentity, subjectId: disabledAuthor, enabled: false })
    await oldPeople.revokeSource({ identity: memoryIdentity, scene: otherGroupNote.memorySource.scene, messageId: 'other-scene-revocation' })
    const notebookKey = simulationNotebookKey(sourceBinding)
    const savedNotes = JSON.parse(await redis.get(notebookKey))
    assert.equal(savedNotes.length, sourceNotes.length)
    await redis.set(notebookKey, JSON.stringify([...savedNotes, plainNote]))
    await redis.set(`shiloh:sim:g:${GROUP}:memories`, JSON.stringify([safetyNote]))
    const protectedNoteIds = new Set([authorNote.id, erasedNote.id, revokedNote.id])
    assert.ok((await oldNotebook.loadMemories(String(GROUP))).every(note => !protectedNoteIds.has(note.id)))
    yield

    const migrationEnv = { ...env }
    delete migrationEnv.TEST_AGENT_MODEL_KEY
    delete migrationEnv.TEST_AGENT_ONEBOT_TOKEN
    const runMigration = async (source = pluginBindings, flags = ['--apply'], overrideEnv = migrationEnv, target = ['--group', String(GROUP)]) => {
      const startedAt = performance.now()
      const execution = runNode(process.execPath, [agentEntry, '--config', config, '--migrate-qq-state',
        '--source-bindings', source, '--connection', 'qq-local', ...target,
        ...(target[0] === '--group' ? sourceControlFlags : []), ...flags], { cwd: directory, env: overrideEnv })
      children.push(execution.child)
      try {
        const { stdout } = await execution
        return JSON.parse(stdout)
      } finally { migrationTimes.push(Math.round(performance.now() - startedAt)) }
    }
    const runRejectedMigration = async (source = pluginBindings, flags = ['--apply'], overrideEnv = migrationEnv, target = ['--group', String(GROUP)]) => {
      // The CLI exposes a fixed safe error. Check the precise guard against its
      // owning service as well, so a different CLI failure cannot satisfy it.
      await assert.rejects(runMigration(source, flags, overrideEnv, target), error => error.code === 1 &&
        /独立宿主启动或检查失败/u.test(error.stderr) && !error.stderr.includes(auth))
      return runStandaloneQqMigration(readStandaloneAgentConfig(config, overrideEnv, { requireCredentials: false }), {
        sourceBindings: source, connectionId: 'qq-local', kind: target[0] === '--friend' ? 'private' : 'group', conversationId: target[1],
        apply: flags.includes('--apply'),
        ...(target[0] === '--group' ? { sourceConfig, sourceDataDir: sourceData } : {}),
        ...(flags.includes('--include-agent-commitments') ? { moveAgentCommitments: true } : {}),
        ...(flags.includes('--include-character-state') ? { moveCharacterState: true } : {}),
      })
    }
    const migrationDeliveries = deliveries.length
    const migrationUpgrades = upgrades
    const personDetailKey = entry => `shiloh:person-memory:v1:${encodeURIComponent(entry.identity.botId)}:${encodeURIComponent(entry.identity.personaId)}:person:${entry.subjectId}:entry:${entry.id}`
    const preview = await runMigration(pluginBindings, [])
    assert.deepEqual(preview, { mode: 'preview', instance: migrationInstance, connectionId: 'qq-local', groupId: String(GROUP),
      delegatedMemories: 1, commitments: 1, agentCommitments: 0, reminders: 2, groupNotes: 4, retainedGroupNotes: 7, personFacts: 6,
      simulationControls: { enabled: true, atOnly: true, activeUntil: null, paused: true,
        dailyCostCny: 0.6, maxTurnsPerDay: 3, carriedTurns: 1, carriedCostCny: 0.35, recentWakeCount: 1, recentSendCount: 1 },
      skipped: { unscoped: 2, binding: 3, inFlight: 2, unsupported: 2, unavailable: 0 } })
    const friendTarget = ['--friend', String(USER)]
    const runFriendMigration = (flags = ['--apply']) => runMigration(pluginBindings, flags, migrationEnv, friendTarget)
    const friendPreview = await runFriendMigration([])
    assert.deepEqual(friendPreview, { mode: 'preview', instance: migrationInstance, connectionId: 'qq-local', friendId: String(USER),
      delegatedMemories: 0, commitments: 0, agentCommitments: 0, reminders: 4, groupNotes: 0, retainedGroupNotes: 0, personFacts: 1,
      skipped: { unscoped: 0, binding: 0, inFlight: 0, unsupported: 0, unavailable: 0 } })
    assert.equal(await redis.get(originalMemoryKey), originalMemory)
    assert.equal(await redis.get(migrationPrefix + originalMemoryKey), null)
    assert.equal(await redis.get(migrationPrefix + originalTaskKey), null)
    assert.equal(await redis.get(migrationPrefix + `bl-chat:commitment:detail:${legacyGroup}`), null)
    assert.equal(await redis.get(migrationPrefix + notebookKey), null)
    assert.ok(await redis.get(personDetailKey(currentFact)))
    assert.equal(await redis.get(migrationPrefix + personDetailKey(currentFact)), null)
    assert.ok(await redis.get(personDetailKey(privateFact)))
    assert.equal(await redis.get(migrationPrefix + personDetailKey(privateFact)), null)
    assert.equal(await redis.get(targetState), null)
    assert.equal(await redis.get(targetControls), destinationControlsBefore)
    assert.equal(await redis.get(carryoverKey), null)
    assert.ok(await redis.get(legacyDetailKey(legacyGroup)))
    const wrongSource = path.join(directory, 'wrong-bindings.yaml')
    await fs.writeFile(wrongSource, YAML.stringify({ ...bindingConfig, bindings: [{ ...bindingConfig.bindings[0], agentId: 'another-agent' }] }))
    await assert.rejects(runRejectedMigration(wrongSource, ['--apply']), /来源和目标必须显式绑定/)
    await fs.writeFile(config, YAML.stringify(hostConfig))
    await assert.rejects(runRejectedMigration(pluginBindings, ['--apply']), /停止独立宿主/)
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    await redis.set(simulationBusyKey(groupId), 'busy')
    await assert.rejects(runRejectedMigration(), /仿真群或角色仍有进行中的工作/)
    assert.equal(await redis.get(targetControls), destinationControlsBefore)
    await redis.del(simulationBusyKey(groupId))
    await fs.writeFile(sourceConfig, YAML.stringify({ pluginSettings: { simulation: { allGroups: false, groups: [groupId] } } }))
    assert.equal((await runMigration(pluginBindings, [])).simulationControls.enabled, false)
    await fs.writeFile(sourceConfig, YAML.stringify({ pluginSettings: { simulation: { budget: { dailyCostCny: 0.6 } } } }))
    await redis.set(migrationPrefix + originalTaskKey, 'existing task')
    await assert.rejects(runRejectedMigration(pluginBindings, ['--apply']), /相同承诺或提醒编号/)
    assert.equal(await redis.get(originalPendingKey), originalPending)
    assert.equal(await redis.get(originalMemoryKey), originalMemory)
    assert.equal(await redis.get(migrationPrefix + originalMemoryKey), null)
    await redis.del(migrationPrefix + originalTaskKey)
    await redis.set(migrationPrefix + originalMemoryKey, '[]')
    await assert.rejects(runRejectedMigration(pluginBindings, ['--apply']), /已有委托记忆分区/)
    assert.equal(await redis.get(migrationPrefix + originalTaskKey), null)
    await redis.del(migrationPrefix + originalMemoryKey)
    await redis.set(migrationPrefix + notebookKey, '[]')
    await assert.rejects(runRejectedMigration(), /已有仿真群笔记分区/)
    assert.equal(await redis.get(migrationPrefix + originalMemoryKey), null)
    assert.ok(await redis.get(personDetailKey(currentFact)))
    assert.equal(await redis.get(migrationPrefix + personDetailKey(currentFact)), null)
    await redis.del(migrationPrefix + notebookKey)
    if (Number(/redis_version:(\d+)/u.exec(await redis.info('server'))?.[1]) >= 7) {
      await redis.sendCommand(['ACL', 'SETUSER', 'default', '-del'])
      try {
        await assert.rejects(runRejectedMigration(), /迁移所需的账本写入权限/)
      } finally {
        await redis.sendCommand(['ACL', 'SETUSER', 'default', '+del'])
      }
      assert.equal(await redis.get(originalPendingKey), originalPending)
      assert.equal(await redis.get(migrationPrefix + originalTaskKey), null)
      assert.equal(await redis.get(migrationPrefix + originalMemoryKey), null)
    }
    yield

    const parallelMoves = await Promise.allSettled([runMigration(pluginBindings, ['--apply']), runMigration(pluginBindings, ['--apply'])])
    const committedMoves = parallelMoves.filter(move => move.status === 'fulfilled' && move.value.commitments === 1)
    assert.deepEqual(committedMoves, [{ status: 'fulfilled', value: { ...preview, mode: 'applied' } }])
    for (const move of parallelMoves) {
      if (move.status === 'rejected') {
        assert.equal(move.reason.code, 1)
        assert.match(move.reason.stderr, /独立宿主启动或检查失败/u)
      }
    }
    assert.equal(await redis.get(originalMemoryKey), null)
    assert.equal(await redis.get(originalTaskKey), null)
    assert.deepEqual(JSON.parse(await redis.get(originalPendingKey)), unchanged)
    assert.deepEqual(await Promise.all(untouchedMemoryKeys.map(name => redis.get(name))), untouchedMemoryKeys.map(() => originalMemory))
    assert.equal(await redis.get(migrationPrefix + originalMemoryKey), originalMemory)
    assert.deepEqual(JSON.parse(await redis.get(migrationPrefix + originalTaskKey)), dueOriginalTask)
    const retry = await runMigration(pluginBindings, ['--apply'])
    assert.equal(retry.reminders, 0)
    assert.equal(retry.groupNotes, 0)
    assert.equal(retry.personFacts, 0)
    assert.equal(retry.simulationControls, undefined)
    assert.equal(await redis.get(simulationSessionKey(groupId)), rawLegacy)
    assert.equal(await redis.get(SIMULATION_OVERRIDES_KEY), sourceControls)
    assert.equal(await redis.get(roleKey), originalRole)
    assert.deepEqual(JSON.parse(await redis.get(carryoverKey)), { day: today, turns: 1, costCny: 0.35 })
    assert.deepEqual(JSON.parse(await redis.get(targetControls)), {
      ...destinationControls, budgetCaps: { ...destinationControls.budgetCaps, [groupKey]: 0.6 },
      turnCaps: { [groupKey]: 3 }, atOnly: [groupKey], playAlongUntil: {},
    })
    assert.deepEqual(JSON.parse(await redis.get(migrationPrefix + roleKey)), { ...createEmptyCharacterState(roleScope), paused: true, revision: 1 })
    const fresh = JSON.parse(await redis.get(targetState))
    assert.equal(fresh.queuedIngressWake, undefined)
    assert.deepEqual(fresh.unread, [])
    assert.deepEqual(fresh.recent, [])
    assert.deepEqual(fresh.agentHistory, [])
    assert.deepEqual(fresh.wakeConfig.triggers.keywords, [])
    assert.deepEqual(fresh.wakeTimes, [time - 80_000])
    assert.deepEqual(fresh.sendTimes, [time - 80_000])
    const readonlyStore = createSimSessionStore({ redis: { get: name => redis.get(migrationPrefix + name) } })
    assert.equal(await readonlyStore.loadBudgetCarryover(groupKey, time + 86_400_000), null)
    const targetNotebook = JSON.parse(await redis.get(migrationPrefix + notebookKey))
    assert.deepEqual(targetNotebook.map(note => note.id), [verifiedNote.id, recallBeforeChat.id, followupNote.id, plainNote.id])
    assert.equal(targetNotebook.find(note => note.id === followupNote.id).proactiveSourceSeq, undefined)
    assert.equal(targetNotebook.find(note => note.id === followupNote.id).dueAt, followupNote.dueAt)
    assert.equal(JSON.parse(await redis.get(notebookKey)).length, 7)
    assert.equal(JSON.parse(await redis.get(`shiloh:sim:g:${GROUP}:memories`))[0].id, safetyNote.id)
    const targetPeople = createPersonMemoryStore({ redis: {
      get: name => redis.get(migrationPrefix + name),
      set: (name, value) => redis.set(migrationPrefix + name, value),
      del: name => redis.del(migrationPrefix + name),
    } })
    const targetQuery = { identity: memoryIdentity, subjectId: String(USER), scene: memoryScene, viewerUserId: String(USER) }
    assert.deepEqual(new Set((await targetPeople.query(targetQuery)).items.map(item => item.id)),
      new Set([verifiedNote.personMemoryId, recallBeforeChat.personMemoryId, followupNote.personMemoryId, currentFact.id, portableFact.id]))
    assert.equal(await redis.get(personDetailKey(currentFact)), null)
    assert.equal(JSON.parse(await redis.get(migrationPrefix + personDetailKey(currentFact))).supersedes, staleFact.id)
    for (const entry of [staleFact, relatedFact, privateFact, expiredFact]) {
      assert.ok(await redis.get(personDetailKey(entry)))
      assert.equal(await redis.get(migrationPrefix + personDetailKey(entry)), null)
    }
    assert.equal((await targetPeople.remember(staleFact)).reason, 'redacted')
    assert.deepEqual((await targetPeople.query({ ...targetQuery, scene: otherGroupNote.memorySource.scene })).items.map(item => item.id), [portableFact.id])
    assert.ok((await targetPeople.getRedactions({ identity: memoryIdentity, subjectId: disabledAuthor })).disabled)
    const importedRules = await targetPeople.getRedactions({ identity: memoryIdentity, subjectId: String(USER) })
    assert.ok(importedRules.revokedSources.includes(JSON.stringify(['group', String(GROUP), revokedNote.id])))
    assert.ok(importedRules.tombstones.some(row => row.id === erasedNote.personMemoryId))
    assert.ok(!importedRules.revokedSources.some(source => source.includes('other-scene-revocation')))
    assert.ok(!(await oldPeople.query(targetQuery)).items.some(item => item.id === verifiedNote.personMemoryId))
    const restoreMovedFact = await oldPeople.remember({ identity: memoryIdentity, subjectId: String(USER), text: verifiedNote.content,
      source: verifiedNote.memorySource, category: 'fact', evidenceKind: 'self', sensitivity: 'personal', portable: false })
    assert.equal(restoreMovedFact.reason, 'redacted')
    assert.ok((await oldPeople.query({ ...targetQuery, scene: otherGroupNote.memorySource.scene })).items.some(item => item.id === otherGroupNote.personMemoryId))
    await fs.writeFile(config, YAML.stringify({ ...migrationConfig, privateChat: { enabled: false } }))
    await assert.rejects(runRejectedMigration(pluginBindings, ['--apply'], migrationEnv, friendTarget), /启用目标宿主的 privateChat/)
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    assert.deepEqual(await runFriendMigration(), { ...friendPreview, mode: 'applied' })
    const retryFriendMigration = await runFriendMigration()
    assert.equal(retryFriendMigration.reminders, 0)
    assert.equal(retryFriendMigration.personFacts, 0)
    const targetPrivateQuery = { ...targetQuery, identity: privateMemoryIdentity, scene: privateScene, localOnly: true }
    assert.equal(await redis.get(personDetailKey(privateFact)), null)
    assert.deepEqual((await targetPeople.query(targetPrivateQuery)).items.map(item => item.id), [privateFact.id])
    for (const entry of [privateOtherPerson, otherFriendFact]) {
      assert.ok(await redis.get(personDetailKey(entry)))
      assert.equal(await redis.get(migrationPrefix + personDetailKey(entry)), null)
    }
    for (const id of [legacyGroup, legacyFriend, cancelFriend, oldPersonaFriend, unknownFriend, rejected]) assert.equal(await redis.get(legacyDetailKey(id)), null)
    const unmovedReminders = new Set([attached, unscoped, ambiguous, oldBinding])
    assert.deepEqual(JSON.parse(await redis.get(legacyPendingKey)), originalReminderIndex.filter(item => unmovedReminders.has(item.id)))
    for (const id of [...unmovedReminders, orphan]) assert.ok(await redis.get(legacyDetailKey(id)))
    const migratedTaskKey = id => migrationPrefix + `bl-chat:commitment:detail:${id}`
    const migratedPrivateTask = JSON.parse(await redis.get(migratedTaskKey(legacyFriend)))
    assert.equal(migratedPrivateTask.static_message, legacyFriendText)
    assert.equal(migratedPrivateTask.group_id, '')
    assert.deepEqual(JSON.parse(migratedPrivateTask.scopeKey), [privateSourceBinding.agentId, 'qq', 'global', String(BOT), 'private', String(USER)])
    assert.equal(JSON.parse(await redis.get(migratedTaskKey(rejected))).retry_count, 2)
    assert.equal(deliveries.length, migrationDeliveries)
    assert.equal(upgrades, migrationUpgrades)
    assert.deepEqual(await stop(recoveredTools, 'SIGTERM'), [0, null])
    yield

    const cutover = launch()
    await waitUntil(() => cutover.log.includes('已启动'), 'independent host opens migrated state', 15_000)
    const groupBudgetReceipt = id => groupMessageReceipt(id).replace(prefix, migrationPrefix)
    const migratedTextQueue = groupTextQueue.replace(prefix, migrationPrefix)
    const budgetRequests = requests.length
    await redis.set(carryoverKey, JSON.stringify({ day: today, turns: 1, costCny: 0.6 }))
    emit(groupText(98000, '累积金额达到上限后的群点名', at))
    await waitUntil(async () => await redis.get(groupBudgetReceipt(98000)) === '1' &&
      await redis.lLen(migratedTextQueue) === 0, 'migrated cost gates group text before model call')
    assert.equal(requests.length, budgetRequests)
    await redis.set(carryoverKey, JSON.stringify({ day: today, turns: 1, costCny: 0.35 }))
    const emitGroupRecall = note => emit({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT,
      group_id: GROUP, user_id: USER, operator_id: USER, message_id: Number(note.memorySource.messageId) })
    emitGroupRecall(recallBeforeChat)
    await waitUntil(async () => !(await targetPeople.query(targetQuery)).items.some(item => item.id === recallBeforeChat.personMemoryId),
      'migrated provenance can be revoked before the first new simulation message')
    await waitUntil(() => deliveries.length === migrationDeliveries + 4, 'migrated reminders delivered')
    const migratedDeliveries = deliveries.slice(migrationDeliveries)
    for (const text of [migratedReminder, legacyGroupText, '提醒你：旧宿主明确拒绝过的提醒']) {
      const sent = migratedDeliveries.find(item => item.params.message.at(-1).data.text === ` ${text}`)
      assert.equal(sent.action, 'send_group_msg')
      assert.deepEqual(sent.params, { group_id: GROUP, message: [
        { type: 'at', data: { qq: String(USER) } }, { type: 'text', data: { text: ` ${text}` } },
      ] })
    }
    assert.deepEqual(migratedDeliveries.find(item => item.action === 'send_private_msg').params, {
      user_id: USER, message: [{ type: 'text', data: { text: legacyFriendText } }],
    })
    await waitUntil(async () => (await Promise.all([migrationPrefix + originalTaskKey, ...[legacyGroup, legacyFriend, rejected].map(migratedTaskKey)]
      .map(name => redis.get(name)))).every(raw => JSON.parse(raw).status === 'completed'), 'all migrated reminders settled')
    const cutoverRequest = '列出从旧宿主接续的托付'
    toolCalls.set(cutoverRequest, call('delegateMemoryTool', { action: 'list' }))
    emit(groupText(98001, cutoverRequest, at))
    await waitUntil(() => deliveries.length === migrationDeliveries + 5, 'original member can read migrated memory')
    assert.match(textDelivery(), new RegExp(migratedMemory, 'u'))
    const cutoverGroupPrompt = JSON.stringify(groupToolRequests.at(-1).messages)
    assert.ok(cutoverGroupPrompt.includes(`本人陈述：${currentFact.text}`))
    assert.ok(cutoverGroupPrompt.includes(portableFact.text))
    for (const hidden of [privateFact, otherSpeakerFact, staleFact, relatedFact, expiredFact]) assert.ok(!cutoverGroupPrompt.includes(hidden.text))
    const groupListRequest = '看看群里的待发提醒'
    toolCalls.set(groupListRequest, call('commitmentTool', { action: 'list' }))
    emit(groupText(98005, groupListRequest, at))
    await waitUntil(() => deliveries.length === migrationDeliveries + 6, 'group task list is delivered only to its conversation')
    const groupList = textDelivery()
    assert.ok(!groupList.includes(cancelFriend) && !groupList.includes(legacyFriendText))
    const afterGroupBudget = requests.length
    emit(groupText(98006, '当日额度耗尽后的群点名', at))
    await waitUntil(async () => await redis.get(groupBudgetReceipt(98006)) === '1' &&
      await redis.lLen(migratedTextQueue) === 0, 'migrated turn allowance gates group text')
    assert.equal(requests.length, afterGroupBudget)

    async function callPrivate(id, query, args) {
      toolCalls.set(query, call('commitmentTool', args))
      const next = deliveries.length + 1
      emit(privateMessage(id, query))
      await waitUntil(() => deliveries.length === next, query)
      assert.equal(deliveries.at(-1).action, 'send_private_msg')
      assert.equal(deliveries.at(-1).params.user_id, USER)
      return textDelivery()
    }
    const privateList = await callPrivate(98002, '查看我迁入的提醒', { action: 'list' })
    assert.match(privateList, new RegExp(cancelFriend))
    assert.ok(!privateList.includes(migratedReminder) && !privateList.includes(legacyFriendText))
    assert.ok(lastPromptContains(`本人陈述：${privateFact.text}`))
    for (const hidden of [currentFact, portableFact, privateOtherPerson, otherFriendFact]) assert.equal(lastPromptContains(hidden.text), false)
    assert.deepEqual(directRequests.at(-1).tools[0].function.parameters.properties.action.enum, ['list', 'cancel'])
    assert.match(await callPrivate(98003, '尝试在私聊创建新提醒', reminderArgs), /没有可用的调用结果/)
    assert.match(await callPrivate(98004, '取消我之前约的提醒', { action: 'cancel', commitment_id: cancelFriend }), /已取消/)
    assert.equal(JSON.parse(await redis.get(migratedTaskKey(cancelFriend))).status, 'cancelled')
    const beforePrivateRevocation = deliveries.length
    const heldMemoryReply = Promise.withResolvers()
    const recallRaceText = '依据之前私聊的地址回复'
    modelGates.set(recallRaceText, heldMemoryReply.promise)
    emit(privateMessage(98007, recallRaceText))
    try {
      await waitUntil(() => directRequests.at(-1)?.messages.at(-1)?.content === recallRaceText, 'migrated private fact enters a live model call')
      assert.ok(lastPromptContains(privateFact.text))
      emit(recall(Number(privateFact.source.messageId)))
      await waitUntil(async () => !(await targetPeople.query(targetPrivateQuery)).items.length, 'friend recall persists for a migrated source without an inbox receipt')
    } finally { heldMemoryReply.resolve() }
    await waitUntil(async () => await redis.lLen(privateQueue.replace(prefix, migrationPrefix)) === 0, 'friend recall discards the stale model response')
    assert.equal(deliveries.length, beforePrivateRevocation)
    emit(privateMessage(98008, '撤回旧来源后的私聊'))
    await waitUntil(() => deliveries.length === beforePrivateRevocation + 1, 'private conversation continues after source recall')
    assert.equal(lastPromptContains(privateFact.text), false)
    const migratedPrivateHistory = privateHistory.replace(prefix, migrationPrefix)
    await waitUntil(async () => JSON.parse(await redis.get(migratedPrivateHistory) ?? 'null')?.turns.length === 1, 'only the fresh private turn remains')
    assert.equal((await redis.get(migratedPrivateHistory)).includes(privateFact.text), false)
    const makeMigratedDue = async id => {
      const destinationQueue = migrationPrefix + originalPendingKey
      const detail = JSON.parse(await redis.get(migratedTaskKey(id)))
      const list = JSON.parse(await redis.get(destinationQueue))
      const dueAt = Date.now() - 1_000
      await redis.multi().set(migratedTaskKey(id), JSON.stringify({ ...detail, next_run_at: dueAt }))
        .set(destinationQueue, JSON.stringify(list.map(item => item.id === id ? { ...item, next_run_at: dueAt } : item))).exec()
    }
    loseNextPrivateReceipt = true
    const unconfirmed = once(privateEvents, 'receipt-lost')
    await makeMigratedDue(unknownFriend)
    await unconfirmed
    websocket.terminate()
    await waitUntil(async () => JSON.parse(await redis.get(migratedTaskKey(unknownFriend))).status === 'unknown', 'no receipt means no replay')
    bindingConfig.bindings[1].agentId = privateSourceBinding.agentId === 'another-agent' ? 'local-agent' : 'another-agent'
    await fs.writeFile(bindingFile, YAML.stringify(bindingConfig))
    await makeMigratedDue(oldPersonaFriend)
    const afterDeliveries = deliveries.length
    assert.deepEqual(await stop(cutover, 'SIGTERM'), [0, null])
    delete migrationConfig.textGroups
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    const afterCutover = launch()
    await waitUntil(() => afterCutover.log.includes('已启动'), 'cutover host restarts', 15_000)
    await waitUntil(async () => JSON.parse(await redis.get(migratedTaskKey(oldPersonaFriend))).status === 'cancelled', 'binding change cancels imported reminder')
    assert.deepEqual(JSON.parse(await redis.get(migrationPrefix + originalPendingKey)), [])
    assert.equal(deliveries.length, afterDeliveries)
    const beforeUnaddressed = requests.length
    emit(groupText(99030, '独立群聊角色，你知道最近发生了什么吗'))
    await waitUntil(async () => JSON.parse(await redis.get(targetState)).recent.some(item => item.messageId === '99030'), 'at-only still ingests unaddressed messages')
    assert.equal(JSON.parse(await redis.get(targetState)).queuedIngressWake, undefined)
    assert.equal(requests.length, beforeUnaddressed)
    const beforeNotebookTurn = requests.length
    emit(groupMessage(99031, '回到原群查看蓝色文件夹'))
    await waitUntil(() => requests.length > beforeNotebookTurn, 'migrated notebook appears in a normal simulation model turn')
    const projectedNotebook = JSON.stringify(requests[beforeNotebookTurn].messages)
    assert.ok(projectedNotebook.includes(verifiedNote.content))
    assert.ok(projectedNotebook.includes(`本人陈述：${currentFact.text}`))
    assert.ok(projectedNotebook.includes(portableFact.text))
    for (const hidden of [staleFact, relatedFact, privateFact, expiredFact]) assert.ok(!projectedNotebook.includes(hidden.text))
    for (const hidden of [revokedNote, erasedNote, authorNote, otherGroupNote, recallBeforeChat]) assert.ok(!projectedNotebook.includes(hidden.content))
    await waitUntil(async () => !await redis.exists(migrationPrefix + simulationBusyKey(groupKey)), 'previous simulation turn releases its lease')
    assert.ok(!(JSON.parse(await redis.get(targetState))).agentHistory.some(message => String(message.content).includes('【本群人物记忆】')))
    const simBudgetRequests = requests.length
    const simBudgetDeliveries = deliveries.length
    await redis.set(carryoverKey, JSON.stringify({ day: today, turns: 1, costCny: 0.6 }))
    emit(groupMessage(99032, '仿真达到金额上限后的点名'))
    await waitUntil(() => deliveries.slice(simBudgetDeliveries).some(item => item.params.group_id === GROUP &&
      item.params.message.some(part => part.type === 'text' && part.data.text.includes('今日消耗额度已达上限'))),
    'simulation uses the same migrated cost allowance')
    assert.equal(requests.length, simBudgetRequests)
    assert.deepEqual(await stop(afterCutover, 'SIGTERM'), [0, null])
    yield

    const scheduledGroup = String(GROUP + 1)
    const scheduledTarget = { ...groupTarget, id: scheduledGroup }
    const scheduledSession = migrationPrefix + simulationSessionKey(simulationAddressKey(scheduledTarget))
    const goalGroup = String(GROUP + 2)
    const goalTarget = { ...groupTarget, id: goalGroup }
    const goalAddress = simulationAddressKey(goalTarget)
    const goalSession = migrationPrefix + simulationSessionKey(goalAddress)
    const timerGroup = String(GROUP + 3)
    const timerTarget = { ...groupTarget, id: timerGroup }
    const timerAddress = simulationAddressKey(timerTarget)
    const timerSourceKey = simulationSessionKey(timerAddress)
    const timerTargetKey = migrationPrefix + timerSourceKey
    const knownKey = migrationPrefix + SIMULATION_KNOWN_GROUPS_KEY
    const scheduledBindings = { ...bindingConfig, bindings: [...bindingConfig.bindings, ...[scheduledGroup, goalGroup, timerGroup]
      .map(conversationId => ({ ...bindingConfig.bindings[0], conversationId }))] }
    await Promise.all([
      fs.writeFile(pluginBindings, YAML.stringify(scheduledBindings)),
      fs.writeFile(bindingFile, YAML.stringify(scheduledBindings)),
      fs.writeFile(sourceConfig, YAML.stringify({ pluginSettings: { simulation: { budget: { dailyCostCny: 5 } } } })),
    ])
    const scheduledBinding = createAgentBindingConfig(pluginBindings)().resolve(scheduledTarget)
    const timerBinding = createAgentBindingConfig(pluginBindings)().resolve(timerTarget)
    const deadline = Date.now() - 10_000
    const timerState = { ...createDefaultSimSession(deadline), botId: String(BOT), personaId: agentPersonaScopeId(timerBinding.agentId),
      bindingToken: agentBindingToken(timerBinding),
      queuedIngressWake: { kind: 'atMention', seq: 2 }, lastConfirmedChat: { at: deadline, userId: String(USER), text: '旧确认回复' },
      agentHistory: [{ role: 'user', content: '定时唤醒以前的聊天不随迁移' }], nextReplyCheckAt: deadline, nextProactiveCheckAt: deadline,
    }
    timerState.wakeConfig = { ...timerState.wakeConfig, mode: 'active', sleepUntil: deadline, confirmedBy: 'agent',
      triggers: { ...timerState.wakeConfig.triggers, probability: 0, keywords: ['原群定制关键词'] } }
    const rawTimer = JSON.stringify(timerState)
    const timerSelector = ['--group', timerGroup]
    const migrateTimer = (flags = []) => runMigration(pluginBindings, flags, migrationEnv, timerSelector)
    await redis.set(timerSourceKey, JSON.stringify({ ...timerState, bindingToken: '旧绑定版本' }))
    assert.equal((await migrateTimer()).simulationControls?.wakeConfigTransferred, undefined)
    await redis.set(timerSourceKey, rawTimer)
    await fs.writeFile(config, YAML.stringify({ ...migrationConfig, textGroups: [{ connectionId: 'qq-local', conversationId: timerGroup }] }))
    assert.equal((await migrateTimer(['--apply'])).simulationControls?.wakeConfigTransferred, undefined)
    assert.equal(await redis.get(timerSourceKey), rawTimer)
    assert.equal(await redis.get(timerTargetKey), null)
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    const timerPreview = await migrateTimer()
    assert.equal(timerPreview.simulationControls.wakeConfigTransferred, true)
    assert.equal(timerPreview.simulationControls.nextWakeAt, deadline)
    assert.equal(await redis.get(timerSourceKey), rawTimer)
    assert.equal(await redis.get(timerTargetKey), null)
    await redis.set(timerTargetKey, JSON.stringify(createDefaultSimSession(deadline)))
    await assert.rejects(runRejectedMigration(pluginBindings, ['--apply'], migrationEnv, timerSelector), /目标已有仿真会话或预算/)
    assert.equal(await redis.get(timerSourceKey), rawTimer)
    await redis.del(timerTargetKey)
    assert.deepEqual(await migrateTimer(['--apply']), { ...timerPreview, mode: 'applied' })
    const savedTimer = JSON.parse(await redis.get(timerTargetKey))
    assert.deepEqual(savedTimer.wakeConfig, timerState.wakeConfig)
    assert.deepEqual(savedTimer.agentHistory, [])
    assert.deepEqual(savedTimer.recent, [])
    assert.equal(savedTimer.queuedIngressWake, undefined)
    assert.equal(savedTimer.nextReplyCheckAt, 0)
    const { sleepUntil: _movedDeadline, ...sourceWakeConfig } = timerState.wakeConfig
    assert.deepEqual(JSON.parse(await redis.get(timerSourceKey)), { ...timerState, wakeConfig: { ...sourceWakeConfig, mode: 'diving' } })
    assert.ok(JSON.parse(await redis.get(knownKey)).includes(timerAddress))
    assert.equal((await migrateTimer(['--apply'])).simulationControls, undefined)

    const scheduledNotebook = simulationNotebookKey(scheduledBinding)
    assert.equal(await redis.get(scheduledNotebook), null)
    await redis.set(migrationPrefix + scheduledNotebook, '[]')
    const scheduledId = 'cutover-agent-commitment'
    const scheduledSource = `bl-chat:commitment:detail:${scheduledId}`
    const scheduledDestination = migratedTaskKey(scheduledId)
    const scheduledAt = Date.now() - 1000
    const scheduledTask = { ...originalData, id: scheduledId, group_id: scheduledGroup, deliver: 'agent', static_message: null,
      scopeKey: agentConversationKey(scheduledBinding), bindingIdentity: agentBindingIdentity(scheduledBinding),
      schedule: { kind: 'once', time: scheduledAt }, next_run_at: scheduledAt, intent: '验收迁入的仿真承诺' }
    await redis.multi().set(scheduledSource, JSON.stringify(scheduledTask)).set(originalPendingKey,
      JSON.stringify([...unchanged, {id: scheduledId, next_run_at: scheduledAt}])).exec()
    const scheduledSelector = ['--group', scheduledGroup]
    const allowAgent = '--include-agent-commitments'
    const defaultPlan = await runMigration(pluginBindings, [], migrationEnv, scheduledSelector)
    assert.equal(defaultPlan.agentCommitments, 0)
    assert.equal(defaultPlan.skipped.unsupported, 1)
    const scheduledPreview = await runMigration(pluginBindings, [allowAgent], migrationEnv, scheduledSelector)
    assert.equal(scheduledPreview.agentCommitments, 1)
    assert.equal(scheduledPreview.personFacts, 1)
    assert.equal(scheduledPreview.groupNotes, 0)
    assert.equal(await redis.get(scheduledDestination), null)
    await fs.writeFile(config, YAML.stringify({ ...migrationConfig, textGroups: [{ connectionId: 'qq-local', conversationId: scheduledGroup }] }))
    await assert.rejects(runRejectedMigration(pluginBindings, [allowAgent, '--apply'], migrationEnv, scheduledSelector), /仿真承诺只能迁到使用仿真模式的群/)
    assert.ok(await redis.get(scheduledSource))
    await fs.writeFile(config, YAML.stringify(migrationConfig))
    const movedSchedule = await runMigration(pluginBindings, [allowAgent, '--apply'], migrationEnv, scheduledSelector)
    assert.equal(movedSchedule.agentCommitments, 1)
    assert.equal(movedSchedule.commitments, 1)
    assert.equal(movedSchedule.personFacts, 1)
    assert.equal(await redis.get(migrationPrefix + scheduledNotebook), '[]')
    assert.deepEqual(new Set((await targetPeople.query({ ...targetQuery, scene: otherGroupNote.memorySource.scene })).items.map(item => item.id)),
      new Set([portableFact.id, otherGroupNote.personMemoryId]))
    assert.ok((await targetPeople.query(targetQuery)).items.some(item => item.id === currentFact.id))
    assert.equal(await redis.get(scheduledSource), null)
    assert.equal(await redis.get(scheduledSession), null)
    assert.deepEqual(JSON.parse(await redis.get(scheduledDestination)), scheduledTask)
    yield

    const goalScope = { ...roleScope, groupId: goalGroup }
    const sourceCharacterKey = characterKey(goalScope)
    const destinationCharacterKey = migrationPrefix + sourceCharacterKey
    const sourceRhythmKey = simulationRhythmKey(goalScope)
    const destinationRhythmKey = migrationPrefix + sourceRhythmKey
    const sourceReflectionKey = characterReflectionKey(goalScope)
    const destinationReflectionKey = migrationPrefix + sourceReflectionKey
    const sourceGoalSessionKey = simulationSessionKey(goalAddress)
    const sourceInitialPromptKey = simulationInitialPromptKey(goalAddress)
    const destinationInitialPromptKey = migrationPrefix + sourceInitialPromptKey
    const sourceInitialPrompt = '管理员为源群保存的启动提示'
    const characterAt = scheduledAt - 3_600_000
    const rhythm = { sleepFrom: 3, sleepTo: 9, setBy: 'agent', updatedAt: characterAt }
    const reflection = { schemaVersion: 1, lastRunAt: characterAt, nextRunAt: scheduledAt + 3_600_000,
      lastOutcome: '原宿主反思的群聊语境', runsToday: 1, day: new Date(characterAt).toISOString().slice(0, 10), processed: ['receipt:sent-before'] }
    const goalMemoryText = '角色记着自己发过公开的版本提示'
    const oldGoalMemoryText = '旧版本的角色经历不应重新出现'
    const sourceReceiptText = '原主机回执详情只留在源端'
    const rootMemory = { id: 'role-fact', kind: 'experience', epistemic: 'observed', content: goalMemoryText,
      evidenceRefs: ['receipt:sent-before', 'memory:old-role-fact'], supersedes: 'old-role-fact', createdAt: characterAt, updatedAt: characterAt }
    const previousMemory = { id: 'old-role-fact', kind: 'experience', epistemic: 'observed', content: oldGoalMemoryText,
      evidenceRefs: ['receipt:sent-before'], createdAt: characterAt - 1, updatedAt: characterAt - 1 }
    const ongoing = { kind: 'autonomous', status: 'active', motivation: '整理自己发过的版本说明', nextStep: '核对先前的公开提示',
      completionCriteria: '确认公开说明内容', stopConditions: ['到期后停止'], evidenceRefs: ['memory:role-fact'], attempts: 0, maxAttempts: 3,
      revision: 1, createdAt: characterAt, updatedAt: characterAt, nextCheckAt: scheduledAt, expiresAt: scheduledAt + 3_600_000 }
    const goalState = validateCharacterState({ ...createEmptyCharacterState(goalScope), revision: 3,
      memories: [previousMemory, rootMemory,
        { ...previousMemory, id: 'source-chat', epistemic: 'reported', content: '源群聊天派生的经历', evidenceRefs: ['message:5'] },
        { ...previousMemory, id: 'external-evidence', content: '宿主外部工具派生的经历', evidenceRefs: ['receipt:external'] },
        { ...previousMemory, id: 'shared-source', content: '其他群共享偏好派生的经历', sharedSources: ['shared-1'] }],
      goals: [{ ...ongoing, id: 'cutover-due-goal', title: '接续已到期的自主目标' },
        { ...ongoing, id: 'cutover-uncertain-goal', title: '核对发送结果未知的目标', status: 'waiting', attempts: 1, revision: 2 },
        { ...ongoing, id: 'source-only-goal', title: '依赖源聊天的目标', evidenceRefs: ['memory:source-chat'] }],
      receipts: [{ id: 'sent-before', toolName: 'simSendMessage', status: 'succeeded', summary: sourceReceiptText, at: characterAt },
        { id: 'sending-at-cutover', toolName: 'simSendMessage', status: 'pending', summary: '仍等待原发送回执',
          at: characterAt, goalId: 'cutover-uncertain-goal', goalRevision: 2 },
        { id: 'external', toolName: 'searchInformationTool', status: 'succeeded', summary: '旧平台工具返回的正文', at: characterAt }],
    }, goalScope)
    const rawGoalState = JSON.stringify(goalState)
    const sourceGoalBinding = createAgentBindingConfig(pluginBindings)().resolve(goalTarget)
    const sourceGoalSession = { ...createDefaultSimSession(characterAt), botId: String(BOT), personaId: goalScope.personaId,
      bindingToken: agentBindingToken(sourceGoalBinding), bootstrapSent: true }
    await redis.multi().set(sourceCharacterKey, rawGoalState).set(sourceRhythmKey, JSON.stringify(rhythm))
      .set(sourceReflectionKey, JSON.stringify(reflection)).set(sourceGoalSessionKey, JSON.stringify(sourceGoalSession))
      .set(sourceInitialPromptKey, sourceInitialPrompt).exec()
    const workspaceKey = characterWorkspaceKey(goalScope)
    const workspace = createCharacterWorkspace({ redis, scope: goalScope, now: () => characterAt })
    const draft = await workspace.write({ title: '已发布版本的整理草稿', kind: 'note', content: '复用公开的版本说明', evidenceRefs: ['memory:role-fact'] })
    await workspace.write({ title: '旧群消息草稿', kind: 'note', content: '依赖原群聊天记录的作品', evidenceRefs: ['message:5'] })
    const sourceWorkspace = await redis.get(workspaceKey)
    const goalSelector = ['--group', goalGroup]
    const allowRole = '--include-character-state'
    const runCharacterMigration = flags => runMigration(pluginBindings, [allowRole, ...flags], migrationEnv, goalSelector)
    const goalPreview = await runCharacterMigration([])
    const roleReport = { memories: 1, goals: 2, receipts: 2, retainedMemories: 4, retainedGoals: 1, pausedGoals: 1 }
    assert.deepEqual(goalPreview.characterState, roleReport)
    assert.deepEqual(goalPreview.characterWorkspace, { works: 1, versions: 1, retainedWorks: 1, retainedVersions: 1 })
    assert.ok(!JSON.stringify(goalPreview).includes(draft.title))
    assert.deepEqual(goalPreview.initialPrompt, { status: 'copied', firstModelCall: false })
    const scheduleReport = { rhythmTransferred: true, reflectionTransferred: true, nextReflectionAt: reflection.nextRunAt,
      reflectionRunsToday: reflection.day === new Date().toISOString().slice(0, 10) ? 1 : 0 }
    assert.deepEqual(goalPreview.characterSchedule, scheduleReport)
    assert.ok(!JSON.stringify(goalPreview).includes(reflection.lastOutcome))
    assert.equal(await redis.get(sourceCharacterKey), rawGoalState)
    assert.equal(await redis.get(destinationCharacterKey), null)
    assert.equal(await redis.get(goalSession), null)
    assert.equal(await redis.get(destinationRhythmKey), null)
    assert.equal(await redis.get(destinationReflectionKey), null)
    assert.equal(await redis.get(destinationInitialPromptKey), null)
    assert.equal(await redis.get(migrationPrefix + workspaceKey), null)
    await redis.set(destinationCharacterKey, JSON.stringify({ ...createEmptyCharacterState(goalScope), memories: [previousMemory], receipts: [goalState.receipts[0]] }))
    await assert.rejects(runRejectedMigration(pluginBindings, [allowRole, '--apply'], migrationEnv, goalSelector), /目标已有角色状态/)
    assert.equal(await redis.get(sourceCharacterKey), rawGoalState)
    assert.equal(await redis.get(goalSession), null)
    await redis.del(destinationCharacterKey)
    await redis.set(destinationRhythmKey, JSON.stringify({ ...rhythm, sleepFrom: 4 }))
    await assert.rejects(runRejectedMigration(pluginBindings, [allowRole, '--apply'], migrationEnv, goalSelector), /目标已有角色作息或反思排期/)
    assert.equal(await redis.get(destinationCharacterKey), null)
    assert.equal(await redis.get(destinationReflectionKey), null)
    assert.equal(await redis.get(sourceCharacterKey), rawGoalState)
    await redis.del(destinationRhythmKey)
    await redis.set(simulationBusyKey(goalAddress), 'role-turn-running')
    await assert.rejects(runRejectedMigration(pluginBindings, [allowRole, '--apply'], migrationEnv, goalSelector), /仍有进行中的工作/)
    assert.equal(await redis.get(destinationCharacterKey), null)
    assert.equal(await redis.get(sourceCharacterKey), rawGoalState)
    await redis.del(simulationBusyKey(goalAddress))
    const appliedGoal = await runCharacterMigration(['--apply'])
    assert.deepEqual(appliedGoal.characterState, roleReport)
    assert.deepEqual(appliedGoal.characterWorkspace, goalPreview.characterWorkspace)
    assert.deepEqual(JSON.parse(await redis.get(migrationPrefix + workspaceKey)).works, [draft])
    assert.equal(await redis.get(workspaceKey), sourceWorkspace)
    assert.deepEqual(appliedGoal.initialPrompt, goalPreview.initialPrompt)
    assert.equal(await redis.get(destinationInitialPromptKey), sourceInitialPrompt)
    assert.equal(await redis.get(sourceInitialPromptKey), sourceInitialPrompt)
    assert.deepEqual(appliedGoal.characterSchedule, scheduleReport)
    assert.deepEqual(JSON.parse(await redis.get(destinationRhythmKey)), rhythm)
    assert.deepEqual(JSON.parse(await redis.get(destinationReflectionKey)), { ...reflection, lastOutcome: '已接续原角色的反思排期' })
    assert.deepEqual(JSON.parse(await redis.get(sourceRhythmKey)), rhythm)
    assert.deepEqual(JSON.parse(await redis.get(sourceReflectionKey)), reflection)
    const transferred = JSON.parse(await redis.get(destinationCharacterKey))
    assert.deepEqual(transferred.memories, [{ ...previousMemory, content: '已被后续版本修正' }, rootMemory])
    assert.ok(!JSON.stringify(transferred).includes(oldGoalMemoryText))
    assert.deepEqual(transferred.goals[0], goalState.goals[0])
    assert.equal(transferred.goals[1].status, 'paused')
    assert.equal(transferred.goals[1].attempts, 1)
    assert.equal(transferred.receipts.find(receipt => receipt.id === 'sending-at-cutover').status, 'unknown')
    assert.ok(!JSON.stringify(transferred).includes(sourceReceiptText))
    const retainedGoals = JSON.parse(await redis.get(sourceCharacterKey)).goals
    assert.deepEqual(retainedGoals.map(goal => [goal.id, goal.status]), [
      ['cutover-due-goal', 'abandoned'], ['cutover-uncertain-goal', 'abandoned'], ['source-only-goal', 'active'],
    ])
    const seededGoalSession = JSON.parse(await redis.get(goalSession))
    assert.equal(seededGoalSession.botId, String(BOT))
    assert.deepEqual(seededGoalSession.recent, [])
    assert.deepEqual(seededGoalSession.agentHistory, [])
    assert.deepEqual(new Set(JSON.parse(await redis.get(knownKey)).filter(id => id === goalAddress || id === timerAddress)), new Set([goalAddress, timerAddress]))
    const repeatedGoalTransfer = await runCharacterMigration(['--apply'])
    assert.equal(repeatedGoalTransfer.characterState, undefined)
    assert.equal(repeatedGoalTransfer.characterSchedule, undefined)
    assert.equal(repeatedGoalTransfer.characterWorkspace, undefined)
    assert.deepEqual(repeatedGoalTransfer.initialPrompt, { status: 'alreadyCopied' })
    assert.deepEqual(JSON.parse(await redis.get(destinationCharacterKey)), transferred)
    yield

    await fs.writeFile(config, YAML.stringify({ ...migrationConfig, simulation: { ...migrationConfig.simulation,
      wake: { ...migrationConfig.simulation.wake, batchWindowMs: 1_000 },
    } }))
    const beforeGoalWake = requests.length
    const scheduledHost = launch()
    await waitUntil(() => scheduledHost.log.includes('已启动'), 'new host resumes migrated agent commitment', 15_000)
    const timeoutCalls = () => requests.slice(beforeGoalWake).filter(body => {
      const wake = body.messages.findLast(row => row.role === 'user' && String(row.content).includes('【执行主体】'))
      return String(wake?.content).includes('【唤醒原因】timeout') && String(wake?.content).includes(`"groupId":"${timerGroup}"`)
    })
    await waitUntil(() => timeoutCalls().length > 0, 'migrated timer fires without incoming chat')
    await waitUntil(async () => !await redis.exists(migrationPrefix + simulationBusyKey(timerAddress)), 'migrated timer finishes its turn')
    assert.equal(timeoutCalls().length, 1)
    assert.ok(!JSON.stringify(timeoutCalls()[0]).includes('定时唤醒以前的聊天不随迁移'))
    const timerAfterWake = JSON.parse(await redis.get(timerTargetKey))
    assert.deepEqual(timerAfterWake.wakeConfig, { ...sourceWakeConfig, mode: 'diving' })
    assert.equal(timerAfterWake.queuedIngressWake, undefined)
    assert.equal(timerAfterWake.budget.turns, 1)
    await waitUntil(async () => JSON.parse(await redis.get(scheduledDestination)).status !== 'active', 'migrated agent commitment settles without a new group message')
    const settled = JSON.parse(await redis.get(scheduledDestination))
    assert.equal(settled.status, 'completed', JSON.stringify({ reason: settled.last_result, log: scheduledHost.log }))
    assert.deepEqual(deliveries.filter(item => item.params.group_id === GROUP + 1).map(item => item.params.message), [
      [{ type: 'text', data: { text: '迁入的仿真承诺已完成' } }],
    ])
    const newSession = JSON.parse(await redis.get(scheduledSession))
    assert.equal(newSession.botId, String(BOT))
    assert.equal(newSession.bootstrapSent, true)
    assert.equal(newSession.budget.turns, 1)
    assert.deepEqual(newSession.recent, [])
    await waitUntil(() => requests.slice(beforeGoalWake).some(body => body.messages.some(row => String(row.content).includes('自己的目标到检查时间（cutover-due-goal）'))),
      'migrated autonomous goal advances without a new group message')
    const goalRequest = requests.slice(beforeGoalWake).find(body => body.messages.some(row => String(row.content).includes('自己的目标到检查时间（cutover-due-goal）')))
    assert.ok(JSON.stringify(goalRequest.messages).includes(goalMemoryText))
    assert.ok(!JSON.stringify(goalRequest.messages).includes(sourceInitialPrompt))
    assert.ok(!JSON.stringify(goalRequest.messages).includes(oldGoalMemoryText))
    assert.ok(!JSON.stringify(goalRequest.messages).includes('源群聊天派生的经历'))
    assert.ok(goalRequest.tools.every(tool => tool.function.name !== 'delegateMemoryTool'))
    const checkedGoal = JSON.parse(await redis.get(destinationCharacterKey)).goals.find(goal => goal.id === 'cutover-due-goal')
    assert.equal(checkedGoal.attempts, 1)
    assert.equal(checkedGoal.status, 'waiting')
    assert.deepEqual(deliveries.filter(item => item.params.group_id === Number(goalGroup)), [])
    await waitUntil(async () => !await redis.exists(migrationPrefix + simulationBusyKey(goalAddress)), 'migrated goal turn finishes before testing message wakes')
    const quoteSession = JSON.parse(await redis.get(goalSession))
    quoteSession.wakeConfig.triggers.probability = 0
    quoteSession.conversation = { activeUntil: 0, interlocutorIds: [] }
    await redis.set(goalSession, JSON.stringify(quoteSession))

    const quoteScopeId = GROUP + 2
    const originalGroupMessage = { message_type: 'group', group_id: quoteScopeId, self_id: BOT, time: Math.floor(Date.now() / 1000) - 1,
      sender: { user_id: BOT, nickname: '独立群聊角色' } }
    const goodQuote = 89101
    const wrongGroup = 89102
    const missingGroup = 89103
    const recalledQuote = 89104
    const nextQuote = 89105
    const wrongMessage = 89106
    const wrongAccount = 89107
    const forbiddenMessage = 89108
    const quoteText = '切换前同群的真实回复'
    const replaySource = (id, text, overrides = {}) => ({ ...originalGroupMessage, message_id: id, message: text, ...overrides })
    readableMessages.set(goodQuote, replaySource(goodQuote, quoteText))
    readableMessages.set(wrongGroup, replaySource(wrongGroup, '另一个群的原文', { group_id: GROUP }))
    readableMessages.set(missingGroup, replaySource(missingGroup, '无法证明地址的原文', { group_id: undefined }))
    readableMessages.set(wrongMessage, replaySource(89100, '和申请不符的消息原文'))
    readableMessages.set(wrongAccount, replaySource(wrongAccount, '另一个账号的原文', { self_id: BOT + 1 }))
    readableMessages.set(forbiddenMessage, replaySource(forbiddenMessage, '禁止输入样本'))
    readableMessages.set(recalledQuote, replaySource(recalledQuote, '已撤回的旧回复内容'))
    readableMessages.set(nextQuote, replaySource(nextQuote, '仍在当前群可见的发言', { sender: { user_id: USER + 1, nickname: '原发言者' } }))
    const emitQuote = (id, sourceId, text, mentions = []) => emit(groupText(id, text, [...mentions, ...quoteOf(sourceId)], { group_id: quoteScopeId }))
    const quoteRequestStart = requests.length
    const rejectedSources = [wrongGroup, missingGroup, wrongMessage, wrongAccount, forbiddenMessage]
    const readBeforeRejections = requestedMessageIds.length
    const rejectedMessages = rejectedSources.map((sourceId, index) => {
      const messageId = 99201 + index
      emitQuote(messageId, sourceId, '原消息来源验证')
      return String(messageId)
    })
    const messagesWithRejectedQuotes = await waitUntil(async () => {
      const recent = JSON.parse(await redis.get(goalSession)).recent.filter(item => rejectedMessages.includes(item.messageId))
      return recent.length === rejectedSources.length && recent
    }, 'rejected OneBot reads preserve incoming text')
    assert.deepEqual(requestedMessageIds.slice(readBeforeRejections), rejectedSources)
    assert.ok(messagesWithRejectedQuotes.every(item => item.text === '原消息来源验证' && !item.quoteToSelf && !item.quoteText && !item.quoteSource))
    assert.equal(requests.length, quoteRequestStart)
    emitQuote(99101, goodQuote, '我想接着上一句说')
    const quotePrompt = await waitUntil(() => requests.slice(quoteRequestStart).find(body => body.messages.some(row => String(row.content).includes(quoteText))),
      'a reply to a verified pre-cutover message wakes simulation')
    const retrieved = JSON.parse(await redis.get(goalSession)).recent.find(item => item.messageId === '99101')
    assert.equal(retrieved.atSelf, false)
    assert.equal(retrieved.quoteToSelf, true)
    assert.equal(retrieved.quoteText, quoteText)
    assert.ok(Number.isSafeInteger(retrieved.quoteSource.invalidatedAt))
    assert.deepEqual(retrieved.quoteSource, { messageId: String(goodQuote), invalidatedAt: retrieved.quoteSource.invalidatedAt })
    assert.ok(quotePrompt.messages.every(row => !/另一个群的原文|无法证明地址的原文|和申请不符的消息原文|另一个账号的原文|禁止输入样本/u.test(String(row.content))))
    const readBeforeRecall = requestedMessageIds.length
    emitQuote(99104, recalledQuote, '准备撤回的引用')
    await waitUntil(async () => JSON.parse(await redis.get(goalSession)).recent.some(item => item.messageId === '99104' && item.quoteToSelf), 'quote wake was queued from the source')
    emit({ ...groupRecall(recalledQuote), group_id: quoteScopeId })
    await waitUntil(async () => {
      const state = JSON.parse(await redis.get(goalSession))
      return state.recent.some(item => item.messageId === '99104' && !item.quoteSource && !item.quoteToSelf) && !state.queuedIngressWake
    }, 'recalling the old source removes the stored snippet and pending quote wake')
    emitQuote(99105, nextQuote, '再次接话', at)
    await waitUntil(() => requests.slice(quoteRequestStart).some(body => body.messages.some(row => String(row.content).includes('仍在当前群可见的发言'))),
      'a valid quote still works after the recall')
    emitQuote(99107, recalledQuote, '重复读取已撤回来源')
    await waitUntil(async () => JSON.parse(await redis.get(goalSession)).recent.some(item => item.messageId === '99107'), 'recalled sources cannot be recovered from OneBot')
    assert.deepEqual(requestedMessageIds.slice(readBeforeRecall), [recalledQuote, nextQuote])
    assert.ok(requests.slice(quoteRequestStart).every(body => body.messages.every(row => !String(row.content).includes('已撤回的旧回复内容'))))
    assert.deepEqual(await stop(scheduledHost, 'SIGTERM'), [0, null])
    const timerRestart = launch()
    await waitUntil(() => timerRestart.log.includes('已启动'), 'host reloads the completed timer', 15_000)
    await delay(1_100)
    assert.equal(timeoutCalls().length, 1)
    assert.equal(JSON.parse(await redis.get(timerTargetKey)).budget.turns, 1)
    yield

    const forwardGroup = String(GROUP + 4)
    const forwardAddress = simulationAddressKey({ ...groupTarget, id: forwardGroup })
    const forwardSessionKey = migrationPrefix + simulationSessionKey(forwardAddress)
    await fs.writeFile(bindingFile, YAML.stringify({ ...scheduledBindings, bindings: [...scheduledBindings.bindings,
      { ...bindingConfig.bindings[0], agentId: 'another-agent', conversationId: forwardGroup }] }))
    const forwardAccount = { group_id: Number(forwardGroup) }
    const forwardIdentity = { botId: String(BOT), personaId: agentPersonaScopeId('another-agent') }
    const forwardScene = { kind: 'group', id: forwardGroup }
    await targetPeople.revokeSource({ identity: forwardIdentity, scene: forwardScene, messageId: 'older-chat' })
    const { invalidatedAt: forwardCutoff } = await targetPeople.getSceneRedactions({ identity: forwardIdentity, scene: forwardScene })
    const forwardedAt = Math.ceil((forwardCutoff + 1) / 1_000)
    const messageAt = forwardedAt + 1
    const plainForward = id => ({ type: 'forward', data: { id } })
    const forwardRecord = (id, forwarded, overrides = {}) => ({ ...originalGroupMessage, ...forwardAccount,
      message_id: id, time: messageAt,
      sender: { user_id: USER, nickname: '发转发的群友' }, message: [plainForward(forwarded)], ...overrides })
    const forwardAt = id => [at[0], plainForward(id)]
    const forwardRow = (message, nickname = '活动负责人') => ({ sender: { nickname }, time: forwardedAt, message })
    const forwardTurnStart = requests.length
    const forwardDeliveredStart = deliveries.length
    readableMessages.set(99300, forwardRecord(99300, 'unseen-forward'))
    readableMessages.set(99301, forwardRecord(99301, 'visible-forward'))
    readableMessages.set(99302, forwardRecord(99302, 'wrong-group-forward', { group_id: GROUP }))
    readableMessages.set(99303, forwardRecord(99303, 'different-forward'))
    readableMessages.set(99304, forwardRecord(99304, 'waiting-forward'))
    readableForwards.set('unseen-forward', { messages: [forwardRow('未经本轮授权的转发')] })
    readableForwards.set('visible-forward', { message: [
      { type: 'node', data: { nickname: '【组织者】', time: forwardedAt, content: `${forwardText}[CQ:image,file=/tmp/image][CQ:forward,id=nested-forward]` } },
      { type: 'node', data: { nickname: '群友', time: forwardedAt, content: '禁止输入样本' } },
      { type: 'node', data: { nickname: '群友', time: forwardedAt - 2, content: '旧隐私水位前的转发' } },
      { type: 'node', data: { nickname: '转发者', time: forwardedAt, content: [{ type: 'forward', data: { id: 'inline-forward', content: [forwardRow('内嵌消息的后续安排')] } }] } },
    ] })
    readableForwards.set('nested-forward', { messages: [forwardRow([{ type: 'text', data: { text: '第二层的文字记录' } }, plainForward('visible-forward')])] })
    readableForwards.set('waiting-forward', { messages: [forwardRow(recalledForwardText)] })

    // A forward-only frame is real ingress, even if the current wake policy ignores it.
    emit(groupMessage(99300, '', { ...forwardAccount, time: messageAt, message: '[CQ:forward,id=unseen-forward]' }))
    const readForwardState = async () => JSON.parse(await redis.get(forwardSessionKey) ?? 'null')
    const waitForwardTurn = () => waitUntil(async () => !await redis.exists(migrationPrefix + simulationBusyKey(forwardAddress)), 'forward turn finishes')
    const bareForward = await waitUntil(async () => (await readForwardState())?.recent.find(row => row.messageId === '99300'), 'forward-only message is retained')
    assert.equal(bareForward.text, '')
    assert.equal(bareForward.forwardId, 'unseen-forward')
    await waitUntil(async () => (await readForwardState()).lastWakeReason?.kind === 'bootstrap', 'the initial forward-only turn starts')
    await waitForwardTurn()
    const { queuedIngressWake: _none, ...settledForwardSession } = await readForwardState()
    await redis.set(forwardSessionKey, JSON.stringify({ ...settledForwardSession, wakeConfig: { ...settledForwardSession.wakeConfig,
      triggers: { ...settledForwardSession.wakeConfig.triggers, probability: 0 } } }))
    const forwardTrigger = (id, text, forwardId, userId = USER + 2) =>
      emit(groupText(id, text, forwardAt(forwardId), { ...forwardAccount, time: messageAt, user_id: userId }))
    forwardTrigger(99301, '同群转发验收', 'visible-forward')
    const forwardedWakeIndex = body => body.messages.findLastIndex(row => row.role === 'user' && String(row.content).includes('【执行主体】'))
    const currentTools = body => body.messages.slice(forwardedWakeIndex(body)).filter(row => row.role === 'tool')
    const expanded = await waitUntil(() => requests.slice(forwardTurnStart).find(body => currentTools(body).length > 0), 'forward tool returns its results to the model')
    const expandedTools = currentTools(expanded).map(row => {
      const content = String(row.content)
      return content.startsWith('error:') ? { error: content } : JSON.parse(content)
    })
    assert.deepEqual(expandedTools[1].lines, ['⟨组织者⟩：修订后的公开活动流程[图片][内嵌转发]', '  活动负责人：第二层的文字记录[内嵌转发]', '转发者：[内嵌转发]', '  活动负责人：内嵌消息的后续安排'], JSON.stringify({ expandedTools, requestedMessageIds, forwarded: requestedForwards.map(item => item.params) }))
    assert.equal(expandedTools[1].partial, true)
    assert.match(expandedTools[0].error, /本轮可见/)
    assert.match(expandedTools[2].error, /本轮可见/)
    assert.deepEqual(requestedForwards.map(item => item.params), [
      { id: 'visible-forward', message_id: 'visible-forward' }, { id: 'nested-forward', message_id: 'nested-forward' },
    ])
    assert.deepEqual(expanded.tools.find(tool => tool.function.name === 'simGetForward').function.parameters.required, ['seq'])
    assert.ok(expanded.messages.every(row => !/禁止输入样本|旧隐私水位前的转发|未经本轮授权|\/tmp\/image/u.test(String(row.content))))
    await waitUntil(() => deliveries.length > forwardDeliveredStart, 'expanded forward can be answered in the original QQ group')
    const forwardedReply = deliveries[forwardDeliveredStart]
    assert.equal(forwardedReply.params.group_id, Number(forwardGroup))
    assert.deepEqual(forwardedReply.params.message[0], { type: 'reply', data: { id: '99301' } })
    await waitForwardTurn()
    assert.ok(!(await readForwardState()).agentHistory.some(row => String(row.content).includes(forwardText)))

    forwardTrigger(99302, '越群转发验收', 'wrong-group-forward', USER + 3)
    forwardTrigger(99303, '不匹配转发验收', 'mismatched-forward', USER + 4)
    await waitUntil(() => requestedMessageIds.includes(99302) && requestedMessageIds.includes(99303), 'both unverified anchors are checked')
    await waitUntil(() => requests.slice(forwardTurnStart).filter(body => currentTools(body).some(row => String(row.content).includes('无法确认原群消息'))).length >= 2,
      'both rejected reads reach the model without forward text')
    await waitForwardTurn()
    assert.equal(requestedForwards.length, 2)

    forwardTrigger(99304, '撤回转发验收', 'waiting-forward')
    const waitingForward = await waitUntil(() => requestedForwards.find(item => item.params.id === 'waiting-forward'), 'forward read is in flight')
    emit({ ...groupRecall(99304), ...forwardAccount })
    await waitUntil(async () => !(await readForwardState()).recent.some(row => row.messageId === '99304'), 'forward source is recalled while reading')
    waitingForward.respond()
    await waitForwardTurn()
    assert.ok(requests.slice(forwardTurnStart).every(body => body.messages.every(row => !String(row.content).includes(recalledForwardText))))
    assert.equal(deliveries.length, forwardDeliveredStart + 1)

    const simRetryText = '换绑时停止仿真模型的兼容重试'
    const simRetry = { calls: [], complete: Promise.withResolvers() }
    compatibilityGates.set(simRetryText, simRetry)
    try {
      emit(groupText(99305, simRetryText, at, forwardAccount))
      await waitUntil(() => simRetry.calls.length === 1, 'old simulation binding has reached the provider')
      assert.equal(typeof simRetry.calls[0].temperature, 'number')
      await fs.appendFile(bindingFile, '\n# 角色不变，绑定版本已更新\n')
    } finally { simRetry.complete.resolve() }
    await waitForwardTurn()
    assert.equal(simRetry.calls.length, 1)
    assert.equal(deliveries.length, forwardDeliveredStart + 1)
    assert.deepEqual(await stop(timerRestart, 'SIGTERM'), [0, null])
    yield

    const totalDeliveries = deliveries.length
    loginId = BOT + 1
    const wrong = launch()
    const [wrongCode] = await once(wrong.child, 'exit')
    assert.equal(wrongCode, 1)
    assert.match(wrong.log, /未能验证 QQ 账号/)
    assert.equal(deliveries.length, totalDeliveries)
    assert.ok(!hostLogs.map(getLog => getLog()).join('').includes(auth))
  }

})

test('standalone QQ sends verified group images only to the configured vision model', {
  skip: redisAvailable ? false : 'redis-server unavailable', timeout: 45_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bl-agent-vision-'))
  const socket = path.join(directory, 'redis.sock')
  const redisProcess = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const backend = createServer()
  const platform = new WebSocketServer({ noServer: true })
  const children = []
  const modelRequests = []
  const visionRequests = []
  const lookups = []
  const deliveries = []
  const originals = new Map()
  const groups = { plain: 10091, direct: 10092, quote: 10093, foreign: 10094, recalled: 10095, rebound: 10096, unauthorized: 10097, empty: 10098 }
  const text = '图上有一只拿蓝伞的猫'
  const forbidden = '图片测试禁词'
  const privateVisionBody = 'VISION_CLI_PRIVATE_PROVIDER_BODY'
  const image = { type: 'image', data: { file: `base64://${fixturePng}` } }
  const mention = { type: 'at', data: { qq: String(BOT) } }
  const talk = value => ({ type: 'text', data: { text: value } })
  const reply = id => ({ type: 'reply', data: { id: String(id) } })
  const mediaTime = Math.floor(Date.now() / 1000)
  let websocket
  let redis
  let holdLookup
  let nextVisionGate
  let nextVisionResponse
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
    for (const client of platform.clients) client.terminate()
    await new Promise(resolve => platform.close(resolve))
    backend.closeAllConnections()
    await new Promise(resolve => backend.close(resolve))
    if (redis?.isOpen) await redis.close()
    if (redisProcess.exitCode === null && redisProcess.signalCode === null) {
      const exited = once(redisProcess, 'exit')
      redisProcess.kill('SIGTERM')
      await exited
    }
    await fs.rm(directory, { recursive: true, force: true })
  })

  backend.on('upgrade', (request, connection, head) =>
    platform.handleUpgrade(request, connection, head, client => platform.emit('connection', client)))
  platform.on('connection', client => {
    websocket = client
    client.on('message', raw => {
      const { action, params, echo } = JSON.parse(String(raw))
      function respond(data) {
        if (client.readyState === client.OPEN) client.send(JSON.stringify({ status: data ? 'ok' : 'failed', retcode: data ? 0 : 100, echo, data }))
      }
      if (action === 'get_login_info') return respond({ user_id: BOT, nickname: '看图验收' })
      if (action === 'get_msg') {
        lookups.push(params.message_id)
        const data = originals.get(params.message_id)
        if (params.message_id === 90107) { holdLookup = () => respond(data); return }
        return respond(data)
      }
      deliveries.push({ action, params })
      respond({ message_id: 88000 + deliveries.length })
    })
  })
  const tool = (name, args, suffix) => ({ id: `${name}-${suffix}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const sendModel = (response, message) => response.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }))
  backend.on('request', async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.method === 'POST' && request.url === '/vision/v1/chat/completions') {
      const status = nextVisionResponse
      nextVisionResponse = undefined
      visionRequests.push({ body, auth: request.headers.authorization, status })
      const gate = nextVisionGate
      nextVisionGate = undefined
      await gate
      if (status === 401) {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: {
          message: `${privateVisionBody} vision-fixture chat-fixture ${request.url} https://private.invalid/vision?token=private ${fixturePng}`,
        } }))
        return
      }
      if (status === 200) { sendModel(response, { content: '' }); return }
      sendModel(response, { content: text })
      return
    }
    if (request.method !== 'POST' || request.url !== '/chat/v1/chat/completions') { response.writeHead(404).end(); return }
    const lastWake = body.messages.findLastIndex(row => row.role === 'user' && String(row.content).includes('【执行主体】'))
    const visible = String(body.messages[lastWake]?.content ?? '')
    const results = body.messages.slice(Math.max(0, lastWake)).filter(row => row.role === 'tool')
    const result = results.at(-1)?.content
    const hasImages = body.tools?.some(item => item.function.name === 'simGetMessageImages') ?? false
    modelRequests.push({ body, visible, result, hasImages })
    if (lastWake < 0) { sendModel(response, { content: '' }); return }
    const command = [...visible.matchAll(/^#(\d+)[^\n]*(?:直接看图验收|引用看图验收|跨群看图验收|来源不符验收|来源禁词验收|撤回看图验收|换绑看图验收|认证失败看图验收|空内容看图验收)[^\n]*$/gmu)].at(-1)
    const pureImage = visible.match(/^#(\d+)[^\n]*图源发送者:[ \t]+\[附图×1\]$/mu)
    const seq = Number(command?.[1] ?? pureImage?.[1] ?? 0)
    const success = results.some(row => String(row.content).includes(text))
    const calls = result !== undefined || !hasImages || !seq
      ? [tool('simFinishTurn', { choice: success ? 'chat' : 'silent', reason: '图片验收结束',
        ...(success ? { messages: ['看到图里的蓝伞了。'], replyToSeq: seq } : {}) }, seq)]
      : (command?.[0].includes('直接看图验收') ? [
        tool('simGetMessageImages', { seq: 999 }, 'hidden'),
        tool('simGetMessageImages', { seq, url: 'https://invalid.example/image.png' }, 'extra'),
        tool('simGetMessageImages', { seq }, `${seq}-0`),
        tool('simGetMessageImages', { seq }, `${seq}-1`),
        tool('simGetMessageImages', { seq }, `${seq}-2`),
      ] : [tool('simGetMessageImages', { seq }, seq)])
    sendModel(response, { content: success ? text : '', tool_calls: calls })
  })
  const port = await listen(backend)
  await waitUntil(() => fs.stat(socket).then(() => true, () => false), 'vision fixture Redis socket')
  redis = createClient({ socket: { path: socket } })
  await redis.connect()
  const file = path.join(directory, 'agent-host.yaml')
  const bindingFile = path.join(directory, 'agent-bindings.yaml')
  const binding = {
    version: 1, agents: [{ id: 'image-role', personaId: 'default' }, { id: 'new-role', personaId: 'default' }],
    connections: [{ id: 'qq-local', platform: 'qq', namespace: 'global', accountId: String(BOT) }],
    bindings: Object.values(groups).map(groupId => ({
      connectionId: 'qq-local', kind: 'group', conversationId: String(groupId), agentId: 'image-role',
    })),
  }
  const config = {
    version: 1, instance: 'vision-test', dataDir: 'data',
    model: { baseUrl: `http://127.0.0.1:${port}/chat`, name: 'local-chat', apiKeyEnv: 'TEST_AGENT_CHAT_KEY' },
    simulation: {
      wake: { batchWindowMs: 1_000, probability: 0, proactiveProbability: 0 }, rhythm: { enabled: false }, reflection: { enabled: false },
      turn: { minSendGapMs: 0, maxTurnsPerDay: 30 },
    },
    forbiddenWords: { words: [forbidden] },
    connections: [{ id: 'qq-local', url: `ws://127.0.0.1:${port}` }],
  }
  const env = { ...process.env, BL_AGENT_REDIS_URL: `unix://${socket}`, TEST_AGENT_CHAT_KEY: 'chat-fixture', TEST_AGENT_VISION_KEY: 'vision-fixture' }
  async function launch() {
    const child = spawn(process.execPath, [agentEntry, '--config', file], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
    t.after(() => { if (t.error) t.diagnostic(log) })
    await waitUntil(() => log.includes('已启动'), 'vision fixture host online', 15_000)
    return { child, readLog: () => log }
  }
  async function stop(child) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    assert.deepEqual(await exited, [0, null])
  }
  const groupAddress = group => simulationAddressKey({ account: { platform: 'qq', namespace: 'global', id: String(BOT) }, kind: 'group', id: String(group) })
  const keyOf = key => `bl-agent:${config.instance}:${key}`
  const session = async group => JSON.parse(await redis.get(keyOf(simulationSessionKey(groupAddress(group)))) ?? 'null')
  const emit = payload => websocket.send(JSON.stringify(payload))
  const record = (group, id, message, overrides = {}) => ({
    message_type: 'group', self_id: BOT, user_id: USER, group_id: group, message_id: id, time: mediaTime,
    sender: { user_id: USER, nickname: '图源发送者' }, message, ...overrides,
  })
  const publish = (group, id, parts, changes = {}, original = {}) => {
    const event = record(group, id, parts, changes)
    originals.set(id, { ...event, ...original })
    emit({ ...event, post_type: 'message' })
  }
  const recall = (group, id) => emit({ post_type: 'notice', notice_type: 'group_recall', self_id: BOT, group_id: group, message_id: id })
  const settled = group => waitUntil(async () => {
    const state = await session(group)
    return state?.lastWakeAt && !state.queuedIngressWake && !await redis.exists(keyOf(simulationBusyKey(groupAddress(group))))
  }, `图片回合 ${group} 结束`)

  await fs.writeFile(bindingFile, YAML.stringify(binding))
  await fs.writeFile(file, YAML.stringify(config))
  const withoutVision = await launch()
  publish(groups.plain, 90100, [mention, image])
  await waitUntil(() => modelRequests.length, 'text-only model sees the attachment marker')
  await settled(groups.plain)
  assert.equal(modelRequests[0].hasImages, false)
  assert.match(modelRequests[0].visible, /\[附图×1\]/u)
  assert.equal(lookups.length, 0)
  assert.equal(visionRequests.length, 0)
  await stop(withoutVision.child)

  config.vision = { baseUrl: `http://127.0.0.1:${port}/vision`, name: 'local-vision', apiKeyEnv: 'TEST_AGENT_VISION_KEY' }
  await fs.writeFile(file, YAML.stringify(config))
  assert.throws(() => readStandaloneAgentConfig(file, { TEST_AGENT_CHAT_KEY: 'chat-fixture' }), /TEST_AGENT_VISION_KEY/u)
  assert.equal(readStandaloneAgentConfig(file, {}, { requireCredentials: false }).vision.model, 'local-vision')
  const active = await launch()

  // A pure image is retained without turning it into user text.
  publish(groups.direct, 90101, [image])
  await waitUntil(() => visionRequests.length === 1, 'pure image reaches vision')
  await settled(groups.direct)
  const directImage = (await session(groups.direct)).recent.find(row => row.messageId === '90101')
  assert.equal(directImage.text, '')
  assert.equal(directImage.imageCount, 1)
  assert.deepEqual(lookups, [90101])

  publish(groups.direct, 90102, [mention, talk('直接看图验收'), image, image, { type: 'image', data: { file: 'local.png' } }])
  await waitUntil(() => deliveries.some(item => item.params.message[0]?.data.id === '90102'), 'direct image produces a visible reply')
  await settled(groups.direct)
  assert.deepEqual(lookups, [90101, 90102, 90102])
  const directResults = modelRequests.filter(item => item.visible.includes('直接看图验收')).flatMap(item => item.body.messages.filter(row => row.role === 'tool'))
  assert.ok(directResults.some(row => row.tool_call_id === 'simGetMessageImages-hidden' && String(row.content).includes('本轮可见')))
  assert.ok(directResults.some(row => row.tool_call_id === 'simGetMessageImages-extra' && String(row.content).includes('正整数序号')))
  assert.ok(directResults.some(row => String(row.content).includes('本轮看图次数上限')))

  // A pre-cutover source has no inbox receipt, so the quote is verified against OneBot.
  originals.set(90103, record(groups.quote, 90103, [image], { time: mediaTime - 60 }))
  publish(groups.quote, 90104, [reply(90103), mention, talk('引用看图验收')])
  await waitUntil(() => deliveries.some(item => item.params.message[0]?.data.id === '90104'), 'same-group quoted image can be answered')
  await settled(groups.quote)
  assert.deepEqual(lookups.slice(-2), [90103, 90103])
  assert.ok(modelRequests.some(item => item.visible.includes('引用看图验收') && item.visible.includes('附1张图')))
  assert.equal((await session(groups.quote)).recent.find(row => row.messageId === '90104').quoteSource.image.count, 1)

  const deliveriesBeforeFailures = deliveries.length
  for (const scenario of [
    { group: groups.unauthorized, id: 90110, status: 401, command: '认证失败看图验收' },
    { group: groups.empty, id: 90111, status: 200, command: '空内容看图验收' },
  ]) {
    const before = visionRequests.length
    nextVisionResponse = scenario.status
    publish(scenario.group, scenario.id, [mention, talk(scenario.command), image])
    await waitUntil(() => visionRequests.length === before + 1, 'diagnostic failure reaches the configured vision provider')
    await waitUntil(() => modelRequests.some(item => item.visible.includes(scenario.command) && String(item.result).startsWith('error:')),
      'failed vision returns a tool error to the current turn')
    await settled(scenario.group)
    assert.equal(visionRequests.length, before + 1, 'HTTP or empty-content failure does not retry vision')
    assert.equal(deliveries.length, deliveriesBeforeFailures, 'unconfirmed vision never sends an answer')
  }

  const visionCount = visionRequests.length
  publish(groups.foreign, 90105, [mention, talk('跨群看图验收'), image], {}, { group_id: groups.quote })
  await waitUntil(() => modelRequests.some(item => item.visible.includes('跨群看图验收') && item.result), 'wrong-group image is refused')
  await settled(groups.foreign)
  publish(groups.foreign, 90106, [mention, talk('来源不符验收'), image], {}, { time: mediaTime - 1 })
  await waitUntil(() => modelRequests.some(item => item.visible.includes('来源不符验收') && item.result), 'different source time is refused')
  await settled(groups.foreign)
  publish(groups.foreign, 90109, [mention, talk('来源禁词验收'), image], {}, { message: [talk(forbidden), image] })
  await waitUntil(() => modelRequests.some(item => item.visible.includes('来源禁词验收') && item.result), 'forbidden source content is refused')
  await settled(groups.foreign)
  assert.ok([90105, 90106, 90109].every(id => lookups.includes(id)))
  assert.equal(visionRequests.length, visionCount)

  publish(groups.recalled, 90107, [mention, talk('撤回看图验收'), image])
  await waitUntil(() => holdLookup, 'image source lookup is in flight')
  recall(groups.recalled, 90107)
  await waitUntil(async () => !(await session(groups.recalled)).recent.some(row => row.messageId === '90107'), 'source is recalled before get_msg responds')
  holdLookup()
  await settled(groups.recalled)
  assert.equal(visionRequests.length, visionCount)

  let releaseVision
  nextVisionGate = new Promise(resolve => { releaseVision = resolve })
  publish(groups.rebound, 90108, [mention, talk('换绑看图验收'), image])
  await waitUntil(() => visionRequests.length === visionCount + 1, 'vision request is in flight')
  binding.bindings.find(row => row.conversationId === String(groups.rebound)).agentId = 'new-role'
  await fs.writeFile(bindingFile, YAML.stringify(binding))
  releaseVision()
  await settled(groups.rebound)
  assert.equal(modelRequests.filter(item => item.visible.includes('换绑看图验收')).length, 1)
  assert.deepEqual(deliveries.map(item => item.params.group_id), [groups.direct, groups.direct, groups.quote])

  const expectedImage = `data:image/png;base64,${fixturePng}`
  assert.ok(visionRequests.every(({ body, auth }) => auth === 'Bearer vision-fixture' &&
    body.model === 'local-vision' && !body.tools && body.messages.length === 1 &&
    body.messages[0].content.at(-1)?.image_url?.url === expectedImage &&
    body.messages[0].content.filter(part => part.type === 'image_url').length === 1 &&
    !JSON.stringify(body).includes('图源发送者')))
  assert.ok(modelRequests.every(({ body }) => !/base64|image_url/u.test(JSON.stringify(body))))
  for (const group of Object.values(groups)) {
    const saved = await session(group)
    assert.ok(!JSON.stringify(saved).includes(fixturePng))
    assert.ok(!JSON.stringify(saved?.agentHistory).includes(text))
  }
  await stop(active.child)
  const ledgerDir = path.join(directory, 'data', 'token_usage')
  const ledger = (await Promise.all((await fs.readdir(ledgerDir)).map(name => fs.readFile(path.join(ledgerDir, name), 'utf8'))))
    .join('').trim().split('\n').map(line => JSON.parse(line))
  const visionUsage = ledger.filter(entry => entry.stage === 'sim-vision')
  assert.equal(visionUsage.length, visionRequests.filter(request => request.status === undefined).length)
  assert.ok(visionUsage.every(entry => entry.model === 'local-vision' && entry.u.total === 15))
  assert.ok(![withoutVision, active].some(app => /vision-fixture|chat-fixture|base64:\/\//u.test(app.readLog())))

  const operations = path.join(directory, 'data', 'operations')
  const journalText = (await Promise.all((await fs.readdir(operations)).filter(name => name.endsWith('.ndjson'))
    .map(name => fs.readFile(path.join(operations, name), 'utf8')))).join('')
  const events = journalText.trim().split('\n').map(line => JSON.parse(line))
  const visionEvents = events.filter(event => ['simulation_image_description', 'vision_provider_http'].includes(event.operation))
  for (const [group, status] of [[groups.unauthorized, 401], [groups.empty, 200]]) {
    const scoped = visionEvents.filter(event => event.scope.kind === 'conversation' && event.scope.binding.target.id === String(group))
    assert.ok(scoped.some(event => event.operation === 'vision_provider_http' && event.outcome === 'started'), 'vision HTTP start is durable')
    assert.ok(scoped.some(event => event.operation === 'vision_provider_http' && event.httpStatus === status &&
      event.code === (status === 401 ? 'http_error' : 'http_ok') && event.outcome === (status === 401 ? 'failed' : 'succeeded')),
      'vision HTTP outcome preserves only its status')
    assert.ok(scoped.some(event => event.operation === 'simulation_image_description' && event.outcome === 'started'), 'image description start is durable')
    assert.ok(scoped.some(event => event.operation === 'simulation_image_description' && event.outcome === 'failed' &&
      event.code === 'image_model_response_error' && event.httpStatus === status), 'HTTP and empty-content failures retain their safe distinction')
  }
  assert.ok(visionEvents.some(event => event.operation === 'simulation_image_description' && event.outcome === 'succeeded' &&
    event.code === 'image_description_completed'), 'normal vision 200 records its confirmed description')
  assert.ok(visionEvents.some(event => event.operation === 'vision_provider_http' && event.outcome === 'succeeded' &&
    event.code === 'http_ok' && event.httpStatus === 200), 'normal vision 200 records its HTTP result')
  for (const event of visionEvents.filter(event => event.outcome !== 'started')) {
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0, 'terminal vision diagnostics retain safe duration')
    assert.ok(Object.keys(event).every(key => ['version', 'id', 'traceId', 'at', 'scope', 'stage', 'operation', 'outcome', 'code',
      'durationMs', 'errorKind', 'httpStatus', 'configurationRevision'].includes(key)), 'vision diagnostics expose metadata only')
  }
  for (const secret of [privateVisionBody, fixturePng, text, forbidden, 'vision-fixture', 'chat-fixture', 'https://private.invalid',
    `http://127.0.0.1:${port}`, '/vision/v1/chat/completions', 'base64://', 'data:image/', 'image_url', '图源发送者']) {
    assert.equal((journalText + withoutVision.readLog() + active.readLog()).includes(secret), false, 'journal and host logs omit provider payload, images, credentials and addresses')
  }
})
