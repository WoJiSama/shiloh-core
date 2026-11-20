import type { PlatformConnection, PlatformUserRef } from '../contracts/agentBinding.js'
import { QQ_OWNER_ALERT_MAX_LENGTH } from '../contracts/agentDiagnostics.js'
import type { AlertBatch } from '../modules/runtime/infrastructure/agentFailureAlerts.js'
import { qqId } from '../adapters/qqIdentity.js'

type Alert = AlertBatch['alerts'][number]

const stageNames: Record<Alert['stage'], string> = {
  host: '宿主服务',
  inbox: '消息处理',
  model: '模型请求',
  tool: '工具执行',
  delivery: '消息投递',
  memory: '记忆处理',
  runtime: '后台运行',
  notification: '通知发送',
}

const operationNames = new Map(Object.entries({
  configuration_load: '读取服务配置',
  host_authority: '宿主运行授权',
  host_log: '后台运行',
  host_run: '宿主运行',
  operation_journal: '操作日志写入',
  alert_queue: '告警队列',
  onebot_disconnect: 'QQ 连接',
  onebot_recovery: 'QQ 重连',
  onebot_admission: '接收 QQ 消息',
  consume_simulation: '处理群消息队列',
  simulation_ingest: '处理群消息',
  provider_http: '请求模型服务',
  provider_request: '请求模型服务',
  provider_recovery: '模型服务重试',
  model_request: '请求模型',
  simulation_main: '主对话模型',
  simulation_turn: '群聊回合',
  simulation_wake_gate: '唤醒预判',
  wake_gate_provider_http: '唤醒预判请求',
  simulation_meme_extract: '群梗提取',
  meme_provider_http: '群梗提取请求',
  conversation_summary: '会话摘要',
  summary_provider_http: '会话摘要请求',
  simulation_person_profile_extract: '提取群成员画像',
  text_person_profile_extract: '提取人物事实',
  person_memory_provider_http: '人物记忆请求',
  group_memory_provider_http: '群记忆请求',
  simulation_image_description: '识别消息图片',
  media_prepare: '准备搬运内容',
  media_provider_prepare: '获取搬运内容',
  media_deliver: '搬运内容投递',
  media_failure_notice: '搬运失败通知',
  bilibili_provider_identify: '解析 B 站链接',
  bilibili_provider_download: '下载 B 站媒体',
  bilibili_provider_prepare: '准备 B 站搬运',
  douyin_provider_prepare: '准备抖音搬运',
  simFinishTurn: '结束群聊回合',
  simGetUnreadMessages: '读取未读消息',
  simGetMessageImages: '读取消息图片',
  simGetForward: '读取合并转发',
  simSendMessage: '发送群聊消息',
  send_send: '发送消息',
  'onebot.send_private_msg': '发送 QQ 私聊消息',
  'onebot.send_group_msg': '发送 QQ 群消息',
}))

const failureReasons = new Map(Object.entries({
  configuration_unavailable: '服务配置无法读取或未通过校验。',
  host_authority_lost: '服务失去了运行所需的授权或连接。',
  connection_lost: '与 QQ 的连接已断开。',
  onebot_rejected: 'QQ 接口拒绝了本次请求。',
  onebot_response_unconfirmed: 'QQ 接口未返回可确认的结果。',
  onebot_transport_unconfirmed: '与 QQ 通信时未收到确认回执。',
  inbox_retry_pending: '消息处理未完成，系统会重试。',
  event_not_queued: '收到的消息未能加入处理队列。',
  admission_not_confirmed: '系统未能确认消息已进入队列。',
  diagnostic_journal_failed: '操作日志未能及时写入。',
  diagnostic_queue_overflow: '等待写入日志的操作过多。',
  alert_group_overflow: '告警种类过多，超出容量的告警已合并计数。',
  wake_gate_timeout: '唤醒预判未在规定时间内完成。',
  wake_gate_unavailable: '唤醒预判未能给出有效结果。',
  provider_timeout: '等待外部服务响应超时。',
  provider_transport_error: '与外部服务通信时发生网络错误。',
  http_error: '服务返回了错误状态。',
  provider_error: '模型服务返回了错误。',
  provider_warning: '模型服务在请求或重试时报告了异常。',
  model_response_error: '模型返回了错误。',
  model_response_invalid: '模型返回的内容或格式无效。',
  image_model_response_error: '图片识别服务未给出有效结果。',
  model_threw: '调用模型时发生异常。',
  summary_timeout: '摘要任务未在规定时间内完成。',
  summary_failed: '会话摘要未能生成或保存。',
  summary_store_unavailable: '摘要存储暂时不可用。',
  summary_queue_unavailable: '摘要队列暂时不可用。',
  source_identification_failed: '未能识别分享链接中的作品。',
  prepare_failed: '未能获取搬运需要的内容。',
  prepare_unavailable: '媒体来源暂时无法提供搬运内容。',
  provider_threw: '请求外部服务时发生异常。',
  video_candidate_failed: '这个视频下载地址未能成功提供文件。',
  image_candidate_failed: '这个图片下载地址未能成功提供文件。',
  video_plan_incomplete: '未能下载完整的全部视频分段。',
  request_unfulfilled: '请求的内容未能交付。',
  explanation_failed: '未能生成或发送失败说明。',
  returned_error: '操作返回了错误结果。',
  returned_failed: '操作返回了失败结果。',
  returned_unknown: '系统未收到可确认的操作结果。',
  tool_reply_failed: '工具报告本次执行失败。',
  effect_rejected: '接收端拒绝了本次投递。',
  effect_unknown: '暂时无法确认内容是否已送达。',
  delivery_failed: '投递过程遇到异常，暂时无法确认是否送达。',
  operation_exception: '执行操作时发生异常。',
  runtime_error: '运行过程中发生异常。',
  tool_budget_exhausted: '本轮工具调用已达到上限。',
}))

const httpReasons = new Map([
  [400, '服务拒绝了请求参数。'],
  [401, '请求未通过服务的身份验证。'],
  [403, '服务拒绝了访问请求。'],
  [404, '服务找不到请求的资源。'],
  [408, '服务等待请求超时。'],
  [429, '服务限制了请求频率或额度。'],
  [504, '网关等待上游服务响应超时。'],
])

const exceptionReasons = new Map<Alert['errorKind'], string>([
  ['TimeoutError', '等待操作完成超时。'],
  ['AbortError', '操作在完成前被中断。'],
  ['SyntaxError', '处理数据时发现格式错误。'],
  ['TypeError', '处理数据时遇到类型不匹配。'],
  ['RangeError', '处理的数值或长度超出了允许范围。'],
])

export function resolveStandaloneQqAlertOwner(connectionId: string, connections: readonly PlatformConnection[], masters: readonly PlatformUserRef[]): PlatformUserRef {
  const connection = connections.find(candidate => candidate.id === connectionId)
  const owner = masters[0]
  if (!connection || connection.account.platform !== 'qq' || connection.account.namespace !== 'global' || masters.length !== 1 ||
      owner?.platform !== 'qq' || owner.namespace !== 'global' || qqId(owner.id) !== owner.id ||
      connections.some(candidate => candidate.account.platform === 'qq' && candidate.account.namespace === 'global' && candidate.account.id === owner.id)) {
    throw new Error('QQ 主人告警需要一个有效 QQ 连接和唯一的 bilibiliQuality.masters 主人')
  }
  return owner
}

export function formatQqOwnerAlerts(batch: AlertBatch): string {
  function format(includeOperation: boolean) {
    const lines = batch.alerts.map(alert => {
      const warning = alert.code === 'runtime_warning' || alert.code === 'provider_warning'
      const outcome = alert.outcome === 'unknown' ? '结果待确认' : warning ? '出现警告' : '失败'
      const operation = operationNames.get(alert.operation) ?? (alert.operation.startsWith('onebot.') ? '调用 QQ 接口' :
        alert.operation.startsWith('mcp.') ? '连接 MCP 工具服务' : stageNames[alert.stage])
      const code = alert.code === 'redacted' ? undefined : alert.code
      const status = alert.httpStatus
      const httpReason = status === undefined ? undefined : httpReasons.get(status) ??
        (status >= 500 && status <= 599 ? '外部服务暂时不可用。' : undefined)
      const knownReason = code && failureReasons.get(code)
      const reason = httpReason || knownReason || exceptionReasons.get(alert.errorKind) ||
        (alert.outcome === 'unknown' ? '暂时无法确认操作是否完成。' : warning ? '后台报告了警告，详情见运行日志。' : '系统未记录更具体的原因，详情见运行日志。')
      const details = [code && `错误码 ${code}`, status !== undefined && `HTTP 状态 ${status}`,
        includeOperation && alert.operation !== 'redacted' && `操作标识 ${alert.operation}`].filter(Boolean).join(' · ')
      return [`${operation}${outcome}，共 ${alert.count} 次`, reason, details,
        alert.traceId && `追踪编号 ${alert.traceId}`].filter(Boolean).join('\n')
    })
    return ['【助手运行告警】', ...lines].join('\n\n')
  }
  const text = format(true)
  // A full QQ batch may be too long when every entry has a long diagnostic label.
  return text.length <= QQ_OWNER_ALERT_MAX_LENGTH ? text : format(false)
}
