import { randomInt } from 'node:crypto'
import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { AgentQzoneOperation, AgentQzoneResult } from '../../../contracts/agentQzone.js'
import { normalizeAgentQzoneCode, normalizeAgentQzoneReceipt, qzoneArray, qzoneData, qzoneToken, validateAgentQzoneAccount, validateAgentQzoneOperation } from './agentQzoneValidation.js'

/** The coordinator injects these ports in the current tool context; no native event, actor or credential comes from a model. */
export interface AgentQzoneToolContext extends AgentToolContext {
  qzone?(operation: AgentQzoneOperation): Promise<AgentQzoneResult>
  /** Host-filtered affinity candidates in this group only. Runtime still fresh-checks the selected member and threshold. */
  qzoneCandidates?(): Promise<readonly string[]>
}
const failed = (): AgentToolResult => ({ status: 'failed', content: JSON.stringify({ code: 'qzone_not_authorized' }) })
function current(context: AgentQzoneToolContext): boolean {
  try {
    const actor = validateAgentQzoneAccount(context.actor.user), account = context.binding.target.account
    return context.actor.kind === 'user' && actor.platform === account.platform && actor.namespace === account.namespace && actor.id !== account.id &&
      !!context.request && qzoneToken(context.request.messageId) !== '0' && typeof context.request.text === 'string' &&
      !context.signal.aborted && context.isCurrent() === true && typeof context.qzone === 'function'
  } catch { return false }
}
async function ensure(context: AgentQzoneToolContext) {
  if (!current(context)) throw new Error('qzone_not_authorized')
  await context.ensureCurrent?.()
  if (!current(context)) throw new Error('qzone_not_authorized')
}
function ownIntent(text: string, deleting: boolean, postId?: string) {
  // Host policy still owns authorization. Conservative text grounding prevents a model-selected own action from borrowing an unrelated turn.
  if (text.length > 16_384 || /不要|别|禁止|取消|不能|无需|不必|不准|假如|如果|例如|示例|他说|她说|转述|有人|能否|[吗么][？?]?$/u.test(text.trim())) return false
  const prefix = /^(?:(?:请|帮我|帮忙|麻烦|你|现在|用你自己的身份|以你自己的身份)\s*)*/u
  const command = text.trim().replace(prefix, '')
  if (deleting) {
    const match = /^(?:删除|删掉|删了|删)(?:你自己的|你的|自己的|自己|你)?(?:的)?(?:QQ)?(?:空间)?(?:说说|动态)\s*[:：,，]?\s*(?:(?:postId|tid|id|编号)\s*(?:为|是|[:：=])?\s*)?[`"'“‘]?([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])/iu.exec(command)
    return !!postId && match?.[1] === postId
  }
  return /^(?:发表|发布|发)(?:布|表)?(?:一条|个|条)?(?:你自己的|你的|自己的|自己|你)?(?:的)?(?:QQ)?(?:空间)?(?:说说|动态)/iu.test(command)
}
async function invoke(context: AgentQzoneToolContext, operation: AgentQzoneOperation): Promise<AgentToolResult> {
  await ensure(context)
  let raw: AgentQzoneResult
  try { raw = await context.qzone!(operation) }
  catch { return { status: 'unknown', content: JSON.stringify({ kind: operation.kind, state: 'unknown', terminal: true, code: 'qzone_outcome_unknown' }) } }
  try {
    const row = qzoneData(raw, ['state', 'kind', 'code', 'postId', 'visitId', 'feeds', 'terminal'])
    if (row.kind !== operation.kind || typeof row.terminal !== 'boolean' || !['confirmed', 'failed', 'unknown'].includes(row.state as string)) throw new Error('qzone_invalid_result')
    const result: Record<string, unknown> = { kind: operation.kind, state: row.state, terminal: row.state === 'unknown' || row.state === 'confirmed' && operation.kind !== 'visit' || row.terminal }
    if (row.state === 'confirmed') {
      const receipt = normalizeAgentQzoneReceipt({ state: 'confirmed', ...(row.postId === undefined ? {} : { postId: row.postId }), ...(row.feeds === undefined ? {} : { feeds: row.feeds }) }, operation)
      if (receipt.state !== 'confirmed') throw new Error('qzone_invalid_result')
      if (operation.kind === 'visit') {
        await ensure(context)
        result.visitId = qzoneToken(row.visitId)
        result.feeds = receipt.feeds
      } else if (row.visitId !== undefined) throw new Error('qzone_invalid_result')
      if (receipt.postId) result.postId = receipt.postId
    } else result.code = row.state === 'unknown' ? 'qzone_outcome_unknown' : normalizeAgentQzoneCode(row.code)
    return { status: row.state === 'confirmed' ? 'succeeded' : row.state as 'failed' | 'unknown', content: JSON.stringify(result) }
  } catch { return { status: 'unknown', content: JSON.stringify({ kind: operation.kind, state: 'unknown', terminal: true, code: 'qzone_invalid_result' }) } }
}
const schema = (properties: Record<string, unknown>, required: readonly string[] = []): AgentTool['parameters'] => Object.freeze({ type: 'object', properties, required, additionalProperties: false })

/** Both surfaces are opt-in. qqZoneTool remains restricted by the host allow/extra policy. */
export function createAgentQzoneTools(options: { readonly enabled?: boolean; readonly simulationEnabled?: boolean } = {}): readonly AgentTool[] {
  const tools: AgentTool[] = []
  if (options.enabled === true) tools.push(Object.freeze<AgentTool>({
    name: 'qqZoneTool', timeoutMs: 60_000,
    // The QQ coordinator injects qzone after the host scopes the context.
    effect: input => ({ actor: 'user', conversation: 'group', metadata: ['request'],
      required: input.type === true ? ['runQqAction'] : ['runQqAction', 'reviewQqText'] }),
    description: '按当前真人的明确请求，以机器人自己的人设发表纯文字 QQ 空间说说，或删除本角色已确认发表的说说。发布传 text；删除传 type:true 和已知稳定 postId。不能按列表位置删除，不支持图片或可见范围。需要宿主显式授权；自主与承诺不可用。',
    parameters: schema({ text: { type: 'string', description: '机器人自己的纯文字说说，最多2000个UTF-16单位；不能冒充请求者或管理员。' },
      type: { type: 'boolean', default: false, description: 'true表示删除本角色已发表的稳定postId。' }, postId: { type: 'string', description: '删除目标的稳定ID，来自已确认发布回执，且须在当前请求中指明。' } }),
    async execute(input: Record<string, unknown>, base: AgentToolContext) {
      const context = base as AgentQzoneToolContext
      try {
        await ensure(context)
        const row = qzoneData(input, ['text', 'type', 'postId'])
        if (row.type !== undefined && typeof row.type !== 'boolean') return failed()
        const deleting = row.type === true
        if (deleting ? row.text !== undefined : row.postId !== undefined) return failed()
        const operation = validateAgentQzoneOperation(deleting ? { kind: 'delete', postId: row.postId } : { kind: 'publish', text: row.text })
        if (!ownIntent(context.request!.text, deleting, 'postId' in operation ? operation.postId : undefined)) return failed()
        return await invoke(context, operation)
      } catch { return failed() }
    },
  }))
  if (options.simulationEnabled === true) tools.push(Object.freeze<AgentTool>({
    name: 'simQzoneInteract', dataPolicy: 'ephemeral', timeoutMs: 60_000,
    effect: input => ({ actor: 'user', conversation: 'group', metadata: ['request'], optional: ['qzoneAffinity'],
      required: ['qzone', 'runQqAction',
        ...(input.action === 'visit' && input.userId === undefined ? ['qzoneCandidates' as const] : []),
        ...(input.action === 'comment' ? ['reviewQqText' as const] : []),
      ] }),
    description: '在获授权的当前真人群聊回合偶尔查看好感达标群友的 QQ 空间。action=visit返回本次visitId及稳定tid；like/comment必须同时传原visitId、userId和tid。评论为短评，最多120个UTF-16单位并脱敏。默认关闭，保留冷却和每日限额，自主或承诺回合禁止使用。',
    parameters: schema({ action: { type: 'string', enum: ['visit', 'like', 'comment'] }, userId: { type: 'string', description: '当前群友ID，visit省略时由宿主候选选择。' },
      tid: { type: 'string', description: '本回合可信visit结果中的稳定说说ID。' }, visitId: { type: 'string', description: '同一真人来源回合内有效的visit凭证。' }, text: { type: 'string', description: 'comment的一句纯文字短评。' } }, ['action']),
    async execute(input: Record<string, unknown>, base: AgentToolContext) {
      const context = base as AgentQzoneToolContext
      try {
        await ensure(context)
        if (context.binding.target.kind !== 'group') return failed()
        const row = qzoneData(input, ['action', 'userId', 'tid', 'visitId', 'text'])
        if (!['visit', 'like', 'comment'].includes(row.action as string)) return failed()
        let userId = row.userId
        if (row.action === 'visit') {
          if (row.tid !== undefined || row.visitId !== undefined || row.text !== undefined) return failed()
          if (userId === undefined) {
            if (typeof context.qzoneCandidates !== 'function') return failed()
            const candidates = qzoneArray(await context.qzoneCandidates(), 2000).map(value => qzoneToken(value))
            await ensure(context)
            if (!candidates.length || new Set(candidates).size !== candidates.length) return failed()
            userId = candidates[randomInt(candidates.length)]
          }
          return await invoke(context, validateAgentQzoneOperation({ kind: 'visit', userId }))
        }
        if (row.action === 'like' && row.text !== undefined) return failed()
        return await invoke(context, validateAgentQzoneOperation({ kind: row.action, userId, postId: row.tid, visitId: row.visitId,
          ...(row.action === 'comment' ? { text: row.text } : {}) }))
      } catch { return failed() }
    },
  }))
  return Object.freeze(tools)
}
