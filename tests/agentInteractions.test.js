import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
const { validateAgentInteraction, validateAgentInteractionPlan, validateAgentInteractionAction, normalizeInteractionReceipt, normalizeAgentInteractionResult, createAgentInteractionWorkflow } = await importBilibiliHost('modules/tools/infrastructure/agentInteractions.js')
const account = { platform: 'fixture', namespace: 'interactions', id: 'robot' }, target = { account, kind: 'group', id: 'room' }
const binding = () => ({ source: 'configured', id: 'bound-room', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'connection', target: structuredClone(target) })
const user = (id = 'human') => ({ ...account, id }), poke = (id = 'human') => ({ kind: 'poke', user: user(id) })
const plan = (operations = [poke(), poke()]) => ({ version: 1, kind: operations[0].kind, operations })
const action = () => ({ version: 1, kind: 'conversation.interact', target: structuredClone(target), binding: binding(), interaction: poke() })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function proxy(value, touch) { return new Proxy(value, { get() { touch(); throw Error('SECRET_PROXY') }, getPrototypeOf() { touch(); throw Error('SECRET_PROXY') }, ownKeys() { touch(); throw Error('SECRET_PROXY') }, getOwnPropertyDescriptor() { touch(); throw Error('SECRET_PROXY') } }) }

test('interaction validators own immutable closed actions and enforce namespace, family and exact operation budgets', () => {
  const input = action(), owned = validateAgentInteractionAction(input)
  input.target.id = 'changed'; input.binding.revision = 'changed'; input.interaction.user.id = 'changed'
  assert.equal(owned.target.id, 'room'); assert.equal(owned.binding.revision, 'one'); assert.equal(owned.interaction.user.id, 'human')
  for (const value of [owned, owned.target, owned.target.account, owned.binding, owned.binding.target, owned.interaction, owned.interaction.user]) assert.ok(Object.isFrozen(value))
  const operations = Array.from({ length: 20 }, (_, index) => Array.from({ length: 5 }, () => poke('member-' + index))).flat()
  assert.equal(validateAgentInteractionPlan(plan(operations), account).operations.length, 100)
  assert.throws(() => validateAgentInteractionPlan(plan([...operations, poke('extra')]), account))
  assert.throws(() => validateAgentInteractionPlan(plan(Array.from({ length: 11 }, () => poke())), account))
  assert.throws(() => validateAgentInteractionPlan(plan(Array.from({ length: 21 }, (_, index) => poke('member-' + index))), account))
  assert.throws(() => validateAgentInteractionPlan(plan([poke(), { kind: 'profile-like', user: user(), count: 1 }]), account))
  assert.throws(() => validateAgentInteractionPlan({ version: 1, kind: 'profile-like', operations: Array.from({ length: 2 }, () => ({ kind: 'profile-like', user: user(), count: 1 })) }, account))
  const reaction = { kind: 'message-reaction', messageId: 'source-1', emojiId: '128563' }
  assert.equal(validateAgentInteractionPlan(plan(Array.from({ length: 20 }, () => reaction)), account).operations.length, 20)
  assert.throws(() => validateAgentInteractionPlan(plan(Array.from({ length: 21 }, () => reaction)), account))
  for (const invalid of [{ ...poke(), user: { ...user(), namespace: 'foreign' } }, { kind: 'profile-like', user: user(), count: 0 }, { kind: 'profile-like', user: user(), count: 21 },
    { ...poke(), user: { ...user(), platform: 'wrong' } }, { ...poke(), count: undefined }, { ...reaction, emojiId: '501' }, { ...reaction, emojiId: '0127801' }, { ...reaction, messageId: '0' }, { ...reaction, native: true }]) assert.throws(() => validateAgentInteraction(invalid, account))
  for (const invalid of [{ ...action(), native: true }, { ...action(), binding: { ...binding(), target: { ...target, id: 'foreign' } } }, { ...action(), target: { ...target, kind: 'private' } }]) assert.throws(() => validateAgentInteractionAction(invalid))
})

test('interaction validators and receipt decoding reject accessors, proxies, sparse arrays and fake message receipts without behavior', () => {
  let touched = 0; const touch = () => { touched++ }, getter = { ...poke() }
  Object.defineProperty(getter, 'user', { get() { touch(); return user() } })
  for (const value of [getter, proxy(poke(), touch), { ...poke(), user: proxy(user(), touch) }, { ...poke(), user: Object.defineProperty(user(), 'id', { get() { touch(); return 'human' } }) }]) assert.throws(() => validateAgentInteraction(value, account))
  for (const values of [[, poke()], Object.assign([poke()], { secret: true }), proxy([poke()], touch), Object.defineProperty([poke()], '0', { get() { touch(); return poke() } })]) assert.throws(() => validateAgentInteractionPlan({ version: 1, kind: 'poke', operations: values }, account))
  for (const value of [{ state: 'confirmed', messageId: 'forged' }, { status: 'ok', retcode: 0 }, { state: 'sent', messageId: 'fake' }, proxy({ state: 'confirmed' }, touch), { get state() { touch(); return 'confirmed' } }, { state: 'failed', code: 'secret\nline' }]) assert.deepEqual(normalizeInteractionReceipt(value), { state: 'unknown' })
  assert.deepEqual(normalizeInteractionReceipt({ state: 'confirmed' }), { state: 'confirmed' })
  assert.deepEqual(normalizeInteractionReceipt({ state: 'failed', code: 'native_rejected' }), { state: 'failed', code: 'native_rejected' })
  assert.equal(touched, 0)
})

test('recall is one closed operation and private actions allow only same-namespace likes or a message recall', () => {
  const recall = { kind: 'message-recall', messageId: 'sent-42' }, selected = validateAgentInteraction(recall, account)
  recall.messageId = 'changed'; assert.deepEqual(selected, { kind: 'message-recall', messageId: 'sent-42' }); assert.ok(Object.isFrozen(selected))
  assert.equal(validateAgentInteractionPlan(plan([selected]), account).operations.length, 1)
  assert.throws(() => validateAgentInteractionPlan(plan([selected, selected]), account))
  for (const value of [{ ...selected, emojiId: '1' }, { ...selected, user: undefined }, { ...selected, count: 1 }, { kind: 'message-recall', messageId: '0' }]) assert.throws(() => validateAgentInteraction(value, account))
  const privateTarget = { account, kind: 'private', id: 'human' }
  const privateAction = interaction => ({ ...action(), target: privateTarget, binding: { ...binding(), target: privateTarget }, interaction })
  assert.equal(validateAgentInteractionAction(privateAction(selected)).interaction.kind, 'message-recall')
  assert.equal(validateAgentInteractionAction(privateAction({ kind: 'profile-like', user: user(), count: 10 })).interaction.kind, 'profile-like')
  const opaque = { account, kind: 'private', id: 'opaque-conversation' }
  assert.equal(validateAgentInteractionAction({ ...privateAction({ kind: 'profile-like', user: user(), count: 10 }), target: opaque,
    binding: { ...binding(), target: opaque } }).interaction.user.id, 'human')
  for (const value of [poke(), { kind: 'profile-like', user: { ...user(), namespace: 'foreign' }, count: 10 },
    { kind: 'message-reaction', messageId: 'sent-42', emojiId: '1' }]) assert.throws(() => validateAgentInteractionAction(privateAction(value)))
  assert.equal(validateAgentInteractionAction({ ...action(), interaction: selected }).interaction.kind, 'message-recall')
})

test('interaction results are descriptor-only, exact-budgeted and whitelist static codes', () => {
  assert.deepEqual(normalizeAgentInteractionResult({ state: 'confirmed', completed: 2, requested: 2 }, 2), { state: 'confirmed', completed: 2, requested: 2 })
  assert.deepEqual(normalizeAgentInteractionResult({ state: 'failed', completed: 1, requested: 2, code: 'interaction_rejected' }, 2),
    { state: 'failed', completed: 1, requested: 2, code: 'interaction_rejected' })
  assert.deepEqual(normalizeAgentInteractionResult({ state: 'unknown', completed: 1, requested: 2 }, 2), { state: 'unknown', completed: 1, requested: 2 })
  let touched = 0
  const values = [proxy({ state: 'confirmed', completed: 1, requested: 2 }, () => touched++),
    { get state() { touched++; return 'confirmed' } }, { state: 'confirmed', completed: 1, requested: 2 },
    { state: 'confirmed', completed: 2, requested: 1 }, { state: 'unknown', completed: 3, requested: 2 },
    { state: 'failed', completed: 0, requested: 2, code: 'native_private_detail' },
    { state: 'failed', completed: 0, requested: 2, extra: true }]
  for (const value of values) assert.deepEqual(normalizeAgentInteractionResult(value, 2),
    { state: 'unknown', completed: 0, requested: 2, code: 'interaction_invalid_result' })
  assert.equal(touched, 0)
})

test('group management actions retain only neutral values, immutable requester proof and strict family budgets', () => {
  const mute = id => ({ kind: 'member-mute', user: user(id), seconds: 300, requester: user('requester') })
  const input = mute('one'), selected = validateAgentInteraction(input, account)
  input.requester.id = 'forged'; input.user.id = 'changed'
  assert.equal(selected.requester.id, 'requester'); assert.equal(selected.user.id, 'one')
  assert.ok(Object.isFrozen(selected.requester)); assert.ok(Object.isFrozen(selected.user))
  assert.equal(validateAgentInteractionPlan(plan(Array.from({ length: 20 }, (_, i) => mute('member-' + i))), account).operations.length, 20)
  for (const operations of [Array.from({ length: 21 }, (_, i) => mute('member-' + i)), [mute('same'), mute('same')],
    [mute('one'), { ...mute('two'), requester: user('other') }]]) assert.throws(() => validateAgentInteractionPlan(plan(operations), account))
  const group = { kind: 'group-mute', enabled: true, requester: user('requester') }
  const card = { kind: 'member-card', user: user('one'), name: '新名片😀', requester: user('requester') }
  for (const operation of [mute('one'), { ...mute('one'), seconds: 0 }, { ...mute('one'), seconds: 2592000 }, group, { ...group, enabled: false }, card,
    { ...card, name: '' }, { ...card, name: '😀'.repeat(60) }]) {
    assert.deepEqual(validateAgentInteraction(operation, account), operation)
    assert.equal(validateAgentInteractionAction({ ...action(), interaction: operation }).interaction.kind, operation.kind)
    const privateTarget = { ...target, kind: 'private' }
    assert.throws(() => validateAgentInteractionAction({ ...action(), target: privateTarget, binding: { ...binding(), target: privateTarget }, interaction: operation }))
  }
  for (const operation of [group, card]) assert.throws(() => validateAgentInteractionPlan(plan([operation, operation]), account))
  for (const invalid of [{ ...mute('one'), seconds: -1 }, { ...mute('one'), seconds: 2592001 }, { ...mute('one'), seconds: 1.5 },
    { ...mute('one'), seconds: NaN }, { ...mute('one'), seconds: '60' }, { ...mute('one'), requester: { ...user('requester'), namespace: 'foreign' } },
    { ...mute('one'), requester: undefined }, { ...group, enabled: 1 }, { ...group, user: user('one') },
    { ...card, name: '😀'.repeat(61) }, { ...card, name: 'x\n' }, { ...card, name: '\u0085' }, { ...card, name: '\ud800' }, { ...card, name: '\udfff' },
    { ...card, role: 'owner' }, { ...card, seconds: undefined }]) assert.throws(() => validateAgentInteraction(invalid, account))
  let touched = 0
  for (const invalid of [{ ...mute('one'), get requester() { touched++; return user('requester') } },
    { ...card, get name() { touched++; return 'new' } }, { ...group, requester: proxy(user('requester'), () => touched++) }]) assert.throws(() => validateAgentInteraction(invalid, account))
  assert.equal(touched, 0)
})

const redisTest = { skip: !redisAvailable, timeout: 12_000 }
async function fixture(t, overrides = {}) {
  const redis = await createAgentRedisFixture(t, 'interaction-workflow'), events = [], calls = []
  const diagnostics = { emit(value) { events.push(value) } }
  const workflow = createAgentInteractionWorkflow(redis.storage, { diagnostics, ...overrides })
  const input = { binding: binding(), identity: 'SECRET_REQUEST_ID', plan: plan(), signal: new AbortController().signal,
    isCurrent: () => true, async ensureCurrent() {}, async validateOperation() { return true }, async dispatch(action, guard) {
      assert.equal(guard.isCurrent(), true); await guard.ensureCurrent(); calls.push(action); return { state: 'confirmed' }
    } }
  return { ...redis, events, calls, workflow, input, restart: () => createAgentInteractionWorkflow(redis.storage, { diagnostics, ...overrides }),
    async records() { const rows = []; for (const key of await redis.reader.keys(redis.prefix + 'agent:interaction:v1:*')) rows.push([key, await redis.reader.get(key)]); return rows } }
}
test('workflow confirms every operation serially, persists only hashed ownership/state, and never repeats after recreation', redisTest, async t => {
  const f = await fixture(t); let checks = 0, validations = 0
  f.input.ensureCurrent = async () => { checks++ }; f.input.validateOperation = async () => { validations++; return true }
  assert.deepEqual(await f.workflow.execute(f.input), { state: 'confirmed', completed: 2, requested: 2 })
  assert.equal(f.calls.length, 2); assert.ok(checks >= 4); assert.ok(validations >= 4)
  const again = await f.restart().execute(f.input); assert.deepEqual(again, { state: 'failed', completed: 0, requested: 2, code: 'interaction_already_confirmed' }); assert.equal(f.calls.length, 2)
  const rows = await f.records(); assert.equal(rows.length, 1)
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_REQUEST_ID|human|robot|room|operations|binding|namespace/u)
  const saved = JSON.parse(rows[0][1]); assert.deepEqual(Object.keys(saved).sort(), ['completed', 'planHash', 'requested', 'state', 'tokenHash', 'version'])
  assert.ok(await f.reader.ttl(rows[0][0]) >= 604790)
})
test('private peer likes and recalls use durable claims while unsupported private effects fail before claim', redisTest, async t => {
  const f = await fixture(t), privateTarget = { account, kind: 'private', id: 'human' }, selected = { ...binding(), target: privateTarget }
  const invalid = await f.workflow.execute({ ...f.input, binding: selected })
  assert.equal(invalid.state, 'failed'); assert.equal(f.calls.length, 0); assert.deepEqual(await f.records(), [])
  for (const operation of [{ kind: 'profile-like', user: user(), count: 10 }, { kind: 'message-recall', messageId: 'sent-42' }]) {
    const input = { ...f.input, binding: selected, plan: plan([operation]) }
    assert.equal((await f.workflow.execute(input)).state, 'confirmed')
    const before = f.calls.length, replay = await f.restart().execute(input)
    assert.equal(replay.state, 'failed'); assert.equal(replay.completed, 0); assert.equal(f.calls.length, before)
  }
  assert.deepEqual(f.calls.map(value => value.interaction.kind), ['profile-like', 'message-recall'])
})
test('complete binding, source identity and interaction family isolate durable claims while altered plans cannot evade one identity', redisTest, async t => {
  const f = await fixture(t); await f.workflow.execute(f.input)
  for (const field of ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId']) {
    const selected = { ...f.input.binding, [field]: field === 'source' ? 'legacy' : 'other-' + field }
    assert.equal((await f.workflow.execute({ ...f.input, binding: selected })).state, 'confirmed')
  }
  for (const target of [{ ...f.input.binding.target, id: 'other-room' }, { ...f.input.binding.target, account: { ...account, id: 'other-account' } },
    { ...f.input.binding.target, account: { ...account, namespace: 'foreign' } }]) {
    const changedPlan = plan([{ kind: 'poke', user: { ...target.account, id: 'human' } }])
    assert.equal((await f.workflow.execute({ ...f.input, binding: { ...binding(), target }, plan: changedPlan })).state, 'confirmed')
  }
  assert.equal((await f.workflow.execute({ ...f.input, identity: 'another-source' })).state, 'confirmed')
  assert.equal((await f.workflow.execute({ ...f.input, plan: { version: 1, kind: 'profile-like', operations: [{ kind: 'profile-like', user: user(), count: 20 }] } })).state, 'confirmed')
  const before = f.calls.length
  assert.deepEqual(await f.workflow.execute({ ...f.input, plan: plan([poke('another-person')]) }), { state: 'failed', completed: 0, requested: 1, code: 'interaction_claim_conflict' })
  assert.equal(f.calls.length, before)
})
for (const terminal of ['failed', 'unknown', 'throw']) test(`workflow preserves actual partial confirmation and fences ${terminal} plans across recreation`, redisTest, async t => {
  const f = await fixture(t); let count = 0
  f.input.plan = plan([poke(), poke(), poke()])
  f.input.dispatch = async () => { count++; if (count === 1) return { state: 'confirmed' }; if (terminal === 'throw') throw Error('SECRET_PROVIDER_URL'); return { state: terminal } }
  const result = await f.workflow.execute(f.input)
  assert.equal(result.state, terminal === 'failed' ? 'failed' : 'unknown'); assert.equal(result.completed, 1); assert.equal(result.requested, 3); assert.equal(count, 2)
  const duplicate = await f.restart().execute(f.input)
  assert.equal(duplicate.state, result.state); assert.equal(duplicate.completed, 0); assert.equal(duplicate.requested, 3); assert.equal(count, 2)
  assert.ok(f.events.some(event => event.outcome === result.state)); assert.doesNotMatch(JSON.stringify(f.events), /SECRET_PROVIDER_URL/u)
})
test('a live pending claim is unknown to a second workflow and a later success never grants another dispatch', redisTest, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred()
  f.input.dispatch = async () => { entered.resolve(); return finish.promise }
  const first = f.workflow.execute(f.input); await entered.promise
  assert.deepEqual(await f.restart().execute(f.input), { state: 'unknown', completed: 0, requested: 2, code: 'interaction_already_unknown' })
  assert.deepEqual(await f.restart().execute({ ...f.input, plan: plan([poke('changed')]) }), { state: 'unknown', completed: 0, requested: 1, code: 'interaction_claim_conflict' })
  finish.resolve({ state: 'unknown' }); assert.equal((await first).state, 'unknown')
  assert.equal((await f.restart().execute(f.input)).state, 'unknown')
})
test('fresh authorization and validation are repeated for every operation and stop a partially confirmed plan', redisTest, async t => {
  const f = await fixture(t); let valid = true, checks = 0
  f.input.validateOperation = async () => { checks++; return valid }
  f.input.dispatch = async () => { f.calls.push(1); valid = false; return { state: 'confirmed' } }
  const result = await f.workflow.execute(f.input)
  assert.equal(result.state, 'failed'); assert.equal(result.completed, 1); assert.equal(f.calls.length, 1); assert.equal(checks, 2)
})
for (const phase of ['authorization', 'validation', 'dispatch']) test(`workflow cancellation during ${phase} is bounded and does not publish late operations`, redisTest, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController(); let calls = 0
  f.input.signal = controller.signal
  if (phase === 'authorization') f.input.ensureCurrent = async () => { entered.resolve(); await release.promise }
  if (phase === 'validation') f.input.validateOperation = async () => { entered.resolve(); await release.promise; return true }
  f.input.dispatch = async () => { calls++; entered.resolve(); await release.promise; return { state: 'confirmed' } }
  const pending = f.workflow.execute(f.input); await entered.promise; controller.abort()
  const result = await Promise.race([pending, delay(500).then(() => 'timed-out')])
  assert.notEqual(result, 'timed-out'); assert.equal(result.state, phase === 'dispatch' ? 'unknown' : 'failed'); assert.equal(result.completed, 0)
  release.resolve(); await delay(5); assert.equal(calls, phase === 'dispatch' ? 1 : 0)
})
test('currentness revocation bounds a hung authorization without caller abort', redisTest, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let current = true
  f.input.isCurrent = () => current
  f.input.ensureCurrent = async () => { entered.resolve(); await release.promise }
  const pending = f.workflow.execute(f.input); await entered.promise; current = false
  const result = await Promise.race([pending, delay(500).then(() => 'timed-out')])
  assert.notEqual(result, 'timed-out'); assert.equal(result.state, 'failed'); assert.equal(result.completed, 0); assert.equal(f.calls.length, 0)
  release.resolve(); await delay(5); assert.equal(f.calls.length, 0)
})
test('hung progress and settlement storage cannot hide a confirmed native effect indefinitely', redisTest, async t => {
  const f = await fixture(t), release = deferred(); let writes = 0, calls = 0
  const controlled = { get: f.storage.get.bind(f.storage), async eval(script, options) {
    if (script.includes('KEEPTTL')) { writes++; return release.promise }
    return f.storage.eval(script, options)
  } }
  const pending = createAgentInteractionWorkflow(controlled, { timeoutMs: 30 }).execute({ ...f.input,
    async dispatch() { calls++; return { state: 'confirmed' } } })
  const result = await Promise.race([pending, delay(500).then(() => 'timed-out')])
  assert.notEqual(result, 'timed-out'); assert.equal(result.state, 'unknown'); assert.equal(result.completed, 1); assert.equal(calls, 1); assert.equal(writes, 2)
  release.resolve(0)
})
test('claim failure cannot dispatch and terminal/progress persistence failures become unknown with safe diagnostics', redisTest, async t => {
  const f = await fixture(t); let calls = 0
  const broken = { get: f.storage.get.bind(f.storage), async eval() { throw Error('SECRET_STORE_ERROR') } }
  assert.equal((await createAgentInteractionWorkflow(broken, { diagnostics: { emit(value) { f.events.push(value) } } }).execute({ ...f.input, dispatch: async () => { calls++; return { state: 'confirmed' } } })).state, 'failed')
  assert.equal(calls, 0)
  let brokenWrites = false
  const controlled = { get: f.storage.get.bind(f.storage), async eval(script, options) { if (brokenWrites && script.includes('KEEPTTL')) throw Error('SECRET_SETTLE_ERROR'); return f.storage.eval(script, options) } }
  const result = await createAgentInteractionWorkflow(controlled, { diagnostics: { emit(value) { f.events.push(value) } } }).execute({ ...f.input, dispatch: async () => { calls++; brokenWrites = true; return { state: 'confirmed' } } })
  assert.equal(result.state, 'unknown'); assert.equal(result.completed, 1); assert.equal(calls, 1)
  assert.equal((await f.restart().execute(f.input)).state, 'unknown'); assert.equal(calls, 1)
  assert.ok(f.events.some(event => event.code === 'interaction_claim_failed')); assert.ok(f.events.some(event => event.code === 'interaction_settlement_failed'))
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_STORE_ERROR|SECRET_SETTLE_ERROR/u)
})
test('malformed or foreign Redis state fails closed without deleting its claim', redisTest, async t => {
  const f = await fixture(t); await f.workflow.execute(f.input)
  const [[key]] = await f.records(); await f.reader.set(key, '{"state":"confirmed","secret":"PRIVATE"}')
  const before = f.calls.length; assert.equal((await f.restart().execute(f.input)).state, 'failed'); assert.equal(f.calls.length, before)
  assert.equal(await f.reader.get(key), '{"state":"confirmed","secret":"PRIVATE"}')
})
