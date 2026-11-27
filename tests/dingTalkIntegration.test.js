import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createDingTalkConnection, normalizeDingTalkMessage } from '../dist/backend/adapters/dingTalkConnection.js'
import { openDingTalkMcpBridge } from '../dist/backend/bootstrap/dingTalkMcpBridge.js'
import { openStandaloneDingTalkReplyPolicies } from '../dist/backend/bootstrap/standaloneDingTalkReplyPolicies.js'
import { readStandaloneMemorySpaces } from '../dist/backend/bootstrap/standaloneMemorySpaces.js'
import { describeStandaloneAgentTopology, prepareStandaloneAgentTopologyChange } from '../dist/backend/bootstrap/standaloneAgentConsoleTopology.js'
import { createStandaloneAgentCandidateValidator } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { readDingTalkReplyPolicy } from '../dist/backend/bootstrap/standaloneDingTalkConfig.js'
import { createAgentSharedSpaces } from '../dist/backend/modules/memory/infrastructure/agentSharedSpaces.js'
import { resolveAgentTextTriggerConfig } from '../dist/backend/modules/conversation/infrastructure/agentTextTriggerConfig.js'
import { agentBindingToken } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'dingtalk', namespace: 'ding-corp-a', id: 'test-app' }
const connection = { id: 'work', account, memorySpaceId: 'engineering' }
const group = { account, kind: 'group', id: 'cid-test' }
const privateTarget = { account, kind: 'private', id: 'employee-1' }
const topic = '/v1.0/im/bot/messages/get'
const callback = {
  chatbotCorpId: account.namespace, senderCorpId: account.namespace, robotCode: account.id, msgtype: 'text',
  senderStaffId: 'employee-1', msgId: 'callback-1', conversationType: '2', conversationId: group.id,
  text: { content: '请查研发自测开关' }, isInAtList: true, createAt: Date.now(),
}

async function openLoopbackStream(t, options) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const network = []
  const dingtalk = createDingTalkConnection({ connection, name: '测试助手', clientId: 'test-app', clientSecret: 'test-only',
    ...options,
    openSocket: () => new WebSocket('ws://127.0.0.1:' + server.address().port),
    async fetch(url, options) {
      network.push({ url, body: JSON.parse(options.body) })
      if (url.endsWith('/connections/open')) return Response.json({ endpoint: 'wss://wss-open-connection.dingtalk.com/connect', ticket: 'test-ticket' })
      if (url.endsWith('/accessToken')) return Response.json({ accessToken: 'fake-token', expireIn: 7200 })
      return Response.json({ processQueryKey: 'batch-receipt-' + network.length })
    },
  })
  t.after(() => { dingtalk.stop(); for (const client of server.clients) client.terminate(); return new Promise(resolve => server.close(resolve)) })
  return { dingtalk, network, connected: once(server, 'connection').then(([client]) => client) }
}

async function sendCallback(client, data) {
  const messageId = 'stream-' + data.msgId
  const response = once(client, 'message')
  client.send(JSON.stringify({ type: 'CALLBACK', headers: { messageId, topic }, data: JSON.stringify(data) }))
  const [raw] = await response
  const ack = JSON.parse(raw.toString())
  assert.equal(ack.headers.messageId, messageId)
  assert.equal(ack.code, 200, `ACK for ${data.msgId}`)
}

const reply = target => ({ version: 1, kind: 'message.send', target, replyTo: 'callback-1',
  parts: [{ kind: 'text', text: '请以当前源码为准。' }] })

async function waitFor(probe, description) {
  const until = Date.now() + 4000
  while (Date.now() < until) {
    if (await probe()) return
    await delay(20)
  }
  assert.fail('Timed out waiting for ' + description)
}

test('DingTalk Stream confirms filtered callbacks and waits for Core admission of a real mention', { timeout: 8000 }, async t => {
  assert.equal(normalizeDingTalkMessage(connection, { ...callback, senderCorpId: 'other' }), undefined)
  assert.equal(normalizeDingTalkMessage(connection, { ...callback, robotCode: 'other-robot' }), undefined)
  const events = []
  let approved = true
  const arrived = Promise.withResolvers(), admission = Promise.withResolvers()
  const { dingtalk, network, connected } = await openLoopbackStream(t, { canUse: target => approved && target.id === group.id })
  await dingtalk.start(async event => {
    events.push(event)
    arrived.resolve()
    await admission.promise
  })
  const client = await connected
  for (const [index, isInAtList] of [false, undefined, 'true'].entries()) {
    const ordinary = { ...callback, msgId: 'ordinary-' + index, isInAtList, text: { content: '@测试助手' } }
    const normalized = normalizeDingTalkMessage(connection, ordinary)
    assert.equal(normalized.directedToAccount, false)
    assert.deepEqual(normalized.mentions, [])
    await sendCallback(client, ordinary)
    assert.equal(events.length, 0)
  }
  let acknowledged = false
  const ack = sendCallback(client, callback).then(() => { acknowledged = true })
  await arrived.promise
  assert.equal(events.length, 1)
  assert.equal(acknowledged, false)
  assert.equal(events[0].message.sender.id, 'employee-1')
  assert.deepEqual(events[0].message.conversation, group)
  assert.equal(events[0].message.directedToAccount, true)
  assert.deepEqual(events[0].message.mentions, [account])
  admission.resolve()
  await ack

  assert.equal((await dingtalk.actions.send(reply(group))).state, 'sent')
  assert.deepEqual(network.at(-1).body, { robotCode: account.id, msgKey: 'sampleText',
    msgParam: '{"content":"请以当前源码为准。"}', openConversationId: group.id })
  approved = false
  assert.equal((await dingtalk.actions.send(reply(group))).state, 'failed')
  assert.equal(network.length, 3)
})

test('DingTalk reply mode and independent user and group lists gate Stream admission and delivery', { timeout: 8000 }, async t => {
  for (const mode of ['both', 'private', 'group']) await t.test(mode, async t => {
    const replyPolicy = readDingTalkReplyPolicy({ mode, requireMention: false, allowUserIds: ['employee-1', 'employee-2'],
      denyUserIds: ['employee-2'], allowGroupIds: [group.id, 'denied-group', 'unbound-group'], denyGroupIds: ['denied-group'] })
    const { dingtalk, network, connected } = await openLoopbackStream(t, { replyPolicy, canUse: target => target.id !== 'unbound-group' })
    const messages = []
    await dingtalk.start(async event => { messages.push(event.message) })
    const client = await connected
    const cases = [
      [{}, mode !== 'private'],
      [{ conversationType: '1' }, mode !== 'group'],
      [{ senderStaffId: 'employee-2', isInAtList: true }, false],
      [{ senderStaffId: 'employee-3' }, false],
      [{ conversationType: '1', senderStaffId: 'employee-2' }, false],
      [{ conversationId: 'denied-group', isInAtList: true }, false],
      [{ conversationId: 'other-group' }, false],
      [{ conversationId: 'unbound-group' }, false],
    ]
    const admitted = []
    for (const [index, [data, allowed]] of cases.entries()) {
      const msgId = 'policy-' + index
      await sendCallback(client, { ...callback, isInAtList: false, ...data, msgId })
      if (allowed) admitted.push(msgId)
      assert.deepEqual(messages.map(row => row.messageId), admitted)
    }
    assert.deepEqual(messages.map(row => row.directedToAccount), messages.map(row => row.conversation.kind === 'private'))
    for (const [target, allowed] of [[group, mode !== 'private'], [privateTarget, mode !== 'group'],
      [{ ...group, id: 'denied-group' }, false], [{ ...privateTarget, id: 'employee-2' }, false]]) {
      const before = network.length
      assert.equal((await dingtalk.actions.send(reply(target))).state, allowed ? 'sent' : 'failed')
      if (!allowed) assert.equal(network.length, before)
    }
    if (mode !== 'group') assert.deepEqual(network.at(-1).body.userIds, [privateTarget.id])
  })
})

test('published MCP invokes only the configured DWS identity, tool and data scope', async t => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const cli = { command: 'dws', profile: 'employee-1', corpId: account.namespace, userId: 'employee-1',
    mcpId: '42', tool: 'read_doc', fixed: { documentId: 'public-for-this-group' }, resultFields: ['title', 'body'] }
  let authorized = true, observed = 0
  const server = await openDingTalkMcpBridge(cli, serverTransport, async (config, args) => {
    if (args[0] === 'auth') return { authenticated: true, corp_id: account.namespace, user_id: authorized ? 'employee-1' : 'someone-else' }
    assert.equal(config.profile, account.namespace + ':employee-1')
    if (args[2] === 'tools') return { tools: [{ name: 'read_doc', inputSchema: { type: 'object', properties: { documentId: { type: 'string' } } },
      annotations: { readOnlyHint: true } }] }
    observed++
    assert.deepEqual(JSON.parse(args[6]), { documentId: 'public-for-this-group' })
    return { mcpId: '42', tool: 'read_doc', result: { structuredContent: { title: '文档', body: '已知事实', privateField: 'hidden' } } }
  })
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })
  assert.deepEqual((await client.listTools()).tools.map(row => row.name), ['read_doc'])
  await assert.rejects(client.callTool({ name: 'read_doc', arguments: { documentId: 'another-doc' } }))
  const result = await client.callTool({ name: 'read_doc', arguments: {} })
  assert.deepEqual(JSON.parse(result.content[0].text), { title: '文档', body: '已知事实' })
  authorized = false
  await assert.rejects(client.callTool({ name: 'read_doc', arguments: {} }))
  assert.equal(observed, 1)
})

test('shared memory scope uses explicit aliases and never maps a group to a private audience', () => {
  const qq = { id: 'qq-work', account: { platform: 'qq', namespace: 'global', id: '12345' }, memorySpaceId: 'engineering' }
  const spaces = readStandaloneMemorySpaces([{ id: 'engineering', groups: [{ connectionId: connection.id, conversationId: group.id }],
    privateUsers: [{ id: 'person', aliases: [{ connectionId: connection.id, conversationId: 'employee-1' },
      { connectionId: qq.id, conversationId: '56789' }] }] }], [connection, qq], () => true)
  const privateDing = { ...group, kind: 'private', id: 'employee-1' }
  const privateQq = { account: qq.account, kind: 'private', id: '56789' }
  assert.deepEqual(spaces.scope(privateDing, { ...account, id: 'employee-1' }, 'engineering'),
    spaces.scope(privateQq, { ...qq.account, id: '56789' }, 'engineering'))
  assert.notEqual(spaces.scope(group, { ...account, id: 'employee-1' }, 'engineering').audience,
    spaces.scope(privateDing, { ...account, id: 'employee-1' }, 'engineering').audience)
  assert.equal(spaces.scope(privateDing, { ...account, id: 'someone-else' }, 'engineering'), undefined)
  assert.equal(spaces.scope(privateQq, { ...qq.account, id: '56789' }, 'another-space'), undefined)
})

test('console candidate adds a DingTalk group, then configures a neutral persona and shared space', () => {
  const hosts = { host: 'version: 1\ninstance: test\nmodel: {baseUrl: "https://model.example/v1", name: test, apiKeyEnv: MODEL_KEY}\nconnections: [{id: qq, url: "ws://localhost:3001"}]\n',
    bindings: 'version: 1\nagents: [{id: shiloh, personaId: default}]\nconnections: [{id: qq, platform: qq, namespace: global, accountId: "12345"}]\nbindings: []\n',
    personas: undefined }
  const added = prepareStandaloneAgentTopologyChange(hosts, { kind: 'connection.dingtalk.add', agentId: 'shiloh',
    connection: { id: 'work', accountId: account.id, namespace: account.namespace, name: '助手', clientIdEnv: 'DING_KEY', clientSecretEnv: 'DING_SECRET' },
    conversations: [{ kind: 'group', conversationId: group.id }] })
  assert.match(added.sources.host, /transport: dingtalk-stream/)
  const next = prepareStandaloneAgentTopologyChange(added.sources, { kind: 'connection.settings', connectionId: 'work',
    personaId: 'assistant:none', memorySpaceId: 'engineering', sharedGroups: [group.id] })
  assert.match(next.sources.bindings, /personaId: null/)
  assert.match(next.sources.host, /memorySpaces/)
  const validate = createStandaloneAgentCandidateValidator('agent-host.yaml', {}, { requireCredentials: false })
  assert.doesNotThrow(() => validate(next.sources))
  assert.deepEqual(describeStandaloneAgentTopology(next.sources).connections.find(row => row.id === connection.id),
    { id: connection.id, account, transport: 'dingtalk-stream' })
  assert.throws(() => prepareStandaloneAgentTopologyChange(next.sources, { kind: 'connection.dingtalk.reply-policy',
    connectionId: connection.id, replyPolicy: { mode: 'group' } }))
})

test('DingTalk policy rejects unknown modes and fields, malformed IDs, and oversized or duplicate lists', () => {
  for (const policy of [{ mode: 'public' }, { requireMention: 'false' }, { allowUsers: [] }, { denyUserIds: 'someone' },
    { allowGroupIds: [0] }, { allowUserIds: ['0'] }, { denyGroupIds: [' group '] }, { allowUserIds: ['one', 'one'] },
    { denyUserIds: Array.from({ length: 257 }, (_, index) => `user-${index}`) }]) {
    assert.throws(() => readDingTalkReplyPolicy(policy))
  }
})

test('a private follow-up crosses platforms only for the linked person and loses revoked source evidence', async () => {
  const privateDing = { ...group, kind: 'private', id: 'employee-1' }
  const privateQq = { account: { platform: 'qq', namespace: 'global', id: '12345' }, kind: 'private', id: '56789' }
  const known = [privateDing, privateQq]
  const store = new Map(), frames = []
  let revoked = false
  const spaces = createAgentSharedSpaces({
    get: async key => store.get(key), set: async (key, value) => store.set(key, value),
    available: target => known.some(row => row.id === target.id),
    scope: (target, author) => known.some(row => row.id === target.id && row.kind === target.kind) && target.id === author.id
      ? { space: 'engineering', audience: 'private:linked-person' } : undefined,
    binding: target => ({ source: 'configured', id: target.id, revision: 'one', agentId: 'assistant', personaId: 'default',
      connectionId: target.account.platform, target }),
    async sourceAvailable(source, summary) { assert.ok(summary); return !revoked && known.some(target => target.id === source.binding.target.id) },
    allowsText: () => true,
    async model(request, guard) {
      await guard.ensureCurrent()
      const data = JSON.parse(request.messages[1].content)
      frames.push(data)
      const output = 'current' in data ? (data.current.includes('明天') ? { kind: 'topic', memory: '明天下午有一场面试。' } : {}) :
        data.memories.length ? { answer: '面试结束了，聊得怎么样？', refs: [1] } : { answer: '祝你面试顺利。', refs: [] }
      return { choices: [{ message: { content: JSON.stringify(output) } }] }
    },
  })
  const guard = { signal: AbortSignal.timeout(4000), isCurrent: () => true, ensureCurrent: async () => {} }
  const prompt = (conversation, text) => ({ version: 1, conversation, sender: { ...conversation.account, id: conversation.id },
    messageId: 'source-' + conversation.id, occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true })
  const first = await spaces.answer(prompt(privateDing, '明天下午要面试，有点紧张。'), {}, guard)
  await first.delivered({ state: 'sent', messageId: 'receipt' })
  assert.equal(store.size, 1)
  assert.doesNotMatch([...store.values()][0], /有点紧张/u)
  const resumed = await spaces.answer(prompt(privateQq, '面完了'), {}, guard)
  assert.match(resumed.text, /面试结束/u)
  assert.equal(await spaces.answer(prompt(group, '面完了'), {}, guard), undefined)
  revoked = true
  await assert.rejects(resumed.ensureCurrent())
  assert.equal(await spaces.answer(prompt(privateQq, '面完了'), {}, guard), undefined)
  assert.ok(frames.some(data => data.memories?.some(row => row.text === '明天下午有一场面试。')))
})

test('normal Core ingress claims and delivers one scoped answer per account and message', { skip: !redisAvailable, timeout: 12_000 }, async t => {
  const redis = await createAgentRedisFixture(t, 'ding-repo-inbox')
  const qq = { platform: 'qq', namespace: 'global', id: '12345' }
  const accounts = [account, qq], routes = [group, { account: qq, kind: 'group', id: '67890' }]
  const bindings = createAgentBindingDirectory({ version: 1, agents: [{ id: 'assistant', personaId: 'default' }],
    connections: accounts.map((row, i) => ({ id: 'conn' + i, platform: row.platform, namespace: row.namespace, accountId: row.id })),
    bindings: routes.map((row, i) => ({ connectionId: 'conn' + i, agentId: 'assistant', kind: row.kind, conversationId: row.id })),
  }, 'test-v1')
  const receive = [], sent = [], observed = []
  const adapters = accounts.map((row, i) => ({ id: 'conn' + i, account: row, botUserId: row.id, botName: '测试机器人',
    async start(accept) { receive[i] = accept }, isReady: () => !!receive[i], stop() { receive[i] = undefined },
    actions: { async send(action, guard) {
      await guard.ensureCurrent?.()
      assert.equal(guard.isCurrent(), true)
      sent.push(action)
      return { state: 'sent', messageId: 'reply-' + sent.length }
    } },
  }))
  const host = createAgentRuntime({ storage: redis.storage, adapters, unifiedGroupChat: true, isExecutionCurrent: redis.isCurrent,
    logger: { info() {}, warn() {}, error() {} }, getExecutionConfig: () => ({}), YTapi: async () => ({ error: 'unused' }),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 100 } }),
    resolvePersona(target) { const binding = bindings.resolve(target); return binding ? { binding, persona: { name: '测试助手' }, systemContent: '' } : undefined },
    repositoryKnowledge: { available: () => true, async answer(incoming, _persona, guard) {
      await guard.ensureCurrent()
      observed.push(incoming.conversation.account.platform)
      return { text: '依据当前源码，研发自测默认关闭。', isCurrent: guard.isCurrent, delivered() {} }
    } },
  })
  try {
    await host.start()
    for (const [i, target] of routes.entries()) {
      const text = '研发自测默认开吗'
      const message = { version: 1, conversation: target, sender: { ...target.account, id: i === 0 ? 'employee-1' : '99887' },
        messageId: 'same-native-id', occurredAt: Date.now(), text, parts: [{ kind: 'text', text }],
        mentions: [target.account], directedToAccount: true }
      await receive[i]({ kind: 'message', message })
      await receive[i]({ kind: 'message', message })
    }
    for (let i = 0; sent.length < 2 && i < 200; i++) await delay(20)
    assert.deepEqual(sent.map(row => row.target.account.platform).sort(), ['dingtalk', 'qq'])
    assert.deepEqual(observed.sort(), ['dingtalk', 'qq'])
    assert.ok(sent.every(row => row.replyTo === 'same-native-id' && row.parts[0].text.includes('研发自测')))
  } finally { await host.stop() }
})

test('DingTalk Core rechecks queued and in-flight replies when policies change on the same Stream', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const redis = await createAgentRedisFixture(t, 'ding-reply-policy')
  const inbox = createAgentInbox(redis.storage)
  const bindings = createAgentBindingDirectory({ version: 1, agents: [{ id: 'assistant', personaId: 'default' }],
    connections: [{ id: connection.id, platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, privateTarget].map(target => ({ connectionId: connection.id, agentId: 'assistant', kind: target.kind, conversationId: target.id })),
  }, 'reply-policy-v1')
  const replyPolicy = readDingTalkReplyPolicy({ requireMention: false, denyUserIds: ['employee-2'] })
  const policyOptions = { storage: redis.storage, connections: [{ connection, replyPolicy }], privateChatEnabled: true }
  const policies = await openStandaloneDingTalkReplyPolicies(policyOptions)
  const { dingtalk, network, connected } = await openLoopbackStream(t, {
    getReplyPolicy: () => policies.current(connection.id), canUse: target => !!bindings.resolve(target),
  })
  const textTrigger = { mode: 'strict' }
  const queue = { account, kind: 'group' }
  const stale = normalizeDingTalkMessage(connection, { ...callback, senderStaffId: 'employee-2', msgId: 'stale-queued',
    text: { content: '旧规则允许的消息' } })
  const bindingToken = JSON.stringify([agentBindingToken(bindings.resolve(group)), '', 'text-trigger-v1',
    JSON.stringify(resolveAgentTextTriggerConfig(textTrigger))])
  await inbox.accept({ event: { kind: 'message', message: stale }, bindingToken }, queue)
  assert.equal((await inbox.next(queue)).entry.event.message.messageId, stale.messageId)

  const repositoryRequests = [], ordinaryRequests = []
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const inFlightText = '模型处理中修改成员名单'
  const host = createAgentRuntime({ storage: redis.storage, adapters: [dingtalk], isExecutionCurrent: redis.isCurrent,
    textTrigger, unifiedGroupChat: true, privateChatEnabled: true,
    logger: { info() {}, warn() {}, error() {} }, getExecutionConfig: () => ({}),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 100 } }),
    resolvePersona(target) { const binding = bindings.resolve(target); return binding && { binding, persona: { name: '测试助手' }, systemContent: '' } },
    async YTapi(request) {
      const prompt = JSON.stringify(request.messages)
      ordinaryRequests.push(prompt)
      if (prompt.includes(inFlightText)) { entered.resolve(); await release.promise }
      return { choices: [{ message: { content: '这是普通文字回复。' } }] }
    },
    repositoryKnowledge: { available: target => target.kind === 'group', async answer(incoming, _persona, guard) {
      await guard.ensureCurrent()
      repositoryRequests.push(incoming.messageId)
      if (incoming.messageId === 'repo') {
        assert.equal(incoming.directedToAccount, false)
        assert.deepEqual(incoming.mentions, [])
        return { text: '这是依据仓库的回答。', isCurrent: guard.isCurrent, delivered() {} }
      }
    } },
  })
  try {
    await host.start()
    const client = await connected
    await waitFor(dingtalk.isReady, 'Stream readiness')
    await host.resumePendingWork()
    await waitFor(async () => !await inbox.next(queue), 'recovered inbox to drain')
    assert.deepEqual(repositoryRequests, [])
    assert.deepEqual(ordinaryRequests, [])
    await sendCallback(client, { ...callback, senderStaffId: 'employee-2', msgId: 'blocked-live' })
    assert.equal(await inbox.canReply(group, 'blocked-live'), false)

    for (const [target, msgId, content] of [[group, 'repo', '当前实现是什么？'],
      [group, 'chat', '这是一句没有点名的群聊。'], [privateTarget, 'direct', '这是一句普通私聊。']]) {
      await sendCallback(client, { ...callback, msgId, isInAtList: false, text: { content }, conversationType: target.kind === 'group' ? '2' : '1' })
      await waitFor(() => inbox.isTextReplyConfirmed(target, msgId), msgId + ' reply confirmation')
    }
    assert.deepEqual(repositoryRequests, ['repo', 'chat'])
    assert.equal(ordinaryRequests.length, 2)
    assert.match(ordinaryRequests[0], /没有点名的群聊/u)
    assert.match(ordinaryRequests[1], /普通私聊/u)
    assert.deepEqual(network.filter(request => request.url.includes('/robot/')).map(({ body }) => ({
      target: body.openConversationId ?? body.userIds[0], text: JSON.parse(body.msgParam).content,
    })), [{ target: group.id, text: '这是依据仓库的回答。' }, { target: group.id, text: '这是普通文字回复。' },
      { target: privateTarget.id, text: '这是普通文字回复。' }])

    await sendCallback(client, { ...callback, msgId: 'in-flight', text: { content: inFlightText } })
    await entered.promise
    const request = { params: { connectionId: connection.id }, query: {} }
    const context = { ensureCurrent() { assert.equal(redis.isCurrent(), true) } }
    const readRule = policies.services.find(service => service.method === 'GET')
    const writeRule = policies.services.find(service => service.method === 'PUT')
    const { value: before } = await readRule.handle(request, context)
    const revised = { ...replyPolicy, denyUserIds: ['employee-1', 'employee-2'] }
    const { value: saved } = await writeRule.handle({ ...request, body: { revision: before.revision, replyPolicy: revised } }, context)
    assert.deepEqual(saved.replyPolicy, revised)
    release.resolve()
    await waitFor(async () => !await inbox.next(queue), 'live policy to block in-flight reply')
    assert.equal(await inbox.isTextReplyConfirmed(group, 'in-flight'), false)
    assert.equal(network.filter(request => request.url.includes('/robot/')).length, 3)
    await sendCallback(client, { ...callback, msgId: 'blocked-by-save' })
    assert.equal(await inbox.canReply(group, 'blocked-by-save'), false)
    await sendCallback(client, { ...callback, msgId: 'allowed-by-save', senderStaffId: 'employee-3', isInAtList: false })
    await waitFor(() => inbox.isTextReplyConfirmed(group, 'allowed-by-save'), 'reply on the existing Stream')
    assert.equal(network.filter(request => request.url.endsWith('/connections/open')).length, 1)
    assert.deepEqual((await openStandaloneDingTalkReplyPolicies(policyOptions)).current(connection.id), revised)
  } finally { release.resolve(); await host.stop() }
})
