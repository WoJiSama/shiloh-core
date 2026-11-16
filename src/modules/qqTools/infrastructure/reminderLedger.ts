import type { ReminderAction, ReminderData, ReminderPending } from '../../../contracts/reminder.js'

export const REMINDER_KEY_PREFIX = 'bl-chat:reminder:'
export const REMINDER_PENDING_KEY = `${REMINDER_KEY_PREFIX}pending:list`
export const REMINDER_LOCK_KEY = `${REMINDER_KEY_PREFIX}lock`

export function reminderDetailKey(id: string): string {
  return `${REMINDER_KEY_PREFIX}detail:${id}`
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function decodeReminderAction(value: unknown): ReminderAction | null {
  const action = record(value)
  return typeof action.tool === 'string' ? { tool: action.tool, params: record(action.params) } : null
}

export function decodeReminder(data: string): ReminderData {
  const r = record(JSON.parse(data))
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string' || typeof r.content !== 'string' ||
      typeof r.trigger_time !== 'number' || !Number.isFinite(r.trigger_time)) throw new Error('提醒详情损坏')
  const status = r.status
  if (status !== 'pending' && status !== 'sending' && status !== 'unknown' && status !== 'failed' &&
      status !== 'completed' && status !== 'cancelled') throw new Error('提醒状态无效')
  const bindingIdentity = r.bindingIdentity
  if (bindingIdentity !== undefined && (typeof bindingIdentity !== 'string' || !bindingIdentity || bindingIdentity.length > 4_096)) {
    throw new Error('提醒绑定无效')
  }
  const receipt = record(r.delivery)
  const delivery: ReminderData['delivery'] = receipt.state === 'sent' && typeof receipt.messageId === 'string' && receipt.messageId
    ? { state: 'sent', messageId: receipt.messageId }
    : receipt.state === 'failed' ? { state: 'failed', code: typeof receipt.code === 'string' ? receipt.code : null } : { state: 'unknown' }
  return {
    id: r.id, user_id: r.user_id, group_id: r.group_id ? String(r.group_id) : null, bot_id: String(r.bot_id || ''),
    message_id: typeof r.message_id === 'string' || typeof r.message_id === 'number' ? r.message_id : null,
    content: r.content, reminder_message: typeof r.reminder_message === 'string' ? r.reminder_message : null,
    trigger_time: r.trigger_time, created_at: Number(r.created_at) || 0, status,
    extra_action: decodeReminderAction(r.extra_action), extra_attempted: r.extra_attempted === true,
    retry_count: Number(r.retry_count) || 0, delivery, updated_at: Number(r.updated_at) || Number(r.created_at) || 0,
    ...(bindingIdentity ? { bindingIdentity } : {}), ...(r.waitingForBinding === true ? { waitingForBinding: true } : {}),
  }
}

export function decodeReminderPendingList(data: string | null): ReminderPending[] {
  if (!data) return []
  const parsed: unknown = JSON.parse(data)
  if (!Array.isArray(parsed)) throw new Error('提醒列表损坏，停止修改')
  return parsed.map(value => {
    const item = record(value)
    if (typeof item.id !== 'string' || typeof item.trigger_time !== 'number' || !Number.isFinite(item.trigger_time)) {
      throw new Error('提醒索引损坏')
    }
    return { id: item.id, trigger_time: item.trigger_time }
  })
}

export function reminderText(reminder: Pick<ReminderData, 'reminder_message' | 'content'>): string {
  return reminder.reminder_message || `提醒你：${reminder.content}`
}
