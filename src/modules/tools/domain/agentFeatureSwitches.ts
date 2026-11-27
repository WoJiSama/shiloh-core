import type { ConversationAddress } from '../../../contracts/agentBinding.js'

export const agentFeatures = Object.freeze({
  mediaRelay: '自动视频与媒体搬运',
  bilibiliQuality: 'B 站高清下载与扫码授权',
  musicExtraction: '音乐分享提取',
  torrentDownload: '磁链下载与文件交付',
  dice: '骰子指令',
  groupLog: '团录',
  'turtle-soup': '海龟汤',
  'uma-race': '赛马娘',
  localEmojiCollection: '自动收藏表情',
  automaticRedPackets: '自动领取红包',
})

export type AgentFeatureName = keyof typeof agentFeatures
type GlobalMode = 'all' | 'off'
export type AgentFeatureRule = { readonly mode: GlobalMode } | { readonly mode: 'groups'; readonly groups: readonly string[] }
export interface AgentFeatureSwitches {
  readonly default?: GlobalMode
  readonly features?: Readonly<Partial<Record<AgentFeatureName, AgentFeatureRule>>>
  readonly tools?: Readonly<Record<string, AgentFeatureRule>>
}

function fields(value: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null ||
      allowed && Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${path} 包含无效字段`)
  return value as Record<string, unknown>
}

export function normalizeAgentFeatureSwitches(value: unknown): Required<AgentFeatureSwitches> {
  const raw = value === undefined ? {} : fields(value, 'featureSwitches', ['default', 'features', 'tools'])
  const mode = raw.default === undefined ? 'all' : raw.default
  if (mode !== 'all' && mode !== 'off') throw new Error('featureSwitches.default 须为 all 或 off')

  function readRules(kind: 'features' | 'tools'): Readonly<Record<string, AgentFeatureRule>> {
    const path = `featureSwitches.${kind}`
    const input = raw[kind] === undefined ? {} : fields(raw[kind], path)
    const rules: Record<string, AgentFeatureRule> = Object.create(null)
    for (const [name, value] of Object.entries(input)) {
      if (kind === 'features' ? !Object.hasOwn(agentFeatures, name) : !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(name)) {
        throw new Error(`${path} 包含无效名称`)
      }
      const rulePath = `${path}.${name}`
      const rule = fields(value, rulePath, ['mode', 'groups'])
      if (rule.mode === 'groups') {
        const groups: unknown = rule.groups
        if (!Array.isArray(groups) ||
            !groups.every((id: unknown): id is string => typeof id === 'string' && /^[1-9][0-9]{0,127}$/u.test(id))) {
          throw new Error(`${rulePath}.groups 须为 QQ 群号字符串列表`)
        }
        rules[name] = Object.freeze({ mode: 'groups', groups: Object.freeze([...new Set<string>(groups)].sort()) })
      } else if ((rule.mode === 'all' || rule.mode === 'off') && !Object.hasOwn(rule, 'groups')) {
        rules[name] = Object.freeze({ mode: rule.mode })
      } else throw new Error(`${rulePath} 须为 all、off 或 groups 模式`)
    }
    return Object.freeze(rules)
  }

  return Object.freeze({ default: mode, features: readRules('features'), tools: readRules('tools') })
}

export function createAgentFeatureSwitches(value: AgentFeatureSwitches | undefined) {
  const policy = normalizeAgentFeatureSwitches(value)
  function allows(rules: Readonly<Record<string, AgentFeatureRule | undefined>>, name: string, target: ConversationAddress): boolean {
    const rule = Object.hasOwn(rules, name) ? rules[name] : undefined
    if (rule?.mode === 'groups') return target.kind === 'group' && target.account.platform === 'qq' && target.account.namespace === 'global' && rule.groups.includes(target.id)
    return (rule?.mode ?? policy.default) === 'all'
  }

  return {
    feature: (name: AgentFeatureName, target: ConversationAddress) => allows(policy.features, name, target),
    tool: (name: string, target: ConversationAddress) => allows(policy.tools, name, target),
  }
}
