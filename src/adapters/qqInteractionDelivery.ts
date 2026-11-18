import { types } from 'node:util'
import type { PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentInteraction, InteractionReceipt, SendInteractionAction } from '../contracts/agentInteraction.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import type { ConversationMember } from '../contracts/platformConnection.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { validateSendInteractionAction } from '../modules/tools/infrastructure/agentInteractions.js'
import { canApplyGroupManagement } from '../modules/tools/domain/agentGroupManagement.js'
import { qqId } from './qqIdentity.js'
import { proveQqFriend, proveQqOwnMessage } from './qqOwnMessageProof.js'

type Options = MessageActionOptions & { readonly signal?: AbortSignal }
export type QqInteractionApiAction = 'get_group_member_info' | 'get_friend_list' | 'get_msg' | 'send_group_poke' | 'send_like' | 'set_msg_emoji_like' | 'delete_msg' | 'set_group_ban' | 'set_group_whole_ban' | 'set_group_card'
export interface QqInteractionApiOptions {
  readonly isCurrent: () => boolean
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** Also usable after a transport-owned asynchronous queue. */
  ensureCurrent(): Promise<void>
}
export const QQ_INTERACTION_TIMEOUT_MS = 30_000
const failed = (code: string): InteractionReceipt => ({ state: 'failed', code })
const unknown = (): InteractionReceipt => ({ state: 'unknown' })
const invalid = () => Error('Invalid QQ interaction')

function data(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    row[key] = field.value
  }
  return row
}
function account(input: unknown): Readonly<PlatformAccountRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw invalid()
  return Object.freeze({ platform: 'qq', namespace: 'global', id: row.id })
}
function nativeId(input: unknown): string | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) || typeof input === 'string'
    ? qqId(input) === String(input) ? String(input) : undefined : undefined
}
function messageId(input: unknown): input is string {
  return typeof input === 'string' && /^-?[1-9]\d{0,9}$/u.test(input) && Number(input) >= -2_147_483_648 && Number(input) <= 2_147_483_647
}
function action(input: unknown, expectedAccount: string, connectionId: string): Readonly<SendInteractionAction> {
  const selected = validateSendInteractionAction(input), { target, binding, interaction } = selected
  if (platformAccountKey(account(target.account)) !== expectedAccount || qqId(target.id) !== target.id || binding.connectionId !== connectionId) throw invalid()
  if (target.kind === 'private' && (target.id === target.account.id || interaction.kind !== 'message-recall' &&
      (interaction.kind !== 'profile-like' || interaction.user.id !== target.id))) throw invalid()
  if (interaction.kind === 'message-reaction' || interaction.kind === 'message-recall') {
    if (!messageId(interaction.messageId)) throw invalid()
  } else if (interaction.kind !== 'group-mute') account(interaction.user)
  if ('requester' in interaction) {
    account(interaction.requester)
    if (target.kind !== 'group') throw invalid()
  }
  return selected
}
function nativeScope(row: Record<string, unknown>, selected: SendInteractionAction, userId?: string): boolean {
  return (row.self_id === undefined || nativeId(row.self_id) === selected.target.account.id) &&
    (row.group_id === undefined || selected.target.kind === 'group' && nativeId(row.group_id) === selected.target.id) &&
    (selected.target.kind !== 'private' || row.target_id === undefined || nativeId(row.target_id) === selected.target.id) &&
    (row.user_id === undefined || userId !== undefined && nativeId(row.user_id) === userId)
}
function memberEvidence(input: unknown, selected: SendInteractionAction, interaction: Extract<AgentInteraction, { kind: 'poke' | 'profile-like' }>): string {
  const response = data(input), member = data(response.data)
  if (response.status !== 'ok' || response.retcode !== 0 || !nativeScope(response, selected, interaction.user.id) ||
      !nativeScope(member, selected, interaction.user.id) || nativeId(member.group_id) !== selected.target.id || nativeId(member.user_id) !== interaction.user.id) throw invalid()
  return interaction.user.id
}
function managementNativeScope(row: Record<string, unknown>, selected: SendInteractionAction, id: string): boolean {
  return (!Object.hasOwn(row, 'self_id') || nativeId(row.self_id) === selected.target.account.id) &&
    (!Object.hasOwn(row, 'group_id') || nativeId(row.group_id) === selected.target.id) &&
    (!Object.hasOwn(row, 'user_id') || nativeId(row.user_id) === id)
}
function managementMemberEvidence(input: unknown, selected: SendInteractionAction, id: string): ConversationMember {
  const response = data(input), member = data(response.data)
  if (response.status !== 'ok' || response.retcode !== 0 || !managementNativeScope(response, selected, id) ||
      !managementNativeScope(member, selected, id) || nativeId(member.group_id) !== selected.target.id || nativeId(member.user_id) !== id ||
      member.role !== 'owner' && member.role !== 'admin' && member.role !== 'member') throw invalid()
  return Object.freeze({ user: Object.freeze({ platform: 'qq', namespace: 'global', id }), displayName: id, role: member.role })
}
function managementReceiptScope(row: Record<string, unknown>, selected: SendInteractionAction): boolean {
  const operation = selected.interaction
  if (!('requester' in operation)) return true
  const userId = operation.kind === 'group-mute' ? operation.requester.id : operation.user.id
  return managementNativeScope(row, selected, userId) &&
    (!Object.hasOwn(row, 'requester_id') || nativeId(row.requester_id) === operation.requester.id) &&
    (!Object.hasOwn(row, 'target_id') || nativeId(row.target_id) === selected.target.id) &&
    (!Object.hasOwn(row, 'duration') || operation.kind === 'member-mute' && row.duration === operation.seconds) &&
    (!Object.hasOwn(row, 'enable') || operation.kind === 'group-mute' && row.enable === operation.enabled) &&
    (!Object.hasOwn(row, 'card') || operation.kind === 'member-card' && row.card === operation.name) &&
    !Object.hasOwn(row, 'message_id') && !Object.hasOwn(row, 'messageId')
}
function messageEvidence(input: unknown, selected: SendInteractionAction, interaction: Extract<AgentInteraction, { kind: 'message-reaction' }>): string {
  const response = data(input), message = data(response.data), sender = data(message.sender), author = nativeId(message.user_id)
  const id = typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id) || typeof message.message_id === 'string' ? String(message.message_id) : undefined
  if (response.status !== 'ok' || response.retcode !== 0 || message.message_type !== 'group' ||
      nativeId(message.group_id) !== selected.target.id || !id || !messageId(id) || id !== interaction.messageId || !author || nativeId(sender.user_id) !== author ||
      !nativeScope(response, selected, author) || !nativeScope(message, selected, author) ||
      typeof message.time !== 'number' || !Number.isSafeInteger(message.time) || message.time <= 0 || message.time > Math.floor(Date.now() / 1000) + 60 ||
      message.post_type !== undefined && message.post_type !== 'message') throw invalid()
  return author
}
function receipt(input: unknown, selected: SendInteractionAction, userId: string): InteractionReceipt {
  try {
    const row = data(input)
    // Only the transport constructs these markers, before native dispatch.
    if (row.state === 'failed' && Object.keys(row).every(key => key === 'state' || key === 'code')) {
      return failed(typeof row.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(row.code) ? row.code : 'native_rejected')
    }
    if (row.state !== undefined) return unknown()
    if (row.retcode === 400 || row.retcode === 1400) return failed(String(row.retcode))
    if (row.status !== 'ok' || row.retcode !== 0 || !nativeScope(row, selected, userId) || !managementReceiptScope(row, selected)) return unknown()
    const detail = row.data === undefined || row.data === null ? undefined : data(row.data)
    if (detail && (!nativeScope(detail, selected, userId) || !managementReceiptScope(detail, selected))) return unknown()
    const operation = selected.interaction
    if (operation.kind === 'message-recall') for (const value of [row, detail]) {
      const reported = value?.message_id
      if (reported !== undefined && (!(typeof reported === 'number' && Number.isSafeInteger(reported) || typeof reported === 'string') ||
          String(reported) !== operation.messageId)) return unknown()
    }
    return { state: 'confirmed' }
  } catch { return unknown() }
}
function signal(input: unknown): AbortSignal {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== AbortSignal.prototype) throw invalid()
  // An own override must not replace the native signal accessors or event methods.
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key === 'string' || !field || !Object.hasOwn(field, 'value') || types.isProxy(field.value)) throw invalid()
  }
  // Check the native brand without invoking an input-provided accessor.
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(input)
  return input as AbortSignal
}

/** One proven group or current-friend interaction on the original connection, with no retry. */
export function createQqInteractionDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId: string
  readonly isReady: () => boolean
  callApi(action: QqInteractionApiAction, params: Record<string, unknown>, options: QqInteractionApiOptions): Promise<unknown>
}): NonNullable<MessageActionPort['interact']> {
  const configured = data(options, ['account', 'connectionId', 'isReady', 'callApi']), configuredAccount = configured.account
  const accountKey = platformAccountKey(account(configuredAccount)), connectionId = configured.connectionId
  if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128 || /[\u0000-\u001f\u007f]/u.test(connectionId) ||
      typeof configured.isReady !== 'function' || types.isProxy(configured.isReady) || typeof configured.callApi !== 'function' || types.isProxy(configured.callApi)) throw invalid()
  const isReady = configured.isReady as () => boolean, callApi = configured.callApi as typeof options.callApi
  return async (input: SendInteractionAction, guard: Options = {}): Promise<InteractionReceipt> => {
    let selected: Readonly<SendInteractionAction>, identity: string, check: (() => boolean) | undefined, parent: AbortSignal | undefined, ensure: (() => Promise<void>) | undefined
    try {
      selected = action(input, accountKey, connectionId); identity = JSON.stringify(selected)
      const scope = data(guard, ['isCurrent', 'signal', 'ensureCurrent'])
      if (scope.isCurrent !== undefined && (typeof scope.isCurrent !== 'function' || types.isProxy(scope.isCurrent)) ||
          scope.ensureCurrent !== undefined && (typeof scope.ensureCurrent !== 'function' || types.isProxy(scope.ensureCurrent))) throw invalid()
      check = scope.isCurrent as (() => boolean) | undefined; ensure = scope.ensureCurrent as (() => Promise<void>) | undefined
      if (scope.signal !== undefined) parent = signal(scope.signal)
    } catch { return failed('invalid_interaction') }
    const cancel = new AbortController(), combined = AbortSignal.any([cancel.signal, ...(parent ? [parent] : [])]), deadline = Date.now() + QQ_INTERACTION_TIMEOUT_MS
    const isCurrent = () => {
      try { return !combined.aborted && isReady() === true && (!check || check() === true) &&
        platformAccountKey(account(configuredAccount)) === accountKey && JSON.stringify(action(input, accountKey, connectionId)) === identity } catch { return false }
    }
    if (!isCurrent()) return failed('source_unavailable')
    const timer = setTimeout(() => cancel.abort(), QQ_INTERACTION_TIMEOUT_MS), watch = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    const ensureCurrent = async () => {
      if (!isCurrent()) throw invalid()
      await ensure?.()
      if (!isCurrent()) throw invalid()
    }
    let dispatched = false
    const invoke = (nativeAction: QqInteractionApiAction, params: Record<string, unknown>) => {
      if (!isCurrent()) throw invalid()
      return withDeliveryGuard(isCurrent, () => {
        if (nativeAction !== 'get_msg' && nativeAction !== 'get_group_member_info' && nativeAction !== 'get_friend_list') dispatched = true
        return callApi(nativeAction, Object.freeze(params), Object.freeze({ isCurrent, signal: combined,
          timeoutMs: Math.max(1, deadline - Date.now()), ensureCurrent }))
      })
    }
    let abort: (() => void) | undefined
    try {
      const result = await new Promise<{ response: unknown; userId: string }>((resolve, reject) => {
        abort = () => reject(invalid())
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) abort()
        Promise.resolve().then(async () => {
          await ensureCurrent()
          const interaction = selected.interaction
          let userId: string
          if (selected.target.kind === 'private') {
            const friends = await invoke('get_friend_list', {})
            if (!isCurrent() || !proveQqFriend(friends, selected.target)) throw invalid()
          }
          if ('requester' in interaction) {
            const readMember = async (id: string) => {
              await ensureCurrent()
              const proof = await invoke('get_group_member_info', { group_id: selected.target.id, user_id: id, no_cache: true })
              if (!isCurrent()) throw invalid()
              return managementMemberEvidence(proof, selected, id)
            }
            const requester = await readMember(interaction.requester.id), bot = await readMember(selected.target.account.id)
            const target = interaction.kind === 'group-mute' ? undefined : await readMember(interaction.user.id)
            if (!canApplyGroupManagement(interaction, requester, bot, target)) throw invalid()
            userId = interaction.kind === 'group-mute' ? interaction.requester.id : interaction.user.id
          } else if (interaction.kind === 'message-recall') {
            const proof = await invoke('get_msg', { message_id: Number(interaction.messageId) })
            if (!isCurrent() || !proveQqOwnMessage(proof, selected.target, interaction.messageId)) throw invalid()
            userId = selected.target.account.id
          } else if (interaction.kind === 'message-reaction') {
            const proof = await invoke('get_msg', { message_id: Number(interaction.messageId) })
            if (!isCurrent()) throw invalid()
            userId = messageEvidence(proof, selected, interaction)
          } else if (selected.target.kind === 'private' && interaction.kind === 'profile-like') {
            if (interaction.user.id !== selected.target.id) throw invalid()
            userId = interaction.user.id
          } else {
            const proof = await invoke('get_group_member_info', { group_id: selected.target.id, user_id: interaction.user.id, no_cache: true })
            if (!isCurrent()) throw invalid()
            userId = memberEvidence(proof, selected, interaction)
          }
          await ensureCurrent()
          if (!isCurrent()) throw invalid()
          const response = interaction.kind === 'member-mute' ? await invoke('set_group_ban', { group_id: selected.target.id, user_id: interaction.user.id, duration: interaction.seconds })
            : interaction.kind === 'group-mute' ? await invoke('set_group_whole_ban', { group_id: selected.target.id, enable: interaction.enabled })
              : interaction.kind === 'member-card' ? await invoke('set_group_card', { group_id: selected.target.id, user_id: interaction.user.id, card: interaction.name })
                : interaction.kind === 'message-recall' ? await invoke('delete_msg', { message_id: Number(interaction.messageId) })
            : interaction.kind === 'poke' ? await invoke('send_group_poke', { group_id: selected.target.id, user_id: interaction.user.id })
            : interaction.kind === 'profile-like' ? await invoke('send_like', { user_id: interaction.user.id, times: interaction.count })
              : await invoke('set_msg_emoji_like', { message_id: interaction.messageId, emoji_id: interaction.emojiId })
          return { response, userId }
        }).then(resolve, reject)
      })
      return isCurrent() ? receipt(result.response, selected, result.userId) : unknown()
    } catch { return dispatched ? unknown() : failed('source_unavailable') }
    finally { if (abort) combined.removeEventListener('abort', abort); clearTimeout(timer); clearInterval(watch); cancel.abort() }
  }
}
