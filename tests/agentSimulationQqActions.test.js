import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createSimulationRuntime } = await load('modules/simulation/infrastructure/simulationRuntime.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { createSimSessionStore, simulationSessionKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { agentBindingToken, agentPersonaScopeId } = await load('modules/runtime/domain/agentBindings.js')
const { personMemoryAddress } = await load('modules/memory/infrastructure/personMemoryContext.js')
const options = { skip: !redisAvailable, timeout: 25000 }, AT = 1_790_000_000_000
const names = ['qqZoneTool', 'sendGiftTool', 'grabRedBagTool', 'simQzoneInteract']
const schema = { type: 'object', properties: {}, required: [] }
let sequence = 0
const call = (name, args = {}) => ({ id: `qq-action-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }], usage: { total_tokens: 1 } })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '本次验证结束' })
const gift = { state: 'confirmed', completed: 1 }
const visited = { state: 'confirmed', kind: 'visit', terminal: false, visitId: 'visit-current-source', feeds: [{ userId: '170001', postId: 'post-one', text: '临时空间正文不应留存' }] }
const rawTool = (name, execute, ephemeral = false) => ({ name, description: '隔离 QQ 回合接缝验证', parameters: schema,
  ...(ephemeral ? { agentDataPolicy: 'ephemeral' } : {}), execute })
async function waitFor(probe, errors) {
  const deadline = performance.now() + 7500
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`QQ action turn did not settle: ${errors.join('|')}`)
}

async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'simulation-qq-actions'), clock = { value: AT }
  const account = { platform: 'qq', namespace: 'global', id: '19000001' }, target = { account, kind: 'group', id: '310001' }, user = { ...account, id: '170001' }
  const binding = { source: 'configured', id: 'qq-action-binding', revision: 'first', agentId: 'role', personaId: 'default', connectionId: 'main', target }
  const key = simulationAddressKey(target), requests = [], actions = [], sends = [], events = [], episodes = [], groupReplies = [], observations = [], errors = []
  const initial = createDefaultSimSession(AT)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
  initial.nextProactiveCheckAt = settings.proactive ? 0 : AT + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await redis.storage.set(simulationSessionKey(key), JSON.stringify(initial))
  if (settings.affinity) {
    const { botId, scene } = personMemoryAddress(target)
    await createSimSessionStore({ redis: redis.storage, now: () => clock.value, logger: { warn() {} },
      characterScope: { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id }, memoryScope: binding }).saveAffinity(key, settings.affinity)
  }
  let round = 0, runtime, supported = settings.support !== false
  const f = { ...redis, clock, account, target, user, binding, key, requests, actions, sends, events, episodes, groupReplies, observations, errors,
    setSupport(value) { supported = value },
    session: async () => JSON.parse(await redis.storage.get(simulationSessionKey(key))),
    async run(extra = {}) {
      const before = requests.length; round = 0
      await runtime.ingest({ version: 1, conversation: target, sender: user, senderName: '真人请求者', messageId: 'source-' + ++sequence,
        occurredAt: clock.value - 1000, text: '按当前请求执行 QQ 动作。', parts: [{ kind: 'text', text: '按当前请求执行 QQ 动作。' }], mentions: [account], directedToAccount: true, ...extra })
      await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, errors)
      await runtime.drain()
    },
    async background() {
      await runtime.ingest({ version: 1, conversation: target, sender: user, senderName: '真人请求者', messageId: 'background-' + ++sequence,
        occurredAt: clock.value, text: '普通背景。', parts: [{ kind: 'text', text: '普通背景。' }], mentions: [], directedToAccount: false })
      await runtime.drain()
    },
    async sweep() { const before = requests.length; round = 0; clock.value += 120000; await runtime.sweepOnce(); await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, errors); await runtime.drain() },
  }
  const tools = settings.tools?.(f) ?? names.filter(name => name !== 'simQzoneInteract').map(name => rawTool(name, async (_args, event) => {
    events.push(event)
    const kind = name === 'sendGiftTool' ? 'gift' : name === 'grabRedBagTool' ? 'red-packet' : 'qzone'
    const result = await event._runAgentQqAction(kind, async guard => {
      await guard.ensureCurrent(); assert.equal(guard.isCurrent(), true); assert.equal(guard.signal.aborted, false)
      actions.push({ kind, guard })
      return settings.result ?? gift
    })
    return JSON.stringify(result)
  }))
  const ports = {
    redis: redis.storage, now: () => clock.value, random: () => 0.99, durableIngress: true,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } },
    handlesTarget: () => true, allowsConversationAI: () => true, isAccountReady: () => true,
    getSelf: () => ({ id: account.id, name: '角色' }), getPersona: () => ({ binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '角色' }, systemContent: '' }),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
      wakeGate: { enabled: false }, userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false }, lifeThreads: { enabled: false },
      qzone: { enabled: true, minAffinity: settings.minAffinity ?? 75 },
      wake: { probability: 0, proactiveProbability: settings.proactive ? 1 : 0, proactiveIdleMs: 60000, proactiveCheckMinMs: 60000, proactiveCheckMaxMs: 60000, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: settings.maxSends ?? 10, maxToolRounds: 8, maxTurnsPerDay: 100 }, toolPolicy: { mode: 'open' }, extraTools: tools.map(tool => tool.name) }),
    getExecutionConfig: () => ({ useTools: true }), extraToolsPlatformNeutral: true,
    listRegistryToolNames: () => ({ builtIn: tools.map(tool => tool.name), all: tools.map(tool => tool.name) }),
    getExtraTools: requested => tools.filter(tool => requested.includes(tool.name)),
    ...(settings.supportPort === false ? {} : { supportsQqAction: (_target, name) => supported && names.includes(name) }),
    ...(settings.history ? { readHistory: async () => ({ text: '临时历史资料', isCurrent: async () => true }) } : {}),
    ...(settings.members === false ? {} : { readGroupMembers: async () => settings.members?.(f) ?? ({ target, observedAt: clock.value, complete: true, members: [{ user, displayName: '当前成员', role: 'member' }] }) }),
    ...(settings.qzone ? { async executeQzone(operation, context) { return context.runQqAction('qzone', async guard => {
      await guard.ensureCurrent(); actions.push({ kind: 'qzone', operation, context, guard })
      return settings.qzone(operation, context, f)
    }) } } : {}),
    ...(settings.legacy ? { qzoneInteract: settings.legacy } : {}),
    messageActions: { async send(action, guard) { assert.equal(guard.isCurrent(), true); sends.push(action); return { state: 'sent', messageId: 'native-text-' + sends.length } } },
    recordEpisode: value => episodes.push(value), recordGroupReply: value => groupReplies.push(value), recordToolResult: value => observations.push(value),
    async YTapi(request) { requests.push(structuredClone(request)); return settings.script ? settings.script(round++, f, request) : round++ === 0 ? response(call(settings.tool ?? 'sendGiftTool'), call('simSendMessage', { messages: ['禁止的后续文字'] })) : response(finish()) },
  }
  runtime = createSimulationRuntime(ports); f.runtime = runtime; f.ports = ports
  t.after(async () => { runtime.stop(); await runtime.drain() })
  return f
}

for (const scenario of [
  { name: 'gift confirmed', tool: 'sendGiftTool', result: gift, sends: 1 },
  { name: 'gift unknown', tool: 'sendGiftTool', result: { state: 'unknown', completed: 0 }, sends: 0 },
  { name: 'red packet grabbed', tool: 'grabRedBagTool', result: { state: 'confirmed', phase: 'finished', code: 'done', passwordConfirmed: false, grabbed: true }, sends: 1 },
  { name: 'red packet password confirmed', tool: 'grabRedBagTool', result: { state: 'failed', phase: 'password_confirmed', code: 'closed', passwordConfirmed: true, grabbed: false }, sends: 1 },
  { name: 'red packet unknown', tool: 'grabRedBagTool', result: { state: 'unknown', phase: 'finished', code: 'uncertain', passwordConfirmed: false, grabbed: false }, sends: 0 },
  { name: 'qzone published', tool: 'qqZoneTool', result: { state: 'confirmed', kind: 'publish', terminal: true, postId: 'own-post' }, sends: 1 },
  { name: 'qzone unknown', tool: 'qqZoneTool', result: { state: 'unknown', kind: 'publish', terminal: true }, sends: 0 },
  { name: 'qzone attempted write failed', tool: 'qqZoneTool', result: { state: 'failed', kind: 'publish', terminal: true, code: 'provider_failed' }, sends: 0 },
]) test(`Simulation ${scenario.name} ends the turn without a follow-up model, text or fabricated chat memory`, options, async t => {
  const f = await fixture(t, scenario)
  await f.run()
  assert.equal(f.actions.length, 1); assert.equal(f.requests.length, 1)
  assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, []); assert.deepEqual(f.groupReplies, [])
  const session = await f.session()
  assert.equal(session.sendTimes.length, scenario.sends); assert.deepEqual(session.confirmedMessageIds ?? [], [])
  assert.equal(session.lastConfirmedChat, undefined); assert.equal(session.nextReplyCheckAt ?? 0, 0)
})

test('Simulation qzone visits continue once into a guarded write while feed text remains ephemeral', options, async t => {
  const f = await fixture(t, { qzone: operation => operation.kind === 'visit' ? visited : { state: 'confirmed', kind: operation.kind, terminal: true },
    script: round => round === 0 ? response(call('simQzoneInteract', { action: 'visit', userId: '170001' }))
      : response(call('simQzoneInteract', { action: 'like', userId: '170001', tid: 'post-one', visitId: 'visit-current-source' }), call('simSendMessage', { messages: ['不追加文字'] })) })
  await f.run()
  assert.deepEqual(f.actions.map(action => action.operation.kind), ['visit', 'like']); assert.equal(f.requests.length, 2)
  assert.match(JSON.stringify(f.requests[1]), /临时空间正文不应留存/u)
  assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), /临时空间正文不应留存|visit-current-source/u)
  assert.deepEqual(f.observations, []); assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, [])
  assert.equal((await f.session()).sendTimes.length, 1)
})

test('Simulation QQ effects use the existing serial text queue and remaining send budget', options, async t => {
  const trace = []
  const f = await fixture(t, { maxSends: 1, tools: run => [rawTool('sendGiftTool', async (_args, event) => {
    const first = event._sendAgentToolMessage({ text: '先发一条正常文字。' }).then(() => trace.push('text-confirmed'))
    const second = event._runAgentQqAction('gift', async () => { run.actions.push('forbidden'); return gift })
    await first; await assert.rejects(second, /上限/u); trace.push('gift-budget-blocked')
    return JSON.stringify({ state: 'failed' })
  })], script: round => round === 0 ? response(call('sendGiftTool')) : response(finish()) })
  await f.run(); assert.deepEqual(trace, ['text-confirmed', 'gift-budget-blocked']); assert.deepEqual(f.actions, []); assert.equal(f.sends.length, 1)
})

test('Simulation terminal or unknown QQ effects fence later operations inside the same tool', options, async t => {
  for (const result of [gift, { state: 'unknown', completed: 0 }]) {
    const f = await fixture(t, { tools: run => [rawTool('sendGiftTool', async (_args, event) => {
      const first = event._runAgentQqAction('gift', async guard => { await guard.ensureCurrent(); run.actions.push('first'); return result })
      const second = event._runAgentQqAction('gift', async () => { run.actions.push('forbidden'); return gift })
      await first; await assert.rejects(second, /失效|未知/u)
      await assert.rejects(event._sendAgentToolMessage({ text: '禁止的工具内补发。' }), /结束|未知/u)
      return JSON.stringify(result)
    })] })
    await f.run(); assert.deepEqual(f.actions, ['first']); assert.equal(f.requests.length, 1); assert.deepEqual(f.sends, [])
  }
})

test('Simulation hides QQ extension tools unless the current capability is explicitly available', options, async t => {
  for (const settings of [{ support: false }, { supportPort: false }]) {
    const f = await fixture(t, { ...settings, qzone: () => visited, script(_round, _run, request) {
      for (const name of names) assert.equal(request.tools.some(row => row.function.name === name), false, name)
      return response(finish())
    } })
    await f.run(); assert.deepEqual(f.actions, [])
  }
})

test('Simulation QQ provider guards recheck a hot capability revocation before an external request', options, async t => {
  const f = await fixture(t, { tools: run => [rawTool('sendGiftTool', async (_args, event) => {
    await assert.rejects(event._runAgentQqAction('gift', async guard => {
      run.setSupport(false); assert.equal(guard.isCurrent(), false)
      await guard.ensureCurrent(); run.actions.push('forbidden'); return gift
    }), /失效/u)
    return JSON.stringify({ state: 'unknown', completed: 0 })
  })] })
  await f.run(); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, []); assert.equal(f.requests.length, 1)
})

test('Simulation QQ actions cannot borrow a truncated human request or temporary history', options, async t => {
  for (const history of [false, true]) {
    const f = await fixture(t, { history, tools: run => [rawTool('sendGiftTool', async (_args, event) => {
      if (history) await event._readAgentHistory({}, () => true, new AbortController().signal)
      await assert.rejects(event._runAgentQqAction('gift', async () => { run.actions.push('forbidden'); return gift }), /完整真人|临时资料/u)
      return JSON.stringify({ state: 'failed' })
    })], script: round => round === 0 ? response(call('sendGiftTool')) : response(finish()) })
    const text = history ? '查询历史后不能送礼。' : '原始请求'.repeat(5000)
    await f.run({ text, parts: [{ kind: 'text', text }] }); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, [])
  }
})

test('Simulation autonomous turns never expose human QQ extension tools', options, async t => {
  const f = await fixture(t, { proactive: true, qzone: () => visited, script(_round, _run, request) {
    for (const name of names) assert.equal(request.tools.some(row => row.function.name === name), false, name)
    return response(finish())
  } })
  await f.background(); await f.sweep(); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, [])
})

test('Simulation QQ text review applies outgoing policy before approving final text', options, async t => {
  const reviews = []
  const f = await fixture(t, { tools: () => [rawTool('sendGiftTool', async (_args, event) => {
    reviews.push(await event._reviewAgentQqText('一条普通说说。'))
    reviews.push(await event._reviewAgentQqText('{"arguments":{"secret":"x"}}'))
    return JSON.stringify({ state: 'failed' })
  })], script: round => round === 0 ? response(call('sendGiftTool')) : response(finish()) })
  await f.run(); assert.deepEqual(reviews, [true, false]); assert.deepEqual(f.sends, [])
})

test('Simulation qzone candidates use only current complete group evidence and recorded affinity', options, async t => {
  const checks = []
  const f = await fixture(t, { affinity: { '170001': { score: 90 }, '170002': { score: 10 }, '170003': { score: 99 } },
    members: run => ({ target: run.target, observedAt: run.clock.value, complete: true, members: [run.user, { ...run.account, id: '170002' }, { ...run.account, id: '170004' }].map(user => ({ user, displayName: '群友', role: 'member' })) }),
    tools: () => [rawTool('sendGiftTool', async (_args, event) => {
      checks.push(await event._qzoneCandidates()); checks.push(event._qzoneAffinity('170001')); checks.push(event._qzoneAffinity('unknown'))
      return JSON.stringify({ state: 'failed' })
    })], script: round => round === 0 ? response(call('sendGiftTool')) : response(finish()) })
  await f.run(); assert.deepEqual(checks, [['170001'], 90, 0])
})

test('Simulation preserves the legacy qzone port when no neutral executor is configured', options, async t => {
  const legacy = []
  const f = await fixture(t, { supportPort: false, affinity: { '170001': { score: 90 } },
    legacy: async operation => { legacy.push(operation); return { ok: true, feeds: [] } },
    script: round => round === 0 ? response(call('simQzoneInteract', { action: 'visit', userId: '170001' })) : response(finish()) })
  await f.run(); assert.equal(legacy.length, 1); assert.equal(legacy[0].action, 'visit'); assert.deepEqual(f.actions, [])
})

test('Simulation unrelated ephemeral tools cannot lend their temporary sources to qzone actions', options, async t => {
  const f = await fixture(t, { tools: () => [rawTool('temporaryEvidenceTool', async () => '其他临时资料正文', true)], qzone: () => visited,
    script: round => round === 0 ? response(call('temporaryEvidenceTool')) : round === 1
      ? response(call('simQzoneInteract', { action: 'visit', userId: '170001' })) : response(finish()) })
  await f.run(); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, [])
  assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), /其他临时资料正文/u)
})

test('Direct Simulation qzone rejects invalid schema or a missing candidate port before marking ephemeral data', options, async t => {
  for (const [argumentsValue, error] of [[{ action: 'visit', userId: 170001 }, /Schema/u], [{ action: 'visit' }, /QQ 空间权限/u]]) {
    const rejected = call('simQzoneInteract', argumentsValue)
    const f = await fixture(t, { members: false, qzone: () => visited, script: round => round === 0 ? response(rejected,
      call('simCharacterMemory', { action: 'remember', kind: 'interest', epistemic: 'inferred', content: '保留普通群聊记忆', evidenceRefs: ['message:1'] }),
    ) : response(finish()) })
    await f.run()
    assert.deepEqual(f.actions, [])
    assert.match(f.observations.find(result => result.toolCallId === rejected.id)?.content, error)
    const { character } = await f.runtime.describeGroup(f.key)
    assert.equal(character.memories[0]?.content, '保留普通群聊记忆')
  }
})

test('Simulation silent and deferred decisions prevent queued QQ provider calls', options, async t => {
  for (const kind of ['silent', 'deferred']) {
    const f = await fixture(t, { script: round => round === 0 ? response(call('simDecide', { kind, reason: '本轮先不执行。' }), call('sendGiftTool')) : response(finish()) })
    await f.run(); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, [])
    assert.equal(f.events.length, 1, 'the provider runner owns the fence even if the enclosing tool is invoked')
  }
})

test('Simulation autonomous and commitment actors cannot borrow QQ authority through a permitted reading tool', options, async t => {
  for (const actor of ['autonomous', 'commitment']) {
    const attempted = []
    const f = await fixture(t, { proactive: actor === 'autonomous', tools: run => [rawTool('searchInformationTool', async (_args, event) => {
      attempted.push(event.simulationActor.kind)
      await assert.rejects(event._runAgentQqAction('gift', async () => { run.actions.push('forbidden'); return gift }), /完整真人/u)
      return JSON.stringify({ state: 'failed' })
    })], script: round => round === 0 ? response(call('searchInformationTool')) : response(finish()) })
    if (actor === 'autonomous') { await f.background(); await f.sweep() }
    else { await f.runtime.wakeForCommitment(f.target.id, '独立托付不能借送礼权限', { taskId: 'qq-commitment', botId: f.account.id, isCurrent: async () => true, beforeExecution: async () => true }, f.target); await f.runtime.drain() }
    assert.deepEqual(attempted, [actor]); assert.deepEqual(f.actions, []); assert.deepEqual(f.sends, [])
  }
})

test('Simulation never invents qzone candidates from missing, incomplete or another group membership evidence', options, async t => {
  for (const members of [false, run => ({ target: run.target, observedAt: AT, complete: false, members: [{ user: run.user }] }),
    run => ({ target: { ...run.target, id: '310002' }, observedAt: AT, complete: true, members: [{ user: run.user }] })]) {
    const found = []
    const f = await fixture(t, { members, affinity: { '170001': { score: 90 } }, tools: () => [rawTool('sendGiftTool', async (_args, event) => {
      found.push(await event._qzoneCandidates()); return JSON.stringify({ state: 'failed' })
    })], script: round => round === 0 ? response(call('sendGiftTool')) : response(finish()) })
    await f.run(); assert.deepEqual(found, [[]]); assert.deepEqual(f.actions, [])
  }
})
