import { describe, expect, it } from 'vitest'
import {
  parseWorkspace,
  robotLocation,
  selectConversation,
  type ConsoleWorkspace
} from './workspaceModel'

const account = (id: string) => ({ platform: 'qq', namespace: 'global', id })
const target = (accountId: string, kind = 'group', id = 'same-group') => ({
  account: account(accountId),
  kind,
  id
})
const binding = (
  agentId: string,
  accountId: string,
  connectionId: string,
  revision = 'binding-r1?&+/%=中文',
  personaId = 'shared-template'
) => ({
  source: 'configured' as const,
  id: JSON.stringify(['qq', 'global', accountId, 'group', 'same-group']),
  revision,
  agentId,
  personaId,
  connectionId,
  target: target(accountId)
})
const scope = (agentId: string, accountId: string) =>
  JSON.stringify([agentId, 'qq', 'global', accountId, 'group', 'same-group'])
const token = (value: ReturnType<typeof binding>) =>
  JSON.stringify([
    value.source,
    value.id,
    value.revision,
    value.agentId,
    value.personaId,
    value.connectionId
  ])

function fixture(): ConsoleWorkspace {
  const firstBinding = binding('agent-a', 'account-one', 'connection-one')
  const otherAccountBinding = binding('agent-a', 'account-two', 'connection-two')
  const secondAgentBinding = binding('agent-b', 'account-one', 'connection-one')
  const conversation = (value: ReturnType<typeof binding>) => ({
    scopeKey: scope(value.agentId, value.target.account.id),
    bindingToken: token(value),
    binding: value
  })
  return {
    mode: 'standalone',
    version: 1,
    observedAt: 1730000000000,
    revision: 'workspace-r1',
    agents: [
      {
        id: 'agent-a',
        name: 'Agent A',
        personaId: 'shared-template',
        personaName: 'Shared template',
        conversations: [conversation(firstBinding), conversation(otherAccountBinding)]
      },
      {
        id: 'agent-b',
        name: 'Agent B',
        personaId: 'shared-template',
        personaName: 'Shared template',
        conversations: [conversation(secondAgentBinding)]
      }
    ],
    connections: [
      {
        id: 'connection-one',
        account: account('account-one'),
        state: 'connected',
        conversationCount: 2,
        capabilities: ['messages.send']
      },
      {
        id: 'connection-two',
        account: account('account-two'),
        state: 'unknown',
        conversationCount: 1,
        capabilities: []
      }
    ],
    capabilities: [
      {
        operation: 'workspace.read',
        scope: 'global',
        status: 'available',
        reason: '',
        effect: 'read'
      },
      {
        operation: 'simulation.group-read',
        scope: 'conversation',
        status: 'available',
        reason: '',
        effect: 'read',
        authorizedScopes: [scope('agent-a', 'account-one')]
      }
    ],
    configState: {
      processEpoch: 'process-a',
      loadedRevision: 'config-r1',
      storedRevision: 'config-r1',
      requiresRestart: false,
      phase: 'active'
    },
    cognition: { status: 'planned' }
  }
}

describe('workspace response model', () => {
  it('keeps agents sharing a template and equal group IDs on separate accounts distinct', () => {
    const parsed = parseWorkspace(fixture())

    expect(parsed.agents.map((agent) => [agent.id, agent.personaId])).toEqual([
      ['agent-a', 'shared-template'],
      ['agent-b', 'shared-template']
    ])
    expect(parsed.agents[0].conversations).toHaveLength(2)
    expect(parsed.agents[1].conversations).toHaveLength(1)
    expect(parsed.agents[0].conversations[0].binding.target.id).toBe('same-group')
    expect(parsed.agents[0].conversations[1].binding.target.id).toBe('same-group')
    expect(parsed.agents[0].conversations[0].scopeKey).not.toBe(
      parsed.agents[0].conversations[1].scopeKey
    )
    expect(parsed.agents[0].conversations[0].scopeKey).not.toBe(
      parsed.agents[1].conversations[0].scopeKey
    )
  })

  it('preserves exact authorized scopes without sharing permission across accounts or agents', () => {
    const parsed = parseWorkspace(fixture())
    const capability = parsed.capabilities.find(
      (item) => item.operation === 'simulation.group-read'
    )!
    const [firstAccount, secondAccount] = parsed.agents[0].conversations
    const otherAgent = parsed.agents[1].conversations[0]

    expect(capability.authorizedScopes).toEqual([firstAccount.scopeKey])
    expect(capability.authorizedScopes).not.toContain(secondAccount.scopeKey)
    expect(capability.authorizedScopes).not.toContain(otherAgent.scopeKey)
    expect(firstAccount.binding.target.id).toBe(secondAccount.binding.target.id)
    expect(firstAccount.binding.target.id).toBe(otherAgent.binding.target.id)
  })

  it.each([
    ['missing', undefined],
    ['not an array', scope('agent-a', 'account-one')],
    ['bare group ID', ['same-group']],
    ['unknown account', [scope('agent-a', 'unknown-account')]],
    ['unknown agent', [scope('unknown-agent', 'account-one')]],
    ['non-string entry', [7]],
    ['duplicate scope', [scope('agent-a', 'account-one'), scope('agent-a', 'account-one')]]
  ])('rejects conversation capability authorization with %s', (_label, authorizedScopes) => {
    const invalid = fixture()
    Reflect.set(invalid.capabilities[1], 'authorizedScopes', authorizedScopes)

    expect(() => parseWorkspace(invalid)).toThrow(/响应不完整或身份不一致/)
  })

  it('round-trips the exact scope and binding token through a deep link', () => {
    const parsed = parseWorkspace(fixture())
    const agent = parsed.agents[0]
    const conversation = agent.conversations[1]
    const location = robotLocation(agent, 'conversations', conversation)
    const url = new URL(location.path, 'https://console.example')
    for (const [key, value] of Object.entries(location.query)) url.searchParams.set(key, value)
    const query = Object.fromEntries(new URL(url.toString()).searchParams)

    expect(location.path).toBe('/robots/agent-a/conversations')
    expect(query).toEqual({
      connection: 'connection-two',
      scopeKey: scope('agent-a', 'account-two'),
      bindingToken: token(conversation.binding)
    })
    expect(selectConversation(agent, query)).toBe(conversation)
  })

  it('keeps robot navigation independent of a shared template and encodes the agent ID', () => {
    const [first, second] = parseWorkspace(fixture()).agents
    expect(robotLocation(first)).toEqual({ path: '/robots/agent-a/home', query: {} })
    expect(robotLocation(second)).toEqual({ path: '/robots/agent-b/home', query: {} })
    expect(robotLocation({ ...first, id: 'agent /甲?' }).path).toBe(
      `/robots/${encodeURIComponent('agent /甲?')}/home`
    )
  })

  it.each([
    ['missing token', { scopeKey: scope('agent-a', 'account-one') }],
    ['missing scope', { bindingToken: 'old-token' }],
    ['array scope', { scopeKey: [scope('agent-a', 'account-one')], bindingToken: 'old-token' }],
    ['array token', { scopeKey: scope('agent-a', 'account-one'), bindingToken: ['old-token'] }],
    ['null token', { scopeKey: scope('agent-a', 'account-one'), bindingToken: null }]
  ])('rejects an incomplete deep link with %s', (_label, query) => {
    const agent = parseWorkspace(fixture()).agents[0]
    expect(() => selectConversation(agent, query)).toThrow(/缺少完整的绑定版本/)
  })

  it('rejects expired and cross-agent deep links without picking a matching group', () => {
    const parsed = parseWorkspace(fixture())
    const firstAgent = parsed.agents[0]
    const secondAgent = parsed.agents[1]
    const oldConversation = firstAgent.conversations[0]

    expect(selectConversation(firstAgent, {})).toBeUndefined()
    expect(() =>
      selectConversation(firstAgent, {
        scopeKey: oldConversation.scopeKey,
        bindingToken: 'expired-binding-token'
      })
    ).toThrow(/已失效或不属于这个机器人/)
    expect(() =>
      selectConversation(secondAgent, {
        scopeKey: oldConversation.scopeKey,
        bindingToken: oldConversation.bindingToken
      })
    ).toThrow(/已失效或不属于这个机器人/)
    expect(() =>
      selectConversation(firstAgent, {
        scopeKey: oldConversation.scopeKey,
        bindingToken: oldConversation.bindingToken,
        connection: 'connection-two'
      })
    ).toThrow(/已失效或不属于这个机器人/)
  })

  it('rejects a token from before a binding revision change even when the scope is unchanged', () => {
    const previous = parseWorkspace(fixture()).agents[0]
    const oldQuery = robotLocation(previous, 'conversations', previous.conversations[0]).query
    const refreshed = fixture()
    const replacement = binding('agent-a', 'account-one', 'connection-one', 'binding-r2')
    refreshed.agents[0].conversations[0] = {
      scopeKey: previous.conversations[0].scopeKey,
      binding: replacement,
      bindingToken: token(replacement)
    }
    const current = parseWorkspace(refreshed).agents[0]

    expect(() => selectConversation(current, oldQuery)).toThrow(/已失效/)
    expect(
      selectConversation(
        current,
        robotLocation(current, 'conversations', current.conversations[0]).query
      )
    ).toBe(current.conversations[0])
  })

  it('rejects binding ownership, persona and connection identity mismatches', () => {
    const cases: Array<(value: ConsoleWorkspace) => void> = [
      (value) => {
        value.agents[0].conversations[0].binding.agentId = 'agent-b'
      },
      (value) => {
        value.agents[0].conversations[0].binding.personaId = 'different-template'
      },
      (value) => {
        value.agents[0].conversations[0].binding.connectionId = 'connection-two'
      },
      (value) => {
        value.agents[0].conversations[0].binding.target.account.id = 'account-two'
      },
      (value) => {
        value.connections[0].account.id = 'different-account'
      },
      (value) => {
        value.connections[0].account.platform = 'different-platform'
      },
      (value) => {
        value.connections[0].account.namespace = 'different-namespace'
      },
      (value) => {
        value.agents[0].conversations[0].binding.connectionId = 'missing-connection'
      }
    ]

    for (const mutate of cases) {
      const invalid = fixture()
      mutate(invalid)
      expect(() => parseWorkspace(invalid)).toThrow(/身份不一致/)
    }
  })

  it.each([0, 1, 2, 3, 4, 5])(
    'rejects a scope with inconsistent identity component %i',
    (index) => {
      const invalid = fixture()
      const values = JSON.parse(invalid.agents[0].conversations[0].scopeKey)
      values[index] = 'different'
      invalid.agents[0].conversations[0].scopeKey = JSON.stringify(values)

      expect(() => parseWorkspace(invalid)).toThrow(/身份不一致/)
    }
  )

  it('rejects duplicate agent IDs, connection IDs and complete conversation scopes', () => {
    const duplicateAgent = fixture()
    duplicateAgent.agents.push(duplicateAgent.agents[0])
    const duplicateConnection = fixture()
    duplicateConnection.connections.push(duplicateConnection.connections[0])
    const duplicateScope = fixture()
    duplicateScope.agents[0].conversations.push(duplicateScope.agents[0].conversations[0])

    for (const invalid of [duplicateAgent, duplicateConnection, duplicateScope])
      expect(() => parseWorkspace(invalid)).toThrow(/身份不一致/)
  })

  it.each(['operation', 'scope', 'status', 'reason', 'effect'])(
    'rejects a capability missing %s',
    (field) => {
      const invalid = fixture()
      Reflect.deleteProperty(invalid.capabilities[0], field)

      expect(() => parseWorkspace(invalid)).toThrow(/响应不完整/)
    }
  )

  it.each(['processEpoch', 'loadedRevision', 'storedRevision', 'requiresRestart', 'phase'])(
    'rejects a config state missing %s',
    (field) => {
      const invalid = fixture()
      Reflect.deleteProperty(invalid.configState, field)

      expect(() => parseWorkspace(invalid)).toThrow(/响应不完整/)
    }
  )

  it.each(['available', 'forbidden', 'unavailable', 'restart-required'] as const)(
    'preserves the capability status %s',
    (status) => {
      const value = fixture()
      value.capabilities[0].status = status
      value.capabilities[0].reason = status === 'available' ? '' : 'not currently executable'

      expect(parseWorkspace(value).capabilities[0]).toEqual(value.capabilities[0])
    }
  )

  it.each(['enabled', '', null, true])('rejects an invalid capability status %s', (status) => {
    const invalid = fixture()
    Reflect.set(invalid.capabilities[0], 'status', status)

    expect(() => parseWorkspace(invalid)).toThrow(/响应不完整/)
  })

  it('rejects missing or inconsistent capability and process configuration state', () => {
    const invalidStates: unknown[] = [
      { ...fixture(), capabilities: undefined },
      { ...fixture(), configState: undefined },
      {
        ...fixture(),
        capabilities: [{ operation: 'x', scope: 'global', reason: '', effect: 'read' }]
      },
      {
        ...fixture(),
        configState: {
          processEpoch: 'process-a',
          loadedRevision: 'config-r1',
          storedRevision: 'config-r2',
          requiresRestart: false,
          phase: 'active'
        }
      },
      {
        ...fixture(),
        configState: {
          processEpoch: 'process-a',
          loadedRevision: 'config-r1',
          storedRevision: 'config-r1',
          requiresRestart: true,
          phase: 'active'
        }
      }
    ]

    for (const invalid of invalidStates) expect(() => parseWorkspace(invalid)).toThrow()
  })
})
