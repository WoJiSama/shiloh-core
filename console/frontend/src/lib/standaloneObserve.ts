import {
  robotLocation,
  type ConsoleWorkspace,
  type WorkspaceAccount,
  type WorkspaceConversation
} from './workspaceModel'
import { accountLabel, conversationAddressLabel, workspaceRobotLabel } from './workspaceNames'

export type DiagnosticOutcome = 'started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export interface DiagnosticEvent {
  version: 1
  id: string
  traceId: string
  at: number
  scope:
    | { kind: 'host' }
    | { kind: 'account'; account: WorkspaceAccount }
    | { kind: 'conversation'; binding: WorkspaceConversation['binding']; messageId?: string }
  stage: 'host' | 'inbox' | 'model' | 'tool' | 'delivery' | 'memory' | 'runtime' | 'notification'
  operation: string
  outcome: DiagnosticOutcome
  configurationRevision?: string
  delivery?: {
    state: 'sent' | 'uploaded' | 'confirmed' | 'unknown' | 'failed'
    messageId?: string
    code?: string
  }
  code?: string
  durationMs?: number
  errorKind?: string
  httpStatus?: number
  diagnosis?: { operation: string; reason?: string; evidence: string; result: string }
  causeEventId?: string
  scopeKey?: string
  bindingToken?: string
  currentBinding?: boolean
}
export interface StandaloneObserveSummary {
  version: 1
  mode: 'standalone'
  processEpoch: string
  observedAt: number
  configuration: {
    loadedRevision: string
    storedRevision: string
    phase: 'active' | 'saving' | 'restart-required' | 'uncertain'
    requiresRestart: boolean
  }
  journal:
    | {
        available: true
        degraded: boolean
        written: number
        failed: number
        lastWrittenAt?: number
      }
    | { available: false }
  scan: {
    truncated: boolean
    invalidRecords: number
    scannedEvents: number
    hostCountersVisible: boolean
  }
  events: DiagnosticEvent[]
}
const fail = (): never => {
  throw new Error('运行观测响应不完整或会话身份不一致，请刷新核对')
}
function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fail()
}
function text(value: unknown, maximum = 4096, empty = false): string {
  return typeof value === 'string' &&
    value.length <= maximum &&
    (empty || !!value.trim()) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : fail()
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : fail()
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : fail()
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : fail()
}
function account(value: unknown): WorkspaceAccount {
  const row = object(value)
  return {
    platform: text(row.platform, 64),
    namespace: text(row.namespace, 128),
    id: text(row.id, 128)
  }
}
function binding(value: unknown): WorkspaceConversation['binding'] {
  const row = object(value),
    target = object(row.target)
  return {
    source: choice(row.source, [
      'configured',
      'legacy'
    ]) as WorkspaceConversation['binding']['source'],
    id: text(row.id),
    revision: text(row.revision, 512),
    agentId: text(row.agentId, 128),
    personaId: text(row.personaId, 128),
    connectionId: text(row.connectionId, 128),
    target: {
      account: account(target.account),
      kind: choice(target.kind, ['group', 'private', 'channel', 'thread']),
      id: text(target.id, 128)
    }
  }
}
function event(value: unknown): DiagnosticEvent {
  const row = object(value),
    rawScope = object(row.scope)
  if (row.version !== 1) return fail()
  const kind = choice(rawScope.kind, ['host', 'account', 'conversation'])
  const scope: DiagnosticEvent['scope'] =
    kind === 'host'
      ? { kind }
      : kind === 'account'
        ? { kind, account: account(rawScope.account) }
        : {
            kind,
            binding: binding(rawScope.binding),
            ...(rawScope.messageId === undefined
              ? {}
              : { messageId: text(rawScope.messageId, 128) })
          }
  const result: DiagnosticEvent = {
    version: 1,
    id: text(row.id, 128),
    traceId: text(row.traceId, 128),
    at: integer(row.at, 8_640_000_000_000_000),
    scope,
    stage: choice(row.stage, [
      'host',
      'inbox',
      'model',
      'tool',
      'delivery',
      'memory',
      'runtime',
      'notification'
    ]),
    operation: text(row.operation, 128),
    outcome: choice(row.outcome, ['started', 'succeeded', 'failed', 'unknown', 'cancelled'])
  }
  if (row.configurationRevision !== undefined)
    result.configurationRevision = text(row.configurationRevision)
  if (row.code !== undefined) result.code = text(row.code, 128)
  if (row.durationMs !== undefined) result.durationMs = integer(row.durationMs)
  if (row.httpStatus !== undefined) {
    result.httpStatus = integer(row.httpStatus, 599)
    if (result.httpStatus < 100) return fail()
  }
  if (row.diagnosis !== undefined) {
    const diagnosis = object(row.diagnosis)
    result.diagnosis = {
      operation: text(diagnosis.operation, 128),
      ...(diagnosis.reason === undefined ? {} : { reason: text(diagnosis.reason, 512) }),
      evidence: text(diagnosis.evidence, 1024, true),
      result: text(diagnosis.result, 256, true)
    }
  }
  if (row.details !== undefined) {
    const related = object(row.details).causeEventId
    if (related !== undefined) result.causeEventId = text(related, 128)
  }
  if (row.errorKind !== undefined)
    result.errorKind = choice(row.errorKind, [
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'AbortError',
      'TimeoutError',
      'Unknown'
    ])
  if (row.delivery !== undefined) {
    const delivery = object(row.delivery)
    result.delivery = {
      state: choice(delivery.state, ['sent', 'uploaded', 'confirmed', 'unknown', 'failed']),
      ...(delivery.messageId === undefined ? {} : { messageId: text(delivery.messageId, 128) }),
      ...(delivery.code === undefined ? {} : { code: text(delivery.code, 128) })
    }
  }
  if (row.currentBinding !== undefined) result.currentBinding = boolean(row.currentBinding)
  if (row.scopeKey !== undefined) result.scopeKey = text(row.scopeKey)
  if (row.bindingToken !== undefined) result.bindingToken = text(row.bindingToken, 8192)
  if (
    result.currentBinding === true ||
    result.scopeKey !== undefined ||
    result.bindingToken !== undefined
  ) {
    if (
      scope.kind !== 'conversation' ||
      result.currentBinding !== true ||
      !result.scopeKey ||
      !result.bindingToken ||
      result.scopeKey !== conversationScopeKey(scope.binding)
    )
      return fail()
  }
  return result
}
export function parseStandaloneObserve(value: unknown): StandaloneObserveSummary {
  const raw = object(value),
    config = object(raw.configuration),
    journal = object(raw.journal),
    scan = object(raw.scan)
  if (raw.version !== 1 || raw.mode !== 'standalone') return fail()
  const available = boolean(journal.available)
  const configuration: StandaloneObserveSummary['configuration'] = {
    loadedRevision: text(config.loadedRevision),
    storedRevision: text(config.storedRevision, 4096, true),
    phase: choice(config.phase, ['active', 'saving', 'restart-required', 'uncertain']),
    requiresRestart: boolean(config.requiresRestart)
  }
  if (
    configuration.phase === 'active' &&
    (configuration.requiresRestart || configuration.loadedRevision !== configuration.storedRevision)
  )
    return fail()
  if (!Array.isArray(raw.events) || raw.events.length > 200) return fail()
  const events = raw.events.map(event)
  if (new Set(events.map((row) => row.id)).size !== events.length) return fail()
  return {
    version: 1,
    mode: 'standalone',
    processEpoch: text(raw.processEpoch),
    observedAt: integer(raw.observedAt, 8_640_000_000_000_000),
    configuration,
    journal: available
      ? {
          available,
          degraded: boolean(journal.degraded),
          written: integer(journal.written),
          failed: integer(journal.failed),
          ...(journal.lastWrittenAt === undefined
            ? {}
            : { lastWrittenAt: integer(journal.lastWrittenAt) })
        }
      : { available },
    scan: {
      truncated: boolean(scan.truncated),
      invalidRecords: integer(scan.invalidRecords),
      scannedEvents: integer(scan.scannedEvents),
      hostCountersVisible: boolean(scan.hostCountersVisible)
    },
    events
  }
}
function conversationScopeKey(binding: WorkspaceConversation['binding']) {
  const { target } = binding
  return JSON.stringify([
    binding.agentId,
    target.account.platform,
    target.account.namespace,
    target.account.id,
    target.kind,
    target.id
  ])
}
function bindingIdentity(binding: WorkspaceConversation['binding']) {
  return JSON.stringify([
    binding.source,
    binding.id,
    binding.revision,
    binding.agentId,
    binding.personaId,
    binding.connectionId,
    conversationScopeKey(binding)
  ])
}
export function diagnosticScopeLabel(event: DiagnosticEvent): string {
  if (event.scope.kind === 'host') return '宿主'
  if (event.scope.kind === 'account') return `账号 ${accountLabel(event.scope.account)}`
  const { binding } = event.scope
  return `本人 ${workspaceRobotLabel(binding.agentId)} · 连接 ${binding.connectionId} · 账号 ${accountLabel(binding.target.account)} · ${conversationAddressLabel(binding.target)}`
}
export function diagnosticLocation(event: DiagnosticEvent, workspace: ConsoleWorkspace | null) {
  if (
    !workspace ||
    event.scope.kind !== 'conversation' ||
    !event.currentBinding ||
    !event.scopeKey ||
    !event.bindingToken
  )
    return undefined
  const eventBinding = event.scope.binding
  const owner = workspace.agents.find((agent) => agent.id === eventBinding.agentId)
  const selected = owner?.conversations.find(
    (row) =>
      row.scopeKey === event.scopeKey &&
      row.bindingToken === event.bindingToken &&
      bindingIdentity(row.binding) === bindingIdentity(eventBinding)
  )
  return owner && selected ? robotLocation(owner, 'conversations', selected) : undefined
}
export function diagnosticTraceKey(event: DiagnosticEvent) {
  const scope = event.scope
  return JSON.stringify([
    event.traceId,
    scope.kind,
    scope.kind === 'conversation'
      ? [bindingIdentity(scope.binding), scope.messageId ?? '']
      : scope.kind === 'account'
        ? [scope.account.platform, scope.account.namespace, scope.account.id]
        : ''
  ])
}
export function diagnosticOutcomeLabel(event: DiagnosticEvent) {
  if (event.delivery)
    return {
      sent: '平台已确认发送',
      uploaded: '已上传',
      confirmed: '平台已确认操作',
      unknown: '投递结果未知',
      failed: '投递失败'
    }[event.delivery.state]
  return {
    started: '已开始',
    succeeded: '操作完成',
    failed: '失败',
    unknown: '结果未知',
    cancelled: '已取消'
  }[event.outcome]
}
export function diagnosticStatus(event: DiagnosticEvent): DiagnosticOutcome {
  return event.delivery?.state === 'unknown' || event.delivery?.state === 'failed'
    ? event.delivery.state
    : event.outcome
}
