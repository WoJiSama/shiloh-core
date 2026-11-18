import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createAgentProfileManagement }, { createPersonMemoryStore }, { personMemoryAddress },
  { createAgentBindingDirectory, agentPersonaScopeId, conversationAddressKey }, { AgentManagementError }] = await Promise.all([
  load('modules/memory/infrastructure/agentProfileManagement.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'), load('modules/runtime/domain/agentBindings.js'), load('contracts/agentManagement.js'),
])
const settings = { timeout: 25_000 }, userId = '10001', otherUserId = '10002'
const account = { platform: 'qq', namespace: 'global', id: '19008801' }
const group = { account, kind: 'group', id: '3108801' }, otherGroup = { ...group, id: '3108802' }
const otherAgentGroup = { ...group, id: '3108803' }
const otherAccountGroup = { ...group, account: { ...account, namespace: 'other-namespace' } }
const privateRoom = { account, kind: 'private', id: userId }
const independentPrivate = { account, kind: 'private', id: 'native-private-room' }
const targets = [group, otherGroup, otherAgentGroup, otherAccountGroup, privateRoom, independentPrivate]
const clone = value => structuredClone(value)
const base = identity => `shiloh:person-memory:v1:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}`

async function fixture(t) {
  assert.equal(redisAvailable, true, 'management requires a real isolated Redis')
  const f = await createAgentRedisFixture(t, 'profile-management'), hooks = {}, accesses = [], authorizations = [], decisions = new Map()
  let clock = Date.now(), serial = 0, revision = 'management-r1', directory
  function rebuild(replace) {
    const accounts = [account, otherAccountGroup.account]
    directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
      connections: accounts.map((account, index) => ({ id: 'connection-' + index, platform: account.platform, namespace: account.namespace, accountId: account.id })),
      bindings: targets.map(target => ({ connectionId: 'connection-' + accounts.findIndex(value => value.namespace === target.account.namespace),
        kind: target.kind, conversationId: target.id, agentId: replace?.get(conversationAddressKey(target)) ?? (target === otherAgentGroup ? 'other' : 'daily') })),
    }, revision)
  }
  rebuild()
  const bindings = { list: () => directory.listBindings(), resolve: target => directory.resolve(target) }
  const redis = { async get(key) { accesses.push(['get', key]); await hooks.beforeGet?.(key); const value = await f.storage.get(key); await hooks.afterGet?.(key, value); return value },
    async eval(script, options) { accesses.push(['eval', clone(options)]); await hooks.beforeEval?.(options); return f.storage.eval(script, options) } }
  const store = createPersonMemoryStore({ redis: f.storage, now: () => clock })
  const management = createAgentProfileManagement({ redis, bindings, now: () => clock })
  const binding = target => directory.resolve(target)
  const address = target => { const { botId, scene } = personMemoryAddress(target); return {
    identity: { botId, personaId: agentPersonaScopeId(binding(target).agentId) }, scene } }
  function context(target, defaults = 'allowed') {
    let active = true
    const controller = new AbortController(), selected = target && clone(binding(target))
    const context = { ...(selected ? { binding: selected } : {}), signal: controller.signal,
      isCurrent: () => active && !controller.signal.aborted,
      ensureCurrent() { if (!context.isCurrent()) throw new AgentManagementError('conflict') },
      async authorize(operation, owner, guard) { authorizations.push({ operation, binding: clone(owner) }); guard.ensureCurrent();
        await hooks.authorize?.(operation, owner, guard)
        return decisions.get(operation + ':' + conversationAddressKey(owner.target)) ?? defaults },
    }
    return { context, revoke() { active = false }, abort() { controller.abort() } }
  }
  async function remember(target, text, extra = {}) {
    const { identity, scene } = address(target), subjectId = extra.subjectId ?? userId
    const source = { scene: clone(scene), authorId: subjectId, messageId: 'native-' + ++serial, at: clock - 1000, excerpt: text }
    const input = { identity, subjectId, category: 'fact', evidenceKind: 'self', source, text, ...extra }
    const result = await store.remember(input)
    assert.equal(result.saved, true, result.reason)
    return { input, entry: result.entry }
  }
  return { ...f, hooks, accesses, authorizations, decisions, bindings, store, management, binding, address, context, remember,
    now: () => clock,
    advance() { clock += 1000 },
    rebind(replace) { revision += '-changed'; rebuild(replace) },
    async rows(target, subjectId = userId) { const owner = address(target), scene = owner.scene.kind === 'private' ? { ...owner.scene, peerId: subjectId } : owner.scene
      return (await store.listScene({ ...owner, subjectId, viewerUserId: subjectId, scene, limit: 50 })).items },
    async snapshot() { const keys = (await f.storage.keys('*')).filter(key => key !== 'agent:host-lease').sort(); return Object.fromEntries(await Promise.all(keys.map(async key => [key, await f.storage.get(key)]))) },
  }
}

test('a binding directory may synchronously audit a profile guard with a paired parent', settings, async t => {
  const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
  const f = await fixture(t), original = await f.remember(group, 'audited source'), list = f.bindings.list
  let observer, busy = false
  const observed = []
  f.bindings.list = () => {
    if (observer && !busy) {
      busy = true
      try { observed.push(observer()) } finally { busy = false }
    }
    return list()
  }
  f.hooks.authorize = (_operation, _binding, guard) => {
    observer = () => guard.isCurrent()
    try { guard.ensureCurrent() } finally { observer = undefined }
  }
  const request = f.context(group).context, parent = { ...request, ...createSynchronousGuard(request.signal,
    request.ensureCurrent, () => { throw new AgentManagementError('conflict') }) }
  const rows = await f.management.list(parent)
  assert.deepEqual(rows.map(row => row.profile.entries[0]), [original.entry])
  assert.ok(observed.length > 0)
  assert.ok(observed.every(value => value === true))
})

test('management lists actual Core source entries with account/Agent isolation and no legacy profile ownership', settings, async t => {
  const f = await fixture(t)
  await f.storage.set('bl-chat:profile:' + userId, JSON.stringify({ name: 'unowned legacy profile', facts: ['legacy secret'] }))
  await f.storage.set('bl-chat:globalAffinity:' + userId, '99')
  await f.storage.set('person-profile:' + userId, JSON.stringify({ traits: ['unscoped'] }))
  const originals = await Promise.all(targets.slice(0, 5).map((target, index) => f.remember(target, 'source-' + index)))
  const rows = await f.management.list(f.context().context)
  assert.equal(rows.length, 5)
  for (let index = 0; index < originals.length; index++) {
    const row = rows.find(row => conversationAddressKey(row.binding.target) === conversationAddressKey(targets[index]))
    assert.deepEqual(row.binding, f.binding(targets[index])); assert.equal(row.profile.userId, userId)
    assert.deepEqual(row.profile.identity, f.address(targets[index]).identity)
    assert.deepEqual(row.profile.entries, [originals[index].entry]); assert.deepEqual(row.profile.sourceScene, originals[index].entry.source.scene)
    for (const field of ['traits', 'taboos', 'prompt', 'systemContent', 'affinity']) assert.equal(Object.hasOwn(row.profile, field), false)
  }
  assert.equal(JSON.stringify(rows).includes('legacy'), false)
  assert.equal(f.accesses.some(([kind, key]) => kind === 'get' && !key.startsWith('shiloh:person-memory:v1:')), false)
  const selected = await f.management.list(f.context(group).context)
  assert.deepEqual(selected.map(row => row.profile.entries[0].text), ['source-0'])
  const original = originals[0].entry.text; selected[0].profile.entries[0].text = 'client mutation'
  assert.equal((await f.rows(group))[0].text, original)
})

test('portable group facts stay with their actual source row and private facts never become a group profile', settings, async t => {
  const f = await fixture(t)
  const portable = await f.remember(otherGroup, 'I like astronomy', { category: 'interest', portable: true, sensitivity: 'ordinary' })
  await f.remember(privateRoom, 'private health fact', { sensitivity: 'sensitive' })
  const independent = await f.remember(independentPrivate, 'self statement in a private room with a separate ID', {
    source: { scene: { ...f.address(independentPrivate).scene, peerId: userId }, authorId: userId,
      messageId: 'real-independent-private', at: Date.now() - 1000, excerpt: 'self statement in a private room with a separate ID' },
  })
  assert.equal((await f.store.query({ ...f.address(group), subjectId: userId, viewerUserId: userId, limit: 50 })).items[0].id, portable.entry.id,
    'the ordinary Core query still supports its original portable recall')
  f.accesses.length = 0
  assert.deepEqual(await f.management.list(f.context(group).context), [])
  assert.equal(f.accesses.some(([method, key]) => method === 'get' && key.endsWith(':entry:' + portable.entry.id)), false,
    'management must filter source scenes before detail hydration')
  const rows = await f.management.list(f.context().context)
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.binding.target.id !== group.id))
  assert.deepEqual(rows.find(row => row.binding.target.id === independentPrivate.id).profile.entries, [independent.entry])
})

test('global listing omits denied rows, scoped listing rejects them and unavailable authority fails closed', settings, async t => {
  const f = await fixture(t); await f.remember(group, 'allowed scene'); await f.remember(otherAccountGroup, 'denied account')
  const denied = conversationAddressKey(otherAccountGroup)
  f.decisions.set('profiles.read:' + denied, 'denied')
  const rows = await f.management.list(f.context().context)
  assert.deepEqual(rows.map(row => row.profile.entries[0].text), ['allowed scene'])
  await assert.rejects(f.management.list(f.context(otherAccountGroup).context), { code: 'forbidden' })
  f.decisions.set('profiles.read:' + denied, 'unavailable')
  await assert.rejects(f.management.list(f.context().context), { code: 'unavailable' })
})

test('entry and category deletion write real Store tombstones and prevent old extraction across restart', settings, async t => {
  const f = await fixture(t), first = await f.remember(group, 'first interest', { category: 'interest' })
  const second = await f.remember(group, 'second interest', { category: 'interest' }), fact = await f.remember(group, 'independent fact')
  const other = await f.remember(otherGroup, 'other scene interest', { category: 'interest', portable: true, sensitivity: 'ordinary' })
  const context = f.context(group).context
  const result = await f.management.removeField(userId, 'entries', first.entry.id, context)
  assert.equal(f.accesses.filter(([method, options]) => method === 'eval' && options.arguments.some((value, index) => index % 4 === 2 && value !== 'keep')).length, 1,
    'the erase uses one atomic write CAS; return validation is read-only')
  assert.deepEqual(result.entries.map(entry => entry.id).sort(), [second.entry.id, fact.entry.id].sort())
  await f.management.removeField(userId, 'interests', undefined, context)
  assert.deepEqual((await f.rows(group)).map(entry => entry.id), [fact.entry.id])
  assert.deepEqual((await f.rows(otherGroup)).map(entry => entry.id), [other.entry.id])
  const restarted = createPersonMemoryStore({ redis: f.storage })
  for (const item of [first, second]) assert.equal((await restarted.remember(item.input)).saved, false)
  const redactions = await restarted.getRedactions({ ...f.address(group), subjectId: userId })
  assert.ok(redactions.tombstones.some(item => item.id === first.entry.id)); assert.ok(redactions.tombstones.some(item => item.id === second.entry.id))
  await assert.rejects(f.management.removeField(userId, 'traits', undefined, context), { code: 'invalid_request' })
  await assert.rejects(f.management.removeField(userId, 'taboos', undefined, context), { code: 'invalid_request' })
  await assert.rejects(f.management.removeField(userId, undefined, undefined, context), { code: 'invalid_request' })
  await assert.rejects(f.management.removeField(userId, 'entries', other.entry.id, context), { code: 'not_found' })
})

test('exact text field deletion preserves unrelated entries and records source invalidation', settings, async t => {
  const f = await fixture(t), first = await f.remember(group, 'first known fact'), second = await f.remember(group, 'second known fact')
  const result = await f.management.removeField(userId, 'facts', '  first   known fact ', f.context(group).context)
  assert.deepEqual(result.entries, [second.entry])
  assert.equal((await f.store.remember(first.input)).saved, false)
  const scope = await f.store.getSceneRedactions(f.address(group))
  assert.ok(scope.invalidatedAt > 0)
})

test('whole profile deletion is scene-scoped and cannot treat a group permission as whole-Agent authority', settings, async t => {
  const f = await fixture(t), same = await f.remember(group, 'same scene fact'), other = await f.remember(otherGroup, 'portable other scene', {
    category: 'name', portable: true, sensitivity: 'ordinary' })
  const sibling = await f.remember(otherAgentGroup, 'other Agent fact'), accountFact = await f.remember(otherAccountGroup, 'other account fact')
  const privateFact = await f.remember(privateRoom, 'private scene fact')
  await assert.rejects(f.management.remove(userId, f.context().context), { code: 'invalid_request' })
  assert.equal(await f.management.remove(userId, f.context(group).context), true)
  assert.deepEqual(await f.rows(group), [])
  for (const [target, item] of [[otherGroup, other], [otherAgentGroup, sibling], [otherAccountGroup, accountFact], [privateRoom, privateFact]]) {
    assert.deepEqual(await f.rows(target), [item.entry])
  }
  const restarted = createPersonMemoryStore({ redis: f.storage })
  assert.equal((await restarted.remember(same.input)).saved, false)
  assert.equal(await f.management.remove(userId, f.context(group).context), false)
  assert.equal(await f.management.remove(otherUserId, f.context(group).context), false)
})

test('source recall, subject/author privacy and superseded or expired facts share the actual Store visibility rules', settings, async t => {
  const f = await fixture(t), recalled = await f.remember(group, 'later recalled source')
  await f.store.revokeSource({ ...f.address(group), messageId: recalled.entry.source.messageId })
  const previous = await f.remember(group, 'old correction')
  const correction = await f.remember(group, 'current correction', { supersedes: previous.entry.id })
  await f.remember(group, 'expired source', { validUntil: f.now() - 10, source: { scene: f.address(group).scene, authorId: userId,
    messageId: 'expired-native', at: f.now() - 10_000, excerpt: 'expired source' } })
  const related = await f.remember(group, 'report about the second person', { subjectId: otherUserId, evidenceKind: 'reported',
    source: { scene: f.address(group).scene, authorId: userId, messageId: 'reported-native', at: Date.now() - 1000, excerpt: 'report about the second person' } })
  let rows = await f.management.list(f.context(group).context)
  assert.deepEqual(rows.find(row => row.profile.userId === userId).profile.entries, [correction.entry])
  assert.deepEqual(rows.find(row => row.profile.userId === otherUserId).profile.entries, [related.entry])
  await f.store.setEnabled({ ...f.address(group), subjectId: userId, enabled: false, scene: f.address(group).scene })
  assert.deepEqual(await f.management.list(f.context(group).context), [])
  assert.equal((await f.store.remember(previous.input)).saved, false)
})

test('late reads cannot reveal data after a context, binding or authorization change', settings, async t => {
  for (const change of ['context', 'binding', 'selected-subject', 'authorization', 'abort']) {
    const f = await fixture(t), original = await f.remember(group, 'private-management-content'), ctx = f.context(group)
    let triggered = false
    f.hooks.afterGet = async key => {
      if (triggered || !key.endsWith(':entry:' + original.entry.id)) return
      triggered = true
      if (change === 'context') ctx.revoke()
      else if (change === 'abort') ctx.abort()
      else if (change === 'binding') f.rebind(new Map([[conversationAddressKey(group), 'other']]))
      else if (change === 'selected-subject') ctx.context.binding = clone(f.binding(otherGroup))
      else f.decisions.set('profiles.read:' + conversationAddressKey(group), 'denied')
      await Promise.resolve()
    }
    await assert.rejects(f.management.list(ctx.context), { code: change === 'authorization' ? 'forbidden' : 'conflict' })
    assert.equal(triggered, true)
  }
})

test('a final list CAS rechecks source/subject privacy and raw source details before returning any rows', settings, async t => {
  for (const race of ['privacy', 'detail', 'directory']) {
    const f = await fixture(t), original = await f.remember(group, 'cannot leak a stale hydrated row')
    let triggered = false
    f.hooks.beforeEval = async () => {
      if (triggered) return; triggered = true
      if (race === 'privacy') await f.store.forget({ ...f.address(group), subjectId: userId, id: original.entry.id })
      else if (race === 'directory') f.rebind()
      else await f.storage.set(base(f.address(group).identity) + ':person:' + userId + ':entry:' + original.entry.id,
        JSON.stringify({ ...original.entry, text: 'concurrent replacement' }))
    }
    await assert.rejects(f.management.list(f.context(group).context), { code: 'conflict' })
    assert.equal(triggered, true)
  }
})

test('failed mutation CAS leaves every staged tombstone, source detail and other profile unchanged', settings, async t => {
  const f = await fixture(t), first = await f.remember(group, 'one selected field', { category: 'interest' })
  const second = await f.remember(group, 'another selected field', { category: 'interest' })
  const before = await f.snapshot(), key = base(f.address(group).identity) + ':scope'
  let concurrent
  f.hooks.beforeEval = async () => {
    const parsed = JSON.parse(await f.storage.get(key)); parsed.revision++; concurrent = JSON.stringify(parsed)
    await f.storage.set(key, concurrent)
  }
  await assert.rejects(f.management.removeField(userId, 'interest', undefined, f.context(group).context), { code: 'conflict' })
  const after = await f.snapshot()
  assert.deepEqual(after, { ...before, [key]: concurrent })
  assert.deepEqual((await f.rows(group)).map(entry => entry.id).sort(), [first.entry.id, second.entry.id].sort())
})

test('mutation reauthorizes while Store prepares tombstones and preserves data on context/permission loss', settings, async t => {
  for (const race of ['permission', 'context', 'binding']) {
    const f = await fixture(t); await f.remember(group, 'must remain present')
    const before = await f.snapshot(), ctx = f.context(group)
    let triggered = false
    f.hooks.afterGet = async key => {
      if (key !== 'shiloh:person-memory:v1:identities' || triggered) return
      triggered = true
      if (race === 'permission') f.decisions.set('profiles.delete:' + conversationAddressKey(group), 'denied')
      else if (race === 'context') ctx.revoke()
      else f.rebind()
      await Promise.resolve()
    }
    await assert.rejects(f.management.remove(userId, ctx.context), { code: race === 'permission' ? 'forbidden' : 'conflict' })
    assert.equal(triggered, true); assert.deepEqual(await f.snapshot(), before)
  }
})

test('no-source legacy profiles are neither exposed nor physically deleted by management', settings, async t => {
  const f = await fixture(t)
  await f.storage.set('bl-chat:profile:' + userId, JSON.stringify({ userId, name: 'Legacy name' }))
  await f.storage.set('bl-chat:globalAffinity:' + userId, JSON.stringify({ value: 100 }))
  const before = await f.snapshot()
  assert.deepEqual(await f.management.list(f.context().context), [])
  assert.equal(await f.management.remove(userId, f.context(group).context), false)
  await assert.rejects(f.management.removeField(userId, 'name', undefined, f.context(group).context), { code: 'not_found' })
  assert.deepEqual(await f.snapshot(), before)
})

test('Store source dependency tombstones suppress dependent records without changing unrelated scenes', settings, async t => {
  const f = await fixture(t), original = await f.remember(group, 'original self statement')
  await f.remember(group, 'a dependent reported fact', { subjectId: otherUserId, evidenceKind: 'reported', source: clone(original.entry.source) })
  const elsewhere = await f.remember(otherGroup, 'unrelated other-scene fact', { subjectId: otherUserId })
  await f.management.removeField(userId, 'entries', original.entry.id, f.context(group).context)
  assert.deepEqual(await f.rows(group, otherUserId), [])
  assert.deepEqual(await f.rows(otherGroup, otherUserId), [elsewhere.entry])
})

test('management rejects mismatched source indexes/details and an active person/privacy directory lock', settings, async t => {
  const f = await fixture(t), original = await f.remember(group, 'original indexed source')
  const key = base(f.address(group).identity) + ':person:' + userId + ':entry:' + original.entry.id
  await f.storage.set(key, JSON.stringify({ ...original.entry, text: 'valid but mismatched replacement' }))
  await assert.rejects(f.management.list(f.context(group).context), { code: 'unavailable' })
  await f.storage.set(key, JSON.stringify(original.entry))
  for (const lock of [base(f.address(group).identity) + ':lock', 'shiloh:person-memory:v1:identities:lock']) {
    await f.storage.set(lock, 'another-writer')
    await assert.rejects(f.management.list(f.context(group).context), { code: 'conflict' })
    await assert.rejects(f.management.remove(userId, f.context(group).context), { code: 'conflict' })
    await f.storage.del(lock)
  }
  assert.deepEqual(await f.rows(group), [original.entry])
})

test('permission revoked while final list validation awaits cannot expose its captured rows', settings, async t => {
  const f = await fixture(t); await f.remember(group, 'must not be returned after permission revocation')
  f.hooks.beforeEval = async () => { f.decisions.set('profiles.read:' + conversationAddressKey(group), 'denied'); await Promise.resolve() }
  await assert.rejects(f.management.list(f.context(group).context), { code: 'forbidden' })
})

test('field deletion cannot return remaining profile facts using write permission without read permission', settings, async t => {
  const f = await fixture(t), original = await f.remember(group, 'selected entry')
  await f.remember(group, 'remaining entry must not leak')
  const before = await f.snapshot()
  f.decisions.set('profiles.read:' + conversationAddressKey(group), 'denied')
  await assert.rejects(f.management.removeField(userId, 'entries', original.entry.id, f.context(group).context), { code: 'forbidden' })
  assert.deepEqual(await f.snapshot(), before)
})

test('actual host lease loss prevents the final managed Redis mutation', settings, async t => {
  const f = await fixture(t); await f.remember(group, 'cannot delete after lease loss')
  const before = await f.snapshot()
  await f.reader.set(f.prefix + 'agent:host-lease', 'replacement-host')
  await assert.rejects(f.management.remove(userId, f.context(group).context), { code: 'unavailable' })
  assert.deepEqual(await f.snapshot(), before)
})

test('privacy changing during final authorization cannot escape the terminal raw-version check', settings, async t => {
  const f = await fixture(t), original = await f.remember(group, 'read before a late privacy change')
  let compared = false, revoked = false
  f.hooks.beforeEval = async () => { compared = true }
  f.hooks.authorize = async () => {
    if (!compared || revoked) return
    revoked = true
    await f.store.forget({ ...f.address(group), subjectId: userId, id: original.entry.id })
  }
  await assert.rejects(f.management.list(f.context(group).context), { code: 'conflict' })
  assert.equal(revoked, true)
})

test('long complete platform addresses keep their real binding IDs and account-derived identity', settings, async t => {
  const f = await fixture(t), account = { platform: 'fixture', namespace: 'n'.repeat(128), id: 'a'.repeat(128) }
  const target = { account, kind: 'group', id: 'r'.repeat(128) }
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'main', kind: target.kind, conversationId: target.id, agentId: 'daily' }],
  }, 'long-source-revision')
  const binding = directory.resolve(target), { botId, scene } = personMemoryAddress(target), identity = { botId, personaId: agentPersonaScopeId(binding.agentId) }
  assert.ok(binding.id.length > 128)
  const saved = await f.store.remember({ identity, subjectId: userId, text: 'scoped long-address fact', category: 'fact', evidenceKind: 'self',
    source: { scene, authorId: userId, messageId: 'long-address-native', at: Date.now() - 1000, excerpt: 'scoped long-address fact' } })
  assert.equal(saved.saved, true)
  const management = createAgentProfileManagement({ redis: f.storage, bindings: { list: () => directory.listBindings(), resolve: target => directory.resolve(target) } })
  const context = { binding, signal: new AbortController().signal, isCurrent: () => true, ensureCurrent() {}, authorize: async () => 'allowed' }
  const rows = await management.list(context)
  assert.deepEqual(rows[0].binding, binding); assert.deepEqual(rows[0].profile.identity, identity); assert.deepEqual(rows[0].profile.entries, [saved.entry])
})
