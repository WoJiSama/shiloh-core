import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createStandaloneAgentConsoleManagement }, { AgentManagementError }, { AgentConsoleError },
  { agentConversationKey, agentBindingToken }] = await Promise.all([
  load('bootstrap/standaloneAgentConsoleManagement.js'), load('contracts/agentManagement.js'),
  load('contracts/agentConsole.js'), load('modules/runtime/domain/agentBindings.js'),
])
const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')

function binding(account = '23000101') {
  return { source: 'configured', id: `binding-${account}`, revision: 'v7', agentId: 'daily', personaId: 'self', connectionId: `qq-${account}`,
    target: { account: { platform: 'qq', namespace: 'production', id: account }, kind: 'group', id: '310901' } }
}
function guard() {
  const controller = new AbortController()
  let active = true
  const isCurrent = () => active && !controller.signal.aborted
  return { signal: controller.signal, isCurrent, ensureCurrent() { if (!isCurrent()) throw new AgentConsoleError('conflict') },
    revoke() { active = false }, abort() { controller.abort() } }
}
function fixture(overrides = {}, selected = binding()) {
  const request = guard(), calls = [], authorizations = [], principal = { id: 'operator', username: 'admin', via: 'session' }
  let sessionCurrent = true
  const management = { profiles: {}, trusteeship: {}, ...overrides }
  for (const [section, methods] of [['profiles', ['list', 'remove', 'removeField']],
    ['trusteeship', ['overview', 'cancelCommitment', 'deleteDelegated', 'clearFailLog']]]) {
    for (const method of methods) management[section][method] ??= async (...args) => {
      calls.push({ section, method, args }); args.at(-1).ensureCurrent()
      return method === 'list' ? [] : method === 'overview' ? { commitments: [], delegated: [], failures: [] } : true
    }
  }
  const context = { ...request, principal, ...(selected ? { binding: selected } : {}),
    cookie: 'private-session-cookie', token: 'private-console-token', moduleContext: { native: 'host-only' } }
  const auth = { isCurrent(actor) { assert.equal(actor, principal); return sessionCurrent },
    async authorize(actor, operation, selectedBinding, authority) {
      authorizations.push({ actor, operation, binding: selectedBinding, guard: authority })
      authority.ensureCurrent(); return 'allowed'
    } }
  const adapter = createStandaloneAgentConsoleManagement({ management, auth })
  return { adapter, management, context, principal, auth, request, calls, authorizations,
    revokeSession() { sessionCurrent = false } }
}
const rejectsConflict = promise => assert.rejects(promise, error => error instanceof AgentConsoleError && error.code === 'conflict')

test('neutral management checks each owned parent once and preserves every awaited boundary', async () => {
  let checks = 0
  const f = fixture({ profiles: { async list(context) { context.ensureCurrent(); return [] } } })
  const parent = createSynchronousGuard(f.request.signal, () => { checks++; f.request.ensureCurrent() }, () => { throw new AgentConsoleError('conflict') })
  assert.deepEqual(await f.adapter.profiles.list({ ...f.context, ...parent }), [])
  assert.equal(checks, 3, 'dispatch, module check and awaited return must each perform one fresh parent observation')
})

test('a session observer may read a paired neutral guard without revoking its current authority', async () => {
  let captured, busy = false
  const observations = [], f = fixture({ profiles: { async list(context) {
    captured = context; context.ensureCurrent(); return []
  } } })
  f.auth.isCurrent = actor => {
    assert.equal(actor, f.principal)
    if (captured && !busy) {
      busy = true
      try { observations.push(captured.isCurrent()) } finally { busy = false }
    }
    return true
  }
  const parent = createSynchronousGuard(f.request.signal, f.request.ensureCurrent, () => { throw new AgentConsoleError('conflict') })
  assert.deepEqual(await f.adapter.profiles.list({ ...f.context, ...parent }), [])
  assert.deepEqual(observations, [true, true])
})

test('neutral foreign current preserves its boolean-only contract while ensure retains stronger checks', async () => {
  let blocked = false
  const f = fixture({ profiles: { async list(context) {
    blocked = true
    assert.equal(context.isCurrent(), true)
    assert.throws(context.ensureCurrent, { code: 'conflict' })
    blocked = false
    return []
  } } })
  f.context.ensureCurrent = () => { if (blocked) throw new AgentConsoleError('conflict'); f.request.ensureCurrent() }
  assert.deepEqual(await f.adapter.profiles.list(f.context), [])
})

test('a foreign ensure may audit the neutral current without causing recursive ensure calls', async () => {
  let captured
  const observations = [], f = fixture({ profiles: { async list(context) {
    captured = context; context.ensureCurrent(); return []
  } } })
  f.context.ensureCurrent = () => {
    if (captured) observations.push(captured.isCurrent())
    f.request.ensureCurrent()
  }
  assert.deepEqual(await f.adapter.profiles.list(f.context), [])
  assert.deepEqual(observations, [true, true])
})

test('a foreign child ensure may audit its scoped current with either an owned or foreign owner', async () => {
  for (const ownParent of [false, true]) {
    let captured
    const observations = [], selected = guard()
    const f = fixture({ profiles: { async list(context) {
      assert.equal(await context.authorize('profiles.read', binding(), selected), 'allowed')
      return []
    } } })
    selected.ensureCurrent = () => { if (captured) observations.push(captured.isCurrent()) }
    f.auth.authorize = async (_principal, _operation, _binding, scope) => {
      captured = scope; scope.ensureCurrent(); return 'allowed'
    }
    const context = ownParent ? { ...f.context, ...createSynchronousGuard(f.request.signal, f.request.ensureCurrent, () => { throw new AgentConsoleError('conflict') }) } : f.context
    assert.deepEqual(await f.adapter.profiles.list(context), [], String(ownParent))
    assert.deepEqual(observations, [true, true], String(ownParent))
  }
})

test('an optimized neutral owner rejects a replacement by another valid owned tuple', async () => {
  const f = fixture({ profiles: { async list(context) {
    Object.assign(parent, createSynchronousGuard(f.request.signal, () => {}, () => { throw new AgentConsoleError('conflict') }))
    assert.equal(context.isCurrent(), false)
    context.ensureCurrent()
    assert.fail('replacement must stop dispatch')
  } } })
  const parent = { ...f.context, ...createSynchronousGuard(f.request.signal, () => {}, () => { throw new AgentConsoleError('conflict') }) }
  await rejectsConflict(f.adapter.profiles.list(parent))
})

test('optimized scoped guards reject a child replaced by another valid owned tuple during authorization', async () => {
  const fail = () => { throw new AgentConsoleError('conflict') }, signal = new AbortController().signal
  const selected = { ...createSynchronousGuard(signal, () => {}, fail) }
  const f = fixture({ profiles: { async list(context) {
    await context.authorize('profiles.read', binding(), selected)
    assert.fail('replacement must stop authorization')
  } } })
  f.auth.authorize = async (_principal, _operation, _binding, scoped) => {
    Object.assign(selected, createSynchronousGuard(signal, () => {}, fail))
    assert.equal(scoped.isCurrent(), false)
    return 'allowed'
  }
  await rejectsConflict(f.adapter.profiles.list({ ...f.context, ...createSynchronousGuard(f.request.signal, () => {}, fail) }))
})

test('the management adapter forwards every operation with a neutral context and complete selected binding', async () => {
  const f = fixture(), key = agentConversationKey(f.context.binding)
  assert.deepEqual(await f.adapter.profiles.list(f.context), [])
  assert.equal(await f.adapter.profiles.remove('user-1', f.context), true)
  assert.equal(await f.adapter.profiles.removeField('user-1', 'likes', 'coffee', f.context), true)
  assert.deepEqual(await f.adapter.trusteeship.overview(f.context), { commitments: [], delegated: [], failures: [] })
  assert.equal(await f.adapter.trusteeship.cancelCommitment(key, 'commitment-1', f.context), true)
  assert.equal(await f.adapter.trusteeship.deleteDelegated(key, 'memory-1', f.context), true)
  assert.equal(await f.adapter.trusteeship.clearFailLog(f.context), true)
  assert.deepEqual(f.calls.map(({ section, method, args }) => [section, method, args.slice(0, -1)]), [
    ['profiles', 'list', []], ['profiles', 'remove', ['user-1']], ['profiles', 'removeField', ['user-1', 'likes', 'coffee']],
    ['trusteeship', 'overview', []], ['trusteeship', 'cancelCommitment', [key, 'commitment-1']],
    ['trusteeship', 'deleteDelegated', [key, 'memory-1']], ['trusteeship', 'clearFailLog', []],
  ])
  for (const { args } of f.calls) {
    const context = args.at(-1)
    assert.deepEqual(Object.keys(context).sort(), ['authorize', 'binding', 'ensureCurrent', 'isCurrent', 'signal'])
    assert.equal(context.binding, f.context.binding); assert.equal(context.signal, f.request.signal)
    assert.equal(context.isCurrent(), true); assert.equal(JSON.stringify(context).includes('private-'), false)
    assert.equal(Object.hasOwn(context, 'principal'), false); assert.equal(Object.hasOwn(context, 'moduleContext'), false)
  }
})

test('management authorization keeps principals at the host and preserves denied and unavailable decisions', async () => {
  for (const decision of ['allowed', 'denied', 'unavailable']) {
    let captured
    const f = fixture({ profiles: { async list(context) {
      captured = context
      return [{ decision: await context.authorize('profiles.read', binding('23000102'), guard()) }]
    } } })
    const original = f.auth.authorize
    f.auth.authorize = async (...args) => { await original(...args); return decision }
    assert.deepEqual(await f.adapter.profiles.list(f.context), [{ decision }])
    assert.equal(f.authorizations.length, 1); assert.equal(f.authorizations[0].actor, f.principal)
    assert.equal(f.authorizations[0].operation, 'profiles.read')
    assert.deepEqual(f.authorizations[0].binding, binding('23000102'))
    assert.notEqual(f.authorizations[0].guard, captured)
    assert.deepEqual(Object.keys(f.authorizations[0].guard).sort(), ['ensureCurrent', 'isCurrent', 'signal'])
  }
})

test('aggregate management receives no selected binding and must authorize each complete conversation', async () => {
  let captured
  const bindings = [binding(), binding('23000102')]
  const f = fixture({ profiles: { async list(context) {
    captured = context
    const rows = []
    for (const selected of bindings) {
      const decision = await context.authorize('profiles.read', selected, guard())
      if (decision === 'allowed') rows.push({ binding: selected, profile: { userId: 'same-user' } })
    }
    return rows
  } } }, null)
  assert.deepEqual((await f.adapter.profiles.list(f.context)).map(row => row.binding), bindings)
  assert.equal(Object.hasOwn(captured, 'binding'), false); assert.equal(Object.hasOwn(captured, 'principal'), false)
  assert.deepEqual(f.authorizations.map(row => row.binding), bindings)
  assert.equal(f.authorizations.every(row => row.actor === f.principal), true)
})

test('equal group IDs on different accounts retain distinct full bindings and authorization targets', async () => {
  const selected = [binding(), binding('23000102')], seen = []
  for (const item of selected) {
    const f = fixture({ profiles: { async remove(userId, context) {
      await context.authorize('profiles.delete', context.binding, context)
      seen.push({ userId, binding: context.binding, authorization: f.authorizations[0].binding })
      return true
    } } }, item)
    assert.equal(await f.adapter.profiles.remove('same-user', f.context), true)
  }
  assert.equal(selected[0].target.id, selected[1].target.id)
  assert.notEqual(agentConversationKey(selected[0]), agentConversationKey(selected[1]))
  assert.notEqual(agentBindingToken(selected[0]), agentBindingToken(selected[1]))
  for (let index = 0; index < selected.length; index++) {
    assert.deepEqual(seen[index], { userId: 'same-user', binding: selected[index], authorization: selected[index] })
  }
})

test('revoked request, session and binding guards prevent management dispatch and authorization', async () => {
  for (const revoke of ['request', 'session', 'abort', 'auth-throws']) {
    const f = fixture()
    if (revoke === 'request') f.request.revoke()
    if (revoke === 'session') f.revokeSession()
    if (revoke === 'abort') f.request.abort()
    if (revoke === 'auth-throws') f.auth.isCurrent = () => { throw new Error('private auth failure') }
    await rejectsConflict(f.adapter.profiles.list(f.context))
    assert.equal(f.calls.length, 0); assert.equal(f.authorizations.length, 0)
  }
  const selectedGuard = guard(); selectedGuard.revoke()
  const f = fixture({ trusteeship: { async overview(context) {
    await context.authorize('trusteeship.read', binding(), selectedGuard)
    assert.fail('revoked binding must not reach storage')
  } } })
  await rejectsConflict(f.adapter.trusteeship.overview(f.context)); assert.equal(f.authorizations.length, 0)
})

test('authorization rechecks request, session and selected binding after its awaited result', async () => {
  for (const revoke of ['request', 'session', 'abort', 'binding']) {
    const selectedGuard = guard()
    let storageReads = 0
    const f = fixture({ profiles: { async list(context) {
      await context.authorize('profiles.read', binding(), selectedGuard)
      storageReads++; return []
    } } })
    f.auth.authorize = async (_principal, _operation, _binding, authority) => {
      authority.ensureCurrent(); await Promise.resolve()
      if (revoke === 'request') f.request.revoke()
      if (revoke === 'session') f.revokeSession()
      if (revoke === 'abort') f.request.abort()
      if (revoke === 'binding') selectedGuard.revoke()
      assert.equal(authority.isCurrent(), false)
      assert.throws(() => authority.ensureCurrent(), { code: 'conflict' })
      return 'allowed'
    }
    await rejectsConflict(f.adapter.profiles.list(f.context)); assert.equal(storageReads, 0, revoke)
  }
})

test('results are withheld after module awaits and a completed request cannot reuse its neutral context', async () => {
  for (const revoke of ['request', 'session', 'abort']) {
    const f = fixture({ trusteeship: { async overview() {
      await Promise.resolve()
      if (revoke === 'request') f.request.revoke()
      if (revoke === 'session') f.revokeSession()
      if (revoke === 'abort') f.request.abort()
      return { commitments: [{ id: 'must-not-return' }] }
    } } })
    await rejectsConflict(f.adapter.trusteeship.overview(f.context))
  }
  let captured
  const f = fixture({ profiles: { async list(context) { captured = context; return [] } } })
  await f.adapter.profiles.list(f.context)
  f.request.abort()
  assert.equal(captured.isCurrent(), false); assert.throws(() => captured.ensureCurrent(), { code: 'conflict' })
  await rejectsConflict(captured.authorize('profiles.read', binding(), guard()))
  assert.equal(f.authorizations.length, 0)
})

test('management failures map to fixed console error codes and unexpected errors remain failures', async () => {
  for (const code of ['forbidden', 'conflict', 'unavailable', 'invalid_request', 'not_found']) {
    const f = fixture({ profiles: { async remove() { throw new AgentManagementError(code) } } })
    await assert.rejects(f.adapter.profiles.remove('user-1', f.context), error =>
      error instanceof AgentConsoleError && error.code === code && error.message === code)
  }
  const upstream = new Error('private upstream credential')
  const f = fixture({ trusteeship: { async clearFailLog() { throw upstream } } })
  await assert.rejects(f.adapter.trusteeship.clearFailLog(f.context), error => error === upstream)
})
