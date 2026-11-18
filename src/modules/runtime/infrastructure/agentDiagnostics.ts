import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { AgentDiagnosticEvent, AgentDiagnosticScope, AgentDiagnosticSink } from '../../../contracts/agentDiagnostics.js'

type Logger = { info(message: string, ...values: unknown[]): void; warn(message: string, ...values: unknown[]): void; error(message: string, ...values: unknown[]): void }
export type AgentDiagnosticInput = Pick<AgentDiagnosticEvent, 'stage' | 'operation' | 'outcome'> &
  Partial<Pick<AgentDiagnosticEvent, 'code' | 'durationMs' | 'httpStatus'>> & { error?: unknown }

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

/** One context per admitted operation; async tools/model callbacks inherit its ownership and trace. */
export function createAgentDiagnostics(options: { sink?: AgentDiagnosticSink; logger?: Logger; now?: () => number } = {}) {
  const contexts = new AsyncLocalStorage<{ scope: AgentDiagnosticScope; traceId: string; operation: string }>()
  const hostTrace = randomUUID()
  const pending = new Set<Promise<unknown>>()
  const now = options.now ?? Date.now
  const terminal = options.logger ?? { info: console.info, warn: console.warn, error: console.error }
  const token = (value: string) => /^[a-z][a-zA-Z0-9_.-]{0,79}$/u.test(value) ? value : 'unclassified'
  function emit(input: AgentDiagnosticInput): void {
    const context = contexts.getStore()
    const event: AgentDiagnosticEvent = { version: 1, id: randomUUID(), traceId: context?.traceId ?? hostTrace,
      at: now(), scope: context?.scope ?? { kind: 'host' }, stage: input.stage, operation: token(input.operation), outcome: input.outcome,
      ...(input.code ? { code: token(input.code) } : {}),
      ...(input.error === undefined ? {} : { errorKind: errorKind(input.error) }),
      ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs!)) } : {}),
      ...(Number.isSafeInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599 ? { httpStatus: input.httpStatus } : {}) }
    const line = `[Agent] ${event.stage}/${event.operation} ${event.outcome}${event.code ? ` ${event.code}` : ''} trace=${event.traceId}`
    // Console remains observable even when the injected journal is unavailable.
    try { (event.outcome === 'failed' || event.outcome === 'unknown' ? terminal.error : event.outcome === 'cancelled' ? terminal.warn : terminal.info)(line) }
    catch { try { console.error('[Agent] diagnostic_console_failed') } catch { /* No remaining writable terminal. */ } }
    if (options.sink) {
      if (pending.size >= 256) {
        try { console.error(`[Agent] diagnostic_queue_overflow ${line}`) } catch { /* Terminal unavailable. */ }
        return
      }
      // A failed custom sink cannot retain arbitrary turns forever or hang shutdown.
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000) })
      const write = Promise.race([Promise.resolve().then(() => options.sink!.append(event)), timeout]).then(ok => {
        if (!ok) console.error(`[Agent] diagnostic_journal_failed ${line}`)
      }).catch(() => { try { console.error(`[Agent] diagnostic_journal_failed ${line}`) } catch { /* Console and journal both unavailable. */ } }).finally(() => { if (timer) clearTimeout(timer) })
      pending.add(write)
      void write.finally(() => pending.delete(write))
    }
  }
  const logger: Logger = {
    info() { emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'succeeded', code: 'runtime_info' }) },
    warn(_message, error) { emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'failed', code: 'runtime_warning', ...(error === undefined ? {} : { error }) }) },
    error(_message, error) { emit({ stage: 'runtime', operation: contexts.getStore()?.operation ?? 'host_log', outcome: 'failed', code: 'runtime_error', ...(error === undefined ? {} : { error }) }) },
  }
  return {
    emit, logger,
    traceId: () => contexts.getStore()?.traceId ?? hostTrace,
    scope: (): AgentDiagnosticScope => contexts.getStore()?.scope ?? { kind: 'host' },
    async run<T>(scope: AgentDiagnosticScope, operation: string, fn: () => Promise<T>, stage: AgentDiagnosticEvent['stage'] = 'runtime'): Promise<T> {
      const parent = contexts.getStore()
      const sameTurn = scope.kind !== 'conversation' || parent?.scope.kind === 'conversation' &&
        parent.scope.binding.id === scope.binding.id && (scope.messageId === undefined || parent.scope.messageId === scope.messageId)
      const ownedScope = scope.kind === 'conversation' && scope.messageId === undefined && sameTurn && parent?.scope.kind === 'conversation' && parent.scope.messageId
        ? { ...scope, messageId: parent.scope.messageId } : scope
      return contexts.run({ scope: ownedScope, operation: token(operation), traceId: sameTurn ? parent?.traceId ?? randomUUID() : randomUUID() }, async () => {
        const started = now()
        emit({ stage, operation, outcome: 'started' })
        try {
          const result = await fn()
          emit({ stage, operation, outcome: outcomeOf(result), durationMs: now() - started })
          return result
        } catch (error) {
          const kind = errorKind(error)
          emit({ stage, operation, outcome: kind === 'AbortError' ? 'cancelled' : 'failed', code: 'operation_exception', error, durationMs: now() - started })
          throw error
        }
      })
    },
    async flush(): Promise<void> { while (pending.size) await Promise.allSettled([...pending]) },
  }
}

export type AgentDiagnostics = ReturnType<typeof createAgentDiagnostics>
