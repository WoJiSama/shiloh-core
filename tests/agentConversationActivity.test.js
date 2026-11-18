import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { commitmentRedis } from './helpers/commitmentRedis.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'

// Exercise these sources without rebuilding shared dist while sibling work is in progress.
const root = fileURLToPath(new URL('../', import.meta.url)), urls = new Map()
function sourceUrl(relative) {
  if (urls.has(relative)) return urls.get(relative)
  const source = readFileSync(path.join(root, relative), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu, (_all, from, quote, specifier) => {
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier))
    const url = dependency.endsWith('/agentConversationActivity.js')
      ? sourceUrl(dependency.replace(/\.js$/u, '.ts'))
      : pathToFileURL(path.join(root, dependency.replace(/^src\//u, 'dist/backend/'))).href
    return `${from}${quote}${url}${quote}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  urls.set(relative, url); return url
}
const { createAgentConversationActivity } = await import(sourceUrl('src/modules/runtime/infrastructure/agentConversationActivity.ts'))
const { createSimulationRuntime } = await import(sourceUrl('src/modules/simulation/infrastructure/simulationRuntime.ts'))
const { createCommitmentRuntime } = await import(sourceUrl('src/modules/commitments/infrastructure/commitmentTool.ts'))
const target = { account: { platform: 'qq', namespace: 'global', id: '200' }, kind: 'group', id: '20' }
const quietLogger = { info() {}, warn() {}, error() {} }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) { if (await check()) return; await delay(10) }
  assert.fail('activity fixture did not settle')
}
const finish = (choice = 'silent') => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
  id: 'finish', type: 'function', function: { name: 'simFinishTurn', arguments: JSON.stringify({ choice, reason: '测试明确收尾', ...(choice === 'chat' ? { messages: ['迟到正文不得发送'] } : {}) }) },
}] } }], usage: { total_tokens: 1 } })

test('conversation activity isolates every address dimension and revokes old captures through reopen', () => {
  const activity = createAgentConversationActivity()
  const alternatives = [
    { ...target, account: { ...target.account, platform: 'feishu' } },
    { ...target, account: { ...target.account, namespace: 'other' } },
    { ...target, account: { ...target.account, id: '201' } },
    { ...target, kind: 'private' }, { ...target, id: '21' },
  ]
  const old = activity.capture(target), others = alternatives.map(other => activity.capture(other))
  activity.set(target, true); assert.equal(old.isCurrent(), true)
  activity.set(target, false)
  assert.equal(old.signal.aborted, true); assert.equal(old.isCurrent(), false)
  assert.ok(others.every(permit => permit.isCurrent()))
  assert.equal(activity.capture(target).signal.aborted, true)
  activity.set(target, true); assert.equal(old.isCurrent(), false)
  const fresh = activity.capture(target); assert.equal(fresh.isCurrent(), true)
  fresh.release(); fresh.release(); assert.equal(fresh.isCurrent(), false); assert.equal(fresh.signal.aborted, true)
  activity.close(); assert.ok(others.every(permit => permit.signal.aborted))
})

test('blockAll denies existing and unknown conversations until explicitly opened, and close is final', () => {
  const activity = createAgentConversationActivity(), old = activity.capture(target)
  activity.blockAll(); assert.equal(old.signal.aborted, true)
  assert.equal(activity.allows(target), false); assert.equal(activity.allows({ ...target, id: 'new' }), false)
  activity.set(target, true); const fresh = activity.capture(target); assert.equal(fresh.isCurrent(), true)
  activity.blockAll(); assert.equal(fresh.signal.aborted, true)
  activity.close(); activity.set(target, true)
  assert.equal(activity.allows(target), false); assert.equal(activity.capture(target).isCurrent(), false)
})

function simulationFixture(model) {
  const data = new Map(), clock = { value: Date.parse('2026-11-11T12:00:00+08:00') }, activity = createAgentConversationActivity()
  const state = createDefaultSimSession(clock.value); state.bootstrapSent = true; state.botId = target.account.id
  state.wakeConfig.triggers.probability = 0; state.nextProactiveCheckAt = 0
  data.set('shiloh:sim:g:20', JSON.stringify(state))
  const calls = [], sends = []
  const runtime = createSimulationRuntime({
    redis: { async get(key) { return data.get(key) ?? null }, async set(key, value) { data.set(key, value); return 'OK' }, async del(key) { return Number(data.delete(key)) } },
    now: () => clock.value, random: () => 0.99, logger: quietLogger,
    allowsConversationAI: activity.allows,
    getSelf: () => ({ id: target.account.id, name: '测试角色' }), getPersona: () => ({ personaId: 'default', persona: { name: '测试角色' }, systemContent: '' }),
    getSection: () => ({ enabled: true, allGroups: false, groups: ['20'],
      wake: { probability: 0, batchWindowMs: 1000, proactiveProbability: 1, proactiveIdleMs: 60_000 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false },
      turn: { minSendGapMs: 0, maxTurnsPerDay: 100 },
    }), getExecutionConfig: () => ({}),
    async YTapi(request, _config, signal, isCurrent) { calls.push({ request, signal, isCurrent }); return model ? model(request, signal, isCurrent) : finish() },
    async sendGroupMessage(_group, parts, _bot, guard) { assert.notEqual(guard?.isCurrent?.(), false); sends.push(parts); return { ok: true, messageId: 'sent' } },
  })
  let messageId = 0
  return { runtime, activity, clock, data, calls, sends,
    ingest(at = true) { return runtime.ingest({ version: 1, conversation: target, sender: { ...target.account, id: '10' }, messageId: `m${++messageId}`,
      occurredAt: clock.value, text: '真人群消息', parts: [{ kind: 'text', text: '真人群消息' }], mentions: at ? [{ ...target.account }] : [], directedToAccount: at }) },
    mute() { activity.set(target, false); runtime.invalidateConversation(target) },
  }
}

test('legacy QQ simulation synchronously aborts an in-flight model and rejects its late tools after reopen', async t => {
  const answer = deferred(), h = simulationFixture(() => answer.promise)
  t.after(() => h.runtime.stop()); await h.ingest(); await waitFor(() => h.calls.length === 1)
  h.mute(); assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls[0].isCurrent(), false)
  h.activity.set(target, true); assert.equal(h.calls[0].isCurrent(), false)
  answer.resolve(finish('chat'))
  await waitFor(async () => !(await h.runtime.describeGroup('20')).running)
  assert.equal(h.calls.length, 1); assert.equal(h.sends.length, 0)
})

test('legacy QQ pending wake and proactive sweep stay silent without changing the simulation setting', async t => {
  const h = simulationFixture(); t.after(() => h.runtime.stop())
  await h.ingest(); h.mute(); await delay(1100)
  h.clock.value += 2 * 60 * 60_000
  await h.runtime.sweepOnce(); assert.equal(h.calls.length, 0); assert.equal(h.sends.length, 0)
  h.activity.set(target, true)
  assert.equal(await h.runtime.isConversationActive(target), true)
})

function commitmentFixture() {
  const data = new Map(), clock = { value: Date.parse('2026-11-11T12:00:00+08:00') }, activity = createAgentConversationActivity(), sends = []
  const ports = { redis: commitmentRedis(data, () => clock.value), logger: quietLogger, now: () => clock.value,
    getBot: () => ({ uin: '200', async sendApi(...args) { sends.push(args); return { retcode: 0, data: { message_id: 'sent' } } } }),
    isSimulationGroup: () => true, loadConfig: () => ({}),
    allowsExecution: activity.allows, captureExecution: activity.capture,
    async wakeSim(_group, _card, options) { assert.equal(await options.beforeExecution(), true); return { status: 'succeeded', sent: 1 } },
  }
  const runtime = createCommitmentRuntime(ports)
  return { ...runtime, ports, data, clock, activity, sends,
    async create(deliver = 'static') {
      const tool = new runtime.CommitmentTool()
      assert.match(await tool.execute({ action: 'create', intent: '提醒喝水', schedule_kind: 'once', schedule_time: '2026-11-11T12:10:00+08:00', deliver,
        ...(deliver === 'static' ? { static_message: '喝水' } : {}) }, { group_id: '20', user_id: '10', self_id: '200', sender: { nickname: 'tester' } }), /已记下/u)
      const [entry] = await runtime.store.listActiveCommitments(); clock.value += 11 * 60_000; return entry
    },
  }
}

test('muted static commitments retain their schedule without retries and execute once after reopen', async () => {
  const h = commitmentFixture(), task = await h.create(); h.activity.set(target, false)
  await h.commitmentTick(); const waiting = await h.store.getCommitment(task.id)
  assert.equal(waiting.status, 'active'); assert.equal(waiting.run_id, undefined); assert.equal(waiting.retry_count, 0)
  assert.equal(waiting.next_run_at, task.next_run_at); assert.equal(h.sends.length, 0)
  h.activity.set(target, true); await h.commitmentTick()
  assert.equal((await h.store.getCommitment(task.id)).status, 'completed'); assert.equal(h.sends.length, 1)
})

test('an unstarted agent commitment is aborted and deferred without spending retries, including a late completion', async () => {
  const h = commitmentFixture(), task = await h.create('agent'), entered = deferred(), late = deferred()
  let captured, calls = 0
  h.ports.wakeSim = async (_group, _card, options) => { calls++; captured = options; entered.resolve(); return late.promise }
  const tick = h.commitmentTick(); await entered.promise; h.activity.set(target, false)
  assert.equal(captured.signal.aborted, true); await tick
  const waiting = await h.store.getCommitment(task.id)
  assert.equal(waiting.status, 'active'); assert.equal(waiting.run_id, undefined); assert.equal(waiting.retry_count, 0)
  late.resolve({ status: 'succeeded', sent: 1 }); await delay(0)
  assert.equal((await h.store.getCommitment(task.id)).status, 'active')
  h.activity.set(target, true)
  h.ports.wakeSim = async (_group, _card, options) => { calls++; assert.equal(await options.beforeExecution(), true); return { status: 'succeeded', sent: 1 } }
  await h.commitmentTick(); assert.equal(calls, 2); assert.equal((await h.store.getCommitment(task.id)).status, 'completed')
})

test('static delivery interrupted after transport starts becomes unknown and never replays', async () => {
  const h = commitmentFixture(), task = await h.create(), entered = deferred(), late = deferred()
  let sends = 0
  h.ports.getBot = () => ({ uin: '200', async sendApi() { sends++; entered.resolve(); return late.promise } })
  const tick = h.commitmentTick(); await entered.promise; h.activity.set(target, false); await tick
  assert.equal((await h.store.getCommitment(task.id)).status, 'unknown')
  late.resolve({ retcode: 0, data: { message_id: 'late' } }); h.activity.set(target, true); h.clock.value += 200_000
  await h.commitmentTick(); assert.equal(sends, 1); assert.equal((await h.store.getCommitment(task.id)).status, 'unknown')
})

test('agent work aborted after beforeExecution stays unknown without replay', async () => {
  const h = commitmentFixture(), task = await h.create('agent'), entered = deferred(), late = deferred()
  let calls = 0
  h.ports.wakeSim = async (_group, _card, options) => { calls++; assert.equal(await options.beforeExecution(), true); entered.resolve(); return late.promise }
  const tick = h.commitmentTick(); await entered.promise; h.activity.set(target, false); await tick
  assert.equal((await h.store.getCommitment(task.id)).status, 'unknown')
  late.resolve({ status: 'succeeded', sent: 1 }); h.activity.set(target, true); h.clock.value += 200_000
  await h.commitmentTick(); assert.equal(calls, 1)
})
