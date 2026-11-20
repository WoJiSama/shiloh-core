import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createAgentBindingDirectory, agentPersonaScopeId, platformAccountKey },
  { createCognitionStore }, { cognitionSourceId, recordCognitionSources }, { applyCognitionProposals },
  { createPersonMemoryStore }, { personMemoryAddress }, { createCharacterStore }, { createAgentCognition }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/memory/infrastructure/cognitionStore.js'), load('modules/memory/domain/cognitionState.js'),
  load('modules/memory/domain/cognitionSelf.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/personMemoryContext.js'),
  load('modules/simulation/infrastructure/characterStore.js'), load('modules/memory/infrastructure/agentCognition.js'),
])
const settings = { skip: !redisAvailable, timeout: 20_000 }
const account = { platform: 'fixture', namespace: 'cognition-test', id: 'bot-a' }
const actor = { ...account, id: 'user-a' }
const a = { account, kind: 'group', id: 'room-a' }, b = { account, kind: 'group', id: 'room-b' }
const privateRoom = { account, kind: 'private', id: 'private-a' }, otherAgentRoom = { account, kind: 'group', id: 'room-other' }
const SELF = '喜欢把六角格游戏的路线仔细规划', SECRET = 'A群的林某准备月底辞职', B_FACT = 'B群还记得上次一起玩六角格游戏'
const guard = { isCurrent: () => true, async ensureCurrent() {} }

async function waitFor(probe, description) {
  const until = performance.now() + 6000
  while (performance.now() < until) { if (await probe()) return; await delay(10) }
  assert.fail(`timed out waiting for ${description}`)
}
async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, options.name ?? 'cognition-core'), requests = [], deliveries = [], attempts = [], warnings = [], cognitionReads = []
  let accept, ready = false, runtime, clock = Date.now(), serial = 0
  const bindings = createAgentBindingDirectory({ version: 1,
    agents: [{ id: 'daily', personaId: 'shared' }, { id: 'other', personaId: 'shared' }],
    connections: [{ id: 'fixture-0', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [a, b, privateRoom, otherAgentRoom].map(target => ({ connectionId: 'fixture-0', kind: target.kind,
      conversationId: target.id, agentId: target === otherAgentRoom ? 'other' : 'daily' })),
  }, 'cognition-v1')
  const storage = { ...redis.storage, async get(key) {
    if (key.startsWith('agent:cognition:v1:')) cognitionReads.push(key)
    return redis.storage.get(key)
  } }
  const store = createCognitionStore(redis.storage), personMemory = createPersonMemoryStore({ redis: storage, now: () => clock })
  const source = (nativeId, kind, content, authorId = actor.id, target = a) => ({
    id: cognitionSourceId('daily', target, kind, nativeId), agentId: 'daily', conversation: target, nativeId, kind,
    authorId, occurredAt: clock - 1000, content, revision: 1, participantIds: [authorId], status: 'active',
  })
  const raw = source('seed-raw', 'message', '今天我们讨论六角格游戏的路线规划')
  const own = source('seed-expression', 'self-expression', SELF, account.id)
  const secret = source('seed-secret', 'message', SECRET)
  const independent = source('seed-b', 'message', B_FACT, actor.id, b)
  await store.update('daily', before => {
    let state = recordCognitionSources(before, [raw, own, secret, independent])
    state.links.push({ id: 'seed-expression-proof', from: raw.id, to: own.id, kind: 'supports', sourceIds: [raw.id] })
    state = applyCognitionProposals(state, a, [
      { id: 'self-interest', action: 'CREATE', kind: 'interest', content: SELF, topic: '六角格游戏', sourceIds: [own.id],
        epistemic: 'inferred', audience: 'self', selfAssessment: { subject: 'self', sensitivity: 'ordinary', containsOtherPeople: false } },
      { id: 'scene-secret', action: 'CREATE', kind: 'experience', content: SECRET, topic: '六角格游戏', sourceIds: [secret.id],
        epistemic: 'reported', audience: 'scene' },
    ], clock - 1000)
    state = applyCognitionProposals(state, b, [{ id: 'independent-b', action: 'CREATE', kind: 'experience', content: B_FACT,
      topic: '六角格游戏', sourceIds: [independent.id], epistemic: 'reported', audience: 'scene' }], clock - 1000)
    return state
  }, guard)
  const seeded = await store.read('daily')
  function managementContext(target) {
    const lifetime = new AbortController()
    return { binding: bindings.resolve(target), signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted, ensureCurrent() { assert.equal(lifetime.signal.aborted, false) },
      async authorize(_operation, _binding, selected) { selected.ensureCurrent(); return 'allowed' },
    }
  }
  const adapter = { id: 'fixture-0', account, botUserId: account.id, botName: '认知接线测试',
    isReady: () => ready, resolvePrivatePeer: () => actor,
    async start(receive) { accept = receive; ready = true }, stop() { ready = false },
    actions: { async send(action, selected) {
      attempts.push(action)
      if (selected?.isCurrent?.() !== true) return { state: 'failed', code: 'binding_changed' }
      deliveries.push(action)
      return { state: 'sent', messageId: `sent-${deliveries.length}` }
    } },
  }
  runtime = createAgentRuntime({ storage, adapters: [adapter], now: () => clock, isExecutionCurrent: redis.isCurrent,
    logger: { info() {}, warn: message => warnings.push(message), error: message => warnings.push(message) },
    managementBindings: { list: () => bindings.listBindings(), resolve: target => bindings.resolve(target) },
    cognition: { enabled: options.enabled !== false }, privateChatEnabled: true, useTextGroup: target => target.kind === 'group',
    resolvePersona(target) { const binding = bindings.resolve(target); return binding && { binding,
      personaId: agentPersonaScopeId(binding.agentId), persona: { name: '认知接线测试' }, systemContent: '一个持续存在的机器人。' } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
    getExecutionConfig: () => ({ useTools: false }), groupTextTools: () => [],
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    async YTapi(request, ...args) {
      requests.push(request)
      await options.model?.(request, ...args)
      return { choices: [{ message: { content: '我喜欢讨论游戏中的路线规划。' } }], model: 'fixture', usage: { total_tokens: 1 } }
    },
  })
  t.after(async () => { options.release?.(); await runtime.stop() })
  await runtime.start()
  const queueKey = target => `agent:inbox:${target.kind === 'private' ? 'private' : 'group-text'}:${platformAccountKey(target.account)}`
  async function drained(target) { await waitFor(() => redis.reader.lLen(redis.prefix + queueKey(target)).then(n => n === 0), 'Core inbox completion') }
  async function emit(target, id, text = '你现在对六角格游戏有什么爱好？') {
    clock++
    const message = { version: 1, conversation: target, sender: actor, senderName: '测试群友', messageId: id,
      occurredAt: clock, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true }
    await accept({ kind: 'message', message })
    return message
  }
  return { runtime, store, storage: redis.storage, now: () => clock, raw, own, secret, independent, seeded, requests, deliveries, attempts, cognitionReads, warnings,
    async send(target, id = `incoming-${++serial}`, text) { const message = await emit(target, id, text); await drained(target); return message },
    emit, drained, recall: () => accept({ kind: 'recall', target: a, messageId: raw.nativeId }),
    async rememberSourceProfile(source = raw) {
      const { botId, scene } = personMemoryAddress(a)
      const saved = await personMemory.remember({ identity: { botId, personaId: agentPersonaScopeId('daily') }, subjectId: actor.id,
        category: 'fact', evidenceKind: 'self', text: source.content,
        source: { scene, authorId: actor.id, messageId: source.nativeId, at: source.occurredAt, excerpt: source.content } })
      assert.equal(saved.saved, true)
      return saved.entry
    },
    removeProfile: () => runtime.management.profiles.remove(actor.id, managementContext(a)),
    removeProfileField: id => runtime.management.profiles.removeField(actor.id, 'entries', id, managementContext(a)),
  }
}

test('Core injects the same self in group and private prompts while keeping A-group facts and other agents separate', settings, async t => {
  const f = await fixture(t)
  await f.send(b, 'in-b')
  assert.ok(JSON.stringify(f.requests.at(-1)).includes(SELF))
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(SECRET))
  await f.send(privateRoom, 'in-private')
  assert.ok(JSON.stringify(f.requests.at(-1)).includes(SELF))
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(SECRET))
  await f.send(otherAgentRoom, 'in-other-agent')
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(SELF))
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(SECRET))
  assert.equal(f.requests.length, 3)
  assert.equal(f.deliveries.length, 3)
})

for (const action of ['source-recall', 'profile-remove']) test(`Core blocks a B-group reply when ${action} revokes its A-group evidence during model generation`, settings, async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers()
  const f = await fixture(t, { name: `cognition-${action}`, release: () => held.resolve(),
    async model(request) { entered.resolve(request); await held.promise } })
  if (action === 'profile-remove') await f.rememberSourceProfile()
  await f.emit(b, `suspended-${action}`)
  await waitFor(() => f.requests.length > 0, 'Core model entry')
  const pending = await entered.promise
  assert.ok(JSON.stringify(pending).includes(SELF), 'the suspended prompt must actually contain A-backed self')
  if (action === 'source-recall') await f.recall()
  else assert.equal(await f.removeProfile(), true)
  held.resolve()
  await f.drained(b)
  assert.equal(f.attempts.length, 0, 'revoked model output must not reach the adapter send boundary')
  assert.equal(f.deliveries.length, 0)
  const state = await f.store.read('daily')
  assert.equal(state.sources.find(s => s.id === f.raw.id).status, 'revoked')
  assert.equal(state.sources.find(s => s.id === f.own.id).status, 'revoked')
  assert.equal(state.nodes.find(n => n.id === 'self-interest').status, 'invalid')
  assert.equal(state.sources.find(s => s.nativeId === `suspended-${action}`).status, 'active', 'A-scene deletion must not erase B-scene incoming evidence')
  assert.equal(state.sources.find(s => s.id === f.independent.id).status, 'active', 'A-scene deletion must preserve independent older B-scene evidence')
  await f.send(b, `after-${action}`)
  const nextPrompt = JSON.stringify(f.requests.at(-1))
  assert.ok(!nextPrompt.includes(SELF), 'fresh turns must not recover the revoked self')
  assert.ok(nextPrompt.includes(B_FACT), 'a scope-wide aggregate watermark must not permanently hide independent B-scene facts')
})

test('ordinary Core text ingestion stores the real incoming source before composing the reply', settings, async t => {
  const f = await fixture(t)
  const incoming = await f.send(b, 'real-incoming', '我喜欢六角格游戏')
  const saved = await f.store.read('daily')
  const row = saved.sources.find(s => s.nativeId === incoming.messageId && s.kind === 'message')
  assert.ok(row)
  assert.equal(row.agentId, 'daily')
  assert.deepEqual(row.conversation, b)
  assert.equal(row.authorId, actor.id)
  assert.equal(row.occurredAt, incoming.occurredAt)
  assert.equal(row.content, incoming.text)
  assert.deepEqual(row.participantIds, [actor.id])
  assert.equal(row.status, 'active')
  assert.equal(f.deliveries.length, 1)
})

test('removing one profile field revokes only its source and derived self while another fact from the same author and scene remains recallable', settings, async t => {
  const f = await fixture(t, { name: 'cognition-field-erase' })
  const independent = { ...f.raw, id: cognitionSourceId('daily', a, 'message', 'same-scene-independent'),
    nativeId: 'same-scene-independent', content: '我喜欢六角格游戏里的森林地图' }
  await f.store.update('daily', state => applyCognitionProposals(recordCognitionSources(state, [independent]), a, [{
    id: 'independent-a', action: 'CREATE', kind: 'experience', content: independent.content,
    topic: '六角格游戏', sourceIds: [independent.id], epistemic: 'reported', audience: 'scene',
  }], f.now()), guard)
  const removed = await f.rememberSourceProfile(f.raw), kept = await f.rememberSourceProfile(independent)
  const remainingProfile = await f.removeProfileField(removed.id)
  assert.deepEqual(remainingProfile.entries.map(entry => entry.id), [kept.id])
  const state = await f.store.read('daily')
  assert.equal(state.sources.find(source => source.id === f.raw.id).status, 'revoked')
  assert.equal(state.sources.find(source => source.id === f.own.id).status, 'revoked')
  assert.equal(state.nodes.find(node => node.id === 'self-interest').status, 'invalid')
  assert.equal(state.sources.find(source => source.id === independent.id).status, 'active')
  assert.equal(state.nodes.find(node => node.id === 'independent-a').status, 'active')
  await f.send(a, 'after-field-erase')
  const prompt = f.requests.at(-1)
  const cognition = prompt.messages.find(message => typeof message.content === 'string' && message.content.startsWith('以下是带证据的记忆资料'))
  assert.ok(cognition, 'Core must supply a cognition section, not only a person-profile fallback')
  assert.ok(cognition.content.includes(independent.content))
  assert.ok(!JSON.stringify(prompt).includes(SELF))
  assert.ok(!JSON.stringify(prompt).includes(f.raw.content))
  assert.equal(f.deliveries.length, 1)
})

test('disabled cognition performs no cognition reads or capture even when prior state exists', settings, async t => {
  const f = await fixture(t, { name: 'cognition-disabled', enabled: false })
  await f.send(b, 'disabled-live')
  await f.send(privateRoom, 'disabled-private')
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes(SELF) && !JSON.stringify(request).includes(SECRET)))
  assert.deepEqual(f.cognitionReads, [])
  assert.deepEqual(await f.store.read('daily'), f.seeded)
  assert.equal(f.deliveries.length, 2)
})

async function seedCharacterSelf(f, kind) {
  const { botId, scene } = personMemoryAddress(a)
  const scope = { botId, personaId: agentPersonaScopeId('daily'), groupId: scene.id }
  const characters = createCharacterStore({ redis: f.storage, now: f.now }), timestamp = f.now() - 500
  const title = kind === 'memory' ? '来自角色经历的路线兴趣' : '来自已确认回执的路线兴趣'
  const committed = await characters.update(scope, state => {
    if (kind === 'memory') state.memories.push({ id: 'authoritative-memory', kind: 'interest', content: '六角格游戏的复杂路线让我着迷',
      epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: timestamp, updatedAt: timestamp })
    else state.receipts.push({ id: 'authoritative-receipt', toolName: 'play_game', status: 'succeeded', summary: '完成六角格游戏的路线挑战', at: timestamp })
    return state
  })
  const cognition = createAgentCognition({ redis: f.storage, canUseSource: () => true, now: f.now })
  const nativeId = `confirmed-${kind}`, expressionId = cognitionSourceId('daily', a, 'self-expression', nativeId)
  await cognition.projectTurn({ agentId: 'daily', conversation: a, character: committed,
    messageRefs: [{ seq: 1, messageId: f.raw.nativeId }],
    expressions: [{ messageId: nativeId, content: title, at: timestamp, participantIds: [account.id] }],
  }, guard)
  await cognition.propose('daily', a, [{ id: `self-${kind}`, action: 'CREATE', kind: 'interest', content: title,
    topic: '六角格游戏', sourceIds: [expressionId], epistemic: 'inferred', audience: 'self',
    selfAssessment: { subject: 'self', sensitivity: 'ordinary', containsOtherPeople: false } }], guard)
  const saved = await f.store.read('daily'), projected = saved.nodes.find(node => node.id.includes(kind === 'memory' ? ':memory:authoritative-memory:' : ':receipt:authoritative-receipt:'))
  assert.ok(projected, 'fixture must project a real committed character record')
  assert.ok(saved.links.some(link => link.from === projected.id && link.to === expressionId), 'confirmed self-expression must depend on the projected authority')
  return { characters, scope, title, projected, expressionId }
}

test('direct deletion of authoritative character memory blocks an already-generating cross-group reply without synchronizing cognition', settings, async t => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers()
  const f = await fixture(t, { name: 'cognition-character-authority', release: () => held.resolve(),
    async model(request) { entered.resolve(request); await held.promise } })
  const seeded = await seedCharacterSelf(f, 'memory')
  await f.emit(b, 'character-memory-in-flight')
  await waitFor(() => f.requests.length > 0, 'Core model reading character-backed self')
  assert.ok(JSON.stringify(await entered.promise).includes(seeded.title))
  const cognitionBeforeDelete = await f.store.read('daily')
  await seeded.characters.update(seeded.scope, state => { state.memories = []; return state })
  assert.deepEqual(await f.store.read('daily'), cognitionBeforeDelete, 'only the authoritative character store was changed')
  held.resolve()
  await f.drained(b)
  assert.equal(f.attempts.length, 0)
  assert.equal(f.deliveries.length, 0)
  await f.send(b, 'after-authority-memory-delete')
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes(seeded.title), 'future prompts must not trust the stale cognition copy')
  assert.ok(JSON.stringify(f.requests.at(-1)).includes(B_FACT), 'independent current-scene memory remains available')
})

test('authoritative receipt deletion or status correction invalidates its old nodes and derived self even before projection synchronization', settings, async t => {
  for (const mutation of ['delete', 'status-change']) await t.test(mutation, async t => {
    const entered = Promise.withResolvers(), held = Promise.withResolvers()
    const f = await fixture(t, { name: `cognition-receipt-${mutation}`, release: () => held.resolve(),
      async model(request) { entered.resolve(request); await held.promise } })
    const seeded = await seedCharacterSelf(f, 'receipt')
    await f.emit(b, `receipt-${mutation}-in-flight`)
    await waitFor(() => f.requests.length > 0, 'Core model reading receipt-backed self')
    assert.ok(JSON.stringify(await entered.promise).includes(seeded.title))
    const cognitionBeforeChange = await f.store.read('daily')
    await seeded.characters.update(seeded.scope, state => {
      if (mutation === 'delete') state.receipts = []
      else { state.receipts[0].status = 'unknown'; state.receipts[0].summary = '实际投递结果仍未知' }
      return state
    })
    assert.deepEqual(await f.store.read('daily'), cognitionBeforeChange, 'receipt authority changes must be checked without a cognition write')
    held.resolve()
    await f.drained(b)
    assert.equal(f.attempts.length, 0)
    assert.equal(f.deliveries.length, 0)
    await f.send(b, `receipt-${mutation}-after`)
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes(seeded.title))
    await f.send(a, `receipt-${mutation}-direct`)
    assert.ok(!JSON.stringify(f.requests.at(-1)).includes('完成六角格游戏的路线挑战'), 'old receipt node itself must not be recalled either')
  })
})
