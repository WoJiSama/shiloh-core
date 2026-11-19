import { afterEach, describe, expect, it, vi } from 'vitest'
import { capability, createWorkspaceStore, workspace as currentWorkspace } from './workspace'
import { parseWorkspace } from './workspaceModel'

const { restartBlocked } = vi.hoisted(() => ({ restartBlocked: { value: false } }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./consoleRestart', async () => ({
  ...(await vi.importActual<typeof import('./consoleRestart')>('./consoleRestart')),
  consoleRestart: { blocked: restartBlocked }
}))

afterEach(() => {
  currentWorkspace.reset()
  restartBlocked.value = false
})

function workspace(revision = 'workspace-r1') {
  const conversations = ['account-one', 'account-two'].map((accountId) => {
    const binding = {
      source: 'configured',
      id: JSON.stringify(['qq', 'global', accountId, 'group', 'same-group']),
      revision: 'binding-r1',
      agentId: 'agent-a',
      personaId: 'shared-template',
      connectionId: `connection-${accountId}`,
      target: {
        account: { platform: 'qq', namespace: 'global', id: accountId },
        kind: 'group',
        id: 'same-group'
      }
    }
    return {
      binding,
      scopeKey: JSON.stringify(['agent-a', 'qq', 'global', accountId, 'group', 'same-group']),
      bindingToken: JSON.stringify([
        binding.source,
        binding.id,
        binding.revision,
        binding.agentId,
        binding.personaId,
        binding.connectionId
      ])
    }
  })
  return {
    mode: 'standalone',
    version: 1,
    observedAt: 1730000000000,
    revision,
    agents: [
      {
        id: 'agent-a',
        name: 'Agent A',
        personaId: 'shared-template',
        personaName: 'Shared template',
        conversations
      }
    ],
    connections: conversations.map(({ binding }) => ({
      id: binding.connectionId,
      account: binding.target.account,
      state: 'connected',
      conversationCount: 1,
      capabilities: ['messages.send']
    })),
    capabilities: [
      {
        operation: 'simulation.group-read',
        scope: 'conversation',
        status: 'available',
        reason: '',
        effect: 'read',
        authorizedScopes: [conversations[0].scopeKey]
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
const failures = [
  ['forbidden', Object.assign(new Error('forbidden'), { status: 403 })],
  ['unavailable', Object.assign(new Error('unavailable'), { status: 503 })],
  ['network failure', new Error('network offline')]
] as const
const malformedPayloads = [
  ['empty object', {}],
  ['missing capability status', { ...workspace(), capabilities: [{ operation: 'read' }] }],
  ['missing config state', { ...workspace(), configState: undefined }],
  [
    'inconsistent config state',
    {
      ...workspace(),
      configState: { ...workspace().configState, storedRevision: 'different-config' }
    }
  ],
  [
    'unknown authorized scope',
    {
      ...workspace(),
      capabilities: [{ ...workspace().capabilities[0], authorizedScopes: ['same-group'] }]
    }
  ]
] as const
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('workspace loading state', () => {
  it('uses legacy mode only for the first 404 response', async () => {
    const notFound = Object.assign(new Error('missing workspace'), { status: 404 })
    const loader = vi.fn().mockRejectedValueOnce(notFound).mockResolvedValueOnce(workspace())
    const store = createWorkspaceStore(loader)

    await store.load()
    expect(store.mode.value).toBe('legacy')
    expect(store.data.value).toBeNull()
    expect(store.error.value).toBe('')

    await store.load()
    expect(store.mode.value).toBe('standalone')
    expect(store.data.value?.revision).toBe('workspace-r1')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('does not downgrade a known standalone store after a later 404', async () => {
    const notFound = Object.assign(new Error('route disappeared'), { status: 404 })
    const loader = vi.fn().mockResolvedValueOnce(workspace()).mockRejectedValueOnce(notFound)
    const store = createWorkspaceStore(loader)

    await store.load()
    const previous = store.data.value
    await expect(store.load()).rejects.toBe(notFound)

    expect(store.mode.value).toBe('standalone')
    expect(store.data.value).toBe(previous)
    expect(store.error.value).toBe('route disappeared')
  })

  it('does not silently swallow another 404 once legacy mode is already known', async () => {
    const notFound = Object.assign(new Error('route missing'), { status: 404 })
    const loader = vi.fn().mockRejectedValue(notFound)
    const store = createWorkspaceStore(loader)

    await store.load()
    await expect(store.load()).rejects.toBe(notFound)

    expect(store.mode.value).toBe('legacy')
    expect(store.data.value).toBeNull()
    expect(store.error.value).toBe('route missing')
    expect(store.loading.value).toBe(false)
  })

  it.each(failures)(
    'reports an initial %s without entering legacy mode',
    async (_label, failure) => {
      const store = createWorkspaceStore(async () => {
        throw failure
      })

      await expect(store.load()).rejects.toBe(failure)

      expect(store.mode.value).toBe('unknown')
      expect(store.data.value).toBeNull()
      expect(store.error.value).toBe(failure.message)
      expect(store.loading.value).toBe(false)
    }
  )

  it.each(failures)(
    'keeps a clear error and the previous workspace on %s',
    async (_label, failure) => {
      const loader = vi.fn().mockResolvedValueOnce(workspace()).mockRejectedValueOnce(failure)
      const store = createWorkspaceStore(loader)

      await store.load()
      const previous = store.data.value
      await expect(store.load()).rejects.toBe(failure)

      expect(store.mode.value).toBe('standalone')
      expect(store.data.value).toBe(previous)
      expect(store.data.value?.revision).toBe('workspace-r1')
      expect(store.error.value).toBe(failure.message)
      expect(store.loading.value).toBe(false)
    }
  )

  it.each(malformedPayloads)(
    'rejects an initial malformed %s without entering legacy mode',
    async (_label, payload) => {
      const store = createWorkspaceStore(async () => payload)

      await expect(store.load()).rejects.toThrow(/工作区响应不完整或身份不一致/)

      expect(store.mode.value).toBe('unknown')
      expect(store.data.value).toBeNull()
      expect(store.error.value).toMatch(/工作区响应不完整或身份不一致/)
      expect(store.loading.value).toBe(false)
    }
  )

  it.each(malformedPayloads)(
    'rejects a malformed %s without replacing the last good workspace',
    async (_label, payload) => {
      const loader = vi.fn().mockResolvedValueOnce(workspace()).mockResolvedValueOnce(payload)
      const store = createWorkspaceStore(loader)

      await store.load()
      const previous = store.data.value
      await expect(store.load()).rejects.toThrow(/工作区响应不完整或身份不一致/)

      expect(store.mode.value).toBe('standalone')
      expect(store.data.value).toBe(previous)
      expect(store.data.value?.revision).toBe('workspace-r1')
      expect(store.error.value).toMatch(/工作区响应不完整或身份不一致/)
      expect(store.loading.value).toBe(false)
    }
  )

  it('clears a previous error only after a valid workspace has loaded', async () => {
    const failure = new Error('temporarily offline')
    const loader = vi
      .fn()
      .mockResolvedValueOnce(workspace())
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(workspace('workspace-r2'))
    const store = createWorkspaceStore(loader)

    await store.load()
    await expect(store.load()).rejects.toBe(failure)
    expect(store.error.value).toBe('temporarily offline')
    await store.load()

    expect(store.mode.value).toBe('standalone')
    expect(store.data.value?.revision).toBe('workspace-r2')
    expect(store.error.value).toBe('')
  })

  it('forwards the abort signal to the injected loader', async () => {
    const loader = vi.fn().mockResolvedValue(workspace())
    const store = createWorkspaceStore(loader)
    const controller = new AbortController()

    await store.load(controller.signal)

    expect(loader).toHaveBeenCalledWith(controller.signal)
    expect(store.data.value?.revision).toBe('workspace-r1')
  })

  it('discards an older result after a newer load has supplied the workspace', async () => {
    const first = deferred()
    const loader = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(workspace('new'))
    const store = createWorkspaceStore(loader)
    const pending = store.load()

    expect(store.loading.value).toBe(true)
    await store.load()
    const current = store.data.value
    first.resolve(workspace('old'))
    await pending

    expect(store.data.value).toBe(current)
    expect(store.data.value?.revision).toBe('new')
    expect(store.error.value).toBe('')
    expect(store.loading.value).toBe(false)
  })

  it('discards an aborted result and a result arriving after reset', async () => {
    const aborted = deferred()
    const afterReset = deferred()
    const loader = vi
      .fn()
      .mockResolvedValueOnce(workspace())
      .mockReturnValueOnce(aborted.promise)
      .mockReturnValueOnce(afterReset.promise)
    const store = createWorkspaceStore(loader)

    await store.load()
    const previous = store.data.value
    const controller = new AbortController()
    const pendingAborted = store.load(controller.signal)
    controller.abort()
    aborted.resolve(workspace('aborted'))
    await pendingAborted
    expect(store.data.value).toBe(previous)

    const pendingReset = store.load()
    store.reset()
    afterReset.resolve(workspace('after-reset'))
    await pendingReset
    expect(store.mode.value).toBe('unknown')
    expect(store.data.value).toBeNull()
    expect(store.error.value).toBe('')
    expect(store.loading.value).toBe(false)
  })
})

describe('workspace capability selection', () => {
  it('allows only the authorized complete scope for equal group IDs on different accounts', () => {
    currentWorkspace.data.value = parseWorkspace(workspace())
    const [firstAccount, secondAccount] = currentWorkspace.data.value.agents[0].conversations

    expect(firstAccount.binding.target.id).toBe(secondAccount.binding.target.id)
    expect(capability('simulation.group-read', firstAccount.scopeKey).status).toBe('available')
    expect(capability('simulation.group-read', secondAccount.scopeKey).status).toBe('forbidden')
    expect(capability('simulation.group-read', 'same-group').status).toBe('forbidden')
    expect(capability('simulation.group-read').authorizedScopes).toEqual([firstAccount.scopeKey])
  })

  it('does not expose cached authorization as available after a failed refresh', () => {
    currentWorkspace.data.value = parseWorkspace(workspace())
    const previous = currentWorkspace.data.value
    const scopeKey = previous.agents[0].conversations[0].scopeKey
    currentWorkspace.error.value = 'refresh failed'

    expect(capability('simulation.group-read', scopeKey)).toMatchObject({
      scope: 'conversation',
      effect: 'read',
      status: 'unavailable'
    })
    expect(currentWorkspace.data.value).toBe(previous)
  })

  it('requires restart even for an authorized scope while execution is retired', () => {
    currentWorkspace.data.value = parseWorkspace(workspace())
    const scopeKey = currentWorkspace.data.value.agents[0].conversations[0].scopeKey
    restartBlocked.value = true

    expect(capability('simulation.group-read', scopeKey)).toMatchObject({
      scope: 'conversation',
      effect: 'read',
      status: 'restart-required'
    })
  })

  it('keeps installed read-only task observations available while execution is retired', () => {
    const value = workspace()
    value.capabilities.push({ operation: 'pipeline.read', scope: 'global', status: 'available', reason: 'authorized', effect: 'read', authorizedScopes: [] })
    currentWorkspace.data.value = parseWorkspace(value)
    restartBlocked.value = true

    expect(capability('pipeline.read').status).toBe('available')
    expect(capability('simulation.group-read').status).toBe('restart-required')
  })

  it('reports an unknown operation as unavailable instead of granting it', () => {
    currentWorkspace.data.value = parseWorkspace(workspace())

    expect(capability('unknown-operation')).toMatchObject({
      operation: 'unknown-operation',
      status: 'unavailable'
    })
  })
})
