import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { agentSemanticMemoryId, createAgentSemanticMemoryStore } from '../dist/backend/modules/memory/infrastructure/agentSemanticMemoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentSemanticMemory } = await load('modules/memory/infrastructure/agentSemanticMemory.js')

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const DAY = 86_400_000
const account = { platform: 'fixture', namespace: 'semantic-memory', id: 'account-a' }
const actor = { ...account, id: 'author-a' }
const otherActor = { ...actor, id: 'author-b' }
const room = { account, kind: 'group', id: 'room-a' }
const otherRoom = { ...room, id: 'room-b' }
const otherAccountRoom = { ...room, account: { ...account, id: 'account-b' } }
const privateRoom = { account, kind: 'private', id: 'opaque-private-room' }
const providerA = 'a'.repeat(64)
const providerB = 'b'.repeat(64)

async function waitFor(probe, description, timeoutMs = 3500) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, options = {}) {
  const composers = [], activeTurns = new Set()
  t.after(async () => { await Promise.all(composers.map(composer => composer.stop())) })
  const redis = await createAgentRedisFixture(t, options.name ?? 'agent-semantic-memory')
  const clock = { at: Date.now() }
  const bindings = new Map(), unavailable = new Set(), recalled = new Set()
  const calls = { embed: [], rerank: [] }, warnings = []
  const store = createAgentSemanticMemoryStore(redis.storage)
  const behavior = { embed: undefined, rerank: undefined }
  let serial = 0, acquired = 0, released = 0, composer, memory, backend
  let currentVector = options.vector ?? (() => [1, 0, 0])
  const config = { enabled: true, topK: 5, minScore: 0.8, timeoutMs: 5000, ...options.config }
  const recallKey = (target, messageId) => JSON.stringify([conversationAddressKey(target), messageId])
  const f = {
    ...redis, clock, store, calls, behavior, warnings, config,
    get composer() { return composer },
    get memory() { return memory },
    get backend() { return backend },
    get activeTurns() { return activeTurns.size },
    get turns() { return { acquired, released } },
    binding(target = room) { return bindings.get(conversationAddressKey(target)) },
    bind(target = room, agentId = 'writer', revision = 'revision-one') {
      const binding = { target: structuredClone(target), agentId, revision, source: 'configured',
        id: conversationAddressKey(target), personaId: 'same-persona', connectionId: `connection-${target.account.id}` }
      bindings.set(conversationAddressKey(target), binding)
      return binding
    },
    subject(target = room, author = actor, agentId = f.binding(target).agentId) {
      const address = personMemoryAddress(target, author.id)
      return { identity: { botId: address.botId, personaId: agentPersonaScopeId(agentId) }, subjectId: author.id, scene: address.scene }
    },
    state(target = room, agentId = f.binding(target).agentId) {
      return store.read(agentSemanticMemoryId({ agentId, target }))
    },
    recall(target, messageId) { recalled.add(recallKey(target, messageId)) },
    unavailable(target) { unavailable.add(conversationAddressKey(target)) },
    async capture(text, input = {}) {
      clock.at++
      const target = input.target ?? room
      const incoming = { version: 1, conversation: target, sender: input.author ?? actor, senderName: '来源作者',
        messageId: input.messageId ?? `source-${++serial}`, occurredAt: clock.at, text,
        parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...input.message }
      await composer.capture(incoming, input.binding ?? f.binding(target), input.guard ?? (() => true))
      return incoming
    },
    read(query, target = room, input = {}) {
      return composer.read(input.binding ?? f.binding(target), query, input.guard ?? (() => true), input.signal, input.excludeMessageIds)
    },
    async indexed(target = room) {
      return waitFor(async () => {
        await composer.tick()
        const state = await f.state(target)
        return state?.rows.length && state.rows.every(row => row.vector && row.providerId === backend.id) && state
      }, `persisted vectors in ${target.id}`)
    },
    async drained() { await waitFor(() => activeTurns.size === 0, 'memory turns released') },
    async restart(next = {}) {
      await composer?.stop()
      currentVector = next.vector ?? currentVector
      memory = createPersonMemoryStore({ redis: redis.storage, now: () => clock.at })
      backend = {
        id: next.id ?? backend?.id ?? providerA,
        async embed(texts, context) {
          const call = { texts: [...texts], context, providerId: backend.id }
          calls.embed.push(call)
          return behavior.embed ? behavior.embed(call) : texts.map(currentVector)
        },
        async rerank(query, documents, context) {
          const call = { query, documents: structuredClone(documents), context, providerId: backend.id }
          calls.rerank.push(call)
          return behavior.rerank ? behavior.rerank(call) : new Map(documents.map(document => [document.id, 1]))
        },
      }
      composer = createAgentSemanticMemory({
        redis: redis.storage, memory, backend, config: () => config, now: () => clock.at,
        resolve: target => { const binding = f.binding(target); return binding && { binding } },
        available: target => !unavailable.has(conversationAddressKey(target)),
        privatePeer: target => target.kind === 'private' ? actor.id : undefined,
        isRecalled: async (target, messageId) => recalled.has(recallKey(target, messageId)),
        isRunning: () => redis.isCurrent(), allowsText: text => !text.includes('blocked-source'),
        async begin(binding) {
          const controller = new AbortController()
          activeTurns.add(controller); acquired++
          return { signal: controller.signal,
            isCurrent: () => !controller.signal.aborted && redis.isCurrent() &&
              agentBindingToken(f.binding(binding.target)) === agentBindingToken(binding),
            release() { if (activeTurns.delete(controller)) released++ },
          }
        },
        logger: { warn: message => warnings.push(message) },
        ...(options.retrieval ? { retrieval: options.retrieval } : {}),
      })
      composers.push(composer)
    },
  }
  for (const target of [room, otherRoom, otherAccountRoom, privateRoom]) f.bind(target)
  await f.restart()
  return f
}

test('capture persists independent original sources without model calls, while repeated background ticks persist every vector', redisTest, async t => {
  const f = await fixture(t)
  const originals = []
  for (let index = 0; index < 12; index++) originals.push(await f.capture(`orchard observation ${index}`))
  assert.deepEqual(f.calls, { embed: [], rerank: [] })
  const before = await f.state()
  assert.equal(before.rows.length, originals.length)
  assert.deepEqual(before.rows.map(row => row.text), originals.map(message => message.text))
  assert.ok(before.rows.every(row => row.vector === undefined && row.providerId === undefined))
  const subject = f.subject()
  assert.deepEqual(await f.memory.listSubjects(subject.identity), [{ identity: subject.identity, subjectId: actor.id }])
  assert.deepEqual(await f.memory.scenes({ ...f.subject(privateRoom), viewerUserId: actor.id }), [subject.scene])
  assert.deepEqual((await f.memory.query({ ...subject, viewerUserId: actor.id })).items, [])
  const after = await f.indexed()
  assert.equal(after.rows.length, 12)
  assert.deepEqual(f.calls.embed.flatMap(call => call.texts).sort(), originals.map(message => message.text).sort())
  assert.ok(f.calls.embed.every(call => call.context.target.id === room.id))
  assert.deepEqual(after.rows.map(row => row.vector), originals.map(() => [1, 0, 0]))
  await f.drained()
  assert.deepEqual(f.turns, { acquired: f.turns.released, released: f.turns.released })
})

test('a reconstructed composer recalls a synonym with no shared keywords only after durable semantic indexing', redisTest, async t => {
  const original = 'physician prescribed jogging'
  const synonym = 'doctor recommended exercise'
  const f = await fixture(t, { vector: text => text === original || text === synonym ? [1, 0, 0] : [0, 1, 0] })
  await f.capture(original)
  await f.capture('astronomer photographed nebula')
  assert.equal((await f.read(synonym)).text, '')
  await f.indexed()
  const persisted = await f.state()
  const previousMemory = f.memory, previousComposer = f.composer
  await f.restart()
  assert.notEqual(f.memory, previousMemory)
  assert.notEqual(f.composer, previousComposer)
  assert.deepEqual(await f.state(), persisted)
  const callsBeforeRead = f.calls.embed.length
  const projection = await f.read(synonym)
  assert.match(projection.text, /physician prescribed jogging/u)
  assert.doesNotMatch(projection.text, /astronomer photographed nebula/u)
  assert.equal(await projection.isCurrent(), true)
  assert.deepEqual(f.calls.embed.slice(callsBeforeRead).map(call => call.texts), [[synonym]])
})

test('account, Agent and conversation boundaries isolate a corpus even when vectors and persona names are identical', redisTest, async t => {
  const f = await fixture(t)
  const entries = [[room, 'alpha apples archive'], [otherRoom, 'beta birches archive'], [otherAccountRoom, 'gamma gardens archive']]
  for (const [target, text] of entries) await f.capture(text, { target })
  for (const [target] of entries) await f.indexed(target)
  for (const [target, expected] of entries) {
    const projection = await f.read('unrelated semantic probe', target)
    assert.ok(projection.text.includes(expected))
    for (const [, forbidden] of entries) if (forbidden !== expected) assert.ok(!projection.text.includes(forbidden))
  }
  f.bind(room, 'other-writer', 'revision-two')
  assert.equal((await f.read('unrelated semantic probe')).text, '')
  await f.capture('delta dahlias archive')
  await f.indexed()
  assert.match((await f.read('unrelated semantic probe')).text, /delta dahlias archive/u)
  assert.doesNotMatch((await f.read('unrelated semantic probe')).text, /alpha apples archive/u)
  f.bind(room, 'writer', 'revision-three')
  const restored = await f.read('unrelated semantic probe')
  assert.match(restored.text, /alpha apples archive/u)
  assert.doesNotMatch(restored.text, /delta dahlias archive/u)
})

test('current and unread source IDs are excluded from both recall projections and rerank documents', redisTest, async t => {
  const f = await fixture(t)
  const retained = await f.capture('retained historical observation')
  const current = await f.capture('current message observation')
  const unread = await f.capture('unread queue observation')
  await f.indexed()
  const projection = await f.read('semantic probe', room, { excludeMessageIds: [current.messageId, unread.messageId] })
  assert.ok(projection.text.includes(retained.text))
  assert.ok(!projection.text.includes(current.text))
  assert.ok(!projection.text.includes(unread.text))
  assert.equal(f.calls.rerank.length, 0)
})

test('forwarded and quoted bodies never become the sender source or provider input', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('forwarded secret', { message: { parts: [{ kind: 'text', text: 'forwarded secret' }, { kind: 'forward', id: 'forward-node' }] } })
  const quote = { messageId: 'quoted-source', author: otherActor, text: 'quoted secret', parts: [{ kind: 'text', text: 'quoted secret' }] }
  await f.capture('quoted secret', { message: { parts: [], quote } })
  const own = await f.capture('quoted secret plus own observation', { message: { quote,
    parts: [{ kind: 'text', text: 'own observation' }, { kind: 'image', name: 'media secret description' }] } })
  assert.deepEqual((await f.state()).rows.map(row => ({ messageId: row.messageId, authorId: row.authorId, text: row.text })),
    [{ messageId: own.messageId, authorId: actor.id, text: 'own observation' }])
  await f.indexed()
  assert.deepEqual(f.calls.embed.flatMap(call => call.texts), ['own observation'])
  assert.deepEqual((await f.memory.listSubjects(f.subject().identity)).map(subject => subject.subjectId), [actor.id])
})

test('opt-out, host recall and source revocation forbid capture and indexing before provider I/O', redisTest, async t => {
  const f = await fixture(t)
  await f.memory.setEnabled({ ...f.subject(room, otherActor), enabled: false, scene: f.subject().scene })
  await f.capture('disabled author source', { author: otherActor })
  f.recall(room, 'already-recalled')
  await f.capture('recalled before capture', { messageId: 'already-recalled' })
  await f.memory.revokeSource({ ...f.subject(), messageId: 'already-revoked' })
  await f.capture('revoked before capture', { messageId: 'already-revoked' })
  assert.equal(await f.state(), undefined)
  const recalled = await f.capture('recalled before indexing')
  const revoked = await f.capture('revoked before indexing')
  await f.capture('disabled before indexing', { target: otherRoom, author: otherActor })
  await f.memory.setEnabled({ ...f.subject(otherRoom, otherActor), enabled: false })
  f.recall(room, recalled.messageId)
  await f.memory.revokeSource({ ...f.subject(), messageId: revoked.messageId })
  await f.composer.tick()
  await waitFor(async () => (await f.state())?.rows.length === 0, 'forbidden corpus rows removed')
  await waitFor(async () => (await f.state(otherRoom))?.rows.length === 0, 'opted-out corpus rows removed')
  await f.drained()
  assert.deepEqual((await f.state()).rows, [])
  assert.deepEqual(f.calls, { embed: [], rerank: [] })
  assert.equal((await f.read('recalled before indexing')).text, '')
})

test('forget during pending indexing blocks a late vector commit and subsequent prompt injection', redisTest, async t => {
  const f = await fixture(t)
  const pending = Promise.withResolvers()
  f.behavior.embed = () => pending.promise
  t.after(() => pending.resolve([[1, 0, 0]]))
  const original = await f.capture('forgotten pending source')
  await f.composer.tick()
  await waitFor(() => f.calls.embed.length === 1, 'pending index provider call')
  assert.deepEqual(f.calls.embed[0].texts, [original.text])
  await f.memory.forget({ ...f.subject(), sourceMessageId: original.messageId })
  pending.resolve([[1, 0, 0]])
  await f.drained()
  assert.ok((await f.state()).rows.every(row => row.vector === undefined))
  assert.equal((await f.read('forgotten pending source')).text, '')
  assert.equal(f.calls.embed.length, 1)
})

test('source deletion during embedding invalidates the provider guard and cannot recreate a vector corpus', redisTest, async t => {
  const f = await fixture(t)
  const pending = Promise.withResolvers()
  f.behavior.embed = () => pending.promise
  t.after(() => pending.resolve([[1, 0, 0]]))
  await f.capture('removed pending source')
  await f.composer.tick()
  await waitFor(() => f.calls.embed.length === 1, 'pending source deletion provider call')
  const request = f.calls.embed[0]
  await f.store.update(agentSemanticMemoryId(f.binding()), () => undefined)
  await assert.rejects(() => request.context.ensureCurrent())
  pending.resolve([[1, 0, 0]])
  await f.drained()
  assert.equal(await f.state(), undefined)
  assert.equal((await f.read('removed pending source')).text, '')
  assert.equal(f.calls.embed.length, 1)
})

test('forget while reranking rejects the late recall instead of retaining erased documents', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('violet horticulture notes')
  await f.capture('indigo gardening journal')
  await f.indexed()
  const pending = Promise.withResolvers()
  f.behavior.rerank = () => pending.promise
  t.after(() => pending.resolve(new Map()))
  const result = f.read('flower cultivation question').then(value => ({ value }), error => ({ error }))
  await waitFor(() => f.calls.rerank.length === 1, 'pending rerank provider call')
  assert.deepEqual(f.calls.rerank[0].documents.map(document => document.text).sort(), ['indigo gardening journal', 'violet horticulture notes'])
  await f.memory.forget(f.subject())
  pending.resolve(new Map(f.calls.rerank[0].documents.map(document => [document.id, 1])))
  const outcome = await result
  assert.ok(outcome.error instanceof Error)
  assert.equal(outcome.value, undefined)
  assert.equal((await f.read('flower cultivation question')).text, '')
})

for (const stage of ['index', 'query']) {
  for (const cancellation of ['rebind', 'stop']) {
    test(`${cancellation} cancels ${stage} without waiting for an unresponsive provider`, redisTest, async t => {
      const f = await fixture(t)
      await f.capture('cancellation source')
      if (stage === 'query') await f.indexed()
      const before = f.calls.embed.length
      f.behavior.embed = () => new Promise(() => {})
      let query
      if (stage === 'query') query = f.read('pending synonym').then(value => ({ value }), error => ({ error }))
      else await f.composer.tick()
      await waitFor(() => f.calls.embed.length > before, `unresponsive ${stage} provider`)
      const request = f.calls.embed.at(-1)
      if (cancellation === 'rebind') f.bind(room, 'writer', 'replacement-binding')
      else await Promise.race([f.composer.stop(), delay(1000).then(() => assert.fail('stop waited for an unresponsive provider'))])
      await waitFor(() => request.context.signal.aborted, `${cancellation} reaches provider signal`, 1000)
      await f.drained()
      if (query) {
        const outcome = await query
        assert.ok(outcome.error instanceof Error)
        assert.equal(outcome.value, undefined)
      } else assert.ok((await f.state()).rows.every(row => row.vector === undefined))
      assert.equal(request.context.isCurrent(), false)
    })
  }
}

test('retained recall projections become invalid after their source is forgotten or recalled', redisTest, async t => {
  const f = await fixture(t)
  const first = await f.capture('first retained source')
  await f.indexed()
  const forgotten = await f.read('first retained source')
  assert.match(forgotten.text, /first retained source/u)
  assert.equal(await forgotten.isCurrent(), true)
  await f.memory.forget({ ...f.subject(), sourceMessageId: first.messageId })
  assert.equal(await forgotten.isCurrent(), false)
  const second = await f.capture('second retained source', { author: otherActor })
  await f.indexed()
  const recalled = await f.read('second retained source')
  assert.match(recalled.text, /second retained source/u)
  assert.equal(await recalled.isCurrent(), true)
  await f.memory.revokeSource({ ...f.subject(room, otherActor), messageId: second.messageId })
  assert.equal(await recalled.isCurrent(), false)
})

test('deleting a persisted source invalidates an already returned projection', redisTest, async t => {
  const f = await fixture(t)
  const original = await f.capture('evicted original source')
  await f.indexed()
  const projection = await f.read('evicted original source')
  assert.ok(projection.text.includes(original.text))
  assert.equal(await projection.isCurrent(), true)
  await f.store.update(agentSemanticMemoryId(f.binding()), () => undefined)
  assert.equal(await f.state(), undefined)
  assert.equal(await projection.isCurrent(), false)
})

test('unattributed queries stay local under any same-scene opt-out while another scene does not block embedding or reranking', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('copper observatory handbook')
  await f.capture('copper telescope maintenance')
  await f.indexed()
  await f.memory.setEnabled({ ...f.subject(otherRoom, otherActor), enabled: false })
  const beforeRemote = f.calls.embed.length
  const remote = await f.read('copper')
  assert.match(remote.text, /copper observatory handbook/u)
  assert.match(remote.text, /copper telescope maintenance/u)
  assert.deepEqual(f.calls.embed.slice(beforeRemote).map(call => call.texts), [['copper']])
  assert.equal(f.calls.rerank.length, 1)
  await f.memory.setEnabled({ ...f.subject(room, otherActor), enabled: false })
  const beforeLocal = { embed: f.calls.embed.length, rerank: f.calls.rerank.length }
  const local = await f.read('copper')
  assert.match(local.text, /copper observatory handbook/u)
  assert.match(local.text, /copper telescope maintenance/u)
  assert.deepEqual({ embed: f.calls.embed.length, rerank: f.calls.rerank.length }, beforeLocal)
  assert.equal(await local.isCurrent(), true)
})

test('retention and per-conversation bounds remove stale sources before embedding or recall', redisTest, async t => {
  const f = await fixture(t, { config: { maxMessagesPerConversation: 50, retentionDays: 1 } })
  const originals = []
  for (let index = 0; index < 55; index++) originals.push(await f.capture(`bounded corpus observation ${index}`))
  assert.deepEqual((await f.state()).rows.map(row => row.messageId), originals.slice(-50).map(message => message.messageId))
  assert.equal(f.calls.embed.length, 0)
  f.clock.at += DAY + 1
  await f.composer.tick()
  await waitFor(async () => (await f.state()) === undefined, 'expired corpus removed')
  await f.drained()
  assert.equal(await f.state(), undefined)
  assert.equal(f.calls.embed.length, 0)
  assert.equal((await f.read('bounded corpus observation')).text, '')
  await f.capture('fresh retained observation')
  await f.indexed()
  assert.deepEqual(f.calls.embed.flatMap(call => call.texts), ['fresh retained observation'])
  assert.match((await f.read('fresh retained observation')).text, /fresh retained observation/u)
})

test('a provider identity change never interprets old vectors in the new embedding space', redisTest, async t => {
  const original = 'physician prescribed jogging'
  const newQuery = 'alternate coordinate question'
  const f = await fixture(t)
  await f.capture(original)
  await f.indexed()
  assert.match((await f.read('doctor recommended exercise')).text, /physician prescribed jogging/u)
  await f.restart({ id: providerB, vector: text => text === newQuery ? [1, 0, 0] : [0, 1, 0] })
  const oldState = await f.state()
  assert.equal(oldState.rows[0].providerId, providerA)
  assert.deepEqual(oldState.rows[0].vector, [1, 0, 0])
  assert.equal((await f.read(newQuery)).text, '')
  const reindexed = await f.indexed()
  assert.equal(reindexed.rows[0].providerId, providerB)
  assert.deepEqual(reindexed.rows[0].vector, [0, 1, 0])
  assert.equal((await f.read(newQuery)).text, '')
  assert.match((await f.read('doctor recommended exercise')).text, /physician prescribed jogging/u)
  assert.ok(f.calls.embed.some(call => call.providerId === providerB && call.texts.includes(original)))
})

test('private corpus attribution requires the proven peer and never accepts a different sender', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('unproven private sender', { target: privateRoom, author: otherActor })
  assert.equal(await f.state(privateRoom), undefined)
  const source = await f.capture('proven private sender', { target: privateRoom })
  const state = await f.indexed(privateRoom)
  assert.equal(state.rows[0].messageId, source.messageId)
  assert.equal(state.rows[0].peerId, actor.id)
  assert.equal(state.rows[0].authorId, actor.id)
  assert.deepEqual(f.calls.embed.flatMap(call => call.texts), ['proven private sender'])
})

test('actual Core read traces complete and partially clipped evidence without changing the public recall contract', redisTest, async t => {
  let trace
  const f = await fixture(t, { retrieval: { observe: value => { trace = value } } })
  const originals = []
  for (let index = 0; index < 5; index++) originals.push(await f.capture(`source ${index}: ${'retained evidence '.repeat(85)}`))
  await f.indexed()
  const recall = await f.read('remember the retained material')
  assert.deepEqual(Object.keys(recall).sort(), ['isCurrent', 'text'])
  assert.equal(await recall.isCurrent(), true)
  assert.equal(trace.mode, 'production')
  assert.equal(trace.selected.length, 5)
  assert.equal(trace.projected.length, 4)
  assert.equal(trace.projected.filter(item => item.complete).length, 3)
  assert.equal(trace.projected.at(-1).complete, false)
  const scopeId = agentSemanticMemoryId(f.binding())
  assert.deepEqual(trace.authorized, originals.map(message => ({ scopeId, messageId: message.messageId })))
  assert.equal(recall.text.includes(originals[3].text), false)
  assert.equal(recall.text.includes(originals[4].text), false)
})

test('BM25 experiment uses actual source guards and never calls the remote query or reranker', redisTest, async t => {
  let trace
  const f = await fixture(t, { retrieval: { mode: 'bm25', observe: value => { trace = value } } })
  const kept = await f.capture('copper observatory handbook')
  const recalled = await f.capture('copper forbidden observation')
  await f.indexed()
  f.recall(room, recalled.messageId)
  const before = { embed: f.calls.embed.length, rerank: f.calls.rerank.length }
  const recall = await f.read('copper')
  assert.match(recall.text, /copper observatory handbook/u)
  assert.doesNotMatch(recall.text, /forbidden observation/u)
  assert.deepEqual({ embed: f.calls.embed.length, rerank: f.calls.rerank.length }, before)
  assert.deepEqual(trace.authorized.map(item => item.messageId), [kept.messageId])
  assert.equal(trace.embedding, 'not-used')
  assert.equal(trace.rerank, 'disabled')
})

test('Core deadline is reported as a timeout and still releases the read lease', redisTest, async t => {
  const f = await fixture(t, { config: { timeoutMs: 200 } })
  await f.capture('indexed source for the deadline')
  await f.indexed()
  f.behavior.embed = () => new Promise(() => {})
  await assert.rejects(f.read('unresponsive semantic query'), { code: 'semantic_memory_timeout' })
  await f.drained()
  assert.equal(f.activeTurns, 0)
})
