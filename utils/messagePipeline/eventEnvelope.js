import { createEventEnvelope as createTypedEnvelope } from '../../dist/backend/modules/messaging/infrastructure/eventEnvelope.js'
import { decodeQqRecall, qqRecallKind } from '../../dist/backend/adapters/qqMessage.js'
import { soleQqAccountId } from '../../dist/backend/adapters/qqIdentity.js'
export { envelopeToRuntimeEvent, isEnvelopeFromBot } from '../../dist/backend/modules/messaging/infrastructure/eventEnvelope.js'

export function createEventEnvelope(event = {}, postType = '') {
  if ((postType || event?.post_type || 'notice') !== 'notice' || !qqRecallKind(event)) {
    return createTypedEnvelope(event, postType, globalThis.Bot?.uin)
  }
  // Decode the original event before the envelope discards the attached bot.
  const recall = decodeQqRecall(event, () => soleQqAccountId(globalThis.Bot))
  if (!recall) throw new Error('QQ 撤回通知的账号、会话或消息 ID 无法核实')
  return createTypedEnvelope(event, postType, recall.target.account.id)
}
