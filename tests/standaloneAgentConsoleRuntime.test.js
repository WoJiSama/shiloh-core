import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis } from './helpers/agentQzoneRedis.mjs'

const [{ createStandaloneAgentConsoleRuntime }, { agentConversationKey, agentBindingToken }, { simulationAddressKey }, { AgentConsoleError }] = await Promise.all([
  load('bootstrap/standaloneAgentConsoleRuntime.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/simulation/infrastructure/simulationAddress.js'), load('contracts/agentConsole.js'),
])
const binding = {
  source: 'configured', id: 'binding-1', revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: 'qq-1',
  target: { kind: 'group', id: '310901', account: { platform: 'qq', namespace: 'global', id: '23000101' } },
}
function fixture() {
  let live = structuredClone(binding), active = true
  const calls = [], authCalls = []
  const controller = new AbortController(), principal = { id: 'operator', username: 'admin', via: 'session' }
  const auth = {
    isCurrent: () => active && !controller.signal.aborted,
    async authorize(actor, operation, selected, guard) {
      authCalls.push({ actor, operation, selected, guard }); guard.ensureCurrent(); return 'allowed'
    },
  }
  const runtime = {
    runAdministration(guard, operation) { calls.push({ kind: 'lease', guard }); return Promise.resolve().then(operation) },
    async overview(keys) { calls.push({ method: 'overview', keys }); return { enabled: true, disabled: [], explicitEnabled: [], budgetGroupsCny: {}, groups: [] } },
    async describeGroup(key) { calls.push({ method: 'describeGroup', key }); return { groupId: key, active: true } },
    async enableGroup(key) { calls.push({ method: 'enableGroup', key }); return 'enabled' },
    async disableGroup(key) { calls.push({ method: 'disableGroup', key }); return 'disabled' },
    async resetGroup(key) { calls.push({ method: 'resetGroup', key }); return 'reset' },
    async setInitialPrompt(key, text) { calls.push({ method: 'setInitialPrompt', key, text }); return text },
    async setGroupBudget(key, value) { calls.push({ method: 'setGroupBudget', key, value }); return 'budget' },
    async setGroupTurnsCap(key, value) { calls.push({ method: 'setGroupTurnsCap', key, value }); return 'turns' },
    async setGroupReplyMode(key, value) { calls.push({ method: 'setGroupReplyMode', key, value }); return 'mode' },
    async controlCharacter(key, operation, id) { calls.push({ method: 'controlCharacter', key, operation, id }); return 'character' },
    async controlActivity(key, operation, id, payload) { calls.push({ method: 'controlActivity', key, operation, id, payload }); return 'activity' },
    async setDefaultBudget(value) { calls.push({ method: 'setDefaultBudget', value }); return 'default' },
    async lifeOverview(keys) { calls.push({ method: 'lifeOverview', keys }); return { rhythm: {}, threads: [], now: {} } },
    async setLifeRhythm(from, to, keys) { calls.push({ method: 'setLifeRhythm', from, to, keys }); return 'rhythm' },
    async getHealthAlerts() { calls.push({ method: 'getHealthAlerts' }); return { alerts: [], checkedAt: 1 } },
  }
  const adapter = createStandaloneAgentConsoleRuntime({ runtime, bindings: { list: () => [live], resolve: target => target.id === live.target.id ? live : undefined }, auth })
  const context = (selected = live) => ({ principal, binding: structuredClone(selected), signal: controller.signal, isCurrent: () => active && !controller.signal.aborted, ensureCurrent() { if (!active || controller.signal.aborted) throw new AgentConsoleError('conflict') } })
  return { adapter, runtime, calls, authCalls, context, revoke() { active = false }, controller, live: () => live, replace(next) { live = next } }
}

test('adapter converts complete configured bindings to v2 simulation keys and serializes all management through administration', async () => {
  const f = fixture(), key = simulationAddressKey(binding.target), scope = agentConversationKey(binding)
  assert.equal(await f.adapter.enableGroup(scope, f.context()), 'enabled')
  assert.equal(f.calls.at(-1).method, 'enableGroup'); assert.equal(f.calls.at(-1).key, key)
  assert.equal(f.calls.filter(row => row.kind === 'lease').length, 1)
  const view = await f.adapter.overview(f.context())
  assert.equal(view.groups.length, 1); assert.equal(view.groups[0].scopeKey, scope); assert.equal(view.groups[0].bindingToken, agentBindingToken(binding))
  assert.deepEqual(f.calls.find(row => row.method === 'overview').keys, [])
  assert.equal(f.calls.filter(row => row.method === 'describeGroup').length, 1)
  assert.ok(f.authCalls.some(row => row.operation === 'simulation.group-write'))
})

test('adapter rejects bare or stale selectors before dispatch and rechecks bindings for aggregate reads', async () => {
  const f = fixture(), scope = agentConversationKey(binding)
  await assert.rejects(f.adapter.disableGroup(binding.target.id, f.context()), { code: 'conflict' })
  f.revoke(); await assert.rejects(f.adapter.disableGroup(scope, f.context()), { code: 'conflict' })
  const g = fixture(), next = { ...binding, revision: 'v2' }; g.replace(next)
  await assert.rejects(g.adapter.overview(g.context(binding)), { code: 'conflict' })
  assert.equal(g.calls.some(row => row.method === 'overview' || row.method === 'describeGroup'), false)
})

test('all scoped operations preserve the complete binding while the adapter owns authorization', async () => {
  const f = fixture(), scope = agentConversationKey(binding)
  await f.adapter.setInitialPrompt(scope, 'hello', f.context())
  await f.adapter.controlCharacter(scope, 'delete-memory', 'm-1', f.context())
  await f.adapter.controlActivity(scope, 'work-restore', 'w-1', { revision: 2 }, f.context())
  assert.deepEqual(f.calls.filter(row => row.method === 'setInitialPrompt')[0], { method: 'setInitialPrompt', key: simulationAddressKey(binding.target), text: 'hello' })
  assert.equal(f.calls.at(-1).key, simulationAddressKey(binding.target)); assert.equal(f.calls.at(-1).operation, 'work-restore')
  for (const row of f.authCalls) row.guard.ensureCurrent()
})

const [{ createSimulationRuntime, SIM_SWEEP_INTERVAL_MS }, { createDefaultSimSession },
  { SIMULATION_OVERRIDES_KEY, SIMULATION_KNOWN_GROUPS_KEY, simulationSessionKey, simulationRhythmKey, createSimSessionStore },
  { createCharacterStore }, { createEmptyCharacterState, characterKey }, { agentPersonaScopeId },
  { simulationInitialPromptKey }, { createSimulationAdministration }, { decodeQqIncomingMessage }] = await Promise.all([
  load('modules/simulation/infrastructure/simulationRuntime.js'), load('modules/simulation/domain/simConfig.js'),
  load('modules/simulation/infrastructure/simSessionStore.js'), load('modules/simulation/infrastructure/characterStore.js'),
  load('modules/simulation/domain/characterState.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/simulation/infrastructure/simInitialPrompt.js'), load('modules/simulation/infrastructure/simulationAdministration.js'),
  load('adapters/qqMessage.js'),
])
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'
async function bounded(promise, label) {
  const timeout = new AbortController()
  try { return await Promise.race([promise, delay(1000, undefined, { signal: timeout.signal }).then(() => assert.fail(`timed out: ${label}`))]) }
  finally { timeout.abort() }
}
function host({ onGet, onSet, onAuthorize, storage } = {}) {
  let active = true, modelCalls = 0
  const now = 1_790_000_000_000, controller = new AbortController(), errors = [], modelStarted = gate()
  const entries = [structuredClone(binding), { ...structuredClone(binding), id: 'binding-2', connectionId: 'qq-2', target: { ...structuredClone(binding.target), account: { ...binding.target.account, id: '23000102' } } }]
  const values = new Map(), calls = [], permissions = new Map(), authorizations = []
  const scoped = selected => ({ botId: selected.target.account.id, personaId: agentPersonaScopeId(selected.agentId), groupId: selected.target.id })
  const keys = entries.map(item => simulationAddressKey(item.target))
  values.set(SIMULATION_OVERRIDES_KEY, JSON.stringify({ explicitEnabled: keys, disabled: [], budgetCaps: {}, turnCaps: {} }))
  values.set(SIMULATION_KNOWN_GROUPS_KEY, JSON.stringify(keys))
  for (const selected of entries) {
    const state = createDefaultSimSession(now); state.botId = selected.target.account.id; state.personaId = agentPersonaScopeId(selected.agentId)
    state.bindingToken = agentBindingToken(selected); state.bootstrapSent = true; state.seq = 17; state.lastReadThroughSeq = 17
    values.set(simulationSessionKey(simulationAddressKey(selected.target)), JSON.stringify(state))
    values.set(characterKey(scoped(selected)), JSON.stringify(createEmptyCharacterState(scoped(selected))))
  }
  const redis = {
    async get(key) { calls.push({ op: 'get', key }); await onGet?.(key, h); return storage ? storage.get(key) : values.get(key) ?? null },
    async set(key, value, options) {
      calls.push({ op: 'set', key, value, options })
      if (storage) { const result = await storage.set(key, value, options); await onSet?.(key, value, options, h); return result }
      if (options?.NX && values.has(key)) return null
      values.set(key, value); await onSet?.(key, value, options, h); return 'OK'
    },
    async del(...keys) { calls.push({ op: 'del', keys }); return storage ? storage.del(keys) : keys.reduce((n, key) => n + Number(values.delete(key)), 0) },
    async eval(script, { keys, arguments: args }) {
      calls.push({ op: 'eval', script, keys: [...keys], args: [...args] })
      if (storage) return storage.eval(script, { keys, arguments: args })
      if (script === RELEASE) { if (values.get(keys[0]) !== args[0]) return 0; return Number(values.delete(keys[0])) }
      if (script.includes('~= ARGV[1]') && script.includes('KEYS[2], ARGV[2]') && keys.length === 2) {
        if (values.get(keys[0]) !== args[0]) return 0
        values.set(keys[1], args[1]); values.delete(keys[0]); return 1
      }
      if (script.includes("if ARGV[1] == '' then") && keys.length === 2) {
        if (args[0]) { values.set(keys[0], args[0]); values.set(keys[1], args[1]) }
        else { values.delete(keys[0]); values.delete(keys[1]) }
        return 1
      }
      if (script.includes("redis.call('SET', KEYS[3], ARGV[3])") && keys.length === 3) {
        if (values.get(keys[0]) !== args[0] || values.get(keys[1]) !== args[1]) return 0
        values.set(keys[2], args[2]); values.set(keys[1], args[3]); return 1
      }
      // Runtime turn stores use additional Lua; these fixtures intentionally exercise fallback storage for scheduling below.
      throw Error('unexpected fixture Lua')
    },
  }
  const bindings = { list: () => entries, resolve: target => entries.find(item => simulationAddressKey(item.target) === simulationAddressKey(target)) }
  const auth = { isCurrent: () => active && !controller.signal.aborted, async authorize(principal, operation, selected, guard) {
    authorizations.push({ operation, selected }); await onAuthorize?.(operation, selected, h); guard.ensureCurrent()
    return permissions.get(`${operation}:${selected?.target.account.id ?? '*'}`) ?? 'allowed'
  } }
  const runtime = createSimulationRuntime({ redis, durableIngress: true, now: () => now, random: () => 0.99,
    logger: { info() {}, warn(value) { errors.push(value) }, error(value) { errors.push(value) } },
    getSection: () => ({ enabled: true, allGroups: false, groups: [], wake: { probability: 0, batchWindowMs: 1000 },
      rhythm: { enabled: false }, mood: { enabled: false }, userStyle: { enabled: false } }),
    handlesTarget: () => true,
    getSelf: botId => ({ id: String(botId ?? binding.target.account.id), name: 'fixture' }),
    getPersona: (_groupId, _botId, target) => { const selected = bindings.resolve(target); return { binding: selected, personaId: selected?.personaId ?? 'default', persona: { name: 'fixture' }, systemContent: 'fixture' } },
    getExecutionConfig: () => ({ useTools: true }),
    async YTapi() {
      modelCalls++; modelStarted.resolve()
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'finish', type: 'function', function: { name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: 'offline fixture' }) } }] }, finish_reason: 'tool_calls' }] }
    },
    async sendGroupMessage() { throw Error('unexpected online action') },
  })
  const adapter = createStandaloneAgentConsoleRuntime({ runtime, bindings, auth })
  const context = selected => {
    const captured = selected && structuredClone(selected), principal = { id: 'operator', username: 'admin', via: 'session' }
    const isCurrent = () => active && !controller.signal.aborted && (!captured || agentBindingToken(bindings.resolve(captured.target)) === agentBindingToken(captured))
    return { principal, signal: controller.signal, ...(captured ? { binding: captured } : {}), isCurrent, ensureCurrent() { if (!isCurrent()) throw new AgentConsoleError('conflict') } }
  }
  const h = { runtime, adapter, redis, entries, keys, values, calls, bindings, auth, context, scoped, permissions, authorizations, errors,
    modelStarted, modelCalls: () => modelCalls, revoke() { active = false }, controller }
  return h
}

test('real runtime persists every management family under separate complete accounts and never touches legacy bare keys', async t => {
  const h = host(); t.after(() => h.runtime.stop())
  const one = h.entries[0], two = h.entries[1], key = agentConversationKey(one), context = h.context(one)
  await h.adapter.disableGroup(key, context); await h.adapter.enableGroup(key, context)
  await h.adapter.setGroupBudget(key, 12.5, context); await h.adapter.setGroupTurnsCap(agentConversationKey(two), 9, h.context(two))
  await h.adapter.setGroupReplyMode(key, 'atOnly', context)
  await h.adapter.setInitialPrompt(key, 'first wake instructions', context)
  await h.adapter.resetGroup(key, context)
  await h.adapter.controlCharacter(key, 'pause', undefined, context)
  await h.adapter.controlActivity(key, 'reflection-reset', undefined, undefined, context)
  await h.adapter.setDefaultBudget(22, h.context())
  await h.adapter.setLifeRhythm(1, 8, h.context())
  const overrides = JSON.parse(h.values.get(SIMULATION_OVERRIDES_KEY))
  assert.equal(overrides.budgetCaps[h.keys[0]], 12.5); assert.equal(overrides.budgetCaps[h.keys[1]], undefined)
  assert.equal(overrides.turnCaps[h.keys[1]], 9); assert.equal(overrides.turnCaps[h.keys[0]], undefined)
  assert.ok(overrides.atOnly.includes(h.keys[0])); assert.equal(overrides.budgetDefaultCny, 22)
  assert.equal(h.values.get(simulationInitialPromptKey(h.keys[0])), 'first wake instructions')
  assert.equal(h.values.has(simulationInitialPromptKey(h.keys[1])), false)
  assert.equal(JSON.parse(h.values.get(simulationSessionKey(h.keys[0]))).seq, 17)
  assert.equal(JSON.parse(h.values.get(characterKey(h.scoped(one)))).paused, true)
  for (const entry of h.entries) assert.equal(JSON.parse(h.values.get(simulationRhythmKey(h.scoped(entry)))).setBy, 'admin')
  assert.equal(h.values.has(simulationSessionKey(binding.target.id)), false)
  assert.equal(h.modelCalls(), 0)
  assert.ok(h.authorizations.length > 20)
})

test('actual overview authorizes each scope before pruning and removes hidden settings and rows', async t => {
  const h = host(); t.after(() => h.runtime.stop())
  h.permissions.set('simulation.group-read:23000102', 'denied')
  const view = await h.adapter.overview(h.context())
  assert.equal(view.groups.length, 1); assert.equal(view.groups[0].bindingToken, agentBindingToken(h.entries[0]))
  assert.deepEqual(view.explicitEnabled, [agentConversationKey(h.entries[0])])
  const hiddenPrefix = characterKey(h.scoped(h.entries[1]))
  assert.equal(h.calls.some(row => row.key?.startsWith(hiddenPrefix) || row.keys?.some(key => key.startsWith(hiddenPrefix))), false)
  assert.equal(h.modelCalls(), 0)
})

test('binding loss during a real read prevents the next Redis mutation; permission changes are reauthorized before each SET/eval', async t => {
  let revoked = false
  const h = host({ onGet(key, h) { if (!revoked && key === SIMULATION_OVERRIDES_KEY) { revoked = true; h.entries[0] = { ...h.entries[0], revision: 'v2' } } } })
  t.after(() => h.runtime.stop())
  await assert.rejects(h.adapter.setGroupBudget(agentConversationKey(h.entries[0]), 2, h.context(h.entries[0])), { code: 'conflict' })
  assert.equal(h.calls.some(row => row.op !== 'get'), false)
  const g = host({ onGet(key, h) { if (key === SIMULATION_OVERRIDES_KEY) h.permissions.set('simulation.group-write:23000101', 'denied') } })
  t.after(() => g.runtime.stop())
  await assert.rejects(g.adapter.setGroupBudget(agentConversationKey(g.entries[0]), 2, g.context(g.entries[0])), { code: 'forbidden' })
  assert.equal(g.calls.some(row => row.op !== 'get'), false)
  let checks = 0
  const e = host({ onAuthorize(operation, selected, h) { if (operation === 'simulation.group-write' && ++checks > 1) h.permissions.set(`${operation}:${selected.target.account.id}`, 'denied') } })
  t.after(() => e.runtime.stop())
  await assert.rejects(e.adapter.setInitialPrompt(agentConversationKey(e.entries[0]), 'blocked', e.context(e.entries[0])), { code: 'forbidden' })
  assert.equal(e.calls.some(row => row.op === 'eval'), false)
})

test('a reset waiting inside the real session write queue cannot persist after its request is revoked', async t => {
  const entered = gate(), release = gate()
  let hold = true
  const h = host({ async onSet(key) { if (hold && key.startsWith('shiloh:sim:g:') && !key.endsWith(':lock')) { hold = false; entered.resolve(); await release.promise } } })
  t.after(() => h.runtime.stop())
  const store = createSimSessionStore({ redis: createSimulationAdministration(h.redis).redis })
  const state = JSON.parse(h.values.get(simulationSessionKey(h.keys[0]))); state.seq = 23
  const pending = store.save(h.keys[0], state)
  await entered.promise
  const reset = h.adapter.resetGroup(agentConversationKey(h.entries[0]), h.context(h.entries[0])).catch(error => error)
  await nextTurn(); h.revoke(); release.resolve(); await pending
  assert.equal((await reset).code, 'conflict')
  assert.equal(JSON.parse(h.values.get(simulationSessionKey(h.keys[0]))).seq, 23)
  assert.equal(h.calls.filter(row => row.op === 'set' && row.key === simulationSessionKey(h.keys[0])).length, 1)
})

test('concurrent real administration serializes whole overrides updates without dropping another account budget', async t => {
  const entered = gate(), release = gate(); let hold = true
  const h = host({ async onGet(key) { if (hold && key === SIMULATION_OVERRIDES_KEY) { hold = false; entered.resolve(); await release.promise } } })
  t.after(() => h.runtime.stop())
  const first = h.adapter.setGroupBudget(agentConversationKey(h.entries[0]), 4, h.context(h.entries[0]))
  await entered.promise
  const second = h.adapter.setGroupBudget(agentConversationKey(h.entries[1]), 7, h.context(h.entries[1]))
  await nextTurn(); assert.equal(h.calls.filter(row => row.key === SIMULATION_OVERRIDES_KEY).length, 1)
  release.resolve(); await Promise.all([first, second])
  assert.deepEqual(JSON.parse(h.values.get(SIMULATION_OVERRIDES_KEY)).budgetCaps, { [h.keys[0]]: 4, [h.keys[1]]: 7 })
})

test('global rhythm stops before the next scoped write if the complete binding directory changes mid-operation', async t => {
  let changed = false
  const h = host({ onSet(key, _value, _options, h) { if (!changed && key === simulationRhythmKey(h.scoped(h.entries[0]))) {
    changed = true
    // Even a malformed host that forgets to bump revision cannot move an address unnoticed.
    h.entries[1] = { ...h.entries[1], target: { ...h.entries[1].target, id: '310902' } }
  } } })
  t.after(() => h.runtime.stop())
  const untouched = simulationRhythmKey(h.scoped(h.entries[1]))
  await assert.rejects(h.adapter.setLifeRhythm(2, 9, h.context()), { code: 'conflict' })
  assert.equal(h.values.has(untouched), false)
  // The authorized writes already dispatched before revocation are preserved; this is not a multi-key transaction.
  assert.equal(JSON.parse(h.values.get(simulationRhythmKey())).sleepFrom, 2)
})

test('real sweeper scheduling exits the HTTP lease before creating the interval', async t => {
  const original = globalThis.setInterval, observed = gate()
  globalThis.setInterval = (run, ms, ...args) => original(run, ms === SIM_SWEEP_INTERVAL_MS ? 15 : ms, ...args)
  t.after(() => { globalThis.setInterval = original })
  let completed = false
  const h = host({ onGet(key) { if (completed && key === SIMULATION_OVERRIDES_KEY) observed.resolve() } })
  t.after(() => h.runtime.stop())
  await h.runtime.runAdministration(h.context(), () => h.runtime.start())
  completed = true; h.revoke()
  await bounded(observed.promise, 'detached sweeper reads')
  h.runtime.stop(); assert.equal(h.errors.some(value => value.includes('调度检查失败')), false)
})

test('a real local Redis wake launches its background turn after the originating administration request has expired', async t => {
  const { storage } = await createQzoneRedis(t), original = globalThis.setTimeout
  globalThis.setTimeout = (run, ms, ...args) => original(run, ms === 1000 ? 20 : ms, ...args)
  t.after(() => { globalThis.setTimeout = original })
  const h = host({ storage }); t.after(() => h.runtime.stop())
  for (const [key, value] of h.values) await storage.set(key, value)
  const at = 1_790_000_000_000, selected = h.entries[0]
  const message = decodeQqIncomingMessage({ self_id: selected.target.account.id, group_id: selected.target.id, user_id: '40000101',
    message_id: 'wake-1', message_type: 'group', msg: 'hello', atBot: true,
    message: [{ type: 'at', data: { qq: selected.target.account.id } }, { type: 'text', data: { text: 'hello' } }], sender: { nickname: 'fixture' } }, { now: at })
  assert.ok(message)
  await h.runtime.runAdministration(h.context(selected), () => h.runtime.ingest(message))
  h.revoke()
  await bounded(h.modelStarted.promise, `detached wake reaches offline model: ${h.errors.join(' | ')}`)
  await h.runtime.drain()
  assert.equal(h.modelCalls(), 1)
  assert.equal(h.errors.some(value => value.includes('调度回合失败')), false)
  const state = JSON.parse(await storage.get(simulationSessionKey(h.keys[0])))
  assert.equal(state.budget.turns, 1)
  assert.ok(h.calls.some(row => row.op === 'eval'))
})

test('a rate-limited real Redis wake retries independently after the originating request lease has completed', async t => {
  const { storage } = await createQzoneRedis(t), original = globalThis.setTimeout, retry = gate()
  const h = host({ storage }); t.after(() => h.runtime.stop())
  for (const [key, value] of h.values) await storage.set(key, value)
  const sessionKey = simulationSessionKey(h.keys[0]), state = JSON.parse(await storage.get(sessionKey))
  state.queuedIngressWake = { kind: 'timeout' }; state.wakeTimes = [1_790_000_000_000, 1_790_000_000_000]
  await storage.set(sessionKey, JSON.stringify(state))
  let retries = 0
  globalThis.setTimeout = (run, ms, ...args) => {
    if (ms === 60_000) {
      retries++; retry.resolve()
      return original(() => { void (async () => {
        // Only the test clock's wake window changes; the real production retry callback is retained.
        const current = JSON.parse(await storage.get(sessionKey)); current.wakeTimes = []
        await storage.set(sessionKey, JSON.stringify(current)); run(...args)
      })().catch(error => assert.fail(String(error))) }, 30)
    }
    return original(run, ms === 1000 ? 20 : ms, ...args)
  }
  t.after(() => { globalThis.setTimeout = original })
  await h.runtime.runAdministration(h.context(), () => h.runtime.sweepOnce())
  h.revoke()
  await bounded(retry.promise, `rate limit schedules retry: ${h.errors.join(' | ')}`)
  await bounded(h.modelStarted.promise, `retry reaches offline model: ${h.errors.join(' | ')}`)
  await h.runtime.drain()
  assert.equal(retries, 1); assert.equal(h.modelCalls(), 1)
  assert.equal(h.errors.some(value => value.includes('调度回合失败')), false)
})
