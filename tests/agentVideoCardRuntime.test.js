import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { createAgentBindingDirectory, agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'

// Build/package verification uses dist by default. Source mode is an explicit
// development-only check and never writes shared build output.
const root = fileURLToPath(new URL('../', import.meta.url)), urls = new Map()
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
const ts = sourceTest ? (await import('typescript')).default : undefined
const moduleUrl = relative => sourceTest ? sourceUrl(relative) : pathToFileURL(path.join(root, relative.replace(/^src\//u, 'dist/backend/').replace(/\.ts$/u, '.js'))).href
const fresh = new Set(['agentRuntime', 'agentTools', 'agentVideoCard', 'simulationRuntime', 'simTools', 'simulationVideoCardLedger'])
function sourceUrl(relative) {
  if (urls.has(relative)) return urls.get(relative)
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu, (_all, from, quote, specifier) => {
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier))
    const url = fresh.has(path.basename(dependency, '.js')) ? sourceUrl(dependency.replace(/\.js$/u, '.ts')) : pathToFileURL(path.join(root, dependency.replace(/^src\//u, 'dist/backend/'))).href
    return `${from}${quote}${url}${quote}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(`${code}\n//# sourceURL=${relative.replace(/\.ts$/u, '.test-source.js')}`).toString('base64')}`
  urls.set(relative, url); return url
}
const { createAgentRuntime } = await import(moduleUrl('src/core/agentRuntime.ts'))
const { createAgentTools } = await import(moduleUrl('src/modules/tools/infrastructure/agentTools.ts'))
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
const card = { provider: 'bilibili', id: 'BV1xx411c7mD', title: '定向集成合成视频', author: '合成作者', durationSeconds: 123, pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const call = (name, input = {}, id = name) => ({ choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '视频卡片定向集成验证结束' })
const attempt = async operation => { try { return { ok: true, value: await operation() } } catch (error) { return { ok: false, reason: String(error) } } }
async function waitFor(check, label, timeout = 7000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await check()) return; await delay(10) }; assert.fail(typeof label === 'function' ? label() : label) }

function wrapped(execute, overrides = {}) {
  const account = { platform: 'fixture', namespace: 'wrapped-video', id: 'robot' }, target = { account, kind: 'group', id: 'room' }
  const controller = new AbortController(), calls = [], scope = { binding: { source: 'configured', id: 'binding', revision: 'one', personaId: 'default', agentId: 'role', connectionId: 'connection', target },
    actor: { kind: 'user', user: { ...account, id: 'human' } }, isCurrent: () => true, async ensureCurrent() {},
    async sendVideoCard(owned, current, signal, ensureCurrent) { calls.push({ owned, current, signal, ensureCurrent }); return { state: 'sent', messageId: 'video-confirmed' } },
    ...overrides,
  }
  const definition = { name: 'videoRuntimeProbe', description: '验证视频卡发送端口', parameters, execute }
  const registry = { builtIn: [definition] }, tools = createAgentTools(registry, { signal: controller.signal, context: () => scope })
  return { scope, calls, controller, registry, run: () => tools.getExtraTools([definition.name])[0].execute({}, {}) }
}

test('AgentTools carries the exact source finalizer and combined cancellation into its outbound card port', async () => {
  const entered = deferred(), release = deferred(), sourceController = new AbortController(); let sourceCurrent = true, checked = 0, first
  const f = wrapped(async (_input, context) => {
    const mutable = { ...card }, pending = context.sendVideoCard(mutable, { signal: sourceController.signal, isCurrent: () => sourceCurrent,
      async ensureCurrent() { checked++; if (!sourceCurrent) throw Error('selected source unavailable') },
    })
    mutable.title = 'after-call mutation'
    first = await attempt(() => pending)
    return { status: 'failed', content: '来源撤销测试结束' }
  }, { async sendVideoCard(owned, current, signal, ensureCurrent) {
    f.calls.push({ owned, current, signal, ensureCurrent }); entered.resolve(); await release.promise
    assert.deepEqual(owned, card); assert.ok(Object.isFrozen(owned)); assert.ok(signal instanceof AbortSignal); assert.equal(typeof ensureCurrent, 'function')
    await ensureCurrent(); assert.equal(current(), true); return { state: 'sent', messageId: 'must-not-publish' }
  } })
  const pending = f.run(); await entered.promise; assert.ok(checked >= 1); sourceCurrent = false; sourceController.abort(); release.resolve(); await pending
  assert.equal(first.ok, false); assert.match(first.reason, /来源|失效|unavailable/u); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[0].current(), false)
})

test('AgentTools unknown card receipt blocks a second card and ordinary text before either port runs again', async () => {
  let first, duplicate, text, texts = 0
  const f = wrapped(async (_input, context) => {
    first = await context.sendVideoCard(card)
    duplicate = await attempt(() => context.sendVideoCard(card)); text = await attempt(() => context.sendMessage({ text: 'unknown fallback' }))
    return { status: 'succeeded', content: '不能把未知回执写成成功' }
  }, { async sendVideoCard() { f.calls.push('native'); return { state: 'unknown' } }, async sendMessage() { texts++; return { state: 'sent', messageId: 'must-not-send' } } })
  const result = await f.run(); assert.deepEqual(first, { state: 'unknown' }); assert.equal(result.status, 'unknown')
  for (const blocked of [duplicate, text]) { assert.equal(blocked.ok, false); assert.match(blocked.reason, /未知/u) }
  assert.equal(f.calls.length, 1); assert.equal(texts, 0)
})

for (const mode of ['ephemeral', 'autonomous', 'private']) test(`AgentTools does not expose outbound cards to ${mode} scope`, async () => {
  let exposed
  const f = wrapped(async (_input, context) => { exposed = Object.hasOwn(context, 'sendVideoCard'); return { status: 'succeeded', content: '权限检查完成' } })
  if (mode === 'ephemeral') f.registry.builtIn = [{ ...f.registry.builtIn[0], dataPolicy: 'ephemeral' }]
  else if (mode === 'autonomous') f.scope.actor = { kind: 'autonomous' }
  else f.scope.binding = { ...f.scope.binding, target: { ...f.scope.binding.target, kind: 'private' } }
  assert.equal((await f.run()).status, 'success'); assert.equal(exposed, false); assert.equal(f.calls.length, 0)
})

const redisTest = { skip: !redisAvailable, timeout: 20000 }; let sequence = 0
// Port contract: nested checks reuse one entry version, while the outer exit
// rejects an otherwise true predicate if its source changed synchronously.
function executionObservation() {
  let depth = 0, version = 0, entry = 0, armed = false, revokedInside = false
  return {
    get depth() { return depth }, get revokedInside() { return revokedInside },
    arm() { armed = true },
    isCurrent() {
      const accepted = (depth ? entry : version) === 0
      if (armed && depth) { armed = false; version++; revokedInside = accepted }
      return accepted
    },
    observe(check) {
      const outer = depth === 0
      if (outer) entry = version
      depth++
      let accepted
      try { accepted = check() === true } finally { depth-- }
      return accepted && (!outer || version === entry)
    },
  }
}
async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'video-card-core-integration'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `video-card-core-${++sequence}`, id: 'robot' }, target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'human' }, now = Date.now()
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }], connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }], bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'video-integration-one'), accept, terminal = false, configCurrent = true, toolDone = false
  const binding = directory.resolve(target), key = simulationAddressKey(target), state = createDefaultSimSession(now)
  state.bootstrapSent = true; state.botId = account.id; state.bindingToken = agentBindingToken(binding); state.personaId = agentPersonaScopeId(binding.agentId); state.nextProactiveCheckAt = now + 86_400_000
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const source = { version: 1, conversation: target, sender, messageId: 'video-trigger', occurredAt: now, text: '请按明确关键词查询并分享合成视频', parts: [], mentions: [account], directedToAccount: true }
  const selectedSource = { ...source, messageId: 'selected-video-source', text: '之前搜索到的合成视频选择来源', occurredAt: now - 1000, mentions: [], directedToAccount: false }
  const originals = new Map([[source.messageId, source], [selectedSource.messageId, selectedSource]]), attempts = [], cards = [], texts = [], requests = [], contexts = [], resolutions = [], diagnostics = [], effects = []
  const effect = port => { if (settings.observer) effects.push({ port, depth: settings.observer.depth }) }
  const registry = { builtIn: settings.execute ? [{ name: 'videoRuntimeProbe', description: '验证Core视频发送路径', parameters,
    async execute(_input, context) { contexts.push(context); try { return await settings.execute(context, f) } finally { toolDone = true } },
  }] : [] }
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { maxToolRounds: 8, maxSendsPerTurn: 3, minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  let f
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now, toolRegistry: registry,
    ...(settings.observer ? { observeExecutionCurrent: check => settings.observer.observe(check),
      isExecutionCurrent: () => redis.isCurrent() && settings.observer.isCurrent() } : {}),
    adapters: [{ id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => Boolean(accept), async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, id, guard) { return guard?.isCurrent?.() !== false && originals.has(id) ? structuredClone(originals.get(id)) : undefined },
      actions: {
        async send(action, guard) { effect('send'); if (settings.sendText) return settings.sendText(action, guard, f); assert.equal(guard.isCurrent(), true); texts.push(structuredClone(action)); return { state: 'sent', messageId: `text-${texts.length}` } },
        async sendVideoCard(action, guard) {
          effect('sendVideoCard')
          attempts.push({ action: structuredClone(action), guard }); assert.ok(guard.signal instanceof AbortSignal)
          if (settings.sendCard) return settings.sendCard(action, guard, f)
          if (!guard.isCurrent() || guard.signal.aborted) return { state: 'failed', code: 'stale' }
          cards.push(structuredClone(action)); return { state: 'sent', messageId: `video-${cards.length}` }
        },
      },
    }],
    ...(settings.provider ? { videoSearchProvider: { async resolve(input, context) { effect('provider.resolve'); resolutions.push({ input, context }); return settings.provider(input, context, f) }, async search() { assert.fail('Core resolver must not bypass the declared resolve operation') } } } : {}),
    isVideoSearchCurrent: () => configCurrent,
    logger: { info() {}, warn(...args) { diagnostics.push(args.join(' ')) }, error(...args) { diagnostics.push(args.join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(address) { const selected = directory.resolve(address); return selected && { binding: selected, persona: { name: '视频验证角色' }, systemContent: '' } },
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      effect('model')
      await ensureCurrent?.(); requests.push(structuredClone(request))
      if (requests.length === 1) return settings.execute ? call('videoRuntimeProbe') : call('simShareVideoCard', { query: '合成视频' })
      if (settings.model) { const result = await settings.model(requests.length, request, f); if (result) return result }
      terminal = true; return finish()
    },
  })
  t.after(async () => { settings.release?.(); await host.stop() })
  const session = async () => JSON.parse(await storage.get(simulationSessionKey(key)) || 'null')
  const settled = async () => { const current = await session(); return current && !current.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(key)) && !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`) }
  f = { ...redis, host, account, target, sender, binding, source, selectedSource, originals, attempts, cards, texts, requests, contexts, resolutions, diagnostics, effects, session, settled,
    invalidateConfig() { configCurrent = false }, rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'video-integration-rebound') },
    async run({ cancelled = false } = {}) { await accept({ kind: 'message', message: structuredClone(source) }); await waitFor(async () => (terminal || cancelled && requests.length > 0) && await settled(), () => `Core video turn did not drain: ${JSON.stringify({ diagnostics, requests: requests.map(row => row.messages.filter(item => item.role === 'tool')) })}`); await host.runtime.drain() },
    async ledger() { return Promise.all((await reader.keys(prefix + 'shiloh:sim:video-card:v1:*')).map(async key => JSON.parse(await reader.get(key)))) },
    get toolDone() { return toolDone },
  }
  await host.start()
  if (settings.seedSelection) {
    await accept({ kind: 'message', message: structuredClone(selectedSource) })
    await waitFor(async () => (await session())?.recent?.some(row => row.messageId === selectedSource.messageId) && await settled(), 'selection source durably admitted before the tool turn')
    assert.equal(requests.length, 0)
  }
  return f
}

test('Core card observation ends before provider resolution and native delivery', redisTest, async t => {
  const observer = executionObservation(), f = await fixture(t, { observer,
    async provider(_input, context) { assert.equal(context.isCurrent(), true); await context.ensureCurrent(); return card },
  })
  await f.run()
  assert.equal(f.resolutions.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.cards.length, 1); assert.equal(f.texts.length, 0)
  for (const port of ['provider.resolve', 'sendVideoCard', 'model']) assert.ok(f.effects.some(effect => effect.port === port))
  assert.ok(f.effects.every(effect => effect.depth === 0), 'provider requests, models and native delivery must leave the configuration observation first')
  assert.ok((await f.ledger()).some(row => row.state === 'sent'))
})

test('Core card observation rejects a mid-check source version change before a resolved card can dispatch', redisTest, async t => {
  const observer = executionObservation(); let accepted
  const f = await fixture(t, { observer, async provider(_input, context) {
    observer.arm(); accepted = context.isCurrent(); return card
  } })
  await f.run({ cancelled: true })
  assert.equal(observer.revokedInside, true, 'the source changed after an inner predicate accepted its entry version')
  assert.equal(accepted, false, 'the outer source fence rejects the nested true result')
  assert.equal(observer.depth, 0); assert.equal(observer.isCurrent(), false)
  assert.equal(f.resolutions.length, 1); assert.equal(f.attempts.length, 0); assert.equal(f.cards.length, 0); assert.equal(f.texts.length, 0)
  assert.deepEqual(await f.ledger(), [])
})

test('Core carries AgentTools source finalizer through a prior queued send before any card can reach the adapter', redisTest, async t => {
  const entered = deferred(), release = deferred(), initiallyAuthorized = deferred(); let outcome, finalChecks = 0
  const f = await fixture(t, { seedSelection: true, release: release.resolve, async sendText(action, guard, f) { entered.resolve(); await release.promise; assert.equal(guard.isCurrent(), true); f.texts.push(action); return { state: 'sent', messageId: 'prior-text' } },
    async execute(context, f) {
      const first = context.sendMessage({ text: '排队在前的正常文字' }); await entered.promise
      const sourceGuard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() { finalChecks++; if (!await context.isSourceAvailable({ messageId: f.selectedSource.messageId, author: f.sender })) throw Error('selected source unavailable'); initiallyAuthorized.resolve() } }
      const pending = attempt(() => context.sendVideoCard(card, sourceGuard)); await initiallyAuthorized.promise; await delay(0)
      f.originals.delete(f.selectedSource.messageId); release.resolve(); await first; outcome = await pending
      return { status: 'failed', content: '来源已撤销，不发送视频卡片' }
    },
  })
  await f.run(); assert.equal(outcome.ok, false); assert.ok(finalChecks >= 2, 'source finalizer runs again after queued predecessor settles')
  assert.equal(f.attempts.length, 0); assert.equal(f.texts.length, 1); assert.deepEqual(await f.ledger(), [])
})

test('Core preserves the source AbortSignal when a card waits behind another send', redisTest, async t => {
  const entered = deferred(), release = deferred(), sourceController = new AbortController(); let outcome, checks = 0
  const f = await fixture(t, { release: release.resolve, async sendText(_action, _guard, f) { entered.resolve(); await release.promise; f.texts.push('prior-text'); return { state: 'sent', messageId: 'prior-text' } },
    async execute(context) {
      const first = context.sendMessage({ text: '前置队列消息' }); await entered.promise
      const pending = attempt(() => context.sendVideoCard(card, { signal: sourceController.signal, isCurrent: () => true, async ensureCurrent() { checks++ } }))
      await waitFor(() => checks >= 1, 'card admitted before source cancellation'); sourceController.abort(); release.resolve(); await first; outcome = await pending
      return { status: 'failed', content: '来源取消后未发卡片' }
    },
  })
  await f.run(); assert.equal(outcome.ok, false); assert.equal(f.attempts.length, 0); assert.equal(f.texts.length, 1); assert.deepEqual(await f.ledger(), [])
})

test('Core sends the immutable bound action with a combined source signal and revokes its adapter guard after tool completion', redisTest, async t => {
  let result, contextAfter, sourceSignal
  const f = await fixture(t, { async execute(context) {
    contextAfter = context; const controller = new AbortController(); sourceSignal = controller.signal
    const mutable = { ...card }, pending = context.sendVideoCard(mutable, { signal: sourceSignal, isCurrent: () => true, async ensureCurrent() {} }); mutable.title = 'mutated after request'
    result = await pending; return { status: 'succeeded', content: '视频卡片已确认发送' }
  } })
  await f.run(); assert.deepEqual(result, { state: 'sent', messageId: 'video-1' }); assert.equal(f.attempts.length, 1)
  assert.deepEqual(f.cards[0], { version: 1, kind: 'video-card.send', target: f.target, binding: f.binding, card })
  const scope = f.attempts[0].guard; assert.notEqual(scope.signal, sourceSignal); assert.equal(scope.signal.aborted, true); assert.equal(scope.isCurrent(), false)
  assert.equal(contextAfter.signal.aborted, true); await assert.rejects(contextAfter.sendVideoCard(card), /失效/u)
  assert.deepEqual((await f.session()).confirmedMessageIds, ['video-1']); assert.ok((await f.ledger()).some(row => row.state === 'sent'))
})

test('Core unknown card receipt blocks tool retry and fallback and persists one unknown attempt', redisTest, async t => {
  let first, retry, fallback
  const f = await fixture(t, { async sendCard() { return { state: 'unknown' } }, async execute(context) {
    first = await context.sendVideoCard(card); retry = await attempt(() => context.sendVideoCard(card)); fallback = await attempt(() => context.sendMessage({ text: '不允许的未知补发' }))
    return { status: 'succeeded', content: '工具不能覆盖未知回执' }
  } })
  await f.run(); assert.deepEqual(first, { state: 'unknown' }); assert.equal(retry.ok, false); assert.equal(fallback.ok, false)
  assert.equal(f.attempts.length, 1); assert.equal(f.cards.length, 0); assert.equal(f.texts.length, 0)
  assert.ok((await f.ledger()).some(row => row.state === 'unknown')); assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
  const results = f.requests.flatMap(row => row.messages.filter(item => item.role === 'tool' && item.tool_call_id === 'videoRuntimeProbe'))
  assert.ok(results.length); assert.ok(results.every(row => /未知|unknown/u.test(String(row.content))))
})

for (const change of ['config', 'binding']) test(`Core provider rejects a late resolved card after ${change} authority changes`, redisTest, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { release: () => release.resolve(card), async provider(_input, context) { entered.resolve(context); return release.promise } })
  const work = f.run({ cancelled: change === 'binding' }), context = await entered.promise
  assert.ok(context.signal instanceof AbortSignal); assert.equal(context.isCurrent(), true); assert.equal(typeof context.ensureCurrent, 'function')
  if (change === 'config') f.invalidateConfig(); else f.rebind()
  assert.equal(context.isCurrent(), false); await assert.rejects(context.ensureCurrent()); release.resolve(card); await work
  assert.equal(f.resolutions.length, 1); assert.equal(f.attempts.length, 0); assert.equal(f.cards.length, 0); assert.deepEqual(await f.ledger(), [])
})

test('Core does not invoke a configured provider once its host revision is already invalid', redisTest, async t => {
  let resolves = 0
  const f = await fixture(t, { async provider() { resolves++; return card } }); f.invalidateConfig(); await f.run()
  assert.equal(resolves, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.attempts.length, 0)
})
