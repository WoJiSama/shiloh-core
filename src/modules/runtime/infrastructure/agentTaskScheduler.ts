import { randomUUID } from 'node:crypto'

export interface AgentTaskClaim {
  readonly id: string
  readonly leaseUntil: number
}

export function createAgentTaskClaim(at: number, lifetime: number): AgentTaskClaim {
  return { id: randomUUID(), leaseUntil: at + lifetime }
}

export function hasLiveTaskClaim(leaseUntil: number | undefined, at: number): boolean {
  return leaseUntil !== undefined && leaseUntil > at
}

export interface AgentScheduledWork {
  readonly kind: string
  readonly scope: string
  run(): Promise<void>
}

/** In-process dispatch. The owning store claims and settles each durable record. */
export function createAgentTaskScheduler(ports: {
  isCurrent(): boolean
  failed(kind: string, error: unknown): void
}) {
  const running = new Map<string, Promise<void>>()

  function tick(work: Iterable<AgentScheduledWork>): Promise<void> {
    if (!ports.isCurrent()) return Promise.resolve()
    const operations: Promise<void>[] = []
    for (const item of work) {
      const key = JSON.stringify([item.kind, item.scope])
      if (running.has(key)) continue
      const operation = Promise.resolve().then(async () => {
        if (ports.isCurrent()) await item.run()
      }).catch(error => {
        if (ports.isCurrent()) ports.failed(item.kind, error)
      }).finally(() => running.delete(key))
      running.set(key, operation)
      operations.push(operation)
    }
    return Promise.all(operations).then(() => undefined)
  }

  return { tick, drain: async () => { await Promise.allSettled(running.values()) } }
}
