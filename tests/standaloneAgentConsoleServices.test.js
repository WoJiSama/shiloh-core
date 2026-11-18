import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createStandaloneAgentConsoleServices }, { AgentConsoleError }, { agentConversationKey, agentBindingToken },
  { simulationAddressKey }, { createTokenLedger }, { ensureSynchronousGuard }] = await Promise.all([
  load('bootstrap/standaloneAgentConsoleServices.js'), load('contracts/agentConsole.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/simulation/infrastructure/simulationAddress.js'), load('modules/models/infrastructure/tokenLedger.js'),
  load('modules/runtime/domain/synchronousGuard.js'),
])
function binding(id = '23000101') {
  return { source: 'configured', id: `binding-${id}`, revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: `qq-${id}`,
    target: { account: { platform: 'qq', namespace: 'global', id }, kind: 'group', id: '310901' } }
}
function fixture(extra = {}) {
  const bindings = [binding(), binding('23000102')], decisions = new Map(), controller = new AbortController()
  let active = true
  const principal = { id: 'operator', username: 'admin', via: 'session' }
  const context = selected => {
    const captured = selected && structuredClone(selected), isCurrent = () => active && !controller.signal.aborted && (!captured || bindings.some(current => agentConversationKey(current) === agentConversationKey(captured) && agentBindingToken(current) === agentBindingToken(captured)))
    return { principal, ...(captured ? { binding: captured } : {}), signal: controller.signal, isCurrent, ensureCurrent() { if (!isCurrent()) throw new AgentConsoleError('conflict') } }
  }
  const ports = { bindings: { list: () => bindings, resolve: target => bindings.find(item => agentConversationKey(item) === agentConversationKey({ agentId: item.agentId, target })) },
    auth: { async authorize(_principal, operation, selected, guard) { guard.ensureCurrent(); return decisions.get(`${operation}:${selected?.target.account.id}`) ?? 'allowed' } }, ...extra }
  const services = createStandaloneAgentConsoleServices(ports)
  const call = async (operation, { body = {}, query = {}, params = {}, selected } = {}) => {
    const service = services.find(item => item.operation === operation)
    assert.ok(service?.handle, `${operation} installed`)
    return (await service.handle({ method: service.method, pathname: service.path, body, query, params }, context(selected))).value
  }
  return { ports, bindings, decisions, controller, context, services, call, revoke: () => { active = false } }
}

test('real standalone token ledger supplies totals, bounded series and recent rows without plugin globals or duplicate accounting', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'console-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const at = Date.now(), ledger = createTokenLedger({ dataDir: directory, now: () => at })
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  ledger.record({ scope: 'global', stage: 'api', model: 'fixture-model', usage })
  ledger.record({ scope: agentConversationKey(binding()), stage: 'sim-turn', model: 'fixture-model', usage }); await ledger.flush()
  const file = path.join(directory, 'token_usage', new Date(at + 8 * 3600_000).toISOString().slice(0, 10) + '.ndjson'), before = await readFile(file, 'utf8')
  const f = fixture({ ledger }), summary = await f.call('tokens.summary')
  assert.equal(summary.today.tokens, 120); assert.equal(summary.today.calls, 1); assert.equal(summary.today.byScopeTop[0].scope, agentConversationKey(binding()))
  const series = await f.call('tokens.series', { query: { hours: '24' } })
  assert.equal(series.hours, 24); assert.equal(series.buckets.reduce((total, row) => total + row.tokens, 0), 120)
  assert.equal((await f.call('tokens.recent', { query: { limit: '1' } })).rows.length, 1)
  for (const limit of ['0', '501', '1.5', 'NaN']) await assert.rejects(f.call('tokens.recent', { query: { limit } }), { code: 'invalid_request' })
  await assert.rejects(f.call('tokens.series', { query: { hours: '721' } }), { code: 'invalid_request' })
  assert.equal(await readFile(file, 'utf8'), before)
})

test('all existing simulation mutations dispatch the full binding key and guard without bare-group aliases', async () => {
  const calls = [], runtime = {}
  for (const method of ['enableGroup', 'disableGroup', 'resetGroup', 'setInitialPrompt', 'setGroupBudget', 'setGroupTurnsCap', 'setGroupReplyMode', 'controlCharacter', 'controlActivity']) {
    runtime[method] = async (...args) => { args.at(-1).ensureCurrent(); calls.push({ method, args }); return `saved-${method}` }
  }
  const f = fixture({ runtime }), selected = f.bindings[1], key = agentConversationKey(selected)
  const inputs = [{ action: 'enable' }, { action: 'disable' }, { action: 'reset' }, { action: 'initial-prompt', text: '完整提示词\n第二行' },
    { action: 'budget', cap: 1.5 }, { action: 'turns', cap: -1 }, { action: 'reply-mode', mode: 'atOnly' },
    { action: 'character', operation: 'delete-memory', id: 'memory-1' }, { action: 'activity', operation: 'work-restore', id: 'work-1', payload: { revision: 2 } }]
  for (const body of inputs) {
    const result = await f.call('simulation.group-write', { selected, body: { ...body, group: selected.target.id } })
    assert.equal(result.ok, true); assert.equal(calls.at(-1).args[0], key); assert.deepEqual(calls.at(-1).args.at(-1).binding, selected)
  }
  assert.equal(calls.length, 9)
  await assert.rejects(f.call('simulation.group-write', { selected, body: { action: 'disable', group: '999999' } }), { code: 'conflict' })
  for (const body of [{ action: 'budget', cap: '10' }, { action: 'budget', cap: -0.5 }, { action: 'turns', cap: 1.5 },
    { action: 'reply-mode', mode: 'other' }, { action: 'character', operation: 'pause', id: 'unexpected' },
    { action: 'activity', operation: 'work-restore', id: 'work-1', payload: { revision: 0 } },
    { action: 'activity', operation: 'reflection-reset', payload: {} }, { action: 'enable', isMaster: true }]) {
    await assert.rejects(f.call('simulation.group-write', { selected, body }), { code: 'invalid_request' })
  }
  assert.equal(calls.length, 9)
})

test('simulation views keep current scoped rows, permission filtering and explicit full selectors across equal group IDs', async () => {
  let f
  const runtime = { async overview() { return { enabled: true, groups: f.bindings.map(item => ({ groupId: simulationAddressKey(item.target), active: true })).concat({ groupId: '310901', active: true }) } },
    async describeGroup(scope, context) { context.ensureCurrent(); return { groupId: scope, unreadCount: 3 } } }
  f = fixture({ runtime }); f.decisions.set('simulation.group-read:23000102', 'denied')
  const view = await f.call('simulation.read')
  assert.equal(view.groups.length, 1); assert.equal(view.unscopedOrHiddenGroups, 2)
  assert.equal(view.groups[0].groupId, agentConversationKey(f.bindings[0])); assert.equal(view.groups[0].bindingToken, agentBindingToken(f.bindings[0]))
  const detail = await f.call('simulation.group-read', { selected: f.bindings[1] })
  assert.equal(detail.unreadCount, 3); assert.equal(detail.scopeKey, agentConversationKey(f.bindings[1])); assert.deepEqual(detail.conversation, f.bindings[1].target)
  assert.equal(detail.bindingToken, agentBindingToken(f.bindings[1]))
  f.ports.auth.authorize = async (_principal, _operation, selected, guard) => { f.bindings[0] = { ...f.bindings[0], revision: 'rebound' }; assert.equal(guard.isCurrent(), false); return 'allowed' }
  await assert.rejects(f.call('simulation.read'), { code: 'conflict' })
})

test('row authorization gives a synchronous helper consumer one fresh combined authority observation', async () => {
  let f, resolutions = 0
  f = fixture({ runtime: { async overview() { return { groups: [{ scopeKey: agentConversationKey(f.bindings[0]), active: true }] } } } })
  const resolve = f.ports.bindings.resolve
  f.ports.bindings.resolve = target => { resolutions++; return resolve(target) }
  f.ports.auth.authorize = async (_principal, _operation, _selected, guard) => {
    const before = resolutions
    ensureSynchronousGuard(guard, () => { throw new AgentConsoleError('conflict') }, 'current-first')
    assert.equal(resolutions - before, 1, 'one helper observation checks the row binding once')
    return 'allowed'
  }
  const view = await f.call('simulation.read')
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0].active, true)
  assert.equal(view.groups[0].bindingToken, agentBindingToken(f.bindings[0]))
})

test('binding resolution observers may read a projected row guard during authorization', async () => {
  let f, captured, busy = false
  const observations = []
  f = fixture({ runtime: { async overview() { return { groups: [{ scopeKey: agentConversationKey(f.bindings[0]) }] } } } })
  const resolve = f.ports.bindings.resolve
  f.ports.bindings.resolve = target => {
    if (captured && !busy) {
      busy = true
      try { observations.push(captured.isCurrent()) } finally { busy = false }
    }
    return resolve(target)
  }
  f.ports.auth.authorize = async (_principal, _operation, _selected, guard) => {
    captured = guard
    ensureSynchronousGuard(guard, () => { throw new AgentConsoleError('conflict') }, 'current-first')
    return 'allowed'
  }
  assert.equal((await f.call('simulation.read')).groups.length, 1)
  assert.ok(observations.length > 0)
  assert.equal(observations.every(Boolean), true)
})

test('row projection withholds an allowed authorization after awaited session or binding withdrawal', async () => {
  for (const changed of ['session', 'binding']) {
    let f, captured
    f = fixture({ runtime: { async overview() { return { groups: [{ scopeKey: agentConversationKey(f.bindings[0]) }] } } } })
    f.ports.auth.authorize = async (_principal, _operation, _selected, guard) => {
      captured = guard
      await Promise.resolve()
      if (changed === 'session') f.revoke()
      else f.bindings[0] = { ...f.bindings[0], revision: 'withdrawn' }
      return 'allowed'
    }
    await assert.rejects(f.call('simulation.read'), { code: 'conflict' }, changed)
    assert.equal(captured.isCurrent(), false, changed)
    assert.throws(captured.ensureCurrent, { code: 'conflict' }, changed)
  }
})

test('later aggregate authorization cannot return an earlier row that was rebound while waiting', async () => {
  let f, checked = 0
  f = fixture({ runtime: { async overview() { return { groups: f.bindings.map(item => ({ scopeKey: agentConversationKey(item) })) } } } })
  f.ports.auth.authorize = async () => { if (++checked === 2) f.bindings[0] = { ...f.bindings[0], revision: 'changed' }; return 'allowed' }
  await assert.rejects(f.call('simulation.read'), { code: 'conflict' })
})

test('trusteeship rechecks earlier arrays after later categories finish authorization', async () => {
  let f, checks = 0
  f = fixture({ trusteeship: { async overview() {
    return { commitments: [{ id: 'first', scopeKey: agentConversationKey(f.bindings[0]) }], delegated: [],
      failures: [{ id: 'last', scopeKey: agentConversationKey(f.bindings[1]) }] }
  } } })
  f.ports.auth.authorize = async () => { if (++checks === 2) f.bindings[0] = { ...f.bindings[0], revision: 'changed' }; return 'allowed' }
  await assert.rejects(f.call('trusteeship.read'), { code: 'conflict' })
})

test('partial runtime capabilities remain absent while supported life, health and default-budget operations validate before dispatch', async () => {
  const calls = []
  const f = fixture({ runtime: { setDefaultBudget: async (cap, context) => { context.ensureCurrent(); calls.push(cap); return 'saved' },
    lifeOverview: async () => ({ rhythm: { sleepFrom: 1, sleepTo: 8 }, threads: [], now: { hour: 12, sleeping: false } }),
    getHealthAlerts: async () => ({ alerts: [{ code: 'real-alert' }], checkedAt: 100 }),
    setLifeRhythm: async (from, to, context) => { context.ensureCurrent(); calls.push([from, to]); return 'saved' }, enableGroup: async () => 'enabled' } })
  assert.equal(f.services.some(item => item.operation === 'simulation.group-read'), false)
  assert.equal((await f.call('life.read')).now.hour, 12); assert.equal((await f.call('health.read')).alerts[0].code, 'real-alert')
  assert.equal((await f.call('simulation.budget-default', { body: { cny: 10 } })).ok, true)
  assert.equal((await f.call('life.rhythm', { body: { sleepFrom: 1, sleepTo: 8 } })).ok, true)
  await assert.rejects(f.call('life.rhythm', { body: { sleepFrom: 8, sleepTo: 1 } }), { code: 'invalid_request' })
  await assert.rejects(f.call('simulation.group-write', { selected: f.bindings[0], body: { action: 'reset' } }), { code: 'unavailable' })
  assert.deepEqual(calls, [10, [1, 8]])
})

test('source entry deletion passes an exact entry ID and full binding to the Core profile port', async () => {
  const calls = [], selected = binding()
  const f = fixture({ profiles: { async removeField(userId, field, value, context) {
    context.ensureCurrent(); calls.push({ userId, field, value, binding: context.binding }); return { userId, entries: [] }
  } } })
  const response = await f.call('profiles.delete-field', { selected, body: { userId: '330091', field: 'entries', value: 'source-entry-1' } })
  assert.equal(response.ok, true); assert.deepEqual(response.profile.entries, [])
  assert.deepEqual(calls, [{ userId: '330091', field: 'entries', value: 'source-entry-1', binding: selected }])
  await assert.rejects(f.call('profiles.delete-field', { selected, body: { userId: '330091', field: 'entries' } }), { code: 'invalid_request' })
  assert.equal(calls.length, 1)
})

test('persona and provider mappings pass exact CAS payloads to neutral ports without manufacturing config or secret placeholders', async () => {
  const calls = []
  const f = fixture({ persona: { read: async () => ({ personas: [{ id: 'daily', name: '真实人设' }], revision: 'persona-v1' }),
    write: async (payload, context) => { context.ensureCurrent(); calls.push(['persona', payload]); return { ok: true } }, accounts: () => [{ connectionId: 'qq-23000101', account: binding().target.account }] },
    providers: { read: () => ({ sections: {}, revisions: { model: 'provider-v1' } }), write: async (payload, context) => { context.ensureCurrent(); calls.push(['providers', payload]); return { ok: true } },
      probe: async payload => { calls.push(['probe', payload]); return { ok: true } } } })
  assert.equal((await f.call('persona.read')).personas[0].name, '真实人设')
  const payload = { revision: 'persona-v1', personas: [{ id: 'daily', name: '改名' }], bindings: [{ scopeKey: agentConversationKey(f.bindings[0]), bindingToken: agentBindingToken(f.bindings[0]) }] }
  await f.call('persona.write', { body: payload }); assert.deepEqual(calls[0], ['persona', payload])
  assert.equal((await f.call('persona-accounts.read')).accounts[0].connectionId, 'qq-23000101')
  const providerPayload = { revision: 'provider-v1', configKey: 'model', providers: [{ _consoleId: 'c-existing', apiKeyAction: 'keep' }] }
  await f.call('providers.write', { body: providerPayload }); assert.deepEqual(calls[1], ['providers', providerPayload])
  await f.call('providers.probe', { body: { configKey: 'model' } }); assert.equal(calls[2][0], 'probe')
  for (const operation of ['persona.write', 'providers.write']) await assert.rejects(f.call(operation, { body: {} }), { code: 'invalid_request' })
})

test('trusteeship and profile mutations preserve original IDs while passing the complete binding to real partitioned ports', async () => {
  const calls = [], first = binding(), second = binding('23000102')
  const f = fixture({ profiles: { list: () => [{ binding: first, profile: { userId: '330091', name: '原档案' } }, { binding: second, profile: { userId: '330091', name: '另一账号档案' } }],
    remove: async (id, context) => { context.ensureCurrent(); calls.push(['profile', id, context.binding]); return true } },
    trusteeship: { overview: () => ({ commitments: [{ id: 'original-extra-id', scopeKey: agentConversationKey(first) }], delegated: [{ scopeKey: agentConversationKey(first), entries: [{ id: 'original-delegated-id' }] }],
      failures: [{ scopeKey: agentConversationKey(first), reason: 'kept' }, { group_id: '310901', intent: 'unscoped-private-data' }], config: { maxActivePerGroup: 10 } }),
    cancelCommitment: async (scope, id, context) => { context.ensureCurrent(); calls.push(['commitment', scope, id, context.binding]); return true },
    deleteDelegated: async (scope, id, context) => { context.ensureCurrent(); calls.push(['delegated', scope, id, context.binding]); return true } } })
  const overview = await f.call('trusteeship.read')
  assert.equal(overview.commitments[0].id, 'original-extra-id'); assert.equal(overview.commitments[0].bindingToken, agentBindingToken(first))
  assert.equal(overview.failures.length, 1); assert.equal(JSON.stringify(overview).includes('unscoped-private-data'), false)
  assert.equal((await f.call('profiles.read')).profiles.length, 2)
  await f.call('profiles.delete', { selected: second, body: { userId: '330091' } })
  await f.call('commitments.cancel', { selected: first, body: { id: 'original-extra-id' } })
  await f.call('delegated.delete', { selected: first, body: { id: 'original-delegated-id', groupId: first.target.id } })
  assert.deepEqual(calls[0], ['profile', '330091', second]); assert.deepEqual(calls[1], ['commitment', agentConversationKey(first), 'original-extra-id', first])
  assert.deepEqual(calls[2], ['delegated', agentConversationKey(first), 'original-delegated-id', first])
})

test('ports receive a live guard and cannot commit queued work after host or binding withdrawal', async () => {
  for (const changed of ['host', 'binding']) {
    let f, committed = false
    f = fixture({ runtime: { async disableGroup(_key, context) {
      await Promise.resolve()
      if (changed === 'host') f.revoke()
      else f.bindings[0] = { ...f.bindings[0], revision: 'withdrawn' }
      context.ensureCurrent(); committed = true; return 'saved'
    } } })
    await assert.rejects(f.call('simulation.group-write', { selected: f.bindings[0], body: { action: 'disable' } }), { code: 'conflict' }); assert.equal(committed, false)
  }
  const f = fixture(); assert.deepEqual(f.services, [])
})
