import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createAgentBindingDirectory, agentPersonaScopeId, agentBindingToken, conversationAddressKey },
  { createConversationMemory }, { createConversationMemoryStore, conversationMemoryId }, { createAgentInbox },
  { createPersonMemoryStore }, { personMemoryAddress }, { personMemoryCommandText: commands },
  { AgentManagementError }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/memory/infrastructure/conversationMemory.js'), load('modules/memory/infrastructure/conversationMemoryStore.js'),
  load('modules/runtime/infrastructure/agentInbox.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/memory/domain/personMemoryCommands.js'), load('contracts/agentManagement.js'),
])
const settings = { timeout: 20_000 }, logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'qq', namespace: 'global', id: '19005501' }
const author = { ...account, id: '17005501' }, otherAuthor = { ...author, id: '17005502' }
const group = { account, kind: 'group', id: '31005501' }, otherGroup = { ...group, id: '31005502' }
const friend = { account, kind: 'private', id: author.id }, otherAccountGroup = { ...group, account: { ...account, id: '19005502' } }
const PREFIX = 'agent:conversation-memory:v1'
const stateKey = (target = group, agentId = 'daily') => `${PREFIX}:state:${conversationMemoryId({ target, agentId })}`
const physicalRead = (script, args) => args.keys.some(key => key.startsWith(`${PREFIX}:state:`)) && !script.includes("redis.call('SET'")
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')

async function waitFor(probe, description) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (await probe()) return; await delay(5) }
  assert.fail(description)
}
async function fixture(t, overrides = {}) {
  assert.equal(redisAvailable, true, 'conversation cleanup integration requires isolated Redis')
  const hosts = [], owners = [], releases = []
  t.after(async () => { for (const release of releases) release(); for (const host of hosts) await host.stop(); for (const owner of owners) await owner.stop() })
  const redis = await createAgentRedisFixture(t, 'core-conversation-cleanup')
  const hooks = {}, deliveries = [], handlers = [], lifetime = new AbortController()
  const storage = { ...redis.storage, async eval(script, args) { await hooks.beforeEval?.(script, args); return redis.storage.eval(script, args) } }
  const store = createConversationMemoryStore(redis.storage), inbox = createAgentInbox(redis.storage)
  let now = Date.now(), serial = 0, revision = 0, live = true, directory
  const assignment = new Map([group, otherGroup, friend, otherAccountGroup].map(target => [conversationAddressKey(target), 'daily']))
  function rebuild() {
    directory = createAgentBindingDirectory({ version: 1,
      agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
      connections: [account, otherAccountGroup.account].map((item, index) => ({ id: `qq-${index}`, platform: item.platform, namespace: item.namespace, accountId: item.id })),
      bindings: [group, otherGroup, friend, otherAccountGroup].filter(target => assignment.has(conversationAddressKey(target))).map(target => ({
        connectionId: target.account.id === account.id ? 'qq-0' : 'qq-1', kind: target.kind, conversationId: target.id,
        agentId: assignment.get(conversationAddressKey(target)),
      })),
    }, `conversation-cleanup-${++revision}`)
  }
  rebuild()
  const bindings = { list: () => directory.listBindings(), resolve: target => directory.resolve(target) }
  const adapters = [account, otherAccountGroup.account].map((item, index) => ({ id: `qq-${index}`, account: item, botUserId: item.id,
    resolvePrivatePeer: () => author, isReady: () => !!handlers[index],
    start(handler) { handlers[index] = handler }, stop() { handlers[index] = undefined },
    actions: { async send(action, guard) {
      if (!guard.isCurrent()) return { state: 'failed', code: 'scope_changed' }
      deliveries.push(action); return { state: 'sent', messageId: `9500${deliveries.length}` }
    } },
  }))
  const options = { storage, adapters, logger, now: () => now, signal: lifetime.signal,
    isExecutionCurrent: () => live && redis.isCurrent(), managementBindings: bindings, privateChatEnabled: true,
    getSection: () => ({ enabled: true, allGroups: true, rhythm: { enabled: false }, reflection: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
    getExecutionConfig: () => ({ useTools: false }),
    resolvePersona(target) {
      const binding = bindings.resolve(target)
      return binding && { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '隔离角色' }, systemContent: '' }
    },
    YTapi: async () => assert.fail('cleanup must not use a model'), memorySystem: { enabled: false },
    midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, semanticMemory: { enabled: false },
    groupMemory: { enabled: false }, groupLog: { enabled: false }, ...overrides,
  }
  function createHost(extra = {}) { const host = createAgentRuntime({ ...options, ...extra }); hosts.push(host); return host }
  const host = createHost(), memory = createPersonMemoryStore({ redis: redis.storage, now: () => now })
  const viewer = (target = group, agentId = 'daily') => ({ botId: personMemoryAddress(target).botId, personaId: agentPersonaScopeId(agentId), personaVersion: 'fixture-v1', personaName: '隔离角色' })
  function authority() {
    let active = true
    const controller = new AbortController(), value = { signal: controller.signal, isCurrent: () => active && !controller.signal.aborted,
      async ensureCurrent() { if (!value.isCurrent()) throw new Error('trusted cleanup revoked') } }
    return { value, revoke() { active = false }, abort() { controller.abort() } }
  }
  function context(target = group) {
    const request = authority()
    const value = { ...request.value, binding: structuredClone(bindings.resolve(target)),
      ensureCurrent() { if (!request.value.isCurrent()) throw new AgentManagementError('conflict') },
      async authorize(operation, binding, guard) { guard.ensureCurrent(); await hooks.authorize?.(operation, binding, guard); return hooks.decision ?? 'allowed' },
    }
    return { ...request, value }
  }
  async function seed(target = group, agentId = 'daily', records = [{}]) {
    const binding = { ...bindings.resolve(target), target, agentId }, id = conversationMemoryId(binding)
    const rows = records.map((row, index) => ({ seq: index + 1, messageId: `record-${++serial}`, authorId: author.id, name: '本人',
      text: `原始资料-${serial}`, at: now - 1000, ...row }))
    const state = { version: 1, id, scope: { target, agentId }, binding, token: agentBindingToken(binding), nextSeq: rows.length + 1,
      records: rows, episodes: [{ id: `episode-${++serial}`, at: now - 20, userId: target.kind === 'private' ? author.id : otherAuthor.id,
        userName: '另一位群友', summary: '含已离开缓冲的本人资料', reply: '由旧上下文生成的回复', source: viewer(target, agentId),
        messageIds: ['source-no-longer-buffered'], replyIds: ['confirmed-old-reply'], invalidatedAt: 0 }],
      summary: { text: '含本人和其他人资料的旧聚合', updatedAt: now - 10, coveredSeq: rows.length, invalidatedAt: 0 },
      dueAt: 0, dueInvalidatedAt: 0, attempts: 0, retryAt: 0,
    }
    assert.equal(await store.update(id, () => state), true)
    return state
  }
  async function raw(target = group, agentId = 'daily') {
    const value = await redis.storage.get(stateKey(target, agentId))
    return value === null ? undefined : JSON.parse(value)
  }
  function message(target = group, command = 'forget', occurredAt = now, text = commands[command]) {
    return { kind: 'message', message: { version: 1, conversation: target, messageId: `5500${++serial}`, sender: author, occurredAt,
      text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false } }
  }
  async function remember() {
    const { botId, scene } = personMemoryAddress(group), text = '只删这一条人物字段'
    const result = await memory.remember({ identity: { botId, personaId: agentPersonaScopeId('daily') }, subjectId: author.id,
      category: 'fact', evidenceKind: 'self', text, source: { scene, authorId: author.id, messageId: `person-${++serial}`, at: now - 500, excerpt: text } })
    assert.equal(result.saved, true, result.reason); return result.entry
  }
  function createOwner(extra = {}) {
    const owner = createConversationMemory({ redis: storage, memory: { ...memory,
      async getSceneRedactions(input) { await hooks.beforeEpoch?.(input); return memory.getSceneRedactions(input) },
    }, midterm: () => ({ enabled: true, minMessages: 4, debounceMs: 5000 }), episodic: () => ({ enabled: true }),
      resolve: target => { const binding = bindings.resolve(target); return binding && { binding, viewer: viewer(target, binding.agentId) } },
      available: () => true, privatePeer: () => author.id, isRecalled: async () => false, isRunning: () => live && redis.isCurrent(),
      begin: async () => ({ signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, release() {} }),
      allowsText: () => true, logger, now: () => now, summarize: async input => input.previous + input.messages.map(row => row.text).join('；'), ...extra,
    })
    owners.push(owner); return owner
  }
  async function capture(owner, text, actor = author) {
    now++
    const event = message(group, 'forget', now, text)
    event.message.sender = actor
    await owner.capture(event.message, bindings.resolve(group), () => true)
    return event.message
  }
  const input = (target = group, through = now) => ({ account, agentId: 'daily', subjectId: author.id, ...(target ? { target } : {}), through })
  return { ...redis, storage, host, createHost, createOwner, inbox, store, memory, hooks, bindings, deliveries, authority, context, viewer, seed, raw, message, remember, capture, input, releases,
    emit: (event, index = 0) => handlers[index](event), get now() { return now }, advance(ms) { now += ms },
    rebind(target = group, agentId = 'other') { assignment.set(conversationAddressKey(target), agentId); rebuild() },
    unbind(target = group) { assignment.delete(conversationAddressKey(target)); rebuild() }, retire() { live = false }, abort() { lifetime.abort() } }
}

test('disabled conversation cleanup removes only matching original records and all old aggregates after the privacy commit', settings, async t => {
  const f = await fixture(t), through = f.now - 25
  const state = await f.seed(group, 'daily', [{ at: through }, { authorId: otherAuthor.id, at: through }, { at: through + 1 }])
  const separate = await f.seed(otherGroup), otherAccount = await f.seed(otherAccountGroup), otherAgent = await f.seed(group, 'other')
  await f.host.start()
  const event = f.message(group, 'forget', through)
  let witnessed = false
  f.hooks.beforeEval = async (script, args) => {
    if (physicalRead(script, args)) {
      const item = await f.inbox.next({ account, kind: 'privacy' })
      assert.ok(item); assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied'); witnessed = true
    }
  }
  await f.emit(event)
  await waitFor(async () => f.deliveries.length === 1 && !await f.inbox.next({ account, kind: 'privacy' }), 'privacy cleanup did not complete')
  assert.equal(witnessed, true)
  const after = await f.raw()
  assert.deepEqual(after.records, state.records.slice(1)); assert.equal(after.summary, undefined); assert.deepEqual(after.episodes, [])
  for (const [target, agentId, prior] of [[otherGroup, 'daily', separate], [otherAccountGroup, 'daily', otherAccount], [group, 'other', otherAgent]]) assert.deepEqual(await f.raw(target, agentId), prior)
})

test('private disable cleans original account and Agent scopes including unbound groups without deleting another person records', settings, async t => {
  const f = await fixture(t)
  const original = await f.seed(group, 'daily', [{}, { authorId: otherAuthor.id }])
  await f.seed(otherGroup); await f.seed(friend)
  const otherAccount = await f.seed(otherAccountGroup), otherAgent = await f.seed(group, 'other')
  f.unbind(group); await f.host.start(); await f.emit(f.message(friend, 'disable'))
  await waitFor(() => f.deliveries.length === 1, 'private disable did not finish')
  assert.deepEqual((await f.raw()).records, original.records.slice(1)); assert.equal((await f.raw()).summary, undefined); assert.deepEqual((await f.raw()).episodes, [])
  assert.equal(await f.raw(otherGroup), undefined); assert.equal(await f.raw(friend), undefined)
  assert.deepEqual(await f.raw(otherAccountGroup), otherAccount); assert.deepEqual(await f.raw(group, 'other'), otherAgent)
})

test('enable and console field deletion preserve physical conversation records, summary and episodes', settings, async t => {
  const f = await fixture(t), prior = await f.seed(), entry = await f.remember()
  await f.host.start(); await f.emit(f.message(group, 'enable'))
  await waitFor(() => f.deliveries.length === 1, 'enable did not finish')
  assert.deepEqual(await f.raw(), prior)
  await f.host.management.profiles.removeField(author.id, 'entries', entry.id, f.context().value)
  assert.deepEqual(await f.raw(), prior)
})

for (const target of [group, friend]) test(`console whole-person deletion limits physical cleanup to the selected ${target.kind} target even without a profile`, settings, async t => {
  const f = await fixture(t)
  await f.seed(target)
  const retainedTarget = target.kind === 'private' ? group : friend, retained = await f.seed(retainedTarget)
  await f.host.start()
  assert.equal(await f.host.management.profiles.remove(author.id, f.context(target).value), false)
  assert.equal(await f.raw(target), undefined); assert.deepEqual(await f.raw(retainedTarget), retained)
})

test('unknown physical cleanup preserves applied work and resumes the original owner and cutoff after rebind', settings, async t => {
  const f = await fixture(t), through = f.now - 25
  const prior = await f.seed(group, 'daily', [{ at: through }, { at: through + 1 }]), separate = await f.seed(group, 'other')
  let failed = false
  f.hooks.beforeEval = (script, args) => { if (physicalRead(script, args)) { failed = true; throw new Error('isolated conversation read failure') } }
  await f.host.start(); const event = f.message(group, 'forget', through); await f.emit(event)
  await waitFor(() => failed, 'physical cleanup did not run')
  const item = await f.inbox.next({ account, kind: 'privacy' })
  assert.ok(item); assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied')
  assert.deepEqual(await f.raw(), prior); assert.deepEqual(f.deliveries, [])
  await f.host.stop(); delete f.hooks.beforeEval; f.rebind(); f.advance(60_000)
  const resumed = f.createHost(); await resumed.start()
  assert.equal(await f.inbox.next({ account, kind: 'privacy' }), null)
  const after = await f.raw(group, 'daily')
  assert.deepEqual(after.records, prior.records.slice(1)); assert.equal(after.summary, undefined); assert.deepEqual(after.episodes, [])
  assert.deepEqual(await f.raw(group, 'other'), separate); assert.deepEqual(f.deliveries, [])
})

test('the public cleanup port reports raw leftovers as unknown then proves actual deletion on retry', settings, async t => {
  const f = await fixture(t), prior = await f.seed()
  await f.host.start()
  f.hooks.beforeEval = (script, args) => { if (physicalRead(script, args)) throw new Error('physical store unavailable') }
  const uncertain = await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value)
  assert.equal(uncertain.cleanup, 'unknown'); assert.equal(uncertain.usage, 'blocked')
  assert.deepEqual(await f.raw(), prior); assert.ok(await f.storage.get(`${PREFIX}:cleanup`))
  delete f.hooks.beforeEval
  const receipt = await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value)
  assert.deepEqual(receipt, { usage: 'blocked', cleanup: 'completed', removedRecords: 1, removedSummaries: 1, removedEpisodes: 1, removedPartitions: 1 })
  assert.equal(await f.raw(), undefined)
})

test('a sibling emoji failure cannot prevent physical conversation cleanup and cannot produce a success confirmation', settings, async t => {
  const f = await fixture(t, { localEmojiCleanup: { async revokeSource() { throw new Error('unused') }, async purgeSubject() { throw new Error('emoji failed') } } })
  await f.seed(); await f.host.start(); await f.emit(f.message())
  await waitFor(async () => !await f.raw(), 'conversation cleanup was blocked by a failed sibling')
  assert.ok(await f.inbox.next({ account, kind: 'privacy' })); assert.deepEqual(f.deliveries, [])
})

test('console rejection and cancellation during the raw read leave physical content unchanged', settings, async t => {
  for (const mode of ['denied', 'request-before', 'binding-before', 'request-during', 'binding-during']) await t.test(mode, async t => {
    const f = await fixture(t), prior = await f.seed(), entered = Promise.withResolvers(), release = Promise.withResolvers()
    f.releases.push(() => release.resolve()); await f.host.start(); const request = f.context()
    if (mode === 'denied') f.hooks.decision = 'denied'
    if (mode.endsWith('before')) f.hooks.authorize = async () => { await Promise.resolve(); if (mode.startsWith('request')) request.revoke(); else f.rebind() }
    if (mode.endsWith('during')) f.hooks.beforeEval = async (script, args) => { if (physicalRead(script, args)) { entered.resolve(); await release.promise } }
    const pending = f.host.management.profiles.remove(author.id, request.value); void pending.catch(() => {})
    if (mode.endsWith('during')) { await entered.promise; if (mode.startsWith('request')) request.abort(); else f.rebind(); release.resolve() }
    await assert.rejects(pending)
    assert.deepEqual(await f.raw(), prior)
  })
})

test('cleanup cancels an old summary only after authorization and permits a new summary and episode under the new token', settings, async t => {
  const f = await fixture(t), held = Promise.withResolvers(), summaries = []
  f.releases.push(() => held.resolve())
  const owner = f.createOwner({ async summarize(input, context) { summaries.push({ input, context }); if (summaries.length === 1) await held.promise; return input.messages.map(row => row.text).join('；') } })
  for (let index = 0; index < 4; index++) await f.capture(owner, `待清理的本人原文-${index}`)
  f.advance(5001); await owner.tick(); await waitFor(() => summaries.length === 1, 'summary did not start')
  const denied = f.authority(); denied.value.ensureCurrent = async () => { await Promise.resolve(); throw new Error('no permission') }
  await assert.rejects(owner.purgeSubject(f.input(), denied.value))
  assert.equal(summaries[0].context.signal.aborted, false, 'denied cleanup must not cancel authorized summary work')
  await owner.purgeSubject(f.input(), f.authority().value)
  assert.equal(summaries[0].context.signal.aborted, true); held.resolve()
  await waitFor(async () => (await f.raw())?.summary === undefined, 'old summary revived')
  for (let index = 0; index < 4; index++) await f.capture(owner, `新水位后的其他人原文-${index}`, otherAuthor)
  f.advance(5001); await owner.tick()
  await waitFor(async () => (await f.raw())?.summary?.cleanupToken, 'new valid summary must be allowed after cleanup')
  const state = await f.raw(), token = await f.store.cleanupToken(state.scope)
  assert.equal(state.summary.cleanupToken, token); assert.equal(summaries[1].input.previous, '')
  assert.ok(summaries[1].input.messages.every(row => row.authorId === otherAuthor.id))
  await owner.recordEpisode({ binding: f.bindings.resolve(group), source: f.viewer(), at: f.now, userId: otherAuthor.id, userName: '另一位',
    summary: '新水位的有效情节', reply: '新的已确认回复', messageIds: [state.records.at(-1).messageId], replyIds: ['new-token-reply'] }, () => true)
  assert.equal((await f.raw()).episodes.at(-1).cleanupToken, token)
  const visible = await owner.read(f.bindings.resolve(group), f.viewer(), () => true, { simulation: true })
  assert.match(visible.digest, /新水位后的其他人/u); assert.match(visible.episodes, /新水位的有效情节/u)
})

test('a public cleanup starts a fresh debounce generation even after the prior summary exhausted its retries', settings, async t => {
  for (const reset of ['capture', 'tick']) await t.test(reset, async t => {
    const f = await fixture(t), summaries = [], owner = f.createOwner({ async summarize(input) {
      summaries.push(input); return input.messages.map(row => row.text).join('；')
    } })
    const before = await f.seed(group, 'daily', [{ text: '应当删除的本人旧来源' }, ...Array.from({ length: 4 }, (_, index) => ({
      text: `应当保留的其他人来源-${index}`, authorId: otherAuthor.id,
    }))])
    await f.store.update(before.id, saved => {
      const { summary: _oldSummary, ...state } = saved
      return { ...state, episodes: [], dueAt: f.now - 1000, attempts: 3, retryAt: f.now + 60_000 }
    })
    await f.host.start()
    await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value)
    assert.equal((await f.memory.getSceneRedactions({ identity: { botId: f.viewer().botId, personaId: f.viewer().personaId },
      scene: personMemoryAddress(group).scene })).invalidatedAt, 0, 'public cleanup need not advance person-memory epochs')
    if (reset === 'tick') await owner.tick()
    const message = await f.capture(owner, '截止之后允许记住的本人新来源')
    const scheduled = await f.raw(), token = await f.store.cleanupToken(scheduled.scope), dueAt = scheduled.dueAt
    assert.equal(scheduled.dueCleanupToken, token); assert.equal(scheduled.attempts, 0); assert.equal(scheduled.retryAt, 0)
    assert.ok(dueAt > f.now); assert.equal(scheduled.summary, undefined)
    await owner.tick(); assert.equal(summaries.length, 0, 'an old expired deadline cannot bypass the new debounce')
    f.advance(dueAt - f.now - 1); await owner.tick(); assert.equal(summaries.length, 0)
    f.advance(2); await owner.tick()
    await waitFor(async () => (await f.raw())?.summary?.cleanupToken === token, 'an exhausted old generation blocked a new summary')
    assert.equal(summaries.length, 1); assert.equal(summaries[0].previous, '')
    assert.ok(summaries[0].messages.some(row => row.text === message.text))
    assert.equal(summaries[0].messages.filter(row => row.authorId === otherAuthor.id).length, 4)
    assert.ok(!summaries[0].messages.some(row => row.text === '应当删除的本人旧来源'))
    await owner.recordEpisode({ binding: f.bindings.resolve(group), source: f.viewer(), at: f.now, userId: author.id,
      summary: '截止之后正常建立的新情节', reply: '新水位允许的回复', messageIds: [message.messageId], replyIds: [`new-generation-${reset}`] }, () => true)
    assert.equal((await f.raw()).episodes.at(-1).cleanupToken, token)
    const visible = await owner.read(f.bindings.resolve(group), f.viewer(), () => true, { simulation: true })
    assert.match(visible.digest, /截止之后允许记住/u); assert.match(visible.episodes, /截止之后正常建立/u)
  })
})

test('a late summary failure from another owner cannot spend the new cleanup generation retry budget', settings, async t => {
  const f = await fixture(t), held = Promise.withResolvers(), summaries = []
  f.releases.push(() => held.resolve())
  const owner = f.createOwner({ async summarize(input, context) {
    summaries.push({ input, context })
    if (summaries.length === 1) { await held.promise; throw new Error('late old-generation provider failure') }
    return input.messages.map(row => row.text).join('；')
  } })
  await f.host.start()
  for (let index = 0; index < 4; index++) await f.capture(owner, `本人旧代次-${index}`)
  for (let index = 0; index < 4; index++) await f.capture(owner, `保留的其他人-${index}`, otherAuthor)
  f.advance(5001); await owner.tick(); await waitFor(() => summaries.length === 1, 'old summary did not begin')
  await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value)
  assert.equal(summaries[0].context.signal.aborted, false, 'the separate owner learns about cleanup from the durable token')
  await f.capture(owner, '允许的新代次来源')
  const scheduled = await f.raw()
  assert.ok(scheduled.dueCleanupToken); assert.equal(scheduled.attempts, 0)
  held.resolve(); await waitFor(() => summaries[0].context.signal.aborted, 'old summary did not settle')
  const afterFailure = await f.raw()
  assert.equal(afterFailure.summary, undefined); assert.equal(afterFailure.dueCleanupToken, scheduled.dueCleanupToken)
  assert.equal(afterFailure.attempts, 0); assert.equal(afterFailure.retryAt, 0); assert.equal(afterFailure.dueAt, scheduled.dueAt)
  f.advance(scheduled.dueAt - f.now + 1); await owner.tick()
  await waitFor(async () => (await f.raw())?.summary?.cleanupToken === scheduled.dueCleanupToken, 'old failure blocked the new summary')
  assert.equal(summaries[1].input.previous, '')
})

test('a timed-out summary logs its active phase, stops authorization reads and respects persisted backoff on a stale sweep', settings, async t => {
  const f = await fixture(t)
  const state = await f.seed(group, 'daily', Array.from({ length: 4 }, () => ({})))
  await f.store.update(state.id, saved => ({ ...saved, summary: undefined, dueAt: f.now - 1 }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = Promise.withResolvers(), allowPrivacy = Promise.withResolvers()
  const oldList = Promise.withResolvers(), allowList = Promise.withResolvers()
  const retrySaved = Promise.withResolvers(), events = [], failures = []
  const diagnostics = createAgentDiagnostics({ logger, now: () => f.now, onFailure: event => failures.push(event),
    sink: { async append(event) {
      events.push(event)
      if (event.code === 'summary_retry_scheduled') retrySaved.resolve()
      return true
    } },
  })
  let holdList = false, tailReads = 0, modelCalls = 0
  const stalledSubject = 'privacy-stall', tailSubject = 'privacy-tail'
  const owner = f.createOwner({ diagnostics,
    redis: { ...f.storage, async eval(script, request) {
      const result = await f.storage.eval(script, request)
      if (holdList && script.includes('local result =')) {
        holdList = false
        oldList.resolve()
        await allowList.promise
      }
      return result
    } },
    memory: { ...f.memory, getRedactionsBatch: undefined,
      async listSubjects(identity) { return [stalledSubject, tailSubject].map(subjectId => ({ identity, subjectId })) },
      async getRedactions(subject) {
        if (subject.subjectId === stalledSubject) { pending.resolve(); await allowPrivacy.promise }
        if (subject.subjectId === tailSubject) tailReads++
        return f.memory.getRedactions(subject)
      } },
    async summarize() { modelCalls++; return '摘要完成' },
  })
  try {
    await owner.tick()
    await pending.promise
    holdList = true
    const sweep = owner.tick()
    await oldList.promise
    f.advance(40_000)
    t.mock.timers.tick(40_000)
    await retrySaved.promise
    await nextTurn()
    const backedOff = await f.raw()
    assert.equal(backedOff.attempts, 1)
    assert.equal(backedOff.retryAt, f.now + 15_000)
    assert.equal(failures.length, 1)
    const [failed] = failures
    assert.equal(failed.operation, 'summary_request_authorization')
    assert.equal(failed.code, 'summary_timeout')
    assert.deepEqual(failed.scope, { kind: 'conversation', binding: state.binding })
    assert.ok(events.filter(event => event.traceId === failed.traceId).some(event => event.code === 'summary_retry_scheduled'))
    allowPrivacy.resolve()
    allowList.resolve()
    await sweep
    await nextTurn()
    assert.equal(tailReads, 0)
    assert.equal(modelCalls, 0)
  } finally { allowPrivacy.resolve(); allowList.resolve(); await owner.stop(); await diagnostics.flush() }
})

test('cleanup during an episode source check cannot label its old context with a new generation', settings, async t => {
  const f = await fixture(t), owner = f.createOwner(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.releases.push(() => release.resolve()); await f.seed(); await f.host.start()
  f.hooks.beforeEpoch = async () => { entered.resolve(); await release.promise }
  const pending = owner.recordEpisode({ binding: f.bindings.resolve(group), source: f.viewer(), at: f.now, userId: author.id,
    summary: '旧上下文情节', reply: '不准复活', messageIds: ['old-source'], replyIds: ['late-episode'] }, () => true)
  await entered.promise; await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value); release.resolve(); await pending
  assert.equal(await f.raw(), undefined)
})

test('a projection held after loading its aggregates is rejected if cleanup advances before return', settings, async t => {
  const f = await fixture(t), owner = f.createOwner(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.releases.push(() => release.resolve()); await f.seed(); await f.host.start()
  f.hooks.beforeEpoch = async () => { entered.resolve(); await release.promise }
  const pending = owner.read(f.bindings.resolve(group), f.viewer(), () => true, { simulation: true })
  await entered.promise; await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value); release.resolve()
  assert.deepEqual(await pending, { digest: '', episodes: '' })
})

test('public cleanup rejects revoked authority without cancelling a model but stops an authorized old turn before episode registration', settings, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, { useTextGroup: () => true, episodicMemory: { enabled: true },
    async YTapi(_request, _config, signal, current) { entered.resolve({ signal, current }); await release.promise; return { choices: [{ message: { content: '迟到的旧上下文回复' } }] } },
  })
  f.releases.push(() => release.resolve()); await f.host.start()
  const message = f.message(group, 'forget', f.now, '启动真实文字模型回合'); message.message.directedToAccount = true
  await f.emit(message); const turn = await entered.promise
  const rejected = f.authority(); rejected.value.ensureCurrent = async () => { await Promise.resolve(); throw new Error('denied') }
  await assert.rejects(f.host.conversationMemoryCleanup.purgeSubject(f.input(), rejected.value))
  assert.equal(turn.current(), true)
  await f.host.conversationMemoryCleanup.purgeSubject(f.input(), f.authority().value)
  assert.equal(turn.current(), false)
  release.resolve()
  await waitFor(async () => !await f.inbox.next({ account, kind: 'group' }), 'old text turn did not settle')
  assert.deepEqual(f.deliveries, []); assert.ok(!(await f.raw())?.episodes.some(row => row.reply.includes('迟到')))
})
