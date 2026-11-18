import type { ConfigSaveResult } from './consoleRestart'

export type ConfigurationJson =
  null | boolean | number | string | ConfigurationJson[] | { [key: string]: ConfigurationJson }
export type ConfigurationTransport = 'forward-websocket' | 'reverse-websocket'
export interface ConfigurationReadSet {
  host: string
  personas: string
  bindings: string
}
export interface ConfigurationAccount {
  platform: 'qq'
  namespace: 'global'
  id: string
}
export interface ConfigurationTarget {
  account: ConfigurationAccount
  kind: 'group' | 'private'
  id: string
}
export interface ConfigurationConversation {
  agentId: string
  connectionId: string
  target: ConfigurationTarget
}
export interface ConfigurationConnection {
  id: string
  account: ConfigurationAccount
  transport: ConfigurationTransport
}
export interface ConfigurationCatalog {
  mode: 'standalone'
  revision: string
  configRevision: string
  processEpoch: string
  readSet: ConfigurationReadSet
  agents: { agentId: string; personaId: string }[]
  personas: { id: string; name: string }[]
  connections: ConfigurationConnection[]
  capabilities: { requiresRestart: true; atomicMultiFile: true }
}
export type ConfigurationChange =
  | {
      kind: 'connection.add'
      agentId: string
      connection: {
        id: string
        accountId: string
        transport: ConfigurationTransport
        url: string
        accessTokenEnv?: string
      }
      conversations: { kind: 'group' | 'private'; conversationId: string }[]
    }
  | {
      kind: 'agent.create'
      agentId: string
      personaId: string
      newPersona?: { id: string; name: string; [field: string]: ConfigurationJson }
    }
export interface ConfigurationPreview {
  mode: 'standalone'
  processEpoch: string
  revision: string
  configRevision: string
  previewId: string
  candidateDigest: string
  readSet: ConfigurationReadSet
  expiresAt: number
  requiresRestart: true
  changes: {
    file: 'host' | 'personas' | 'bindings'
    path: string
    action: 'add' | 'change'
    before: ConfigurationJson
    after: ConfigurationJson
  }[]
  affected: {
    agents: string[]
    connections: { id: string; account: ConfigurationAccount }[]
    conversations: ConfigurationConversation[]
  }
  permissions: {
    scopeKey: string
    mode: 'text' | 'simulation' | 'private-disabled' | 'private'
    tools: string[]
    note: string
  }[]
}
export interface ConfigurationCommitResult extends ConfigSaveResult<ConfigurationCatalog> {
  requiresRestart: true
  transactionId: string
}
const invalid = (): never => {
  throw new Error('配置候选响应不完整或来源不一致，请保留草稿后重新核对')
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid()
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}
function text(value: unknown, max = 256, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid()
  return value as string
}
function internalId(value: unknown) {
  const id = text(value, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) invalid()
  return id
}
function personaId(value: unknown) {
  const id = text(value, 128)
  if (id.trim() !== id) invalid()
  return id
}
function qqId(value: unknown) {
  const id = text(value, 128)
  if (!/^[1-9][0-9]*$/u.test(id)) invalid()
  return id
}
function list(value: unknown, maximum = 10000): unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : invalid()
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) invalid()
}
function account(value: unknown): ConfigurationAccount {
  const raw = record(value)
  fields(raw, ['platform', 'namespace', 'id'])
  if (raw.platform !== 'qq' || raw.namespace !== 'global') invalid()
  return { platform: 'qq', namespace: 'global', id: qqId(raw.id) }
}
function transport(value: unknown): ConfigurationTransport {
  return value === 'forward-websocket' || value === 'reverse-websocket' ? value : invalid()
}
function readSet(value: unknown): ConfigurationReadSet {
  const raw = record(value)
  fields(raw, ['host', 'personas', 'bindings'])
  return { host: text(raw.host), personas: text(raw.personas), bindings: text(raw.bindings) }
}
function capabilities(value: unknown) {
  const raw = record(value)
  fields(raw, ['requiresRestart', 'atomicMultiFile'])
  if (raw.requiresRestart !== true || raw.atomicMultiFile !== true) invalid()
  return { requiresRestart: true as const, atomicMultiFile: true as const }
}
function base(raw: Record<string, unknown>) {
  if (raw.mode !== 'standalone') invalid()
  return {
    mode: 'standalone' as const,
    revision: text(raw.revision),
    configRevision: text(raw.configRevision),
    processEpoch: text(raw.processEpoch),
    readSet: readSet(raw.readSet)
  }
}
export const configurationScopeKey = (row: ConfigurationConversation) =>
  JSON.stringify([
    row.agentId,
    row.target.account.platform,
    row.target.account.namespace,
    row.target.account.id,
    row.target.kind,
    row.target.id
  ])

export function parseConfigurationCatalog(value: unknown): ConfigurationCatalog {
  const raw = record(value)
  fields(raw, [
    'mode',
    'revision',
    'configRevision',
    'processEpoch',
    'readSet',
    'agents',
    'personas',
    'connections',
    'capabilities'
  ])
  const personas = list(raw.personas, 501).map((value) => {
    const item = record(value)
    fields(item, ['id', 'name'])
    return { id: personaId(item.id), name: text(item.name, 200) }
  })
  unique(personas.map((item) => item.id))
  unique(
    personas.filter((item) => item.id !== 'default').map((item) => item.name.toLocaleLowerCase())
  )
  // The default template may intentionally share a display name with a named template.
  const agents = list(raw.agents).map((value) => {
    const item = record(value)
    fields(item, ['agentId', 'personaId'])
    const result = { agentId: internalId(item.agentId), personaId: personaId(item.personaId) }
    if (!personas.some((persona) => persona.id === result.personaId)) invalid()
    return result
  })
  unique(agents.map((item) => item.agentId))
  const connections = list(raw.connections).map((value) => {
    const item = record(value)
    fields(item, ['id', 'account', 'transport'])
    return {
      id: internalId(item.id),
      account: account(item.account),
      transport: transport(item.transport)
    }
  })
  if (!connections.length || !personas.length) invalid()
  unique(connections.map((item) => item.id))
  unique(connections.map((item) => item.account.id))
  return {
    ...base(raw),
    personas,
    agents,
    connections,
    capabilities: capabilities(raw.capabilities)
  }
}

function json(
  value: unknown,
  budget: { nodes: number; bytes: number },
  depth = 0
): ConfigurationJson {
  if (++budget.nodes > 100000 || depth > 16) invalid()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    budget.bytes += value.length
    if (
      budget.bytes > 4 * 1024 * 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    )
      invalid()
    return value
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid()
  if (Array.isArray(value)) return list(value, 10000).map((item) => json(item, budget, depth + 1))
  const raw = record(value),
    result: Record<string, ConfigurationJson> = Object.create(null)
  const entries = Object.entries(raw)
  if (entries.length > 10000) invalid()
  for (const [key, item] of entries) {
    text(key, 4096, true)
    if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid()
    budget.bytes += key.length
    result[key] = json(item, budget, depth + 1)
  }
  return result
}
export function parseConfigurationPreview(value: unknown): ConfigurationPreview {
  const raw = record(value)
  fields(raw, [
    'mode',
    'processEpoch',
    'revision',
    'configRevision',
    'previewId',
    'candidateDigest',
    'readSet',
    'expiresAt',
    'requiresRestart',
    'changes',
    'affected',
    'permissions',
    'capabilities'
  ])
  if (
    raw.requiresRestart !== true ||
    !Number.isSafeInteger(raw.expiresAt) ||
    Number(raw.expiresAt) <= 0
  )
    invalid()
  if (raw.capabilities !== undefined) capabilities(raw.capabilities)
  const affected = record(raw.affected)
  fields(affected, ['agents', 'connections', 'conversations'])
  const agents = list(affected.agents).map(internalId)
  unique(agents)
  if (!agents.length) invalid()
  const connections = list(affected.connections).map((value) => {
    const item = record(value)
    fields(item, ['id', 'account'])
    return { id: internalId(item.id), account: account(item.account) }
  })
  unique(connections.map((item) => item.id))
  unique(connections.map((item) => item.account.id))
  const conversations = list(affected.conversations).map((value) => {
    const item = record(value)
    fields(item, ['agentId', 'connectionId', 'target'])
    const target = record(item.target)
    fields(target, ['account', 'kind', 'id'])
    if (target.kind !== 'group' && target.kind !== 'private') invalid()
    const result: ConfigurationConversation = {
      agentId: internalId(item.agentId),
      connectionId: internalId(item.connectionId),
      target: {
        account: account(target.account),
        kind: target.kind as 'group' | 'private',
        id: qqId(target.id)
      }
    }
    const connection = connections.find((entry) => entry.id === result.connectionId)
    if (
      !agents.includes(result.agentId) ||
      !connection ||
      connection.account.id !== result.target.account.id
    )
      invalid()
    return result
  })
  const scopes = conversations.map(configurationScopeKey)
  unique(scopes)
  const permissions: ConfigurationPreview['permissions'] = list(raw.permissions, 64).map(
    (value) => {
      const item = record(value)
      fields(item, ['scopeKey', 'mode', 'tools', 'note'])
      const scopeKey = text(item.scopeKey, 8192),
        index = scopes.indexOf(scopeKey)
      if (
        index < 0 ||
        !['text', 'simulation', 'private-disabled', 'private'].includes(String(item.mode))
      )
        invalid()
      const mode = item.mode as ConfigurationPreview['permissions'][number]['mode']
      if (
        (conversations[index]!.target.kind === 'private') !==
        (mode === 'private' || mode === 'private-disabled')
      )
        invalid()
      const tools = list(item.tools, 256).map((value) => text(value, 128))
      if (
        tools.some((tool) => !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(tool)) ||
        (mode === 'private-disabled' && tools.length)
      )
        invalid()
      unique(tools)
      return { scopeKey, mode, tools, note: text(item.note, 32768, true) }
    }
  )
  unique(permissions.map((item) => item.scopeKey))
  const budget = { nodes: 0, bytes: 0 }
  const changes: ConfigurationPreview['changes'] = list(raw.changes, 1000).map((value) => {
    const item = record(value)
    fields(item, ['file', 'path', 'action', 'before', 'after'])
    if (
      !['host', 'personas', 'bindings'].includes(String(item.file)) ||
      !['add', 'change'].includes(String(item.action))
    )
      invalid()
    return {
      file: item.file as ConfigurationPreview['changes'][number]['file'],
      path: text(item.path, 4096),
      action: item.action as 'add' | 'change',
      before: json(item.before, budget),
      after: json(item.after, budget)
    }
  })
  if (!changes.length) invalid()
  unique(changes.map((item) => item.file + ':' + item.path))
  return {
    ...base(raw),
    previewId: text(raw.previewId),
    candidateDigest: text(raw.candidateDigest),
    expiresAt: raw.expiresAt as number,
    requiresRestart: true,
    changes,
    affected: { agents, connections, conversations },
    permissions
  }
}

export function parseConfigurationCommitResult(value: unknown): ConfigurationCommitResult {
  const raw = record(value)
  fields(raw, [
    'changed',
    'requiresRestart',
    'committedRevision',
    'processEpoch',
    'view',
    'transactionId'
  ])
  if (!Number.isSafeInteger(raw.changed) || Number(raw.changed) < 1 || raw.requiresRestart !== true)
    invalid()
  const view = parseConfigurationCatalog(raw.view),
    committedRevision = text(raw.committedRevision),
    processEpoch = text(raw.processEpoch)
  if (view.configRevision !== committedRevision || view.processEpoch !== processEpoch) invalid()
  return {
    changed: raw.changed as number,
    requiresRestart: true,
    committedRevision,
    processEpoch,
    view,
    transactionId: text(raw.transactionId)
  }
}
