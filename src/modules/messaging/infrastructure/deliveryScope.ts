import { AsyncLocalStorage } from 'node:async_hooks'

// Carry the turn's synchronous authorization through host-owned async queues.
// The callback stays local to the current send and never enters platform parameters.
const guards = new AsyncLocalStorage<() => boolean>()

export function withDeliveryGuard<T>(isCurrent: (() => boolean) | undefined, send: () => T): T {
  const parent = guards.getStore()
  if (!isCurrent) return send()
  return guards.run(parent ? () => parent() && isCurrent() : isCurrent, send)
}

export function queuedDeliveryAllowed(): boolean {
  try {
    return guards.getStore()?.() ?? true
  } catch {
    return false
  }
}
