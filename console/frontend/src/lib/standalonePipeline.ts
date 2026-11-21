import type { WorkspaceAccount } from './workspaceModel'
import { accountLabel, conversationAddressLabel } from './workspaceNames'

export type PipelineMode = 'unknown' | 'standalone' | 'legacy'
export const corePipelineStates = {
  queued: '待处理',
  preparing: '准备中',
  sending: '发送中（结果待确认）',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '结果未知（不自动重发）'
} as const
export const legacyPipelineStates = {
  pending: '待处理',
  processing: '处理中',
  retry_wait: '等待重试',
  completed: '已完成',
  sent: '已发送',
  failed: '失败',
  sending: '发送结果待确认',
  uncertain: '结果不确定（未自动重试）'
} as const
type CoreState = keyof typeof corePipelineStates
interface CoreIdentity {
  mode: 'standalone'
  id: string
  scopeKey: string
  bindingToken: string
  agentId: string
  connectionId: string
  account: WorkspaceAccount
  conversation: { account: WorkspaceAccount; kind: string; id: string }
}
export interface CoreInboxJob extends CoreIdentity {
  kind: 'event'
  state: 'queued'
  queue: 'private' | 'group' | 'simulation' | 'privacy' | 'group-log'
  eventKind: 'message' | 'recall' | 'nudge'
  occurredAt?: number
}
export interface CoreMediaJob extends CoreIdentity {
  kind: 'delivery'
  state: CoreState
  provider: 'bilibili' | 'douyin' | 'xiaohongshu' | 'youtube' | 'pixiv'
  createdAt: number
  updatedAt: number
  expiresAt: number
  attempts: number
  prepareFailures: number
  nextRetryAt: number
  effects: {
    effect: 'forward' | 'forwardRetry' | 'directIntro' | 'directVideo' | 'link'
    state: 'pending' | 'sent' | 'failed' | 'unknown'
    beganAt: number
    finishedAt?: number
  }[]
}
export interface LegacyPipelineJob {
  mode: 'legacy'
  kind: 'event' | 'delivery'
  id: string
  state: string
  botId: string
  groupId: string
  platform: string
  attempts?: number
  createdAt?: number
  updatedAt?: number
  nextRetryAt?: number
  leaseUntil?: number
  lastError?: string
  uncertain?: boolean
  receiptMessageId?: string
  runtimeConfirmed?: boolean
}
export type PipelineJob = CoreInboxJob | CoreMediaJob | LegacyPipelineJob
interface PipelineRead {
  returned: number
  scanTruncated: boolean
}
export type PipelineSnapshot =
  | (PipelineRead & {
      mode: 'standalone'
      version: 1
      observedAt: number
      jobs: (CoreInboxJob | CoreMediaJob)[]
      retention: {
        inbox: 'until-acknowledged'
        textQueueIdleSeconds: number
        mediaRecordIdleSeconds: number
        mediaTaskLifetimeSeconds: number
      }
    })
  | (PipelineRead & {
      mode: 'legacy'
      jobs: LegacyPipelineJob[]
      retention: { eventMinutes: number; deliveryHours: number }
    })
const fail = (): never => {
  throw new Error('任务响应不完整或会话身份不一致，请刷新核对')
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail()
}
function text(value: unknown, empty = false, maximum = 8192): string {
  return typeof value === 'string' &&
    value.length <= maximum &&
    (empty || !!value.trim()) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : fail()
}
function integer(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail()
}
function timestamp(value: unknown): number {
  const result = integer(value)
  return result <= 8_640_000_000_000_000 ? result : fail()
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : fail()
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  return typeof value === 'string' && options.includes(value as T) ? (value as T) : fail()
}
function account(value: unknown): WorkspaceAccount {
  const row = object(value)
  return { platform: text(row.platform), namespace: text(row.namespace), id: text(row.id) }
}
function coreJob(value: unknown): CoreInboxJob | CoreMediaJob {
  const row = object(value),
    target = object(row.conversation),
    owner = account(row.account),
    conversation = {
      account: account(target.account),
      kind: choice(target.kind, ['private', 'group', 'channel', 'thread']),
      id: text(target.id)
    }
  const common: CoreIdentity = {
    mode: 'standalone',
    id: text(row.id),
    scopeKey: text(row.scopeKey),
    bindingToken: text(row.bindingToken),
    agentId: text(row.agentId),
    connectionId: text(row.connectionId),
    account: owner,
    conversation
  }
  if (
    JSON.stringify(owner) !== JSON.stringify(conversation.account) ||
    common.scopeKey !==
      JSON.stringify([
        common.agentId,
        owner.platform,
        owner.namespace,
        owner.id,
        conversation.kind,
        conversation.id
      ])
  )
    return fail()
  const kind = choice(row.kind, ['event', 'delivery'])
  if (kind === 'event')
    return {
      ...common,
      kind,
      state: choice(row.state, ['queued']),
      queue: choice(row.queue, ['private', 'group', 'simulation', 'privacy', 'group-log']),
      eventKind: choice(row.eventKind, ['message', 'recall', 'nudge']),
      ...(row.occurredAt === undefined ? {} : { occurredAt: timestamp(row.occurredAt) })
    }
  if (!Array.isArray(row.effects) || row.effects.length > 5) return fail()
  return {
    ...common,
    kind,
    state: choice(row.state, Object.keys(corePipelineStates) as CoreState[]),
    provider: choice(row.provider, ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv']),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    expiresAt: timestamp(row.expiresAt),
    attempts: integer(row.attempts),
    prepareFailures: integer(row.prepareFailures),
    nextRetryAt: timestamp(row.nextRetryAt),
    effects: row.effects.map((value) => {
      const effect = object(value)
      return {
        effect: choice(effect.effect, ['forward', 'forwardRetry', 'directIntro', 'directVideo', 'link']),
        state: choice(effect.state, ['pending', 'sent', 'failed', 'unknown']),
        beganAt: timestamp(effect.beganAt),
        ...(effect.finishedAt === undefined ? {} : { finishedAt: timestamp(effect.finishedAt) })
      }
    })
  }
}
function legacyJob(value: unknown): LegacyPipelineJob {
  const row = object(value)
  const result: LegacyPipelineJob = {
    mode: 'legacy',
    kind: choice(row.kind, ['event', 'delivery']),
    id: text(row.id),
    state: text(row.state),
    botId: text(row.botId ?? '', true),
    groupId: text(row.groupId ?? '', true),
    platform: text(row.platform ?? '', true)
  }
  if (row.attempts !== undefined) result.attempts = integer(row.attempts)
  for (const key of ['createdAt', 'updatedAt', 'nextRetryAt', 'leaseUntil'] as const)
    if (row[key] !== undefined) result[key] = timestamp(row[key])
  if (row.lastError !== undefined) result.lastError = text(row.lastError, true)
  if (row.receiptMessageId !== undefined) result.receiptMessageId = text(row.receiptMessageId, true)
  if (row.uncertain !== undefined) result.uncertain = boolean(row.uncertain)
  if (row.runtimeConfirmed !== undefined) result.runtimeConfirmed = boolean(row.runtimeConfirmed)
  return result
}
export function parsePipelineSnapshot(value: unknown): PipelineSnapshot {
  const raw = object(value),
    retention = object(raw.retention)
  if (!Array.isArray(raw.jobs) || raw.jobs.length > 100) return fail()
  const returned = integer(raw.returned),
    scanTruncated = boolean(raw.scanTruncated)
  if (returned !== raw.jobs.length) return fail()
  if (raw.mode === 'standalone') {
    if (raw.version !== 1 || retention.inbox !== 'until-acknowledged') return fail()
    return {
      mode: 'standalone',
      version: 1,
      observedAt: timestamp(raw.observedAt),
      returned,
      scanTruncated,
      jobs: raw.jobs.map(coreJob),
      retention: {
        inbox: 'until-acknowledged',
        textQueueIdleSeconds: integer(retention.textQueueIdleSeconds),
        mediaRecordIdleSeconds: integer(retention.mediaRecordIdleSeconds),
        mediaTaskLifetimeSeconds: integer(retention.mediaTaskLifetimeSeconds)
      }
    }
  }
  if (raw.mode !== undefined && raw.mode !== 'legacy') return fail()
  return {
    mode: 'legacy',
    returned,
    scanTruncated,
    jobs: raw.jobs.map(legacyJob),
    retention: {
      eventMinutes: integer(retention.eventMinutes),
      deliveryHours: integer(retention.deliveryHours)
    }
  }
}
export function pipelineStatusOptions(mode: PipelineMode) {
  const names: Record<string, string> =
    mode === 'standalone' ? corePipelineStates : mode === 'legacy' ? legacyPipelineStates : {}
  return [
    { label: '全部状态', value: 'all' },
    ...Object.entries(names).map(([value, label]) => ({ value, label }))
  ]
}
export function pipelineStateLabel(job: PipelineJob) {
  const names: Record<string, string> =
    job.mode === 'standalone' ? corePipelineStates : legacyPipelineStates
  return names[job.state] || job.state
}
export function pipelineConversationLabel(job: CoreInboxJob | CoreMediaJob) {
  return conversationAddressLabel({ ...job.conversation, account: job.account })
}
export function pipelineAccountLabel(job: CoreInboxJob | CoreMediaJob) {
  return accountLabel(job.account)
}
export function pipelineTime(value: number | undefined) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'
}
export function pipelineDuration(seconds: number) {
  for (const [unit, size] of [['天', 86400], ['小时', 3600], ['分钟', 60]] as const)
    if (seconds >= size && seconds % size === 0) return `${seconds / size} ${unit}`
  return `${seconds} 秒`
}
export const pipelineEffectNames: Record<CoreMediaJob['effects'][number]['effect'], string> = {
  forward: '合并转发',
  forwardRetry: '合并转发重试',
  directIntro: '介绍消息',
  directVideo: '视频直发',
  link: '链接回退'
}
export const pipelineEffectStates: Record<CoreMediaJob['effects'][number]['state'], string> = {
  pending: '结果待确认',
  sent: '已发送',
  failed: '失败',
  unknown: '结果未知'
}
