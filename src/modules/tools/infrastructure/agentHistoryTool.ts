import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import { isToolActionDenied } from '../../conversation/domain/toolActionPolicy.js'

const fields = ['question', 'user_id', 'start_time', 'end_time', 'keywords', 'limit', 'offset', 'source', 'memory_ids']
const sources = ['all', 'recent', 'archive', 'memory']
const failed = (status: string, message: string): AgentToolResult => ({ status: 'failed',
  content: JSON.stringify({ action: 'chat_history', success: false, status, message }) })

function current(context: AgentToolContext): boolean {
  return context.actor.kind === 'user' && !!context.actor.user && !!context.request?.messageId &&
    !context.signal.aborted && context.isCurrent()
}
async function ensure(context: AgentToolContext): Promise<void> {
  if (!current(context)) throw new Error('历史查询所属真人请求已失效')
  await context.ensureCurrent?.()
  if (!current(context)) throw new Error('历史查询所属真人请求已失效')
}
function boundedInput(input: Record<string, unknown>): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !fields.includes(name))) return false
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) return false
  if (input.user_id !== undefined && (typeof input.user_id !== 'string' || !input.user_id.trim() || input.user_id.length > 240)) return false
  for (const name of ['start_time', 'end_time']) {
    if (input[name] !== undefined && (typeof input[name] !== 'string' || input[name].length > 100)) return false
  }
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.length > 20 ||
      Array.from(input.keywords).some(value => typeof value !== 'string' || value.length > 100))) return false
  if (input.memory_ids !== undefined && (!Array.isArray(input.memory_ids) || input.memory_ids.length > 50 ||
      Array.from(input.memory_ids).some(value => typeof value !== 'string' || !value.trim() || value.length > 200))) return false
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) return false
  if (input.offset !== undefined && (typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 100000)) return false
  return input.source === undefined || typeof input.source === 'string' && sources.includes(input.source)
}

/** History scope, target resolution and privacy projection belong to the Core reader. */
export function createAgentHistoryTool(): AgentTool {
  return {
    name: 'chatHistoryTool',
    description: '检索当前场景的原始发言和有来源记忆；与本人私聊时可查询宿主授权群中的本人历史。支持时间、主题、分来源分页及真实记忆ID详情。只根据返回证据回答，未命中不代表从未发生，转发内容不等于转发者说过。',
    parameters: { type: 'object', properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000, description: '当前用户要回忆或查证的问题。' },
      user_id: { type: 'string', maxLength: 240, description: '明确发言人的真实平台标识；私聊只允许当前本人，不能猜测。' },
      start_time: { type: 'string', maxLength: 100, description: '含时区的ISO 8601或北京时间日期YYYY-MM-DD，包含开始边界。' },
      end_time: { type: 'string', maxLength: 100, description: '含时区的ISO 8601或北京时间日期YYYY-MM-DD，日期包含当天整日。' },
      keywords: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 }, description: '原文主题词；不传时由查询服务从问题提取。' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: '每类来源默认20条，最多50条。' },
      offset: { type: 'number', minimum: 0, maximum: 100000, description: '默认0；按返回next_offsets选来源继续分页。' },
      source: { type: 'string', enum: sources, description: '默认all；recent为当前会话，archive仅私聊本人授权群原文，memory为有来源长期记忆。' },
      memory_ids: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 }, description: '展开已返回memory_index中的真实ID，不能猜测ID扩大范围。' },
    }, required: ['question'], additionalProperties: false },
    async execute(input, context) {
      if (!boundedInput(input)) return failed('invalid_query', '历史查询参数无效或超过数量、长度、分页上限。')
      if (!current(context)) return failed('unavailable', '当前没有可核验的真人历史查询请求。')
      if (isToolActionDenied(context.request!.text, 'chatHistoryTool')) return failed('forbidden', '本条消息没有授权查询历史。')
      if (!context.readHistory) return failed('unavailable', '当前宿主未提供历史查询端口，本次无法核实。')
      await ensure(context)
      const content = await context.readHistory(input)
      await ensure(context)
      return { status: 'succeeded', content }
    },
  }
}
