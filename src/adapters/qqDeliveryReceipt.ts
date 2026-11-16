import type { DeliveryReceipt } from '../contracts/delivery.js'
import { normalizeDeliveryReceipt } from '../modules/messaging/domain/deliveryReceipt.js'

/** NapCat HTTP/Debug and WS distinguish schema rejection (400/1400) from handler exceptions (200/1200).
 * A handler can time out after native send, so its error is not evidence of non-delivery. */
export function qqDeliveryRejection(value: unknown): Exclude<DeliveryReceipt, { state: 'sent' }> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const response = value as Record<string, unknown>
  if (response.state === 'unknown') return { state: 'unknown' }
  // This internal transport marker is only constructed before native dispatch.
  if (response.state === 'failed') return { state: 'failed', code: typeof response.code === 'string' ? response.code.slice(0, 128) : null }
  const code = response.retcode
  if (code === 400 || code === 1400) return { state: 'failed', code: String(code) }
  if (response.status === 'failed' || code !== undefined && code !== 0) return { state: 'unknown' }
  return undefined
}

/** Keep legacy successful host reply shapes, while classifying native handler ambiguity here. */
export function normalizeQqDeliveryReceipt(value: unknown): DeliveryReceipt {
  return qqDeliveryRejection(value) ?? normalizeDeliveryReceipt(value)
}
