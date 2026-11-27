import type { ConversationAddress, PlatformConnection } from '../contracts/agentBinding.js'
import { validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { defaultDingTalkReplyPolicy, type DingTalkConnectionOptions, type DingTalkReplyPolicy } from '../adapters/dingTalkConnection.js'

const dingId = /^[A-Za-z0-9_@.$=+/-]{1,128}$/u
const environmentName = /^[A-Z_][A-Z0-9_]{0,127}$/u

export function validateStandaloneBindingAddress(target: ConversationAddress): void {
  validateQqBindingAddress(target)
  if (target.account.platform !== 'dingtalk') return
  if (!['group', 'private'].includes(target.kind) ||
      ![target.account.namespace, target.account.id, target.id].every(id => dingId.test(id) && id !== '0')) throw new Error('钉钉会话和账号标识无效')
}

export function readDingTalkReplyPolicy(input: unknown, complete = false): DingTalkReplyPolicy {
  if (input === undefined && !complete) return defaultDingTalkReplyPolicy
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(defaultDingTalkReplyPolicy, key)) ||
      complete && Object.keys(input).length !== Object.keys(defaultDingTalkReplyPolicy).length) throw new Error('钉钉回复规则字段无效')
  const raw = input as Record<string, unknown>
  const { mode = defaultDingTalkReplyPolicy.mode, requireMention = defaultDingTalkReplyPolicy.requireMention } = raw
  if ((mode !== 'both' && mode !== 'private' && mode !== 'group') || typeof requireMention !== 'boolean') throw new Error('钉钉回复范围或群聊 @ 设置无效')
  function ids(key: string): string[] {
    const value = raw[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 256 || value.some(id => typeof id !== 'string' || !dingId.test(id) || id === '0') ||
        new Set(value).size !== value.length) throw new Error(`钉钉回复规则的 ${key} 须为不重复的有效标识列表（最多 256 项）`)
    return [...value]
  }
  return { mode, requireMention, allowUserIds: ids('allowUserIds'), denyUserIds: ids('denyUserIds'),
    allowGroupIds: ids('allowGroupIds'), denyGroupIds: ids('denyGroupIds') }
}

type ParsedConnection = Pick<DingTalkConnectionOptions, 'connection' | 'name' | 'clientId' | 'clientSecret'> & { replyPolicy: DingTalkReplyPolicy }

export function readStandaloneDingTalkConnection(item: Record<string, unknown>, connection: PlatformConnection,
  env: NodeJS.ProcessEnv, requireCredentials: boolean): ParsedConnection {
  if (item.transport !== 'dingtalk-stream' || Object.keys(item).some(key => !['id', 'transport', 'name', 'clientIdEnv', 'clientSecretEnv', 'replyPolicy'].includes(key)) ||
    ![connection.account.namespace, connection.account.id].every(id => dingId.test(id) && id !== '0')) throw new Error('钉钉连接须使用 dingtalk-stream 和有效企业、机器人标识')
  function credential(value: unknown): string {
    if (typeof value !== 'string' || !environmentName.test(value)) throw new Error('钉钉应用凭据须引用环境变量')
    const data = env[value]?.trim() ?? ''
    if (data.length > 4096 || /[\u0000-\u001f\u007f]/u.test(data) || requireCredentials && !data) throw new Error(`环境变量 ${value} 缺少有效的钉钉应用凭据`)
    return data
  }
  if (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(item.name))) throw new Error('钉钉机器人显示名称无效')
  return { connection, name: typeof item.name === 'string' ? item.name.trim() : '钉钉机器人',
    clientId: credential(item.clientIdEnv), clientSecret: credential(item.clientSecretEnv), replyPolicy: readDingTalkReplyPolicy(item.replyPolicy) }
}
