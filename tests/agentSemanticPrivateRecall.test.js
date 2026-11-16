import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentSemanticMemory } from '../dist/backend/modules/memory/infrastructure/agentSemanticMemory.js'
import { agentSemanticMemoryId, createAgentSemanticMemoryStore } from '../dist/backend/modules/memory/infrastructure/agentSemanticMemoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const account = { platform: 'fixture', namespace: 'private-semantic', id: 'account-a' }
const peer = { ...account, id: 'real-private-peer' }
const otherAuthor = { ...peer, id: 'another-group-member' }
const viewer = { account, kind: 'private', id: 'opaque-private-conversation' }
const groupA = { account, kind: 'group', id: 'group-a' }
const groupB = { ...groupA, id: 'group-b' }
const foreignAccount = { ...groupA, account: { ...account, id: 'account-b' } }
const foreignNamespace = { ...groupA, account: { ...account, namespace: 'different-namespace' } }
const foreignPlatform = { ...groupA, account: { ...account, platform: 'alternative' } }
const foreignAgent = { ...groupA, id: 'different-agent-group' }
const groups = [groupA, groupB, foreignAccount, foreignNamespace, foreignPlatform, foreignAgent]

async function waitFor(probe, description, timeoutMs = 4000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = await probe()
    if (value) return value
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, options = {}) {
  let composer
  t.after(async () => { await composer?.stop() })
  const redis = await createAgentRedisFixture(t, 'agent-semantic-private-recall')
  const clock = { at: Date.now() }, active = new Set(), queries = []
  const bindings = new Map(), available = new Set(), authorized = new Set(), recalled = new Set()
  const calls = { embed: [], rerank: [], authorize: [] }
  const behavior = { embed: undefined, rerank: undefined }
  const memory = createPersonMemoryStore({ redis: redis.storage, now: () => clock.at })
  const store = createAgentSemanticMemoryStore(redis.storage)
  let serial = 0, revision = 0
  const f = {
    ...redis, clock, calls, behavior, memory, store, authorized, available,
    get composer() { return composer },
    binding: target => bindings.get(conversationAddressKey(target)),
    bind(target, agentId = 'reader') {
      const binding = { target: structuredClone(target), agentId, personaId: 'shared-persona', source: 'configured',
        revision: `revision-${++revision}`, connectionId: `connection-${target.account.id}`, id: conversationAddressKey(target) }
      bindings.set(conversationAddressKey(target), binding)
      return binding
    },
    subject(target = viewer, author = peer) {
      const { botId, scene } = personMemoryAddress(target, target.kind === 'private' ? peer.id : undefined)
      return { identity: { botId, personaId: agentPersonaScopeId(f.binding(target).agentId) }, scene, subjectId: author.id }
    },
    async capture(target, text, input = {}) {
      clock.at++
      const incoming = { version: 1, conversation: target, sender: input.author ?? peer, senderName: input.name ?? '真实本人',
        messageId: input.messageId ?? `source-${++serial}`, occurredAt: clock.at, text,
        parts: [{ kind: 'text', text }], mentions: [], directedToAccount: target.kind === 'private' }
      await composer.capture(incoming, f.binding(target), () => true)
      return incoming
    },
    state: target => store.read(agentSemanticMemoryId(f.binding(target))),
    async indexed(target) {
      return waitFor(async () => {
        await composer.tick()
        const state = await f.state(target)
        return state?.rows.length && state.rows.every(row => row.vector) && state
      }, `durable vectors for ${target.id}`)
    },
    async prepareQuery(text) {
      const incoming = await f.capture(viewer, text)
      queries.push(incoming)
      return { incoming, source: { messageId: incoming.messageId, authorId: incoming.sender.id, at: incoming.occurredAt } }
    },
    async query(text, input = {}) {
      const prepared = input.prepared ?? await f.prepareQuery(text)
      const proof = input.proof === false ? undefined : { ...prepared.source, ...input.proof }
      return composer.read(f.binding(viewer), text, input.guard ?? (() => true), input.signal,
        queries.map(message => message.messageId), proof)
    },
    async revoke(target, messageId) {
      recalled.add(JSON.stringify([conversationAddressKey(target), messageId]))
      composer.invalidate(target)
      await memory.revokeSource({ ...f.subject(target), messageId })
    },
    clearProviderCalls() { calls.embed.length = 0; calls.rerank.length = 0; calls.authorize.length = 0 },
    drained: () => waitFor(() => active.size === 0, 'memory turns released'),
  }
  for (const target of [viewer, ...groups]) {
    f.bind(target, target === foreignAgent ? 'different-reader' : 'reader')
    available.add(conversationAddressKey(target))
    if (target.kind === 'group') authorized.add(conversationAddressKey(target))
  }
  const ports = {
    redis: redis.storage, memory, now: () => clock.at,
    config: () => ({ enabled: true, topK: 5, minScore: 0.8, timeoutMs: 5000, ...options.config }),
    backend: {
      id: 'a'.repeat(64),
      async embed(texts, context) {
        const call = { texts: [...texts], context }; calls.embed.push(call)
        return behavior.embed ? behavior.embed(call) : texts.map(options.vector ?? (() => [1, 0, 0]))
      },
      async rerank(query, documents, context) {
        const call = { query, documents: structuredClone(documents), context }; calls.rerank.push(call)
        return behavior.rerank ? behavior.rerank(call) : new Map(documents.map(document => [document.id, 1]))
      },
    },
    resolve: target => { const binding = f.binding(target); return binding && { binding } },
    available: target => available.has(conversationAddressKey(target)),
    privatePeer: target => target.kind === 'private' ? peer.id : undefined,
    isRecalled: async (target, messageId) => recalled.has(JSON.stringify([conversationAddressKey(target), messageId])),
    isRunning: redis.isCurrent, allowsText: () => true, logger: { warn() {} },
    async begin(binding) {
      const controller = new AbortController()
      active.add(controller)
      return { signal: controller.signal,
        isCurrent: () => redis.isCurrent() && agentBindingToken(f.binding(binding.target)) === agentBindingToken(binding),
        release: () => { active.delete(controller) },
      }
    },
  }
  if (options.authorize !== false) ports.authorizePrivateSource = async (viewerBinding, sourceBinding, subjectId, context) => {
    calls.authorize.push({ viewerBinding, sourceBinding, subjectId, context })
    return authorized.has(conversationAddressKey(sourceBinding.target)) && !context.signal.aborted
  }
  composer = createAgentSemanticMemory(ports)
  return f
}

function noLateProjection(outcome, forbidden) {
  assert.ok(outcome.error instanceof Error || !outcome.value?.text.includes(forbidden), 'a revoked source entered the returned projection')
}

test('a proven private peer semantically recalls their own group original without shared query keywords', redisTest, async t => {
  const source = 'physician prescribed jogging', query = 'doctor recommended exercise'
  const f = await fixture(t, { vector: text => text === source || text === query ? [1, 0, 0] : [0, 1, 0] })
  const original = await f.capture(groupA, source)
  await f.capture(groupA, 'astronomer photographed nebula')
  await f.indexed(groupA)
  f.clearProviderCalls()
  const projection = await f.query(query)
  assert.ok(projection.text.includes(original.text))
  assert.doesNotMatch(projection.text, /astronomer photographed nebula/u)
  assert.equal(await projection.isCurrent(), true)
  assert.deepEqual(f.calls.embed.map(call => call.texts), [[query]])
  assert.ok(f.calls.authorize.length > 0)
  assert.ok(f.calls.authorize.every(call => call.subjectId === peer.id && call.viewerBinding.target.kind === 'private' && call.sourceBinding.target.kind === 'group'))
})

test('missing query proof preserves local recall while a proof for another peer cannot widen it', redisTest, async t => {
  const f = await fixture(t)
  await f.capture(viewer, 'copper private handbook')
  await f.capture(groupA, 'copper group secret')
  await f.indexed(viewer); await f.indexed(groupA)
  const local = await f.query('copper', { proof: false })
  assert.match(local.text, /copper private handbook/u)
  assert.doesNotMatch(local.text, /copper group secret/u)
  f.clearProviderCalls()
  const foreign = await f.query('copper', { proof: { authorId: otherAuthor.id } })
  assert.doesNotMatch(foreign.text, /copper group secret/u)
  assert.deepEqual(f.calls.embed, [])
  assert.deepEqual(f.calls.rerank, [])
})

test('absent or denied group authorization preserves local private BM25 without exposing a group corpus', redisTest, async t => {
  for (const authorize of [false, true]) {
    const f = await fixture(t, { authorize })
    await f.capture(viewer, 'cobalt private notebook')
    await f.capture(groupA, 'cobalt unauthorized group source')
    await f.indexed(viewer); await f.indexed(groupA)
    f.authorized.clear()
    f.clearProviderCalls()
    const projection = await f.query('cobalt')
    assert.match(projection.text, /cobalt private notebook/u)
    assert.doesNotMatch(projection.text, /cobalt unauthorized group source/u)
    assert.ok(f.calls.rerank.every(call => call.documents.every(document => !document.text.includes('unauthorized'))))
  }
})

test('cross-group lookup isolates receiving account, namespace, platform and Agent before authorizing sources', redisTest, async t => {
  const f = await fixture(t)
  const entries = [[groupA, 'allowed amber archive'], [foreignAccount, 'foreign account archive'],
    [foreignNamespace, 'foreign namespace archive'], [foreignPlatform, 'foreign platform archive'], [foreignAgent, 'foreign Agent archive']]
  for (const [target, text] of entries) await f.capture(target, text)
  for (const [target] of entries) await f.indexed(target)
  f.clearProviderCalls()
  const projection = await f.query('unrelated semantic phrase')
  assert.match(projection.text, /allowed amber archive/u)
  for (const [, text] of entries.slice(1)) assert.ok(!projection.text.includes(text))
  assert.ok(f.calls.authorize.every(call => conversationAddressKey(call.sourceBinding.target) === conversationAddressKey(groupA)))
})

test('other group authors and their opt-outs never enter private provider documents or suppress the proven peer query', redisTest, async t => {
  const f = await fixture(t)
  await f.capture(groupA, 'own violet horticulture notes')
  await f.capture(groupA, 'own indigo gardening journal')
  await f.capture(groupA, 'another authors confidential report', { author: otherAuthor })
  await f.indexed(groupA)
  await f.memory.setEnabled({ ...f.subject(groupA, otherAuthor), enabled: false })
  f.clearProviderCalls()
  const query = 'flower cultivation question'
  const projection = await f.query(query)
  assert.match(projection.text, /own violet horticulture notes/u)
  assert.match(projection.text, /own indigo gardening journal/u)
  assert.doesNotMatch(projection.text, /confidential report/u)
  assert.deepEqual(f.calls.embed.map(call => call.texts), [[query]])
  assert.equal(f.calls.rerank.length, 1)
  assert.deepEqual(f.calls.rerank[0].documents.map(document => document.text).sort(), ['own indigo gardening journal', 'own violet horticulture notes'])
})

test('identical message IDs in different groups remain distinct rerank candidates and retain correct ownership', redisTest, async t => {
  const f = await fixture(t, { config: { topK: 1 } })
  await f.capture(groupA, 'alpha group original', { messageId: 'same-platform-id' })
  await f.capture(groupB, 'beta group original', { messageId: 'same-platform-id' })
  await f.indexed(groupA); await f.indexed(groupB)
  f.clearProviderCalls()
  f.behavior.rerank = call => new Map(call.documents.map(document => [document.id, document.text.startsWith('beta') ? 1 : 0]))
  const projection = await f.query('semantic coordinate question')
  assert.equal(f.calls.rerank.length, 1)
  const documents = f.calls.rerank[0].documents
  assert.equal(documents.length, 2)
  assert.equal(new Set(documents.map(document => document.id)).size, 2)
  assert.match(projection.text, /beta group original/u)
  assert.doesNotMatch(projection.text, /alpha group original/u)
  await f.revoke(groupB, 'same-platform-id')
  assert.equal(await projection.isCurrent(), false)
  const remaining = await f.query('semantic coordinate question')
  assert.match(remaining.text, /alpha group original/u)
  assert.doesNotMatch(remaining.text, /beta group original/u)
})

test('group-scoped opt-out or forget removes only that group, while a private global opt-out or forget covers all historical groups', redisTest, async t => {
  for (const privacy of ['disable', 'forget']) {
    const f = await fixture(t)
    await f.capture(groupA, 'apricot revoked group source')
    await f.capture(groupB, 'birch retained group source')
    await f.indexed(groupA); await f.indexed(groupB)
    if (privacy === 'disable') await f.memory.setEnabled({ ...f.subject(groupA), enabled: false })
    else await f.memory.forget(f.subject(groupA))
    const projection = await f.query('semantic first question')
    assert.doesNotMatch(projection.text, /apricot revoked group source/u)
    assert.match(projection.text, /birch retained group source/u)
    const { identity, subjectId } = f.subject(viewer)
    if (privacy === 'disable') await f.memory.setEnabled({ identity, subjectId, enabled: false })
    else await f.memory.forget({ identity, subjectId })
    f.clearProviderCalls()
    assert.equal((await f.query('semantic second question')).text, '')
    assert.deepEqual(f.calls.embed, [])
    assert.deepEqual(f.calls.rerank, [])
  }
})

test('membership loss or a group binding change during query embedding blocks a late cross-group projection', redisTest, async t => {
  for (const change of ['membership', 'binding']) {
    const f = await fixture(t)
    const text = 'pending group embedding original'
    await f.capture(groupA, text)
    await f.indexed(groupA)
    f.clearProviderCalls()
    const pending = Promise.withResolvers()
    f.behavior.embed = () => pending.promise
    t.after(() => pending.resolve([[1, 0, 0]]))
    const result = f.query('late semantic question').then(value => ({ value }), error => ({ error }))
    await waitFor(() => f.calls.embed.length === 1, 'private query embedding')
    if (change === 'membership') f.authorized.delete(conversationAddressKey(groupA))
    else f.bind(groupA, 'different-reader')
    await assert.rejects(() => f.calls.embed[0].context.ensureCurrent())
    pending.resolve([[1, 0, 0]])
    noLateProjection(await result, text)
  }
})

test('membership loss during reranking rejects a late result containing previously authorized group originals', redisTest, async t => {
  const f = await fixture(t)
  await f.capture(groupA, 'first pending group original')
  await f.capture(groupB, 'second pending group original')
  await f.indexed(groupA); await f.indexed(groupB)
  f.clearProviderCalls()
  const pending = Promise.withResolvers()
  f.behavior.rerank = () => pending.promise
  t.after(() => pending.resolve(new Map()))
  const result = f.query('semantic rerank question').then(value => ({ value }), error => ({ error }))
  await waitFor(() => f.calls.rerank.length === 1, 'private query reranking')
  f.authorized.delete(conversationAddressKey(groupB))
  await assert.rejects(() => f.calls.rerank[0].context.ensureCurrent())
  pending.resolve(new Map(f.calls.rerank[0].documents.map(document => [document.id, 1])))
  noLateProjection(await result, 'second pending group original')
})

test('recalling a source group or stopping cancels pending private embedding without a provider response', redisTest, async t => {
  for (const change of ['recall', 'stop']) {
    const f = await fixture(t)
    const original = await f.capture(groupA, 'never returning provider source')
    await f.indexed(groupA)
    f.clearProviderCalls()
    f.behavior.embed = () => new Promise(() => {})
    const result = f.query('unresponsive private query').then(value => ({ value }), error => ({ error }))
    await waitFor(() => f.calls.embed.length === 1, 'unresponsive private embedding')
    if (change === 'recall') await f.revoke(groupA, original.messageId)
    else await Promise.race([f.composer.stop(), delay(1000).then(() => assert.fail('stop waited for the provider'))])
    await waitFor(() => f.calls.embed[0].context.signal.aborted, `${change} reaches the private provider signal`, 1000)
    const outcome = await result
    assert.ok(outcome.error instanceof Error)
    assert.equal(outcome.value, undefined)
    await f.drained()
  }
})

test('retained private projections revalidate group membership, binding, readiness, source persistence, recall and shutdown', redisTest, async t => {
  for (const change of ['membership', 'binding', 'readiness', 'deletion', 'recall', 'stop']) {
    const f = await fixture(t)
    const original = await f.capture(groupA, 'retained authorized group original')
    await f.indexed(groupA)
    const projection = await f.query('retained private query')
    assert.ok(projection.text.includes(original.text))
    assert.equal(await projection.isCurrent(), true)
    if (change === 'membership') f.authorized.delete(conversationAddressKey(groupA))
    else if (change === 'binding') f.bind(groupA, 'different-reader')
    else if (change === 'readiness') f.available.delete(conversationAddressKey(groupA))
    else if (change === 'deletion') await f.store.update(agentSemanticMemoryId(f.binding(groupA)), () => undefined)
    else if (change === 'recall') await f.revoke(groupA, original.messageId)
    else await f.composer.stop()
    assert.equal(await projection.isCurrent(), false, `${change} must revoke the retained projection`)
  }
})

test('a forgotten current private query source is never sent to embedding or rerank providers', redisTest, async t => {
  const f = await fixture(t)
  await f.capture(groupA, 'original authorized group source')
  await f.capture(viewer, 'original local private source')
  await f.indexed(groupA); await f.indexed(viewer)
  const query = 'forgotten confidential private query'
  const prepared = await f.prepareQuery(query)
  await f.memory.forget({ ...f.subject(viewer), sourceMessageId: prepared.source.messageId })
  f.clearProviderCalls()
  await f.query(query, { prepared }).catch(() => undefined)
  assert.deepEqual(f.calls.embed, [])
  assert.deepEqual(f.calls.rerank, [])
})
