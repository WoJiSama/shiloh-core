import type { CharacterState, CharacterMemory, CharacterGoal, CharacterDecision } from '../../../contracts/character.js'
import { annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'
import { AbstractTool, type ParameterSchema } from '../../toolSupport/infrastructure/AbstractTool.js'
import { normalizeMessageTextsInput } from '../domain/paramTolerance.js'
import { isQqSimulationUserId } from '../domain/simConfig.js'
import { createCharacterTools, type CharacterToolContext } from './characterTools.js'
import { prepareSimulationToolInput } from './simulationToolInput.js'
import type { ToolParameterIssue } from '../../tools/infrastructure/agentToolSchema.js'

export const CHARACTER_TURN_CHOICES = ['chat', 'interest_only', 'silent', 'cannot', 'unauthorized', 'unwilling', 'deferred', 'schedule', 'wait', 'complete', 'abandon'] as const
export type CharacterTurnChoice = typeof CHARACTER_TURN_CHOICES[number]

export interface CharacterTurnFinishResult {
  choice: CharacterTurnChoice
  state: CharacterState
  memories?: CharacterMemory[]
  goal?: CharacterGoal
  decision?: CharacterDecision['kind']
  messages?: string[]
  replyToSeq?: number
  atUserIds?: string[]
  markRead?: boolean
  throughSeq?: number
}

export interface CharacterTurnToolContext extends Pick<CharacterToolContext, 'now' | 'read' | 'update' | 'visibleEvidenceRefs' | 'makeId' | 'sharedSourceIds' | 'memoryInvalidatedAt'> {
  ensureActive(): Promise<void>
  platformUserId?(value: string): boolean
  review?(input: { candidate: Record<string, unknown>; state: CharacterState }): Promise<void>
  finish(result: CharacterTurnFinishResult): Promise<unknown>
}

const GOAL_ACTIONS = { schedule: 'create', wait: 'wait', complete: 'complete', abandon: 'abandon' } as const
const DECISION_CHOICES = new Set(['silent', 'cannot', 'unauthorized', 'unwilling', 'deferred'])
const TOP_FIELDS = ['choice', 'reason', 'memories', 'goal', 'messages', 'replyToSeq', 'atUserIds', 'markRead', 'throughSeq']
const ROUTINE_REASONS = new Map([['chat', '普通聊天收尾'], ['interest_only', '表达兴趣后收尾'], ['silent', '安静收尾']])

class FinishParameterError extends Error {
  constructor(message: string, readonly issue: ToolParameterIssue) { super(message) }
}

function object(value: unknown, allowed: string[], field?: string): Record<string, unknown> {
  const location = field ? { field } : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinishParameterError(`${field ?? '收尾参数'} 必须是对象`,
    { ...location, rule: value === undefined ? 'required' : 'type' })
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new FinishParameterError(`${field ?? '收尾参数'} 包含未声明字段`,
    { ...location, rule: 'additionalProperties' })
  return input
}

function optionalInteger(input: Record<string, unknown>, field: string, min: number): number | undefined {
  if (!Object.hasOwn(input, field)) return undefined
  const value = input[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new FinishParameterError(`${field} 必须是至少 ${min} 的整数`,
    { field, rule: typeof value === 'number' && Number.isSafeInteger(value) ? 'minimum' : 'integer', limit: min })
  return value
}

function nestedSchema(tool: AbstractTool): ParameterSchema {
  return {
    ...structuredClone(tool.parameters),
    properties: Object.fromEntries(Object.entries(tool.parameters.properties).filter(([key]) => key !== 'action').map(([key, value]) => [key, structuredClone(value)])),
    required: tool.parameters.required.filter(key => key !== 'action'),
    description: tool.description,
  }
}

interface TurnInput extends Omit<CharacterTurnFinishResult, 'state' | 'memories' | 'goal' | 'decision'> {
  reason: string
  memories: Record<string, unknown>[]
  goal?: Record<string, unknown>
}

function parse(input: Record<string, unknown>, memoryFields: string[], goalFields: string[], isUserId: (value: string) => boolean): TurnInput {
  object(input, TOP_FIELDS)
  if (typeof input.choice !== 'string' || !CHARACTER_TURN_CHOICES.includes(input.choice as CharacterTurnChoice)) throw new FinishParameterError('choice 必须是明确的允许选项', { field: 'choice', rule: 'enum' })
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 600) throw new FinishParameterError('reason 必须是非空、至多 600 字符的简短理由，不写思考过程',
    { field: 'reason', rule: input.reason === undefined ? 'required' : typeof input.reason !== 'string' ? 'type' : !input.reason.trim() ? 'blank' : 'maxLength', limit: 600 })
  const choice = input.choice as CharacterTurnChoice
  const memories = Object.hasOwn(input, 'memories') ? input.memories : []
  if (!Array.isArray(memories) || memories.length > 2) throw new FinishParameterError('memories 必须是至多两条记忆的数组', { field: 'memories', rule: Array.isArray(memories) ? 'maxItems' : 'type', limit: 2 })
  const checkedMemories = memories.map(value => object(value, memoryFields, 'memories'))
  const goalAction = Object.hasOwn(GOAL_ACTIONS, choice)
  const goal = goalAction ? object(input.goal, goalFields, 'goal') : undefined
  if (!goalAction && Object.hasOwn(input, 'goal')) throw new FinishParameterError('当前 choice 不接受 goal', { field: 'goal', rule: 'incompatible' })
  let messages: string[] | undefined
  if (Object.hasOwn(input, 'messages')) {
    if (choice === 'silent' || choice === 'deferred') throw new FinishParameterError('silent/deferred 不接受 messages', { field: 'messages', rule: 'incompatible' })
    const values = normalizeMessageTextsInput(input.messages)
    if (!Array.isArray(values) || values.length < 1 || values.length > 5 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 500))
      throw new FinishParameterError('messages 必须是 1 至 5 条非空字符串，每条至多 500 字符', { field: 'messages', rule: 'message_list' })
    messages = values as string[]
  }
  const replyToSeq = optionalInteger(input, 'replyToSeq', 1)
  const throughSeq = optionalInteger(input, 'throughSeq', 0)
  const markRead = input.markRead
  if (Object.hasOwn(input, 'markRead') && typeof markRead !== 'boolean') throw new FinishParameterError('markRead 必须为布尔值', { field: 'markRead', rule: 'type' })
  if (markRead !== undefined && throughSeq !== undefined) throw new FinishParameterError('markRead 和 throughSeq 只能提交一个', { field: 'markRead', rule: 'incompatible' })
  let atUserIds: string[] | undefined
  if (Object.hasOwn(input, 'atUserIds')) {
    const values = input.atUserIds
    if (!Array.isArray(values) || values.length > 3 || values.some(value => typeof value !== 'string' || !isUserId(value)))
      throw new FinishParameterError('atUserIds 必须是当前平台的成员 ID，至多 3 个字符串', { field: 'atUserIds', rule: 'member_list', limit: 3 })
    atUserIds = values as string[]
  }
  if (!messages && (replyToSeq !== undefined || atUserIds !== undefined)) throw new FinishParameterError('replyToSeq/atUserIds 只能与 messages 一起使用',
    { field: replyToSeq === undefined ? 'atUserIds' : 'replyToSeq', rule: 'incompatible' })
  return {
    choice, reason: input.reason.trim(), memories: checkedMemories,
    ...(goal === undefined ? {} : { goal }), ...(messages === undefined ? {} : { messages }),
    ...(replyToSeq === undefined ? {} : { replyToSeq }), ...(atUserIds === undefined ? {} : { atUserIds }),
    ...(typeof markRead === 'boolean' ? { markRead } : {}),
    ...(throughSeq === undefined ? {} : { throughSeq }),
  }
}

/** Validate with the existing tools on a private draft, then commit once. No transport is owned here. */
export function createCharacterTurnTool(ctx: CharacterTurnToolContext): AbstractTool {
  const isUserId = ctx.platformUserId ?? isQqSimulationUserId
  const schemas = createCharacterTools({ ...ctx,
    selectGoal: async () => { throw new Error('收尾不支持 focus') }, onDecision: () => {},
  })
  const memoryTool = schemas.find(tool => tool.name === 'simCharacterMemory')!
  const goalTool = schemas.find(tool => tool.name === 'simGoal')!
  const memoryFields = Object.keys(memoryTool.parameters.properties).filter(key => key !== 'action')
  const goalFields = Object.keys(goalTool.parameters.properties).filter(key => key !== 'action')

  class FinishTurnTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simFinishTurn'
      this.description = '结束本轮时必须提交顶层 choice。chat普通聊天、interest_only仅有兴趣不承诺后续、silent旁听、cannot做不到、unauthorized未授权、unwilling不愿意、deferred暂缓；这些选择不自动建目标。schedule创建新自主目标，wait调整已有目标，complete完成有本目标成功回执的目标，abandon放弃目标。可显式保存至多两条有来源记忆；所有变更先完整校验再一次保存，成功后才交运行时发送可选消息、标读并结束本轮。reason只写简短选择理由。goal与memories都不传action，schedule也不传id；不支持focus。不推测聊天文字、不补来源、不自动发消息或重试。保存失败不表示安排或完成已生效，拒绝仍然自由。silent/deferred禁止messages；其余选择可发1至5条消息。需要标读时用 markRead=true，由系统计算连续已展示的位置。'
      this.parameters = {
        type: 'object', additionalProperties: false, required: ['choice'], properties: {
          choice: { type: 'string', enum: [...CHARACTER_TURN_CHOICES], description: '必填。依据本轮实际选择，普通回话填 chat，安静旁听填 silent。' },
          reason: { type: 'string', minLength: 1, maxLength: 600, description: '本轮选择的简短理由。chat、interest_only、silent 可省略，其余 choice 必填。' },
          memories: { type: 'array', maxItems: 2, description: '仅角色自己的经历、兴趣、观点。社交待办 pendingEvent 和本群相处习惯 interaction 请在收尾前单独调用 simRemember。每项不传 action 或新记录 id。', items: nestedSchema(memoryTool) },
          goal: { ...nestedSchema(goalTool), description: `仅 schedule/wait/complete/abandon 使用，操作由 choice 固定，不传 action。${goalTool.description}` },
          messages: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 500 }, description: '可选的最终群消息，填写字符串数组，例如 ["你好"]。silent/deferred 省略此字段。' },
          replyToSeq: { type: 'number', minimum: 1, description: '可选：引用已展示的消息序号，须为整数。' },
          atUserIds: { type: 'array', maxItems: 3, items: { type: 'string', ...(ctx.platformUserId ? { minLength: 1, maxLength: 128 } : { pattern: '^\\d{1,12}$' }) } },
          markRead: { type: 'boolean', description: '传 true 标读已经连续展示的消息，遇到未展示的消息时停下。省略或传 false 保留已读位置。' },
          throughSeq: { type: 'number', minimum: 0 },
        },
      }
    }
    override getToolInfo() {
      const info = super.getToolInfo()
      // Accept recorded calls that used the old numeric cursor.
      const { throughSeq: _legacyCursor, ...properties } = info.parameters.properties
      return { ...info, parameters: { ...info.parameters, properties } }
    }
    override normalizeParameters(params: unknown) {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('收尾参数必须是对象')
      const input = params as Record<string, unknown>
      const normalized = { ...input }
      if (Object.hasOwn(input, 'messages')) {
        if (input.messages === null && (input.choice === 'silent' || input.choice === 'deferred')) delete normalized.messages
        else normalized.messages = normalizeMessageTextsInput(input.messages)
      }
      const reason = typeof input.choice === 'string' && !Object.hasOwn(input, 'reason') ? ROUTINE_REASONS.get(input.choice) : undefined
      if (reason !== undefined) normalized.reason = reason
      return normalized
    }
    override validateParameters(params: Record<string, unknown>, onInvalid?: (issue: ToolParameterIssue) => void) {
      try { parse(params, memoryFields, goalFields, isUserId); return true }
      catch (error) {
        if (error instanceof FinishParameterError) onInvalid?.(error.issue)
        return error instanceof Error ? error.message : '收尾参数无效'
      }
    }
    override async func(params: Record<string, unknown>): Promise<unknown> {
      const input = parse(params, memoryFields, goalFields, isUserId)
      let step = 'finish_authorization'
      try {
        await ctx.ensureActive()
        step = 'finish_state_read'
        const snapshot = structuredClone(await ctx.read())
        let draft = structuredClone(snapshot), changed = false
        const visible = [...ctx.visibleEvidenceRefs()]
        const localTools = createCharacterTools({
          now: ctx.now, read: async () => structuredClone(draft),
          update: async mutate => { draft = mutate(structuredClone(draft)); changed = true; return structuredClone(draft) },
          visibleEvidenceRefs: () => [...visible], makeId: ctx.makeId,
          ...(ctx.sharedSourceIds ? { sharedSourceIds: ctx.sharedSourceIds } : {}),
          ...(ctx.memoryInvalidatedAt ? { memoryInvalidatedAt: ctx.memoryInvalidatedAt } : {}),
          selectGoal: async () => { throw new Error('收尾不支持 focus') }, onDecision: () => {},
        })
        const apply = async (name: string, value: Record<string, unknown>) => {
          const tool = localTools.find(tool => tool.name === name)!
          let issue: ToolParameterIssue | undefined, failure: unknown
          const invalid = (value: ToolParameterIssue) => { issue = value }
          const args = prepareSimulationToolInput(tool, value, undefined, invalid)
          if (typeof args === 'string') throw annotateAgentError(new Error(args), { cause: 'finish_draft_invalid', ...issue })
          const result = await tool.execute(args, {}, { invalid, failed: error => { failure = error } })
          if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
            const error = new Error(typeof result === 'string' ? result : '角色草稿校验失败', { cause: failure })
            throw annotateAgentError(error, { ...issue, ...(failure === undefined ? { cause: 'finish_draft_invalid' } : {}) })
          }
        }
        step = 'finish_memory_draft'
        for (const memory of input.memories) await apply('simCharacterMemory', { ...memory, action: 'remember' })
        step = 'finish_goal_draft'
        if (input.goal) await apply('simGoal', { ...input.goal, action: GOAL_ACTIONS[input.choice as keyof typeof GOAL_ACTIONS] })
        step = 'finish_decision_draft'
        if (DECISION_CHOICES.has(input.choice)) await apply('simDecide', { kind: input.choice, reason: input.reason })
        step = 'finish_review'
        await ctx.review?.({ candidate: { ...structuredClone(input) }, state: structuredClone(draft) })
        step = 'finish_source_check'
        await ctx.ensureActive()
        const stillVisible = new Set(ctx.visibleEvidenceRefs())
        const submittedRefs = [...input.memories, ...(input.goal ? [input.goal] : [])].flatMap(item => Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [])
        if (submittedRefs.some(ref => typeof ref !== 'string' || !stillVisible.has(ref))) {
          throw annotateAgentError(new Error('一致性检查期间引用来源已不可见，收尾未提交'), { cause: 'finish_source_changed' })
        }
        step = 'finish_commit'
        const state = changed ? await ctx.update(current => {
          if (current.revision !== snapshot.revision) throw annotateAgentError(new Error('角色状态已改变，收尾未提交，请重新读取后选择'),
            { cause: 'character_revision_changed', result: 'not_saved' })
          return structuredClone(draft)
        }) : snapshot
        step = 'finish_apply'
        const goal = input.goal ? state.goals.find(item => !snapshot.goals.some(old => old.id === item.id) || (item.id === input.goal!.id && item.revision !== snapshot.goals.find(old => old.id === item.id)?.revision)) : undefined
        return await ctx.finish({ choice: input.choice, state,
          memories: state.memories.filter(item => !snapshot.memories.some(old => old.id === item.id)),
          ...(goal ? { goal } : {}),
          ...(DECISION_CHOICES.has(input.choice) && state.decision ? { decision: state.decision.kind } : {}),
          ...(input.messages === undefined ? {} : { messages: input.messages }),
          ...(input.replyToSeq === undefined ? {} : { replyToSeq: input.replyToSeq }),
          ...(input.atUserIds === undefined ? {} : { atUserIds: input.atUserIds }),
          ...(input.markRead === undefined ? {} : { markRead: input.markRead }),
          ...(input.throughSeq === undefined ? {} : { throughSeq: input.throughSeq }),
        })
      } catch (error) {
        throw annotateAgentError(error, { step, ...(step !== 'finish_commit' && step !== 'finish_apply' ? { result: 'not_saved' } : {}) })
      }
    }
  }
  return new FinishTurnTool()
}
