import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentDiagnosticDetails } from '../../../contracts/agentDiagnostics.js'

export interface DeliveryFailureEvidence { readonly code: string; readonly details: AgentDiagnosticDetails }
type FailedDelivery = Exclude<DeliveryReceipt, { state: 'sent' }>
const failures = new WeakMap<object, DeliveryFailureEvidence>()

/** Keep adapter diagnostics on the host while preserving the delivery receipt contract. */
export function annotateDeliveryFailure<T extends FailedDelivery>(receipt: T, evidence: DeliveryFailureEvidence): T {
  failures.set(receipt, evidence)
  return Object.freeze(receipt)
}

export function deliveryFailureEvidence(value: unknown): DeliveryFailureEvidence | undefined {
  return value && typeof value === 'object' ? failures.get(value) : undefined
}

export function validDeliveryMessageId(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== '0'
}

/** Compatibility decoding for existing QQ/tool callers. New transports return DeliveryReceipt directly. */
export function normalizeDeliveryReceipt(value: unknown): DeliveryReceipt {
  if (value === false) return { state: 'failed', code: null }
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return { state: 'unknown' }
  if (deliveryFailureEvidence(value)) return value as FailedDelivery
  const status = 'status' in value ? value.status : undefined
  const code = 'retcode' in value ? value.retcode : undefined
  const state = 'state' in value ? value.state : undefined
  if (state === 'failed' || status === 'failed' || ('success' in value && value.success === false) || (code != null && Number(code) !== 0)) {
    const failure = code ?? ('code' in value ? value.code : null)
    return { state: 'failed', code: typeof failure === 'string' || typeof failure === 'number' ? String(failure) : null }
  }
  if (state === 'unknown' || status === 'unknown' || ('unknown' in value && value.unknown === true)) return { state: 'unknown' }
  if ('ok' in value && value.ok === false) return { state: 'failed', code: null }
  const data = 'data' in value && value.data && typeof value.data === 'object' ? value.data : value
  const id = ('message_id' in data ? data.message_id : undefined) ??
    ('message_id' in value ? value.message_id : undefined) ?? ('messageId' in value ? value.messageId : undefined)
  if (validDeliveryMessageId(id)) return { state: 'sent', messageId: String(id) }
  return { state: 'unknown' }
}
