import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createStandaloneAgentWorkspace }, { AGENT_CONSOLE_SERVICES, AgentConsoleError }, { agentBindingToken, agentConversationKey, conversationAddressKey }] = await Promise.all([
  load('bootstrap/standaloneAgentWorkspace.js'), load('contracts/agentConsole.js'), load('modules/runtime/domain/agentBindings.js'),
])
const definition = operation => ({ ...AGENT_CONSOLE_SERVICES.find(row => row.operation === operation) })
function binding(index = 1) {
  const target = { account: { platform: 'qq', namespace: 'global', id: `account-${index}` }, kind: 'group', id: 'equal-group' }
  return { source: 'configured', id: conversationAddressKey(target), revision: 'loaded-v1', agentId: `agent-${index}`, personaId: 'shared-persona', connectionId: `connection-${index}`, target }
}
function fixture() {
  const rows = [binding(1), binding(2)], decisions = new Map(), calls = [], controller = new AbortController()
  const conversationNames = new Map()
  let hostCurrent = true, authCurrent = true, time = 1000, handlerCalls = 0
  const data = {
    agents: [1, 2, 3].map(index => ({ id: `agent-${index}`, name: `Agent ${index}`, personaId: 'shared-persona', personaName: 'Shared persona' })),
    connections: [1, 2, 3].map(index => ({ id: `connection-${index}`, account: binding(index).target.account, state: index === 2 ? 'unknown' : 'connected', capabilities: ['messages.send'] })),
    config: { processEpoch: 'process-1', loadedRevision: 'loaded-v1', storedRevision: 'loaded-v1', requiresRestart: false, phase: 'active' },
    services: ['overview.read', 'config-state.read', 'simulation.group-read', 'simulation.group-write', 'providers.probe'].map(operation => ({ ...definition(operation), handle: async () => { handlerCalls++; return { kind: 'json', value: {} } } })),
  }
  const principal = Object.freeze({ id: 'operator', username: 'admin', via: 'session' })
  const context = { principal, signal: controller.signal, isCurrent: () => hostCurrent && !controller.signal.aborted,
    ensureCurrent() { if (!this.isCurrent()) throw new AgentConsoleError('conflict') } }
  const options = {
    bindings: { list: () => rows, resolve: target => rows.find(row => conversationAddressKey(row.target) === conversationAddressKey(target)) },
    auth: { isCurrent: () => authCurrent,
      async authorize(_principal, operation, selected, guard) {
        guard.ensureCurrent(); calls.push({ operation, selected, guard })
        return decisions.get(`${operation}:${selected ? selected.target.account.id : 'global'}`) ?? 'allowed'
      } },
    agents: () => data.agents, connections: () => data.connections, services: () => data.services,
    conversationName: selected => conversationNames.get(conversationAddressKey(selected.target)),
    configState: () => data.config, now: () => time++,
  }
  const service = createStandaloneAgentWorkspace(options)
  data.services.push(service)
  const call = async (override = {}, selectedContext = context) => (await service.handle({ method: 'GET', pathname: '/api/workspace', params: {}, query: {}, body: {}, ...override }, selectedContext)).value
  return { rows, data, decisions, calls, controller, context, options, service, call, conversationNames,
    revokeHost: () => { hostCurrent = false }, revokeAuth: () => { authCurrent = false }, handlerCalls: () => handlerCalls }
}
const capability = (view, operation) => view.capabilities.find(row => row.operation === operation)
const hiddenUnbound = f => { f.decisions.set('agents.read:global', 'denied'); f.decisions.set('connections.read:global', 'denied') }

test('workspace separates Agents sharing a Persona and equal group IDs on different accounts in a detached frozen snapshot', async () => {
  const f = fixture(); hiddenUnbound(f)
  f.rows[0].revision = 'loaded:' + 'v'.repeat(200)
  f.rows.forEach((row, index) => f.conversationNames.set(conversationAddressKey(row.target), `群名 ${index + 1}`))
  f.data.connections.forEach((row, index) => { row.name = `QQ 昵称 ${index + 1}` })
  const result = await f.call()
  assert.deepEqual([f.service.operation, f.service.method, f.service.path, f.service.scope], ['workspace.read', 'GET', '/api/workspace', 'global'])
  assert.equal(result.mode, 'standalone'); assert.equal(result.version, 1); assert.equal(result.observedAt, 1000)
  assert.equal(result.agents.length, 2); assert.equal(result.agents[0].personaId, result.agents[1].personaId)
  assert.notEqual(result.agents[0].id, result.agents[1].id)
  const first = result.agents[0].conversations[0], second = result.agents[1].conversations[0]
  assert.deepEqual([first.name, second.name], ['群名 1', '群名 2'])
  assert.deepEqual(result.connections.map(row => row.name), ['QQ 昵称 1', 'QQ 昵称 2'])
  assert.notEqual(first.scopeKey, second.scopeKey); assert.equal(first.scopeKey, agentConversationKey(f.rows[0]))
  assert.equal(first.bindingToken, agentBindingToken(f.rows[0])); assert.deepEqual(first.binding, f.rows[0])
  f.conversationNames.set(conversationAddressKey(f.rows[0].target), '已更新群名')
  const renamed = (await f.call()).agents[0].conversations[0]
  assert.equal(renamed.name, '已更新群名')
  assert.equal(renamed.scopeKey, first.scopeKey); assert.equal(renamed.bindingToken, first.bindingToken)
  assert.deepEqual(result.connections.map(row => row.conversationCount), [1, 1]); assert.equal(result.connections[1].state, 'unknown')
  assert.deepEqual(result.cognition, { status: 'planned' }); assert.deepEqual(result.configState, f.data.config)
  for (const value of [result, result.agents, result.agents[0], first, first.binding, first.binding.target, first.binding.target.account, result.connections[0].capabilities, result.configState]) assert.equal(Object.isFrozen(value), true)
  f.rows[0].target.id = 'changed'; f.data.agents[0].name = 'changed'; f.data.connections[0].capabilities.push('changed')
  assert.equal(first.binding.target.id, 'equal-group'); assert.equal(result.agents[0].name, 'Agent 1'); assert.deepEqual(result.connections[0].capabilities, ['messages.send'])
  assert.equal(f.handlerCalls(), 0)
})

test('workspace.read grants no binding or unbound Agent/connection visibility and conversation capabilities enumerate actual authorized scopes', async () => {
  const f = fixture(); hiddenUnbound(f)
  f.conversationNames.set(conversationAddressKey(f.rows[1].target), '不可见群名')
  f.data.connections[1].name = '不可见 QQ 昵称'
  f.data.connections[2].name = '未绑定 QQ 昵称'
  f.decisions.set('bindings.read:account-2', 'denied')
  f.decisions.set('simulation.group-write:account-1', 'denied')
  const result = await f.call()
  assert.doesNotMatch(JSON.stringify(result), /不可见群名|不可见 QQ 昵称|未绑定 QQ 昵称/u)
  assert.deepEqual(result.agents.map(row => row.id), ['agent-1']); assert.deepEqual(result.connections.map(row => row.id), ['connection-1'])
  assert.equal(capability(result, 'simulation.group-read').status, 'available')
  assert.deepEqual(capability(result, 'simulation.group-read').authorizedScopes, [agentConversationKey(f.rows[0])])
  assert.equal(capability(result, 'simulation.group-write').status, 'forbidden'); assert.deepEqual(capability(result, 'simulation.group-write').authorizedScopes, [])
  assert.deepEqual(f.calls.filter(row => row.operation === 'bindings.read').map(row => row.selected.target.account.id), ['account-1', 'account-2'])
  assert.equal(f.calls.some(row => row.operation === 'simulation.group-read' && row.selected?.target.account.id === 'account-2'), false)
  f.decisions.set('bindings.read:account-1', 'denied')
  const empty = await f.call(); assert.deepEqual(empty.agents, []); assert.deepEqual(empty.connections, [])
  assert.equal(capability(empty, 'simulation.group-read').reason, 'no-visible-conversations')
})

test('unbound metadata requires the dedicated global directory permissions', async () => {
  const f = fixture()
  f.decisions.set('bindings.read:account-2', 'denied'); f.decisions.set('connections.read:global', 'denied')
  const result = await f.call()
  assert.deepEqual(result.agents.map(row => [row.id, row.conversations.length]), [['agent-1', 1], ['agent-2', 0], ['agent-3', 0]])
  assert.deepEqual(result.connections.map(row => row.id), ['connection-1'])
  f.decisions.set('agents.read:global', 'denied'); f.decisions.set('connections.read:global', 'allowed')
  const connections = await f.call()
  assert.deepEqual(connections.agents.map(row => row.id), ['agent-1'])
  assert.deepEqual(connections.connections.map(row => [row.id, row.conversationCount]), [['connection-1', 1], ['connection-2', 0], ['connection-3', 0]])
})

test('unknown or mismatched connection and Agent ownership fail closed without guessing from equal group IDs', async () => {
  for (const mutate of [
    f => { f.rows[0].connectionId = 'unknown' }, f => { f.rows[0].connectionId = 'connection-2' },
    f => { f.rows[0].agentId = 'unknown' }, f => { f.data.agents[0].personaId = 'different' },
  ]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.call(), { code: 'conflict' }); assert.equal(f.calls.length, 0)
  }
})

test('capabilities intersect the real catalog with installed handlers and scope each conversation authorization independently', async () => {
  const f = fixture()
  f.data.services = f.data.services.filter(row => row.operation !== 'overview.read')
  f.data.services.push(definition('overview.read'), { ...definition('life.read'), path: '/wrong', handle: async () => assert.fail('must not execute') },
    { operation: 'fake.read', method: 'GET', path: '/fake', scope: 'global', handle: async () => assert.fail('must not execute') })
  f.decisions.set('simulation.group-write:account-2', 'denied'); f.decisions.set('providers.probe:global', 'denied')
  const result = await f.call()
  assert.equal(capability(result, 'overview.read').status, 'unavailable'); assert.equal(capability(result, 'life.read').reason, 'handler-unavailable')
  assert.equal(capability(result, 'fake.read'), undefined); assert.equal(capability(result, 'providers.probe').effect, 'write')
  assert.equal(capability(result, 'providers.probe').status, 'forbidden'); assert.equal(capability(result, 'simulation.group-read').effect, 'read')
  assert.deepEqual(capability(result, 'simulation.group-write').authorizedScopes, [agentConversationKey(f.rows[0])])
  assert.equal(f.handlerCalls(), 0)
})

test('retired execution retains loaded metadata and config state while sealing execution capabilities', async () => {
  const f = fixture()
  f.data.config = { ...f.data.config, storedRevision: 'stored-v2', requiresRestart: true, phase: 'restart-required' }
  const result = await f.call()
  assert.deepEqual(result.configState, f.data.config); assert.equal(result.agents[0].conversations[0].binding.revision, 'loaded-v1')
  const recoveryOperations = new Set(['observe.read', 'pipeline.read', 'host.readiness', 'host.restart'])
  for (const { operation, status } of result.capabilities) {
    if (['workspace.read', 'config-state.read'].includes(operation)) assert.equal(status, 'available', operation)
    else if (recoveryOperations.has(operation) || operation.startsWith('auth.')) assert.equal(status, 'unavailable', operation)
    else assert.equal(status, 'restart-required', operation)
  }
  assert.deepEqual(capability(result, 'simulation.group-write').authorizedScopes, [])
  assert.equal(f.calls.some(row => row.operation === 'providers.probe'), false)
})

test('complete directory guards reject additions, removals, unrelated row rebinds and resolve drift during authorization', async () => {
  for (const mutate of [
    f => { f.rows[0].revision = 'rebound' }, f => { f.rows.pop() }, f => { f.rows.push(binding(3)) },
    f => { f.options.bindings.resolve = () => undefined },
    f => { f.options.bindings.resolve = target => ({ ...f.rows.find(row => conversationAddressKey(row.target) === conversationAddressKey(target)), revision: 'resolve-rebound' }) },
    f => { f.rows[0].target = { ...f.rows[0].target, id: 'different-target-with-same-token' } },
  ]) {
    const f = fixture(), original = f.options.auth.authorize
    f.options.auth.authorize = async (...args) => {
      const result = await original(...args)
      if (args[1] === 'bindings.read' && args[2].target.account.id === 'account-2') { mutate(f); assert.equal(args[3].isCurrent(), false) }
      return result
    }
    await assert.rejects(f.call(), { code: 'conflict' })
  }
})

test('guards reject directory mutation in later capability checks and auth/host withdrawal before and after await', async () => {
  const later = fixture(), original = later.options.auth.authorize
  later.options.auth.authorize = async (...args) => { const result = await original(...args); if (args[1] === 'simulation.group-write') later.rows[0].revision = 'late-rebind'; return result }
  await assert.rejects(later.call(), { code: 'conflict' })
  for (const revoke of [f => f.revokeHost(), f => f.revokeAuth(), f => f.controller.abort()]) {
    for (const before of [true, false]) {
      const f = fixture()
      if (before) revoke(f)
      else f.options.auth.authorize = async () => { await Promise.resolve(); revoke(f); return 'allowed' }
      await assert.rejects(f.call(), { code: 'conflict' })
      if (before) assert.equal(f.calls.length, 0)
    }
  }
})

test('final projection rechecks configuration phase, revision, metadata and installed handler identities', async () => {
  for (const mutate of [
    f => { f.data.config = { ...f.data.config, storedRevision: 'new', phase: 'restart-required', requiresRestart: true } },
    f => { f.data.config.processEpoch = 'different-process' }, f => { f.data.agents[0].name = 'changed' },
    f => { f.data.connections[0].state = 'disconnected' }, f => { f.data.services[0].handle = async () => ({ kind: 'json', value: {} }) },
  ]) {
    const f = fixture(), original = f.options.auth.authorize; let changed = false
    f.options.auth.authorize = async (...args) => { const result = await original(...args); if (!changed) { changed = true; mutate(f) } return result }
    await assert.rejects(f.call(), { code: 'conflict' })
  }
  const f = fixture(); f.options.now = () => { f.data.config = { ...f.data.config, storedRevision: 'late', phase: 'uncertain', requiresRestart: true }; return 100 }
  await assert.rejects(f.call(), { code: 'conflict' })
})

test('authorization denial, exceptions and noncanonical decisions fail closed with fixed public diagnostics', async () => {
  for (const decision of ['denied', 'unavailable', false, undefined]) {
    const f = fixture(); f.options.auth.authorize = async () => decision
    await assert.rejects(f.call(), { code: decision === 'denied' ? 'forbidden' : 'unavailable' })
  }
  const f = fixture(), original = f.options.auth.authorize
  f.options.auth.authorize = async (...args) => { if (args[1] === 'overview.read') throw new Error('secret upstream error'); return original(...args) }
  const result = await f.call(); assert.equal(capability(result, 'overview.read').status, 'unavailable'); assert.equal(JSON.stringify(result).includes('secret upstream error'), false)
  f.options.auth.authorize = async (...args) => { if (args[1] === 'bindings.read') throw new Error('private'); return original(...args) }
  await assert.rejects(f.call(), { code: 'unavailable', message: 'unavailable' })
})

test('secret and runtime metadata are never projected and extra getters do not execute', async () => {
  const f = fixture(); let reads = 0
  for (const row of [f.data.agents[0], f.data.connections[0], f.data.config, f.rows[0], f.rows[0].target.account]) {
    row.token = 'secret-token'; row.url = 'https://secret.example'; row.environment = { PRIVATE: 'private-environment' }
    Object.defineProperty(row, 'prompt', { enumerable: true, get() { reads++; return 'private-prompt' } })
  }
  const result = await f.call(), serialized = JSON.stringify(result)
  assert.equal(reads, 0)
  for (const secret of ['secret-token', 'secret.example', 'private-environment', 'private-prompt']) assert.equal(serialized.includes(secret), false)
})

test('unsupported params/query/body, selectors, bytes and direct request accessors are rejected without authorization', async () => {
  const f = fixture()
  for (const request of [{ method: 'POST' }, { pathname: '/api/workspace/extra' }, { params: { id: 'x' } }, { query: { scopeKey: 'x' } },
    { body: { token: 'x' } }, { body: null }, { bytes: new Uint8Array() }, { contentType: 'text/plain' }, { unknown: true }]) await assert.rejects(f.call(request), { code: 'invalid_request' })
  await assert.rejects(f.call({}, { ...f.context, binding: f.rows[0] }), { code: 'invalid_request' })
  let reads = 0
  const request = { method: 'GET', pathname: '/api/workspace', params: {}, query: {}, body: {} }
  Object.defineProperty(request, 'method', { enumerable: true, get() { reads++; return 'GET' } })
  await assert.rejects(f.service.handle(request, f.context), { code: 'invalid_request' })
  assert.equal(reads, 0); assert.equal(f.calls.length, 0)
})

test('metadata proxies, accessors, sparse arrays and inherited required fields are rejected without executing traps', async () => {
  let traps = 0
  const getter = { enumerable: true, get() { traps++; throw new Error('must not execute') } }
  for (const mutate of [
    f => { f.data.agents = new Proxy([], { get() { traps++; throw new Error('must not execute') } }) },
    f => { f.data.agents[0] = new Proxy(f.data.agents[0], { getOwnPropertyDescriptor() { traps++; throw new Error('must not execute') } }) },
    f => { Object.defineProperty(f.rows[0], 'revision', getter) },
    f => { Object.defineProperty(f.rows[0].target.account, 'id', getter) },
    f => { Object.defineProperty(f.data.connections[0].capabilities, '0', getter) },
    f => { Object.defineProperty(f.data.services[0], 'handle', getter) },
    f => { Object.defineProperty(f.data.config, 'phase', getter) },
    f => { delete f.data.agents[0] },
    f => { const agent = f.data.agents[0]; f.data.agents[0] = Object.create(agent) },
  ]) { const f = fixture(); mutate(f); await assert.rejects(f.call(), { code: 'unavailable' }) }
  assert.equal(traps, 0)
})

test('directory projections reject duplicate scopes and malformed or excessive metadata before authorizing', async () => {
  for (const [mutate, code] of [
    [f => { f.rows.push(structuredClone(f.rows[0])) }, 'conflict'],
    [f => { f.data.agents.push({ ...f.data.agents[0] }) }, 'conflict'],
    [f => { f.data.connections.push({ ...f.data.connections[0] }) }, 'conflict'],
    [f => { f.rows[0].revision = 'v'.repeat(4097) }, 'unavailable'],
    [f => { f.rows[0].agentId = 'bad/id' }, 'unavailable'],
    [f => { f.data.connections[0].state = 'pretending' }, 'unavailable'],
    [f => { f.data.agents[0].name = 'n'.repeat(257) }, 'unavailable'],
    [f => { f.data.agents.length = 257 }, 'unavailable'],
    [f => { f.rows.length = 257 }, 'unavailable'],
    [f => { f.data.services.length = 129 }, 'unavailable'],
    [f => { f.data.connections[0].capabilities.length = 65 }, 'unavailable'],
    [f => { f.data.config.requiresRestart = false; f.data.config.storedRevision = 'different' }, 'conflict'],
  ]) { const f = fixture(); mutate(f); await assert.rejects(f.call(), { code }); assert.equal(f.calls.length, 0) }
})

test('serialized response has a hard bound and revision is stable for identical visible content', async () => {
  const f = fixture(), first = await f.call(), second = await f.call()
  assert.notEqual(first.observedAt, second.observedAt); assert.equal(first.revision, second.revision)
  f.decisions.set('bindings.read:account-2', 'denied')
  assert.notEqual((await f.call()).revision, first.revision)
  const large = fixture(); large.rows.length = 0; large.data.agents = []
  large.data.connections = Array.from({ length: 256 }, (_, index) => ({ id: `connection-${index}`, account: { platform: 'qq', namespace: 'global', id: `account-${index}` }, state: 'unknown',
    capabilities: Array.from({ length: 64 }, (_, capability) => `${capability}:` + 'x'.repeat(120)) }))
  await assert.rejects(large.call(), { code: 'unavailable' })
  assert.equal(large.calls.length < 128, true)
})

test('the full supported 256-binding directory fits the authorization budget with every real handler installed', async () => {
  const f = fixture()
  f.rows.splice(0, f.rows.length, ...Array.from({ length: 256 }, (_, index) => ({ ...binding(1), id: `binding-${index}`, target: { ...binding(1).target, id: `group-${index}` } })))
  const byAddress = new Map(f.rows.map(row => [conversationAddressKey(row.target), row]))
  f.options.bindings.resolve = target => byAddress.get(conversationAddressKey(target))
  f.data.services = AGENT_CONSOLE_SERVICES.map(row => ({ ...row, handle: row.operation === 'workspace.read' ? f.service.handle : async () => assert.fail('metadata never dispatches handlers') }))
  const result = await f.call()
  assert.equal(result.agents[0].conversations.length, 256); assert.equal(result.connections[0].conversationCount, 256)
  const conversationDefinitions = AGENT_CONSOLE_SERVICES.filter(row => row.scope === 'conversation')
  for (const row of conversationDefinitions) assert.equal(capability(result, row.operation).authorizedScopes.length, 256)
  const expected = 1 + 256 + 2 + AGENT_CONSOLE_SERVICES.filter(row => row.scope === 'global').length + 256 * conversationDefinitions.length
  assert.equal(f.calls.length, expected)
  assert.equal(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024, true)
})
