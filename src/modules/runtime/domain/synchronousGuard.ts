/** A fresh synchronous authority observation. Failed observations must throw. */
export interface SynchronousGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): void
}
type Failure = () => never
type Tuple = Readonly<{ signal: AbortSignal; isCurrent: SynchronousGuard['isCurrent']; ensureCurrent: SynchronousGuard['ensureCurrent'] }>
const owned = new WeakMap<SynchronousGuard['ensureCurrent'], Tuple>()

function synchronous(value: unknown, fail: Failure): void {
  if (value instanceof Promise) {
    // Reject immediately, while preventing an async validator's rejection from becoming unhandled.
    // Never invoke an arbitrary thenable's callback or an overridden Promise.then method.
    try { void Promise.prototype.then.call(value, undefined, () => {}) } catch { /* It remains invalid. */ }
    return fail()
  }
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function') fail()
}
function tuple(guard: SynchronousGuard, fail: Failure): Tuple {
  const signal = guard.signal, isCurrent = guard.isCurrent, ensureCurrent = guard.ensureCurrent
  if (!(signal instanceof AbortSignal) || typeof isCurrent !== 'function' || typeof ensureCurrent !== 'function') return fail()
  return { signal, isCurrent, ensureCurrent }
}
function unchanged(guard: SynchronousGuard, before: Tuple, fail: Failure): void {
  if (guard.signal !== before.signal || guard.isCurrent !== before.isCurrent || guard.ensureCurrent !== before.ensureCurrent) fail()
}
function ownTuple(guard: SynchronousGuard, expected: Tuple): boolean {
  // Accessor-backed or inherited methods never receive the private fast path.
  return (['signal', 'isCurrent', 'ensureCurrent'] as const).every(key => {
    const field = Object.getOwnPropertyDescriptor(guard, key)
    return !!field && Object.hasOwn(field, 'value') && field.value === expected[key]
  })
}

/** Both methods run the same validator; no result survives even one completed call. */
export function createSynchronousGuard(signal: AbortSignal, check: () => unknown, fail: Failure): SynchronousGuard {
  const ensureCurrent = () => {
    if (!(signal instanceof AbortSignal) || signal.aborted) return fail()
    synchronous(check(), fail)
    if (signal.aborted) fail()
  }
  const isCurrent = () => { try { ensureCurrent(); return true } catch { return false } }
  const value = Object.freeze({ signal, isCurrent, ensureCurrent })
  owned.set(ensureCurrent, value)
  return value
}

/** Capture an intact owned pair without invoking either method. Later replacement always revokes it. */
export function captureSynchronousGuardCheck(guard: SynchronousGuard, fail: Failure): (() => void) | undefined {
  const field = Object.getOwnPropertyDescriptor(guard, 'ensureCurrent')
  if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'function') return undefined
  const registered = owned.get(field.value as SynchronousGuard['ensureCurrent'])
  if (!registered || !ownTuple(guard, registered)) return undefined
  return () => {
    if (!ownTuple(guard, registered)) return fail()
    registered.ensureCurrent.call(guard)
    if (!ownTuple(guard, registered) || registered.signal.aborted) fail()
  }
}

/** Deduplicate only an intact owned pair. Foreign guards retain their caller's original order. */
export function ensureSynchronousGuard(guard: SynchronousGuard, fail: Failure,
  order: 'ensure-first' | 'current-first' = 'ensure-first'): void {
  const captured = captureSynchronousGuardCheck(guard, fail)
  if (captured) return captured()
  const before = tuple(guard, fail)
  if (order === 'current-first') {
    if (before.signal.aborted || before.isCurrent.call(guard) !== true) return fail()
    unchanged(guard, before, fail)
    if (before.signal.aborted) return fail()
  }
  synchronous(before.ensureCurrent.call(guard), fail)
  unchanged(guard, before, fail)
  if (before.signal.aborted || before.isCurrent.call(guard) !== true) return fail()
  unchanged(guard, before, fail)
  if (before.signal.aborted) fail()
}
