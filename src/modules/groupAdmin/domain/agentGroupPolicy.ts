export const defaultAgentGroupPolicy = Object.freeze({
  enabled: true,
  foldLongMessages: false,
  maxLength: 1500,
  maxLines: 0,
  forwardFolded: true,
})
export type AgentGroupPolicy = { -readonly [K in keyof typeof defaultAgentGroupPolicy]: (typeof defaultAgentGroupPolicy)[K] extends boolean ? boolean : number }
type Override = Partial<AgentGroupPolicy> & { connectionId: string; groupId: string }

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(name => !names.includes(name))) throw new Error('群管理设置包含无效字段')
  return value as Record<string, unknown>
}

export function readAgentGroupPolicyValues(value: unknown, extra: readonly string[] = []): Partial<AgentGroupPolicy> {
  const raw = fields(value, [...Object.keys(defaultAgentGroupPolicy), ...extra])
  const result: Partial<AgentGroupPolicy> = {}
  for (const key of ['enabled', 'foldLongMessages', 'forwardFolded'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new Error('群管理开关需要布尔值')
    result[key] = raw[key]
  }
  for (const [key, min, max] of [['maxLength', 100, 20000], ['maxLines', 0, 2000]] as const) {
    const input = raw[key]
    if (input === undefined) continue
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error('群管理长度上限无效')
    result[key] = input
  }
  return result
}

export function readAgentGroupPolicy(value: unknown) {
  const raw = fields(value ?? {}, [...Object.keys(defaultAgentGroupPolicy), 'groups'])
  const defaults = Object.freeze({ ...defaultAgentGroupPolicy, ...readAgentGroupPolicyValues(raw, ['groups']) })
  const input = raw.groups ?? []
  if (!Array.isArray(input) || input.length > 256) throw new Error('单群审核配置数量无效')
  const groups: Override[] = []
  const scopes = new Set<string>()
  for (const entry of input) {
    const settings = readAgentGroupPolicyValues(entry, ['connectionId', 'groupId'])
    const { connectionId, groupId } = entry as Record<string, unknown>
    if (typeof connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(connectionId) ||
        typeof groupId !== 'string' || !/^[1-9]\d{4,11}$/u.test(groupId)) throw new Error('单群审核配置需要连接 ID 和群号')
    const scope = connectionId + '/' + groupId
    if (scopes.has(scope)) throw new Error('同一连接下的群管理设置不能重复')
    scopes.add(scope)
    groups.push({ connectionId, groupId, ...settings })
  }
  return { defaults, groups, effective(connectionId: string, groupId: string): AgentGroupPolicy {
    const group = groups.find(row => row.connectionId === connectionId && row.groupId === groupId)
    if (!group) return defaults
    const { connectionId: _connection, groupId: _group, ...overrides } = group
    return { ...defaults, ...overrides }
  } }
}
