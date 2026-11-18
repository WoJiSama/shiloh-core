import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'

// Build/package verification uses dist by default. Source mode is explicit and
// never writes shared build output.
const root = fileURLToPath(new URL('../', import.meta.url)), urls = new Map()
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
const ts = sourceTest ? (await import('typescript')).default : undefined
const moduleUrl = relative => sourceTest ? sourceUrl(relative) : pathToFileURL(path.join(root, relative.replace(/^src\//u, 'dist/backend/').replace(/\.ts$/u, '.js'))).href
const fresh = new Set(['simulationRuntime', 'simulationVideoCardLedger', 'agentVideoCard', 'simTools'])
function sourceUrl(relative) {
  if (urls.has(relative)) return urls.get(relative)
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu, (_all, from, quote, specifier) => {
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier))
    const url = fresh.has(path.basename(dependency, '.js')) ? sourceUrl(dependency.replace(/\.js$/u, '.ts')) : pathToFileURL(path.join(root, dependency.replace(/^src\//u, 'dist/backend/'))).href
    return `${from}${quote}${url}${quote}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${relative.replace(/\.ts$/u, '.test-source.js')}`).toString('base64')}`; urls.set(relative, url); return url
}
const { createSimulationRuntime } = await import(moduleUrl('src/modules/simulation/infrastructure/simulationRuntime.ts'))
const { createSimulationVideoCardLedger } = await import(moduleUrl('src/modules/simulation/infrastructure/simulationVideoCardLedger.ts'))
const testOptions = { skip: !redisAvailable, timeout: 15_000 }
const AT = 1_790_000_000_000, BVID = 'BV1xx411c7mD'
const account = { platform: 'fixture', namespace: 'video-card', id: 'robot' }
const target = { account, kind: 'group', id: 'room' }
const bindingFor = (address = target, changes = {}) => ({ source: 'configured', id: 'configured-video', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'video-connection', target: address, ...changes })
const card = (changes = {}) => ({ provider: 'bilibili', id: BVID, title: '相关视频', author: '作者', durationSeconds: 123, pageUrl: `https://www.bilibili.com/video/${BVID}`, ...changes })
let sequence = 0
const call = (name, args = {}) => ({ id: `video-card-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...toolCalls) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }], usage: { total_tokens: 1 } })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '视频卡验证已结束' })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, description) {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) { if (await check()) return; await delay(10) }
  assert.fail(description)
}
async function ledgerEntries(f) {
  const keys = await f.reader.keys(`${f.prefix}shiloh:sim:video-card:v1:*`)
  return Promise.all(keys.map(async key => ({ key, value: JSON.parse(await f.reader.get(key)), ttl: await f.reader.pTTL(key) })))
}
async function fixture(t, settings = {}) {
  const redis = settings.redis ?? await createAgentRedisFixture(t, 'simulation-video-card')
  const clock = settings.clock ?? { value: AT }, chosen = settings.target ?? target, key = simulationAddressKey(chosen)
  let binding = settings.binding ?? bindingFor(chosen), current = true, round = 0, native = 0
  const state = createDefaultSimSession(clock.value)
  state.bootstrapSent = true; state.botId = chosen.account.id; state.bindingToken = agentBindingToken(binding); state.personaId = agentPersonaScopeId(binding.agentId)
  state.nextProactiveCheckAt = settings.proactive ? 0 : clock.value + 86_400_000; state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  if (await redis.storage.get(`shiloh:sim:g:${key}`) === null) await redis.storage.set(`shiloh:sim:g:${key}`, JSON.stringify(state))
  const attempts = [], sends = [], texts = [], resolutions = [], replies = [], requests = [], errors = [], reviews = []
  const tool = settings.execute ? { name: 'videoCardProbe', description: '中立视频卡发送验证', parameters: { type: 'object', properties: {}, additionalProperties: false }, async execute(_args, event) { return settings.execute(event, f) } } : undefined
  const storage = settings.storage?.(redis.storage) ?? redis.storage
  const runtime = createSimulationRuntime({
    redis: storage, now: () => clock.value, random: () => 0.99, durableIngress: true,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    handlesTarget: () => true, allowsConversationAI: () => current,
    getSelf: (_hint, selected) => ({ id: selected?.id ?? chosen.account.id, name: '角色' }),
    getPersona: () => ({ binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '角色' }, systemContent: '' }),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: settings.review === true },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false },
      wake: { probability: 0, proactiveProbability: settings.proactive ? 1 : 0, proactiveIdleMs: 60_000, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: settings.maxSends ?? 3, maxToolRounds: 6, maxTurnsPerDay: 100 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ useTools: true }),
    ...(tool ? { getBoundTools: () => [tool] } : {}),
    ...(settings.allowsToolInput ? { allowsToolInput: settings.allowsToolInput } : {}),
    async resolveVideoCard(input, address, guard) { resolutions.push({ input, address, guard }); return settings.resolve ? settings.resolve(input, address, guard, f) : card() },
    async resolveBilibiliCard() { native++; return { ok: true, cardJson: 'native JSON must not enter Core' } },
    async sendGroupMessage() { native++; return { ok: true, messageId: 'native-forbidden' } },
    messageActions: {
      async send(action, guard) { if (guard.isCurrent?.() === false) return { state: 'failed', code: 'stale' }; texts.push(action); return { state: 'sent', messageId: 'text-confirmed' } },
      async sendVideoCard(action, guard) {
        attempts.push({ action: structuredClone(action), guard });
        const records = await ledgerEntries(redis)
        assert.equal(records.filter(entry => entry.value.state === 'pending').length, 2, 'attempt and cooldown must persist before transport')
        assert.equal(guard.signal.aborted, false); assert.equal(guard.isCurrent(), true)
        const result = settings.deliver ? await settings.deliver(action, guard, f) : settings.receipt ?? { state: 'sent', messageId: `video-confirmed-${attempts.length}` }
        if (result?.state === 'sent' && guard.isCurrent()) sends.push(structuredClone(action))
        return result
      },
    },
    async reviewCharacter(request) { reviews.push(request); await settings.onReview?.(f); return { choices: [{ message: { content: JSON.stringify({ verdict: settings.rejectReview ? 'reject' : 'accept', issues: [] }) } }] } },
    recordToolResult(reply) { replies.push(reply) },
    async YTapi(request) {
      requests.push(request); const index = round++
      return settings.script ? settings.script(index, f) : index === 0 ? response(call(tool?.name ?? 'simShareVideoCard', tool ? {} : { query: '相关' })) : response(finish())
    },
  })
  t.after(() => runtime.stop())
  const f = { ...redis, runtime, clock, target: chosen, attempts, sends, texts, resolutions, replies, requests, errors, reviews,
    get native() { return native }, get binding() { return binding },
    rebind() { binding = { ...binding, revision: 'rebound', agentId: 'replacement' } },
    mute() { current = false; runtime.invalidateConversation(chosen) },
    session: async () => JSON.parse(await redis.storage.get(`shiloh:sim:g:${key}`)),
    async background() {
      await runtime.ingest({ version: 1, conversation: chosen, sender: { ...chosen.account, id: 'human' }, messageId: `background-${++sequence}`, occurredAt: clock.value,
        text: '普通聊天背景', parts: [{ kind: 'text', text: '普通聊天背景' }], mentions: [], directedToAccount: false })
      await runtime.drain()
    },
    async sweep() {
      const before = requests.length; round = 0; clock.value += 2 * 60 * 60_000
      await runtime.sweepOnce()
      await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, 'proactive video turn did not settle')
    },
    async run() {
      round = 0; const before = requests.length
      const messageId = `human-${++sequence}`
      await runtime.ingest({ version: 1, conversation: chosen, sender: { ...chosen.account, id: 'human' }, messageId, occurredAt: clock.value,
        text: '请分享当前相关视频', parts: [{ kind: 'text', text: '请分享当前相关视频' }], mentions: [chosen.account], directedToAccount: true })
      await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, `video turn did not settle: ${errors.join(' | ')}`)
      return messageId
    },
  }
  return f
}

test('neutral simShareVideoCard resolves metadata under the turn guard and sends the exact bound action', testOptions, async t => {
  const f = await fixture(t, { review: true })
  await f.run()
  assert.equal(f.native, 0); assert.equal(f.resolutions.length, 1); assert.equal(f.sends.length, 1)
  assert.deepEqual(f.resolutions[0].input, { query: '相关' }); assert.deepEqual(f.resolutions[0].address, target)
  assert.ok(f.resolutions[0].guard.signal instanceof AbortSignal); assert.equal(typeof f.resolutions[0].guard.ensureCurrent, 'function')
  assert.deepEqual(f.sends[0], { version: 1, kind: 'video-card.send', target, binding: f.binding, card: card() })
  assert.equal(f.reviews.length, 1); const reviewed = JSON.stringify(f.reviews[0]); for (const text of [BVID, '相关视频', '作者', '123', card().pageUrl]) assert.ok(reviewed.includes(text))
  const session = await f.session(); assert.equal(session.sendTimes.length, 1); assert.ok(session.confirmedMessageIds.includes('video-confirmed-1'))
  const entries = await ledgerEntries(f); assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.value.state === 'sent'))
  assert.ok(entries.find(entry => entry.key.includes(':attempt:')).ttl > 6 * 86_400_000)
  assert.ok(entries.find(entry => entry.key.endsWith(':cooldown')).ttl > 19 * 60_000)
})

test('known failure releases cooldown but blocks every further card attempt in the same turn', testOptions, async t => {
  const seen = []
  const f = await fixture(t, { receipt: { state: 'failed', code: 'rejected' }, async execute(event) {
    seen.push(await event._sendAgentToolVideoCard(card()))
    seen.push(await event._sendAgentToolVideoCard(card({ title: '不同视频正文' })))
    return { ok: true }
  } })
  await f.run()
  assert.deepEqual(seen, [{ state: 'failed', code: 'rejected' }, { state: 'failed', code: 'duplicate_video_card_attempt' }])
  assert.equal(f.attempts.length, 1); assert.equal((await ledgerEntries(f)).filter(entry => entry.key.endsWith(':cooldown')).length, 0)
  f.clock.value += 1000; await f.run(); assert.equal(f.attempts.length, 2)
})

test('sent and unknown deliveries retain the 20 minute cooldown across runtime restarts', testOptions, async t => {
  for (const receipt of [{ state: 'sent', messageId: 'confirmed' }, { state: 'unknown' }]) {
    const redis = await createAgentRedisFixture(t, `video-restart-${receipt.state}`), clock = { value: AT }
    const first = await fixture(t, { redis, clock, receipt }); await first.run(); await first.runtime.stop()
    const second = await fixture(t, { redis, clock }); await second.run()
    assert.equal(first.attempts.length, 1); assert.equal(second.attempts.length, 0)
    // A genuinely new turn after cooldown can share again; it cannot resume the old attempt.
    clock.value += 20 * 60_000 + 1; await second.run(); assert.equal(second.attempts.length, 1)
  }
})

test('unknown transport prevents text and every following card in the same turn', testOptions, async t => {
  let blocked = 0
  const f = await fixture(t, { async deliver() { throw new Error('native response lost after gateway accepted') }, async execute(event) {
    assert.deepEqual(await event._sendAgentToolVideoCard(card()), { state: 'unknown' })
    await assert.rejects(event._sendAgentToolVideoCard(card()), /失效|未知/u); blocked++
    await assert.rejects(event._sendAgentToolMessage({ text: '后续正文' }), /未知/u); blocked++
    return { status: 'unknown' }
  } })
  await f.run(); assert.equal(f.attempts.length, 1); assert.equal(f.texts.length, 0); assert.equal(blocked, 2)
  assert.ok((await ledgerEntries(f)).every(entry => entry.value.state === 'unknown'))
})

test('replayed pending or unknown ledger attempts fence every later runtime send without retrying transport', testOptions, async t => {
  for (const replayState of ['pending', 'unknown']) {
    let blocked = 0, injected = false
    const f = await fixture(t, { storage(base) { return { ...base, async eval(script, options) {
      if (script.includes('simulation-video-card-claim-v1') && !injected) {
        injected = true
        await base.set(options.keys[0], JSON.stringify({ ...JSON.parse(options.arguments[0]), state: replayState }))
      }
      return base.eval(script, options)
    } } }, async execute(event) {
      assert.deepEqual(await event._sendAgentToolVideoCard(card()), { state: 'unknown' })
      await assert.rejects(event._sendAgentToolVideoCard(card()), /失效|未知/u); blocked++
      await assert.rejects(event._sendAgentToolMessage({ text: '不确定回执的文字补发' }), /未知/u); blocked++
      return { status: 'unknown' }
    } })
    await f.run()
    assert.equal(injected, true); assert.equal(blocked, 2); assert.equal(f.attempts.length, 0); assert.equal(f.texts.length, 0)
    const entries = await ledgerEntries(f)
    assert.equal(entries.length, 1); assert.equal(entries[0].value.state, replayState)
  }
})

test('queued video sends recheck the source guard after an earlier queued transport', testOptions, async t => {
  const entered = deferred(), release = deferred(); let sourceCurrent = true, result, finalChecks = 0
  const f = await fixture(t, { async deliver() { entered.resolve(); await release.promise; return { state: 'failed', code: 'known_rejection' } }, async execute(event) {
    const first = event._sendAgentToolVideoCard(card())
    await entered.promise
    const queued = event._sendAgentToolVideoCard(card(), () => true, new AbortController().signal, async () => { finalChecks++; if (!sourceCurrent) throw new Error('source revoked') })
    sourceCurrent = false; release.resolve(); await first
    try { result = await queued } catch (error) { result = error.message }
    return { ok: true }
  } })
  await f.run(); assert.equal(f.attempts.length, 1); assert.equal(finalChecks, 1); assert.equal(result, 'source revoked')
})

test('resolver completion after mute or rebind never reaches card transport', testOptions, async t => {
  for (const change of ['mute', 'rebind']) {
    const pending = deferred(), started = deferred()
    const f = await fixture(t, { async resolve(_input, _target, guard) { started.resolve(guard); return pending.promise } })
    const work = f.run(), guard = await started.promise; f[change](); pending.resolve(card()); await work
    assert.equal(f.attempts.length, 0); assert.equal(guard.isCurrent(), false)
    if (change === 'mute') assert.equal(guard.signal.aborted, true)
  }
})

test('a permitted autonomous wake can share neutral cards while ordinary ingress adds no trigger', testOptions, async t => {
  const f = await fixture(t, { proactive: true })
  await f.background(); assert.equal(f.requests.length, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.attempts.length, 0)
  await f.sweep(); assert.equal(f.attempts.length, 1); assert.equal(f.resolutions.length, 1)
  assert.equal((await f.session()).lastWakeReason.kind, 'proactiveCheck')
  const atOnly = await fixture(t, { proactive: true })
  await atOnly.runtime.setGroupReplyMode(simulationAddressKey(target), 'atOnly'); await atOnly.background()
  atOnly.clock.value += 2 * 60 * 60_000; await atOnly.runtime.sweepOnce(); await atOnly.runtime.drain()
  assert.equal(atOnly.requests.length, 0); assert.equal(atOnly.resolutions.length, 0); assert.equal(atOnly.attempts.length, 0)
})

test('binding revocation after pending persistence is rechecked before transport and releases only its cooldown', testOptions, async t => {
  let f
  f = await fixture(t, { storage(base) { return { ...base, async eval(script, options) {
    const result = await base.eval(script, options)
    if (script.includes('simulation-video-card-claim-v1') && result === 1) f.rebind()
    return result
  } } } })
  await f.run(); assert.equal(f.attempts.length, 0)
  const entries = await ledgerEntries(f); assert.equal(entries.length, 1); assert.equal(entries[0].value.state, 'failed')
})

test('malformed or forbidden card metadata cannot bypass the neutral sender', testOptions, async t => {
  let checked = 0
  const f = await fixture(t, { allowsToolInput: text => !text.includes('HOST_PRIVATE_SECRET'), async execute(event) {
    for (const invalid of [card({ cardJson: '{}' }), card({ id: 'BVbad' }), card({ pageUrl: 'http://127.0.0.1' }), card({ title: 'HOST_PRIVATE_SECRET' }), card({ title: '\u0000hidden' }), card({ durationSeconds: -1 })]) {
      await assert.rejects(async () => event._sendAgentToolVideoCard(invalid)); checked++
    }
    return { ok: true }
  } })
  await f.run(); assert.equal(checked, 6); assert.equal(f.attempts.length, 0); assert.deepEqual(await ledgerEntries(f), [])
})

test('consistency review rejection and exhausted send budget deny transport', testOptions, async t => {
  const rejected = await fixture(t, { review: true, rejectReview: true }); await rejected.run(); assert.equal(rejected.attempts.length, 0)
  let results = []
  const limited = await fixture(t, { maxSends: 1, async execute(event) {
    results.push(await event._sendAgentToolMessage({ text: '先发正常文字' }))
    try { results.push(await event._sendAgentToolVideoCard(card())) } catch (error) { results.push(error.message) }
    return { ok: true }
  } })
  await limited.run(); assert.equal(limited.texts.length, 1); assert.equal(limited.attempts.length, 0); assert.equal(typeof results[1], 'string')
})

test('pending receipt persistence failure denies transport; final receipt loss locks the turn', testOptions, async t => {
  for (const stage of ['claim', 'finish']) {
    let blocked = 0
    const f = await fixture(t, { storage(base) { return { ...base, async eval(script, options) {
      if (script.includes(`simulation-video-card-${stage}-v1`)) throw new Error('storage unavailable')
      return base.eval(script, options)
    } } }, async execute(event) {
      assert.deepEqual(await event._sendAgentToolVideoCard(card()), { state: 'unknown' })
      await assert.rejects(event._sendAgentToolMessage({ text: '账本不可用后的文字补发' }), /未知/u); blocked++
      return { status: 'unknown' }
    } })
    await f.run()
    assert.equal(blocked, 1); assert.equal(f.texts.length, 0); assert.equal(f.attempts.length, stage === 'claim' ? 0 : 1)
    if (stage === 'finish') assert.ok((await ledgerEntries(f)).every(entry => entry.value.state === 'pending'))
  }
})

test('ledger atomically isolates complete addresses and binding owners and retains failed turn receipts', testOptions, async t => {
  const redis = await createAgentRedisFixture(t, 'video-ledger'), clock = { value: AT }, ledger = createSimulationVideoCardLedger(redis.storage, () => clock.value)
  const first = await ledger.claim(bindingFor(), 'turn-1'); assert.equal(first.state, 'claimed')
  const rival = await createSimulationVideoCardLedger(redis.storage, () => clock.value).claim(bindingFor(), 'turn-2'); assert.equal(rival.state, 'cooldown')
  await first.finish({ state: 'failed', code: 'rejected' })
  assert.equal((await ledger.claim(bindingFor(), 'turn-1')).state, 'duplicate')
  const retry = await ledger.claim(bindingFor(), 'turn-2'); assert.equal(retry.state, 'claimed'); await retry.finish({ state: 'unknown' })
  for (const address of [
    { ...target, account: { ...account, platform: 'other' } }, { ...target, account: { ...account, namespace: 'other' } },
    { ...target, account: { ...account, id: 'other' } }, { ...target, kind: 'channel' }, { ...target, id: 'other' },
  ]) assert.equal((await ledger.claim(bindingFor(address), 'turn-2')).state, 'claimed')
  assert.equal((await ledger.claim(bindingFor(target, { agentId: 'other' }), 'turn-2')).state, 'claimed')
  assert.equal((await ledger.claim(bindingFor(target, { revision: 'updated-config' }), 'turn-3')).state, 'cooldown')
  clock.value += 20 * 60_000 + 1
  assert.equal((await ledger.claim(bindingFor(), 'turn-2')).state, 'unconfirmed')
  assert.equal((await ledger.claim(bindingFor(), 'turn-3')).state, 'claimed')
})

test('concurrent ledger claims admit one attempt and an unfinished attempt survives recreation', testOptions, async t => {
  const redis = await createAgentRedisFixture(t, 'video-ledger-race'), ledger = createSimulationVideoCardLedger(redis.storage, () => AT)
  const claims = await Promise.all(Array.from({ length: 12 }, (_, index) => ledger.claim(bindingFor(), `race-${index}`)))
  assert.equal(claims.filter(value => value.state === 'claimed').length, 1)
  assert.equal(claims.filter(value => value.state === 'cooldown').length, 11)
  const restarted = createSimulationVideoCardLedger(redis.storage, () => AT)
  assert.equal((await restarted.claim(bindingFor(), 'new-after-restart')).state, 'cooldown')
  assert.equal((await restarted.claim(bindingFor(), `race-${claims.findIndex(value => value.state === 'claimed')}`)).state, 'unconfirmed')
})

test('same-turn pending and unknown receipts stay unconfirmed across restart and cooldown expiry while sent and failed stay duplicate', testOptions, async t => {
  for (const state of ['pending', 'unknown', 'sent', 'failed']) {
    const redis = await createAgentRedisFixture(t, `video-ledger-replay-${state}`), clock = { value: AT }
    const ledger = createSimulationVideoCardLedger(redis.storage, () => clock.value), turn = `same-turn-${state}`
    const claim = await ledger.claim(bindingFor(), turn); assert.equal(claim.state, 'claimed')
    if (state !== 'pending') await claim.finish(state === 'sent' ? { state, messageId: 'confirmed' } : { state })
    const expected = state === 'pending' || state === 'unknown' ? 'unconfirmed' : 'duplicate'
    assert.equal((await ledger.claim(bindingFor(), turn)).state, expected)
    const restarted = createSimulationVideoCardLedger(redis.storage, () => clock.value)
    assert.equal((await restarted.claim(bindingFor(), turn)).state, expected)
    clock.value += 20 * 60_000 + 1
    assert.equal((await restarted.claim(bindingFor(), turn)).state, expected)
    const records = await ledgerEntries(redis)
    assert.equal(records.find(entry => entry.key.includes(':attempt:')).value.state, state)
  }
})

test('malformed existing attempt and cooldown records fail closed atomically without overwriting evidence', testOptions, async t => {
  const redis = await createAgentRedisFixture(t, 'video-ledger-malformed'), ledger = createSimulationVideoCardLedger(redis.storage, () => AT)
  await ledger.claim(bindingFor(), 'malformed-turn')
  const records = await ledgerEntries(redis), attempt = records.find(entry => entry.key.includes(':attempt:')), cooldown = records.find(entry => entry.key.endsWith(':cooldown'))
  const attemptKey = attempt.key.slice(redis.prefix.length), cooldownKey = cooldown.key.slice(redis.prefix.length)
  const corruptions = value => [
    '{', 'null', '[]', '{}', JSON.stringify({ ...value, version: 2 }), JSON.stringify({ ...value, owner: '' }),
    JSON.stringify({ ...value, state: 'unrecognized' }), JSON.stringify({ ...value, extra: true }),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123'].map(time => JSON.stringify({ ...value, ...(value.at === undefined ? { untilAt: time } : { at: time }) })),
  ]
  for (const raw of corruptions(attempt.value)) {
    await redis.storage.set(attemptKey, raw)
    await assert.rejects(ledger.claim(bindingFor(), 'malformed-turn'), /账本不可用/u)
    assert.equal(await redis.storage.get(attemptKey), raw)
  }
  await redis.storage.del(attemptKey)
  for (const raw of [...corruptions(cooldown.value), JSON.stringify({ ...cooldown.value, state: 'failed' })]) {
    await redis.storage.set(cooldownKey, raw)
    await assert.rejects(ledger.claim(bindingFor(), 'new-turn'), /账本不可用/u)
    assert.equal(await redis.storage.get(cooldownKey), raw)
    assert.equal(await redis.storage.get(attemptKey), null)
  }
})

test('a storage without atomic Lua support fails closed for neutral video cards', testOptions, async t => {
  const f = await fixture(t, { storage(base) { return { get: base.get, set: base.set, del: base.del } } })
  await f.run(); assert.equal(f.attempts.length, 0)
})
