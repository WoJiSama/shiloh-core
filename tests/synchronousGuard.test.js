import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { captureSynchronousGuardCheck, createSynchronousGuard, ensureSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
const fail = () => { throw new Error('guard-conflict') }
const conflict = { message: 'guard-conflict' }

test('an owned method pair runs its one fresh validator for every call and preserves copied contexts', async () => {
  const controller = new AbortController()
  let calls = 0, current = true
  const guard = createSynchronousGuard(controller.signal, () => { calls++; if (!current) fail() }, fail)
  const context = { ...guard, principal: { id: 'host-only' } }
  ensureSynchronousGuard(context, fail); assert.equal(calls, 1)
  assert.equal(guard.isCurrent(), true); assert.equal(calls, 2)
  guard.ensureCurrent(); assert.equal(calls, 3)
  ensureSynchronousGuard(context, fail, 'current-first'); assert.equal(calls, 4)
  await Promise.resolve()
  current = false
  assert.equal(guard.isCurrent(), false); assert.equal(calls, 5)
  assert.throws(() => ensureSynchronousGuard(context, fail), conflict); assert.equal(calls, 6)
  current = true
  ensureSynchronousGuard(context, fail); assert.equal(calls, 7, 'failure does not cache a result either')
})

test('owned validation checks cancellation before and after its synchronous callback', () => {
  const before = new AbortController(), after = new AbortController()
  let calls = 0
  before.abort()
  const first = createSynchronousGuard(before.signal, () => { calls++ }, fail)
  assert.equal(first.isCurrent(), false); assert.throws(first.ensureCurrent, conflict); assert.equal(calls, 0)
  const second = createSynchronousGuard(after.signal, () => { calls++; after.abort() }, fail)
  assert.equal(second.isCurrent(), false); assert.equal(calls, 1)
  assert.throws(() => ensureSynchronousGuard(second, fail), conflict); assert.equal(calls, 1)
})

test('a thrown validator is false for current and remains a failure for ensure', () => {
  const error = new Error('validator-failure')
  const guard = createSynchronousGuard(new AbortController().signal, () => { throw error }, fail)
  assert.equal(guard.isCurrent(), false)
  assert.throws(guard.ensureCurrent, value => value === error)
})

test('async, object thenable and function thenable validators cannot grant authority', () => {
  for (const check of [async () => {}, () => Promise.resolve(), () => ({ then() {} }), () => Object.assign(() => {}, { then() {} })]) {
    const guard = createSynchronousGuard(new AbortController().signal, check, fail)
    assert.equal(guard.isCurrent(), false)
    assert.throws(guard.ensureCurrent, conflict)
    assert.throws(() => ensureSynchronousGuard(guard, fail), conflict)
  }
})

test('rejected native Promises fail synchronously without leaving unhandled rejections', async () => {
  let overriddenCalls = 0
  const check = () => {
    const value = Promise.reject(new Error('async validator failed'))
    value.then = () => { overriddenCalls++; throw new Error('overridden then must not run') }
    return value
  }
  const signal = new AbortController().signal, guard = createSynchronousGuard(signal, check, fail)
  assert.equal(guard.isCurrent(), false)
  assert.throws(guard.ensureCurrent, conflict)
  assert.throws(() => ensureSynchronousGuard({ signal, isCurrent: () => true, ensureCurrent: check }, fail), conflict)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(overriddenCalls, 0)
})

test('untrusted thenable callbacks are never invoked when rejecting async authority', () => {
  let calls = 0
  const signal = new AbortController().signal, check = () => ({ then() { calls++; throw new Error('untrusted then') } })
  const guard = createSynchronousGuard(signal, check, fail)
  assert.equal(guard.isCurrent(), false)
  assert.throws(guard.ensureCurrent, conflict)
  assert.throws(() => ensureSynchronousGuard({ signal, isCurrent: () => true, ensureCurrent: check }, fail), conflict)
  assert.equal(calls, 0)
})

test('finite reentrant observers run a complete fresh validator and retain current authority', () => {
  let guard, busy = false, calls = 0
  const observations = []
  guard = createSynchronousGuard(new AbortController().signal, () => {
    calls++
    if (!busy) {
      busy = true
      try { observations.push(guard.isCurrent()) } finally { busy = false }
    }
  }, fail)
  assert.equal(guard.isCurrent(), true); assert.equal(calls, 2)
  guard.ensureCurrent(); assert.equal(calls, 4)
  ensureSynchronousGuard({ ...guard }, fail); assert.equal(calls, 6)
  assert.deepEqual(observations, [true, true, true])
})

test('an observer cannot conceal revocation or cancellation after its fresh authority read', () => {
  for (const change of ['revoke', 'abort']) {
    for (const entry of ['current', 'ensure']) {
      const controller = new AbortController(), observations = []
      let guard, busy = false, current = true, calls = 0
      guard = createSynchronousGuard(controller.signal, () => {
        calls++
        if (!current) fail()
        if (!busy) {
          busy = true
          try { observations.push(guard.isCurrent()) } finally { busy = false }
          if (change === 'revoke') current = false
          else controller.abort()
        }
        if (!current) fail()
      }, fail)
      if (entry === 'current') assert.equal(guard.isCurrent(), false, change)
      else assert.throws(guard.ensureCurrent, conflict, change)
      assert.deepEqual(observations, [true], `${change}: ${entry}`)
      assert.equal(calls, 2, `${change}: ${entry}`)
      assert.equal(guard.isCurrent(), false, `${change}: later observation`)
    }
  }
})

test('a reentrant throwing check propagates through ensure and failed observations are never cached', () => {
  const error = new Error('nested-validator-failure')
  let guard, busy = false, rejectNested = true, calls = 0
  guard = createSynchronousGuard(new AbortController().signal, () => {
    calls++
    if (busy) {
      if (rejectNested) throw error
      return
    }
    busy = true
    try { guard.ensureCurrent() } finally { busy = false }
  }, fail)
  assert.throws(guard.ensureCurrent, value => value === error); assert.equal(calls, 2)
  assert.equal(guard.isCurrent(), false); assert.equal(calls, 4)
  rejectNested = false
  guard.ensureCurrent(); assert.equal(calls, 6)
  assert.equal(guard.isCurrent(), true); assert.equal(calls, 8)
})

test('captured tuple replacement after a reentrant observation still revokes the original capture', () => {
  const signal = new AbortController().signal, observations = []
  let copy, busy = false, calls = 0, replacementCalls = 0
  const replacement = createSynchronousGuard(signal, () => { replacementCalls++ }, fail)
  const original = createSynchronousGuard(signal, () => {
    calls++
    if (!busy) {
      busy = true
      try { observations.push(copy.isCurrent()) } finally { busy = false }
      Object.assign(copy, replacement)
    }
  }, fail)
  copy = { ...original }
  const check = captureSynchronousGuardCheck(copy, fail)
  assert.throws(check, conflict)
  assert.deepEqual(observations, [true]); assert.equal(calls, 2)
  assert.throws(check, conflict)
  assert.equal(calls, 2); assert.equal(replacementCalls, 0)
})

test('foreign guards preserve stronger ensure and the ensure-first call order with their receiver', () => {
  const events = [], controller = new AbortController()
  const foreign = { signal: controller.signal,
    isCurrent() { assert.equal(this, foreign); events.push('current'); return true },
    ensureCurrent() { assert.equal(this, foreign); events.push('ensure') } }
  ensureSynchronousGuard(foreign, fail)
  assert.deepEqual(events, ['ensure', 'current'])
  foreign.ensureCurrent = () => { throw new Error('stronger-ensure') }
  assert.throws(() => ensureSynchronousGuard(foreign, fail), { message: 'stronger-ensure' })
})

test('foreign current-first does not invoke ensure for an already revoked guard and rechecks afterward', () => {
  const events = [], controller = new AbortController()
  let current = false
  const foreign = { signal: controller.signal,
    isCurrent() { events.push('current'); return current },
    ensureCurrent() { events.push('ensure'); current = false } }
  assert.throws(() => ensureSynchronousGuard(foreign, fail, 'current-first'), conflict)
  assert.deepEqual(events, ['current'])
  events.length = 0; current = true
  assert.throws(() => ensureSynchronousGuard(foreign, fail, 'current-first'), conflict)
  assert.deepEqual(events, ['current', 'ensure', 'current'])
})

test('foreign thenable ensure and post-current cancellation remain failures', () => {
  const first = new AbortController(), second = new AbortController()
  assert.throws(() => ensureSynchronousGuard({ signal: first.signal, isCurrent: () => true, ensureCurrent: async () => {} }, fail), conflict)
  assert.throws(() => ensureSynchronousGuard({ signal: second.signal, isCurrent() { second.abort(); return true }, ensureCurrent() {} }, fail), conflict)
})

test('replacing any method or signal cannot borrow the owned fast path', () => {
  for (const field of ['signal', 'isCurrent', 'ensureCurrent']) {
    let checks = 0, ensures = 0
    const original = createSynchronousGuard(new AbortController().signal, () => { checks++ }, fail)
    const copy = { ...original }
    if (field === 'signal') copy.signal = new AbortController().signal
    if (field === 'isCurrent') copy.isCurrent = () => { checks++; return true }
    if (field === 'ensureCurrent') copy.ensureCurrent = () => { ensures++ }
    ensureSynchronousGuard(copy, fail)
    assert.equal(checks + ensures, 2, field)
  }
})

test('an owned validator changing its copied tuple during the check cannot return authority', () => {
  for (const field of ['signal', 'isCurrent', 'ensureCurrent']) {
    let copy
    const original = createSynchronousGuard(new AbortController().signal, () => {
      copy[field] = field === 'signal' ? new AbortController().signal : () => true
    }, fail)
    copy = { ...original }
    assert.throws(() => ensureSynchronousGuard(copy, fail), conflict, field)
  }
})

test('foreign method replacement inside current or ensure cannot escape post-call identity checks', () => {
  for (const stage of ['current', 'ensure']) {
    const foreign = { signal: new AbortController().signal,
      isCurrent() { if (stage === 'current') this.ensureCurrent = () => {}; return true },
      ensureCurrent() { if (stage === 'ensure') this.isCurrent = () => true } }
    assert.throws(() => ensureSynchronousGuard(foreign, fail, 'current-first'), conflict)
  }
})

test('inherited and accessor method copies use the foreign path and never skip stronger ensure', () => {
  let checks = 0
  const original = createSynchronousGuard(new AbortController().signal, () => { checks++ }, fail)
  const inherited = Object.create(original)
  ensureSynchronousGuard(inherited, fail); assert.equal(checks, 2)
  const accessor = { signal: original.signal, ensureCurrent: original.ensureCurrent, get isCurrent() { return original.isCurrent } }
  ensureSynchronousGuard(accessor, fail); assert.equal(checks, 4)
})

test('capturing an owned tuple invokes no checks and every captured invocation remains fresh', () => {
  let checks = 0
  const guard = { ...createSynchronousGuard(new AbortController().signal, () => { checks++ }, fail) }
  const check = captureSynchronousGuardCheck(guard, fail)
  assert.equal(typeof check, 'function'); assert.equal(checks, 0)
  check(); check(); assert.equal(checks, 2)
})

test('captured ownership rejects an entire replacement by another valid owned tuple without calling it', () => {
  let originalChecks = 0, replacementChecks = 0
  const signal = new AbortController().signal
  const guard = { ...createSynchronousGuard(signal, () => { originalChecks++ }, fail) }
  const check = captureSynchronousGuardCheck(guard, fail)
  Object.assign(guard, createSynchronousGuard(signal, () => { replacementChecks++ }, fail))
  assert.throws(check, conflict)
  assert.equal(originalChecks, 0); assert.equal(replacementChecks, 0)
  assert.equal(typeof captureSynchronousGuardCheck(guard, fail), 'function', 'new captures may recognize the new pair; old captures remain revoked')
})

test('capture never invokes foreign guard methods or accessors and does not certify inherited pairs', () => {
  let callbacks = 0
  const guard = createSynchronousGuard(new AbortController().signal, () => { callbacks++ }, fail)
  const foreign = { signal: guard.signal, isCurrent() { callbacks++; return true }, ensureCurrent() { callbacks++ } }
  const accessor = { signal: guard.signal, get isCurrent() { callbacks++; return guard.isCurrent }, ensureCurrent: guard.ensureCurrent }
  assert.equal(captureSynchronousGuardCheck(foreign, fail), undefined)
  assert.equal(captureSynchronousGuardCheck(accessor, fail), undefined)
  assert.equal(captureSynchronousGuardCheck(Object.create(guard), fail), undefined)
  assert.equal(callbacks, 0)
})

test('captured checks reject a tuple changed by its own validator without a fallback callback', () => {
  let copy, foreignCalls = 0
  const guard = createSynchronousGuard(new AbortController().signal, () => {
    copy.ensureCurrent = () => { foreignCalls++ }
  }, fail)
  copy = { ...guard }
  const check = captureSynchronousGuardCheck(copy, fail)
  assert.throws(check, conflict)
  assert.throws(check, conflict)
  assert.equal(foreignCalls, 0)
})
