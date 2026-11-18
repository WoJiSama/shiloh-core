import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import { AGENT_GIFT_CATALOG, type AgentGiftToolExecutor, type AgentGiftType } from '../../../contracts/agentQqGift.js'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { ConversationMember } from '../../../contracts/platformConnection.js'
import { conversationAddressKey, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { giftData, giftInvalid, giftUser, normalizeAgentGiftResult, validateAgentGiftPlan } from './agentGiftValidation.js'

const fail = (code: string): AgentToolResult => ({ status: 'failed', content: JSON.stringify({ state: 'failed', completed: 0, code }) })
function clauses(text: string): readonly string[] {
  const denial = /(?:不要|不用|不必|无需|别|甭|先不).*(?:送|赠|礼物)|(?:没(?:有)?|并未)(?:让|叫|要求)你.*(?:送|赠|礼物)/u
  const example = /(?:只是|仅仅|仅).{0,12}(?:举例|示例|讨论|转述|引用)|^(?:例如|比如|举例|示例|例子|他(?:们)?说|她(?:们)?说|朋友说|同事说)/u
  const request = /^(?:(?:请|麻烦|你|帮我|替我|先|再|现在|确认|帮忙|能否|能不能|可以|能)\s*)*(?:(?:给|向).{1,100}?(?:送|赠)|(?:送|赠|赠送))/u
  const split = text.split(/[，,。；;！？!?\n]+/u).map(value => value.trim())
  if (split.some(value => denial.test(value) || example.test(value) && /送|赠|礼物/u.test(value)) || /[“「『"'].*(?:送|赠|礼物).*[”」』"']/u.test(text) || /付费|支付|扣费|扣款|充值|余额|付款/u.test(text)) return []
  return split.filter(value => !example.test(value) && request.test(value))
}
function current(context: AgentToolContext): boolean {
  try {
    return context.binding.target.kind === 'group' && context.actor.kind === 'user' && !!context.actor.user &&
      samePlatformNamespace(giftUser(context.actor.user), context.binding.target.account) && context.actor.user.id !== context.binding.target.account.id &&
      !!context.request && typeof context.request.text === 'string' && context.request.messageId !== '0' && !!context.request.messageId &&
      typeof context.readMember === 'function' && typeof context.ensureCurrent === 'function' && !context.signal.aborted && context.isCurrent() === true
  } catch { return false }
}
async function ensure(context: AgentToolContext) {
  if (!current(context)) throw giftInvalid()
  await context.ensureCurrent?.()
  if (!current(context)) throw giftInvalid()
}
function exactId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp('(?:^|[^A-Za-z0-9_/-])' + escaped + '(?:$|[^A-Za-z0-9_/-])', 'u').test(text)
}
const names = (member: ConversationMember) => [...new Set([member.displayName, member.profile?.nickname, member.profile?.conversationName].filter((value): value is string => typeof value === 'string' && !!value.trim()))]
function selfRequest(text: string): boolean { return /(?:送|赠)(?:给)?我(?=$|[\s，,.。!！？?吧呀呗]|一|个|份|件|香槟|风暴战锤|遨游太空|蹦迪派对|露营|龙腾万里|超级跑车|直升机|礼物)|给我\s*(?:送|赠)/u.test(text) }
async function target(context: AgentToolContext, requested: unknown, positive: readonly string[]): Promise<PlatformUserRef> {
  if (requested !== undefined && (typeof requested !== 'string' || !requested.trim() || requested.length > 240)) throw giftInvalid()
  const text = positive.join('，'), selected = typeof requested === 'string' ? requested.trim() : undefined
  const mentions = context.request!.mentions.filter(user => samePlatformNamespace(user, context.binding.target.account))
  let recipient: PlatformUserRef | undefined
  if (selected && ['我', '自己', '本人'].includes(selected)) {
    if (!selfRequest(text)) throw giftInvalid()
    recipient = context.actor.user
  } else if (selected && /^[1-9][0-9]*$/u.test(selected) && exactId(text, selected)) recipient = giftUser({ ...context.binding.target.account, id: selected })
  else if (selected && mentions.some(value => value.id === selected)) recipient = mentions.find(value => value.id === selected)
  else if (!selected && selfRequest(text)) recipient = context.actor.user
  else if (!selected && mentions.length === 1) recipient = mentions[0]
  else if (context.request!.replyAuthor && /他|她|这位|对方|引用|回复/u.test(text) && (!selected || selected === context.request!.replyAuthor.id)) recipient = context.request!.replyAuthor
  else if (selected && context.listMembers) {
    await ensure(context)
    const snapshot = await context.listMembers()
    await ensure(context)
    if (!snapshot || snapshot.complete !== true || conversationAddressKey(snapshot.target) !== conversationAddressKey(context.binding.target)) throw giftInvalid()
    const matches = snapshot.members.filter(member => names(member).some(name => name.trim() === selected))
    if (matches.length !== 1 || selected.length < 2 || !text.includes(selected)) throw giftInvalid()
    if (snapshot.members.some(member => member.user.id !== matches[0]!.user.id && names(member).some(name => name.length > selected.length && name.includes(selected) && text.includes(name)))) throw giftInvalid()
    recipient = matches[0]!.user
  }
  if (!recipient || !samePlatformNamespace(giftUser(recipient), context.binding.target.account)) throw giftInvalid()
  await ensure(context)
  const fresh = await context.readMember!(recipient.id)
  await ensure(context)
  if (!fresh || conversationAddressKey(fresh.target) !== conversationAddressKey(context.binding.target) || platformAccountKey(giftUser(fresh.member.user)) !== platformAccountKey(recipient)) throw giftInvalid()
  return giftUser(recipient)
}

/** Remains restricted: host tool policy must separately grant this capability to the current human. */
export function createAgentGiftTools(options: { readonly enabled?: boolean; readonly execute?: AgentGiftToolExecutor } = {}): readonly AgentTool[] {
  if (options.enabled !== true || typeof options.execute !== 'function') return Object.freeze([])
  const execute = options.execute
  const tool: AgentTool = {
    name: 'sendGiftTool', description: '按本条真人明确请求，在当前QQ群展示固定礼物效果；不是付费赠礼或扣费接口，仅由当前机器人署名。',
    parameters: { type: 'object', properties: {
      targetQQ: { type: 'string', description: '本条明确请求中的真实群成员QQ号或精确显示名；可从当前真实@或引用定位。' },
      giftType: { type: 'string', enum: Object.keys(AGENT_GIFT_CATALOG), default: 'champagne', description: '固定礼物展示类型。' },
    }, required: [], additionalProperties: false },
    async execute(input, context) {
      let executed = false
      try {
        await ensure(context)
        const row = giftData(input, ['targetQQ', 'giftType']), positive = clauses(context.request!.text)
        if (!positive.length) return fail('gift_denied')
        const giftType = row.giftType === undefined ? 'champagne' : row.giftType
        if (typeof giftType !== 'string' || !Object.hasOwn(AGENT_GIFT_CATALOG, giftType)) return fail('gift_invalid_input')
        const named = Object.entries(AGENT_GIFT_CATALOG).filter(([id, gift]) => positive.some(text => text.includes(gift.name) || new RegExp('(?:^|\\W)' + id + '(?:$|\\W)', 'iu').test(text))).map(([id]) => id)
        if (named.length && (named.length !== 1 || named[0] !== giftType)) return fail('gift_invalid_input')
        const recipient = await target(context, row.targetQQ, positive)
        const plan = validateAgentGiftPlan({ version: 1, recipient, giftType: giftType as AgentGiftType })
        await ensure(context)
        executed = true
        const result = normalizeAgentGiftResult(await execute(plan, context))
        return { status: result.state === 'confirmed' ? 'succeeded' : result.state, content: JSON.stringify({ action: 'gift-display', ...result, ...(result.state === 'confirmed' ? { evidence: 'packet-accepted' } : {}) }) }
      } catch { return executed ? { status: 'unknown', content: JSON.stringify({ state: 'unknown', completed: 0, code: 'gift_outcome_unknown' }) } : fail('gift_source_unavailable') }
    },
  }
  return Object.freeze([Object.freeze(tool)])
}
