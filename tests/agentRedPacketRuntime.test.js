import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { loadRedPacketSource as load, redPacketMemoryStorage, redPacketRedis } from './helpers/agentRedPacketSource.mjs'

const { createAgentRedPacketRuntime, createAgentRedPacketAutomaticProducer, hasAgentRedPacketRequest } = await load('modules/runtime/infrastructure/agentRedPacketRuntime.js')
const { createAgentRedPacketLedger } = await load('modules/runtime/infrastructure/agentRedPacketLedger.js')
const { createAgentRedPacketTools } = await load('modules/tools/infrastructure/agentRedPacketTools.js')
const account = { platform: 'qq', namespace: 'global', id: '10001' }, author = { ...account, id: '20001' }
const target = { account, kind: 'group', id: '30001' }
const binding = { source: 'configured', id: 'bound', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'qq', target }
const snapshot = (overrides = {}) => ({ version: 1, target, source: { messageId: 'wallet-1', author, at: Date.now() - 1000 }, observedAt: Date.now(),
  packetRef: 'packet:0123456789abcdef', packetIdentity: 'a'.repeat(64), kind: 'normal', title: '红包', exclusiveForBot: false, ...overrides })

function fixture(settings = {}) {
  const storage = settings.storage ?? redPacketMemoryStorage(), effects = [], calls = [], waits = []
  let current = true, sourceCurrent = true
  const packet = settings.packet ?? snapshot({ kind: settings.kind ?? 'normal' })
  const p = { enabled: true, allowExplicit: true, allowPasswordSend: true, ...settings.policy }
  const context = { binding, actor: { kind: 'user', user: author }, request: { messageId: 'human-1', text: '请抢这个红包', mentions: [], replyMessageId: packet.source.messageId },
    signal: new AbortController().signal, isCurrent: () => current, async ensureCurrent() {}, async isSourceAvailable() { return sourceCurrent }, ...settings.context }
  const auto = { binding: context.binding, signal: context.signal, isCurrent: context.isCurrent, ensureCurrent: context.ensureCurrent, isSourceAvailable: context.isSourceAvailable }
  let f
  const port = {
    async read(_, id, guard) { calls.push('read:' + id); await guard.ensureCurrent(); return settings.read ? settings.read(id, f) : id === packet.source.messageId ? packet : undefined },
    async recent(_, guard) { calls.push('recent:' + guard.limit); await guard.ensureCurrent(); return settings.recent ?? [packet] },
    async revalidate(value, guard) { calls.push('revalidate:' + value.source.messageId); await guard.ensureCurrent(); return settings.revalidate ? settings.revalidate(f) : true },
    async sendPassword(value, guard) { calls.push('password'); await guard.ensureCurrent(); effects.push('password'); return settings.password ? settings.password(f, guard) : { state: 'confirmed', messageId: 'password-1' } },
    async grab(value, guard) { calls.push('grab'); await guard.ensureCurrent(); effects.push('grab'); return settings.grab ? settings.grab(f, guard) : { state: 'confirmed', amountFen: 123 } },
  }
  const runtime = createAgentRedPacketRuntime({ storage, port, policy: () => p, wait: async (ms, signal) => { waits.push(ms); await settings.wait?.(f, signal) }, ...settings.options })
  f = { storage, effects, calls, waits, context, auto, packet, policy: p, runtime, ledger: createAgentRedPacketLedger(storage),
    revoke() { current = false }, revokeSource() { sourceCurrent = false }, run: request => runtime.execute(context, request),
    automatic: () => runtime.executeAutomatic(auto, packet) }
  return f
}
function record(f) { return f.ledger.inspect(f.context.binding.target.account, f.packet.packetIdentity) }

test('human requests preserve positive intent and reject denial, reports, examples and mixed conflicts', () => {
  for (const text of ['抢红包', '帮我抢一下这个红包', '确认领取这个口令红包', '请领这个红包']) assert.equal(hasAgentRedPacketRequest(text), true, text)
  for (const text of ['不要抢红包，请查天气', '先不抢红包，抢红包', '只是举例：抢红包', '他说请抢红包', '“抢红包”是个例子', '红包今天很多', '帮我发红包']) assert.equal(hasAgentRedPacketRequest(text), false, text)
})

test('disabled, revoked, private, autonomous and ungrounded human requests perform zero native calls', async () => {
  for (const settings of [{ policy: { enabled: false } }, { policy: { allowExplicit: false } }, { context: { actor: { kind: 'autonomous' } } },
    { context: { actor: { kind: 'commitment' } } }, { context: { actor: { kind: 'user', user: { ...author, namespace: 'foreign' } } } },
    { context: { actor: { kind: 'user', user: account } } }, { context: { ensureCurrent: undefined } },
    { context: { binding: { ...binding, target: { ...target, kind: 'private' } } } },
    { context: { request: { messageId: 'x', text: '不要抢红包，请查天气', mentions: [] } } }]) {
    const f = fixture(settings)
    assert.notEqual((await f.run()).state, 'confirmed'); assert.deepEqual(f.calls, [])
  }
  const f = fixture(); f.revoke(); await f.run(); assert.deepEqual(f.calls, [])
})

test('confirm defaults true and false cancels without looking up wallet/history or writing claims', async () => {
  const f = fixture(), cancelled = await f.run({ confirm: false })
  assert.equal(cancelled.state, 'cancelled'); assert.deepEqual(f.calls, []); assert.equal(f.storage.rows.size, 0)
  assert.equal((await f.run()).state, 'confirmed'); assert.deepEqual(f.effects, ['grab'])
})

test('normal packets need fresh proof and persist pending before one native grab', async () => {
  const f = fixture({ grab: async f => { const pending = await record(f); assert.equal(pending.phase, 'grab_pending'); assert.equal(pending.state, 'active'); return { state: 'confirmed', amountFen: 123 } } })
  const done = await f.run()
  assert.deepEqual(done, { state: 'confirmed', code: 'red_packet_grabbed', phase: 'finished', passwordConfirmed: false, grabbed: true, amountFen: 123 })
  assert.deepEqual(f.effects, ['grab']); assert.deepEqual(f.waits, [])
  assert.equal((await record(f)).state, 'confirmed')
  assert.equal(Object.hasOwn(done, 'messageId'), false)
})

test('password and grab are separate durable stages with a 500ms barrier', async () => {
  const states = []
  const f = fixture({ kind: 'password', password: async f => { states.push((await record(f)).phase); return { state: 'confirmed', messageId: 'real-password-id' } },
    wait: async f => { const saved = await record(f); states.push(saved.phase); assert.equal(saved.passwordMessageId, 'real-password-id') },
    grab: async f => { states.push((await record(f)).phase); return { state: 'confirmed', amountFen: 8 } } })
  const done = await f.run()
  assert.equal(done.state, 'confirmed'); assert.equal(done.passwordConfirmed, true)
  assert.deepEqual(f.effects, ['password', 'grab']); assert.deepEqual(f.waits, [500]); assert.deepEqual(states, ['password_pending', 'password_confirmed', 'grab_pending'])
})

test('production wait actually delays grab after confirmed password', async () => {
  let passwordAt, grabAt
  const f = fixture({ kind: 'password', options: { wait: undefined }, password: async () => { passwordAt = performance.now(); return { state: 'confirmed', messageId: 'real-password' } },
    grab: async () => { grabAt = performance.now(); return { state: 'confirmed', amountFen: 1 } } })
  assert.equal((await f.run()).state, 'confirmed'); assert.ok(grabAt - passwordAt >= 490)
})

test('password send requires its separate grant and never inherits a plain grab authorization', async () => {
  const f = fixture({ kind: 'password', policy: { allowPasswordSend: false } })
  assert.equal((await f.run()).code, 'red_packet_password_not_authorized'); assert.deepEqual(f.effects, []); assert.equal(f.storage.rows.size, 0)
})

for (const receipt of [{ state: 'unknown' }, { state: 'confirmed' }, { state: 'confirmed', messageId: '0' }, { state: 'confirmed', messageId: { toString() { throw new Error('should not coerce') } } }, { state: 'confirmed', messageId: 'one', pc_body: 'PRIVATE_CREDENTIAL' }]) {
  test('uncertain or malformed password receipts freeze and never wait/grab: ' + JSON.stringify(receipt), async () => {
    const f = fixture({ kind: 'password', password: async () => receipt })
    assert.equal((await f.run()).state, 'unknown'); assert.deepEqual(f.effects, ['password']); assert.deepEqual(f.waits, [])
    assert.equal((await record(f)).state, 'unknown'); assert.equal((await f.run()).state, 'unknown'); assert.deepEqual(f.effects, ['password'])
  })
}

test('a definite password rejection is terminal and never replaced by a retry or a grab', async () => {
  const f = fixture({ kind: 'password', password: async () => ({ state: 'failed', code: 'PRIVATE_ERROR' }) })
  assert.equal((await f.run()).state, 'failed'); assert.equal((await f.run()).state, 'failed'); assert.deepEqual(f.effects, ['password']); assert.deepEqual(f.waits, [])
})

test('revocation immediately after confirmed password persists receipt and stops before wait or grab', async () => {
  for (const revoke of [f => f.revoke(), f => f.revokeSource(), f => { f.policy.allowExplicit = false }, f => { f.policy.allowPasswordSend = false }, f => { f.context.binding = { ...binding, revision: 'two' } }]) {
    const f = fixture({ kind: 'password', password: async f => { revoke(f); return { state: 'confirmed', messageId: 'real-password' } } })
    const stopped = await f.run()
    assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.passwordConfirmed, true); assert.deepEqual(f.effects, ['password']); assert.deepEqual(f.waits, [])
    const saved = await record(f); assert.equal(saved.phase, 'password_confirmed'); assert.equal(saved.passwordConfirmed, true); assert.equal(saved.state, 'cancelled')
  }
})

test('source privacy withdrawal during the 500ms wait stops the next native proof and grab', async () => {
  const f = fixture({ kind: 'password', wait: async f => f.revokeSource() })
  const stopped = await f.run(); assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.passwordConfirmed, true)
  assert.deepEqual(f.effects, ['password']); assert.equal(f.calls.at(-1), 'password')
})

test('timeout during password dispatch freezes late confirmation and never sends a grab', async () => {
  let resolve
  const f = fixture({ kind: 'password', options: { timeoutMs: 50 }, password: () => new Promise(done => { resolve = done }) })
  assert.equal((await f.run()).state, 'unknown'); resolve({ state: 'confirmed', messageId: 'late-real-id' }); await delay(10)
  assert.deepEqual(f.effects, ['password']); assert.deepEqual(f.waits, []); assert.equal((await f.run()).state, 'unknown')
})

for (const receipt of [{ state: 'unknown' }, { state: 'confirmed', amountFen: 0 }, { state: 'confirmed', amountFen: 0.5 },
  { state: 'confirmed', amountFen: '100' }, { state: 'confirmed', amountFen: 100, messageId: 'invented' }]) {
  test('grab confirmation needs a positive integer amount and no fabricated message ID: ' + JSON.stringify(receipt), async () => {
    const f = fixture({ grab: async () => receipt })
    assert.equal((await f.run()).state, 'unknown'); assert.equal((await f.run()).state, 'unknown'); assert.deepEqual(f.effects, ['grab'])
  })
}

test('a native definite grab failure freezes this real packet regardless of another command', async () => {
  const storage = redPacketMemoryStorage(), first = fixture({ storage, grab: async () => ({ state: 'failed', code: 'expired' }) })
  assert.equal((await first.run()).state, 'failed')
  const second = fixture({ storage, context: { request: { messageId: 'another-human-trigger', text: '抢红包', mentions: [], replyMessageId: 'wallet-1' } } })
  assert.equal((await second.run()).state, 'failed'); assert.deepEqual(second.effects, [])
})

test('quoted wallet is preferred; recent search and quote failure fallback require separate grants', async () => {
  const noGrant = fixture({ read: () => undefined })
  assert.equal((await noGrant.run()).code, 'red_packet_not_found'); assert.deepEqual(noGrant.calls, ['read:wallet-1'])
  const noFallback = fixture({ policy: { allowRecentSearch: true }, read: () => undefined })
  await noFallback.run(); assert.deepEqual(noFallback.calls, ['read:wallet-1'])
  const packet = snapshot({ source: { messageId: 'recent-wallet', author, at: Date.now() - 1000 } })
  const fallback = fixture({ packet, context: { request: { messageId: 'human', text: '抢最近的红包', mentions: [], replyMessageId: 'not-wallet' } },
    policy: { allowRecentSearch: true, allowReferenceFallback: true, recentLimit: 1000 } })
  assert.equal((await fallback.run()).state, 'confirmed'); assert.deepEqual(fallback.calls.slice(0, 3), ['read:not-wallet', 'recent:1000', 'read:recent-wallet'])
  const quoted = fixture({ policy: { allowRecentSearch: true, allowReferenceFallback: true } })
  await quoted.run(); assert.ok(!quoted.calls.some(value => value.startsWith('recent:')))
})

test('a plain human request may search latest only under its explicit recent-search grant', async () => {
  const f = fixture({ context: { request: { messageId: 'human', text: '帮我抢最近的红包', mentions: [] } }, policy: { allowRecentSearch: true } })
  assert.equal((await f.run()).state, 'confirmed'); assert.deepEqual(f.calls.slice(0, 3), ['read:human', 'recent:100', 'read:wallet-1'])
})

test('live revocation of recent-search permission stops after history and before source/native grab', async () => {
  const f = fixture({ context: { request: { messageId: 'human', text: '抢最近的红包', mentions: [] } }, policy: { allowRecentSearch: true },
    read: (id, f) => { if (id === 'human') { queueMicrotask(() => { f.policy.allowRecentSearch = false }); return undefined } return f.packet } })
  assert.notEqual((await f.run()).state, 'confirmed'); assert.deepEqual(f.effects, [])
})

test('explicit message/ref selectors are limited to trusted current/reply/visible sources', async () => {
  const unknown = fixture(); assert.equal((await unknown.run({ messageId: 'made-up' })).code, 'red_packet_untrusted_selection'); assert.deepEqual(unknown.calls, [])
  const missing = fixture(); assert.equal((await missing.run({ packetRef: 'made-up-ref' })).code, 'red_packet_untrusted_selection'); assert.deepEqual(missing.calls, [])
  const packet = snapshot(), visible = fixture({ packet, context: { visiblePackets: [packet] } })
  assert.equal((await visible.run({ packetRef: packet.packetRef })).state, 'confirmed')
  const changed = fixture({ packet: { ...packet, packetIdentity: 'b'.repeat(64) }, context: { visiblePackets: [packet] } })
  assert.equal((await changed.run({ packetRef: packet.packetRef })).state, 'failed'); assert.deepEqual(changed.effects, [])
})

test('source identity, native revalidation and exclusive recipient evidence cannot be guessed', async () => {
  for (const settings of [{ revalidate: () => false }, { packet: snapshot({ kind: 'exclusive', exclusiveForBot: false }) },
    { packet: snapshot({ target: { ...target, id: 'foreign-room' } }) }, { packet: snapshot({ source: { messageId: 'wallet-1', author: { ...author, namespace: 'foreign' }, at: Date.now() } }) }]) {
    const f = fixture(settings); assert.notEqual((await f.run()).state, 'confirmed'); assert.deepEqual(f.effects, [])
  }
})

test('password receipt persistence failure prevents grab and freezes the packet across runtime recreation', async () => {
  const storage = redPacketMemoryStorage(), original = storage.eval
  storage.eval = async (script, args) => {
    if (script.includes('KEEPTTL') && JSON.parse(args.arguments[1]).phase === 'password_confirmed') throw new Error('injected settlement failure')
    return original(script, args)
  }
  const first = fixture({ storage, kind: 'password' })
  assert.equal((await first.run()).state, 'unknown'); assert.deepEqual(first.effects, ['password']); assert.deepEqual(first.waits, [])
  const second = fixture({ storage, kind: 'password' })
  assert.equal((await second.run()).state, 'unknown'); assert.deepEqual(second.effects, [])
})

test('grab receipt persistence failure reports unknown and never repeats the native claim', async () => {
  const storage = redPacketMemoryStorage(), original = storage.eval
  storage.eval = async (script, args) => { if (script.includes('KEEPTTL') && JSON.parse(args.arguments[1]).state === 'confirmed') throw new Error('fail after native success'); return original(script, args) }
  const f = fixture({ storage }); assert.equal((await f.run()).state, 'unknown'); assert.deepEqual(f.effects, ['grab'])
  assert.equal((await fixture({ storage }).run()).state, 'unknown')
})

test('real Redis packet claims survive fresh runtime, different human commands and binding revisions', async t => {
  const redis = await redPacketRedis(t), first = fixture({ storage: redis.storage })
  assert.equal((await first.run()).state, 'confirmed')
  const alias = snapshot({ source: { messageId: 'wallet-alias', author, at: Date.now() - 1000 } })
  for (const context of [{ request: { messageId: 'other-human-command', text: '抢红包', mentions: [], replyMessageId: 'wallet-alias' } },
    { binding: { ...binding, revision: 'new-revision', agentId: 'other-role' }, request: { messageId: 'third-human-command', text: '抢红包', mentions: [], replyMessageId: 'wallet-alias' } }]) {
    const second = fixture({ storage: redis.storage, packet: alias, context }); assert.equal((await second.run()).state, 'failed'); assert.deepEqual(second.effects, [])
  }
  const keys = await redis.reader.keys(redis.prefix + 'agent:red-packet:v1:*'); assert.equal(keys.length, 1)
  const ttl = await redis.reader.ttl(keys[0]); assert.ok(ttl > 604790 && ttl <= 604800)
  const raw = await redis.reader.get(keys[0]); for (const sensitive of ['wallet-', 'human-', '红包', 'pc_body', 'msg_seq', 'string_index', 'real-password-id', 'PRIVATE_CREDENTIAL', binding.revision, target.id]) assert.ok(!raw.includes(sensitive), sensitive)
})

test('real Redis concurrent runtimes permit exactly one side effect for a packet but separate receiving robots may each claim', async t => {
  const redis = await redPacketRedis(t), fixtures = Array.from({ length: 12 }, () => fixture({ storage: redis.storage }))
  const results = await Promise.all(fixtures.map(f => f.run()))
  assert.equal(results.filter(value => value.state === 'confirmed').length, 1); assert.equal(fixtures.flatMap(f => f.effects).length, 1)
  const other = { ...account, id: '10002' }, otherTarget = { ...target, account: other }, otherPacket = snapshot({ target: otherTarget })
  const separate = fixture({ storage: redis.storage, packet: otherPacket, context: { binding: { ...binding, target: otherTarget } } })
  assert.equal((await separate.run()).state, 'confirmed'); assert.deepEqual(separate.effects, ['grab'])
})

test('real Redis restart freezes all interrupted phases including a confirmed password', async t => {
  const redis = await redPacketRedis(t)
  for (const phase of ['claimed', 'password_pending', 'password_confirmed', 'grab_pending']) {
    const packet = snapshot({ packetIdentity: ({ claimed: '1', password_pending: '2', password_confirmed: '3', grab_pending: '4' })[phase].repeat(64), kind: 'password' })
    const claim = await createAgentRedPacketLedger(redis.storage).claim(binding, packet); assert.equal(claim.state, 'claimed')
    if (phase !== 'claimed') await claim.session.begin('password_pending')
    if (phase === 'password_confirmed' || phase === 'grab_pending') await claim.session.confirmPassword('real-password')
    if (phase === 'grab_pending') await claim.session.begin('grab_pending')
    const fresh = fixture({ storage: redis.storage, packet })
    const replay = await fresh.run(); assert.equal(replay.state, 'unknown'); assert.equal(replay.phase, phase); assert.deepEqual(fresh.effects, []); assert.deepEqual(fresh.waits, [])
  }
})

test('corrupt or wrong-type real Redis records fail closed without any native effect', async t => {
  const redis = await redPacketRedis(t), f = fixture({ storage: redis.storage })
  await f.ledger.claim(binding, f.packet)
  const [key] = await redis.reader.keys(redis.prefix + 'agent:red-packet:v1:*')
  await redis.reader.set(key, '{"version":1,"state":"confirmed","untrusted":"PRIVATE_CREDENTIAL"}')
  assert.notEqual((await f.run()).state, 'confirmed'); assert.deepEqual(f.effects, [])
  await redis.reader.del(key); await redis.reader.lPush(key, 'unexpected-type')
  assert.notEqual((await fixture({ storage: redis.storage }).run()).state, 'confirmed')
})

test('automatic producer has an independent grant and never needs or manufactures a human request', async () => {
  for (const automatic of [undefined, { enabled: false, toolConfigured: true }, { enabled: true, toolConfigured: false }]) {
    const f = fixture({ policy: { automatic } }); assert.notEqual((await f.automatic()).state, 'confirmed'); assert.deepEqual(f.calls, [])
  }
  const f = fixture({ policy: { allowExplicit: false, automatic: { enabled: true, toolConfigured: true } }, options: { random: () => 0 } })
  assert.equal((await createAgentRedPacketAutomaticProducer(f.runtime).accept(f.auto, f.packet)).state, 'confirmed')
  assert.deepEqual(f.effects, ['grab']); assert.equal((await f.run()).state, 'failed')
})

test('exclusive automatic packets only target the robot and bypass random/cooldown immediately', async () => {
  let draws = 0
  for (const exclusiveForBot of [false, true]) {
    const f = fixture({ packet: snapshot({ kind: 'exclusive', exclusiveForBot }), policy: { automatic: { enabled: true, toolConfigured: true } }, options: { random: () => { draws++; return 0.99 } } })
    assert.equal((await f.automatic()).state, exclusiveForBot ? 'confirmed' : 'skipped')
    assert.equal(f.storage.rows.size, exclusiveForBot ? 1 : 0)
  }
  assert.equal(draws, 0)
})

test('non-exclusive automatic probability preserves 30%-80% draw and sixty second account/group cooldown', async t => {
  const redis = await redPacketRedis(t), automatic = { enabled: true, toolConfigured: true }
  const values = [0, 0.31], miss = fixture({ storage: redis.storage, policy: { automatic }, options: { random: () => values.shift() } })
  assert.equal((await miss.automatic()).code, 'red_packet_probability_skipped'); assert.deepEqual(miss.effects, [])
  const high = [0.999, 0.79], hit = fixture({ storage: redis.storage, policy: { automatic }, options: { random: () => high.shift() } })
  assert.equal((await hit.automatic()).state, 'confirmed')
  const next = fixture({ storage: redis.storage, packet: snapshot({ packetIdentity: 'c'.repeat(64) }), policy: { automatic }, options: { random: () => 0 } })
  assert.equal((await next.automatic()).code, 'red_packet_cooldown'); assert.deepEqual(next.effects, [])
  const [key] = await redis.reader.keys(redis.prefix + 'agent:red-packet:v1:cooldown:*')
  assert.ok(await redis.reader.pTTL(key) > 59000)
})

test('automatic passwords require their own send grant even when manual passwords are granted', async () => {
  const f = fixture({ kind: 'password', policy: { allowPasswordSend: true, automatic: { enabled: true, toolConfigured: true } }, options: { random: () => 0 } })
  assert.equal((await f.automatic()).code, 'red_packet_password_not_authorized'); assert.deepEqual(f.effects, [])
  f.policy.automatic.allowPasswordSend = true
  assert.equal((await f.automatic()).state, 'confirmed'); assert.deepEqual(f.effects, ['password', 'grab'])
})

test('tools are absent by default; enabled schema keeps confirm=true and strips all raw wallet inputs', async () => {
  assert.deepEqual(createAgentRedPacketTools(), []); assert.deepEqual(createAgentRedPacketTools({ enabled: true }), [])
  const f = fixture(), [tool] = createAgentRedPacketTools({ enabled: true, execute: (request, context) => f.runtime.execute({ ...context, isSourceAvailable: f.context.isSourceAvailable }, request) })
  assert.equal(tool.name, 'grabRedBagTool'); assert.equal(tool.dataPolicy, 'ephemeral'); assert.equal(tool.parameters.properties.confirm.default, true)
  assert.equal(tool.parameters.additionalProperties, false); assert.deepEqual(Object.keys(tool.parameters.properties), ['confirm', 'message_id', 'packet_ref'])
  for (const input of [{ pc_body: 'PRIVATE' }, { index: 'PRIVATE' }, { msg_seq: '1' }, { confirm: 'true' }, { message_id: 'x', packet_ref: 'y' }]) {
    assert.equal((await tool.execute(input, f.context)).status, 'failed'); assert.deepEqual(f.effects, [])
  }
  const done = await tool.execute({}, f.context); assert.equal(done.status, 'succeeded'); assert.equal(JSON.parse(done.content).grabbed, true)
})

test('tool local cancellation, unknown outcome and malformed runtime receipts never trigger an extra send', async () => {
  const f = fixture(); let calls = 0
  const [tool] = createAgentRedPacketTools({ enabled: true, execute: async () => { calls++; return { state: 'unknown', phase: 'grab_pending', code: 'red_packet_outcome_unknown', passwordConfirmed: false, grabbed: false } } })
  assert.equal(JSON.parse((await tool.execute({ confirm: false }, f.context)).content).state, 'cancelled'); assert.equal(calls, 0)
  assert.equal((await tool.execute({}, f.context)).status, 'unknown'); assert.equal(calls, 1)
  const [bad] = createAgentRedPacketTools({ enabled: true, execute: async () => ({ state: 'confirmed', amountFen: 1, messageId: 'forged' }) })
  assert.equal((await bad.execute({}, f.context)).status, 'unknown'); assert.deepEqual(f.effects, [])
})

test('selector and snapshot accessors/proxies never execute or reach a native operation', async () => {
  let touched = 0
  const proxy = value => new Proxy(value, { get() { touched++; throw Error('trap') }, getPrototypeOf() { touched++; throw Error('trap') }, ownKeys() { touched++; throw Error('trap') } })
  const accessor = (value, key) => { const row = { ...value }; Object.defineProperty(row, key, { enumerable: true, get() { touched++; throw Error('getter') } }); return row }
  for (const request of [proxy({}), accessor({}, 'confirm'), { packetRef: { toString() { touched++; return 'invented' } } }]) {
    const f = fixture(); assert.equal((await f.run(request)).state, 'failed'); assert.deepEqual(f.calls, [])
  }
  const array = [snapshot()]; Object.defineProperty(array, '0', { enumerable: true, get() { touched++; throw Error('selector getter') } })
  for (const visiblePackets of [array, proxy([]), [proxy(snapshot())], [accessor(snapshot(), 'packetIdentity')]]) {
    const f = fixture({ context: { visiblePackets } }); assert.equal((await f.run()).state, 'failed'); assert.deepEqual(f.effects, [])
  }
  for (const input of [proxy({}), accessor({}, 'confirm'), { confirm: { valueOf() { touched++; return true } } }]) {
    const f = fixture(), [tool] = createAgentRedPacketTools({ enabled: true, execute: request => f.run(request) })
    assert.equal((await tool.execute(input, f.context)).status, 'failed'); assert.deepEqual(f.effects, [])
  }
  assert.equal(touched, 0)
})

test('source evidence is bounded, fresh, namespace-scoped and contains no fake zero IDs', async () => {
  for (const packet of [snapshot({ observedAt: Date.now() - 31_000 }), snapshot({ observedAt: Date.now() + 2000 }), snapshot({ title: '文'.repeat(257) }),
    snapshot({ source: { messageId: '0', author, at: Date.now() } }), snapshot({ packetIdentity: 'not-an-identity' })]) {
    const f = fixture({ packet }); assert.notEqual((await f.run()).state, 'confirmed'); assert.deepEqual(f.effects, [])
  }
})
