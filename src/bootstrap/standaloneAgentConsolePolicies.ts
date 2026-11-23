import { AgentConsoleError } from '../contracts/agentConsole.js'
import { isSeq, type Document } from 'yaml'

type Setting = Readonly<{
  field: string
  label: string
  value: boolean | number | string | readonly string[]
  range?: readonly [number, number]
  options?: readonly string[]
}>
const switchField = (field: string, label: string, value = false): Setting => ({ field, label, value })
const intField = (field: string, label: string, value: number, min: number, max: number): Setting => ({ field, label, value, range: [min, max] })
const note = (field: string, label: string): Setting => ({ field, label, value: '' })
function readValue(host: Document, setting: Setting) {
  const value = host.getIn(setting.field.split('.'))
  return (isSeq(value) ? value.toJSON() : value) ?? setting.value
}

const policies: Readonly<Record<string, { title: string; fields: readonly Setting[] }>> = {
  conversation: { title: '对话配置', fields: [
    switchField('privateChat.enabled', '响应已绑定的好友私聊'),
    switchField('simulation.wakeGate.enabled', '使用模型判断是否主动接话', true),
    switchField('personalFollow.enabled', '允许自主跟进公开信息', true),
  ] },
  reasoning: { title: '推理设置', fields: [
    { field: 'model.reasoningEffort', label: '主对话推理强度', value: '',
      options: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    note('simulation.wakeGate.model', '主动接话判断模型（留空沿用人物提取模型）'),
  ] },
  tracking: { title: '运行记录', fields: [
    intField('logging.maxFiles', '最多保留日志文件数', 14, 1, 128),
    intField('logging.maxFileBytes', '单个日志文件最大字节数', 8 * 1024 * 1024, 65536, 67108864),
    intField('logging.retentionDays', '日志保留天数', 14, 1, 365),
  ] },
  memory: { title: '记忆与学习策略', fields: [
    switchField('history.enabled', '保存会话历史'),
    intField('history.retentionDays', '历史保留天数', 30, 1, 90),
    intField('history.maxMessagesPerConversation', '每个会话保留的历史条数', 1000, 50, 2000),
    switchField('memorySystem.enabled', '提取人物记忆'),
    switchField('groupMemory.enabled', '提取群记忆'),
    switchField('midtermMemory.enabled', '生成会话摘要'),
    switchField('episodicMemory.enabled', '整理会话情节'),
    switchField('semanticMemory.enabled', '语义索引与检索'),
    switchField('semanticMemory.groupOnly', '语义来源仅限群聊'),
    intField('semanticMemory.retentionDays', '语义原文保留天数', 30, 1, 90),
    intField('semanticMemory.topK', '语义召回条数', 5, 1, 10),
    switchField('cognition.enabled', '启用统一认知'),
  ] },
  pipeline: { title: '搬运与投递配置', fields: [
    switchField('mediaRelay.enabled', '自动搬运符合条件的链接'),
    switchField('mediaRelay.douyin.enabled', '抖音'),
    switchField('mediaRelay.xiaohongshu.enabled', '小红书'),
    switchField('mediaRelay.youtube.enabled', 'YouTube'),
    switchField('mediaRelay.pixiv.enabled', 'Pixiv'),
    switchField('mediaRelay.bilibili.autoAuthorizedRetry', 'B 站授权重试'),
    switchField('bilibiliQuality.enabled', 'B 站高清搬运与授权'),
    switchField('torrentDownload.enabled', '磁链下载与投递'),
    switchField('groupLog.enabled', '团录'),
  ] },
  riskControl: { title: '消息与安全边界', fields: [
    switchField('forbiddenWords.enabled', '检查词表', true),
    switchField('forbiddenWords.blockOutput', '拦截命中词表的输出', true),
    { field: 'forbiddenWords.words', label: '词表', value: [] },
  ] },
  groupAdmin: { title: '群审核默认策略', fields: [
    switchField('groupAdmin.enabled', '审核明显广告与刷屏', true),
    switchField('groupAdmin.foldLongMessages', '折叠超长纯文字消息'),
    intField('groupAdmin.maxLength', '超长判定字数', 1500, 100, 20000),
    intField('groupAdmin.maxLines', '超长判定行数，0 为关闭', 0, 0, 2000),
    switchField('groupAdmin.forwardFolded', '撤回后发送合并转发', true),
  ] },
}

export function standalonePolicyView(host: Document, kind: string) {
  if (!Object.hasOwn(policies, kind)) return undefined
  const policy = policies[kind]!
  return { title: policy.title, fields: policy.fields.map(setting => ({
    field: setting.field, label: setting.label, value: readValue(host, setting),
    component: setting.options ? 'Select' : typeof setting.value === 'boolean' ? 'Switch' :
      typeof setting.value === 'number' ? 'InputNumber' : Array.isArray(setting.value) ? 'GTags' : 'Input',
    secret: false, componentProps: setting.range ? { min: setting.range[0], max: setting.range[1], step: 1 } :
      setting.options ? { options: setting.options.map(value => ({ value, label: value || '使用服务商默认配置' })) } : {},
  })) }
}

export function updateStandalonePolicy(host: Document, kind: string, values: Readonly<Record<string, unknown>>): number | undefined {
  if (!Object.hasOwn(policies, kind)) return undefined
  const policy = policies[kind]!
  let changed = 0
  for (const [key, value] of Object.entries(values)) {
    const setting = policy.fields.find(item => item.field === key)
    if (!setting || !valid(setting, value)) throw new AgentConsoleError('invalid_request')
    const keys = key.split('.')
    if (JSON.stringify(readValue(host, setting)) === JSON.stringify(value)) continue
    if (setting.value === '' && value === '') host.deleteIn(keys)
    else {
      if (keys[0] === 'mediaRelay' && keys.length > 2 && host.getIn(['mediaRelay']) === undefined) host.set('mediaRelay', { enabled: false })
      host.setIn(keys, value)
    }
    changed++
  }
  return changed
}

function valid(setting: Setting, value: unknown): boolean {
  if (setting.options) return typeof value === 'string' && setting.options.includes(value)
  if (setting.range) return typeof value === 'number' && Number.isSafeInteger(value) && value >= setting.range[0] && value <= setting.range[1]
  if (Array.isArray(setting.value)) return Array.isArray(value) && value.length <= 200 &&
    value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(item))
  return typeof setting.value === 'boolean' ? typeof value === 'boolean' :
    typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value)
}
