import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createAgentBindingDirectory, agentPersonaScopeId, conversationAddressKey },
  { createAgentSemanticMemoryStore, agentSemanticMemoryId }, { createAgentInbox },
  { createPersonMemoryStore }, { personMemoryAddress }, { personMemoryCommandText: commands },
  { AgentManagementError }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/memory/infrastructure/agentSemanticMemoryStore.js'), load('modules/runtime/infrastructure/agentInbox.js'),
  load('modules/memory/infrastructure/personMemoryStore.js'), load('modules/memory/infrastructure/personMemoryContext.js'),
  load('modules/memory/domain/personMemoryCommands.js'), load('contracts/agentManagement.js'),
])
const settings = { timeout: 20_000 }, logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'qq', namespace: 'global', id: '19006601' }
const author = { ...account, id: '17006601' }, otherAuthor = { ...author, id: '17006602' }
const group = { account, kind: 'group', id: '31006601' }, otherGroup = { ...group, id: '31006602' }
const friend = { account, kind: 'private', id: author.id }
const otherAccountGroup = { ...group, account: { ...account, id: '19006602' } }
const PREFIX = 'agent:semantic-memory:v1', providerId = 'a'.repeat(64)
const stateKey = (target = group, agentId = 'daily') => `${PREFIX}:state:${agentSemanticMemoryId({ target, agentId })}`
const semanticRead = (script, args) => args.keys.some(key => key.startsWith(`${PREFIX}:state:`)) && !script.includes("redis.call('SET'")

async function waitFor(probe, description) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (await probe()) return; await delay(5) }
  assert.fail(description)
}
async function fixture(t, overrides = {}) {
  assert.equal(redisAvailable, true, 'semantic cleanup integration requires isolated Redis')
  const hosts = [], releases = []
  t.after(async () => { for (const release of releases) release(); for (const host of hosts) await host.stop() })
  const redis = await createAgentRedisFixture(t, 'core-semantic-cleanup')
  const hooks = {}, deliveries = [], handlers = [], lifetime = new AbortController()
  const storage = { ...redis.storage,
    async eval(script, args) { await hooks.beforeEval?.(script, args); return redis.storage.eval(script, args) },
  }
  const store = createAgentSemanticMemoryStore(redis.storage), inbox = createAgentInbox(redis.storage)
  let now = Date.now(), serial = 0, revision = 0, live = true, directory
  const owners = new Map([group, otherGroup, friend, otherAccountGroup].map(target => [conversationAddressKey(target), 'daily']))
  function rebuild() {
    directory = createAgentBindingDirectory({ version: 1,
      agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
      connections: [account, otherAccountGroup.account].map((item, index) => ({ id: `qq-${index}`, platform: item.platform, namespace: item.namespace, accountId: item.id })),
      bindings: [group, otherGroup, friend, otherAccountGroup].filter(target => owners.has(conversationAddressKey(target))).map(target => ({
        connectionId: target.account.id === account.id ? 'qq-0' : 'qq-1', kind: target.kind, conversationId: target.id,
        agentId: owners.get(conversationAddressKey(target)),
      })),
    }, `semantic-cleanup-${++revision}`)
  }
  rebuild()
  const bindings = { list: () => directory.listBindings(), resolve: target => directory.resolve(target) }
  const adapters = [account, otherAccountGroup.account].map((owner, index) => ({ id: `qq-${index}`, account: owner, botUserId: owner.id,
    resolvePrivatePeer: () => author, isReady: () => !!handlers[index],
    start(handler) { handlers[index] = handler }, stop() { handlers[index] = undefined },
    actions: { async send(action, guard) {
      assert.equal(guard.isCurrent(), true); deliveries.push(action)
      return { state: 'sent', messageId: `9600${deliveries.length}` }
    } },
  }))
  const options = { storage, adapters, logger, now: () => now, signal: lifetime.signal,
    isExecutionCurrent: () => live && redis.isCurrent(), managementBindings: bindings, privateChatEnabled: true,
    semanticMemory: { enabled: false },
    getSection: () => ({ enabled: true, allGroups: true, rhythm: { enabled: false }, reflection: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
    getExecutionConfig: () => ({ useTools: false }),
    resolvePersona(target) {
      const binding = bindings.resolve(target)
      return binding && { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '隔离角色' }, systemContent: '' }
    },
    YTapi: async () => assert.fail('cleanup must not use a model'),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false },
    groupMemory: { enabled: false }, groupLog: { enabled: false }, ...overrides,
  }
  function createHost(extra = {}) { const host = createAgentRuntime({ ...options, ...extra }); hosts.push(host); return host }
  const host = createHost(), memory = createPersonMemoryStore({ redis: redis.storage, now: () => now })
  function authority() {
    let active = true
    const controller = new AbortController()
    const value = { signal: controller.signal, isCurrent: () => active && !controller.signal.aborted,
      async ensureCurrent() { if (!value.isCurrent()) throw new Error('trusted cleanup revoked') },
    }
    return { value, revoke() { active = false }, abort() { controller.abort() } }
  }
  function context(target = group) {
    let active = true
    const controller = new AbortController()
    const value = { binding: structuredClone(bindings.resolve(target)), signal: controller.signal,
      isCurrent: () => active && !controller.signal.aborted,
      ensureCurrent() { if (!value.isCurrent()) throw new AgentManagementError('conflict') },
      async authorize(operation, binding, guard) {
        guard.ensureCurrent(); await hooks.authorize?.(operation, binding, guard)
        return hooks.decision ?? 'allowed'
      },
    }
    return { value, revoke() { active = false }, abort() { controller.abort() } }
  }
  async function seed(target = group, agentId = 'daily', rows = [{}]) {
    const id = agentSemanticMemoryId({ target, agentId })
    const saved = rows.map(row => ({ messageId: `semantic-${++serial}`, authorId: author.id, name: '来源作者', text: `真实持久来源-${serial}`,
      at: now - 1000, vector: [1, 0], providerId, ...row }))
    assert.equal(await store.update(id, () => ({ version: 1, id, scope: { target, agentId }, rows: saved })), true)
    return saved
  }
  async function raw(target = group, agentId = 'daily') {
    const value = await redis.storage.get(stateKey(target, agentId))
    return value === null ? undefined : JSON.parse(value)
  }
  function message(target = group, command = 'forget', occurredAt = now) {
    const text = commands[command]
    return { kind: 'message', message: { version: 1, conversation: target, messageId: `6600${++serial}`, sender: author, occurredAt,
      text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false } }
  }
  async function remember(target = group) {
    const { botId, scene } = personMemoryAddress(target), text = '需要删除的独立人物字段'
    const saved = await memory.remember({ identity: { botId, personaId: agentPersonaScopeId('daily') }, subjectId: author.id,
      category: 'fact', evidenceKind: 'self', text,
      source: { scene, authorId: author.id, messageId: `person-${++serial}`, at: now - 500, excerpt: text } })
    assert.equal(saved.saved, true, saved.reason)
    return saved.entry
  }
  return { ...redis, storage, host, createHost, inbox, store, hooks, bindings, deliveries, authority, context, seed, raw, message, remember, releases,
    emit: (event, index = 0) => handlers[index](event), get now() { return now }, advance(ms) { now += ms },
    rebind(target = group, agentId = 'other') { owners.set(conversationAddressKey(target), agentId); rebuild() },
    unbind(target = group) { owners.delete(conversationAddressKey(target)); rebuild() },
    retire() { live = false }, abort() { lifetime.abort() } }
}

test('disabled semantic cleanup physically deletes only group author rows at or before the incoming cutoff without a backend', settings, async t => {
  const f = await fixture(t), through = f.now - 25
  const rows = await f.seed(group, 'daily', [{ at: through }, { authorId: otherAuthor.id, at: through }, { at: through + 1 }])
  const other = await f.seed(otherGroup), otherAccount = await f.seed(otherAccountGroup), otherAgent = await f.seed(group, 'other')
  await f.host.start()
  const event = f.message(group, 'forget', through)
  let witnessedApplied = false
  f.hooks.beforeEval = async (script, args) => {
    if (semanticRead(script, args)) {
      const item = await f.inbox.next({ account, kind: 'privacy' })
      assert.ok(item)
      assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied')
      witnessedApplied = true
    }
  }
  await f.emit(event)
  await waitFor(async () => f.deliveries.length === 1 && !await f.inbox.next({ account, kind: 'privacy' }), 'group privacy cleanup did not finish')
  assert.equal(witnessedApplied, true, 'the real semantic store can be cleaned only after its durable privacy commit')
  assert.deepEqual((await f.raw()).rows, rows.slice(1), 'raw persisted text and vectors must both be removed')
  assert.deepEqual((await f.raw(otherGroup)).rows, other)
  assert.deepEqual((await f.raw(otherAccountGroup)).rows, otherAccount)
  assert.deepEqual((await f.raw(group, 'other')).rows, otherAgent)
})

test('private disable physically cleans the original Agent across this account including an unbound group', settings, async t => {
  const f = await fixture(t)
  await f.seed(); await f.seed(otherGroup); await f.seed(friend)
  const otherAccount = await f.seed(otherAccountGroup), otherAgent = await f.seed(group, 'other')
  f.unbind(group)
  await f.host.start(); await f.emit(f.message(friend, 'disable'))
  await waitFor(() => f.deliveries.length === 1, 'private cleanup was not confirmed')
  for (const target of [group, otherGroup, friend]) assert.equal(await f.raw(target), undefined, 'matching empty partitions must be physically deleted')
  const catalog = JSON.parse(await f.storage.get(`${PREFIX}:catalog`))
  assert.equal(catalog.entries.length, 2)
  assert.deepEqual((await f.raw(otherAccountGroup)).rows, otherAccount)
  assert.deepEqual((await f.raw(group, 'other')).rows, otherAgent)
})

test('enabling person memory preserves the existing semantic rows and vectors', settings, async t => {
  const f = await fixture(t), rows = await f.seed()
  await f.host.start(); await f.emit(f.message(group, 'enable'))
  await waitFor(() => f.deliveries.length === 1, 'enable command did not finish')
  assert.deepEqual((await f.raw()).rows, rows)
})

for (const target of [group, friend]) {
  test(`console whole-person removal physically cleans only its selected ${target.kind} target even when no profile exists`, settings, async t => {
    const f = await fixture(t)
    await f.seed(target)
    const retainedTarget = target.kind === 'private' ? group : friend, retained = await f.seed(retainedTarget)
    await f.host.start()
    assert.equal(await f.host.management.profiles.remove(author.id, f.context(target).value), false)
    assert.equal(await f.raw(target), undefined)
    assert.deepEqual((await f.raw(retainedTarget)).rows, retained)
  })
}

test('console field removal does not purge semantic raw rows or vectors', settings, async t => {
  const f = await fixture(t), rows = await f.seed(), entry = await f.remember()
  await f.host.start()
  await f.host.management.profiles.removeField(author.id, 'entries', entry.id, f.context().value)
  assert.deepEqual((await f.raw()).rows, rows)
})

test('console cutoff stays fixed before awaited profile storage instead of moving with cleanup time', settings, async t => {
  const f = await fixture(t), through = f.now
  const rows = await f.seed(group, 'daily', [{ at: through }, { at: through + 1 }])
  await f.host.start()
  let advanced = false
  f.hooks.beforeEval = (_script, args) => {
    if (!advanced && args.keys.some(key => key.startsWith('shiloh:person-memory:v1:'))) { advanced = true; f.advance(5000) }
  }
  assert.equal(await f.host.management.profiles.remove(author.id, f.context().value), false)
  assert.equal(advanced, true, 'clock must advance during the real profile owner storage access')
  assert.deepEqual((await f.raw()).rows, rows.slice(1), 'source after admission must survive even when cleanup occurs later')
})

test('unknown physical cleanup preserves applied privacy work and resumes the original Agent and cutoff after rebind', settings, async t => {
  const f = await fixture(t), through = f.now - 25
  const rows = await f.seed(group, 'daily', [{ at: through }, { at: through + 1 }])
  const newerAgent = await f.seed(group, 'other')
  let failedReads = 0
  f.hooks.beforeEval = (script, args) => {
    if (semanticRead(script, args)) { failedReads++; throw new Error('isolated semantic raw read failure') }
  }
  await f.host.start()
  const event = f.message(group, 'forget', through)
  await f.emit(event)
  await waitFor(() => failedReads > 0, 'semantic cleanup did not reach the physical store')
  const item = await f.inbox.next({ account, kind: 'privacy' })
  assert.ok(item); assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied')
  assert.deepEqual((await f.raw()).rows, rows)
  assert.deepEqual(f.deliveries, [])
  await f.host.stop(); delete f.hooks.beforeEval; f.rebind(); f.advance(60_000)
  const resumed = f.createHost()
  await resumed.start()
  assert.equal(await f.inbox.next({ account, kind: 'privacy' }), null)
  assert.deepEqual((await f.raw(group, 'daily')).rows, rows.slice(1), 'replay must retain sources newer than its original inclusive cutoff')
  assert.deepEqual((await f.raw(group, 'other')).rows, newerAgent)
  assert.deepEqual(f.deliveries, [], 'a replacement Agent cannot confirm the old command')
})

test('the trusted cleanup port returns a real unknown receipt after a committed fence and succeeds when retried', settings, async t => {
  const f = await fixture(t), rows = await f.seed()
  await f.host.start()
  f.hooks.beforeEval = (script, args) => { if (semanticRead(script, args)) throw new Error('physical store unavailable') }
  const input = { account, agentId: 'daily', subjectId: author.id, target: group, through: f.now }
  const uncertain = await f.host.semanticMemoryCleanup.purgeSubject(input, f.authority().value)
  assert.equal(uncertain.usage, 'blocked'); assert.equal(uncertain.cleanup, 'unknown')
  assert.deepEqual((await f.raw()).rows, rows, 'unknown must not hide physical leftovers behind filtered reads')
  assert.ok(await f.storage.get(`${PREFIX}:cleanup`), 'usage blocked needs a real durable fence')
  delete f.hooks.beforeEval
  const done = await f.host.semanticMemoryCleanup.purgeSubject(input, f.authority().value)
  assert.equal(done.cleanup, 'completed'); assert.equal(done.removedRows, 1); assert.equal(done.removedVectors, 1)
  assert.equal(await f.raw(), undefined)
})

test('console unknown physical cleanup rejects completion and a later authorized retry removes the real rows', settings, async t => {
  const f = await fixture(t), rows = await f.seed()
  await f.host.start()
  f.hooks.beforeEval = (script, args) => { if (semanticRead(script, args)) throw new Error('physical read failed') }
  await assert.rejects(f.host.management.profiles.remove(author.id, f.context().value), /语义记忆清理尚未完成/u)
  assert.deepEqual((await f.raw()).rows, rows)
  delete f.hooks.beforeEval
  assert.equal(await f.host.management.profiles.remove(author.id, f.context().value), false)
  assert.equal(await f.raw(), undefined)
})

test('emoji cleanup failure cannot prevent actual semantic row deletion in a privacy command', settings, async t => {
  const f = await fixture(t, { localEmojiCleanup: {
    async revokeSource() { throw new Error('unused') },
    async purgeSubject() { throw new Error('isolated sibling cleanup failure') },
  } })
  await f.seed(); await f.host.start(); await f.emit(f.message())
  await waitFor(async () => !await f.raw(), 'semantic deletion was blocked by a sibling failure')
  const item = await f.inbox.next({ account, kind: 'privacy' })
  assert.ok(item); assert.equal(await f.inbox.privacyCommandState(group, item.entry.event.message.messageId, item.raw), 'applied')
  assert.deepEqual(f.deliveries, [])
})

test('console denied or revoked authorization leaves raw semantic content unchanged', settings, async t => {
  for (const failure of ['denied', 'unavailable', 'request', 'binding']) await t.test(failure, async t => {
    const f = await fixture(t), rows = await f.seed()
    await f.host.start()
    const request = f.context()
    f.hooks.authorize = async () => {
      await Promise.resolve()
      if (failure === 'request') request.revoke()
      else if (failure === 'binding') f.rebind()
      else f.hooks.decision = failure
    }
    await assert.rejects(f.host.management.profiles.remove(author.id, request.value), {
      code: failure === 'denied' ? 'forbidden' : failure === 'unavailable' ? 'unavailable' : 'conflict',
    })
    assert.deepEqual((await f.raw()).rows, rows)
  })
})

test('console cancellation and rebind during the physical read cannot commit semantic deletion', settings, async t => {
  for (const failure of ['request', 'binding']) await t.test(failure, async t => {
    const f = await fixture(t), rows = await f.seed(), entered = Promise.withResolvers(), release = Promise.withResolvers()
    f.releases.push(() => release.resolve())
    await f.host.start()
    f.hooks.beforeEval = async (script, args) => { if (semanticRead(script, args)) { entered.resolve(); await release.promise } }
    const request = f.context(), pending = f.host.management.profiles.remove(author.id, request.value)
    void pending.catch(() => {})
    await entered.promise
    if (failure === 'request') request.abort(); else f.rebind()
    release.resolve()
    await assert.rejects(pending)
    assert.deepEqual((await f.raw()).rows, rows)
  })
})

test('public cleanup authority combines the host lifecycle, execution observations and the calling guard', settings, async t => {
  for (const failure of ['request', 'signal', 'host-signal', 'stop', 'execution', 'observation', 'async-authority']) await t.test(failure, async t => {
    let observe
    const f = await fixture(t, { observeExecutionCurrent(check) { observe?.(); return check() } }), rows = await f.seed()
    await f.host.start()
    const request = f.authority()
    if (failure === 'request') request.revoke()
    else if (failure === 'signal') request.abort()
    else if (failure === 'host-signal') f.abort()
    else if (failure === 'stop') await f.host.stop()
    else if (failure === 'execution') f.retire()
    else if (failure === 'observation') observe = request.revoke
    else request.value.ensureCurrent = async () => { await Promise.resolve(); request.revoke() }
    await assert.rejects(f.host.semanticMemoryCleanup.purgeSubject({ account, agentId: 'daily', subjectId: author.id, target: group, through: f.now }, request.value))
    assert.deepEqual((await f.raw()).rows, rows)
  })
})
