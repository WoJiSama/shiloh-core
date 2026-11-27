import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createPersonMemoryStore }, { personMemoryAddress },
  { createCommitmentStore }, { createDelegatedMemoryStore }, { createAgentDeferredActionPolicy },
  { createAgentBindingDirectory, agentBindingIdentity, agentConversationKey, agentPersonaScopeId, conversationAddressKey },
  { AgentManagementError }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/commitments/infrastructure/commitmentStore.js'),
  load('modules/memory/infrastructure/delegatedMemoryStore.js'), load('modules/tools/infrastructure/agentDeferredActionPolicy.js'),
  load('modules/runtime/domain/agentBindings.js'), load('contracts/agentManagement.js'),
])
const settings = { timeout: 25_000 }, logger = { info() {}, warn() {}, error() {} }, userId = '17008801'
const account = { platform: 'qq', namespace: 'global', id: '19008801' }
const targets = [
  { account, kind: 'group', id: '3108801' },
  { account: { ...account, id: '19008802' }, kind: 'group', id: '3108801' },
  { account, kind: 'group', id: '3108802' },
  { account, kind: 'private', id: userId },
]
const operations = (f, context = target => f.context(target).value) => [
  ['profiles.list', () => f.host.management.profiles.list(context())],
  ['profiles.remove', () => f.host.management.profiles.remove(userId, context(targets[0]))],
  ['profiles.removeField', () => f.host.management.profiles.removeField(userId, 'fact', undefined, context(targets[0]))],
  ['trusteeship.overview', () => f.host.management.trusteeship.overview(context())],
  ['trusteeship.cancelCommitment', () => f.host.management.trusteeship.cancelCommitment(f.key(targets[0]), 'task-0', context(targets[0]))],
  ['trusteeship.deleteDelegated', () => f.host.management.trusteeship.deleteDelegated(f.key(targets[0]), 'delegated-0', context(targets[0]))],
  ['trusteeship.clearFailLog', () => f.host.management.trusteeship.clearFailLog(context())],
]
const conflict = promise => assert.rejects(promise, error => error instanceof AgentManagementError && error.code === 'conflict')
async function waitFor(probe, description) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (await probe()) return; await delay(5) }
  assert.fail(description)
}
async function fixture(t, extra = {}) {
  assert.equal(redisAvailable, true, 'Core management integration requires isolated Redis')
  let host
  t.after(() => host?.stop())
  const redis = await createAgentRedisFixture(t, 'core-management')
  const controller = new AbortController(), hooks = {}, authorizations = [], writes = []
  const storage = { ...redis.storage }
  storage.get = async key => { await hooks.beforeGet?.(key); return redis.storage.get(key) }
  for (const method of ['set', 'del', 'eval']) storage[method] = (...args) => {
    writes.push(method); return redis.storage[method](...args)
  }
  let active = true, clock = Date.now(), revision = 'management-r1', directory, serial = 0
  const accounts = [account, targets[1].account]
  function rebuild() {
    directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
      connections: accounts.map((item, index) => ({ id: `qq-${index}`, platform: item.platform, namespace: item.namespace, accountId: item.id })),
      bindings: targets.map((target, index) => ({ connectionId: `qq-${accounts.findIndex(item => item.id === target.account.id)}`,
        kind: target.kind, conversationId: target.id, agentId: index === 2 ? 'other' : 'daily' })),
    }, revision)
  }
  rebuild()
  const bindings = { list: () => directory.listBindings(), resolve: target => directory.resolve(target) }
  const adapters = accounts.map((account, index) => ({ id: `qq-${index}`, account, botUserId: account.id,
    isReady: () => false, start() {}, stop() {}, actions: { async send() { assert.fail('offline fixture must not send') } } }))
  const options = { storage, adapters, logger, now: () => clock,
    signal: controller.signal, isExecutionCurrent: () => active && redis.isCurrent(), managementBindings: bindings,
    resolvePersona: target => ({ binding: bindings.resolve(target), persona: { name: '隔离机器人' }, systemContent: '管理集成验证' }),
    getSection: () => ({ enabled: false, allGroups: false }), getExecutionConfig: () => ({ useTools: false }),
    YTapi: async () => { assert.fail('management reads must not call a model') },
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false },
    groupMemory: { enabled: false }, groupLog: { enabled: false }, ...extra }
  host = createAgentRuntime(options)
  const memory = createPersonMemoryStore({ redis: storage, now: () => clock })
  const store = createCommitmentStore({ redis: storage, logger })
  const delegated = createDelegatedMemoryStore({ redis: storage, logger, loadConfig: () => ({}), now: () => clock })
  const binding = target => bindings.resolve(target)
  const key = target => agentConversationKey(binding(target))
  function context(target) {
    let current = true
    const lifetime = new AbortController(), value = {
      ...(target ? { binding: structuredClone(binding(target)) } : {}), signal: lifetime.signal,
      isCurrent: () => current && !lifetime.signal.aborted,
      ensureCurrent() { if (!value.isCurrent()) throw new AgentManagementError('conflict') },
      async authorize(operation, selected, guard) {
        authorizations.push({ operation, binding: structuredClone(selected) }); guard.ensureCurrent()
        await hooks.authorize?.(operation, selected, guard)
        return hooks.decision ?? 'allowed'
      },
    }
    return { value, revoke() { current = false }, abort() { lifetime.abort() } }
  }
  async function remember(target, text) {
    const { botId, scene } = personMemoryAddress(target)
    const result = await memory.remember({ identity: { botId, personaId: agentPersonaScopeId(binding(target).agentId) }, subjectId: userId,
      category: 'fact', evidenceKind: 'self', text, source: { scene, authorId: userId, messageId: `native-${++serial}`, at: clock - 1000, excerpt: text } })
    assert.equal(result.saved, true, result.reason)
    return result.entry
  }
  async function task(target, id, more = {}) {
    const due = clock + 86_400_000
    const row = { id, group_id: target.kind === 'group' ? target.id : '', creator_id: userId, creator_name: '隔离用户', intent: `intent-${id}`,
      schedule: { kind: 'once', time: due }, deliver: 'static', static_message: `reminder-${id}`, expiry_at: due + 86_400_000,
      next_run_at: due, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: clock,
      bot_id: target.account.id, scope: { agentId: binding(target).agentId, target }, bindingIdentity: agentBindingIdentity(binding(target)), ...more }
    await store.createCommitment(row)
    return row
  }
  async function seed() {
    for (const [index, target] of targets.entries()) await remember(target, `profile-source-${index}`)
    for (const [index, target] of targets.slice(0, 3).entries()) {
      const row = await task(target, `task-${index}`)
      await delegated.update(binding(target), () => ({ entries: [{ id: `delegated-${index}`, owner: userId, ownerName: '隔离用户',
        content: `delegated-source-${index}`, dueAt: 0, status: 'active', createdAt: clock, updatedAt: clock }], result: true }))
      await store.appendFailLog({ id: row.id, intent: row.intent, group_id: row.group_id, reason: `failure-source-${index}`, at: clock })
    }
  }
  async function snapshot() {
    const keys = (await redis.storage.keys('*')).filter(key => key !== 'agent:host-lease').sort()
    return Object.fromEntries(await Promise.all(keys.map(async key => [key, await redis.reader.dump(redis.prefix + key)])))
  }
  return { ...redis, storage, writes, host, options, bindings, binding, key, context, hooks, authorizations, memory, store, delegated, remember, task, seed, snapshot,
    get now() { return clock }, advance(ms) { clock += ms }, retire() { active = false }, abort() { controller.abort() },
    rebind() { revision += '-changed'; rebuild() } }
}

test('Core exposes management only when the trusted host supplies a binding directory', settings, async t => {
  const f = await fixture(t, { managementBindings: undefined })
  assert.equal(f.host.management, undefined)
  await f.host.start(); await f.host.stop()
  assert.equal(f.host.management, undefined)
})

test('a synchronous execution hook cannot revoke the parent request and still dispatch a management read', settings, async t => {
  const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
  for (const owned of [false, true]) await t.test(owned ? 'paired parent' : 'foreign parent', async t => {
    let revoke
    const f = await fixture(t, { isExecutionCurrent() { revoke?.(); return true } })
    await f.host.start()
    const request = f.context()
    const parent = owned ? { ...request.value, ...createSynchronousGuard(request.value.signal,
      () => request.value.ensureCurrent(), () => { throw new AgentManagementError('conflict') }) } : request.value
    let reads = 0
    f.hooks.beforeGet = () => { reads++ }
    revoke = request.revoke
    await conflict(f.host.management.profiles.list(parent))
    assert.equal(reads, 0)
    assert.equal(f.authorizations.length, 0)
  })
})

test('an execution hook may synchronously audit a scoped management guard with a paired parent', settings, async t => {
  const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
  let observer, busy = false
  const observed = [], f = await fixture(t, { isExecutionCurrent() {
    if (observer && !busy) {
      busy = true
      try { observed.push(observer()) } finally { busy = false }
    }
    return true
  } })
  await f.host.start()
  const request = f.context(), parent = { ...request.value, ...createSynchronousGuard(request.value.signal,
    request.value.ensureCurrent, () => { throw new AgentManagementError('conflict') }) }
  f.hooks.authorize = (_operation, _binding, guard) => {
    observer = () => guard.isCurrent()
    try { guard.ensureCurrent() } finally { observer = undefined }
  }
  assert.deepEqual(await f.host.management.profiles.list(parent), [])
  assert.ok(observed.length > 0)
  assert.ok(observed.every(value => value === true))
})

test('owned management checks share one synchronous configuration observation and recheck after authorization', settings, async t => {
  const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
  let inside = false, observations = 0, revision = 1, invalidate = false
  const f = await fixture(t, {
    isExecutionCurrent: () => revision === 1,
    observeExecutionCurrent(check) {
      if (inside) return check()
      observations++
      const before = revision
      inside = true
      try { return check() && revision === before } finally { inside = false }
    },
  })
  await f.host.start()
  const request = f.context()
  const parent = { ...request.value, ...createSynchronousGuard(request.value.signal, () => {
    assert.equal(inside, true)
    request.value.ensureCurrent()
  }, () => { throw new AgentManagementError('conflict') }) }
  f.hooks.authorize = async (_operation, _binding, guard) => {
    const before = observations
    guard.ensureCurrent()
    assert.equal(observations - before, 1)
    if (invalidate) {
      await Promise.resolve()
      revision++
    }
  }
  assert.deepEqual((await f.host.management.trusteeship.overview(parent)).commitments, [])
  invalidate = true
  await conflict(f.host.management.trusteeship.overview(parent))
})

test('real Core management reads existing person, commitment and delegated partitions across accounts and Agents', settings, async t => {
  const f = await fixture(t); await f.seed(); await f.host.start()
  const profiles = await f.host.management.profiles.list(f.context().value)
  assert.equal(profiles.length, 4)
  for (const [index, target] of targets.entries()) {
    const row = profiles.find(row => conversationAddressKey(row.binding.target) === conversationAddressKey(target))
    assert.deepEqual(row.binding, f.binding(target)); assert.equal(row.profile.entries[0].text, `profile-source-${index}`)
    const selected = await f.host.management.profiles.list(f.context(target).value)
    assert.deepEqual(selected.map(row => row.profile.entries[0].text), [`profile-source-${index}`])
  }
  const overview = await f.host.management.trusteeship.overview(f.context().value)
  assert.deepEqual(overview.commitments.map(row => row.id).sort(), ['task-0', 'task-1', 'task-2'])
  assert.deepEqual(overview.delegated.map(row => row.entries[0].content).sort(), ['delegated-source-0', 'delegated-source-1', 'delegated-source-2'])
  assert.deepEqual(overview.failures.map(row => row.reason).sort(), ['failure-source-0', 'failure-source-1', 'failure-source-2'])
  for (const [index, target] of targets.slice(0, 3).entries()) {
    const scoped = await f.host.management.trusteeship.overview(f.context(target).value)
    assert.deepEqual(scoped.commitments.map(row => row.id), [`task-${index}`])
    assert.deepEqual(scoped.delegated.map(row => row.entries[0].id), [`delegated-${index}`])
    assert.equal(scoped.commitments[0].scopeKey, f.key(target))
  }
  assert.equal(f.authorizations.every(row => row.binding.connectionId && row.binding.revision && row.binding.target.account.id), true)
})

test('Core management mutations alter only the selected real storage partition', settings, async t => {
  const f = await fixture(t); await f.seed(); await f.host.start()
  assert.equal(await f.host.management.profiles.remove(userId, f.context(targets[0]).value), true)
  assert.deepEqual(await f.host.management.profiles.list(f.context(targets[0]).value), [])
  assert.equal((await f.host.management.profiles.list(f.context(targets[1]).value)).length, 1)
  assert.equal(await f.store.getCommitment('task-0'), null); assert.equal((await f.store.getCommitment('task-1')).status, 'active')
  assert.deepEqual(await f.delegated.load(f.binding(targets[0])), [])
  assert.equal((await f.delegated.load(f.binding(targets[1]))).length, 1)
  f.advance(1)
  const fresh = await f.task(targets[0], 'post-forget-task')
  await f.delegated.update(f.binding(targets[0]), () => ({ entries: [{ id: 'post-forget-delegated', owner: userId, ownerName: '隔离用户',
    content: '新的托付', dueAt: 0, status: 'active', createdAt: f.now, updatedAt: f.now, sourceAt: f.now }], result: true }))
  assert.equal(await f.host.management.trusteeship.cancelCommitment(f.key(targets[0]), fresh.id, f.context(targets[0]).value), true)
  assert.equal((await f.store.getCommitment(fresh.id)).status, 'cancelled')
  assert.equal(await f.host.management.trusteeship.deleteDelegated(f.key(targets[0]), 'post-forget-delegated', f.context(targets[0]).value), true)
  await f.store.appendFailLog({ id: fresh.id, intent: fresh.intent, group_id: fresh.group_id, reason: 'new failure', at: f.now })
  assert.equal(await f.host.management.trusteeship.clearFailLog(f.context(targets[0]).value), true)
  assert.deepEqual((await f.host.management.trusteeship.overview(f.context().value)).failures.map(row => row.reason).sort(), ['failure-source-1', 'failure-source-2'])
})

test('Core forget bridges the original durable cutoff, exposes all four source owners and resumes without replaying source deletion', settings, async t => {
  const [{ createStandaloneAgentForgetOperations }, { createStandaloneAgentConsoleManagement }, { createForgetOperationStore },
    { createAgentHistoryStore, agentHistoryId }] = await Promise.all([
      load('bootstrap/standaloneAgentForgetOperations.js'), load('bootstrap/standaloneAgentConsoleManagement.js'),
      load('modules/runtime/infrastructure/forgetOperationStore.js'), load('modules/memory/infrastructure/agentHistoryStore.js'),
    ])
  const f = await fixture(t), cutoff = f.now, target = targets[0], binding = f.binding(target)
  await f.remember(target, '人物来源待忘记')
  await f.task(target, 'old-source-task')
  await f.task(target, 'new-source-task', { sourceAt: cutoff + 1 })
  const history = createAgentHistoryStore(f.storage), scope = { agentId: binding.agentId, target }, id = agentHistoryId(scope)
  await history.update(id, () => ({ version: 1, id, scope, rows: [
    { messageId: 'old-source', authorId: userId, name: '用户', text: 'old history source', at: cutoff },
    { messageId: 'new-source', authorId: userId, name: '用户', text: 'new history source', at: cutoff + 1 },
  ] }))
  f.advance(5_000); await f.host.start()
  const auth = { async authorize() { return 'allowed' }, isCurrent() { return true } }
  const management = createStandaloneAgentConsoleManagement({ management: f.host.management, auth })
  const request = { ...f.context(target).value, principal: { id: 'trusted-admin', username: 'admin', via: 'session' } }
  const profiles = { ...management.profiles, async remove(...args) { removals++; return management.profiles.remove(...args) } }
  let removals = 0
  const calls = [], store = createForgetOperationStore({ redis: f.storage, now: () => cutoff })
  const forgetting = createStandaloneAgentForgetOperations({ store, bindings: f.bindings, auth, profiles,
    characters: { async describeGroup() { throw Error('unused') }, async controlCharacter() { throw Error('unused') } },
    sourceMemoryCleanup: { async purgeSubject(input, guard) {
      calls.push(structuredClone(input))
      const receipt = await f.host.sourceMemoryCleanup.purgeSubject(input, guard)
      assert.deepEqual(receipt.partitions.map(row => row.id).sort(), ['commitments', 'delegated-memory', 'history-records', 'person-extraction-batches'])
      const partitions = receipt.partitions.map(row => calls.length === 1 && row.id === 'history-records' ? { ...row, cleanup: 'unknown' } : row)
      if (calls.length === 1) partitions.push({ id: 'public-web-evidence', cleanup: 'completed', removedRecords: 1, removedPartitions: 0 })
      return { ...receipt, partitions }
    } },
  })
  const first = await forgetting.profile({ userId, requestId: 'core-forget-fixed-cutoff' }, request)
  assert.equal(first.createdAt, cutoff); assert.equal(first.phase, 'unknown'); assert.equal(removals, 1)
  assert.equal(first.impacts.find(impact => impact.id === 'public-web-evidence')?.state, 'completed')
  assert.deepEqual((await history.read(id)).rows.map(row => row.messageId), ['new-source'])
  assert.equal(await f.store.getCommitment('old-source-task'), null)
  assert.equal((await f.store.getCommitment('new-source-task')).sourceAt, cutoff + 1)
  f.advance(10_000)
  const completed = await forgetting.profile({ userId, requestId: 'core-forget-fixed-cutoff' }, request)
  assert.equal(completed.phase, 'completed'); assert.equal(completed.cleanup, 'unsupported')
  assert.equal(completed.operationId, first.operationId); assert.equal(removals, 1)
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].through, cutoff)
  assert.deepEqual((await history.read(id)).rows.map(row => row.messageId), ['new-source'])
  assert.notEqual(await f.store.getCommitment('new-source-task'), null)
})

test('Core rejects host cutoff metadata for a different subject, binding or future timestamp before source mutation', settings, async t => {
  const f = await fixture(t), target = targets[0]
  await f.remember(target, '不能扩大此来源'); await f.host.start()
  const { agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
  for (const extra of [{ userId: 'different' }, { bindingToken: 'different' }, { through: f.now + 1 }]) {
    const request = { ...f.context(target).value, profileForget: { operationId: '019cb495-1f56-7756-aa47-459067a692d9',
      userId, bindingToken: agentBindingToken(f.binding(target)), through: f.now, ...extra } }
    await assert.rejects(f.host.management.profiles.remove(userId, request), { code: 'invalid_request' })
    assert.equal((await f.host.management.profiles.list(f.context(target).value)).length, 1)
  }
})

for (const revoked of ['stop', 'execution', 'external-signal']) {
  test(`all Core management methods reject after ${revoked} without changing real Redis`, settings, async t => {
    const f = await fixture(t); await f.seed(); await f.host.start()
    if (revoked === 'stop') await f.host.stop()
    if (revoked === 'execution') f.retire()
    if (revoked === 'external-signal') { f.abort(); await f.host.stop() }
    const before = await f.snapshot(), authorizations = f.authorizations.length, writes = f.writes.length
    for (const [name, invoke] of operations(f)) { await conflict(invoke()); assert.deepEqual(await f.snapshot(), before, name) }
    assert.equal(f.authorizations.length, authorizations)
    assert.equal(f.writes.length, writes, 'retired management must not attempt any Redis mutation')
  })
}

for (const revoked of ['stop', 'execution', 'external-signal', 'request', 'binding']) {
  test(`Core rechecks ${revoked} revoked during awaited management authorization before touching records`, settings, async t => {
    for (let index = 0; index < 7; index++) {
      const f = await fixture(t); await f.seed(); await f.host.start()
      const before = await f.snapshot(), pending = f.context(targets[0]), writes = f.writes.length
      f.hooks.authorize = async () => {
        await Promise.resolve()
        if (revoked === 'stop') await f.host.stop()
        if (revoked === 'execution') f.retire()
        if (revoked === 'external-signal') { f.abort(); await f.host.stop() }
        if (revoked === 'request') pending.revoke()
        if (revoked === 'binding') f.rebind()
      }
      const [name, invoke] = operations(f, () => pending.value)[index]
      await conflict(invoke())
      assert.ok(f.authorizations.length > 0, `${name} reached awaited authorization`)
      assert.deepEqual(await f.snapshot(), before, name)
      assert.equal(f.writes.length, writes, `${name} must not attempt writes after awaited revocation`)
    }
  })
}

test('management cancellation reaches the actual in-flight Core deferred worker immediately', settings, async t => {
  // Disable interval polling so only the store invalidation listener can end this suspended authorization.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const entered = Promise.withResolvers(), suspended = Promise.withResolvers()
  t.after(() => suspended.resolve())
  let ready = false, captured, effects = 0, sends = 0
  const sourceAt = Date.now() - 1000
  const adapter = { id: 'qq-0', account, botUserId: account.id, isReady: () => ready,
    start() { ready = true }, stop() { ready = false },
    async readConversationMember(target, user, guard) {
      captured = guard; entered.resolve(); await suspended.promise
      return { target, observedAt: Date.now(), member: { user, role: 'member' } }
    },
    async readMessage(target, id) { return { version: 1, conversation: target, sender: { ...account, id: userId }, messageId: id,
      occurredAt: sourceAt, text: '按批准计划执行一次', parts: [{ kind: 'text', text: '按批准计划执行一次' }], mentions: [], directedToAccount: false } },
    actions: { async send() { sends++; return { state: 'sent', messageId: 'must-not-send' } } } }
  const definition = { name: 'managementCancellationTool', executor: 'custom', definitionId: 'fixture:management-cancel:v1',
    isCurrent: () => true, validate: input => input.value === 'fixed', async execute() { effects++; return { status: 'succeeded', content: 'must-not-execute' } } }
  const policy = { enabled: true, rules: [] }
  const f = await fixture(t, { adapters: [adapter],
    deferredActions: policy,
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false },
      rhythm: { enabled: false }, wakeGate: { enabled: false }, wake: { probability: 0, proactiveProbability: 0 },
      toolPolicy: { mode: 'open', allowTools: [definition.name] } }),
    toolRegistry: { builtIn: [{ name: definition.name, description: 'fixture capability', parameters: { type: 'object',
      properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      execute: async () => ({ status: 'failed', content: 'not a model test' }) }] },
    getDeferredActionDefinitions: () => [definition] })
  const binding = f.binding(targets[0]), creator = { ...account, id: userId }, dueAt = f.now + 60_000
  const action = { tool: definition.name, executor: definition.executor, definitionId: definition.definitionId, params: { value: 'fixed' } }
  policy.rules.push({ id: 'management-rule', revision: 'r1', bindingIdentity: agentBindingIdentity(binding), scopeKey: f.key(targets[0]),
    creatorIds: [userId], tool: definition.name, executor: definition.executor, definitionId: definition.definitionId, maxDelayMs: 86_400_000 })
  const issuer = createAgentDeferredActionPolicy({ getConfig: () => policy, resolveDefinition: () => definition,
    mode: () => 'simulation', isToolAllowed: () => true, verifyAuthority: async () => 'allowed', now: () => f.now })
  const grant = await issuer.issue({ binding, creator, action, dueAt, source: { kind: 'message', messageId: 'cancel-source', at: sourceAt }, requestText: '按批准计划执行一次' })
  assert.ok(grant)
  await f.task(targets[0], 'inflight-task', { schedule: { kind: 'once', time: dueAt }, next_run_at: dueAt,
    deferredAction: { version: 1, action, grant, state: 'pending', attemptedAt: 0, settledAt: 0, resultCode: '' } })
  f.advance(60_001); await f.host.start()
  let timer
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('real Core deferred authorization never started')), 5000)
    })])
  } finally { clearTimeout(timer) }
  assert.equal(captured.signal.aborted, false)
  assert.equal(await f.host.management.trusteeship.cancelCommitment(f.key(targets[0]), 'inflight-task', f.context(targets[0]).value), true)
  assert.equal(captured.signal.aborted, true, 'cancellation must abort without periodic claim polling')
  assert.equal((await f.store.getCommitment('inflight-task')).status, 'cancelled')
  suspended.resolve(); await f.host.resumePendingWork(); await f.host.stop()
  assert.equal(effects, 0); assert.equal(sends, 0)
  assert.equal((await f.store.getCommitment('inflight-task')).status, 'cancelled')
})

for (const method of ['remove', 'removeField']) {
  test(`authorized profiles.${method} aborts actual Core media work before tombstone I/O while denied work remains live`, settings, async t => {
    const heldProvider = Promise.withResolvers(), heldRead = Promise.withResolvers(), readStarted = Promise.withResolvers()
    t.after(() => { heldProvider.resolve(); heldRead.resolve() })
    const accepts = new Map(), ready = new Set(), sources = new Map(), preparations = new Map(), deliveries = [], released = []
    const ids = ['BV1H7Gq6zEiC', 'BV1xx411c7mD']
    const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
    const adapters = [account, targets[1].account].map((owner, index) => ({
      id: `qq-${index}`, account: owner, botUserId: owner.id,
      isReady: () => ready.has(owner.id), start(accept) { ready.add(owner.id); accepts.set(owner.id, accept) }, stop() { ready.delete(owner.id) },
      async readMessage(target, id) { return structuredClone(sources.get(sourceKey(target, id))?.message) },
      async readMediaShare(target, id, guard) {
        guard.signal.throwIfAborted()
        const source = sources.get(sourceKey(target, id))
        if (source && guard.isCurrent() && await guard.allowsSource(source.message)) return structuredClone(source)
      },
      actions: { async sendMediaRelay(action, guard) {
        assert.equal(guard.isCurrent(), true); deliveries.push(action); return { state: 'sent', messageId: `relay-${deliveries.length}` }
      }, async send() { assert.fail('media preparation must not fall back to ordinary text') } },
    }))
    const f = await fixture(t, { adapters, mediaRelay: { enabled: true },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false },
        mood: { enabled: false }, personProfile: { enabled: false }, wakeGate: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
      mediaRelayProvider: { async prepare(share, context) {
        preparations.set(share.reference.id, context); await heldProvider.promise
        return { status: 'ready', pageUrl: `https://www.bilibili.com/video/${share.reference.id}`, infoText: '隔离媒体准备',
          plan: { version: 1, items: [{ parts: [{ kind: 'image', artifact: { id: '1'.repeat(32), kind: 'image', mime: 'image/png', sizeBytes: 16, sha256: '2'.repeat(64) } }] }] },
          async release() { released.push(share.reference.id) } }
      } } })
    const original = await f.remember(targets[0], '删除前的有据事实')
    await f.host.start()
    for (const [index, target] of targets.slice(0, 2).entries()) {
      const message = { version: 1, conversation: target, sender: { ...target.account, id: userId }, senderName: '隔离用户',
        messageId: `privacy-media-${index}`, occurredAt: f.now, text: `https://www.bilibili.com/video/${ids[index]}`,
        parts: [{ kind: 'extension', platform: 'qq', type: 'json' }], mentions: [target.account], directedToAccount: true }
      sources.set(sourceKey(target, message.messageId), { message, share: { provider: 'bilibili', reference: { kind: 'video', id: ids[index] } } })
      await accepts.get(target.account.id)({ kind: 'message', message })
    }
    await waitFor(() => preparations.size === 2, 'actual Core did not start both account media preparations')
    const selectedWork = preparations.get(ids[0]), otherWork = preparations.get(ids[1])
    const remove = context => method === 'remove'
      ? f.host.management.profiles.remove(userId, context)
      : f.host.management.profiles.removeField(userId, 'entries', original.id, context)
    f.hooks.decision = 'denied'
    await assert.rejects(remove(f.context(targets[0]).value), { code: 'forbidden' })
    assert.equal(selectedWork.signal.aborted, false); assert.equal(otherWork.signal.aborted, false)
    f.hooks.decision = 'allowed'
    const revoked = f.context(targets[0])
    f.hooks.authorize = async () => { await Promise.resolve(); revoked.revoke() }
    await conflict(remove(revoked.value))
    assert.equal(selectedWork.signal.aborted, false); assert.equal(otherWork.signal.aborted, false)
    delete f.hooks.authorize
    let intercept = true
    f.hooks.beforeGet = async key => {
      if (intercept && key.startsWith('shiloh:person-memory:v1:')) {
        intercept = false; readStarted.resolve(); await heldRead.promise
      }
    }
    const deleting = remove(f.context(targets[0]).value)
    // Attach a rejection handler immediately so a failed assertion cannot leave an unhandled deletion.
    void deleting.catch(() => {})
    await readStarted.promise
    try {
      assert.equal(selectedWork.signal.aborted, true, 'authorized deletion must revoke its existing memory turn before tombstone reads/writes')
      assert.equal(otherWork.signal.aborted, false, 'another account must keep its captured memory turn')
    } finally { heldRead.resolve() }
    await deleting
    delete f.hooks.beforeGet
    assert.equal(selectedWork.signal.aborted, true, 'finishing privacy admission must not revive the old provider authority')
    await assert.rejects(selectedWork.ensureCurrent())
    assert.deepEqual(await f.host.management.profiles.list(f.context(targets[0]).value), [])
    heldProvider.resolve()
    await waitFor(() => released.length === 2, 'late prepared leases were not released')
    await waitFor(() => deliveries.length === 1, 'unrelated account did not finish after privacy admission was released')
    assert.deepEqual(deliveries.map(action => action.target.account.id), [targets[1].account.id])
  })
}
