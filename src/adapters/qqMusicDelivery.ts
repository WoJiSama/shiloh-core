import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { SendMusicAction } from '../contracts/agentMusic.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentMusicCard } from '../modules/media/infrastructure/agentMusicCard.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId } from './qqIdentity.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

type MusicSendOptions = MessageActionOptions & { readonly signal?: AbortSignal }
export const QQ_MUSIC_SEND_TIMEOUT_MS = 30_000

function plainData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function targetValid(target: ConversationAddress): boolean {
  return plainData(target, ['account', 'kind', 'id']) && plainData(target.account, ['platform', 'namespace', 'id']) &&
    target.account.platform === 'qq' && target.account.namespace === 'global' && typeof target.account.id === 'string' &&
    qqId(target.account.id) === target.account.id && typeof target.id === 'string' && qqId(target.id) === target.id && target.kind === 'group'
}
function bindingValid(binding: AgentBindingSnapshot, targetKey: string, connectionId?: string): boolean {
  return plainData(binding, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target']) &&
    (binding.source === 'configured' || binding.source === 'legacy') &&
    [binding.id, binding.revision, binding.personaId, binding.agentId, binding.connectionId].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)) &&
    targetValid(binding.target) && conversationAddressKey(binding.target) === targetKey &&
    (connectionId === undefined || binding.connectionId === connectionId)
}
function providerCard(card: ReturnType<typeof validateAgentMusicCard>, accountId: string): boolean {
  const page = new URL(card.pageUrl), cover = new URL(card.coverUrl), audio = new URL(card.audioUrl)
  const mid = /^\/n\/yqq\/song\/([A-Za-z0-9]{1,80})\.html$/u.exec(page.pathname)?.[1]
  if (page.protocol !== 'https:' || page.hostname !== 'y.qq.com' || page.port || page.search || !mid || card.pageUrl !== `https://y.qq.com${page.pathname}` ||
      cover.hostname !== 'y.gtimg.cn' || cover.port || cover.search ||
      !/^\/music\/photo_new\/(?:T062R150x150M000|T002R150x150M000|T001R150x150M000)[A-Za-z0-9]{1,80}\.jpg$/u.test(cover.pathname) ||
      card.coverUrl !== `${cover.origin}${cover.pathname}` || audio.port || card.audioUrl !== audio.href) return false
  const keys = [...audio.searchParams.keys()]
  if (new Set(keys).size !== keys.length) return false
  if (audio.hostname === 'c6.y.qq.com') return audio.pathname === '/rsc/fcgi-bin/fcg_pyq_play.fcg' && keys.length === 6 &&
    keys.every(key => ['songid', 'songmid', 'songtype', 'fromtag', 'uin', 'code'].includes(key)) &&
    audio.searchParams.get('songid') === '' && audio.searchParams.get('songmid') === mid &&
    audio.searchParams.get('songtype') === '1' && audio.searchParams.get('fromtag') === '50' &&
    audio.searchParams.get('uin') === accountId && /^[A-F0-9]{5}$/u.test(audio.searchParams.get('code') ?? '')
  if (audio.hostname !== 'ws.stream.qqmusic.qq.com' ||
      !/^\/[A-Za-z0-9_-]{1,180}\.(?:mp3|m4a|flac|ogg|aac|ape)$/u.test(audio.pathname) ||
      !keys.every(key => ['vkey', 'guid', 'uin', 'fromtag'].includes(key))) return false
  for (const [key, value] of audio.searchParams) {
    if (key === 'vkey' ? !/^[A-Za-z0-9_-]{1,2048}$/u.test(value) : key === 'guid' ? !/^[A-Za-z0-9]{1,80}$/u.test(value) : !/^\d{1,80}$/u.test(value)) return false
  }
  return true
}
function failed(code: string): DeliveryReceipt { return { state: 'failed', code } }
function responseReceipt(value: unknown, target: ConversationAddress): DeliveryReceipt {
  const rejection = qqDeliveryRejection(value)
  if (rejection) return rejection
  if (!value || typeof value !== 'object') return { state: 'unknown' }
  const response = value as Record<string, unknown>, data = response.data
  if (response.status !== 'ok' || response.retcode !== 0 || !data || typeof data !== 'object') return { state: 'unknown' }
  const detail = data as Record<string, unknown>, id = detail.message_id
  if (!(typeof id === 'number' && Number.isSafeInteger(id) && id !== 0 ||
      typeof id === 'string' && /^-?[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)))) return { state: 'unknown' }
  for (const row of [response, detail]) {
    if (row.self_id !== undefined && String(row.self_id) !== target.account.id ||
        row.group_id !== undefined && String(row.group_id) !== target.id || row.user_id !== undefined) return { state: 'unknown' }
  }
  return { state: 'sent', messageId: String(id) }
}

/** One fixed-group custom music segment. NapCat's signer retries/redirects remain outside this adapter's control. */
export function createQqMusicDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  sendApi(action: 'send_group_msg', params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<MessageActionPort['sendMusic']> {
  const accountKey = platformAccountKey(options.account)
  return async (action: SendMusicAction, guard: MusicSendOptions = {}): Promise<DeliveryReceipt> => {
    const input = action, check = guard.isCurrent
    let target: ConversationAddress, targetKey: string, bindingKey: string | undefined
    let card: ReturnType<typeof validateAgentMusicCard>
    try {
      if (!plainData(action, ['version', 'kind', 'target', 'music', 'binding']) || action.version !== 1 || action.kind !== 'music.send' ||
          !targetValid(action.target) || platformAccountKey(action.target.account) !== accountKey) return failed('invalid_music_target')
      targetKey = conversationAddressKey(action.target)
      if (action.binding !== undefined) {
        if (!bindingValid(action.binding, targetKey, options.connectionId)) return failed('binding_target_mismatch')
        bindingKey = JSON.stringify(action.binding)
      }
      card = validateAgentMusicCard(action.music)
      if (!providerCard(card, action.target.account.id)) return failed('invalid_music_provider')
      target = Object.freeze({ ...action.target, account: Object.freeze({ ...action.target.account }) })
    } catch { return failed('invalid_music_card') }
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(QQ_MUSIC_SEND_TIMEOUT_MS), ...(guard.signal ? [guard.signal] : [])])
    const isCurrent = () => {
      try {
        return !signal.aborted && check?.() !== false && platformAccountKey(options.account) === accountKey &&
          plainData(input, ['version', 'kind', 'target', 'music', 'binding']) && targetValid(input.target) &&
          conversationAddressKey(input.target) === targetKey &&
          (input.binding === undefined || bindingValid(input.binding, targetKey, options.connectionId)) && JSON.stringify(input.binding) === bindingKey
      } catch { return false }
    }
    if (!isCurrent()) return failed('binding_changed')
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    let abort: (() => void) | undefined
    try {
      const segment = Object.freeze({ type: 'music', data: Object.freeze({ type: 'custom', url: card.pageUrl, audio: card.audioUrl,
        title: card.title, image: card.coverUrl, content: card.artist ?? '',
      }) })
      const params = Object.freeze({ group_id: target.id, message: Object.freeze([segment]) })
      if (!isCurrent()) return failed('binding_changed')
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('QQ music send outcome unknown'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          if (!isCurrent()) throw new Error('QQ music send outcome unknown')
          return withDeliveryGuard(isCurrent, () => options.sendApi('send_group_msg', params, { isCurrent, signal }))
        }).then(resolve, reject)
      })
      return isCurrent() ? responseReceipt(result, target) : { state: 'unknown' }
    } catch { return { state: 'unknown' } }
    finally {
      if (abort) signal.removeEventListener('abort', abort)
      clearInterval(timer)
      cancel.abort()
    }
  }
}
