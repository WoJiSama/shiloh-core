import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import type { AgentRedPacketRequest, AgentRedPacketResult } from '../../../contracts/agentQqRedPacket.js'
import { hasAgentRedPacketRequest } from '../../runtime/infrastructure/agentRedPacketRuntime.js'
import { redPacketData, redPacketText } from '../../runtime/infrastructure/agentRedPacketValidation.js'

export interface AgentRedPacketToolOptions {
  readonly enabled?: boolean
  /** Core binds this callback to its fixed request, policy, live source checks and persistent runtime. */
  execute?(request: AgentRedPacketRequest, context: AgentToolContext): Promise<AgentRedPacketResult>
}
const failed = (code: string): AgentToolResult => ({ status: 'failed', content: JSON.stringify({ action: 'red-packet', state: 'failed', code }) })
export function createAgentRedPacketTools(options: AgentRedPacketToolOptions = {}): readonly AgentTool[] {
  const execute = options.execute
  if (options.enabled !== true || typeof execute !== 'function') return Object.freeze([])
  const tool = Object.freeze<AgentTool>({
    name: 'grabRedBagTool',
    effect: input => input.confirm === false ? {} : { actor: 'user', conversation: 'group', required: ['runQqAction'], metadata: ['request'] },
    description: '仅按当前真人明确请求领取当前群已核验红包。confirm默认true，false取消。只可选择可信来源message_id或packet_ref；查最近、引用失败后回退及代发口令须各自获显式授权。不确定结果停止，不重复领取。',
    dataPolicy: 'ephemeral',
    parameters: Object.freeze({ type: 'object', additionalProperties: false, required: Object.freeze([]), properties: Object.freeze({
      confirm: Object.freeze({ type: 'boolean', default: true, description: '确认领取；false取消且不调用外部接口' }),
      message_id: Object.freeze({ type: 'string', description: '当前真人消息、可信引用或宿主已提供的红包来源ID；不得猜测' }),
      packet_ref: Object.freeze({ type: 'string', description: '宿主提供的opaque红包引用；不得编造，不能与message_id并用' }),
    }) }),
    async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
      let dispatched = false
      try {
        const row = redPacketData(input, ['confirm', 'message_id', 'packet_ref'])
        if (row.confirm !== undefined && typeof row.confirm !== 'boolean' || row.message_id !== undefined && row.packet_ref !== undefined) return failed('red_packet_invalid_input')
        // Cancellation is a local operation and must not read wallet/history/member data.
        if (row.confirm === false) return { status: 'succeeded', content: JSON.stringify({ action: 'red-packet', state: 'cancelled', code: 'red_packet_cancelled', grabbed: false }) }
        if (context.actor.kind !== 'user' || !context.actor.user || context.binding.target.kind !== 'group' || !context.request ||
            typeof context.ensureCurrent !== 'function' || !hasAgentRedPacketRequest(context.request.text) || context.signal.aborted || !context.isCurrent()) return failed('red_packet_not_authorized')
        const request: AgentRedPacketRequest = Object.freeze({ ...(row.confirm === undefined ? {} : { confirm: row.confirm as boolean }),
          ...(row.message_id === undefined ? {} : { messageId: redPacketText(row.message_id) }),
          ...(row.packet_ref === undefined ? {} : { packetRef: redPacketText(row.packet_ref) }) })
        dispatched = true
        const raw = redPacketData(await execute(request, context), ['state', 'phase', 'code', 'passwordConfirmed', 'grabbed', 'amountFen'])
        if (!['confirmed', 'failed', 'unknown', 'cancelled', 'skipped'].includes(raw.state as string) ||
            !['claimed', 'password_pending', 'password_confirmed', 'grab_pending', 'finished'].includes(raw.phase as string) ||
            typeof raw.code !== 'string' || !/^red_packet_[a-z_]{1,80}$/u.test(raw.code) ||
            typeof raw.passwordConfirmed !== 'boolean' || typeof raw.grabbed !== 'boolean' ||
            raw.state === 'confirmed' && (raw.grabbed !== true || !Number.isSafeInteger(raw.amountFen) || Number(raw.amountFen) < 1) ||
            raw.state !== 'confirmed' && (raw.grabbed || raw.amountFen !== undefined)) return { status: 'unknown', content: JSON.stringify({ action: 'red-packet', state: 'unknown', code: 'red_packet_invalid_result' }) }
        return { status: raw.state === 'confirmed' ? 'succeeded' : raw.state === 'unknown' ? 'unknown' : 'failed',
          content: JSON.stringify({ action: 'red-packet', ...raw }) }
      } catch { return dispatched ? { status: 'unknown', content: JSON.stringify({ action: 'red-packet', state: 'unknown', code: 'red_packet_execution_unknown' }) } : failed('red_packet_invalid_input') }
    },
  })
  return Object.freeze([tool])
}
