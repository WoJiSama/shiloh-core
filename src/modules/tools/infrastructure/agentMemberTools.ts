import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { ConversationMember } from '../../../contracts/platformConnection.js'
import { validateMemberQueryTarget } from '../domain/memberMemoryIntent.js'
import { isExplicitAdminCollectionMentionRequest, isExplicitOwnerInAdminCollectionMentionRequest, isSingularOwnerMentionRequest } from '../../conversation/domain/mentionRoleRouting.js'
import { isToolActionDenied } from '../../conversation/domain/toolActionPolicy.js'

const failed = (status: string, message: string, extra = {}): AgentToolResult => ({ status: 'failed', content: JSON.stringify({ success: false, status, message, ...extra }) })
const succeeded = (data: unknown): AgentToolResult => ({ status: 'succeeded', content: JSON.stringify(data) })
const names = (member: ConversationMember) => [...new Set([member.displayName, member.profile?.nickname, member.profile?.conversationName].filter((value): value is string => !!value))]
const key = (value: string) => value.trim().toLocaleLowerCase()
const matches = (members: readonly ConversationMember[], target: string, fuzzy = false) => {
  const direct = members.filter(member => member.user.id === target)
  if (direct.length) return direct
  const exact = members.filter(member => names(member).some(name => key(name) === key(target)))
  return exact.length || !fuzzy ? exact : members.filter(member => names(member).some(name => key(name).includes(key(target))))
}

function request(context: AgentToolContext) {
  return context.actor.kind === 'user' && context.actor.user && context.request?.messageId &&
    context.binding.target.kind === 'group' && !context.signal.aborted && context.isCurrent() ? context.request : undefined
}
function containsId(text: string, id: string) {
  let at = text.indexOf(id)
  while (at >= 0) {
    const before = text[at - 1], after = text[at + id.length]
    if ((!before || !/[A-Za-z0-9_/-]/u.test(before)) && (!after || !/[A-Za-z0-9_/-]/u.test(after))) return true
    at = text.indexOf(id, at + 1)
  }
  return false
}
function explicitNameIds(text: string, members: readonly ConversationMember[]) {
  const content = text.toLocaleLowerCase(), spans: { id: string; start: number; end: number }[] = []
  for (const member of members) for (const name of names(member)) {
    const normalized = key(name)
    if (normalized.length < 2) continue
    let start = content.indexOf(normalized)
    while (start >= 0) { spans.push({ id: member.user.id, start, end: start + normalized.length }); start = content.indexOf(normalized, start + normalized.length) }
  }
  return new Set(spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start)).map(span => span.id))
}
function grounded(context: AgentToolContext, member: ConversationMember, members: readonly ConversationMember[]) {
  const source = request(context)
  return !!source && (source.mentions.some(user => user.id === member.user.id) || source.replyAuthor?.id === member.user.id ||
    containsId(source.text, member.user.id) || explicitNameIds(source.text, members).has(member.user.id))
}
async function ensure(context: AgentToolContext) {
  if (!request(context)) throw new Error('当前会话没有可用的真人请求')
  await context.ensureCurrent?.()
  if (!request(context)) throw new Error('当前会话没有可用的真人请求')
}
function schema(properties: Record<string, unknown>, required: string[] = []): AgentTool['parameters'] {
  return { type: 'object', properties, required, additionalProperties: false }
}
function validInput(input: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(input).every(name => keys.includes(name)) && JSON.stringify(input).length <= 4096
}
async function deliver(context: AgentToolContext, members: readonly ConversationMember[], text: string, data: Record<string, unknown>): Promise<AgentToolResult> {
  if (!context.sendMessage || !members.length || members.length > 20) return failed('unavailable', '本次没有发送：通知不可用或超过20人上限。')
  await ensure(context)
  const receipt = await context.sendMessage({ text, mentionUserIds: members.map(member => member.user.id) })
  return receipt.state === 'sent' ? succeeded({ ...data, success: true, messageId: receipt.messageId }) : receipt.state === 'failed'
    ? failed('delivery_failed', '本次通知未发送成功。')
    : { status: 'unknown', content: JSON.stringify({ action: 'mention_delivery', deliveryState: 'unknown', message: '发送结果未确认，请先核实，不要自动重发。' }) }
}

/** Built-in tools use only fixed-conversation Core capabilities, never native platform events. */
export function createAgentMemberTools(): readonly AgentTool[] {
  const info: AgentTool = {
    name: 'memberInfoTool',
    effect: input => ({ actor: 'user', conversation: 'group', required: ['readMember'], metadata: ['request', 'botUserId'],
      optional: input.nickname === undefined ? [] : ['listMembers'] }),
    description: '查询当前群一名明确成员的昵称、群名片、角色及平台提供的资料。优先本轮真实@、明确本人或被回复成员；也可按本条原话中的姓名查询，重名须澄清。不得猜测ID或把“他”当成提问者。',
    parameters: schema({ user_id: { type: 'string' }, nickname: { type: 'string' } }),
    async execute(input, context) {
      if (!validInput(input, ['user_id', 'nickname']) || Object.values(input).some(value => typeof value !== 'string' || !value.trim() || value.length > 240)) return failed('invalid_target', '请提供有效成员标识或姓名。')
      if (!request(context) || !context.readMember) return failed('unavailable', '当前群没有可核验的真人查询或成员端口。')
      if (isToolActionDenied(context.request!.text, info.name)) return failed('forbidden', '本条消息没有授权执行该查询。')
      await ensure(context)
      const source = context.request!
      let id: string | undefined, nickname: string | undefined
      if (context.binding.target.account.platform === 'qq') {
        const target = validateMemberQueryTarget(source.text, input, { currentUserId: context.actor.user!.id, botId: context.botUserId,
          atQq: source.mentions.map(user => user.id), replyTargetUserId: source.replyAuthor?.id })
        if (target.status === 'resolved') id = target.userId
        else if (target.status === 'lookup_by_name') nickname = target.nickname
        else return failed(target.status === 'unspecified' ? 'needs_clarification' : target.status, '请明确@一位成员、本人、被回复对象或姓名。')
      } else {
        const mentioned = source.mentions.filter(user => user.id !== context.botUserId)
        if (mentioned.length === 1) id = mentioned[0]!.id
        else if (typeof input.user_id === 'string' && (containsId(source.text, input.user_id) || source.replyAuthor?.id === input.user_id)) id = input.user_id
        else if (typeof input.nickname === 'string' && source.text.toLocaleLowerCase().includes(key(input.nickname))) nickname = input.nickname
        else return failed('needs_clarification', '请明确一位查询对象。')
      }
      if (!id && nickname) {
        const snapshot = await context.listMembers?.()
        if (!snapshot) return failed('unavailable', '本次群成员列表无法核实。', { unavailable: 'list' })
        const found = matches(snapshot.members, nickname, true)
        if (found.length !== 1) return failed(found.length ? 'needs_clarification' : 'not_found', '姓名未唯一匹配，请提供准确成员标识。', {
          candidates: found.slice(0, 10).map(member => ({ user_id: member.user.id, nickname: member.profile?.nickname ?? member.displayName, card: member.profile?.conversationName ?? '' })), total_candidates: found.length,
        })
        const explicit = explicitNameIds(source.text, snapshot.members)
        if (explicit.size && (explicit.size !== 1 || !found.some(member => explicit.has(member.user.id)))) return failed('needs_clarification', '姓名与本条请求的唯一指向不一致，请明确@查询对象。')
        id = found[0]!.user.id
      }
      if (!id) return failed('needs_clarification', '请明确一位查询对象。')
      const snapshot = await context.readMember(id)
      await ensure(context)
      if (!snapshot) return failed('unavailable', '本次成员资料无法核实。', { unavailable: 'detail' })
      return succeeded({ action: 'member_info', success: true, data: { user_id: id, displayName: snapshot.member.displayName,
        role: snapshot.member.role, ...(snapshot.member.profile ?? {}) }, observedAt: snapshot.observedAt })
    },
  }
  const members: AgentTool = {
    name: 'mentionMembersTool',
    effect: { actor: 'user', conversation: 'group', required: ['listMembers', 'sendMessage'], metadata: ['request'] },
    description: '仅响应本条真人请求，在当前群真实@指定成员并发送通知。targets使用原话中的准确ID、唯一完整名片/昵称或明确要求的“群主”；不能猜测姓名、扩大范围或借用旧请求。工作流通知使用groupKnowledgeTool。',
    parameters: schema({ targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, message: { type: 'string', maxLength: 2000 } }, ['targets']),
    async execute(input, context) {
      if (!validInput(input, ['targets', 'message']) || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 20 ||
          Array.from(input.targets).some(value => typeof value !== 'string' || !value.trim() || value.length > 240) ||
          input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 2000)) return failed('invalid_target', '通知参数无效。')
      if (!request(context) || !context.listMembers) return failed('unavailable', '当前群没有可核验的真人通知或成员端口。')
      if (isToolActionDenied(context.request!.text, members.name)) return failed('forbidden', '本条消息没有授权执行该通知。')
      await ensure(context)
      const snapshot = await context.listMembers()
      if (!snapshot) return failed('unavailable', '本次群成员列表无法核实。')
      const selected: ConversationMember[] = [], skipped: string[] = []
      for (const target of [...new Set((input.targets as string[]).map(value => value.trim()))]) {
        const found = target === '群主' && isSingularOwnerMentionRequest(context.request!.text)
          ? snapshot.members.filter(member => member.role === 'owner') : matches(snapshot.members, target)
        if (found.length === 1 && (grounded(context, found[0]!, snapshot.members) || target === '群主' && isSingularOwnerMentionRequest(context.request!.text))) selected.push(found[0]!)
        else skipped.push(target)
      }
      const unique = [...new Map(selected.map(member => [member.user.id, member])).values()]
      if (!unique.length) return failed('needs_clarification', '没有唯一且有本条请求依据的通知对象。', { skipped })
      const text = [typeof input.message === 'string' ? input.message.trim() : '', skipped.length ? `（未艾特：${skipped.join('、')}，成员不存在、名称有歧义或没有本条请求依据）` : ''].filter(Boolean).join('\n')
      return deliver(context, unique, text, { action: 'mention_members', count: unique.length, skipped, targets: unique.map(member => ({ userId: member.user.id, name: member.displayName })) })
    },
  }
  const admins: AgentTool = {
    name: 'mentionAdminsTool',
    effect: { actor: 'user', conversation: 'group', required: ['listMembers', 'sendMessage'], metadata: ['request', 'botUserId'] },
    description: '仅在显式放通且本条真人明确要求通知所有管理员/管理员们/全体群管时使用。默认排除机器人和群主；includeOwner=true还须原话明确包含群主。excludeTargets要求准确ID或唯一完整名片/昵称，歧义则整批停止。',
    parameters: schema({ message: { type: 'string', maxLength: 2000 }, includeOwner: { type: 'boolean' }, excludeTargets: { type: 'array', items: { type: 'string' }, maxItems: 20 } }),
    async execute(input, context) {
      if (!validInput(input, ['message', 'includeOwner', 'excludeTargets']) || input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 2000) ||
          input.includeOwner !== undefined && typeof input.includeOwner !== 'boolean' || input.excludeTargets !== undefined && (!Array.isArray(input.excludeTargets) || input.excludeTargets.length > 20 ||
            Array.from(input.excludeTargets).some(value => typeof value !== 'string' || !value.trim() || value.length > 240))) return failed('invalid_target', '管理员通知参数无效。')
      if (!request(context) || !isExplicitAdminCollectionMentionRequest(context.request!.text) || !context.listMembers) return failed('forbidden', '只有本条真人明确要求所有管理员、管理员们或全体群管时才能执行。')
      if (isToolActionDenied(context.request!.text, admins.name)) return failed('forbidden', '本条消息没有授权执行该通知。')
      if (input.includeOwner === true && !isExplicitOwnerInAdminCollectionMentionRequest(context.request!.text)) return failed('forbidden', '包含群主需要本条原话的明确要求。')
      await ensure(context)
      const snapshot = await context.listMembers()
      if (!snapshot) return failed('unavailable', '本次群成员角色无法核实。')
      const excluded = new Set<string>()
      for (const target of (input.excludeTargets ?? []) as string[]) {
        const found = matches(snapshot.members, target.trim())
        if (found.length !== 1 || !grounded(context, found[0]!, snapshot.members)) return failed('needs_clarification', '排除对象没有唯一匹配或本条请求依据，本次没有发送。')
        excluded.add(found[0]!.user.id)
      }
      const selected = snapshot.members.filter(member => member.user.id !== context.botUserId && !excluded.has(member.user.id) &&
        (member.role === 'admin' || input.includeOwner === true && member.role === 'owner'))
      return deliver(context, selected, typeof input.message === 'string' ? input.message.trim() : '', { action: 'mention_admins', count: selected.length, includeOwner: input.includeOwner === true, excluded: excluded.size })
    },
  }
  return Object.freeze([info, members, admins])
}
