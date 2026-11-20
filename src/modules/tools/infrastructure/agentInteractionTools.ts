import { randomInt } from 'node:crypto'
import { types } from 'node:util'
import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentInteraction, AgentInteractionPlan, AgentInteractionResult } from '../../../contracts/agentInteraction.js'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { ConversationMember, ConversationMemberSnapshot, ConversationMembersSnapshot } from '../../../contracts/platformConnection.js'
import { conversationAddressKey, isPlatformAccount, isPlatformIdentifier, platformAccountKey, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { groupManagementActionClauses, hasRecallActionIntent, isToolActionDenied } from '../../conversation/domain/toolActionPolicy.js'
import { canApplyGroupManagement } from '../domain/agentGroupManagement.js'
import { normalizeAgentInteractionResult, validateAgentInteraction, validateAgentInteractionPlan } from './agentInteractions.js'

const fail = (code: string): AgentToolResult => ({ status: 'failed', content: JSON.stringify({ state: 'failed', code, completed: 0, requested: 0 }) })
const invalid = () => new Error('互动目标或请求不可用')
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    row[key] = field.value
  }
  return row
}
function strings(input: unknown): string[] {
  if (typeof input === 'string') input = [input]
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 20 || Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
  return Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || !field.value.trim() || field.value.length > 240) throw invalid()
    return field.value.trim() as string
  })
}
function count(value: unknown, maximum: number, fallback = 1): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid()
  return value
}
function containsId(text: string, id: string): boolean {
  let index = text.indexOf(id)
  while (index >= 0) {
    const before = text[index - 1], after = text[index + id.length]
    if ((!before || !/[A-Za-z0-9_/-]/u.test(before)) && (!after || !/[A-Za-z0-9_/-]/u.test(after))) return true
    index = text.indexOf(id, index + 1)
  }
  return false
}
const actionRequests = {
  poke: /^(?:(?:请|麻烦|你|帮我|替我|给我|先|再|来|随机|随便|任意)\s*)*(?:(?:给|对|帮|替).{1,80}?)?(?:戳|拍一拍|拍(?:我|他|她|这|那))/u,
  'profile-like': /^(?:(?:请|麻烦|你|帮我|替我|给我|先|再|来|随机|随便|任意)\s*)*(?:(?:给|对|帮|替).{1,80}?|我的(?:资料|名片|主页)\s*)?(?:点赞|点(?:一|个|下|一下|\d|[一二三四五六七八九十两]){0,8}赞|赞(?:我|他|她)|给赞)/u,
  'message-reaction': /^(?:(?:请|麻烦|你|帮我|替我|给我|先|再|来|随机|随便|任意)\s*)*(?:(?:给|对|帮|替|用).{1,80}?)?(?:(?:贴|加|添加|回|回复|回应).{0,8}表情|表情(?:回应|回复))/u,
}
function requestsAction(text: string, kind: keyof typeof actionRequests, random = false): boolean {
  return text.split(/[，,。；;！？!?\n]+/u).some(clause => actionRequests[kind].test(clause.trim()) &&
    (!random || /随机|随便|任意|抽(?:一|个)/u.test(clause)))
}
function current(context: AgentToolContext) {
  try {
    return context.actor.kind === 'user' && !!context.actor.user && isPlatformAccount(context.actor.user) &&
      samePlatformNamespace(context.actor.user, context.binding.target.account) && ['group', 'private'].includes(context.binding.target.kind) &&
      !!context.request && isPlatformIdentifier(context.request.messageId) && context.request.messageId !== '0' &&
      typeof context.request.text === 'string' && !context.signal.aborted && context.isCurrent() === true && typeof context.interact === 'function'
  } catch { return false }
}
async function ensure(context: AgentToolContext) {
  if (!current(context)) throw invalid()
  await context.ensureCurrent?.()
  if (!current(context)) throw invalid()
}
const names = (member: ConversationMember) => [...new Set([member.displayName, member.profile?.conversationName, member.profile?.nickname].filter((value): value is string => typeof value === 'string' && !!value.trim()))]
const key = (text: string) => text.trim().toLocaleLowerCase()
function namedIds(text: string, members: readonly ConversationMember[]) {
  const content = text.toLocaleLowerCase(), spans: { id: string; start: number; end: number }[] = []
  for (const member of members) for (const name of names(member)) {
    const normalized = key(name)
    if (normalized.length < 2) continue
    let start = content.indexOf(normalized)
    while (start >= 0) { spans.push({ id: member.user.id, start, end: start + normalized.length }); start = content.indexOf(normalized, start + normalized.length) }
  }
  return new Set(spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start)).map(span => span.id))
}
function selfRequest(context: AgentToolContext, kind: 'poke' | 'profile-like') {
  const text = context.request!.text
  return kind === 'poke' ? /(?:戳|拍)(?:一戳|一拍|一下|一?个|一?次)?我(?!们)/u.test(text)
    : /(?:给我|我的(?:资料|名片|主页))\s*(?:点(?:一|个|下|一下|\d|[一二三四五六七八九十两]){0,8}赞|赞)|(?:赞|点赞)(?:一下|一?个)?我(?!们)/u.test(text)
}
function privateLikeUser(context: AgentToolContext, selected: unknown): PlatformUserRef {
  const peer = context.privatePeer, actor = context.actor.user, target = context.binding.target
  if (target.kind !== 'private' || !peer || !actor || !isPlatformAccount(peer) || !samePlatformNamespace(peer, target.account) ||
      !samePlatformNamespace(peer, actor) || peer.id !== actor.id ||
      selected !== undefined && (typeof selected !== 'string' || !['我', '本人', '自己', peer.id].includes(selected.trim()))) throw invalid()
  const bare = /^(?:(?:请|麻烦|你|帮我|替我|给我|先|再)\s*)*(?:点赞|点(?:一|个|下|一下|\d|[一二三四五六七八九十两]){0,8}赞)(?:一下|吧|呗)?[。！!]?$/u.test(context.request!.text.trim())
  if (!selfRequest(context, 'profile-like') && !bare) throw invalid()
  return Object.freeze({ platform: peer.platform, namespace: peer.namespace, id: peer.id })
}
function grounded(context: AgentToolContext, member: ConversationMember, members: readonly ConversationMember[], kind: 'poke' | 'profile-like') {
  const source = context.request!, user = member.user
  return source.mentions.some(value => samePlatformNamespace(value, user) && value.id === user.id) ||
    source.replyAuthor && samePlatformNamespace(source.replyAuthor, user) && source.replyAuthor.id === user.id &&
      /他|她|这人|那人|这位|对方|引用|回复/u.test(source.text) && !selfRequest(context, kind) ||
    containsId(source.text, user.id) || namedIds(source.text, members).has(user.id) ||
    user.id === context.actor.user!.id && selfRequest(context, kind)
}
async function members(context: AgentToolContext): Promise<ConversationMembersSnapshot> {
  await ensure(context)
  const snapshot = await context.listMembers?.()
  await ensure(context)
  if (!snapshot || snapshot.complete !== true || conversationAddressKey(snapshot.target) !== conversationAddressKey(context.binding.target) || !Array.isArray(snapshot.members)) throw invalid()
  const seen = new Set<string>()
  for (const member of snapshot.members) {
    if (!isPlatformAccount(member.user) || !samePlatformNamespace(member.user, context.binding.target.account) || seen.has(member.user.id)) throw invalid()
    seen.add(member.user.id)
  }
  return snapshot
}
async function fresh(context: AgentToolContext, member: ConversationMember): Promise<PlatformUserRef> {
  await ensure(context)
  const snapshot = await context.readMember?.(member.user.id)
  await ensure(context)
  if (!snapshot || conversationAddressKey(snapshot.target) !== conversationAddressKey(context.binding.target) ||
      platformAccountKey(snapshot.member.user) !== platformAccountKey(member.user)) throw invalid()
  return Object.freeze({ ...member.user })
}
function resolve(context: AgentToolContext, target: string, all: readonly ConversationMember[], kind: 'poke' | 'profile-like'): ConversationMember {
  const self = ['我', '本人', '自己'].includes(target) && selfRequest(context, kind)
  const exact = all.filter(member => member.user.id === (self ? context.actor.user!.id : target) || names(member).some(name => key(name) === key(target)))
  const matches = exact.length ? exact : all.filter(member => names(member).some(name => key(name).includes(key(target))))
  if (matches.length !== 1 || !grounded(context, matches[0]!, all, kind)) throw invalid()
  return matches[0]!
}
function defaults(context: AgentToolContext, kind: 'poke' | 'profile-like'): string[] {
  if (selfRequest(context, kind)) return [context.actor.user!.id]
  const mentions = context.request!.mentions.filter(user => samePlatformNamespace(user, context.binding.target.account) && user.id !== context.botUserId)
  if (mentions.length) return mentions.map(user => user.id)
  const reply = context.request!.replyAuthor
  if (reply && /他|她|这人|那人|这位|对方|引用|回复/u.test(context.request!.text)) return [reply.id]
  return []
}
async function deliver(context: AgentToolContext, plan: AgentInteractionPlan): Promise<AgentToolResult> {
  await ensure(context)
  let response: AgentInteractionResult
  try { response = await context.interact!(validateAgentInteractionPlan(plan, context.binding.target.account)) }
  catch { return { status: 'unknown', content: JSON.stringify({ action: plan.kind, state: 'unknown', completed: 0, requested: plan.operations.length, code: 'interaction_outcome_unknown' }) } }
  const row = normalizeAgentInteractionResult(response, plan.operations.length)
  return { status: row.state === 'confirmed' ? 'succeeded' : row.state,
    content: JSON.stringify({ action: plan.kind, ...row }) }
}
const schema = (properties: Record<string, unknown>): AgentTool['parameters'] => ({ type: 'object', properties, required: [], additionalProperties: false })

type GroupManagement = Extract<AgentInteraction, { kind: 'member-mute' | 'group-mute' | 'member-card' }>
const unmuteRequest = (text: string) => /解禁|(?:解除|关闭|取消).{0,40}禁言/u.test(text)
const randomRequest = (text: string) => /随机|随便|任意|抽(?:一|个)/u.test(text)
const wholeRequest = (text: string) => /全体禁言|禁言全体/u.test(text)
const timedRequest = (text: string) => /(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万两半]+)\s*(?:秒钟?|分钟?|小时|时|天|日|周|个月|月|年)|持续|维持|直到|(?:禁言|开启|打开).{0,20}到.{0,20}(?:点|时|明天)|一会儿|永久|永远|一直/u.test(text)
const cardField = '(?:群名片|群昵称|名片|昵称|名字|名称)'
const selfCardRequest = (text: string) => new RegExp('(?:我|本人|自己)(?:的)?' + cardField + '|(?:帮|给|替)(?:我|本人|自己)(?:改|修改|设置|清空|清除|删除)(?:一下|下)?' + cardField, 'u').test(text)
const botCardRequest = (text: string) => new RegExp('(?:你|机器人)(?:的)?' + cardField + '|(?:帮|给|替)(?:你|机器人)(?:改|修改|设置|清空|清除|删除)(?:一下|下)?' + cardField, 'u').test(text)
function muteSeconds(input: unknown): number {
  if (input === undefined) return 300
  if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input)) throw invalid()
  return Math.max(0, Math.min(input, 30 * 86_400))
}
function groupManagementAvailable(context: AgentToolContext): boolean {
  return current(context) && context.binding.target.kind === 'group' && !!context.listMembers && !!context.readMember &&
    isPlatformIdentifier(context.botUserId)
}
async function freshGroupMember(context: AgentToolContext, user: PlatformUserRef): Promise<ConversationMemberSnapshot> {
  await ensure(context)
  const startedAt = Date.now()
  const snapshot = await context.readMember!(user.id)
  await ensure(context)
  if (!snapshot || conversationAddressKey(snapshot.target) !== conversationAddressKey(context.binding.target) ||
      !isPlatformAccount(snapshot.member.user) || platformAccountKey(snapshot.member.user) !== platformAccountKey(user) ||
      !Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < startedAt - 5_000 || snapshot.observedAt > Date.now() + 5_000) throw invalid()
  return snapshot
}
async function authorizeGroupManagement(context: AgentToolContext, operation: GroupManagement): Promise<void> {
  const requester = await freshGroupMember(context, context.actor.user!)
  const bot = await freshGroupMember(context, { ...context.binding.target.account, id: context.botUserId! })
  const target = operation.kind === 'group-mute' ? undefined : await freshGroupMember(context, operation.user)
  if (!canApplyGroupManagement(operation, requester.member, bot.member, target?.member)) throw invalid()
}
function groupGrounded(context: AgentToolContext, member: ConversationMember, all: readonly ConversationMember[], text: string, card: boolean): boolean {
  const id = member.user.id, source = context.request!
  if (card && id === context.actor.user!.id && selfCardRequest(text) || card && id === context.botUserId && botCardRequest(text)) return true
  if (containsId(text, id) || namedIds(text, all).has(id)) return true
  if (source.replyAuthor && platformAccountKey(source.replyAuthor) === platformAccountKey(member.user) && /他|她|这人|那人|这位|对方|引用|回复/u.test(text)) return true
  return source.mentions.some(value => platformAccountKey(value) === platformAccountKey(member.user)) &&
    /@|这(?:个|位)?(?:群友|成员|人)|那(?:个|位)?(?:群友|成员|人)/u.test(text) && namedIds(text, all).size === 0
}
function resolveGroupMember(context: AgentToolContext, target: string, all: readonly ConversationMember[], clauses: readonly string[], card: boolean): ConversationMember {
  const text = clauses.join('，')
  let id = target, alias = false
  if (['我', '本人', '自己'].includes(target)) {
    if (!card || !clauses.some(selfCardRequest)) throw invalid()
    id = context.actor.user!.id; alias = true
  } else if (['你', '机器人'].includes(target) && card && clauses.some(botCardRequest)) { id = context.botUserId!; alias = true }
  const exact = all.filter(member => member.user.id === id || !alias && names(member).some(name => key(name) === key(target)))
  const matches = exact.length ? exact : all.filter(member => names(member).some(name => key(name).includes(key(target))))
  if (matches.length !== 1 || !groupGrounded(context, matches[0]!, all, text, card)) throw invalid()
  return matches[0]!
}
function defaultGroupTargets(context: AgentToolContext, all: readonly ConversationMember[], clauses: readonly string[], card: boolean): string[] {
  const text = clauses.join('，')
  if (card && clauses.some(selfCardRequest)) return [context.actor.user!.id]
  if (card && clauses.some(botCardRequest)) return [context.botUserId!]
  return all.filter(member => groupGrounded(context, member, all, text, card)).map(member => member.user.id)
}
function cardClause(text: string, name: string): { readonly targetText: string } | undefined {
  const assignment = /(?:群名片|群昵称|名片|昵称|名字|名称)\s*(?:修改成|修改为|改成|改为|换成|换为|设置为|设为|为|成|叫做|叫)/u.exec(text)
  if (name === '') return !assignment && /(?:清空|清除|删除|删掉).{0,100}(?:群名片|群昵称|名片|昵称)|(?:群名片|群昵称|名片|昵称)\s*(?:清空|清除|删除|删掉)/u.test(text) ? { targetText: text } : undefined
  if (!assignment) return undefined
  const offset = assignment.index + assignment[0].length, payload = text.slice(offset).trim()
  const quotes: readonly (readonly [string, string])[] = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]]
  const matches = (value: string) => value === name || quotes.some(([open, close]) => value === open + name + close)
  if (!['', '吧', '呗', '谢谢', '就行', '即可'].some(suffix => payload.endsWith(suffix) && matches(payload.slice(0, payload.length - suffix.length).trim()))) return undefined
  return { targetText: text.slice(0, offset) }
}

/** Human interaction tools never receive native API names, arbitrary targets or host account handles. */
export function createAgentInteractionTools(config: { readonly enabled: boolean }): readonly AgentTool[] {
  if (!config.enabled) return Object.freeze([])
  const poke: AgentTool = {
    name: 'pokeTool', description: '按本条真人请求戳当前群明确成员。target支持真实@、明确本人或原话中的准确ID/唯一姓名；重名须澄清。仅原话明确随机时可random，不猜目标。每人1至10次，最多20人和100次，部分完成或未知不能重试。',
    effect: { actor: 'user', conversation: 'group', required: ['interact', 'listMembers', 'readMember'], metadata: ['request', 'botUserId'] },
    timeoutMs: 240_000,
    parameters: schema({ target: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }] }, times: { type: 'integer', minimum: 1, maximum: 10 }, random: { type: 'boolean' } }),
    async execute(input, context) {
      try {
        const row = data(input, ['target', 'times', 'random']), times = count(row.times, 10), provided = row.target === undefined ? undefined : strings(row.target)
        if (row.random !== undefined && typeof row.random !== 'boolean') return fail('interaction_invalid_input')
        if (row.random === true && provided !== undefined) return fail('interaction_invalid_input')
        if (!current(context) || context.binding.target.kind !== 'group' || !context.listMembers || !context.readMember) return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, poke.name)) return fail('interaction_denied')
        if (!requestsAction(context.request!.text, 'poke')) return fail('interaction_unrequested')
        const snapshot = await members(context)
        let selected: ConversationMember[]
        if (row.random === true) {
          if (!requestsAction(context.request!.text, 'poke', true)) return fail('interaction_target_unproven')
          const available = snapshot.members.filter(member => ![context.actor.user!.id, context.botUserId, context.binding.target.account.id].includes(member.user.id))
          if (!available.length) return fail('interaction_target_unavailable')
          selected = [available[randomInt(available.length)]!]
        } else {
          const targets = provided ?? defaults(context, 'poke')
          if (!targets.length) return fail('interaction_needs_target')
          selected = [...new Map(targets.map(target => { const member = resolve(context, target, snapshot.members, 'poke'); return [member.user.id, member] })).values()]
        }
        if (selected.length * times > 100) return fail('interaction_invalid_input')
        const operations: AgentInteraction[] = []
        for (const member of selected) { const user = await fresh(context, member); for (let index = 0; index < times; index++) operations.push({ kind: 'poke', user }) }
        return await deliver(context, { version: 1, kind: 'poke', operations })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  const like: AgentTool = {
    name: 'likeTool', description: '按本条真人请求给明确成员的资料点赞；好友私聊仅支持当前对方明确给本人点赞。群聊qq为真实@、明确本人或原话中的准确ID/唯一姓名；留空须能确定对象。random仅用于原话明确随机给群友点赞，排除请求者和机器人。count默认10，为1至20。',
    effect: (input, conversation) => conversation === 'private' && input.random !== true
      ? { actor: 'user', conversation: 'private', required: ['interact'], metadata: ['request', 'botUserId', 'privatePeer'] }
      : { actor: 'user', conversation: 'group', required: ['interact', 'listMembers', 'readMember'], metadata: ['request', 'botUserId'] },
    parameters: schema({ qq: { type: 'string' }, count: { type: 'integer', default: 10, minimum: 1, maximum: 20 }, random: { type: 'boolean' } }),
    async execute(input, context) {
      try {
        const row = data(input, ['qq', 'count', 'random']), amount = count(row.count, 20, 10)
        if (row.qq !== undefined && (typeof row.qq !== 'string' || !row.qq.trim() || row.qq.length > 240)) return fail('interaction_invalid_input')
        if (row.random !== undefined && typeof row.random !== 'boolean') return fail('interaction_invalid_input')
        if (row.random === true && row.qq !== undefined) return fail('interaction_invalid_input')
        if (!current(context)) return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, like.name)) return fail('interaction_denied')
        if (!requestsAction(context.request!.text, 'profile-like')) return fail('interaction_unrequested')
        if (context.binding.target.kind === 'private') {
          if (row.random === true) return fail('interaction_invalid_input')
          const user = privateLikeUser(context, row.qq)
          return await deliver(context, { version: 1, kind: 'profile-like', operations: [{ kind: 'profile-like', user, count: amount }] })
        }
        if (!context.listMembers || !context.readMember) return fail('interaction_unavailable')
        const snapshot = await members(context)
        let selected: ConversationMember
        if (row.random === true) {
          if (!requestsAction(context.request!.text, 'profile-like', true)) return fail('interaction_target_unproven')
          const available = snapshot.members.filter(member => ![context.actor.user!.id, context.botUserId, context.binding.target.account.id].includes(member.user.id))
          if (!available.length) return fail('interaction_target_unavailable')
          selected = available[randomInt(available.length)]!
        } else {
          const targets = row.qq === undefined ? defaults(context, 'profile-like') : [String(row.qq).trim()]
          if (targets.length !== 1) return fail('interaction_needs_target')
          selected = resolve(context, targets[0]!, snapshot.members, 'profile-like')
        }
        const user = await fresh(context, selected)
        return await deliver(context, { version: 1, kind: 'profile-like', operations: [{ kind: 'profile-like', user, count: amount }] })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  const reaction: AgentTool = {
    name: 'reactionTool', description: '给当前真人群请求中的消息贴表情。message_id仅可使用本条触发消息、被引用消息或原话精确写出的消息ID；count为1至20，表情由可信运行时随机选择。未知或部分完成不能重试。',
    effect: { actor: 'user', conversation: 'group', required: ['interact'], metadata: ['request'] },
    parameters: schema({ message_id: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 20 } }),
    async execute(input, context) {
      try {
        const row = data(input, ['message_id', 'count']), amount = count(row.count, 20)
        if (!current(context) || context.binding.target.kind !== 'group') return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, reaction.name) || /(?:不要|不用|别|不必|无需).{0,8}(?:贴|加|回应|回复|表情)/u.test(context.request!.text)) return fail('interaction_denied')
        if (!requestsAction(context.request!.text, 'message-reaction')) return fail('interaction_unrequested')
        const source = context.request!, messageId = row.message_id === undefined ? source.replyMessageId ?? source.messageId : row.message_id
        if (!isPlatformIdentifier(messageId) || messageId === '0' || messageId !== source.messageId && messageId !== source.replyMessageId && !containsId(source.text, messageId)) return fail('interaction_target_unproven')
        const operations = Array.from({ length: amount }, (): AgentInteraction => {
          const selected = randomInt(500 + 128563 - 127801 + 1)
          return { kind: 'message-reaction', messageId, emojiId: String(selected < 500 ? selected + 1 : selected - 500 + 127801) }
        })
        return await deliver(context, { version: 1, kind: 'message-reaction', operations })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  const recall: AgentTool = {
    name: 'recallTool', description: '仅按本条真人明确请求撤回当前会话中本角色已确认发出的自有消息。message_id只能用本条原话精确写出的ID或可信引用消息ID；省略仅使用可信引用，不猜当前触发消息或最近消息。所有权由运行时复验，结果未知不能重试。',
    effect: { actor: 'user', required: ['interact'], metadata: ['request'] },
    parameters: schema({ message_id: { type: 'string' } }),
    async execute(input, context) {
      try {
        const row = data(input, ['message_id'])
        if (!current(context)) return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, recall.name)) return fail('interaction_denied')
        if (!hasRecallActionIntent(context.request!.text)) return fail('interaction_unrequested')
        const source = context.request!, messageId = row.message_id === undefined ? source.replyMessageId : row.message_id
        if (messageId === undefined) return fail('interaction_needs_target')
        if (!isPlatformIdentifier(messageId) || messageId === '0' || messageId !== source.replyMessageId && !containsId(source.text, messageId)) return fail('interaction_target_unproven')
        return await deliver(context, { version: 1, kind: 'message-recall', operations: [{ kind: 'message-recall', messageId }] })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  const mute: AgentTool = {
    name: 'jinyanTool',
    effect: { actor: 'user', conversation: 'group', required: ['interact', 'listMembers', 'readMember'], metadata: ['request', 'botUserId'] },
    description: '仅按当前真人明确请求禁言或解禁当前群成员。target为准确ID、真实@或唯一姓名，最多20人、每人一次；不猜目标。time默认300秒，解禁必须0，禁言必须正整数，上限30天。random仅在本条同分句明确随机且无指定目标时使用。全体target="all"须明确全体禁言/解禁；开启须confirm=true，仅设置开关，不支持定时自动解除。请求者和机器人须当前群主/管理员，个人目标须普通成员；自主决定不执行。',
    timeoutMs: 240_000,
    parameters: schema({ target: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }] },
      time: { type: 'integer', default: 300 }, random: { type: 'boolean', default: false }, confirm: { type: 'boolean', default: false },
      selfDecision: { type: 'boolean', enum: [false], default: false } }),
    async execute(input, context) {
      try {
        const row = data(input, ['target', 'time', 'random', 'confirm', 'selfDecision'])
        const seconds = muteSeconds(row.time), provided = row.target === undefined ? undefined : strings(row.target)
        if (row.random !== undefined && typeof row.random !== 'boolean' || row.confirm !== undefined && typeof row.confirm !== 'boolean' ||
            row.selfDecision !== undefined && row.selfDecision !== false || row.random === true && provided !== undefined) return fail('interaction_invalid_input')
        if (!groupManagementAvailable(context)) return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, mute.name)) return fail('interaction_denied')
        const requested = groupManagementActionClauses(context.request!.text, 'moderation')
        if (!requested.length) return fail('interaction_unrequested')
        const clauses = requested.filter(clause => unmuteRequest(clause) === (seconds === 0))
        if (!clauses.length) return fail('interaction_invalid_input')
        const requester = Object.freeze({ ...context.actor.user! })
        if (row.target === 'all') {
          const whole = clauses.filter(wholeRequest)
          if (!whole.length || whole.some(timedRequest) || seconds > 0 && row.confirm !== true) return fail('interaction_invalid_input')
          const operation: GroupManagement = { kind: 'group-mute', enabled: seconds > 0, requester }
          await authorizeGroupManagement(context, operation)
          return await deliver(context, { version: 1, kind: operation.kind, operations: [operation] })
        }
        if (provided?.includes('all') || clauses.some(wholeRequest)) return fail('interaction_invalid_input')
        const snapshot = await members(context)
        let selected: ConversationMember[]
        if (row.random === true) {
          const randomClauses = clauses.filter(randomRequest)
          if (!randomClauses.length) return fail('interaction_target_unproven')
          const text = randomClauses.join('，')
          if (namedIds(text, snapshot.members).size || snapshot.members.some(member => containsId(text, member.user.id)) || context.request!.mentions.length) return fail('interaction_invalid_input')
          const available = snapshot.members.filter(member => member.role === 'member' &&
            ![requester.id, context.botUserId, context.binding.target.account.id].includes(member.user.id))
          selected = []
          while (available.length) {
            const candidate = available.splice(randomInt(available.length), 1)[0]!, checked = await freshGroupMember(context, candidate.user)
            if (checked.member.role !== 'member' || seconds === 0 && !(typeof checked.member.profile?.mutedUntil === 'number' && checked.member.profile.mutedUntil > Date.now())) continue
            selected = [checked.member]; break
          }
          if (!selected.length) return fail('interaction_target_unavailable')
        } else {
          const targets = provided ?? defaultGroupTargets(context, snapshot.members, clauses, false)
          if (!targets.length) return fail('interaction_needs_target')
          selected = [...new Map(targets.map(target => { const member = resolveGroupMember(context, target, snapshot.members, clauses, false); return [member.user.id, member] })).values()]
        }
        const operations: GroupManagement[] = []
        for (const member of selected) {
          const operation: GroupManagement = { kind: 'member-mute', user: Object.freeze({ ...member.user }), seconds, requester }
          await authorizeGroupManagement(context, operation); operations.push(operation)
        }
        return await deliver(context, { version: 1, kind: 'member-mute', operations })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  const card: AgentTool = {
    name: 'changeCardTool',
    effect: { actor: 'user', conversation: 'group', required: ['interact', 'listMembers', 'readMember'], metadata: ['request', 'botUserId'] },
    description: '仅按当前真人明确请求修改当前群的一位成员的群名片。target取准确ID、真实@、唯一姓名；我/本人是请求者，你/机器人须原话明确指机器人。cardName须精确来自本条正向改名请求，最多60码点，空串仅用于明确清空名片。普通成员只能请求改自己；改他人须群主/管理员。机器人改他人也须管理员，改自己可普通成员。角色未知或姓名重名应澄清。',
    parameters: { ...schema({ target: { type: 'string' }, cardName: { type: 'string', maxLength: 60 } }), required: ['cardName'] },
    async execute(input, context) {
      try {
        const row = data(input, ['target', 'cardName'])
        if (typeof row.cardName !== 'string' || row.target !== undefined && (typeof row.target !== 'string' || !row.target.trim() || row.target.length > 240)) return fail('interaction_invalid_input')
        if (!groupManagementAvailable(context)) return fail('interaction_unavailable')
        if (isToolActionDenied(context.request!.text, card.name)) return fail('interaction_denied')
        const clauses = groupManagementActionClauses(context.request!.text, 'card').flatMap(clause => {
          const parsed = cardClause(clause, row.cardName as string); return parsed ? [parsed.targetText] : []
        })
        if (!clauses.length) return fail('interaction_unrequested')
        const snapshot = await members(context), targets = row.target === undefined ? defaultGroupTargets(context, snapshot.members, clauses, true) : [row.target.trim()]
        if (targets.length !== 1) return fail('interaction_needs_target')
        const selected = resolveGroupMember(context, targets[0]!, snapshot.members, clauses, true)
        const operation = validateAgentInteraction({ kind: 'member-card', user: selected.user, name: row.cardName, requester: context.actor.user! }, context.binding.target.account) as Extract<GroupManagement, { kind: 'member-card' }>
        await authorizeGroupManagement(context, operation)
        return await deliver(context, { version: 1, kind: 'member-card', operations: [operation] })
      } catch { return fail('interaction_target_unavailable') }
    },
  }
  return Object.freeze([Object.freeze(poke), Object.freeze(like), Object.freeze(reaction), Object.freeze(recall), Object.freeze(mute), Object.freeze(card)])
}
