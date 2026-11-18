import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createSimulationAdministration, SimulationAdministrationConflictError }, { createScopedStateStore },
  { createCharacterStore }, { createEmptyCharacterState, characterKey }] = await Promise.all([
  load('modules/simulation/infrastructure/simulationAdministration.js'), load('modules/simulation/infrastructure/scopedStateStore.js'),
  load('modules/simulation/infrastructure/characterStore.js'), load('modules/simulation/domain/characterState.js'),
])
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function request(beforeWrite) {
  let active = true
  const controller = new AbortController(), isCurrent = () => active && !controller.signal.aborted
  return { guard: { signal: controller.signal, isCurrent, ensureCurrent() { if (!isCurrent()) throw new SimulationAdministrationConflictError() }, ...(beforeWrite ? { beforeWrite } : {}) },
    revoke() { active = false }, controller }
}
function memory({ evalEnabled = true, onGet, onSet } = {}) {
  const values = new Map(), calls = []
  const redis = {
    async get(key) { calls.push(['get', key]); await onGet?.(key); return values.get(key) ?? null },
    async set(key, value, options) {
      calls.push(['set', key, value, options])
      if (options?.NX && values.has(key)) return null
      values.set(key, value); await onSet?.(key, value, options); return 'OK'
    },
    async del(...keys) { calls.push(['del', ...keys]); return keys.reduce((n, key) => n + Number(values.delete(key)), 0) },
    async keys() { calls.push(['keys']); return [...values.keys()] },
    ...(evalEnabled ? { async eval(script, { keys, arguments: args }) {
      calls.push(['eval', script, [...keys], [...args]])
      if (script === RELEASE) {
        if (values.get(keys[0]) !== args[0]) return 0
        return Number(values.delete(keys[0]))
      }
      if (script.includes('KEYS[2]') && script.includes('ARGV[2]') && script.includes('~= ARGV[1]')) {
        if (values.get(keys[0]) !== args[0]) return 0
        values.set(keys[1], args[1]); values.delete(keys[0]); return 1
      }
      throw Error('unrecognized fixture Lua')
    } } : {}),
  }
  return { redis, calls, values }
}

test('all actual Redis mutations reauthorize and recheck after awaited authorization; reads recheck after completion', async () => {
  const authorized = gate(), entered = gate(), f = memory(), admin = createSimulationAdministration(f.redis)
  const r = request(async () => { entered.resolve(); await authorized.promise })
  const write = admin.run(r.guard, () => admin.redis.set('state', 'value'))
  await entered.promise; r.revoke(); authorized.resolve()
  await assert.rejects(write, SimulationAdministrationConflictError)
  assert.deepEqual(f.calls, [])
  let checked = 0
  const valid = request(async () => { checked++ })
  await admin.run(valid.guard, async () => {
    await admin.redis.set('state', 'value')
    await admin.redis.del('state')
    await admin.redis.eval(RELEASE, { keys: ['unowned:lock'], arguments: ['no-token'] })
    await admin.redis.keys('*')
  })
  assert.equal(checked, 3)
  const readGate = gate(), readEntered = gate(), readRequest = request()
  const blocked = memory({ onGet: async () => { readEntered.resolve(); await readGate.promise } }), reads = createSimulationAdministration(blocked.redis)
  const reading = reads.run(readRequest.guard, () => reads.redis.get('state'))
  await readEntered.promise; readRequest.revoke(); readGate.resolve()
  await assert.rejects(reading, SimulationAdministrationConflictError)
})

test('completed leases reject delayed children while explicitly detached background writes remain independent', async () => {
  const f = memory(), admin = createSimulationAdministration(f.redis), r = request(), release = gate()
  let late, background
  await admin.run(r.guard, async () => {
    late = release.promise.then(() => admin.redis.set('late', 'forbidden')).catch(error => error)
    background = admin.background(() => release.promise.then(() => admin.redis.set('background', 'normal')))
  })
  // Completion alone revokes the lease, even if the HTTP guard still reports current.
  assert.equal(r.guard.isCurrent(), true)
  release.resolve()
  assert.ok(await late instanceof SimulationAdministrationConflictError)
  assert.equal(await background, 'OK')
  assert.equal(f.values.has('late'), false); assert.equal(f.values.get('background'), 'normal')
})

test('a swallowed guard failure permanently revokes the administration lease even if an external predicate later recovers', async () => {
  let current = true
  const f = memory({ onGet() { current = false } }), admin = createSimulationAdministration(f.redis)
  const guard = { signal: new AbortController().signal, isCurrent: () => current, ensureCurrent() {} }
  await assert.rejects(admin.run(guard, async () => {
    await admin.redis.get('state').catch(() => { current = true })
    await admin.redis.set('revived', 'forbidden')
  }), SimulationAdministrationConflictError)
  assert.equal(current, true); assert.equal(f.values.has('revived'), false)
})

test('administration queue retains each request lease and rejects a revoked queued request before its callback', async () => {
  const f = memory(), admin = createSimulationAdministration(f.redis), first = request(), second = request(), release = gate(), entered = gate()
  let secondRan = false
  const one = admin.run(first.guard, async () => { entered.resolve(); await release.promise; await admin.redis.set('first', 'ok') })
  await entered.promise
  const two = admin.run(second.guard, async () => { secondRan = true; await admin.redis.set('second', 'bad') })
  const caught = two.catch(error => error)
  second.revoke(); release.resolve(); await one
  assert.ok(await caught instanceof SimulationAdministrationConflictError)
  assert.equal(secondRan, false); assert.equal(f.values.has('second'), false)
  assert.equal(createSimulationAdministration(f.redis), admin)
  assert.equal(createSimulationAdministration(admin.redis), admin)
  await admin.run(request().guard, async () => {
    await assert.rejects(admin.run(request().guard, async () => undefined), SimulationAdministrationConflictError)
  })
})

test('store queues preserve the requesting lease until the actual fallback SET boundary', async () => {
  const release = gate(), entered = gate(), f = memory({ evalEnabled: false, onGet: async () => { entered.resolve(); await release.promise } })
  const admin = createSimulationAdministration(f.redis), r = request()
  const state = createScopedStateStore({ redis: admin.redis, key: 'queued', empty: () => ({ value: 0 }), validate: value => value })
  const background = state.update(value => ({ value: value.value + 1 }))
  await entered.promise
  const queued = admin.run(r.guard, () => state.update(value => ({ value: value.value + 10 }))).catch(error => error)
  await nextTurn(); r.revoke(); release.resolve(); await background
  assert.ok(await queued instanceof SimulationAdministrationConflictError)
  assert.deepEqual(JSON.parse(f.values.get('queued')), { value: 1 })
  assert.equal(f.calls.filter(row => row[0] === 'set').length, 1)
})

test('revoked character and scoped CAS operations release only their own exact token lock', async () => {
  for (const kind of ['character', 'scoped']) {
    const release = gate(), entered = gate(), r = request()
    const f = memory({ onGet: async key => { if (!key.endsWith(':lock')) { entered.resolve(); await release.promise } } })
    const admin = createSimulationAdministration(f.redis), scope = { botId: '23000101', personaId: 'daily', groupId: '310901' }
    const key = kind === 'character' ? characterKey(scope) : 'workspace'
    f.values.set(key, JSON.stringify(kind === 'character' ? createEmptyCharacterState(scope) : { value: 0 }))
    const store = kind === 'character' ? createCharacterStore({ redis: admin.redis }) :
      createScopedStateStore({ redis: admin.redis, key, empty: () => ({ value: 0 }), validate: value => value })
    const write = admin.run(r.guard, () => kind === 'character' ? store.update(scope, value => ({ ...value, paused: true })) : store.update(value => ({ ...value, value: 1 })))
    await entered.promise; r.revoke(); release.resolve()
    await assert.rejects(write, SimulationAdministrationConflictError)
    assert.equal(f.values.has(`${key}:lock`), false, kind)
    const scripts = f.calls.filter(row => row[0] === 'eval')
    assert.equal(scripts.length, 1, kind); assert.equal(scripts[0][1], RELEASE)
    const after = JSON.parse(f.values.get(key)); assert.equal(kind === 'character' ? after.paused : after.value, kind === 'character' ? false : 0)
  }
})

test('revocation after an in-flight lock SET still cleans up before the store can observe acquisition', async () => {
  const release = gate(), entered = gate(), r = request()
  const f = memory({ onSet: async (key, _value, options) => { if (options?.NX) { entered.resolve(); await release.promise } } })
  const admin = createSimulationAdministration(f.redis)
  const store = createScopedStateStore({ redis: admin.redis, key: 'inflight', empty: () => ({ value: 0 }), validate: value => value })
  const write = admin.run(r.guard, () => store.update(() => ({ value: 1 })))
  await entered.promise; r.revoke(); release.resolve()
  await assert.rejects(write, SimulationAdministrationConflictError)
  assert.equal(f.values.has('inflight:lock'), false); assert.equal(f.values.has('inflight'), false)
  assert.equal(f.calls.filter(row => row[0] === 'eval' && row[1] === RELEASE).length, 1)
})

test('cleanup exemption rejects other tokens, other keys, edited scripts and direct deletes after revocation', async () => {
  const f = memory(), admin = createSimulationAdministration(f.redis), r = request()
  await assert.rejects(admin.run(r.guard, async () => {
    await admin.redis.set('owned:lock', 'token-a', { NX: true, PX: 10_000 })
    f.values.set('foreign:lock', 'token-b'); r.revoke()
    for (const action of [
      () => admin.redis.eval(RELEASE, { keys: ['owned:lock'], arguments: ['token-b'] }),
      () => admin.redis.eval(RELEASE, { keys: ['foreign:lock'], arguments: ['token-b'] }),
      () => admin.redis.eval(RELEASE + ' ', { keys: ['owned:lock'], arguments: ['token-a'] }),
      () => admin.redis.del('owned:lock'),
    ]) await assert.rejects(action(), SimulationAdministrationConflictError)
    assert.equal(await admin.redis.eval(RELEASE, { keys: ['owned:lock'], arguments: ['token-a'] }), 1)
  }), SimulationAdministrationConflictError)
  assert.equal(f.values.has('owned:lock'), false); assert.equal(f.values.get('foreign:lock'), 'token-b')
  assert.equal(f.calls.filter(row => row[0] === 'eval').length, 1)
})
