import { randomUUID } from 'node:crypto'
import type { AgentDiagnosticEvent } from '../../../contracts/agentDiagnostics.js'
import { parseAgentDiagnosticDetails } from './agentOperationJournal.js'

const cooldownMs = 60_000
const maximumGroups = 256
const overflowKey = 'overflow'

interface Alert {
  stage: AgentDiagnosticEvent['stage']
  operation: string
  outcome: 'failed' | 'unknown'
  code?: string
  httpStatus?: number
  errorKind?: NonNullable<AgentDiagnosticEvent['errorKind']>
  sourceTag?: string
  durationMs?: number
  details?: NonNullable<AgentDiagnosticEvent['details']>
  traceId?: string
  firstAt: number
  lastAt: number
  count: number
}

interface Group {
  nextAt: number
  pending?: Alert
}

interface Batch {
  id: string
  rows: { group: Group; alert: Alert }[]
}

export interface AlertBatch {
  readonly version: 1
  readonly id: string
  readonly alerts: readonly Readonly<Alert>[]
}

type AlertDelivery = { state: 'confirmed' | 'unknown' } | { state: 'failed'; code: string }

/** Best-effort live notifications. The local operation journal remains the record of individual events. */
export function createAgentFailureAlerts(options: {
  channel: 'webhook' | 'qq'
  deliver(batch: AlertBatch, signal: AbortSignal): Promise<AlertDelivery>
  allowsLabel?: (label: string) => boolean
  logger?: Pick<Console, 'error'> & Partial<Pick<Console, 'info'>>
}) {
  const logger = options.logger ?? console
  const batchSize = options.channel === 'qq' ? 8 : 32
  const timeoutMs = options.channel === 'qq' ? 12_000 : 5_000
  const groups = new Map<string, Group>()
  let batch: Batch | undefined
  let retryAt = 0, retryDelay = 5_000, nextSendAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined, scheduledAt = Infinity
  let active: Promise<boolean> | undefined
  let closing: Promise<void> | undefined

  function log(message: string, level: 'error' | 'info' = 'error'): void {
    // The alert channel must not feed its own failures into diagnostics.
    try { logger[level]?.(`[AgentAlerts] ${message}`) } catch { /* No writable terminal. */ }
  }

  function allowed(value: string): boolean { try { return options.allowsLabel?.(value) !== false } catch { return false } }
  const label = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) && allowed(value) ? value : 'redacted'

  function collect(force: boolean): Batch | undefined {
    const rows: Batch['rows'] = [], now = Date.now()
    for (const group of groups.values()) {
      if (!group.pending || (!force && group.nextAt > now)) continue
      rows.push({ group, alert: group.pending })
      delete group.pending
      group.nextAt = Infinity
      if (rows.length === batchSize) break
    }
    return rows.length ? { id: randomUUID(), rows } : undefined
  }

  async function send(signal: AbortSignal, force = false): Promise<boolean> {
    batch ??= collect(force)
    if (!batch) return false
    let failure = 'transport_error'
    try {
      const result = await options.deliver({ version: 1, id: batch.id, alerts: batch.rows.map(row => row.alert) }, signal)
      if (result.state !== 'failed') {
        const now = Date.now()
        for (const { group } of batch.rows) group.nextAt = now + cooldownMs
        if (options.channel === 'qq') nextSendAt = now + 5_000
        const summary = `${options.channel}_delivery_${result.state} batch=${batch.id} alerts=${batch.rows.length}`
        log(summary, result.state === 'confirmed' ? 'info' : 'error')
        batch = undefined
        retryDelay = 5_000
        return true
      }
      failure = result.code
    } catch { /* A trusted delivery adapter returns a status; thrown details stay local. */ }
    retryAt = Date.now() + retryDelay
    log(`${options.channel}_delivery_failed ${failure} retry_in_ms=${retryDelay}`)
    retryDelay = Math.min(cooldownMs, retryDelay * 2)
    return false
  }

  function prune(now: number): void {
    for (const [key, group] of groups) if (!group.pending && group.nextAt <= now) groups.delete(key)
  }

  function schedule(): void {
    if (closing || active) return
    const now = Date.now()
    prune(now)
    let due = batch ? retryAt : Infinity
    if (!batch) for (const group of groups.values()) if (group.pending) due = Math.min(due, group.nextAt)
    due = Math.max(due, nextSendAt)
    if (due >= scheduledAt) return
    clearTimeout(timer)
    scheduledAt = due
    timer = setTimeout(() => {
      timer = undefined
      scheduledAt = Infinity
      active = send(AbortSignal.timeout(timeoutMs))
      void active.finally(() => { active = undefined; schedule() })
    }, Math.max(0, due - now))
    timer.unref?.()
  }

  function report(event: AgentDiagnosticEvent): void {
    if (closing || (event.outcome !== 'failed' && event.outcome !== 'unknown')) return
    const operation = label(event.operation), rawCode = event.code ?? event.delivery?.code
    const code = rawCode === undefined ? undefined : label(rawCode)
    const traceId = label(event.traceId)
    let details: AgentDiagnosticEvent['details']
    if (event.details) try {
      details = Object.fromEntries(Object.entries(parseAgentDiagnosticDetails(event.details))
        .filter(([, value]) => allowed(String(value))))
    } catch { /* The failure remains reportable without optional metadata. */ }
    const sourceTag = event.sourceTag && /^[\p{L}\p{N} _-]{1,24}$/u.test(event.sourceTag) && allowed(event.sourceTag) ? event.sourceTag : undefined
    let key = JSON.stringify([event.stage, operation, event.outcome, code, event.httpStatus, event.errorKind, sourceTag,
      details?.step, details?.blockingStep, details?.cause, details?.field, details?.rule, details?.limit, details?.nativeCode,
      details?.dispatched, details?.dispatchTurnPending, details?.result])
    let alert: Alert = { stage: event.stage, operation, outcome: event.outcome,
      ...(code === undefined ? {} : { code }), ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }), ...(traceId === 'redacted' ? {} : { traceId }),
      ...(sourceTag ? { sourceTag } : {}), ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs! } : {}),
      ...(details && Object.keys(details).length ? { details } : {}),
      firstAt: event.at, lastAt: event.at, count: 1 }
    if (!groups.has(key) && groups.size >= maximumGroups) {
      prune(Date.now())
      if (groups.size >= maximumGroups) {
        key = overflowKey
        alert = { stage: 'host', operation: 'alert_queue', outcome: 'failed', code: 'alert_group_overflow',
          firstAt: event.at, lastAt: event.at, count: 1 }
        if (!groups.get(key)?.pending) log('alert_group_overflow')
      }
    }
    let group = groups.get(key)
    if (!group) { group = { nextAt: 0 }; groups.set(key, group) }
    const previous = group.pending
    if (previous) {
      alert.firstAt = Math.min(previous.firstAt, alert.firstAt)
      if (previous.lastAt > alert.lastAt) alert = { ...previous, firstAt: alert.firstAt, count: alert.count }
      alert.lastAt = Math.max(previous.lastAt, alert.lastAt)
      alert.count += previous.count
    }
    group.pending = alert
    schedule()
  }

  async function drain(): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs)
    await active
    while (!deadline.aborted && await send(deadline, true)) { /* Drain queued batches within the same deadline. */ }
    if (batch || [...groups.values()].some(group => group.pending)) log(`${options.channel}_shutdown_pending`)
  }

  return { report, close(): Promise<void> {
    clearTimeout(timer)
    closing ??= drain()
    return closing
  } }
}
