import test from 'node:test'
import assert from 'node:assert/strict'
import { createSimSessionStore } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { createSimTools } from '../dist/backend/modules/simulation/infrastructure/simTools.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { buildPersonCards, normalizeSimMemoryEntry, defaultAffinityEntry } from '../dist/backend/modules/simulation/domain/simMemory.js'
import { parsePersonProfilePatches, groundPersonProfileCandidate } from '../dist/backend/modules/simulation/domain/personProfile.js'
import { addCharacterMemory, recordCharacterReceipt, createCharacterGoal, createEmptyCharacterState, characterMemoryVisibility, formatCharacterSection } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createCharacterTools } from '../dist/backend/modules/simulation/infrastructure/characterTools.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { createCharacterSharedSelf } from '../dist/backend/modules/simulation/infrastructure/characterSharedSelf.js'
import { agentBindingToken, createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'

const BASE = 1790000000000
const IDENTITY = { botId: '90000', personaId: 'shiloh' }
const USER = '10001'
const A = { ...IDENTITY, groupId: '10086' }, B = { ...IDENTITY, groupId: '10087' }
function fixture() {
  const data = new Map(), clock = { at: BASE }
  const redis = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); return 'OK' }, del: async (...keys) => keys.reduce((n, key) => n + Number(data.delete(key)), 0), keys: async pattern => [...data.keys()].filter(key => key.startsWith(pattern.replace('*', ''))) }
  const scoped = scope => createSimSessionStore({ redis, characterScope: scope, now: () => clock.at })
  return { data, clock, redis, scoped, core: createPersonMemoryStore({ redis, now: () => clock.at }) }
}
const source = (groupId, messageId, excerpt, at = BASE) => ({ scene: { kind: 'group', id: groupId }, messageId, authorId: USER, at, excerpt })
const memory = (category, text, evidence, portable = true) => ({ category, text, source: evidence, evidenceKind: 'self', sensitivity: 'ordinary', portable })

test('scoped profiles share evidenced preferences while quarantining old strings, events and other identities', async () => {
  const h = fixture(), a = h.scoped(A), b = h.scoped(B)
  h.data.set(`shiloh:sim:person:${USER}`, JSON.stringify({ name: '原群私下外号', interests: ['未经核实旧兴趣'], taboos: [] }))
  assert.deepEqual(await b.loadPersonProfile(USER), { interests: [], taboos: [] })
  await a.mergePersonProfile(USER, { name: '没有来源的模型猜测', facts: ['很稳定的私事'] }, 12)
  assert.deepEqual(await b.loadPersonProfile(USER), { interests: [], taboos: [] })
  await a.mergePersonProfile(USER, { memories: [
    memory('interest', '爵士乐', source(A.groupId, 'm1', '我一直很喜欢爵士乐')),
    memory('event', '下周去面试', source(A.groupId, 'm2', '我下周去面试')),
    memory('name', '阿林', source(A.groupId, 'm3', '平时都叫我阿林就好')),
  ] }, 12)
  assert.deepEqual((await b.loadPersonProfile(USER)).interests, ['爵士乐'])
  assert.equal((await b.loadPersonProfile(USER)).name, '阿林')
  assert.equal(JSON.stringify(await b.loadPersonProfile(USER)).includes('面试'), false)
  assert.deepEqual(await h.scoped({ ...B, botId: '90001' }).loadPersonProfile(USER), { interests: [], taboos: [] })
  assert.deepEqual(await h.scoped({ ...B, personaId: 'other' }).loadPersonProfile(USER), { interests: [], taboos: [] })
  const privateView = await h.core.query({ identity: IDENTITY, subjectId: USER, scene: { kind: 'private', id: USER }, viewerUserId: USER })
  assert.ok(privateView.items.some(entry => entry.text === '下周去面试'))
})

test('extractor source index and excerpt must belong to the exact author; snippets and privacy fail closed', () => {
  const messages = [{ userId: USER, text: '我一直很喜欢爵士乐' }, { userId: '10002', text: '小林好像最近换工作了' }]
  const [patch] = parsePersonProfilePatches(JSON.stringify([{ userId: USER, entries: [
    { category: 'interest', text: '爵士乐', sourceIndex: 1, sourceExcerpt: '很喜欢爵士乐', portable: true, sensitivity: 'ordinary' },
    { category: 'fact', text: '换工作', sourceIndex: 2, sourceExcerpt: '换工作', portable: true, sensitivity: 'ordinary' },
  ] }]))
  assert.equal(patch.entries.length, 2)
  assert.equal(groundPersonProfileCandidate(patch, patch.entries[0], messages), messages[0])
  assert.equal(groundPersonProfileCandidate(patch, patch.entries[1], messages), undefined)
  assert.equal(patch.entries[1].portable, false, 'a stable fact category does not authorize global use')
  assert.equal(groundPersonProfileCandidate(patch, { ...patch.entries[0], sourceExcerpt: '伪造原话' }, messages), undefined)
  assert.equal(groundPersonProfileCandidate(patch, patch.entries[0], [{ ...messages[0], textTruncated: true }]), undefined)
  assert.equal(groundPersonProfileCandidate(patch, patch.entries[0], [{ ...messages[0], forwardId: 'forward-other-author' }]), undefined)
})

test('simRemember binds host evidence and never calls the former heuristic portable promotion', async () => {
  const h = fixture(), store = h.scoped(A)
  let list = [], promoted = 0
  const tool = createSimTools({ now: () => h.clock.at, getMemories: () => list, saveMemories: async value => { await store.saveMemories(A.groupId, value); list = value },
    savePersonFact: async () => { promoted++ },
    preparePersonMemory: async (entry, seq, quote) => {
      assert.equal(seq, 7); assert.equal(quote, '我在准备换工作')
      const evidence = source(A.groupId, 'actual-message', quote)
      const result = await store.rememberPersonMemory({ subjectId: USER, text: entry.content, category: 'fact', source: evidence, evidenceKind: 'self', portable: true, sensitivity: 'ordinary' })
      assert.equal(result.saved, true)
      return { memoryIdentity: IDENTITY, memorySource: evidence, personMemoryId: result.entry.id }
    }, forgetPersonMemory: entry => store.forgetPersonMemory(USER, { id: entry.personMemoryId }),
  }).find(item => item.name === 'simRemember')
  const result = JSON.parse(await tool.func({ aboutUser: USER, content: '在准备换工作', sourceSeq: 7, sourceQuote: '我在准备换工作' }))
  assert.equal(result.saved, true)
  assert.equal(promoted, 0)
  assert.equal((await h.scoped(B).loadPersonProfile(USER)).facts, undefined)
  const persisted = normalizeSimMemoryEntry((await store.loadMemories(A.groupId))[0], BASE)
  assert.equal(persisted.memorySource.messageId, 'actual-message')
  assert.equal(persisted.memoryIdentity.personaId, IDENTITY.personaId)
  h.clock.at++
  await tool.func({ action: 'remove', id: list[0].id })
  assert.equal((await h.core.query({ identity: IDENTITY, subjectId: USER, scene: { kind: 'private', id: USER }, viewerUserId: USER })).items.length, 0)
  assert.equal((await store.loadMemories(A.groupId)).length, 0)
})

test('source revocation and administrative deletion survive restart and reject late profile extraction', async () => {
  const h = fixture(), a = h.scoped(A), b = h.scoped(B)
  const candidate = memory('interest', '爵士乐', source(A.groupId, 'm1', '我一直很喜欢爵士乐'))
  await a.mergePersonProfile(USER, { memories: [candidate] }, 12)
  h.clock.at++
  await a.revokePersonSource('m1')
  await h.scoped(A).mergePersonProfile(USER, { memories: [candidate] }, 12)
  assert.deepEqual((await b.loadPersonProfile(USER)).interests, [])
  const later = memory('preference', '回答简洁一点', source(A.groupId, 'm2', '以后回答我简洁一点', ++h.clock.at))
  await a.mergePersonProfile(USER, { memories: [later] }, 12)
  h.clock.at++
  await createSimSessionStore({ redis: h.redis, now: () => h.clock.at }).deletePersonProfile(USER)
  await a.mergePersonProfile(USER, { memories: [later] }, 12)
  assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).taboos, [])
})

test('field deletion removes portable copies without losing an unrelated preference', async () => {
  const h = fixture(), a = h.scoped(A)
  await a.mergePersonProfile(USER, { memories: [memory('interest', '爵士乐', source(A.groupId, 'm1', '我喜欢爵士乐')), memory('interest', '围棋', source(A.groupId, 'm2', '我喜欢围棋'))] }, 12)
  h.clock.at++
  await createSimSessionStore({ redis: h.redis, now: () => h.clock.at }).deletePersonProfileField(USER, 'interests', '爵士乐')
  assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, ['围棋'])
})

test('cross-group familiarity keeps the scoped score but never its original story', async () => {
  const h = fixture(), a = h.scoped(A)
  await a.bumpGlobalAffinity(USER, 3, 'A群向我倾诉家庭纠纷')
  assert.ok((await h.scoped(B).loadGlobalAffinity([USER]))[USER] > 50)
  assert.equal((await h.scoped({ ...B, botId: '90001' }).loadGlobalAffinity([USER]))[USER], undefined)
  assert.deepEqual(await a.loadGlobalAffinityNotes([USER]), {})
  const { section } = buildPersonCards({ affinity: { [USER]: defaultAffinityEntry(BASE) }, speakers: [USER], nameOf: () => '小林', globalAffinityNotes: { [USER]: ['A群向我倾诉家庭纠纷'] } })
  assert.doesNotMatch(section, /家庭|纠纷|跨群近况/)
})

test('scene familiarity is identity scoped and old reason strings cannot survive a privacy invalidation', async () => {
  const h = fixture(), a = h.scoped(A)
  await a.saveAffinity(A.groupId, { [USER]: { ...defaultAffinityEntry(BASE), reasons: ['小林在A群说了家庭私事'] } })
  assert.match(JSON.stringify(await a.loadAffinity(A.groupId)), /家庭私事/)
  assert.deepEqual(await h.scoped({ ...A, personaId: 'other' }).loadAffinity(A.groupId), {})
  h.clock.at++
  await h.core.forget({ identity: IDENTITY, subjectId: USER })
  const value = (await a.loadAffinity(A.groupId))[USER]
  assert.equal(value.score, 50)
  assert.deepEqual(value.reasons, [])
})

test('history readers recheck privacy after persistence or a pending forward fetch', async () => {
  for (const name of ['simGetUnreadMessages', 'simGetRecentMessages', 'simGetMessageDetail', 'simGetForward']) {
    const state = createDefaultSimSession(BASE)
    const message = { seq: 1, messageId: 'm1', userId: USER, name: '小林', text: '已删除的事情', at: BASE, imageCount: 0, kind: 'text' }
    state.seq = 1; state.unread = [message]; state.recent = [message]
    let reads = 0
    const tool = createSimTools({ now: () => BASE, getState: () => state, mutate: async fn => fn(state),
      getForward: async () => ({ lines: ['已删除的转发内容'] }),
      assertMemoryCurrent: async () => { if (++reads > 1) throw new Error('人物记忆来源已改变') },
    }).find(item => item.name === name)
    await assert.rejects(tool.func({ seq: 1, forwardId: 'f1' }), /人物记忆来源已改变/)
    assert.equal(reads, 2)
  }
})

test('chat-derived character memories become unreadable after invalidation while independent receipt facts remain', async () => {
  let state = createEmptyCharacterState(A)
  state = recordCharacterReceipt(state, { id: 'r1', toolName: 'searchInformationTool', status: 'pending', summary: '等候公开文档', at: BASE }, BASE)
  state = recordCharacterReceipt(state, { id: 'r1', toolName: 'searchInformationTool', status: 'succeeded', summary: '已检索公开文档', at: BASE }, BASE)
  state = addCharacterMemory(state, { id: 'chat', kind: 'experience', epistemic: 'reported', content: '小林的私事', evidenceRefs: ['message:1'] }, ['message:1'], BASE)
  state = addCharacterMemory(state, { id: 'derived', kind: 'opinion', epistemic: 'inferred', content: '据此形成的旧判断', evidenceRefs: ['memory:chat'] }, ['memory:chat'], BASE)
  state = addCharacterMemory(state, { id: 'public', kind: 'experience', epistemic: 'observed', content: '读取公开文档的经历', evidenceRefs: ['receipt:r1'] }, ['receipt:r1'], BASE)
  state = recordCharacterReceipt(state, { id: 'history', toolName: 'chatHistoryTool', status: 'pending', summary: '等待历史', at: BASE }, BASE)
  state = recordCharacterReceipt(state, { id: 'history', toolName: 'chatHistoryTool', status: 'succeeded', summary: '查到小林的私事', at: BASE }, BASE)
  state = addCharacterMemory(state, { id: 'history-derived', kind: 'opinion', epistemic: 'inferred', content: '从旧历史回执派生的私事', evidenceRefs: ['receipt:history'] }, ['receipt:history'], BASE)
  state = createCharacterGoal(state, { id: 'private-goal', title: '私事安排', motivation: '旧私事', nextStep: '询问', completionCriteria: '知道后续', stopConditions: ['来源失效'], evidenceRefs: ['memory:derived'] }, ['memory:derived'], BASE)
  state = createCharacterGoal(state, { id: 'public-goal', title: '研究公开文档', motivation: '公开资料兴趣', nextStep: '阅读', completionCriteria: '理解文档', stopConditions: ['资料不可用'], evidenceRefs: ['receipt:r1'] }, ['receipt:r1'], BASE)
  const view = characterMemoryVisibility(state, BASE + 1)
  assert.deepEqual(view.memories.map(item => item.id), ['public'])
  assert.deepEqual(view.goals.map(item => item.id), ['public-goal'])
  assert.equal(view.receipts.length, 1)
  assert.doesNotMatch(formatCharacterSection(state, BASE + 1), /小林的私事|旧判断|私事安排/)
  assert.match(formatCharacterSection(state, BASE + 1), /公开文档/)
  assert.equal(state.memories.length, 4, 'projection cannot destructively rewrite the source store')
  const tools = createCharacterTools({ now: () => BASE + 2, read: async () => state, update: async fn => (state = fn(state)), visibleEvidenceRefs: () => ['receipt:r1', 'memory:public'], memoryInvalidatedAt: () => BASE + 1, makeId: () => 'new', selectGoal: async () => {}, onDecision() {} })
  assert.deepEqual((await tools.find(tool => tool.name === 'simCharacterMemory').func({ action: 'list' })).memories.map(item => item.id), ['public'])
  await assert.rejects(tools.find(tool => tool.name === 'simGoal').func({ action: 'focus', id: 'private-goal' }), /来源已失效/)
  state = addCharacterMemory(state, { id: 'replacement', kind: 'opinion', epistemic: 'inferred', content: '旧私事的替换判断', supersedes: 'chat', evidenceRefs: ['memory:chat'] }, ['memory:chat'], BASE + 2)
  assert.equal(characterMemoryVisibility(state, BASE + 1).memories.some(item => item.id === 'replacement'), false)
})

test('approved character sharing cannot carry forgotten chat-derived content to another group', async () => {
  const h = fixture(), characters = createCharacterStore({ redis: h.redis, now: () => h.clock.at })
  await characters.update(A, state => addCharacterMemory(state, { id: 'chat-opinion', kind: 'opinion', epistemic: 'inferred', content: '来自一次聊天的判断', evidenceRefs: ['message:1'] }, ['message:1'], BASE))
  const shared = createCharacterSharedSelf({ redis: h.redis, scope: A, now: () => h.clock.at })
  const id = await shared.propose('chat-opinion'); await shared.approve(id)
  const other = createCharacterSharedSelf({ redis: h.redis, scope: B, now: () => h.clock.at })
  assert.equal((await other.projection()).length, 1)
  h.clock.at++
  await h.core.forget({ identity: IDENTITY, subjectId: USER })
  assert.deepEqual(await other.projection(), [])
  assert.equal((await characters.load(A)).memories.length, 1)
})

function profileSweepFixture({ getPersona, personProfileExtract, ports = {} } = {}) {
  const h = fixture(), state = createDefaultSimSession(BASE)
  state.botId = IDENTITY.botId; state.personaId = IDENTITY.personaId; state.bootstrapSent = true
  state.seq = 20; state.lastIncomingAt = BASE; state.nextProactiveCheckAt = BASE + 86400000; state.nextReplyCheckAt = BASE + 86400000
  state.recent = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, messageId: `m${i + 1}`, userId: USER, name: '仅A群使用的名字', text: i === 0 ? '我一直很喜欢爵士乐' : `闲聊消息${i}`, at: BASE, atSelf: false, quoteToSelf: false, imageCount: 0, kind: 'text' }))
  const sessionKey = `shiloh:sim:g:${A.groupId}`
  if (getPersona) state.bindingToken = agentBindingToken(getPersona().binding)
  h.data.set(sessionKey, JSON.stringify(state))
  h.data.set('shiloh:sim:known', JSON.stringify([A.groupId]))
  h.data.set('shiloh:sim:overrides', JSON.stringify({ explicitEnabled: [A.groupId], disabled: [], atOnly: [A.groupId], budgetCaps: {}, turnCaps: {} }))
  let calls = 0
  const tokens = []
  const runtime = createSimulationRuntime({ redis: h.redis, now: () => h.clock.at, random: () => 0.99,
    logger: { info() {}, warn() {}, error() {} }, getSelf: () => ({ id: IDENTITY.botId, name: '机器人' }), getPersona: getPersona ?? (() => ({ personaId: IDENTITY.personaId, persona: {}, systemContent: '' })),
    getSection: () => ({ enabled: true, allGroups: false, groups: [A.groupId], mood: { enabled: false }, rhythm: { enabled: false }, userStyle: { enabled: false }, personProfile: { enabled: true }, meme: { enabled: false }, lifeThreads: { enabled: false }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 } }),
    getExecutionConfig: () => ({}), YTapi: async () => { throw new Error('no main conversation') }, sendGroupMessage: async () => { throw new Error('no delivery') },
    recordTokens: input => tokens.push(input), ...ports,
    personProfileExtract: async (messages, isCurrent, context) => {
      calls++
      if (personProfileExtract) return await personProfileExtract(messages, isCurrent, context)
      return JSON.stringify([{ userId: USER, entries: [{ category: 'interest', text: '爵士乐', sourceIndex: 1, sourceExcerpt: '我一直很喜欢爵士乐', portable: true, sensitivity: 'ordinary' }] }, { userId: '20002', entries: [{ category: 'name', text: '别人', sourceIndex: 1, sourceExcerpt: '我一直很喜欢爵士乐', portable: true, sensitivity: 'ordinary' }] }])
    },
  })
  return { h, runtime, sessionKey, calls: () => calls, tokens }
}

function extractionPatch() {
  return JSON.stringify([{ userId: USER, entries: [{ category: 'interest', text: '爵士乐', sourceIndex: 1,
    sourceExcerpt: '我一直很喜欢爵士乐', portable: true, sensitivity: 'ordinary' }] }])
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(check, label) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('runtime background extraction grounds the author, stores source provenance and never promotes group nicknames', async () => {
  const { h, runtime, calls } = profileSweepFixture()
  try {
    await runtime.sweepOnce()
    assert.equal(calls(), 1)
    const profile = await h.scoped(B).loadPersonProfile(USER)
    assert.deepEqual(profile.interests, ['爵士乐'])
    assert.equal(profile.name, undefined)
    assert.deepEqual((await h.scoped(B).loadPersonProfile('20002')).interests, [])
    const entries = await h.core.query({ identity: IDENTITY, subjectId: USER, scene: { kind: 'private', id: USER }, viewerUserId: USER })
    assert.equal(entries.items[0].source.messageId, 'm1')
    await runtime.handleRecall({ group_id: A.groupId, message_id: 'm1' })
    assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
  } finally { runtime.stop() }
})

function profileBinding(agentId, revision) {
  const account = { platform: 'qq', namespace: 'global', id: IDENTITY.botId }
  const target = { account, kind: 'group', id: A.groupId }
  return createAgentBindingDirectory({ version: 1, agents: [{ id: agentId, personaId: 'default' }],
    connections: [{ id: 'qq-profile', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'qq-profile', kind: target.kind, conversationId: target.id, agentId }],
  }, revision).resolve(target)
}

test('a QQ role change during the activity storage read stops background profile extraction before dispatch', async () => {
  let binding = profileBinding('first', 'old-revision')
  const { h, runtime, sessionKey, calls } = profileSweepFixture({ getPersona: () => ({ binding, persona: {}, systemContent: '' }) })
  const get = h.redis.get
  let checkedActivity = false
  h.redis.get = async key => {
    const value = await get(key)
    if (key === `${sessionKey}:activity-version` && !checkedActivity) {
      checkedActivity = true
      binding = profileBinding('second', 'new-revision')
    }
    return value
  }
  try {
    await runtime.sweepOnce()
    assert.equal(checkedActivity, true)
    assert.equal(calls(), 0)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
  } finally { runtime.stop() }
})

test('background profile extraction supplies a live guard and discards the result after a QQ role change', async () => {
  let binding = profileBinding('first', 'old-revision')
  const firstScope = { ...A, personaId: 'agent:first' }
  const secondScope = { ...A, personaId: 'agent:second' }
  const { h, runtime, sessionKey, calls } = profileSweepFixture({
    getPersona: () => ({ binding, persona: {}, systemContent: '' }),
    async personProfileExtract(messages, isCurrent) {
      assert.match(messages[0].text, /爵士乐/u)
      assert.equal(isCurrent(), true)
      await Promise.resolve()
      binding = profileBinding('second', 'new-revision')
      assert.equal(isCurrent(), false)
      return JSON.stringify([{ userId: USER, entries: [{ category: 'interest', text: '爵士乐', sourceIndex: 1,
        sourceExcerpt: '我一直很喜欢爵士乐', portable: true, sensitivity: 'ordinary' }] }])
    },
  })
  try {
    await runtime.sweepOnce()
    assert.equal(calls(), 1)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
    assert.deepEqual((await h.scoped(firstScope).loadPersonProfile(USER)).interests, [])
    assert.deepEqual((await h.scoped(secondScope).loadPersonProfile(USER)).interests, [])
  } finally { runtime.stop() }
})

test('stopping background extraction aborts its context and prevents late facts or cursor progress', { timeout: 5000 }, async () => {
  const entered = deferred(), held = deferred()
  const { h, runtime, sessionKey } = profileSweepFixture({
    async personProfileExtract(_messages, isCurrent, context) {
      entered.resolve({ isCurrent, context })
      await held.promise
      return extractionPatch()
    },
  })
  let sweep
  try {
    sweep = runtime.sweepOnce()
    const { isCurrent, context } = await entered.promise
    assert.equal(context.signal.aborted, false)
    assert.equal(isCurrent(), true)
    runtime.stop()
    assert.equal(context.signal.aborted, true)
    assert.equal(isCurrent(), false)
    held.resolve()
    await sweep
    assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
    await assert.rejects(context.ensureCurrent())
  } finally {
    runtime.stop(); held.resolve()
    if (sweep) await sweep
  }
})

test('recall during extraction aborts the request and cannot restore the source or advance its cursor', { timeout: 5000 }, async () => {
  const entered = deferred(), held = deferred()
  const { h, runtime, sessionKey } = profileSweepFixture({
    async personProfileExtract(_messages, isCurrent, context) {
      entered.resolve({ isCurrent, context })
      await held.promise
      return extractionPatch()
    },
  })
  let sweep
  try {
    sweep = runtime.sweepOnce()
    const { isCurrent, context } = await entered.promise
    h.clock.at++
    assert.equal(await runtime.handleRecall({ group_id: A.groupId, message_id: 'm1' }), true)
    assert.equal(context.signal.aborted, true)
    assert.equal(isCurrent(), false)
    held.resolve()
    await sweep
    const persisted = JSON.parse(h.data.get(sessionKey))
    assert.equal(persisted.recent.some(message => message.messageId === 'm1'), false)
    assert.equal(persisted.personProfileCursor, undefined)
    assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
  } finally {
    runtime.stop(); held.resolve()
    if (sweep) await sweep
  }
})

test('a queued privacy operation blocks background person extraction before model dispatch', async () => {
  const binding = profileBinding('first', 'privacy-backlog')
  let begins = 0
  const { runtime, h, calls, sessionKey } = profileSweepFixture({
    getPersona: () => ({ binding, persona: {}, systemContent: '' }),
    ports: {
      isMemoryInputAvailable: () => false,
      beginMemoryTurn: async () => { begins++; throw new Error('privacy backlog must block admission') },
    },
  })
  try {
    await runtime.sweepOnce()
    assert.equal(calls(), 0)
    assert.equal(begins, 0)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
  } finally { runtime.stop() }
})

test('persisted character pause prevents background person extraction from dispatching', async () => {
  const { h, runtime, sessionKey, calls } = profileSweepFixture()
  const characters = createCharacterStore({ redis: h.redis, now: () => h.clock.at })
  await characters.update(A, state => ({ ...state, paused: true }))
  try {
    await runtime.sweepOnce()
    assert.equal(calls(), 0)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
  } finally { runtime.stop() }
})

test('privacy admission cancels an active person extraction and releases the memory turn without saving late output', { timeout: 5000 }, async () => {
  const binding = profileBinding('first', 'privacy-cancel')
  const identity = { botId: IDENTITY.botId, personaId: 'agent:first' }
  const entered = deferred(), held = deferred(), privacy = new AbortController()
  let begins = 0, releases = 0
  const { h, runtime, sessionKey } = profileSweepFixture({
    getPersona: () => ({ binding, persona: {}, systemContent: '' }),
    ports: { beginMemoryTurn: async candidate => {
      assert.equal(agentBindingToken(candidate), agentBindingToken(binding))
      begins++
      return { signal: privacy.signal, isCurrent: () => !privacy.signal.aborted, release: () => { releases++ } }
    } },
    async personProfileExtract(_messages, isCurrent, context) {
      entered.resolve({ isCurrent, context })
      await held.promise
      return extractionPatch()
    },
  })
  let sweep
  try {
    sweep = runtime.sweepOnce()
    const { isCurrent, context } = await entered.promise
    assert.equal(begins, 1)
    privacy.abort(new Error('privacy command admitted'))
    assert.equal(context.signal.aborted, true)
    assert.equal(isCurrent(), false)
    h.clock.at++
    await h.core.setEnabled({ identity, subjectId: USER, enabled: false })
    held.resolve()
    await sweep
    assert.equal(releases, 1)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
    assert.deepEqual((await h.scoped({ ...B, ...identity }).loadPersonProfile(USER)).interests, [])
    await assert.rejects(context.ensureCurrent())
  } finally {
    runtime.stop(); held.resolve()
    if (sweep) await sweep
  }
})

test('a role change while the fact store awaits persistence prevents the final person fact commit', { timeout: 5000 }, async () => {
  let binding = profileBinding('first', 'before-storage')
  const firstScope = { ...A, personaId: 'agent:first' }, secondScope = { ...A, personaId: 'agent:second' }
  const entered = deferred(), held = deferred()
  let armed = false, intercepted = false
  const { h, runtime, sessionKey } = profileSweepFixture({
    getPersona: () => ({ binding, persona: {}, systemContent: '' }),
    async personProfileExtract() { armed = true; return extractionPatch() },
  })
  const get = h.redis.get
  h.redis.get = async key => {
    const value = await get(key)
    // remember() registers its identity before starting the fact transaction.
    // Suspending here crosses the runtime's last pre-store guard without
    // depending on how many read-side privacy checks that guard performs.
    if (armed && !intercepted && key === 'shiloh:person-memory:v1:identities') {
      intercepted = true; entered.resolve(); await held.promise
    }
    return value
  }
  let sweep
  try {
    sweep = runtime.sweepOnce()
    await entered.promise
    binding = profileBinding('second', 'after-storage-wait')
    held.resolve()
    await sweep
    assert.equal(intercepted, true)
    assert.deepEqual((await h.scoped(firstScope).loadPersonProfile(USER)).interests, [])
    assert.deepEqual((await h.scoped(secondScope).loadPersonProfile(USER)).interests, [])
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined)
  } finally {
    runtime.stop(); held.resolve()
    if (sweep) await sweep
  }
})

test('new directed ingress survives cancelled extraction and retains its wake without advancing the extraction cursor', { timeout: 10000 }, async () => {
  const entered = deferred(), held = deferred(), mainCalls = [], sessionWrites = []
  const { h, runtime, sessionKey } = profileSweepFixture({
    async personProfileExtract(_messages, _isCurrent, context) {
      entered.resolve(context)
      await held.promise
      return extractionPatch()
    },
    ports: { YTapi: async request => {
      mainCalls.push(request)
      return { choices: [{ message: { role: 'assistant', content: '' } }], model: 'main-fixture', usage: { total_tokens: 1 } }
    } },
  })
  const set = h.redis.set
  h.redis.set = async (key, value) => {
    if (key === sessionKey) sessionWrites.push(JSON.parse(value))
    return set(key, value)
  }
  let sweep
  try {
    sweep = runtime.sweepOnce()
    const context = await entered.promise
    h.clock.at++
    const account = { platform: 'qq', namespace: 'global', id: IDENTITY.botId }
    const text = '提取尚未结束时的新点名消息'
    assert.equal(await runtime.ingest({ version: 1, conversation: { account, kind: 'group', id: A.groupId },
      sender: { ...account, id: USER }, senderName: '小林', messageId: 'arrival-during-extraction', occurredAt: h.clock.at,
      text, parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true,
    }), true)
    const during = JSON.parse(h.data.get(sessionKey))
    assert.equal(during.seq, 21)
    assert.ok(during.recent.some(message => message.messageId === 'arrival-during-extraction' && message.seq === 21))
    assert.ok(during.pendingWakeReasons.some(reason => reason.kind === 'atMention' && reason.seq === 21))
    assert.equal(mainCalls.length, 0, 'extraction owns the live session until its handoff')
    await runtime.handleRecall({ group_id: A.groupId, message_id: 'm1' })
    assert.equal(context.signal.aborted, true)
    held.resolve()
    await sweep
    await waitFor(() => mainCalls.length > 0, 'directed wake after extraction cancellation')
    await runtime.drain()
    const persisted = JSON.parse(h.data.get(sessionKey))
    assert.equal(persisted.seq, 21)
    assert.ok(persisted.recent.some(message => message.messageId === 'arrival-during-extraction' && message.seq === 21))
    assert.equal(persisted.recent.some(message => message.messageId === 'm1'), false)
    assert.equal(persisted.personProfileCursor, undefined)
    assert.ok(sessionWrites.some(state => state.pendingWakeReasons.some(reason => reason.kind === 'atMention' && reason.seq === 21)))
    assert.ok(mainCalls.some(request => JSON.stringify(request.messages).includes(text)))
    assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
  } finally {
    runtime.stop(); held.resolve()
    if (sweep) await sweep
    await runtime.drain()
  }
})

test('extraction usage belongs to the source conversation and the completed context loses authority', async () => {
  const binding = profileBinding('first', 'usage-owner')
  const usage = { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }
  let supplied
  const { h, runtime, tokens, sessionKey } = profileSweepFixture({
    getPersona: () => ({ binding, persona: {}, systemContent: '' }),
    async personProfileExtract(_messages, isCurrent, context) {
      supplied = { isCurrent, context }
      assert.deepEqual(context.target, binding.target)
      assert.equal(agentBindingToken(context.binding), agentBindingToken(binding))
      assert.equal(context.signal.aborted, false)
      await context.ensureCurrent()
      context.recordUsage('person-fixture', usage)
      return extractionPatch()
    },
  })
  try {
    await runtime.sweepOnce()
    const recorded = tokens.filter(record => record.stage === 'person-profile' && record.usage !== undefined)
    assert.deepEqual(recorded.map(({ scope, stage, model, usage }) => ({ scope, stage, model, usage })), [
      { scope: A.groupId, stage: 'person-profile', model: 'person-fixture', usage },
    ])
    assert.equal(recorded[0].ms >= 0, true)
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor.seq, 20)
    assert.deepEqual((await h.scoped({ ...B, personaId: 'agent:first' }).loadPersonProfile(USER)).interests, ['爵士乐'])
    assert.equal(supplied.isCurrent(), false)
    assert.equal(supplied.context.isCurrent(), false)
    await assert.rejects(supplied.context.ensureCurrent())
  } finally { runtime.stop() }
})

test('malformed extraction output leaves the batch cursor available for a later retry', async () => {
  for (const raw of ['not JSON', '```json\n[]\n```', '{"entries":[]}', 'null']) {
    const { h, runtime, sessionKey, calls } = profileSweepFixture({ personProfileExtract: async () => raw })
    try {
      await runtime.sweepOnce()
      assert.equal(calls(), 1)
      assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor, undefined, raw)
      assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
      await runtime.sweepOnce()
      assert.equal(calls(), 2, 'invalid output must not consume the extraction cooldown')
    } finally { runtime.stop() }
  }
})

test('quote text and forwarded text cannot become a real author self statement in profile extraction', async () => {
  const quoteOnly = '我一直很喜欢爵士乐'
  let input
  const { h, runtime, sessionKey } = profileSweepFixture({
    async personProfileExtract(messages) {
      input = messages
      assert.equal(messages.length, 20)
      assert.equal(messages.some(message => message.text.includes(quoteOnly)), false)
      assert.equal(messages.some(message => Object.hasOwn(message, 'quoteText') || Object.hasOwn(message, 'forwardId')), false)
      // An untrusted extractor deliberately invents a quote-backed self fact
      // for the actual quoter, and another fact for the quoted third party.
      return JSON.stringify([
        { userId: USER, entries: [{ category: 'interest', text: '爵士乐', sourceIndex: 1, sourceExcerpt: quoteOnly, portable: true, sensitivity: 'ordinary' }] },
        { userId: '10002', entries: [{ category: 'interest', text: '爵士乐', sourceIndex: 1, sourceExcerpt: '他之前说过这个', portable: true, sensitivity: 'ordinary' }] },
      ])
    },
  })
  const state = JSON.parse(h.data.get(sessionKey))
  state.recent[0] = { ...state.recent[0], text: '他之前说过这个', quoteText: quoteOnly,
    quoteAuthor: '引用的第三人', replyToUserId: '10002', quoteSource: { messageId: 'quoted-third-party', invalidatedAt: 0 } }
  state.recent.push(
    { ...state.recent[1], seq: 21, messageId: 'forwarded-self-claim', text: quoteOnly, forwardId: 'forward-other-author' },
    { ...state.recent[1], seq: 22, messageId: 'truncated-self-claim', text: quoteOnly, textTruncated: true },
    { ...state.recent[1], seq: 23, messageId: null, text: quoteOnly },
  )
  state.seq = 23
  h.data.set(sessionKey, JSON.stringify(state))
  try {
    await runtime.sweepOnce()
    assert.equal(input[0].text, '他之前说过这个')
    assert.deepEqual((await h.scoped(B).loadPersonProfile(USER)).interests, [])
    assert.deepEqual((await h.scoped(B).loadPersonProfile('10002')).interests, [])
    assert.equal(JSON.parse(h.data.get(sessionKey)).personProfileCursor.seq, 20)
  } finally { runtime.stop() }
})
