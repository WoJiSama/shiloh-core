import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { giftRedis, account, binding, user, target } from './helpers/agentGiftSource.mjs'

const { createAgentQqActions } = await load('modules/runtime/infrastructure/agentQqActions.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createAgentQzoneTools } = await load('modules/tools/infrastructure/agentQzoneTools.js')
const { createAgentToolSourceGuard } = await load('modules/runtime/infrastructure/agentToolSourceGuard.js')
const author = user('20000101'), subject = user('30000101')
const defaultConfig = () => ({ qzone: { enabled: true }, gift: { enabled: true }, redPackets: { enabled: true, allowExplicit: true,
  automatic: { enabled: true, toolConfigured: true } } })
const snapshot = () => ({ version: 1, target, source: { messageId: 'wallet-1', author, at: Date.now() - 1000 }, observedAt: Date.now(),
  packetRef: 'packet:0123456789abcdef', packetIdentity: 'a'.repeat(64), kind: 'exclusive', title: '合成红包', exclusiveForBot: true })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(probe) { const until = Date.now() + 4000; while (Date.now() < until) { if (probe()) return; await delay(10) }; assert.fail('service fixture did not reach its bounded stage') }
async function fixture(t, settings = {}) {
  const redis = await giftRedis(t), config = settings.config ?? defaultConfig(), effects = [], events = [], sources = [], permissions = []
  let current = true, authorized = true, sourceCurrent = true, adapter, active, controller = new AbortController()
  const packet = snapshot()
  const member = id => ({ target, observedAt: Date.now(), member: { user: user(id), displayName: id === author.id ? '当前玩家' : '目标玩家', role: 'member' } })
  adapter = { id: binding.connectionId, account, botUserId: account.id, botName: '合成机器人', actions: {}, isReady: () => true,
    async readConversationMember(_target, selected, guard) { await guard.ensureCurrent(); events.push('member'); return member(selected.id) },
    async gift(action, guard) { events.push('gift-provider'); await guard.ensureCurrent(); effects.push(['gift', action]); return settings.giftReceipt ?? { state: 'confirmed', evidence: 'packet-accepted' } },
    qzone: { async execute(action, guard) {
      events.push('qzone-provider'); await guard.ensureCurrent(); effects.push(['qzone', action.operation]);
      return action.operation.kind === 'visit' ? { state: 'confirmed', feeds: [{ postId: 'post-1', userId: subject.id, text: '可信访问结果' }] }
        : action.operation.kind === 'publish' ? { state: 'confirmed', postId: 'own-post-1' } : { state: 'confirmed' }
    } },
    redPackets: { async read(_target, id, guard) { await guard.ensureCurrent(); events.push('packet-read'); return id === packet.source.messageId ? packet : undefined },
      async recent(_target, guard) { await guard.ensureCurrent(); return [packet] }, async revalidate(_packet, guard) { await guard.ensureCurrent(); return true },
      async sendPassword(_packet, guard) { await guard.ensureCurrent(); effects.push(['password']); return { state: 'confirmed', messageId: 'password-1' } },
      async grab(_packet, guard) { await guard.ensureCurrent(); effects.push(['grab']); return settings.packetReceipt ?? { state: 'confirmed', amountFen: 123 } }, revoke() {} },
  }
  const options = { config, storage: redis.storage, adapterFor: () => active, isCurrent: () => current,
    async authorize(name, selected, actor) { permissions.push({ name, selected, actor }); return authorized },
    async sourceAvailable(_binding, source, guard) { await guard.ensureCurrent(); sources.push(source); return sourceCurrent },
    affinity: () => 80, getQzoneLimits: () => ({ enabled: true }),
    async allowsText(text) { events.push('host-text'); return settings.hostText !== false },
    diagnostics: createAgentDiagnostics({ logger: { info() {}, warn() {}, error() {} } }),
  }
  active = adapter
  const context = { binding: structuredClone(binding), actor: { kind: 'user', user: author },
    request: { messageId: 'human-1', text: '请送给我一个香槟', mentions: [] }, signal: controller.signal,
    isCurrent: () => current, async ensureCurrent() { events.push('outer-ensure'); assert.equal(current, true) },
    async readMember(id) { return member(id) }, qzoneAffinity: () => 80,
    async reviewQqText() { events.push('persona-text'); return settings.personaText !== false },
    async runQqAction(kind, run) {
      events.push('queue:' + kind); await settings.beforeQueue?.(f)
      return run({ signal: controller.signal, isCurrent: () => current, async ensureCurrent() {
        events.push('queue-ensure'); await settings.duringQueue?.(f); assert.equal(current, true)
      } })
    },
  }
  const f = { redis, config, options, context, packet, effects, events, sources, permissions, adapter,
    revoke() { current = false }, deny() { authorized = false }, withdraw() { sourceCurrent = false }, replace() { active = { ...adapter } },
    signal: controller.signal, guard: { signal: controller.signal, isCurrent: () => current, async ensureCurrent() { assert.equal(current, true) } },
    restart() { return createAgentQqActions(options) },
  }
  if (settings.ownedSource) Object.assign(context, createAgentToolSourceGuard(context, async () => {
    events.push('owned-source'); assert.equal(current && sourceCurrent, true)
  }))
  f.service = f.restart(); return f
}
const tool = (f, name) => { const selected = f.service.builtIn.find(item => item.name === name); assert.ok(selected); return selected }

test('QQ action service defaults off with no adapter, storage, queue or native calls', async () => {
  let accesses = 0
  const service = createAgentQqActions({ storage: { async get() { accesses++; throw Error('unexpected storage') }, async eval() { accesses++; throw Error('unexpected storage') } },
    adapterFor() { accesses++; return undefined }, isCurrent: () => true, authorize: () => false, sourceAvailable: async () => false })
  assert.deepEqual(service.builtIn, []); assert.ok(Object.isFrozen(service)); assert.ok(Object.isFrozen(service.builtIn)); assert.equal(accesses, 0)
})

test('gift callback uses the original host queue and durable workflow, never a fabricated message receipt', async t => {
  const f = await fixture(t), selected = tool(f, 'sendGiftTool')
  assert.deepEqual(f.service.builtIn.map(item => item.name), ['qqZoneTool', 'sendGiftTool', 'grabRedBagTool'])
  const result = await selected.execute({}, f.context); assert.equal(result.status, 'succeeded')
  assert.equal(JSON.parse(result.content).completed, 1); assert.equal(JSON.parse(result.content).evidence, 'packet-accepted')
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0][0], 'gift'); assert.equal(f.effects[0][1].source.messageId, 'human-1')
  assert.equal(f.effects[0][1].plan.recipient.id, author.id)
  assert.ok(f.events.indexOf('queue:gift') < f.events.indexOf('gift-provider')); assert.ok(f.events.includes('queue-ensure'))
  assert.ok(f.sources.every(source => source.messageId === 'human-1' && source.author.id === author.id))
  const second = await f.restart().builtIn.find(item => item.name === 'sendGiftTool').execute({}, f.context)
  assert.equal(second.status, 'failed'); assert.equal(f.effects.length, 1)
})

test('configuration observation surrounds only synchronous current predicates, never source reads or effects', async t => {
  const f = await fixture(t); let observing = false, observations = 0, predicates = 0
  f.options.observeCurrent = check => {
    assert.equal(observing, false); observing = true; observations++
    try { const result = check(); assert.equal(typeof result, 'boolean'); return result }
    finally { observing = false }
  }
  const isCurrent = f.options.isCurrent
  f.options.isCurrent = selected => { assert.equal(observing, true); predicates++; return isCurrent(selected) }
  for (const [owner, key] of [[f.options, 'authorize'], [f.options, 'sourceAvailable'], [f.context, 'ensureCurrent'],
    [f.context, 'runQqAction'], [f.adapter, 'gift']]) {
    const original = owner[key]
    owner[key] = async function (...args) {
      assert.equal(observing, false, key)
      const result = await original.apply(this, args)
      assert.equal(observing, false, key); return result
    }
  }
  f.service = f.restart()
  assert.equal((await tool(f, 'sendGiftTool').execute({}, f.context)).status, 'succeeded')
  assert.equal(observing, false); assert.ok(observations > 1); assert.equal(predicates, observations)
  assert.equal(f.effects.length, 1); assert.ok(f.sources.length > 0)
})

test('configuration observation fails closed and cannot retain authorization across a queue await', async t => {
  for (const mode of ['false', 'throw', 'async']) {
    const f = await fixture(t); let observations = 0
    f.options.observeCurrent = check => {
      observations++; assert.equal(check(), true)
      if (mode === 'throw') throw Error('configuration observation unavailable')
      return mode === 'async' ? Promise.resolve(true) : false
    }
    f.service = f.restart()
    assert.equal((await tool(f, 'sendGiftTool').execute({}, f.context)).status, 'failed', mode)
    assert.ok(observations > 0, mode); assert.deepEqual(f.effects, [], mode)
  }
  const gate = deferred(); let reached = false, observations = 0
  const f = await fixture(t, { async duringQueue() { reached = true; await gate.promise } })
  t.after(() => gate.resolve())
  f.options.observeCurrent = check => { observations++; return check() }; f.service = f.restart()
  const pending = tool(f, 'sendGiftTool').execute({}, f.context)
  await waitFor(() => reached); const before = observations
  f.config.gift.enabled = false; gate.resolve()
  assert.equal((await pending).status, 'failed'); assert.ok(observations > before); assert.deepEqual(f.effects, [])
})

test('missing queue, authorization, current source or adapter identity prevents gift dispatch', async t => {
  for (const phase of ['queue', 'authorize', 'source', 'adapter']) {
    const f = await fixture(t)
    if (phase === 'queue') delete f.context.runQqAction
    else if (phase === 'authorize') f.deny()
    else if (phase === 'source') f.withdraw()
    else f.options.adapterFor = () => ({ ...f.adapter, id: 'foreign-connection' })
    assert.equal((await tool(f, 'sendGiftTool').execute({}, f.context)).status, 'failed', phase); assert.deepEqual(f.effects, [])
  }
})

test('queue wait cannot survive configuration, binding, adapter or source revocation', async t => {
  for (const phase of ['config', 'binding', 'adapter', 'source']) {
    const gate = deferred(); let reached = false
    const f = await fixture(t, { async beforeQueue() { reached = true; await gate.promise } }); t.after(() => gate.resolve())
    const pending = tool(f, 'sendGiftTool').execute({}, f.context); await waitFor(() => reached)
    if (phase === 'config') f.config.gift.enabled = false
    else if (phase === 'binding') f.context.binding.connectionId = 'foreign'
    else if (phase === 'adapter') f.replace()
    else f.withdraw()
    gate.resolve(); assert.notEqual((await pending).status, 'succeeded'); assert.deepEqual(f.effects, [])
  }
})

test('owned human source is fresh after the final queue and authorization await before native dispatch', async t => {
  for (const phase of ['queue', 'authorize']) {
    let reached = false
    const gate = deferred(), f = await fixture(t, { ownedSource: true, async duringQueue() {
      if (phase === 'queue' && f.events.includes('gift-provider')) { reached = true; await gate.promise }
    } })
    t.after(() => gate.resolve())
    const authorize = f.options.authorize
    f.options.authorize = async (...args) => {
      const allowed = await authorize(...args)
      if (phase === 'authorize' && f.events.includes('gift-provider')) { reached = true; await gate.promise }
      return allowed
    }
    const pending = tool(f, 'sendGiftTool').execute({}, f.context)
    await waitFor(() => reached); f.withdraw(); gate.resolve()
    assert.notEqual((await pending).status, 'succeeded', phase); assert.deepEqual(f.effects, [], phase)
  }
})

test('owned source bypass applies only to its human source; foreign and wallet sources retain independent checks', async t => {
  const owned = await fixture(t, { ownedSource: true })
  assert.equal((await tool(owned, 'sendGiftTool').execute({}, { ...owned.context })).status, 'succeeded')
  assert.ok(owned.events.filter(event => event === 'owned-source').length > 1); assert.deepEqual(owned.sources, [])
  const foreign = await fixture(t, { ownedSource: true })
  foreign.context.ensureCurrent = async () => { foreign.events.push('foreign-source') }
  foreign.withdraw()
  assert.equal((await tool(foreign, 'sendGiftTool').execute({}, foreign.context)).status, 'failed')
  assert.deepEqual(foreign.effects, []); assert.ok(foreign.sources.some(source => source.messageId === 'human-1'))
  const packet = await fixture(t, { ownedSource: true })
  packet.context.request.text = '请抢这个红包'; packet.context.request.replyMessageId = packet.packet.source.messageId
  Object.assign(packet.context, createAgentToolSourceGuard(packet.context, async () => { packet.events.push('owned-source') }))
  assert.equal((await tool(packet, 'grabRedBagTool').execute({}, packet.context)).status, 'succeeded')
  assert.ok(packet.sources.some(source => source.messageId === packet.packet.source.messageId))
  assert.ok(packet.sources.every(source => source.messageId !== 'human-1'))
})

test('own qzone publish/delete share queue, persona plus host policy, ownership ledger and terminal writes', async t => {
  const f = await fixture(t); f.context.request.text = '请发布一条QQ空间说说'
  const published = await tool(f, 'qqZoneTool').execute({ text: '自己的人设说说' }, f.context)
  assert.equal(published.status, 'succeeded'); assert.equal(JSON.parse(published.content).terminal, true)
  assert.ok(f.events.includes('persona-text')); assert.ok(f.events.includes('host-text')); assert.ok(f.events.includes('queue:qzone'))
  f.context.request = { messageId: 'human-2', text: '请删除你的空间说说 own-post-1', mentions: [] }
  const deleted = await tool(f, 'qqZoneTool').execute({ type: true, postId: 'own-post-1' }, f.context)
  assert.equal(deleted.status, 'succeeded'); assert.equal(JSON.parse(deleted.content).terminal, true)
  assert.deepEqual(f.effects.map(effect => effect[1].kind), ['publish', 'delete'])
})

test('qzone text denies absent or rejected persona and host evidence before any provider effect', async t => {
  for (const phase of ['no-persona', 'no-host', 'persona-deny', 'host-deny']) {
    const f = await fixture(t, { personaText: phase !== 'persona-deny', hostText: phase !== 'host-deny' })
    if (phase === 'no-persona') delete f.context.reviewQqText
    if (phase === 'no-host') delete f.options.allowsText
    const result = await f.service.executeQzone({ kind: 'publish', text: '必须有双重证据' }, f.context)
    assert.equal(result.state, 'failed', phase); assert.equal(result.terminal, false); assert.deepEqual(f.effects, [])
  }
})

test('simulation qzone is independent from own-publish enablement, fresh-checks members and returns nonterminal visit', async t => {
  const f = await fixture(t, { config: { qzone: { enabled: false } } })
  const result = await f.service.executeQzone({ kind: 'visit', userId: subject.id }, f.context)
  assert.equal(result.state, 'confirmed'); assert.equal(result.terminal, false); assert.ok(result.visitId)
  assert.ok(f.events.includes('member')); assert.ok(f.permissions.some(row => row.name === 'simQzoneInteract'))
  const commented = await f.service.executeQzone({ kind: 'comment', userId: subject.id, postId: 'post-1', visitId: result.visitId, text: '看到近况啦' }, f.context)
  assert.equal(commented.state, 'confirmed'); assert.equal(commented.terminal, true)
  assert.equal((await f.service.executeQzone({ kind: 'publish', text: '未授权自己的发布' }, f.context)).state, 'failed')
  assert.deepEqual(f.effects.map(effect => effect[1].kind), ['visit', 'comment'])
})

test('simulation qzone denies missing affinity and autonomous tool contexts', async t => {
  const f = await fixture(t); delete f.context.qzoneAffinity; delete f.options.affinity
  assert.equal((await f.service.executeQzone({ kind: 'visit', userId: subject.id }, f.context)).state, 'failed')
  f.context.actor = { kind: 'autonomous' }
  assert.equal((await f.service.executeQzone({ kind: 'visit', userId: subject.id }, f.context)).state, 'failed')
  const sim = createAgentQzoneTools({ simulationEnabled: true })[0]
  assert.equal((await sim.execute({ action: 'visit', userId: subject.id }, { ...f.context, qzone: operation => f.service.executeQzone(operation, f.context) })).status, 'failed')
  assert.deepEqual(f.effects, [])
})

test('explicit red-packet tool uses its original queue and source guards while preserving real amount and dedup', async t => {
  const f = await fixture(t); f.context.request = { messageId: 'human-1', text: '请抢这个红包', mentions: [], replyMessageId: f.packet.source.messageId }
  const result = await tool(f, 'grabRedBagTool').execute({}, f.context)
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.parse(result.content).amountFen, 123)
  assert.deepEqual(f.effects.map(item => item[0]), ['grab']); assert.ok(f.events.includes('queue:red-packet'))
  assert.ok(f.sources.some(source => source.messageId === 'human-1')); assert.ok(f.sources.some(source => source.messageId === f.packet.source.messageId))
  const duplicate = await f.restart().builtIn.find(item => item.name === 'grabRedBagTool').execute({}, f.context)
  assert.notEqual(duplicate.status, 'succeeded'); assert.equal(f.effects.length, 1)
})

test('automatic packets use the trusted guard and autonomous authorization without opening autonomous public tools', async t => {
  const f = await fixture(t)
  const result = await f.service.automatic(f.packet, binding, f.guard)
  assert.equal(result.state, 'confirmed'); assert.equal(result.amountFen, 123); assert.deepEqual(f.effects.map(item => item[0]), ['grab'])
  assert.ok(f.permissions.some(row => row.name === 'grabRedBagTool' && row.actor.kind === 'autonomous'))
  f.context.actor = { kind: 'autonomous' }; f.context.request.text = '请抢这个红包'
  assert.equal((await tool(f, 'grabRedBagTool').execute({}, f.context)).status, 'failed'); assert.equal(f.effects.length, 1)
  const g = await fixture(t); g.config.redPackets.automatic.toolConfigured = false
  assert.notEqual((await g.service.automatic(g.packet, binding, g.guard)).state, 'confirmed'); assert.deepEqual(g.effects, [])
})

test('unknown gift and packet results survive reconstructed services without additional native attempts', async t => {
  const f = await fixture(t, { giftReceipt: { state: 'unknown' }, packetReceipt: { state: 'unknown' } })
  assert.equal((await tool(f, 'sendGiftTool').execute({}, f.context)).status, 'unknown')
  assert.equal((await f.restart().builtIn.find(item => item.name === 'sendGiftTool').execute({}, f.context)).status, 'unknown')
  f.context.request = { messageId: 'human-2', text: '请抢这个红包', mentions: [], replyMessageId: f.packet.source.messageId }
  assert.equal((await tool(f, 'grabRedBagTool').execute({}, f.context)).status, 'unknown')
  assert.equal((await f.restart().builtIn.find(item => item.name === 'grabRedBagTool').execute({}, f.context)).status, 'unknown')
  assert.deepEqual(f.effects.map(item => item[0]), ['gift', 'grab'])
})
