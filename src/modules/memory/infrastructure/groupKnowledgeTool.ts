import type { MessageActionPort } from '../../../contracts/platformMessage.js'
import type { ConversationMemberSnapshot } from '../../../contracts/platformConnection.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import type { createGroupMemoryManagement, GroupMemoryManagementContext } from './groupMemoryManagement.js'

export interface GroupKnowledgeRequest extends GroupMemoryManagementContext {
  readonly userText: string
  allowsText(text: string): boolean
  reportOutcome?(status: 'succeeded' | 'failed'): void
}

/** The current main model selects intent; persisted teaching never authorizes a send. */
export function createGroupKnowledgeTool(ports: {
  management: ReturnType<typeof createGroupMemoryManagement>
  member(target: GroupMemoryManagementContext['binding']['target'], userId: string, signal: AbortSignal, guard: () => boolean): Promise<ConversationMemberSnapshot | undefined>
  actions: MessageActionPort
}) {
  return new class GroupKnowledgeTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'groupKnowledgeTool'
      this.description = '仅响应当前真人的明确请求，查看或管理本群已保存资料。list列出；delete按编号删除；forget按完整名称遗忘，歧义须追问；clear须管理员在30秒内另一条新消息携带确认码再次确认。notify仅执行已保存工作流：当前用户必须明确要求现在通知这些人，正文与requestExcerpt都逐字来自本条消息。历史教学、自动说法和自主回合都不授权通知。'
      this.parameters = { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'delete', 'forget', 'clear', 'notify'] },
        id: { type: 'string', description: 'delete/notify使用list返回的完整编号' },
        subject: { type: 'string', description: 'forget使用完整名称，不做模糊匹配' },
        confirmationId: { type: 'string', description: 'clear第二条真人消息中提供的确认码' },
        requestExcerpt: { type: 'string', description: 'notify：本条真人消息中要求立即通知的完整原句' },
        content: { type: 'string', description: 'notify：从本条真人消息逐字摘出的通知正文，最多300字' },
      }, required: ['action'], additionalProperties: false }
    }

    override async func(input: Record<string, unknown>, event: unknown): Promise<string> {
      const value = event && typeof event === 'object' ? event as {
        _agentBinding?: GroupMemoryManagementContext['binding']
        _isAgentBindingCurrent?: () => boolean
        _ensureAgentToolCurrent?: () => Promise<void>
        _agentToolSignal?: AbortSignal
        _agentRequestMessageId?: string
        _agentUserText?: string
        _agentAllowsText?: (text: string) => boolean
        simulationReportOutcome?: GroupKnowledgeRequest['reportOutcome']
        simulationActor?: { kind?: string; userId?: string; userName?: string }
      } : {}
      const binding = value._agentBinding
      const actor = value.simulationActor
      const requestMessageId = value._agentRequestMessageId
      if (!binding || !actor || actor.kind !== 'user' || !actor.userId || !requestMessageId ||
          !value._isAgentBindingCurrent?.()) return '当前仿真回合没有可用的真人请求。'
      const signal = value._agentToolSignal ?? AbortSignal.timeout(45_000)
      const isCurrent = () => !signal.aborted && value._isAgentBindingCurrent?.() === true
      return await this.executeForRequest(input, {
        binding,
        actor: { kind: 'user', user: { ...binding.target.account, id: actor.userId } },
        signal,
        requestMessageId,
        userText: value._agentUserText ?? '',
        isCurrent,
        ensureCurrent: async () => { await value._ensureAgentToolCurrent?.(); if (!isCurrent()) throw new Error('仿真回合已失效') },
        allowsText: value._agentAllowsText ?? (() => true),
        ...(value.simulationReportOutcome ? { reportOutcome: value.simulationReportOutcome } : {}),
      })
    }

    async executeForRequest(input: Record<string, unknown>, context: GroupKnowledgeRequest): Promise<string> {
      if (context.actor.kind !== 'user' || context.binding.target.kind !== 'group' || !context.isCurrent() || context.signal.aborted) return '当前会话没有可用的真人请求。'
      if (Object.keys(input).some(key => !Object.hasOwn(this.parameters.properties, key)) ||
          Object.values(input).some(value => typeof value !== 'string') || JSON.stringify(input).length > 4096 || this.validateParameters(input) !== true) return '群资料工具参数无效。'
      const text = (key: string) => typeof input[key] === 'string' ? input[key] as string : ''
      const report = (result: { status: string; deleted?: number; confirmationId?: string }) => {
        if (result.status === 'deleted' || result.status === 'cleared') return `已${result.status === 'cleared' ? '清空' : '删除'}本群资料，共${result.deleted ?? 0}条。`
        if (result.status === 'confirmation_required') return `请由同一位管理员在30秒内再发一条新消息确认清空本群资料，并附确认码：${result.confirmationId}。`
        const reasons: Record<string, string> = { forbidden: '只有创建者或当前群管理员可删除；清空须群管理员。',
          cancelled: '会话或消息来源已改变，操作已停止。', unavailable: '本次操作未获有效确认，请先核实。',
          not_found: '没有找到这条当前可用的本群资料。', ambiguous: '这个名称对应多项资料，请先提供准确编号。',
          invalid_confirmation: '确认码已过期、会话不匹配或不是另一条新消息，请重新申请清空。',
          capacity_exceeded: '删除记录已达容量上限，本次未修改资料。', invalid_request: '请提供完整编号或准确名称。' }
        return reasons[result.status] ?? '本次操作没有可用的确认结果。'
      }
      try {
        await context.ensureCurrent?.()
        if (input.action === 'list') {
          const result = await ports.management.list(context)
          if (result.status !== 'listed') return report(result)
          const rows = result.entries.slice(-40)
          return rows.length ? `本群已保存资料（最近${rows.length}条）：\n${rows.map(entry =>
            `${entry.id} [${entry.kind}${'kind' in entry.persona ? '；旧群教学，提交人格版本未记录' : ''}] ${entry.text ?? entry.subject ?? entry.condition ?? ''}${entry.targetUserIds.length ? ` → ${entry.targetUserIds.join('、')}` : ''}`).join('\n')}` : '本群目前没有可用的已保存资料。'
        }
        if (input.action === 'delete') return report(await ports.management.delete({ id: text('id') }, context))
        if (input.action === 'forget') return report(await ports.management.forget({ subject: text('subject') }, context))
        if (input.action === 'clear') {
          const confirmationId = text('confirmationId')
          if (confirmationId && !context.userText.includes(confirmationId)) return '请在另一条新消息中明确提供确认码。'
          return report(await ports.management.clear(confirmationId ? { confirmationId } : {}, context))
        }
        if (input.action !== 'notify') return '群资料工具参数无效。'
        const excerpt = text('requestExcerpt').trim(), content = text('content').trim()
        if (excerpt.length < 2 || !context.userText.includes(excerpt) || !content || content.length > 300 ||
            !context.userText.includes(content) || !context.allowsText(content) || sanitizeFinalReplyText(content) !== content) return '请在当前消息中明确说出通知请求和要发送的正文。'
        const listed = await ports.management.list(context)
        if (listed.status !== 'listed') return report(listed)
        const entry = listed.entries.find(item => item.id === text('id') && item.kind === 'workflow')
        if (!entry || !entry.targetUserIds.length || entry.targetUserIds.length > 20) return '没有找到可执行的本群工作流，请先查看并确认编号。'
        for (const id of entry.targetUserIds) if (!await ports.member(context.binding.target, id, context.signal, context.isCurrent)) return '通知对象已无法核验，本次没有发送。'
        await context.ensureCurrent?.()
        const refreshed = await ports.management.list(context)
        if (refreshed.status !== 'listed' || !refreshed.entries.some(item => item.id === entry.id && JSON.stringify(item) === JSON.stringify(entry)) ||
            !context.isCurrent() || context.signal.aborted) return '工作流或会话已改变，本次没有发送。'
        const receipt = await ports.actions.send({ version: 1, kind: 'message.send', target: context.binding.target, binding: context.binding,
          replyTo: context.requestMessageId, parts: [
            ...entry.targetUserIds.map(id => ({ kind: 'mention' as const, user: { ...context.binding.target.account, id } })),
            { kind: 'text', text: content },
          ] }, { isCurrent: () => !context.signal.aborted && context.isCurrent() })
        if (receipt.state === 'sent' || receipt.state === 'failed') {
          context.reportOutcome?.(receipt.state === 'sent' ? 'succeeded' : 'failed')
        }
        return receipt.state === 'sent' ? '已按本条请求通知工作流中的成员。' : receipt.state === 'failed'
          ? '本次通知未发送成功。' : '本次通知结果未确认，可能已经发送，请先核实，不要重复执行。'
      } catch { return '本次操作未获有效确认，请先核实，不要重复执行。' }
    }
  }()
}
