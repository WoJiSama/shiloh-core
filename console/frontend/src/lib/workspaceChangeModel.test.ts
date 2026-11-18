import { describe, expect, it } from 'vitest'
import {
  configurationScopeKey,
  parseConfigurationCatalog,
  parseConfigurationCommitResult,
  parseConfigurationPreview
} from './workspaceChangeModel'

function catalog() {
  return {
    mode: 'standalone',
    revision: 'catalog-r1',
    configRevision: 'config-r1',
    processEpoch: 'process-1',
    readSet: { host: 'host-r1', personas: 'personas-r1', bindings: 'bindings-r1' },
    agents: [
      { agentId: 'daily', personaId: 'default' },
      { agentId: 'research', personaId: 'shared' }
    ],
    personas: [
      { id: 'default', name: '相同名字' },
      { id: 'shared', name: '相同名字' }
    ],
    connections: [
      {
        id: 'main',
        account: { platform: 'qq', namespace: 'global', id: '19000911' },
        transport: 'forward-websocket'
      }
    ],
    capabilities: { requiresRestart: true, atomicMultiFile: true }
  }
}
function preview() {
  const target = {
      account: { platform: 'qq' as const, namespace: 'global' as const, id: '19000912' },
      kind: 'group' as const,
      id: '310911'
    },
    conversation = { agentId: 'daily', connectionId: 'extra', target }
  return {
    mode: 'standalone',
    processEpoch: 'process-1',
    revision: 'catalog-r1',
    configRevision: 'config-r1',
    previewId: 'server-candidate-1',
    candidateDigest: 'digest-of-candidate',
    readSet: { host: 'host-r1', personas: 'personas-r1', bindings: 'bindings-r1' },
    expiresAt: 1_800_000_000_000,
    requiresRestart: true,
    capabilities: { requiresRestart: true, atomicMultiFile: true },
    changes: [
      {
        file: 'host',
        path: 'connections[1]',
        action: 'add',
        before: null,
        after: {
          id: 'extra',
          transport: 'forward-websocket',
          url: 'ws://127.0.0.1:3002',
          accessTokenEnv: 'EXTRA_TOKEN'
        }
      }
    ],
    affected: {
      agents: ['daily'],
      connections: [{ id: 'extra', account: { ...target.account } }],
      conversations: [conversation]
    },
    permissions: [
      {
        scopeKey: configurationScopeKey(conversation),
        mode: 'simulation',
        tools: ['simReply'],
        note: '只列显式工具；运行时仍检查权限'
      }
    ]
  }
}
function committed() {
  return {
    changed: 3,
    requiresRestart: true,
    committedRevision: 'config-r1',
    processEpoch: 'process-1',
    view: catalog(),
    transactionId: 'transaction-1'
  }
}

describe('configuration catalog contract', () => {
  it('keeps all source versions and distinct identities despite shared persona names', () => {
    const input = catalog(),
      result = parseConfigurationCatalog(input)
    expect(result).toEqual(input)
    input.readSet.host = 'mutated'
    input.connections[0]!.account.id = '999999'
    expect(result.readSet.host).toBe('host-r1')
    expect(result.connections[0]!.account.id).toBe('19000911')
  })
  it('allows an empty agent list while preserving the existing QQ host connections', () => {
    const input = catalog()
    input.agents = []
    expect(parseConfigurationCatalog(input).agents).toEqual([])
  })
  it.each([
    ['missing read-set member', (value: any) => delete value.readSet.personas],
    ['missing restart guarantee', (value: any) => delete value.capabilities.requiresRestart],
    [
      'missing atomic transaction guarantee',
      (value: any) => (value.capabilities.atomicMultiFile = false)
    ],
    ['unknown template reference', (value: any) => (value.agents[0].personaId = 'missing')],
    ['duplicate agent identity', (value: any) => value.agents.push(value.agents[0])],
    [
      'duplicate named template display names',
      (value: any) => value.personas.push({ id: 'another', name: '相同名字' })
    ],
    ['duplicate connection identity', (value: any) => value.connections.push(value.connections[0])],
    [
      'duplicate QQ account on another connection',
      (value: any) => value.connections.push({ ...value.connections[0], id: 'extra' })
    ],
    ['empty connection directory', (value: any) => (value.connections = [])],
    ['numeric account identity', (value: any) => (value.connections[0].account.id = 19000911)],
    ['leading-zero account alias', (value: any) => (value.connections[0].account.id = '019000911')],
    [
      'foreign account namespace',
      (value: any) => (value.connections[0].account.namespace = 'foreign')
    ],
    ['unknown transport', (value: any) => (value.connections[0].transport = 'http')],
    [
      'existing URL exposed in safe catalog',
      (value: any) => (value.connections[0].url = 'ws://private-existing-host')
    ],
    ['empty epoch', (value: any) => (value.processEpoch = '')],
    ['oversized revision', (value: any) => (value.revision = 'x'.repeat(257))]
  ])('rejects %s', (_name, change) => {
    const value = catalog()
    change(value)
    expect(() => parseConfigurationCatalog(value)).toThrow('配置候选响应不完整')
  })
})

describe('configuration preview contract', () => {
  it('preserves the server candidate, complete source, field diffs and permission explanation', () => {
    const input = preview(),
      result = parseConfigurationPreview(input)
    expect(result.previewId).toBe(input.previewId)
    expect(result.candidateDigest).toBe(input.candidateDigest)
    expect(result.readSet).toEqual(input.readSet)
    expect(result.affected).toEqual(input.affected)
    expect(result.permissions).toEqual(input.permissions)
    expect(result.changes).toEqual(input.changes)
    input.permissions[0]!.tools.push('newTool')
    ;(input.changes[0]!.after as Record<string, string>).url = 'changed'
    expect(result.permissions[0]!.tools).toEqual(['simReply'])
    expect(result.changes[0]!.after).toMatchObject({ url: 'ws://127.0.0.1:3002' })
  })
  it('accepts a new person and template with no invented connection or authorization', () => {
    const input = preview()
    input.affected = { agents: ['new-person'], connections: [], conversations: [] }
    input.permissions = []
    input.changes = [
      {
        file: 'bindings',
        path: 'agents[2]',
        action: 'add',
        before: null,
        after: { id: 'new-person', personaId: 'default' }
      } as any
    ]
    const result = parseConfigurationPreview(input)
    expect(result.affected.conversations).toEqual([])
    expect(result.permissions).toEqual([])
  })
  it('accepts a complete captured host projection and permissions only for new conversations', () => {
    const input = preview(),
      original = {
        agentId: 'research',
        connectionId: 'main',
        target: {
          account: { platform: 'qq' as const, namespace: 'global' as const, id: '19000911' },
          kind: 'group' as const,
          id: '310911'
        }
      }
    input.affected.agents.unshift('research')
    input.affected.connections.unshift({ id: 'main', account: { ...original.target.account } })
    input.affected.connections.push({
      id: 'declared-no-conversations',
      account: { platform: 'qq', namespace: 'global', id: '19000913' }
    })
    input.affected.conversations.unshift(original)
    const result = parseConfigurationPreview(input)
    expect(result.affected).toEqual(input.affected)
    expect(result.permissions).toHaveLength(1)
    expect(result.permissions[0]!.scopeKey).toBe(
      configurationScopeKey(input.affected.conversations[1]!)
    )
  })
  it('accepts agent creation with all pre-existing affected conversations and no new permissions', () => {
    const input = preview()
    input.affected.agents.push('new-person')
    input.permissions = []
    input.changes = [
      {
        file: 'bindings',
        path: 'agents[2]',
        action: 'add',
        before: null,
        after: { id: 'new-person', personaId: 'default' }
      } as any
    ]
    const result = parseConfigurationPreview(input)
    expect(result.affected.conversations).toHaveLength(1)
    expect(result.permissions).toEqual([])
  })
  it('keeps more than sixty-four existing conversations in the captured host impact', () => {
    const input = preview(),
      original = input.affected.conversations[0]!
    input.affected.conversations = Array.from({ length: 70 }, (_, index) => ({
      ...original,
      target: { ...original.target, id: String(310911 + index) }
    }))
    expect(parseConfigurationPreview(input).affected.conversations).toHaveLength(70)
  })
  it('supports a disabled private source only when it grants no tools', () => {
    const input = preview()
    input.affected.conversations[0]!.target.kind = 'private' as any
    input.permissions[0]!.scopeKey = configurationScopeKey(input.affected.conversations[0]!)
    input.permissions[0]!.mode = 'private-disabled'
    input.permissions[0]!.tools = []
    expect(parseConfigurationPreview(input).permissions[0]!.mode).toBe('private-disabled')
  })
  it.each([
    ['missing server candidate', (value: any) => delete value.previewId],
    ['missing candidate digest', (value: any) => delete value.candidateDigest],
    ['incomplete read-set', (value: any) => delete value.readSet.bindings],
    ['non-restart preview', (value: any) => (value.requiresRestart = false)],
    ['invalid expiry', (value: any) => (value.expiresAt = NaN)],
    ['empty diff', (value: any) => (value.changes = [])],
    ['duplicate changed field', (value: any) => value.changes.push(value.changes[0])],
    ['unknown change operation', (value: any) => (value.changes[0].action = 'remove')],
    ['raw YAML file name', (value: any) => (value.changes[0].file = '/tmp/private.yaml')],
    ['undefined after projection', (value: any) => (value.changes[0].after = undefined)],
    ['nonfinite diff value', (value: any) => (value.changes[0].after = { value: Infinity })],
    ['oversized diff', (value: any) => (value.changes[0].after = 'x'.repeat(4 * 1024 * 1024 + 1))],
    [
      'unknown affected person',
      (value: any) => (value.affected.conversations[0].agentId = 'other')
    ],
    [
      'unknown affected connection',
      (value: any) => (value.affected.conversations[0].connectionId = 'main')
    ],
    [
      'account inconsistent with connection',
      (value: any) => (value.affected.conversations[0].target.account.id = '19000911')
    ],
    ['ambiguous bare group permission', (value: any) => (value.permissions[0].scopeKey = '310911')],
    [
      'permission for another account in the same group',
      (value: any) =>
        (value.permissions[0].scopeKey = JSON.stringify([
          'daily',
          'qq',
          'global',
          '19000911',
          'group',
          '310911'
        ]))
    ],
    [
      'duplicate permission explanation',
      (value: any) => value.permissions.push(value.permissions[0])
    ],
    [
      'duplicate conversation source',
      (value: any) => value.affected.conversations.push(value.affected.conversations[0])
    ],
    ['private mode for a group', (value: any) => (value.permissions[0].mode = 'private')],
    ['unknown permission mode', (value: any) => (value.permissions[0].mode = 'all')],
    [
      'duplicate declared tool',
      (value: any) => value.permissions[0].tools.push(value.permissions[0].tools[0])
    ],
    [
      'more than ten thousand captured conversations',
      (value: any) =>
        (value.affected.conversations = Array(10001).fill(value.affected.conversations[0]))
    ]
  ])('rejects %s', (_name, change) => {
    const value = preview()
    change(value)
    expect(() => parseConfigurationPreview(value)).toThrow('配置候选响应不完整')
  })
  it('rejects private-disabled permissions that still advertise a tool', () => {
    const value = preview()
    value.affected.conversations[0]!.target.kind = 'private' as any
    value.permissions[0]!.scopeKey = configurationScopeKey(value.affected.conversations[0]!)
    value.permissions[0]!.mode = 'private-disabled'
    expect(() => parseConfigurationPreview(value)).toThrow()
  })
})

describe('configuration commit receipt contract', () => {
  it('retains the transaction receipt and safe catalog without claiming hot activation', () => {
    const result = parseConfigurationCommitResult(committed())
    expect(result.transactionId).toBe('transaction-1')
    expect(result.requiresRestart).toBe(true)
    expect(result.view.configRevision).toBe(result.committedRevision)
  })
  it.each([
    ['missing transaction', (value: any) => delete value.transactionId],
    ['missing catalog source version', (value: any) => delete value.view.readSet.host],
    ['different projected revision', (value: any) => (value.view.configRevision = 'config-other')],
    ['different projected epoch', (value: any) => (value.view.processEpoch = 'process-other')],
    ['missing restart', (value: any) => (value.requiresRestart = false)],
    ['fractional change count', (value: any) => (value.changed = 1.1)],
    ['no-change new topology commit', (value: any) => (value.changed = 0)],
    ['raw source bytes', (value: any) => (value.view.sources = { host: 'secret' })]
  ])('rejects %s', (_name, change) => {
    const value = committed()
    change(value)
    expect(() => parseConfigurationCommitResult(value)).toThrow('配置候选响应不完整')
  })
})
