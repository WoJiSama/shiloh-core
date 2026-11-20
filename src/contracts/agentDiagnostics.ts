import type { AgentBindingSnapshot, PlatformAccountRef } from './agentBinding.js'

export type AgentDiagnosticScope =
  | { readonly kind: 'host' }
  | { readonly kind: 'conversation'; readonly binding: AgentBindingSnapshot; readonly messageId?: string }
  | { readonly kind: 'account'; readonly account: PlatformAccountRef }

/** Structured operational metadata only; no prompts, response bodies, errors, URLs or arbitrary details. */
export interface AgentDiagnosticEvent {
  readonly version: 1
  readonly id: string
  readonly traceId: string
  readonly at: number
  readonly scope: AgentDiagnosticScope
  readonly stage: 'host' | 'inbox' | 'model' | 'tool' | 'delivery' | 'memory' | 'runtime' | 'notification'
  readonly operation: string
  readonly outcome: 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
  readonly code?: string
  /** Leading bracketed label of a runtime logger message, e.g. "[海龟汤]"; never the message body. */
  readonly sourceTag?: string
  readonly durationMs?: number
  readonly errorKind?: 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'AbortError' | 'TimeoutError' | 'Unknown'
  readonly httpStatus?: number
  /** The immutable configuration loaded by the process that produced this event. */
  readonly configurationRevision?: string
  /** Native action metadata only. An unknown result never becomes a confirmed delivery. */
  readonly delivery?: {
    readonly state: 'sent' | 'uploaded' | 'confirmed' | 'unknown' | 'failed'
    readonly messageId?: string
    readonly code?: string
  }
}

export interface AgentDiagnosticSink {
  /** True confirms that this event, or its safe redacted replacement, was committed. */
  append(event: AgentDiagnosticEvent): Promise<boolean>
}

export interface AgentOperationJournal extends AgentDiagnosticSink {
  flush(): Promise<boolean>
  close(): Promise<boolean>
  health(): { readonly degraded: boolean; readonly written: number; readonly failed: number; readonly lastWrittenAt?: number }
}
