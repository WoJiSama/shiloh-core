import type {
  AgentBindingSnapshot,
  AgentConversationScope,
  AgentDefinition,
  ConversationAddress,
  ConversationKind,
  PlatformAccountRef,
  PlatformConnection,
} from '../../../contracts/agentBinding.js'

const conversationKinds = new Set<string>(['group', 'private', 'channel', 'thread'])
const internalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isPlatformIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function isPlatformAccount(account: PlatformAccountRef | undefined | null): account is PlatformAccountRef {
  return !!account && typeof account.platform === 'string' && internalIdPattern.test(account.platform) &&
    isPlatformIdentifier(account.namespace) && isPlatformIdentifier(account.id)
}

export function isConversationAddress(target: ConversationAddress | undefined | null): target is ConversationAddress {
  return !!target && isPlatformAccount(target.account) && conversationKinds.has(target.kind) && isPlatformIdentifier(target.id)
}

export function samePlatformNamespace(left: PlatformAccountRef, right: PlatformAccountRef): boolean {
  return left.platform === right.platform && left.namespace === right.namespace
}

export function platformAccountKey(account: PlatformAccountRef): string {
  return JSON.stringify([account.platform, account.namespace, account.id])
}

export function conversationAddressKey(target: ConversationAddress): string {
  const { account, kind, id } = target
  return JSON.stringify([account.platform, account.namespace, account.id, kind, id])
}

export function decodeConversationAddressKey(key: string): ConversationAddress | null {
  if (key.length > 4096) return null
  try {
    const values: unknown = JSON.parse(key)
    if (!Array.isArray(values) || values.length !== 5) return null
    const [platform, namespace, accountId, kind, conversationId] = values
    if (typeof kind !== 'string' || !conversationKinds.has(kind)) return null
    const target: ConversationAddress = {
      account: { platform: internalId(platform, 'platform'), namespace: identifier(namespace, 'namespace'), id: identifier(accountId, 'accountId') },
      kind: kind as ConversationKind,
      id: identifier(conversationId, 'conversationId'),
    }
    return conversationAddressKey(target) === key ? target : null
  } catch {
    return null
  }
}

export function agentConversationKey({agentId, target}: AgentConversationScope): string {
  const {account, kind, id} = target
  return JSON.stringify([agentId, account.platform, account.namespace, account.id, kind, id])
}

export function agentPersonaScopeId(agentId: string): string {
  return `agent:${agentId}`
}

export function decodeAgentConversationKey(key: string): AgentConversationScope | null {
  if (key.length > 4096) return null
  try {
    const values: unknown = JSON.parse(key)
    if (!Array.isArray(values) || values.length !== 6) return null
    const [agent, platform, namespace, accountId, kind, conversationId] = values
    if (typeof kind !== 'string' || !conversationKinds.has(kind)) return null
    const scope = {
      agentId: internalId(agent, 'agentId'),
      target: {
        account: {platform:internalId(platform, 'platform'), namespace:identifier(namespace, 'namespace'), id:identifier(accountId, 'accountId')},
        kind: kind as ConversationKind,
        id: identifier(conversationId, 'conversationId'),
      },
    }
    return agentConversationKey(scope) === key ? scope : null
  } catch {
    return null
  }
}

export function agentBindingToken(binding: AgentBindingSnapshot): string {
  return JSON.stringify([binding.source, binding.id, binding.revision, binding.agentId, binding.personaId, binding.connectionId])
}

export function agentBindingIdentity(binding: AgentBindingSnapshot): string {
  return JSON.stringify([binding.source, binding.id, binding.agentId, binding.personaId, binding.connectionId])
}

function fail(field: string): never {
  throw new Error(`角色绑定配置无效：${field}`)
}

function fields(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) fail(`${field} 含未知字段`)
  return result
}

function identifier(value: unknown, field: string): string {
  if (!isPlatformIdentifier(value)) fail(field)
  return value
}

function internalId(value: unknown, field: string): string {
  const id = identifier(value, field)
  if (!internalIdPattern.test(id)) fail(field)
  return id
}

function entries(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(field)
  return value
}

export function createAgentBindingDirectory(value: unknown, revision: string, validateAddress?: (target: ConversationAddress) => void) {
  const raw = fields(value, '根节点', ['version', 'agents', 'connections', 'bindings'])
  if (raw.version !== 1) fail('version 须为 1')
  const agents = new Map<string, AgentDefinition>()
  const connections = new Map<string, PlatformConnection>()
  const accounts = new Map<string, PlatformConnection>()
  const bindings = new Map<string, AgentBindingSnapshot>()

  for (const [index, entry] of entries(raw.agents, 'agents').entries()) {
    const label = `agents[${index}]`
    const agent = fields(entry, label, ['id', 'personaId'])
    const id = internalId(agent.id, `${label}.id`)
    if (agents.has(id)) fail(`${label}.id 重复`)
    agents.set(id, { id, personaId: identifier(agent.personaId, `${label}.personaId`) })
  }

  for (const [index, entry] of entries(raw.connections, 'connections').entries()) {
    const label = `connections[${index}]`
    const connection = fields(entry, label, ['id', 'platform', 'namespace', 'accountId'])
    const id = internalId(connection.id, `${label}.id`)
    const account = Object.freeze({
      platform: internalId(connection.platform, `${label}.platform`),
      namespace: identifier(connection.namespace, `${label}.namespace`),
      id: identifier(connection.accountId, `${label}.accountId`),
    })
    const key = platformAccountKey(account)
    if (connections.has(id) || accounts.has(key)) fail(`${label} 的连接 ID 或平台账号重复`)
    const configured = Object.freeze({ id, account })
    connections.set(id, configured)
    accounts.set(key, configured)
  }

  for (const [index, entry] of entries(raw.bindings, 'bindings').entries()) {
    const label = `bindings[${index}]`
    const binding = fields(entry, label, ['connectionId', 'kind', 'conversationId', 'agentId'])
    const agent = agents.get(internalId(binding.agentId, `${label}.agentId`))
    const connection = connections.get(internalId(binding.connectionId, `${label}.connectionId`))
    if (!agent || !connection) fail(`${label} 引用的角色或连接不存在`)
    if (typeof binding.kind !== 'string' || !conversationKinds.has(binding.kind)) fail(`${label}.kind`)
    const target = Object.freeze({
      account: connection.account,
      kind: binding.kind as ConversationKind,
      id: identifier(binding.conversationId, `${label}.conversationId`),
    })
    validateAddress?.(target)
    const key = conversationAddressKey(target)
    if (bindings.has(key)) fail(`${label} 的会话已绑定`)
    bindings.set(key, Object.freeze({
      source: 'configured',
      id: key,
      revision,
      agentId: agent.id,
      personaId: agent.personaId,
      connectionId: connection.id,
      target,
    }))
  }

  return {
    resolve: (target: ConversationAddress) => bindings.get(conversationAddressKey(target)),
    connectionFor: (account: PlatformAccountRef) => accounts.get(platformAccountKey(account)),
    connectionById: (id: string) => connections.get(id),
    listBindings: (): readonly AgentBindingSnapshot[] => [...bindings.values()],
  }
}
