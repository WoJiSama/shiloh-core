import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentBindingDirectory, createAgentRuntime }, { personMemoryCommandText: commands },
  { personMemoryAddress }, { createPersonMemoryStore }, { createTextPersonMemoryStore },
  { agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey }, { simulationAddressKey },
  { createAgentInbox }] = await Promise.all([
  load('core/index.js'), load('modules/memory/domain/personMemoryCommands.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/textPersonMemoryStore.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/simulation/infrastructure/simulationAddress.js'), load('modules/runtime/infrastructure/agentInbox.js'),
])

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const accounts = ['bot-a', 'bot-b'].map(id => ({ platform: 'fixture', namespace: 'tenant-a', id }))
const actor = { platform: 'fixture', namespace: 'tenant-a', id: 'real-peer' }
const otherActor = { ...actor, id: 'other-peer' }
const group = { account: accounts[0], kind: 'group', id: 'room-a' }
const otherGroup = { ...group, id: 'room-b' }
const otherRoleGroup = { ...group, id: 'other-role-room' }
const otherAccountGroup = { ...group, account: accounts[1] }
const privateRoom = { account: accounts[0], kind: 'private', id: 'room-with-independent-id' }
const otherPrivateRoom = { ...privateRoom, id: 'another-private-room' }
const otherAccountPrivate = { ...privateRoom, account: accounts[1] }
const targets = [group, otherGroup, otherRoleGroup, otherAccountGroup, privateRoom, otherPrivateRoom, otherAccountPrivate]

async function waitFor(probe, description) {
  const until = performance.now() + 6_000
  while (performance.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function directory(revision = 'text-learning-v1', replacements = new Map()) {
  return createAgentBindingDirectory({
    version: 1,
    agents: [{ id: 'role', personaId: 'shared' }, { id: 'other', personaId: 'shared' }],
    connections: accounts.map((account, index) => ({ id: `fixture-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map(target => ({
      connectionId: `fixture-${accounts.findIndex(account => platformAccountKey(account) === platformAccountKey(target.account))}`,
      kind: target.kind, conversationId: target.id,
      agentId: replacements.get(conversationAddressKey(target)) ?? (target === otherRoleGroup ? 'other' : 'role'),
    })),
  }, revision)
}

function patch(messages, { category = 'fact', portable = false } = {}) {
  return JSON.stringify([{ userId: messages[0].userId, entries: messages.map((message, index) => ({
    category, text: message.text, sourceIndex: index + 1, sourceExcerpt: message.text,
    portable, sensitivity: 'ordinary',
  })) }])
}

function memoryAt(target, { subject = actor, agentId = target === otherRoleGroup ? 'other' : 'role' } = {}) {
  const { botId, scene } = personMemoryAddress(target, subject.id)
  return { identity: { botId, personaId: agentPersonaScopeId(agentId) }, subjectId: subject.id, scene, viewerUserId: subject.id }
}

async function withFixture(t, options, run) {
  const redis = await createAgentRedisFixture(t, options.name ?? 'agent-text-person-memory')
  const storage = options.wrapStorage?.(redis.storage) ?? redis.storage
  const clock = { at: Date.now() }
  const requests = [], deliveries = [], attempts = [], extractions = [], tokens = [], warnings = [], errors = [], hosts = []
  const peers = new Map(targets.filter(target => target.kind === 'private').map(target => [conversationAddressKey(target), actor]))
  let bindings = directory()
  let current
  const store = createPersonMemoryStore({ redis: storage, now: () => clock.at })
  const pending = createTextPersonMemoryStore(storage)
  const inbox = createAgentInbox(storage)
  const memorySystem = Object.hasOwn(options, 'memorySystem') ? options.memorySystem
    : { enabled: true, userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 1 }
  const fixture = {
    ...redis, storage, clock, store, requests, deliveries, attempts, extractions, tokens, warnings, errors,
    inbox: target => redis.reader.lRange(redis.prefix + `agent:inbox:${target.kind === 'group' ? 'group-text' : target.kind}:${platformAccountKey(target.account)}`, 0, -1),
    replyConfirmed: (target, id) => inbox.isTextReplyConfirmed(target, id),
    history: target => inbox.loadTextHistory(target),
    pending: () => pending.list(),
    binding: target => bindings.resolve(target),
    rebind(revision, replacements) { bindings = directory(revision, replacements) },
    setPeer(target, peer) { peers.set(conversationAddressKey(target), peer) },
    async items(target, overrides = {}) {
      return (await store.query({ ...memoryAt(target, overrides), localOnly: target.kind === 'private', limit: 50, ...overrides })).items
    },
    async texts(target, overrides) { return (await fixture.items(target, overrides)).map(item => item.text).sort() },
    async drained(target, kind = target.kind) {
      const queue = kind === 'group' ? 'group-text' : kind
      await waitFor(() => redis.reader.lLen(redis.prefix + `agent:inbox:${queue}:${platformAccountKey(target.account)}`).then(length => length === 0), `${kind} inbox drained`)
    },
    event(target, id, text, overrides = {}) {
      return { kind: 'message', message: {
        version: 1, conversation: target, sender: actor, senderName: '原始群昵称', messageId: id,
        occurredAt: clock.at, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true, ...overrides,
      } }
    },
    async emit(event) {
      const target = event.kind === 'message' ? event.message.conversation : event.target
      return current.receive.get(platformAccountKey(target.account))(event)
    },
    async send(target, id, text, overrides) {
      clock.at++
      const event = fixture.event(target, id, text, overrides)
      await fixture.emit(event)
      await fixture.drained(target)
      return event
    },
    async tick() { await current.runtime.resumePendingWork() },
    async completed() {
      await waitFor(async () => (await fixture.pending()).every(batch => batch.messages.length === 0), 'all admitted learning sources acknowledged')
    },
    async start() {
      const receive = new Map()
      const adapters = accounts.map((account, index) => {
        let ready = false
        return {
          id: `fixture-${index}`, account, botUserId: `bot-user-${index}`, botName: 'Test bot',
          resolvePrivatePeer: target => peers.get(conversationAddressKey(target)),
          actions: { async send(action, guard) {
            attempts.push(action)
            if (!guard?.isCurrent?.()) return { state: 'failed', code: 'binding_changed' }
            const receipt = options.send ? await options.send(action, guard) : { state: 'sent', messageId: `sent-${attempts.length}` }
            if (receipt.state === 'sent') deliveries.push(action)
            return receipt
          } },
          async start(accept) { receive.set(platformAccountKey(account), accept); ready = true },
          isReady: () => ready,
          stop() { ready = false },
        }
      })
      const runtime = createAgentRuntime({
        storage, adapters, now: () => clock.at, isExecutionCurrent: redis.isCurrent,
        logger: { info() {}, warn: message => warnings.push(message), error: message => errors.push(message) },
        privateChatEnabled: true, useTextGroup: target => target.kind === 'group',
        memorySystem,
        resolvePersona(target) {
          const binding = bindings.resolve(target)
          return binding && { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: 'Test bot' }, systemContent: '' }
        },
        getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
          wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
          turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
        getExecutionConfig: () => ({}),
        groupTextTools: () => ['commitmentTool'],
        recordTokens: input => tokens.push(input),
        async YTapi(request, ...args) {
          requests.push(request)
          return options.model ? await options.model(request, ...args)
            : { choices: [{ message: { content: '收到你的回复。' } }], model: 'text-fixture', usage: { total_tokens: 1 } }
        },
        ...((Object.hasOwn(options, 'extract') && options.extract === undefined) ? {} : {
          async personProfileExtract(messages, isCurrent, context) {
            extractions.push({ messages, isCurrent, context })
            return options.extract ? await options.extract(messages, isCurrent, context) : patch(messages)
          },
        }),
      })
      current = { runtime, receive }
      hosts.push(runtime)
      await runtime.start()
      return runtime
    },
    async stop() { await current?.runtime.stop() },
  }
  try {
    await fixture.start()
    await run(fixture)
  } finally {
    options.release?.()
    await Promise.all(hosts.map(host => host.stop()))
  }
}

test('text person learning stays disabled unless both the explicit switch and extractor exist', redisTest, async t => {
  for (const [name, config] of [
    ['default-off', { memorySystem: undefined }],
    ['explicit-off', { memorySystem: { enabled: false } }],
    ['no-extractor', { memorySystem: { enabled: true }, extract: undefined }],
  ]) {
    await withFixture(t, { name, ...config }, async f => {
      await f.send(privateRoom, 'ordinary', '我一直喜欢爵士乐')
      f.clock.at += 90_001
      await f.tick()
      assert.equal(f.deliveries.length, 1)
      assert.equal(f.extractions.length, 0)
      assert.deepEqual(await f.pending(), [])
      assert.deepEqual(await f.texts(privateRoom), [])
    })
  }
})

test('only a confirmed ordinary text reply admits learning, excluding uncertain delivery, tool output and forwarded sources', redisTest, async t => {
  let mode = 'unknown'
  await withFixture(t, {
    name: 'text-learning-eligibility',
    send: async () => mode === 'unknown' ? { state: 'unknown' }
      : mode === 'failed' ? { state: 'failed', code: 'transport_failed' }
        : { state: 'sent', messageId: `confirmed-${mode}` },
    model: async () => ({ choices: [{ message: mode === 'tool' ? { tool_calls: [{ id: 'list-reminders', type: 'function', function: { name: 'commitmentTool', arguments: '{"action":"list"}' } }] }
      : { content: '收到你的回复。' } }] }),
  }, async f => {
    for (const [nextMode, id, overrides] of [
      ['unknown', 'uncertain', {}], ['failed', 'failed', {}], ['tool', 'tool-only', {}],
      ['forward', 'forwarded', { parts: [{ kind: 'forward', id: 'nested-source' }] }],
    ]) {
      mode = nextMode
      await f.send(privateRoom, id, `我喜欢${id}`, overrides)
      await f.tick()
      assert.equal(f.extractions.length, 0)
      assert.deepEqual(await f.pending(), [])
    }
    mode = 'ordinary'
    await f.send(privateRoom, 'ordinary', '我一直喜欢爵士乐')
    await f.tick()
    await waitFor(async () => (await f.texts(privateRoom)).includes('我一直喜欢爵士乐'), 'ordinary confirmed reply learned')
    assert.equal(f.extractions.length, 1)
    assert.deepEqual(f.extractions[0].messages.map(message => message.text), ['我一直喜欢爵士乐'])
  })
})

test('private learning uses the verified peer and original utterance, with host-owned source provenance and quote grounding', redisTest, async t => {
  const utterance = '我一直很喜欢爵士乐'
  const quoted = '我住在引用里的城市'
  await withFixture(t, {
    name: 'text-learning-grounding',
    extract: async messages => JSON.stringify([
      { userId: actor.id, entries: [
        { category: 'interest', text: '喜欢爵士乐', sourceIndex: 1, sourceExcerpt: utterance, portable: true, sensitivity: 'ordinary' },
        { category: 'fact', text: quoted, sourceIndex: 1, sourceExcerpt: quoted, portable: true, sensitivity: 'ordinary' },
        { category: 'fact', text: '没有第二条来源', sourceIndex: 2, sourceExcerpt: utterance, portable: false, sensitivity: 'ordinary' },
      ] },
      { userId: otherActor.id, entries: [{ category: 'interest', text: '伪造他人爱好', sourceIndex: 1, sourceExcerpt: messages[0].text, portable: true, sensitivity: 'ordinary' }] },
    ]),
  }, async f => {
    const original = await f.send(privateRoom, 'source-real', utterance, {
      senderName: '仅来源场景的名字', quote: { messageId: 'quoted-id', author: otherActor, text: quoted, parts: [{ kind: 'text', text: quoted }] },
    })
    await f.tick()
    await waitFor(async () => (await f.items(privateRoom)).length === 1, 'grounded private fact')
    await f.completed()
    const [entry] = await f.items(privateRoom)
    assert.deepEqual(f.extractions[0].messages, [{ userId: actor.id, name: '仅来源场景的名字', text: utterance }])
    assert.equal(entry.text, '喜欢爵士乐')
    assert.equal(entry.evidenceKind, 'self')
    assert.equal(entry.portable, false)
    assert.deepEqual(entry.source, { scene: { kind: 'private', id: privateRoom.id, peerId: actor.id }, authorId: actor.id,
      messageId: 'source-real', at: original.message.occurredAt, excerpt: utterance })
    assert.deepEqual(await f.texts(privateRoom, { subject: otherActor }), [])
    assert.deepEqual(await f.texts(otherPrivateRoom), [])
    assert.deepEqual(await f.texts(group), [])
    assert.equal(JSON.stringify(f.extractions[0].messages).includes(quoted), false)
  })
})

test('Agent identity, account identity and private audiences stay separate while grounded public interests may cross groups', redisTest, async t => {
  await withFixture(t, { name: 'text-learning-scopes', extract: messages => Promise.resolve(patch(messages, { category: 'interest', portable: true })) }, async f => {
    await f.send(group, 'same-source-id', '我一直喜欢公开讨论天文学')
    await f.tick()
    await waitFor(async () => (await f.items(group)).length === 1, 'public interest learned')
    await f.completed()
    assert.deepEqual(await f.texts(otherGroup), ['我一直喜欢公开讨论天文学'])
    assert.deepEqual(await f.texts(otherAccountGroup), [])
    assert.deepEqual(await f.texts(otherRoleGroup), [])
    assert.deepEqual(await f.texts(privateRoom), [])

    await f.send(privateRoom, 'same-source-id', '我只在这个私聊说自己喜欢陶艺')
    await f.tick()
    await waitFor(async () => (await f.items(privateRoom)).length === 1, 'private interest learned locally')
    await f.completed()
    assert.deepEqual(await f.texts(group), ['我一直喜欢公开讨论天文学'])
    assert.deepEqual(await f.texts(otherPrivateRoom), [])
    assert.deepEqual(await f.texts(otherAccountPrivate), [])
    assert.equal((await f.items(privateRoom))[0].portable, false)

    await f.send(otherAccountGroup, 'same-source-id', '我在另一个账号讨论园艺')
    await f.send(otherRoleGroup, 'same-source-id', '我向另一位同人设角色说喜欢烹饪')
    await f.tick()
    await waitFor(async () => (await f.items(otherAccountGroup)).length === 1 && (await f.items(otherRoleGroup)).length === 1, 'independent account and Agent facts')
    await f.completed()
    assert.deepEqual(await f.texts(group), ['我一直喜欢公开讨论天文学'])
    assert.deepEqual(await f.texts(otherAccountGroup), ['我在另一个账号讨论园艺'])
    assert.deepEqual(await f.texts(otherRoleGroup), ['我向另一位同人设角色说喜欢烹饪'])

    await f.send(otherPrivateRoom, 'private-prompt', '请根据这次私聊回答')
    await f.send(otherGroup, 'group-prompt', '请根据公开资料回答')
    const privateRequest = f.requests.find(request => request.messages.at(-1).content === '请根据这次私聊回答')
    const groupRequest = f.requests.find(request => request.messages.at(-1).content === '请根据公开资料回答')
    assert.ok(privateRequest, 'private reply reaches the main model')
    assert.ok(groupRequest, 'group reply reaches the main model')
    const privatePrompt = JSON.stringify(privateRequest)
    const groupPrompt = JSON.stringify(groupRequest)
    assert.equal(privatePrompt.includes('公开讨论天文学'), false)
    assert.equal(privatePrompt.includes('私聊说自己喜欢陶艺'), false)
    assert.equal(groupPrompt.includes('公开讨论天文学'), true)
    assert.equal(groupPrompt.includes('私聊说自己喜欢陶艺'), false)
  })
})

test('ordinary learning defaults to six messages or ninety seconds of idle time and acknowledges each batch once', redisTest, async t => {
  await withFixture(t, { name: 'text-learning-default-batching', memorySystem: { enabled: true } }, async f => {
    for (let index = 1; index <= 5; index++) await f.send(privateRoom, `batch-${index}`, `本人事实第${index}条`)
    await f.tick()
    assert.equal(f.extractions.length, 0)
    assert.equal((await f.pending())[0].messages.length, 5)

    await f.send(privateRoom, 'batch-6', '本人事实第6条')
    await f.tick()
    await waitFor(() => f.extractions.length === 1, 'sixth message starts extraction')
    await f.completed()
    assert.deepEqual(f.extractions[0].messages.map(message => message.text), Array.from({ length: 6 }, (_, index) => `本人事实第${index + 1}条`))
    assert.equal((await f.items(privateRoom)).length, 6)

    await f.send(privateRoom, 'idle-source', '未到六条也会在闲置后学习')
    f.clock.at += 89_999
    await f.tick()
    assert.equal(f.extractions.length, 1)
    f.clock.at++
    await f.tick()
    await waitFor(() => f.extractions.length === 2, 'ninety-second idle threshold')
    await f.completed()
    assert.deepEqual(f.extractions[1].messages.map(message => message.text), ['未到六条也会在闲置后学习'])
    await f.tick()
    assert.equal(f.extractions.length, 2)
    assert.equal((await f.items(privateRoom)).length, 7)
  })
})

test('pending original sources survive a host restart and duplicate confirmed input does not learn or reply twice', redisTest, async t => {
  await withFixture(t, { name: 'text-learning-pending-restart', memorySystem: { enabled: true } }, async f => {
    const original = await f.send(privateRoom, 'surviving-source', '我会长期保留读书习惯')
    assert.equal(f.extractions.length, 0)
    assert.equal((await f.pending())[0].messages[0].messageId, original.message.messageId)
    await f.stop()
    f.clock.at += 90_000
    await f.start()
    await waitFor(async () => (await f.items(privateRoom)).length === 1, 'restart recovers idle extraction')
    await f.completed()
    assert.equal(f.extractions.length, 1)
    assert.equal(f.deliveries.length, 1)
    await f.emit(original)
    await f.drained(privateRoom)
    await f.tick()
    assert.equal(f.requests.length, 1)
    assert.equal(f.deliveries.length, 1)
    assert.equal(f.extractions.length, 1)
    assert.equal((await f.items(privateRoom)).length, 1)
  })
})

for (const target of [privateRoom, group]) test(`${target.kind}: a confirmed reply recovers failed durable admission after restart without repeating the model or send`, redisTest, async t => {
  let failAdmission = true
  let failures = 0
  await withFixture(t, {
    name: `text-learning-admission-restart-${target.kind}`,
    wrapStorage: storage => ({ ...storage, async eval(script, input) {
      if (failAdmission && input.keys.some(key => key.includes('agent:person-memory:text:v1:batch:')) && script.includes("redis.call('SET', KEYS[2],")) {
        failures++
        throw new Error('test lost the admission commit')
      }
      return storage.eval(script, input)
    } }),
  }, async f => {
    await f.emit(f.event(target, 'confirmed-before-admission', '我一直喜欢骑行'))
    await waitFor(() => failures > 0 && f.errors.length > 0, 'confirmed reply admission fails durably')
    await waitFor(async () => f.errors.some(line => line.includes('inbox_retry_pending')) || (await f.inbox(target)).length === 0, 'first inbox attempt settles')
    assert.equal(f.deliveries.length, 1)
    assert.equal(f.extractions.length, 0)
    assert.equal(await f.replyConfirmed(target, 'confirmed-before-admission'), true)
    const retained = await f.inbox(target)
    assert.equal(retained.length, 1, 'failed admission retains the original inbox source')
    assert.equal(JSON.parse(retained[0]).event.message.messageId, 'confirmed-before-admission')
    assert.deepEqual((await f.history(target)).turns.map(({ user, reply }) => ({ user, reply })), [
      { user: '我一直喜欢骑行', reply: '收到你的回复。' },
    ], 'admission failure preserves the sent conversation history')
    assert.deepEqual(await f.pending(), [])
    await f.stop()
    assert.deepEqual(await f.inbox(target), retained, 'shutdown preserves the same raw source')
    failAdmission = false
    await f.start()
    await waitFor(async () => (await f.items(target)).length === 1, 'confirmed inbox source re-admitted on restart')
    await f.drained(target)
    await f.completed()
    assert.equal(f.requests.length, 1)
    assert.equal(f.deliveries.length, 1)
    assert.equal(f.extractions.length, 1)
    assert.equal((await f.items(target))[0].source.messageId, 'confirmed-before-admission')
  })
})

for (const mode of ['privacy', 'recall', 'rebind', 'peer-change']) test(`a retained confirmed source cannot resume learning after ${mode}`, redisTest, async t => {
  let failAdmission = true
  await withFixture(t, {
    name: `text-learning-admission-revoked-${mode}`,
    wrapStorage: storage => ({ ...storage, async eval(script, input) {
      if (failAdmission && input.keys.some(key => key.includes('agent:person-memory:text:v1:batch:')) && script.includes("redis.call('SET', KEYS[2],")) {
        throw new Error('test lost the admission commit')
      }
      return storage.eval(script, input)
    } }),
  }, async f => {
    const messageId = `confirmed-before-${mode}`
    await f.emit(f.event(privateRoom, messageId, '我一直喜欢骑行'))
    await waitFor(() => f.errors.some(line => line.includes('inbox_retry_pending')), 'failed admission retains its inbox source')
    assert.equal((await f.inbox(privateRoom)).length, 1)
    assert.equal(await f.replyConfirmed(privateRoom, messageId), true)
    if (mode === 'privacy') {
      f.clock.at++
      await f.emit(f.event(privateRoom, 'disable-retained-learning', commands.disable, { directedToAccount: false }))
      await f.drained(privateRoom, 'privacy')
    }
    if (mode === 'recall') await f.emit({ kind: 'recall', target: privateRoom, messageId })
    if (mode === 'rebind') f.rebind('text-learning-revoked')
    if (mode === 'peer-change') f.setPeer(privateRoom, otherActor)
    await f.stop()
    const requests = f.requests.length, deliveries = f.deliveries.length
    failAdmission = false
    await f.start()
    await f.drained(privateRoom)
    await f.tick()
    await f.completed()
    assert.deepEqual(await f.pending(), [])
    assert.deepEqual(await f.items(privateRoom), [])
    assert.equal(f.extractions.length, 0)
    assert.equal(f.requests.length, requests)
    assert.equal(f.deliveries.length, deliveries)
  })
})

test('persisted extraction proposals resume after a partial fact-write failure without a second model proposal or duplicate fact', redisTest, async t => {
  let detailCommits = 0
  let failSecond = true
  const utterance = '我长期喜欢爵士乐，也经常跑步'
  await withFixture(t, {
    name: 'text-learning-result-restart',
    wrapStorage: storage => ({ ...storage, async eval(script, input) {
      if (input.keys.some(key => key.includes(':entry:')) && ++detailCommits === 2 && failSecond) throw new Error('test second fact commit failed')
      return storage.eval(script, input)
    } }),
    extract: async () => JSON.stringify([{ userId: actor.id, entries: [
      { category: 'interest', text: '喜欢爵士乐', sourceIndex: 1, sourceExcerpt: '长期喜欢爵士乐', portable: true, sensitivity: 'ordinary' },
      { category: 'interest', text: '经常跑步', sourceIndex: 1, sourceExcerpt: '经常跑步', portable: true, sensitivity: 'ordinary' },
    ] }]),
  }, async f => {
    await f.send(privateRoom, 'partially-written', utterance)
    await f.tick()
    await waitFor(async () => (await f.pending()).some(batch => batch.result && batch.attempts === 1), 'raw proposal retained after partial fact failure')
    assert.deepEqual(await f.texts(privateRoom), ['喜欢爵士乐'])
    assert.equal(f.extractions.length, 1)
    await f.stop()
    failSecond = false
    f.clock.at += 15_001
    await f.start()
    await waitFor(async () => (await f.items(privateRoom)).length === 2, 'stored proposals applied after restart')
    await f.completed()
    assert.deepEqual(await f.texts(privateRoom), ['喜欢爵士乐', '经常跑步'])
    assert.equal(f.extractions.length, 1)
    assert.equal(f.deliveries.length, 1)
  })
})

test('recall removes a waiting source and aborts in-flight extraction before any late fact may be stored', redisTest, async t => {
  const held = Promise.withResolvers()
  await withFixture(t, { name: 'text-learning-recall', extract: async messages => { await held.promise; return patch(messages) }, release: held.resolve }, async f => {
    await f.send(privateRoom, 'recall-during-extract', '我喜欢即将撤回的内容')
    await f.tick()
    await waitFor(() => f.extractions.length === 1, 'extractor starts before recall')
    const supplied = f.extractions[0]
    await f.emit({ kind: 'recall', target: privateRoom, messageId: 'recall-during-extract' })
    assert.equal(supplied.context.signal.aborted, true)
    assert.equal(supplied.isCurrent(), false)
    await assert.rejects(supplied.context.ensureCurrent())
    held.resolve()
    await f.tick()
    await waitFor(async () => (await f.pending()).every(batch => !batch.messages.some(message => message.messageId === 'recall-during-extract')), 'revoked source leaves pending work')
    assert.deepEqual(await f.texts(privateRoom), [])
    f.clock.at += 90_001
    await f.tick()
    assert.equal(f.extractions.length, 1)
  })
})

test('a private privacy command cancels same-Agent learning across its account while another account remains independent', redisTest, async t => {
  const held = Promise.withResolvers()
  await withFixture(t, {
    name: 'text-learning-privacy', release: held.resolve,
    extract: async (messages, _isCurrent, context) => {
      if (platformAccountKey(context.target.account) === platformAccountKey(accounts[0])) await held.promise
      return patch(messages)
    },
  }, async f => {
    await f.send(group, 'group-held', '我在本账号群里介绍自己')
    await f.send(privateRoom, 'private-held', '我在本账号私聊介绍自己')
    await f.tick()
    await waitFor(() => f.extractions.length === 2, 'both account-local extractors in flight')
    const previous = f.extractions.slice()
    await f.send(otherAccountGroup, 'other-account-source', '另一账号的独立事实')
    await f.tick()
    await waitFor(async () => (await f.items(otherAccountGroup)).length === 1, 'another account learns independently')
    f.clock.at++
    await f.emit(f.event(privateRoom, 'disable-memory', commands.disable, { directedToAccount: false }))
    await f.drained(privateRoom, 'privacy')
    assert.ok(previous.every(call => call.context.signal.aborted && !call.isCurrent()))
    assert.equal((await f.store.getRedactions(memoryAt(privateRoom))).disabled, true)
    held.resolve()
    await f.tick()
    assert.deepEqual(await f.texts(group), [])
    assert.deepEqual(await f.texts(privateRoom), [])
    assert.deepEqual(await f.texts(otherAccountGroup), ['另一账号的独立事实'])
    const count = f.extractions.length
    await f.send(privateRoom, 'disabled-source', '禁用后不再学习这句话')
    await f.tick()
    assert.equal(f.extractions.length, count)
    assert.equal(JSON.stringify(f.extractions.map(call => call.messages)).includes(commands.disable), false)

    f.clock.at++
    await f.emit(f.event(privateRoom, 'enable-memory', commands.enable, { directedToAccount: false }))
    await f.drained(privateRoom, 'privacy')
    await f.send(privateRoom, 'fresh-after-enable', '重新启用之后的新事实')
    await f.tick()
    await waitFor(async () => (await f.items(privateRoom)).length === 1, 'fresh source learns after re-enable')
    assert.deepEqual(await f.texts(privateRoom), ['重新启用之后的新事实'])
    assert.deepEqual(await f.texts(group), [])
  })
})

test('rebinding, a changed private peer and host stop revoke extraction authority and reject late results', redisTest, async t => {
  for (const mode of ['rebind', 'peer-change', 'stop']) {
    const held = Promise.withResolvers()
    await withFixture(t, { name: `text-learning-cancel-${mode}`, extract: async messages => { await held.promise; return patch(messages) }, release: held.resolve }, async f => {
      await f.send(privateRoom, `cancel-${mode}`, '仍在提取时的原始事实')
      await f.tick()
      await waitFor(() => f.extractions.length === 1, `${mode} extractor starts`)
      const supplied = f.extractions[0]
      await supplied.context.ensureCurrent()
      if (mode === 'rebind') f.rebind('text-learning-v2')
      if (mode === 'peer-change') f.setPeer(privateRoom, otherActor)
      if (mode === 'stop') await f.stop()
      await waitFor(() => supplied.context.signal.aborted, `${mode} abort signal`)
      assert.equal(supplied.isCurrent(), false)
      assert.equal(supplied.context.isCurrent(), false)
      await assert.rejects(supplied.context.ensureCurrent())
      held.resolve()
      if (mode !== 'stop') await f.tick()
      assert.deepEqual(await f.texts(privateRoom), [])
      assert.equal(f.deliveries.length, 1)
    })
  }
})

test('extraction context carries frozen host scope, independent turn authority and source-conversation usage attribution', redisTest, async t => {
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
  let supplied
  await withFixture(t, {
    name: 'text-learning-usage-context',
    extract: async (messages, isCurrent, context) => {
      supplied = { isCurrent, context }
      assert.equal(isCurrent(), true)
      assert.equal(context.signal.aborted, false)
      assert.deepEqual(context.target, privateRoom)
      assert.equal(Object.isFrozen(context.target), true)
      assert.equal(Object.isFrozen(context.target.account), true)
      await context.ensureCurrent()
      context.recordUsage('person-fixture', usage)
      context.recordUsage('duplicate-usage', { total_tokens: 999 })
      return patch(messages)
    },
  }, async f => {
    await f.send(privateRoom, 'context-source', '这条原文拥有自己的提取任务')
    await f.tick()
    await waitFor(async () => (await f.items(privateRoom)).length === 1, 'context-bound extraction committed')
    await f.completed()
    assert.equal(agentBindingToken(supplied.context.binding), agentBindingToken(f.binding(privateRoom)))
    const recorded = f.tokens.filter(row => row.stage === 'person-profile' && row.usage !== undefined)
    assert.deepEqual(recorded.map(({ scope, stage, model, usage }) => ({ scope, stage, model, usage })), [
      { scope: simulationAddressKey(privateRoom), stage: 'person-profile', model: 'person-fixture', usage },
    ])
    assert.ok(recorded[0].ms >= 0)
    await waitFor(() => !supplied.isCurrent(), 'completed task releases authority')
    assert.equal(supplied.context.isCurrent(), false)
    await assert.rejects(supplied.context.ensureCurrent())
    supplied.context.recordUsage('after-release', { total_tokens: 999 })
    assert.equal(f.tokens.filter(row => row.stage === 'person-profile').length, 1)
  })
})
