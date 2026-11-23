import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentDiagnosticDetails, AgentDiagnosticEvent, AgentDiagnosticScope, AgentDiagnosticSink } from '../../../contracts/agentDiagnostics.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../domain/agentBindings.js'
import { parseAgentDiagnosticDetails } from './agentOperationJournal.js'

type Logger = { info(message: string, ...values: unknown[]): void; warn(message: string, ...values: unknown[]): void; error(message: string, ...values: unknown[]): void }
export type AgentDiagnosticInput = Pick<AgentDiagnosticEvent, 'stage' | 'operation' | 'outcome'> &
  Partial<Pick<AgentDiagnosticEvent, 'code' | 'sourceTag' | 'durationMs' | 'httpStatus' | 'details' | 'delivery'>> & { error?: unknown }

const knownErrors = new WeakMap<object, AgentDiagnosticDetails>()
const systemCauses = new Map([
  ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'], ['EPIPE', 'connection_closed'],
  ['ENOTFOUND', 'dns_lookup_failed'], ['EAI_AGAIN', 'dns_lookup_failed'], ['ETIMEDOUT', 'network_timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'connection_timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'response_headers_timeout'],
  ['UND_ERR_BODY_TIMEOUT', 'response_body_timeout'], ['UND_ERR_SOCKET', 'connection_closed'],
  ['ENOENT', 'file_missing'], ['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'], ['ENOSPC', 'disk_full'],
])

/** Attach fixed context while preserving the exception's original type and the caller's error contract. */
export function annotateAgentError<T>(error: T, details: AgentDiagnosticDetails): T {
  if (error && typeof error === 'object' && types.isNativeError(error)) {
    knownErrors.set(error, { ...errorDetails(error), ...details })
  }
  return error
}

function errorDetails(error: unknown): AgentDiagnosticDetails | undefined {
  for (let depth = 0; depth < 4 && error && typeof error === 'object' && !types.isProxy(error) && types.isNativeError(error); depth++) {
    const trusted = knownErrors.get(error)
    if (trusted) return trusted
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    const cause = typeof code === 'string' ? systemCauses.get(code) : undefined
    if (cause) return { cause }
    error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
  }
}

/** Only a leading bracketed label survives from runtime logger messages; bodies stay local. */
function sourceTagOf(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const label = /^\s*\[([^\][\r\n]{1,24})\]/u.exec(message)?.[1]
  if (!label) return undefined
  return /^[\p{Script=Han}\p{L}\p{N} _-]+$/u.test(label) ? label.trim().slice(0, 24) : undefined
}

/** Never inspect exception text, stack, request bodies, tool arguments or provider responses. */
function errorKind(error: unknown): NonNullable<AgentDiagnosticEvent['errorKind']> {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'Unknown'
  const name = Object.getOwnPropertyDescriptor(error, 'name')?.value
  if (name === 'AbortError' || name === 'TimeoutError') return name
  // Invoke the native brand-checking accessor directly, never an instance getter.
  try {
    const nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')!.get!.call(error)
    if (nativeName === 'AbortError' || nativeName === 'TimeoutError') return nativeName
  } catch { /* A non-DOMException carries no safe exception classification. */ }
  if (types.isNativeError(error)) {
    const prototype = Object.getPrototypeOf(error)
    if (prototype === TypeError.prototype) return 'TypeError'
    if (prototype === RangeError.prototype) return 'RangeError'
    if (prototype === SyntaxError.prototype) return 'SyntaxError'
    return 'Error'
  }
  return 'Unknown'
}

function outcomeOf(result: unknown): AgentDiagnosticEvent['outcome'] {
  if (!result || typeof result !== 'object' || types.isProxy(result)) return 'succeeded'
  const state = Object.getOwnPropertyDescriptor(result, 'state')?.value
  if (state === 'unknown' || state === 'failed') return state
  if (Object.getOwnPropertyDescriptor(result, 'error')?.value) return 'failed'
  return 'succeeded'
}

function deliveryOf(result: unknown): AgentDiagnosticEvent['delivery'] | undefined {
  if (!result || typeof result !== 'object' || types.isProxy(result)) return undefined
  const state = Object.getOwnPropertyDescriptor(result, 'state')?.value as unknown
  if (state !== 'sent' && state !== 'uploaded' && state !== 'confirmed' && state !== 'unknown' && state !== 'failed') return undefined
  const messageId = Object.getOwnPropertyDescriptor(result, 'messageId')?.value as unknown
  const code = Object.getOwnPropertyDescriptor(result, 'code')?.value as unknown
  return Object.freeze({ state,
    ...(typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 128 && messageId.trim() === messageId &&
      !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(messageId) ? { messageId } : {}),
    ...(typeof code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(code) ? { code } : {}),
  })
}

function sameScope(left: AgentDiagnosticScope, right: AgentDiagnosticScope): boolean {
  if (left.kind === 'host') return right.kind === 'host'
  if (left.kind === 'account') return right.kind === 'account' && platformAccountKey(left.account) === platformAccountKey(right.account)
  return right.kind === 'conversation' && agentBindingToken(left.binding) === agentBindingToken(right.binding) &&
    conversationAddressKey(left.binding.target) === conversationAddressKey(right.binding.target) &&
    (right.messageId === undefined || left.messageId === right.messageId)
}

/** One context per admitted operation; async tools/model callbacks inherit its ownership and trace. */
export function createAgentDiagnostics(options: {
  sink?: AgentDiagnosticSink; logger?: Logger; now?: () => number; configurationRevision?: string
  allowsLabel?: (label: string) => boolean
  onFailure?: (event: AgentDiagnosticEvent) => void
} = {}) {
  type Context = { scope: AgentDiagnosticScope; traceId: string; operation: string }
  const contexts = new AsyncLocalStorage<Context>()
  const errorEvents = new WeakMap<object, AgentDiagnosticEvent>()
  const receiptEvents = new WeakMap<object, AgentDiagnosticEvent>()
  const hostTrace = randomUUID()
  const pending = new Set<Promise<unknown>>()
  const now = options.now ?? Date.now
  const terminal = options.logger ?? { info: console.info, warn: console.warn, error: console.error }
  const allowed = (value: string) => { try { return options.allowsLabel?.(value) !== false } catch { return false } }
  const token = (value: string) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/u.test(value) && allowed(value) ? value : 'unclassified'
  const configurationRevision = typeof options.configurationRevision === 'string' && options.configurationRevision.length > 0 &&
    options.configurationRevision.length <= 512 && options.configurationRevision.trim() === options.configurationRevision &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(options.configurationRevision) ? options.configurationRevision : undefined
  function notifyFailure(event: AgentDiagnosticEvent): void {
    try { options.onFailure?.(Object.freeze(event)) }
    catch { try { console.error('[Agent] diagnostic_failure_observer_failed') } catch { /* No writable terminal. */ } }
  }
  function journalFailure(event: AgentDiagnosticEvent, line: string, code: string, outcome: 'failed' | 'unknown' = 'failed'): void {
    try { console.error(`[Agent] ${code} ${line}`) } catch { /* Terminal unavailable. */ }
    if (options.onFailure) notifyFailure({ version: 1, id: randomUUID(), traceId: event.traceId, at: now(), scope: { kind: 'host' },
      stage: 'host', operation: 'operation_journal', outcome, code })
  }
  function recordEvent(input: AgentDiagnosticInput, notify = true): AgentDiagnosticEvent {
    const context = contexts.getStore()
    const delivery = input.delivery === undefined ? undefined : deliveryOf(input.delivery)
    const failed = input.outcome === 'failed' || input.outcome === 'unknown'
    const code = input.code ?? delivery?.code ?? (failed ? input.outcome === 'unknown' ? 'result_unconfirmed' : 'failure_reason_unavailable' : undefined)
    const inferred = errorDetails(input.error)
    let details: AgentDiagnosticDetails | undefined
    if (inferred || input.details) try {
      const validated = parseAgentDiagnosticDetails({ ...inferred, ...input.details })
      const entries = Object.entries(validated).filter(([, value]) => typeof value !== 'string' || allowed(value))
      if (entries.length) details = Object.freeze(Object.fromEntries(entries))
    } catch { /* Invalid diagnostic metadata cannot hide the operation itself. */ }
    const event: AgentDiagnosticEvent = { version: 1, id: randomUUID(), traceId: context?.traceId ?? (failed ? randomUUID() : hostTrace),
      at: now(), scope: context?.scope ?? { kind: 'host' }, stage: input.stage, operation: token(input.operation), outcome: input.outcome,
      ...(code ? { code: token(code) } : {}),
      ...(input.sourceTag && allowed(input.sourceTag) ? { sourceTag: input.sourceTag } : {}),
      ...(input.error === undefined ? {} : { errorKind: errorKind(input.error) }),
      ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs!)) } : {}),
      ...(Number.isSafeInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599 ? { httpStatus: input.httpStatus } : {}),
      ...(details ? { details } : {}),
      ...(configurationRevision ? { configurationRevision } : {}),
      ...(delivery === undefined ? {} : { delivery }),
    }
    const evidence = [event.sourceTag && `source=${event.sourceTag}`, event.errorKind && `errorKind=${event.errorKind}`,
      event.httpStatus && `http=${event.httpStatus}`, event.durationMs !== undefined && `ms=${event.durationMs}`,
      ...Object.entries(details ?? {}).map(([key, value]) => `${key}=${value}`)].filter(Boolean).join(' ')
    const line = `[Agent] ${event.stage}/${event.operation} ${event.outcome}${event.code ? ` ${event.code}` : ''} trace=${event.traceId}${evidence ? ` ${evidence}` : ''}`
    // Console remains observable even when the injected journal is unavailable.
    try { (event.outcome === 'failed' || event.outcome === 'unknown' ? terminal.error : event.outcome === 'cancelled' ? terminal.warn : terminal.info)(line) }
    catch { try { console.error('[Agent] diagnostic_console_failed') } catch { /* No remaining writable terminal. */ } }
    if (failed) {
      if (notify && input.error && typeof input.error === 'object') errorEvents.set(input.error, event)
      if (notify && options.onFailure) notifyFailure(event)
    }
    if (options.sink) {
      if (pending.size >= 256) {
        journalFailure(event, line, 'diagnostic_queue_overflow')
        return event
      }
      // A failed custom sink cannot retain arbitrary turns forever or hang shutdown.
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5_000) })
      const write = Promise.race([Promise.resolve().then(() => options.sink!.append(event)), timeout]).then(ok => {
        if (ok === undefined) journalFailure(event, line, 'diagnostic_journal_timeout', 'unknown')
        else if (!ok) journalFailure(event, line, 'diagnostic_journal_failed')
      }, () => journalFailure(event, line, 'diagnostic_journal_failed')).finally(() => { if (timer) clearTimeout(timer) })
      pending.add(write)
      void write.finally(() => pending.delete(write))
    }
    return event
  }
  const emit = (input: AgentDiagnosticInput) => { recordEvent(input) }
  function emitFailure(input: AgentDiagnosticInput, notifyRelated = false): void {
    const traceId = contexts.getStore()?.traceId
    let error = input.error
    let related: AgentDiagnosticEvent | undefined
    for (let depth = 0; traceId && depth < 4 && error && typeof error === 'object' && !types.isProxy(error); depth++) {
      const previous = errorEvents.get(error)
      if (previous?.traceId === traceId && previous.outcome === input.outcome) { related = previous; break }
      error = Object.getOwnPropertyDescriptor(error, 'cause')?.value
    }
    recordEvent(related ? { ...input, details: { ...input.details, causeEventId: related.id,
      ...(related.code === undefined ? {} : { cause: related.code }) } } : input, !related || notifyRelated)
  }
  const logger: Logger = {
    info() { emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'succeeded', code: 'runtime_info' }) },
    warn(message, error) { const sourceTag = sourceTagOf(message); emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'failed', code: 'runtime_warning', ...(sourceTag ? { sourceTag } : {}), ...(error === undefined ? {} : { error }) }) },
    error(message, error) { const sourceTag = sourceTagOf(message); emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'failed', code: 'runtime_error', ...(sourceTag ? { sourceTag } : {}), ...(error === undefined ? {} : { error }) }) },
  }
  return {
    emit, emitFailure, logger,
    traceId: () => contexts.getStore()?.traceId ?? hostTrace,
    scope: (): AgentDiagnosticScope => contexts.getStore()?.scope ?? { kind: 'host' },
    withScope<T>(scope: AgentDiagnosticScope, operation: string, fn: () => T, inheritTrace = false): T {
      return contexts.run({ scope, operation: token(operation), traceId: (inheritTrace ? contexts.getStore()?.traceId : undefined) ?? randomUUID() }, fn)
    },
    async run<T>(scope: AgentDiagnosticScope, operation: string, fn: () => Promise<T>, stage: AgentDiagnosticEvent['stage'] = 'runtime'): Promise<T> {
      const parent = contexts.getStore()
      const sameTurn = !!parent && sameScope(parent.scope, scope)
      const ownedScope = scope.kind === 'conversation' && scope.messageId === undefined && sameTurn && parent?.scope.kind === 'conversation' && parent.scope.messageId
        ? { ...scope, messageId: parent.scope.messageId } : scope
      const context: Context = { scope: ownedScope, operation: token(operation), traceId: sameTurn ? parent.traceId : randomUUID() }
      const relation = (event: AgentDiagnosticEvent | undefined, outcome: AgentDiagnosticEvent['outcome']) =>
        event?.traceId === context.traceId && event.outcome === outcome ? { causeEventId: event.id, ...(event.code ? { cause: event.code } : {}) } : undefined
      return contexts.run(context, async () => {
        const started = now()
        emit({ stage, operation, outcome: 'started' })
        try {
          const result = await fn()
          const delivery = stage === 'delivery' ? deliveryOf(result) : undefined
          const outcome = outcomeOf(result)
          const failureReceipt = (outcome === 'failed' || outcome === 'unknown') && result && typeof result === 'object' ? result : undefined
          const cause = failureReceipt ? relation(receiptEvents.get(failureReceipt), outcome) : undefined
          const event = recordEvent({ stage, operation, outcome, durationMs: now() - started,
            ...(delivery ? { delivery } : {}), ...(cause ? { details: cause } : {}) }, !cause)
          if (failureReceipt && !cause) receiptEvents.set(failureReceipt, event)
          return result
        } catch (error) {
          const kind = errorKind(error)
          const outcome = kind === 'AbortError' ? 'cancelled' : 'failed'
          const cause = error && typeof error === 'object' ? relation(errorEvents.get(error), outcome) : undefined
          recordEvent({ stage, operation, outcome, code: 'operation_exception', error, durationMs: now() - started,
            ...(cause ? { details: cause } : {}) }, !cause)
          throw error
        }
      })
    },
    async flush(): Promise<void> { while (pending.size) await Promise.allSettled([...pending]) },
  }
}

export type AgentDiagnostics = ReturnType<typeof createAgentDiagnostics>

export function reportAgentFailure(
  diagnostics: Pick<AgentDiagnostics, 'emit'> | undefined,
  failure: Omit<AgentDiagnosticInput, 'outcome'> & { code: string; outcome?: 'failed' | 'unknown' },
  log: () => void,
): void {
  try {
    if (diagnostics) diagnostics.emit({ outcome: 'failed', ...failure })
    else log()
  } catch { /* Diagnostics cannot interrupt recovery. */ }
}
