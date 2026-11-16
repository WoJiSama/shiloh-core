import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { FileDeliveryReceipt, SendFileAction } from '../contracts/agentFileDelivery.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentFileUpload } from '../modules/messaging/infrastructure/agentFileDelivery.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId } from './qqIdentity.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

type FileUploadApi = 'upload_group_file' | 'upload_private_file'
type FileSendOptions = MessageActionOptions & { readonly signal?: AbortSignal }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function plainData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function targetValid(target: ConversationAddress): boolean {
  return plainData(target, ['account', 'kind', 'id']) && plainData(target.account, ['platform', 'namespace', 'id']) &&
    target.account.platform === 'qq' && target.account.namespace === 'global' && qqId(target.account.id) === target.account.id &&
    qqId(target.id) === target.id && (target.kind === 'group' || target.kind === 'private')
}
function failed(code: string): FileDeliveryReceipt { return { state: 'failed', code } }
function fileId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\u0000-\u0020\u007f]/u.test(value)
}
function responseReceipt(value: unknown, target: ConversationAddress): FileDeliveryReceipt {
  const response = record(value), data = record(response.data)
  const rejection = qqDeliveryRejection(value)
  if (rejection) return rejection
  if (response.status !== 'ok' || response.retcode !== 0 || !fileId(data.file_id)) return { state: 'unknown' }
  for (const row of [response, data]) {
    if (row.self_id !== undefined && String(row.self_id) !== target.account.id ||
        row.group_id !== undefined && (target.kind !== 'group' || String(row.group_id) !== target.id) ||
        row.user_id !== undefined && (target.kind !== 'private' || String(row.user_id) !== target.id)) return { state: 'unknown' }
  }
  // NapCat's real upload endpoints return fileUuid only, even though they also send a file message.
  // The UUID proves a confirmed upload; it is never a normal message identifier.
  return { state: 'uploaded', fileId: data.file_id }
}

/** Native upload parameters are constructed from owned bytes and a captured, complete QQ target. */
export function createQqFileDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  sendApi(action: FileUploadApi, params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<MessageActionPort['sendFile']> {
  const accountKey = platformAccountKey(options.account)
  return async (action: SendFileAction, guard: FileSendOptions = {}): Promise<FileDeliveryReceipt> => {
    let target: ConversationAddress, targetKey: string, bindingKey: string | undefined
    let file: ReturnType<typeof validateAgentFileUpload>
    const input = action, check = guard.isCurrent
    try {
      if (!plainData(action, ['version', 'kind', 'target', 'file', 'binding']) || action.version !== 1 || action.kind !== 'file.upload' ||
          !targetValid(action.target) || platformAccountKey(action.target.account) !== accountKey) return failed('invalid_file_target')
      targetKey = conversationAddressKey(action.target)
      if (action.binding) {
        if (!plainData(action.binding, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target']) ||
            !targetValid(action.binding.target) || conversationAddressKey(action.binding.target) !== targetKey ||
            options.connectionId !== undefined && action.binding.connectionId !== options.connectionId) return failed('binding_target_mismatch')
        bindingKey = JSON.stringify(action.binding)
      }
      file = validateAgentFileUpload(action.file)
      target = Object.freeze({ ...action.target, account: Object.freeze({ ...action.target.account }) })
    } catch { return failed('invalid_file_upload') }
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(20_000), ...(guard.signal ? [guard.signal] : [])])
    const isCurrent = () => {
      try {
        return !signal.aborted && check?.() !== false && platformAccountKey(options.account) === accountKey &&
          conversationAddressKey(input.target) === targetKey && JSON.stringify(input.binding) === bindingKey
      } catch { return false }
    }
    if (!isCurrent()) return failed('binding_changed')
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    let abort: (() => void) | undefined
    try {
      // No user path, source URL, folder, actor or extra upload options enter the native request.
      const params = Object.freeze({ [target.kind === 'group' ? 'group_id' : 'user_id']: target.id,
        file: `base64://${file.base64}`, name: file.name,
      })
      if (!isCurrent()) return failed('binding_changed')
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('QQ file upload outcome unknown'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          if (!isCurrent()) throw new Error('QQ file upload outcome unknown')
          return withDeliveryGuard(isCurrent, () => options.sendApi(target.kind === 'group' ? 'upload_group_file' : 'upload_private_file', params, { isCurrent, signal }))
        }).then(resolve, reject)
      })
      if (!isCurrent()) return { state: 'unknown' }
      return responseReceipt(result, target)
    } catch { return { state: 'unknown' } }
    finally {
      if (abort) signal.removeEventListener('abort', abort)
      clearInterval(timer)
      cancel.abort()
    }
  }
}
