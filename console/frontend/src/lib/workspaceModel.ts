import { parseConfigProcessState, type ConfigProcessState } from './consoleRestart'

export interface WorkspaceAccount {
  platform: string
  namespace: string
  id: string
}
export interface WorkspaceTarget {
  account: WorkspaceAccount
  kind: string
  id: string
}
export interface WorkspaceConversation {
  scopeKey: string
  bindingToken: string
  name?: string
  sharedGroup?: boolean
  binding: {
    source: 'configured'
    id: string
    revision: string
    agentId: string
    personaId: string
    connectionId: string
    target: WorkspaceTarget
  }
}
export interface WorkspaceAgent {
  id: string
  name: string
  personaId: string
  personaName: string
  conversations: WorkspaceConversation[]
}
export interface WorkspaceConnection {
  id: string
  account: WorkspaceAccount
  name?: string
  personaId?: string
  memorySpaceId?: string
  state: 'connected' | 'disconnected' | 'unknown'
  conversationCount: number
  capabilities: string[]
}
export interface WorkspaceCapability {
  operation: string
  scope: 'global' | 'conversation'
  status: 'available' | 'forbidden' | 'unavailable' | 'restart-required'
  reason: string
  effect: 'read' | 'write'
  authorizedScopes?: string[]
}
export interface ConsoleWorkspace {
  mode: 'standalone'
  version: 1
  observedAt: number
  revision: string
  agents: WorkspaceAgent[]
  connections: WorkspaceConnection[]
  capabilities: WorkspaceCapability[]
  configState: ConfigProcessState
  cognition: { status: 'planned' }
}
const fail = (): never => {
  throw new Error('工作区响应不完整或身份不一致，请刷新核对')
}
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : fail()
function text(value: unknown, max = 4096, empty = false): string {
  return typeof value === 'string' &&
    value.length <= max &&
    (empty || !!value.trim()) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : fail()
}
function list(value: unknown, max = 10000): any[] {
  return Array.isArray(value) && value.length <= max ? value : fail()
}
function account(value: unknown): WorkspaceAccount {
  const raw = record(value)
  return { platform: text(raw.platform), namespace: text(raw.namespace), id: text(raw.id) }
}
function displayName(value: unknown, id: string): string | undefined {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name !== id && name.length <= 128 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : undefined
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail()
}
export function parseWorkspace(value: unknown): ConsoleWorkspace {
  const raw = record(value)
  if (
    raw.mode !== 'standalone' ||
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.observedAt) ||
    raw.observedAt <= 0 ||
    record(raw.cognition).status !== 'planned'
  )
    fail()
  let configState: ConfigProcessState
  try {
    configState = parseConfigProcessState(raw.configState)
  } catch {
    return fail()
  }
  const connections: WorkspaceConnection[] = list(raw.connections).map((value) => {
    const item = record(value)
    if (
      !['connected', 'disconnected', 'unknown'].includes(item.state) ||
      !Number.isSafeInteger(item.conversationCount) ||
      item.conversationCount < 0
    )
      fail()
    const identity = account(item.account), name = displayName(item.name, identity.id)
    return {
      id: text(item.id),
      account: identity,
      ...(name ? { name } : {}),
      ...(item.personaId === undefined ? {} : { personaId: text(item.personaId, 128) }),
      ...(item.memorySpaceId === undefined ? {} : { memorySpaceId: text(item.memorySpaceId, 64) }),
      state: item.state,
      conversationCount: item.conversationCount,
      capabilities: list(item.capabilities, 1000).map((value) => text(value))
    }
  })
  unique(connections.map((item) => item.id))
  const agents: WorkspaceAgent[] = list(raw.agents).map((value) => {
    const item = record(value),
      id = text(item.id),
      personaId = text(item.personaId)
    const conversations: WorkspaceConversation[] = list(item.conversations).map((value) => {
      const row = record(value),
        b = record(row.binding),
        target = record(b.target),
        a = account(target.account)
      const binding = {
        source: 'configured' as const,
        id: text(b.id),
        revision: text(b.revision),
        agentId: text(b.agentId),
        personaId: text(b.personaId),
        connectionId: text(b.connectionId),
        target: { account: a, kind: text(target.kind), id: text(target.id) }
      }
      if (
        b.source !== 'configured' ||
        binding.agentId !== id ||
        !['group', 'private', 'channel', 'thread'].includes(binding.target.kind)
      )
        fail()
      const connection = connections.find((item) => item.id === binding.connectionId)
      if (!connection || (connection.personaId ?? personaId) !== binding.personaId ||
        JSON.stringify(connection.account) !== JSON.stringify(a)) fail()
      const scopeKey = text(row.scopeKey),
        bindingToken = text(row.bindingToken, 8192)
      if (
        scopeKey !==
        JSON.stringify([id, a.platform, a.namespace, a.id, binding.target.kind, binding.target.id])
      )
        fail()
      const name = displayName(row.name, binding.target.id)
      return { scopeKey, bindingToken, binding, ...(name ? { name } : {}), ...(row.sharedGroup === true ? { sharedGroup: true } : {}) }
    })
    return {
      id,
      name: text(item.name, 256),
      personaId,
      personaName: text(item.personaName, 256),
      conversations
    }
  })
  unique(agents.map((item) => item.id))
  unique(agents.flatMap((item) => item.conversations.map((row) => row.scopeKey)))
  const capabilities: WorkspaceCapability[] = list(raw.capabilities, 1000).map((value) => {
    const item = record(value)
    if (
      !['global', 'conversation'].includes(item.scope) ||
      !['available', 'forbidden', 'unavailable', 'restart-required'].includes(item.status) ||
      !['read', 'write'].includes(item.effect)
    )
      fail()
    const authorizedScopes =
      item.authorizedScopes === undefined && item.scope === 'global'
        ? undefined
        : list(item.authorizedScopes).map((value) => text(value))
    if (authorizedScopes) {
      unique(authorizedScopes)
      const scopes = new Set(
        agents.flatMap((agent) => agent.conversations.map((row) => row.scopeKey))
      )
      if (authorizedScopes.some((scope) => !scopes.has(scope))) fail()
    }
    return {
      operation: text(item.operation),
      scope: item.scope,
      status: item.status,
      reason: text(item.reason, 2000, true),
      effect: item.effect,
      ...(authorizedScopes ? { authorizedScopes } : {})
    }
  })
  unique(capabilities.map((item) => item.operation))
  return {
    mode: 'standalone',
    version: 1,
    observedAt: raw.observedAt,
    revision: text(raw.revision),
    agents,
    connections,
    capabilities,
    configState,
    cognition: { status: 'planned' }
  }
}
export function robotLabel(agent: WorkspaceAgent, agents: readonly WorkspaceAgent[]) {
  return agents.some((item) => item.id !== agent.id && item.name === agent.name)
    ? `${agent.name}（本人标识 · ${agent.id}）`
    : agent.name
}
export const connectionStateLabel = (state: WorkspaceConnection['state']) =>
  ({ connected: '已连接', disconnected: '已断开', unknown: '状态未知' })[state]
export const statusLabel = (status: WorkspaceCapability['status']) =>
  ({
    available: '可用',
    forbidden: '未授权',
    unavailable: '暂不可用',
    'restart-required': '等待重启'
  })[status]
export function robotLocation(
  agent: WorkspaceAgent,
  tab = 'home',
  conversation?: WorkspaceConversation
) {
  return {
    path: `/robots/${encodeURIComponent(agent.id)}/${tab}`,
    query: conversation
      ? {
          connection: conversation.binding.connectionId,
          scopeKey: conversation.scopeKey,
          bindingToken: conversation.bindingToken
        }
      : {}
  }
}
export function selectConversation(agent: WorkspaceAgent, query: Record<string, unknown>) {
  if (query.scopeKey === undefined && query.bindingToken === undefined) return undefined
  if (typeof query.scopeKey !== 'string' || typeof query.bindingToken !== 'string')
    throw new Error('会话链接缺少完整的绑定版本，请从会话列表重新打开')
  const selected = agent.conversations.find(
    (row) => row.scopeKey === query.scopeKey && row.bindingToken === query.bindingToken
  )
  if (
    !selected ||
    (query.connection !== undefined && query.connection !== selected.binding.connectionId)
  )
    throw new Error('会话链接已失效或不属于这个机器人，请从会话列表重新打开')
  return selected
}
