import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { agentHostModuleUrl, importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentBindingDirectory, createAgentRuntime, createAgentDiagnostics }, { personMemoryCommandText: commands },
  { personMemoryAddress }, { createPersonMemoryStore }, { agentBindingToken, agentPersonaScopeId },
  { createAgentInbox }, { openAgentRedis }, { isPersonMemoryRedacted }] = await Promise.all([
  load('core/index.js'), load('modules/memory/domain/personMemoryCommands.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/runtime/domain/agentBindings.js'), load('modules/runtime/infrastructure/agentInbox.js'),
  load('modules/runtime/infrastructure/agentRedis.js'), load('modules/memory/domain/personMemory.js'),
])

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const logger = { info() {}, warn() {}, error() {} }
const qq = id => ({ platform: 'qq', namespace: 'global', id })
const account = qq('19000001')
const secondAccount = qq('19000002')
const author = qq('170001')
const otherAuthor = qq('170002')
const simulationGroup = { account, kind: 'group', id: '310001' }
const textGroup = { account, kind: 'group', id: '310002' }
const friend = { account, kind: 'private', id: author.id }
const otherRoleGroup = { account, kind: 'group', id: '310003' }
const otherBotGroup = { ...simulationGroup, account: secondAccount }
const unbound = { ...simulationGroup, id: '310004' }
const bindings = {
  version: 1,
  agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
  connections: [account, secondAccount].map((bot, index) => ({ id: `qq-${index}`, platform: 'qq', namespace: 'global', accountId: bot.id })),
  bindings: [simulationGroup, textGroup, friend, otherRoleGroup, otherBotGroup].map(target => ({
    connectionId: target.account === account ? 'qq-0' : 'qq-1', kind: target.kind, conversationId: target.id,
    agentId: target === otherRoleGroup ? 'other' : 'daily',
  })),
}

async function waitFor(probe, description, timeoutMs = 5_000) {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function message(conversation, messageId, text, overrides = {}) {
  return { kind: 'message', message: {
    version: 1, conversation, messageId, sender: author, occurredAt: Date.now(), text,
    parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...overrides,
  } }
}

function memoryAt(target, actor = author, agentId = target === otherRoleGroup ? 'other' : 'daily') {
  const { botId, scene } = personMemoryAddress(target, actor.id)
  return { identity: { botId, personaId: agentPersonaScopeId(agentId) }, subjectId: actor.id, scene, viewerUserId: actor.id }
}

async function seed(store, target, text, actor = author, at = Date.now() - 10_000) {
  const input = memoryAt(target, actor)
  const result = await store.remember({ ...input, text, category: 'fact', evidenceKind: 'self',
    source: { scene: input.scene, authorId: input.subjectId, messageId: `source-${text}`, excerpt: text, at },
  })
  assert.equal(result.saved, true)
}

async function texts(store, target, actor = author) {
  return (await store.query({ ...memoryAt(target, actor), localOnly: true })).items.map(item => item.text)
}

function createHost({ storage, isCurrent, direct = true, resolveDirectory, send, model, peer = () => author, warn, diagnostics }) {
  const accept = []
  const adapters = [account, secondAccount].map((bot, index) => ({
    id: `qq-${index}`, account: bot, botUserId: bot.id, botName: '验收角色', resolvePrivatePeer: peer,
    async start(handler) { accept[index] = handler },
    isReady() { return !!accept[index] },
    stop() { accept[index] = undefined },
    actions: { send },
  }))
  const runtime = createAgentRuntime({
    storage, adapters, logger: { ...logger, ...(warn ? { warn } : {}) }, isExecutionCurrent: isCurrent,
    ...(diagnostics ? { diagnostics } : {}),
    privateChatEnabled: direct, useTextGroup: target => target.id === textGroup.id,
    getSection: () => ({ rhythm: { enabled: false }, reflection: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
    getExecutionConfig: () => ({}),
    resolvePersona(target) {
      const binding = resolveDirectory().resolve(target)
      return binding && { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '验收角色' }, systemContent: '' }
    },
    async YTapi(request) { return model(request) },
  })
  const emit = (event, index = 0) => accept[index](event)
  return { runtime, emit }
}

test('standalone privacy commands isolate scenes, actors, roles and accounts and revoke in-flight replies', redisTest, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-memory-privacy')
  const inbox = createAgentInbox(storage)
  const store = createPersonMemoryStore({ redis: storage })
  const directory = createAgentBindingDirectory(bindings, 'privacy-binding')
  const deliveries = []
  const models = []
  const pendingTransports = []
  const releaseTransport = Promise.withResolvers()
  const reply = '已经等待发送的旧资料'
  const host = createHost({ storage, isCurrent, resolveDirectory: () => directory,
    async send(action, guard) {
      const text = action.parts.find(part => part.kind === 'text').text
      if (text === reply) {
        pendingTransports.push(action)
        await releaseTransport.promise
      }
      if (!guard.isCurrent()) return { state: 'failed', code: 'binding_changed' }
      deliveries.push(action)
      return { state: 'sent', messageId: String(91000 + deliveries.length) }
    },
    model(request) {
      models.push(request)
      const isSimulation = request.messages.some(row => typeof row.content === 'string' && row.content.includes('【执行主体】'))
      const response = isSimulation ? { content: '', tool_calls: [{ id: 'privacy-sim', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'chat', reason: '验证发送守卫', messages: [reply] }),
      } }] } : { content: reply }
      return { choices: [{ message: response }] }
    },
  })
  const direct = message(friend, '510001', commands.disable)
  const enable = message(friend, '510002', commands.enable)
  const sendGroup = message(textGroup, '510003', commands.forget)
  const wrong = { kind: 'image' }
  try {
    for (const [target, text, actor] of [
      [simulationGroup, '仿真群本地资料'], [textGroup, '文字群本地资料'], [friend, '私聊本地资料'],
      [otherRoleGroup, '同账号其他角色资料'], [otherBotGroup, '另一接收账号资料'], [textGroup, '另一位发言人资料', otherAuthor],
    ]) await seed(store, target, text, actor)
    await host.runtime.start()
    const rejected = [
      message(friend, '520001', commands.forget, { sender: otherAuthor }),
      message(simulationGroup, '520002', commands.forget, { sender: account }),
      message(simulationGroup, '520003', commands.forget, { sender: { ...author, namespace: 'another' } }),
      message(simulationGroup, '520004', commands.forget, { parts: [{ kind: 'text', text: commands.forget }, wrong] }),
      message(simulationGroup, '520005', commands.forget, { quote: { parts: [] } }),
      message(simulationGroup, '520006', commands.forget, { quote: { messageId: '530000', parts: [] } }),
      message(simulationGroup, '520007', commands.disable, { parts: [{ kind: 'text', text: commands.enable }] }),
      message(simulationGroup, '520008', commands.forget, { binding: { ...directory.resolve(simulationGroup), revision: 'expired' } }),
      message(unbound, '520009', commands.forget),
      message(simulationGroup, '520010', commands.forget, { occurredAt: Date.now() - 3_600_001 }),
      message(simulationGroup, '520011', commands.forget, { occurredAt: Date.now() + 180_000 }),
      message(simulationGroup, '520012', commands.forget, { mentions: [account], directedToAccount: true }),
    ]
    for (const event of rejected) await host.emit(event)
    for (const event of rejected) assert.equal(await inbox.canReply(event.message.conversation, event.message.messageId), false)
    assert.deepEqual(await texts(store, simulationGroup), ['仿真群本地资料'])
    assert.deepEqual(models, [])
    assert.deepEqual(deliveries, [])

    await host.emit(sendGroup)
    await waitFor(() => deliveries.length === 1, 'group text-mode command confirmation')
    assert.equal(deliveries[0].replyTo, sendGroup.message.messageId)
    assert.deepEqual(deliveries[0].target, textGroup)
    assert.deepEqual(await texts(store, textGroup), [])
    assert.deepEqual(await texts(store, textGroup, otherAuthor), ['另一位发言人资料'])
    assert.deepEqual(await texts(store, simulationGroup), ['仿真群本地资料'])
    assert.deepEqual(await texts(store, friend), ['私聊本地资料'])

    await host.emit(message(simulationGroup, '510004', '等待仿真回复', { directedToAccount: true, mentions: [account] }))
    await host.emit(message(textGroup, '510005', '等待文字回复', { directedToAccount: true, mentions: [account] }))
    await waitFor(() => pendingTransports.length === 2, 'both normal sends at the transport guard')
    await host.emit(direct)
    await waitFor(() => deliveries.length === 2, 'private disable is independent of both in-flight group sends')
    assert.deepEqual(deliveries[1].target, friend)
    assert.equal(deliveries[1].replyTo, undefined)
    assert.equal((await store.getRedactions(memoryAt(simulationGroup))).disabled, true)
    assert.deepEqual(await texts(store, simulationGroup), [])
    assert.deepEqual(await texts(store, friend), [])
    assert.deepEqual(await texts(store, otherRoleGroup), ['同账号其他角色资料'])
    assert.deepEqual(await texts(store, otherBotGroup), ['另一接收账号资料'])
    releaseTransport.resolve()

    await host.emit(enable)
    await waitFor(() => deliveries.length === 3, 'opposite toggle confirmed')
    await host.emit(direct)
    const postToggle = await store.getRedactions(memoryAt(friend))
    assert.equal(postToggle.disabled, false)
    assert.deepEqual(await texts(store, friend), [])
    await seed(store, friend, '重新启用后的新资料', author, postToggle.forgottenBefore + 1)
    assert.deepEqual(await texts(store, friend), ['重新启用后的新资料'])
    const secondCommand = message(otherBotGroup, direct.message.messageId, commands.forget)
    await host.emit(secondCommand, 1)
    await waitFor(() => deliveries.length === 4, 'same message ID is independent on another account')
    assert.equal(deliveries[3].replyTo, secondCommand.message.messageId)
    assert.deepEqual(deliveries[3].target, otherBotGroup)
    assert.deepEqual(await texts(store, otherBotGroup), [])
    assert.deepEqual(await texts(store, otherRoleGroup), ['同账号其他角色资料'])
    assert.deepEqual(await texts(store, friend), ['重新启用后的新资料'])
    assert.ok(models.length >= 2)
    assert.equal(Object.values(commands).some(command => JSON.stringify(models).includes(command)), false)
    assert.ok(deliveries.every(action => action.parts.every(part => part.text !== reply)))
  } finally {
    releaseTransport.resolve()
    await host.runtime.stop()
  }
})

test('privacy effects and receipt are atomic if a process loses the Redis commit acknowledgement', redisTest, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-memory-privacy-restart')
  const directory = createAgentBindingDirectory(bindings, 'privacy-binding')
  const store = createPersonMemoryStore({ redis: storage })
  const inbox = createAgentInbox(storage)
  const queue = { account, kind: 'privacy' }
  const disable = message(friend, '610001', commands.disable)
  const enable = message(friend, '610002', commands.enable)
  const releaseCommit = Promise.withResolvers()
  const commitLost = Promise.withResolvers()
  const deliveries = []
  let confirmation
  let mode = 'lose-result'
  const diagnosticEvents = []
  const diagnostics = createAgentDiagnostics({ logger, sink: { async append(event) { diagnosticEvents.push(event); return true } } })
  const wrappedStorage = { ...storage, async eval(script, options) {
    const commandCommit = options.arguments[1]?.startsWith('privacy:pending:') && options.arguments.includes('keepttl')
    if (!commandCommit || mode === 'regular') return storage.eval(script, options)
    if (mode === 'lose-result') {
      await storage.eval(script, options)
      commitLost.resolve()
      await releaseCommit.promise
      throw new Error('lost the first commit reply')
    }
    const pending = mode
    pending.reached = true
    await pending.release.promise
    return storage.eval(script, options)
  } }
  const create = options => createHost({ storage: wrappedStorage, isCurrent, resolveDirectory: () => directory,
    async send(action, guard) {
      if (confirmation) {
        confirmation.started = true
        await confirmation.release.promise
      }
      if (!guard.isCurrent()) return { state: 'failed', code: 'binding_changed' }
      deliveries.push(action)
      return { state: 'sent', messageId: String(92000 + deliveries.length) }
    }, model: () => assert.fail('privacy commands must not use the model'), diagnostics, ...options,
  })
  await seed(store, friend, '重启之前的受保护资料')
  const first = create()
  let resumed
  let recalledCommit
  try {
    await first.runtime.start()
    await first.emit(disable)
    await waitFor(async () => {
      const item = await inbox.next(queue)
      return item && await inbox.privacyCommandState(friend, disable.message.messageId, item.raw) === 'applied'
    }, 'atomic privacy write before acknowledgement')
    await commitLost.promise
    const { raw } = await inbox.next(queue)
    assert.equal(await inbox.privacyCommandState(friend, disable.message.messageId, raw), 'applied')
    assert.equal((await store.getRedactions(memoryAt(friend))).disabled, true)
    assert.equal(deliveries.length, 0)
    const stopped = first.runtime.stop()
    releaseCommit.resolve()
    await stopped

    mode = 'regular'
    resumed = create()
    const revision = (await store.getRedactions(memoryAt(friend))).revision
    await resumed.runtime.start()
    assert.equal(await inbox.next(queue), null)
    assert.equal((await store.getRedactions(memoryAt(friend))).revision, revision)
    assert.equal(deliveries.length, 1)

    await resumed.emit(enable)
    await resumed.emit(disable)
    await waitFor(() => deliveries.length === 2, 'opposite toggle after restart')
    assert.equal((await store.getRedactions(memoryAt(friend))).disabled, false)

    recalledCommit = { reached: false, release: Promise.withResolvers() }
    mode = recalledCommit
    const recalled = message(friend, '610003', commands.disable)
    await resumed.emit(recalled)
    await waitFor(() => recalledCommit.reached, 'privacy write waiting for recall')
    const recall = resumed.emit({ kind: 'recall', target: friend, messageId: recalled.message.messageId })
    await waitFor(() => inbox.isRecalled(friend, recalled.message.messageId), 'private recall marker during the pending write')
    recalledCommit.release.resolve()
    await recall
    await waitFor(async () => !await inbox.next(queue), 'recall rejects the atomic write and preserves later processing')
    assert.equal(await inbox.isRecalled(friend, recalled.message.messageId), true)
    assert.equal((await store.getRedactions(memoryAt(friend))).disabled, false)
    assert.equal(deliveries.length, 2)

    mode = 'regular'
    confirmation = { started: false, release: Promise.withResolvers() }
    const acknowledged = message(friend, '610004', commands.disable)
    await resumed.emit(acknowledged)
    await waitFor(() => confirmation.started, 'private confirmation queued at the transport')
    await resumed.emit({ kind: 'recall', target: friend, messageId: acknowledged.message.messageId })
    confirmation.release.resolve()
    await waitFor(async () => !await inbox.next(queue), 'recalled confirmation consumed without delivery')
    assert.equal((await store.getRedactions(memoryAt(friend))).disabled, true)
    await resumed.emit(acknowledged)
    assert.equal(deliveries.length, 2)
    await diagnostics.flush()
    const firstFailures = diagnosticEvents.filter(event => event.operation === 'consume_privacy' && event.outcome === 'failed')
    assert.deepEqual(firstFailures.map(event => [event.code, event.details.step]), [['inbox_retry_privacy_command', 'privacy_command']])
  } finally {
    releaseCommit.resolve()
    recalledCommit?.release.resolve()
    confirmation?.release.resolve()
    await first.runtime.stop()
    await resumed?.runtime.stop()
  }
})

test('a pending privacy command cannot cross a role rebind or a disabled friend boundary', redisTest, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-memory-privacy-rebind')
  const before = createAgentBindingDirectory(bindings, 'before-rebind')
  const afterConfig = { ...bindings, bindings: bindings.bindings.map(item => item.conversationId === simulationGroup.id && item.connectionId === 'qq-0'
    ? { ...item, agentId: 'other' } : item) }
  const after = createAgentBindingDirectory(afterConfig, 'after-rebind')
  const store = createPersonMemoryStore({ redis: storage })
  const inbox = createAgentInbox(storage)
  const groupCommand = message(simulationGroup, '620001', commands.forget)
  const privateCommand = message(friend, '620002', commands.disable)
  await seed(store, simulationGroup, '换绑前仍受保护的资料')
  await inbox.accept({ event: groupCommand, bindingToken: agentBindingToken(before.resolve(simulationGroup)), privacyCommand: 'forget' })
  // The current binding is valid for this friend, but the host still must opt in to private chat.
  await inbox.accept({ event: privateCommand, bindingToken: agentBindingToken(after.resolve(friend)), privacyCommand: 'disable' })
  const touched = []
  const host = createHost({ storage, isCurrent, direct: false, resolveDirectory: () => after,
    send: action => { touched.push(action); return { state: 'failed' } }, model: request => { touched.push(request); return { choices: [] } },
  })
  try {
    await host.runtime.start()
    assert.equal(await inbox.next({ account, kind: 'privacy' }), null)
    assert.deepEqual(await texts(store, simulationGroup), ['换绑前仍受保护的资料'])
    assert.equal((await store.getRedactions(memoryAt(simulationGroup, author, 'other'))).forgottenBefore, 0)
    assert.equal((await store.getRedactions(memoryAt(friend))).disabled, false)
    const late = message(friend, '620003', commands.disable)
    await host.emit(late)
    assert.equal(await inbox.canReply(friend, late.message.messageId), false)
    assert.deepEqual(touched, [])
  } finally { await host.runtime.stop() }
})

test('a pending intake fences new same-account models while another account stays available', redisTest, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-memory-privacy-intake')
  const directory = createAgentBindingDirectory(bindings, 'privacy-binding')
  const store = createPersonMemoryStore({ redis: storage })
  const waitForEnqueue = Promise.withResolvers()
  let sensitiveEnqueue = false
  const received = []
  const wrappedStorage = { ...storage, async eval(script, options) {
    if (options.arguments[4]?.startsWith('privacy:pending:')) {
      sensitiveEnqueue = true
      await waitForEnqueue.promise
    }
    return storage.eval(script, options)
  } }
  const host = createHost({ storage: wrappedStorage, isCurrent, resolveDirectory: () => directory,
    send: async () => ({ state: 'sent', messageId: '960001' }),
    model(request) {
      received.push(JSON.stringify(request.messages))
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'privacy-test-finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '验收结束' }),
      } }] } }] }
    },
  })
  const secret = '清空前的专属人物资料'
  const afterCommandText = '我新的文字回合，请记得我以前的资料吗'
  const otherAccountText = '其他接收账号仍可处理'
  let admission
  try {
    await seed(store, textGroup, secret)
    await host.runtime.start()
    admission = host.emit(message(friend, '630001', commands.forget))
    await waitFor(() => sensitiveEnqueue, 'privacy admission before reaching Redis')
    await host.emit(message(textGroup, '630002', afterCommandText, { directedToAccount: true }))
    await host.emit(message(otherBotGroup, '630003', otherAccountText, { directedToAccount: true }), 1)
    await waitFor(() => received.some(input => input.includes(otherAccountText)), 'model from the other account')
    assert.ok(received.every(input => !input.includes(afterCommandText)))
    assert.deepEqual(await texts(store, textGroup), [secret])
    waitForEnqueue.resolve()
    await admission
    const subsequentModel = await waitFor(() => received.find(input => input.includes(afterCommandText)), 'fresh model after privacy commit')
    assert.equal(subsequentModel.includes(secret), false)
    assert.deepEqual(await texts(store, textGroup), [])
  } finally {
    waitForEnqueue.resolve()
    await admission?.catch(() => {})
    await host.runtime.stop()
  }
})

test('a standalone QQ process keeps commands out of model requests and aborts a revoked provider retry', redisTest, async t => {
  const { url, reader } = await createAgentRedisFixture(t, 'privacy-process-fixture')
  const directory = await mkdtemp(join(tmpdir(), 'agent-memory-commands-'))
  const socketServer = new WebSocketServer({ noServer: true })
  const deliveries = []
  const modelRequests = [], apiCalls = [], sources = new Map()
  let responseToAbort, providerAborted = false, beforeProviderRedactions
  let websocket, child, childExit, ownerStorage, log = ''
  const server = createServer(async (request, response) => {
    let payload = ''
    for await (const chunk of request) payload += chunk
    modelRequests.push(payload)
    if (!payload.includes('本轮请求处于等待状态') || modelRequests.length > 1) {
      response.writeHead(500).end()
      return
    }
    responseToAbort = response
    response.on('close', () => { providerAborted = !response.writableEnded })
    response.writeHead(400).write('unsupported reasoning_effort')
  })
  server.on('upgrade', (request, connection, head) => socketServer.handleUpgrade(request, connection, head,
    client => socketServer.emit('connection', client)))
  socketServer.on('connection', client => {
    websocket = client
    client.on('message', message => {
      const { action, params, echo } = JSON.parse(String(message))
      apiCalls.push({ action, params })
      if (action !== 'get_login_info') deliveries.push({ action, params })
      client.send(JSON.stringify({ status: 'ok', retcode: 0, echo, data: action === 'get_login_info'
        ? { user_id: Number(account.id), nickname: '人物记忆验收' } : { message_id: 93000 + deliveries.length } }))
    })
  })
  t.after(async () => {
    if (t.error) t.diagnostic(JSON.stringify({ log, apiCalls, sources: [...sources.values()], modelRequests, deliveries, beforeProviderRedactions, childExitCode: child?.exitCode }))
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await childExit
    await ownerStorage?.close()
    for (const client of socketServer.clients) client.terminate()
    await new Promise(resolve => socketServer.close(resolve))
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const instance = 'privacy-process'
  const port = server.address().port
  const onlyMainBot = { ...bindings, connections: bindings.connections.slice(0, 1),
    bindings: bindings.bindings.filter(binding => binding.connectionId === 'qq-0') }
  const configFile = join(directory, 'agent-host.yaml')
  await writeFile(join(directory, 'agent-bindings.yaml'), JSON.stringify(onlyMainBot))
  await writeFile(configFile, JSON.stringify({ version: 1, instance, privateChat: { enabled: true },
    model: { baseUrl: `http://127.0.0.1:${port}/v1`, name: 'unused-model', apiKeyEnv: 'FIXTURE_PRIVACY_MODEL_KEY', reasoningEffort: 'low' },
    connections: [{ id: 'qq-0', url: `ws://127.0.0.1:${port}` }],
    textGroups: [{ connectionId: 'qq-0', conversationId: textGroup.id }],
    simulation: { wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
      wakeGate: { enabled: false }, rhythm: { enabled: false }, reflection: { enabled: false } },
  }))
  ownerStorage = await openAgentRedis({ url, instance, onLost() {} })
  const stored = createPersonMemoryStore({ redis: ownerStorage.storage })
  await seed(stored, simulationGroup, '进程验收仿真群资料')
  await seed(stored, textGroup, '进程验收文字群资料')
  await seed(stored, friend, '进程验收私聊资料')
  await ownerStorage.close()
  ownerStorage = undefined
  const compiled = fileURLToPath(agentHostModuleUrl('bootstrap/standaloneAgent.js'))
  const release = process.env.BL_CHAT_AGENT_RELEASE_DIR
  const args = release ? [join(release, 'scripts/start-agent.mjs'), '--config', configFile] : [
    ...(process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
      ? ['--import', fileURLToPath(new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url))] : []),
    '--input-type=module', '-e', `import { main } from ${JSON.stringify(compiled)}; await main(['--config', process.argv[1]])`, configFile,
  ]
  child = spawn(process.execPath, args, { env: { ...process.env, BL_AGENT_REDIS_URL: url, FIXTURE_PRIVACY_MODEL_KEY: 'fake' } })
  childExit = once(child, 'exit')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  await waitFor(() => log.includes('已启动') || child.exitCode !== null, 'standalone QQ startup', 12_000)
  assert.match(log, /已启动/u)

  function send(target, id, text, overrides = {}) {
    const frame = {
      post_type: 'message', message_type: target.kind, sub_type: target.kind === 'private' ? 'friend' : 'normal',
      self_id: Number(account.id), user_id: Number(author.id), message_id: id,
      ...(target.kind === 'group' ? { group_id: Number(target.id) } : {}), time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text } }], ...overrides,
    }
    sources.set(String(id), frame)
    websocket.send(JSON.stringify(frame))
  }
  const bad = [{ type: 'reply', data: {} }, { type: 'text', data: { text: commands.disable } }]
  send(simulationGroup, 710001, commands.disable, { message: bad })
  send(simulationGroup, 710002, commands.disable, { message: `[CQ:reply]${commands.disable}` })
  send(simulationGroup, 710003, commands.disable, { message: `[CQ:reply,id=0]${commands.disable}` })
  send(simulationGroup, 710004, commands.disable, { time: undefined })
  send(simulationGroup, 710005, commands.disable, { time: Math.floor(Date.now() / 1000) - 7 * 86_400 - 1 })
  send(friend, 710006, commands.disable, { sub_type: 'group' })
  send(simulationGroup, 710007, commands.forget)
  send(textGroup, 710008, commands.forget)
  send(friend, 710009, commands.disable)
  send(friend, 710010, commands.enable, { message: commands.enable })
  send(friend, 710009, commands.disable)
  await waitFor(() => deliveries.length >= 4 || child.exitCode !== null, 'one response per accepted new command')
  assert.equal(modelRequests.length, 0)

  const redactionInspector = createPersonMemoryStore({ redis: { get: key => reader.get('bl-agent:privacy-process:' + key) } })
  beforeProviderRedactions = await redactionInspector.getRedactions(memoryAt(textGroup))
  const cutoff = Math.max(beforeProviderRedactions.forgottenBefore,
    ...beforeProviderRedactions.scenes.filter(rule => rule.scene.kind === 'group' && rule.scene.id === textGroup.id).map(rule => rule.forgottenBefore))
  const erasedSource = sources.get('710008'), scene = personMemoryAddress(textGroup).scene
  assert.ok(erasedSource.time * 1000 <= cutoff)
  assert.equal(isPersonMemoryRedacted({ scene, messageId: String(erasedSource.message_id), authorId: author.id,
    at: erasedSource.time * 1000, excerpt: commands.forget }, commands.forget, beforeProviderRedactions), true)
  // OneBot timestamps have second precision. A new post-command request must
  // actually be newer than the durable millisecond privacy cutoff.
  await waitFor(() => Math.floor(Date.now() / 1000) * 1000 > cutoff, 'a genuine source timestamp after the privacy cutoff')

  send(textGroup, 710011, '本轮请求处于等待状态', { message: [
    { type: 'at', data: { qq: account.id } }, { type: 'text', data: { text: '本轮请求处于等待状态' } },
  ] })
  const providerSource = sources.get('710011')
  assert.ok(providerSource.time * 1000 > cutoff)
  assert.equal(isPersonMemoryRedacted({ scene, messageId: String(providerSource.message_id), authorId: author.id,
    at: providerSource.time * 1000, excerpt: '本轮请求处于等待状态' }, '本轮请求处于等待状态', beforeProviderRedactions), false)
  await waitFor(() => responseToAbort, 'first provider call with an unfinished retryable body')
  assert.equal(JSON.parse(modelRequests[0]).reasoning_effort, 'low')
  send(friend, 710012, commands.forget)
  await waitFor(() => deliveries.length === 5 && providerAborted, 'private command confirmed while closing the old provider connection')
  await delay(100)
  assert.equal(modelRequests.length, 1)
  assert.ok(Object.values(commands).every(command => !modelRequests[0].includes(command)))
  child.kill('SIGTERM')
  assert.deepEqual(await childExit, [0, null])
  assert.deepEqual(deliveries.map(({ action, params }) => [action, params.group_id ?? params.user_id]), [
    ['send_group_msg', Number(simulationGroup.id)], ['send_group_msg', Number(textGroup.id)],
    ['send_private_msg', Number(author.id)], ['send_private_msg', Number(author.id)], ['send_private_msg', Number(author.id)],
  ])
  for (const [index, id] of [[0, '710007'], [1, '710008']]) {
    assert.deepEqual(deliveries[index].params.message[0], { type: 'reply', data: { id } })
  }
  assert.equal(deliveries[2].params.message.some(part => part.type === 'reply'), false)
  ownerStorage = await openAgentRedis({ url, instance, onLost() {} })
  const after = createPersonMemoryStore({ redis: ownerStorage.storage })
  assert.deepEqual(await texts(after, simulationGroup), [])
  assert.deepEqual(await texts(after, textGroup), [])
  assert.deepEqual(await texts(after, friend), [])
  const state = await after.getRedactions(memoryAt(simulationGroup))
  assert.equal(state.disabled, false)
  assert.equal(state.scenes.length, 2)
  assert.ok(state.scenes.every(rule => !rule.disabled))
})
