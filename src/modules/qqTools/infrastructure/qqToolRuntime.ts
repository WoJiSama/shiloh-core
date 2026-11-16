import { findQqAccount, qqId, resolveQqConversationAddress } from '../../../adapters/qqIdentity.js'
import type { AgentBindingTurn } from '../../../contracts/agentBinding.js'
import { qqViewBot, qqViewRecord } from '../../../contracts/qqToolViews.js'
import type { QqViewEvent, QqViewPorts } from '../../../contracts/qqToolViews.js'
import type { QqToolBot, QqToolEvent, QqToolGroup, QqToolPorts } from '../../../contracts/qqTools.js'
import { queuedDeliveryAllowed, withDeliveryGuard } from '../../messaging/infrastructure/deliveryScope.js'
import { conversationAddressKey, isConversationAddress } from '../../runtime/domain/agentBindings.js'

export function asRecord(value:unknown):Record<string,unknown>{return value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{}}
export function errorText(error:unknown):string{return error instanceof Error?error.message:String(error)}
export function apiOk(value:unknown):boolean{const r=asRecord(value);return value===true || ((r.status==='ok'||r.retcode===0||r.code===0) && r.status!=='failed' && (r.retcode===undefined||r.retcode===0) && (r.code===undefined||r.code===0))}

export const qqToolBindingChanged = '角色绑定已改变，未执行后续 QQ 操作'

export class QqToolBindingChanged extends Error {
  constructor() { super(qqToolBindingChanged) }
}

/** Keep the ingress proof and attached client for the entire tool invocation. */
export function captureQqToolScope(value: unknown) {
  const event = asRecord(value) as Record<string, unknown> & AgentBindingTurn
  const binding = event._agentBinding
  const check = event._isAgentBindingCurrent
  const eventBot = event.bot
  const bindingToken = event._agentBindingToken
  const expectedToken = event._expectedAgentBindingToken
  const bound = binding !== undefined || check !== undefined || bindingToken !== undefined || expectedToken !== undefined
  const address = binding === undefined ? (bound ? resolveQqConversationAddress(event) : null) : binding?.target
  const target = isConversationAddress(address) ? address : null
  const targetKey = target && conversationAddressKey(target)
  const accountId = target?.account.id
  const hasProof = typeof check === 'function' && target !== null && target.account.platform === 'qq' && target.account.namespace === 'global'

  let revoked = false
  const isCurrent = (): boolean => {
    if (!bound) return true
    if (revoked) return false
    revoked = true
    try {
      if (hasProof && event.bot === eventBot && event._agentBinding === binding && event._agentBindingToken === bindingToken &&
        event._expectedAgentBindingToken === expectedToken && (eventBot == null || qqId(asRecord(eventBot).uin) === accountId)) {
        const live = resolveQqConversationAddress(event)
        if (live && conversationAddressKey(live) === targetKey && check?.call(event) === true) revoked = false
      }
    } catch { /* An unavailable guard revokes the captured turn. */ }
    return !revoked
  }

  const assertCurrent = () => {
    if (!queuedDeliveryAllowed() || !isCurrent()) throw new QqToolBindingChanged()
  }
  const resolveBot = (getBot?: () => unknown) => {
    assertCurrent()
    if (eventBot != null) return eventBot
    const root = getBot?.()
    return bound ? findQqAccount(root, accountId) : root
  }
  function effect<T>(dispatch: () => T, bot?: unknown): T {
    const canDispatch = () => {
      if (bound && bot !== undefined && qqId(asRecord(bot).uin) !== accountId) revoked = true
      return isCurrent()
    }
    if (!queuedDeliveryAllowed() || !canDispatch()) throw new QqToolBindingChanged()
    return withDeliveryGuard(bound ? canDispatch : undefined, dispatch)
  }
  return { bound, assertCurrent, resolveBot, effect }
}

export type QqToolScope = ReturnType<typeof captureQqToolScope>

export function requireQqToolBot(scope: QqToolScope, ports: QqToolPorts): QqToolBot {
  const bot = scope.resolveBot(() => ports.getBot())
  if (!bot) throw new Error('未找到事件机器人')
  return bot as QqToolBot
}

export function qqToolGroup(scope: QqToolScope, event: QqToolEvent, bot: QqToolBot, id: string | number): QqToolGroup | Promise<QqToolGroup> {
  return !scope.bound && event.group ? event.group : bot.pickGroup(id)
}

export function qqToolViewApi(scope: QqToolScope, ports: QqViewPorts) {
  const rawBot = scope.resolveBot(() => ports.getBot?.())
  const bot = qqViewBot(rawBot)
  if (!bot?.sendApi) throw new Error('找不到OneBotv11 API调用接口')
  const send = bot.sendApi
  return async (action: string, params: Record<string, unknown>) =>
    qqViewRecord(await scope.effect(() => send(action, params), rawBot))
}

export async function qqToolMentionGroup(scope: QqToolScope, event: QqViewEvent, ports: QqViewPorts) {
  const rawBot = scope.bound ? scope.resolveBot(() => ports.getBot?.()) : asRecord(event.raw).bot
  const bot = qqViewBot(rawBot)
  if (scope.bound && !bot) throw new Error('未找到事件机器人')
  const group = !scope.bound && event.group ? event.group : await (scope.bound ? bot : event.bot)?.pickGroup?.(event.group_id)
  // An existing reply port carries host or simulation reply policy and quotas.
  const send = scope.bound && event.reply ? event.reply : group?.sendMsg ?? event.reply
  const members = await scope.effect(() => group?.getMemberMap?.(), rawBot)
  return {
    botId: () => bot?.uin || (!scope.bound ? qqViewBot(ports.getBot?.())?.uin || '' : ''),
    members,
    async send(message: unknown) {
      try { return await scope.effect(() => send?.(message) ?? null, rawBot) }
      catch (error) {
        if (error instanceof QqToolBindingChanged) return { state: 'failed', code: 'binding_changed' }
        throw error
      }
    },
  }
}
