import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createAgentBindingDirectory, agentPersonaScopeId },
  { createAgentInbox }, { createPersonMemoryStore }, { personMemoryAddress },
  { personMemoryCommandText: commands }, { AgentManagementError }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/runtime/infrastructure/agentInbox.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/memory/domain/personMemoryCommands.js'),
  load('contracts/agentManagement.js'),
])
const settings = { timeout: 20_000 }, logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'qq', namespace: 'global', id: '19007701' }
const secondAccount = { ...account, id: '19007702' }, author = { ...account, id: '17007701' }
const group = { account, kind: 'group', id: '31007701' }
const friend = { account, kind: 'private', id: author.id }
const secondGroup = { ...group, account: secondAccount }
const completed = { usage: 'blocked', cleanup: 'completed', removedSources: 0, removedImages: 0, unattributedImages: 0 }

async function waitFor(probe, description) {
  const until = performance.now() + 5000
  while (performance.now() < until) { if (await probe()) return; await delay(5) }
  assert.fail(description)
}

async function fixture(t, overrides = {}) {
  assert.equal(redisAvailable, true, 'Core emoji cleanup integration requires isolated Redis')
  const hosts = []
  t.after(async () => { for (const host of hosts) await host.stop() })
  const redis = await createAgentRedisFixture(t, 'core-emoji-cleanup')
  const inbox = createAgentInbox(redis.storage), handlers = [], deliveries = [], cleanups = [], hooks = {}
  const lifetime = new AbortController()
  let now = Date.now(), serial = 0, revision = 0, owner = 'daily', bound = true, directory
  function rebuild() {
    directory = createAgentBindingDirectory({ version: 1,
      agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
      connections: [account, secondAccount].map((item, index) => ({ id: `qq-${index}`, platform: item.platform, namespace: item.namespace, accountId: item.id })),
      bindings: bound ? [group, friend, secondGroup].map(target => ({ connectionId: target.account.id === account.id ? 'qq-0' : 'qq-1',
        kind: target.kind, conversationId: target.id, agentId: owner })) : [],
    }, `cleanup-${++revision}`)
  }
  rebuild()
  const bindings = { list: () => directory.listBindings(), resolve: target => directory.resolve(target) }
  const adapters = [account, secondAccount].map((item, index) => ({ id: `qq-${index}`, account: item, botUserId: item.id,
    resolvePrivatePeer: () => author, isReady: () => !!handlers[index],
    start(handler) { handlers[index] = handler }, stop() { handlers[index] = undefined },
    actions: { async send(action, guard) {
      assert.equal(guard.isCurrent(), true); deliveries.push(action)
      return { state: 'sent', messageId: `9900${deliveries.length}` }
    } },
  }))
  const localEmojiCleanup = {
    async revokeSource(source, guard) { await guard.ensureCurrent(); cleanups.push({ kind: 'recall', source, guard }); return completed },
    async purgeSubject(source, guard) { await guard.ensureCurrent(); cleanups.push({ kind: 'privacy', source, guard }); return completed },
  }
  const options = { storage: redis.storage, adapters, logger, now: () => now, signal: lifetime.signal,
    isExecutionCurrent: redis.isCurrent, managementBindings: bindings, privateChatEnabled: true,
    getSection: () => ({ enabled: true, allGroups: true, rhythm: { enabled: false }, reflection: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
    getExecutionConfig: () => ({ useTools: false }),
    resolvePersona(target) {
      const binding = bindings.resolve(target)
      return binding && { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '隔离角色' }, systemContent: '' }
    },
    YTapi: async () => assert.fail('cleanup integration must not call a model'),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false },
    groupMemory: { enabled: false }, groupLog: { enabled: false },
    isLocalEmojiCurrent: () => false, autoCollectLocalEmoji: false, localEmojiCleanup, ...overrides,
  }
  function createHost(extra = {}) { const host = createAgentRuntime({ ...options, ...extra }); hosts.push(host); return host }
  const host = createHost(), memory = createPersonMemoryStore({ redis: redis.storage, now: () => now })
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
  function message(target, command, occurredAt = now) {
    const text = commands[command]
    return { kind: 'message', message: { version: 1, conversation: target, messageId: `7700${++serial}`,
      sender: author, occurredAt, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false } }
  }
  async function remember(target, text) {
    const { botId, scene } = personMemoryAddress(target)
    const result = await memory.remember({ identity: { botId, personaId: agentPersonaScopeId(bindings.resolve(target).agentId) },
      subjectId: author.id, category: 'fact', evidenceKind: 'self', text,
      source: { scene, authorId: author.id, messageId: `native-${++serial}`, at: now - 1000, excerpt: text } })
    assert.equal(result.saved, true, result.reason)
    return result.entry
  }
  return { ...redis, host, createHost, inbox, bindings, deliveries, cleanups, hooks, context, message, remember,
    emit: (event, index = 0) => handlers[index](event), get now() { return now }, advance(ms) { now += ms },
    rebind(agentId = 'other') { owner = agentId; rebuild() }, unbind() { bound = false; rebuild() }, abort() { lifetime.abort() } }
}

test('recall cleanup keeps the full account and source address after unbinding, even with emoji disabled', settings, async t => {
  const f = await fixture(t); await f.host.start(); f.unbind()
  for (const [index, target] of [group, friend, secondGroup].entries()) {
    const event = { kind: 'recall', target, messageId: `recall-${index}` }
    await f.emit(event, target.account.id === account.id ? 0 : 1)
    assert.deepEqual(f.cleanups[index].source, { target, messageId: event.messageId })
    assert.equal(f.cleanups[index].guard.isCurrent(), true)
  }
  await f.emit({ kind: 'recall', target: secondGroup, messageId: 'foreign-adapter' })
  assert.equal(f.cleanups.length, 3, 'an event from the wrong receiving account must not gain cleanup authority')
  const guard = f.cleanups[0].guard
  await f.host.stop()
  assert.equal(guard.signal.aborted, true); assert.equal(guard.isCurrent(), false)
  await assert.rejects(guard.ensureCurrent())
})

for (const failure of ['unknown', 'throw']) {
  test(`recall ${failure} reaches its caller while independent inbox revocation still completes`, settings, async t => {
    const f = await fixture(t, { localEmojiCleanup: {
      async revokeSource(_source, guard) {
        await guard.ensureCurrent()
        if (failure === 'throw') throw new Error('isolated cleanup failure')
        return { ...completed, cleanup: 'unknown' }
      }, async purgeSubject() { return completed },
    } })
    await f.host.start()
    const messageId = `recall-${failure}`
    await assert.rejects(f.emit({ kind: 'recall', target: group, messageId }), /清理尚未完成|isolated cleanup failure/u)
    assert.equal(await f.inbox.isRecalled(group, messageId), true)
  })
}

test('privacy commands purge only after durable application using the source cutoff and trusted group or private scope', settings, async t => {
  const applied = [], calls = []
  let f
  f = await fixture(t, { localEmojiCleanup: {
    async revokeSource() { return completed },
    async purgeSubject(source, guard) {
      await guard.ensureCurrent()
      const item = await f.inbox.next({ account, kind: 'privacy' })
      applied.push(await f.inbox.privacyCommandState(item.entry.event.message.conversation, item.entry.event.message.messageId, item.raw))
      calls.push(source); return completed
    },
  } })
  await f.host.start()
  for (const [target, command] of [[group, 'forget'], [group, 'disable'], [friend, 'forget'], [friend, 'disable'], [friend, 'enable']]) {
    const event = f.message(target, command, f.now - 25), count = f.deliveries.length
    await f.emit(event)
    await waitFor(async () => f.deliveries.length === count + 1 && !await f.inbox.next({ account, kind: 'privacy' }), 'privacy command did not finish')
  }
  assert.deepEqual(applied, ['applied', 'applied', 'applied', 'applied'])
  assert.deepEqual(calls, [group, group, friend, friend].map(target => ({
    account, agentId: 'daily', subjectId: author.id, through: f.now - 25,
    ...(target.kind === 'group' ? { target } : {}),
  })))
  assert.equal(f.deliveries.some(action => action.parts.some(part => part.kind === 'text' && part.text.includes('清理归属仍待核对'))), false)
})

test('unsupported legacy emoji cleanup releases the privacy queue with a precise confirmation and no warning on enable', settings, async t => {
  const calls = [], limitation = '缺少原始来源的旧表情已停用，清理归属仍待核对。'
  const f = await fixture(t, { localEmojiCleanup: {
    async revokeSource() { return completed },
    async purgeSubject(source, guard) {
      await guard.ensureCurrent(); calls.push(source)
      return { ...completed, cleanup: 'unsupported', unattributedImages: 1 }
    },
  } })
  await f.host.start()
  for (const [target, command] of [[group, 'forget'], [group, 'disable'], [friend, 'forget'], [friend, 'disable'], [friend, 'enable']]) {
    const event = f.message(target, command), count = f.deliveries.length
    await f.emit(event)
    await waitFor(async () => f.deliveries.length === count + 1 && !await f.inbox.next({ account, kind: 'privacy' }), 'unsupported cleanup blocked a privacy command')
    const text = f.deliveries.at(-1).parts.filter(part => part.kind === 'text').map(part => part.text).join('')
    assert.equal(text.endsWith(limitation), command !== 'enable')
  }
  assert.equal(calls.length, 4)
})

test('unsupported legacy emoji cleanup does not block trusted recall or whole-profile removal', settings, async t => {
  const calls = []
  const cleanup = async (source, guard) => {
    await guard.ensureCurrent(); calls.push(source)
    return { ...completed, cleanup: 'unsupported', unattributedImages: 1 }
  }
  const f = await fixture(t, { localEmojiCleanup: { revokeSource: cleanup, purgeSubject: cleanup } })
  await f.host.start()
  await f.emit({ kind: 'recall', target: group, messageId: 'legacy-recall' })
  assert.equal(await f.inbox.isRecalled(group, 'legacy-recall'), true)
  await waitFor(async () => !await f.inbox.next({ account, kind: 'simulation' }), 'recall did not finish its independent memory cleanup')
  assert.equal(await f.host.management.profiles.remove(author.id, f.context().value), false)
  assert.deepEqual(calls, [{ target: group, messageId: 'legacy-recall' },
    { account, agentId: 'daily', subjectId: author.id, target: group, through: f.now }])
})

test('unknown privacy cleanup survives command recall and resumes its original owner and cutoff after restart and rebind', settings, async t => {
  const firstCalls = [], resumedCalls = []
  const f = await fixture(t, { localEmojiCleanup: {
    async revokeSource() { return completed },
    async purgeSubject(source, guard) { await guard.ensureCurrent(); firstCalls.push(source); return { ...completed, cleanup: 'unknown' } },
  } })
  await f.host.start()
  const event = f.message(group, 'forget', f.now - 25)
  await f.emit(event)
  await waitFor(() => firstCalls.length > 0, 'initial privacy cleanup did not run')
  const item = await f.inbox.next({ account, kind: 'privacy' })
  assert.ok(item); assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied')
  assert.deepEqual(f.deliveries, [])
  await f.emit({ kind: 'recall', target: group, messageId: event.message.messageId })
  assert.equal(await f.inbox.isRecalled(group, event.message.messageId), true)
  assert.equal(await f.inbox.privacyCommandState(group, event.message.messageId, item.raw), 'applied')
  await f.host.stop(); f.rebind(); f.advance(60_000)
  const resumed = f.createHost({ localEmojiCleanup: {
    async revokeSource() { return completed },
    async purgeSubject(source, guard) { await guard.ensureCurrent(); resumedCalls.push(source); return completed },
  } })
  await resumed.start()
  assert.equal(await f.inbox.next({ account, kind: 'privacy' }), null)
  assert.equal(resumedCalls.length, 1)
  assert.deepEqual(resumedCalls[0], { account, agentId: 'daily', subjectId: author.id, target: group, through: event.message.occurredAt })
  assert.deepEqual(f.deliveries, [], 'the new Agent must not confirm the original owner command')
})

test('console whole-person deletion purges the selected scene even without a profile; field deletion preserves emoji', settings, async t => {
  const f = await fixture(t); await f.host.start()
  for (const target of [group, friend]) {
    assert.equal(await f.host.management.profiles.remove(author.id, f.context(target).value), false)
    assert.deepEqual(f.cleanups.at(-1).source, { account, agentId: 'daily', subjectId: author.id, target, through: f.now })
  }
  const entry = await f.remember(group, '保留同人的其他来源')
  const remaining = await f.host.management.profiles.removeField(author.id, 'entries', entry.id, f.context().value)
  assert.deepEqual(remaining.entries, [])
  assert.equal(f.cleanups.length, 2)
})

test('console denied, revoked, and rebound authorization never dispatches cleanup', settings, async t => {
  for (const failure of ['denied', 'unavailable', 'request', 'binding']) await t.test(failure, async t => {
    const f = await fixture(t); await f.host.start()
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
    assert.deepEqual(f.cleanups, [])
  })
})

test('an in-flight console cleanup loses its authority on request cancellation or rebind', settings, async t => {
  for (const failure of ['request', 'binding']) await t.test(failure, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(() => release.resolve())
    const f = await fixture(t, { localEmojiCleanup: {
      async revokeSource() { return completed },
      async purgeSubject(_source, guard) { await guard.ensureCurrent(); entered.resolve(guard); await release.promise; return completed },
    } })
    await f.host.start()
    const request = f.context(), pending = f.host.management.profiles.remove(author.id, request.value)
    void pending.catch(() => {})
    const guard = await entered.promise
    if (failure === 'request') request.abort(); else f.rebind()
    assert.equal(guard.isCurrent(), false)
    if (failure === 'request') assert.equal(guard.signal.aborted, true)
    await assert.rejects(guard.ensureCurrent())
    release.resolve()
    await assert.rejects(pending)
  })
})

test('console unknown cleanup is reported as incomplete and remains retryable', settings, async t => {
  let attempts = 0
  const f = await fixture(t, { localEmojiCleanup: {
    async revokeSource() { return completed },
    async purgeSubject(_source, guard) { await guard.ensureCurrent(); return { ...completed, cleanup: ++attempts === 1 ? 'unknown' : 'completed' } },
  } })
  await f.host.start()
  await assert.rejects(f.host.management.profiles.remove(author.id, f.context().value), /清理尚未完成/u)
  assert.equal(await f.host.management.profiles.remove(author.id, f.context().value), false)
  assert.equal(attempts, 2)
})
