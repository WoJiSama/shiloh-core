import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { FileDeliveryReceipt } from '../contracts/agentFileDelivery.js'
import type { SendAudioFileAction } from '../contracts/agentMusicExtraction.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentAudioAttachment } from '../modules/media/infrastructure/agentAudioAttachment.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId } from './qqIdentity.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

type AudioFileUploadApi = 'upload_group_file' | 'upload_private_file'
export const QQ_AUDIO_FILE_SEND_TIMEOUT_MS = 180_000
function plainData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function targetValid(target: ConversationAddress): boolean {
  return plainData(target, ['account', 'kind', 'id']) && plainData(target.account, ['platform', 'namespace', 'id']) &&
    target.account.platform === 'qq' && target.account.namespace === 'global' && typeof target.account.id === 'string' &&
    qqId(target.account.id) === target.account.id && typeof target.id === 'string' && qqId(target.id) === target.id &&
    (target.kind === 'group' || target.kind === 'private' && target.id !== target.account.id)
}
function bindingValid(binding: AgentBindingSnapshot, targetKey: string, connectionId?: string): boolean {
  return plainData(binding, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target']) &&
    (binding.source === 'configured' || binding.source === 'legacy') &&
    [binding.id, binding.revision, binding.personaId, binding.agentId, binding.connectionId].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)) &&
    targetValid(binding.target) && conversationAddressKey(binding.target) === targetKey &&
    (connectionId === undefined || binding.connectionId === connectionId)
}
function failed(code: string): FileDeliveryReceipt { return { state: 'failed', code } }
function responseReceipt(value: unknown, target: ConversationAddress): FileDeliveryReceipt {
  const rejection = qqDeliveryRejection(value)
  if (rejection) return rejection
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown' }
  const response = value as Record<string, unknown>, detail = response.data
  if (response.status !== 'ok' || response.retcode !== 0 || !detail || typeof detail !== 'object' || Array.isArray(detail)) return { state: 'unknown' }
  const data = detail as Record<string, unknown>, fileId = data.file_id
  if (typeof fileId !== 'string' || !fileId || fileId.length > 1024 || /[\u0000-\u0020\u007f]/u.test(fileId)) return { state: 'unknown' }
  for (const row of [response, data]) {
    if (row.self_id !== undefined && String(row.self_id) !== target.account.id ||
        row.group_id !== undefined && (target.kind !== 'group' || String(row.group_id) !== target.id) ||
        row.user_id !== undefined && (target.kind !== 'private' || String(row.user_id) !== target.id)) return { state: 'unknown' }
  }
  return { state: 'uploaded', fileId }
}

/** One fixed-conversation upload of validated complete audio bytes; never a playable-record fallback. */
export function createQqAudioFileDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  sendApi(action: AudioFileUploadApi, params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<MessageActionPort['sendAudioFile']> {
  const accountKey = platformAccountKey(options.account)
  return async (action: SendAudioFileAction, guard: MessageActionOptions & { readonly signal?: AbortSignal } = {}) => {
    const input = action, check = guard.isCurrent
    let target: ConversationAddress, targetKey: string, bindingKey: string | undefined
    let attachment: ReturnType<typeof validateAgentAudioAttachment>
    try {
      if (!plainData(action, ['version', 'kind', 'target', 'attachment', 'binding']) || action.version !== 1 || action.kind !== 'audio-file.upload' ||
          !targetValid(action.target) || platformAccountKey(action.target.account) !== accountKey) return failed('invalid_audio_file_target')
      targetKey = conversationAddressKey(action.target)
      if (action.binding !== undefined) {
        if (!bindingValid(action.binding, targetKey, options.connectionId)) return failed('binding_target_mismatch')
        bindingKey = JSON.stringify(action.binding)
      }
      attachment = validateAgentAudioAttachment(action.attachment)
      target = Object.freeze({ ...action.target, account: Object.freeze({ ...action.target.account }) })
    } catch { return failed('invalid_audio_attachment') }
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(QQ_AUDIO_FILE_SEND_TIMEOUT_MS), ...(guard.signal ? [guard.signal] : [])])
    const isCurrent = () => {
      try {
        return !signal.aborted && check?.() !== false && platformAccountKey(options.account) === accountKey &&
          plainData(input, ['version', 'kind', 'target', 'attachment', 'binding']) && targetValid(input.target) &&
          conversationAddressKey(input.target) === targetKey &&
          (input.binding === undefined || bindingValid(input.binding, targetKey, options.connectionId)) && JSON.stringify(input.binding) === bindingKey
      } catch { return false }
    }
    if (!isCurrent()) return failed('binding_changed')
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    let abort: (() => void) | undefined
    try {
      const params = Object.freeze({ [target.kind === 'group' ? 'group_id' : 'user_id']: target.id,
        file: `base64://${attachment.base64}`, name: attachment.name,
      })
      if (!isCurrent()) return failed('binding_changed')
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('QQ audio file upload outcome unknown'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          if (!isCurrent()) throw new Error('QQ audio file upload outcome unknown')
          return withDeliveryGuard(isCurrent, () => options.sendApi(target.kind === 'group' ? 'upload_group_file' : 'upload_private_file', params, { isCurrent, signal }))
        }).then(resolve, reject)
      })
      return isCurrent() ? responseReceipt(result, target) : { state: 'unknown' as const }
    } catch { return { state: 'unknown' as const } }
    finally {
      if (abort) signal.removeEventListener('abort', abort)
      clearInterval(timer)
      cancel.abort()
    }
  }
}
