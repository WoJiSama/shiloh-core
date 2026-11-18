import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleRestart } from './consoleRestart'
import { createWorkspaceChangeSession } from './workspaceChanges'
import {
  configurationScopeKey,
  type ConfigurationCatalog,
  type ConfigurationChange,
  type ConfigurationPreview,
  type ConfigurationCommitResult
} from './workspaceChangeModel'

const { denied } = vi.hoisted(() => ({ denied: new Set<string>() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./workspace', () => ({
  capability: (operation: string) => ({ status: denied.has(operation) ? 'forbidden' : 'available' })
}))

const endpoints = {
  catalog: '/api/configuration/catalog',
  preview: '/api/configuration/preview',
  commit: '/api/configuration/commit'
}
const change: ConfigurationChange = {
  kind: 'connection.add',
  agentId: 'daily',
  connection: {
    id: 'extra',
    accountId: '19000912',
    transport: 'forward-websocket',
    url: 'ws://127.0.0.1:3002',
    accessTokenEnv: 'EXTRA_QQ_TOKEN'
  },
  conversations: [{ kind: 'group', conversationId: '310911' }]
}
function catalog(processEpoch = 'process-1', version = 'r1'): ConfigurationCatalog {
  return {
    mode: 'standalone',
    revision: `catalog-${version}`,
    configRevision: `config-${version}`,
    processEpoch,
    readSet: {
      host: `host-${version}`,
      personas: `personas-${version}`,
      bindings: `bindings-${version}`
    },
    agents: [{ agentId: 'daily', personaId: 'default' }],
    personas: [{ id: 'default', name: '本地角色' }],
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
function preview(source = catalog(), id = 'server-preview-1'): ConfigurationPreview {
  const target = {
      account: { platform: 'qq' as const, namespace: 'global' as const, id: '19000912' },
      kind: 'group' as const,
      id: '310911'
    },
    conversation = { agentId: 'daily', connectionId: 'extra', target }
  return {
    mode: 'standalone',
    processEpoch: source.processEpoch,
    revision: source.revision,
    configRevision: source.configRevision,
    previewId: id,
    candidateDigest: 'server-digest-' + id,
    readSet: { ...source.readSet },
    expiresAt: Date.now() + 60_000,
    requiresRestart: true,
    changes: [
      {
        file: 'bindings',
        path: 'bindings[1]',
        action: 'add',
        before: null,
        after: { connectionId: 'extra', conversationId: '310911', agentId: 'daily', kind: 'group' }
      }
    ],
    affected: {
      agents: source.agents.map((agent) => agent.agentId),
      connections: [
        ...source.connections.map(({ id, account }) => ({ id, account: { ...account } })),
        { id: 'extra', account: { ...target.account } }
      ],
      conversations: [
        {
          agentId: 'daily',
          connectionId: 'main',
          target: {
            account: { platform: 'qq', namespace: 'global', id: '19000911' },
            kind: 'group',
            id: '310911'
          }
        },
        conversation
      ]
    },
    permissions: [
      {
        scopeKey: configurationScopeKey(conversation),
        mode: 'simulation',
        tools: [],
        note: '不新增工具授权；以运行时策略为准。'
      }
    ]
  }
}
function receipt(source = catalog('process-1', 'r2')): ConfigurationCommitResult {
  return {
    changed: 3,
    requiresRestart: true,
    committedRevision: source.configRevision,
    processEpoch: source.processEpoch,
    view: source,
    transactionId: 'transaction-1'
  }
}
function rejection(status: number, error: string) {
  return Object.assign(new Error(error), { status, details: { error } })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const sessions: ReturnType<typeof createWorkspaceChangeSession>[] = []
function harness() {
  const source = { current: catalog() }
  const handlers: Record<
    keyof typeof endpoints,
    (options?: RequestInit) => unknown | Promise<unknown>
  > = {
    catalog: () => source.current,
    preview: () => preview(source.current),
    commit: () => receipt(catalog(source.current.processEpoch, 'r2'))
  }
  // Match api.ts's global gate semantics while retaining deterministic deferred transport.
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === endpoints.catalog) return handlers.catalog(options)
    if (path === endpoints.preview) return handlers.preview(options)
    if (path !== endpoints.commit) throw new Error('unexpected request')
    const ticket = consoleRestart.begin(path)
    try {
      const result = await handlers.commit(options)
      consoleRestart.complete(ticket, result)
      return result
    } catch (cause) {
      consoleRestart.failed(ticket, cause, path)
      throw cause
    }
  })
  const session = createWorkspaceChangeSession(request)
  sessions.push(session)
  const calls = (kind: keyof typeof endpoints) =>
    request.mock.calls.filter(([path]) => path === endpoints[kind])
  const ready = async () => {
    await session.loadCatalog()
    await session.previewChange(change)
  }
  return { session, source, handlers, request, calls, ready }
}
beforeEach(() => {
  denied.clear()
  Object.assign(consoleRestart.state, {
    standalone: true,
    phase: 'active',
    processEpoch: 'process-1',
    committedRevision: '',
    recoveryRequired: false,
    transaction: { phase: 'clean' },
    generation: 0,
    reloadGeneration: 0
  })
})
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose())
  vi.useRealTimers()
})

describe('configuration change session reads and candidates', () => {
  it('keeps a catalog 503 as failure and sends no preview from missing data', async () => {
    const h = harness()
    h.handlers.catalog = () => {
      throw rejection(503, 'unavailable')
    }
    await h.session.loadCatalog()
    await h.session.previewChange(change)
    expect(h.session.catalog.value).toBeNull()
    expect(h.session.requiresRead.value).toBe(true)
    expect(h.session.error.value).toContain('配置服务暂时不可用')
    expect(h.calls('preview')).toHaveLength(0)
  })
  it('submits only the server candidate and every read-set member, then waits for restart', async () => {
    const h = harness()
    await h.ready()
    const selected = h.session.preview.value!
    await h.session.commit()
    expect(JSON.parse(String(h.calls('preview')[0]![1]!.body))).toEqual({
      revision: 'catalog-r1',
      change
    })
    expect(JSON.parse(String(h.calls('commit')[0]![1]!.body))).toEqual({
      previewId: selected.previewId,
      revision: selected.revision,
      candidateDigest: selected.candidateDigest,
      readSet: { host: 'host-r1', personas: 'personas-r1', bindings: 'bindings-r1' }
    })
    expect(h.session.receipt.value?.transactionId).toBe('transaction-1')
    expect(h.session.issue.value).toBe('saved')
    expect(h.session.catalog.value?.configRevision).toBe('config-r1')
    expect(consoleRestart.state.phase).toBe('restart-required')
    await h.session.commit()
    expect(h.calls('commit')).toHaveLength(1)
  })
  it.each(['expired', 'draft edited', 'generation changed', 'read-set changed'])(
    'does not submit a candidate after it becomes %s',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const h = harness()
      await h.ready()
      if (reason === 'expired') vi.setSystemTime(Date.now() + 60_001)
      if (reason === 'draft edited') h.session.invalidatePreview()
      if (reason === 'generation changed') consoleRestart.state.generation++
      if (reason === 'read-set changed')
        h.session.catalog.value!.readSet.personas = 'different-personas'
      await h.session.commit()
      expect(h.calls('commit')).toHaveLength(0)
      expect(h.session.preview.value).toBeNull()
      if (reason !== 'draft edited') expect(h.session.requiresRead.value).toBe(true)
    }
  )
  it('requires reloading the catalog before previewing after a process-generation change', async () => {
    const h = harness()
    await h.session.loadCatalog()
    consoleRestart.state.generation++
    await h.session.previewChange(change)
    expect(h.session.issue.value).toBe('stale')
    expect(h.session.requiresRead.value).toBe(true)
    expect(h.calls('preview')).toHaveLength(0)
  })
  it('discards a late preview after editing and preserves the later accepted candidate', async () => {
    const h = harness(),
      old = deferred<unknown>()
    await h.session.loadCatalog()
    h.handlers.preview = () => old.promise
    const pending = h.session.previewChange(change)
    const oldSignal = h.calls('preview')[0]![1]!.signal!
    h.session.invalidatePreview()
    expect(oldSignal.aborted).toBe(true)
    h.handlers.preview = () => preview(h.source.current, 'new-candidate')
    await h.session.previewChange(change)
    old.resolve(preview(h.source.current, 'old-candidate'))
    await pending
    expect(h.session.preview.value?.previewId).toBe('new-candidate')
    expect(h.session.previewing.value).toBe(false)
  })
  it('rejects a preview returned from a different read-set despite matching process and revision', async () => {
    const h = harness()
    await h.session.loadCatalog()
    h.handlers.preview = () => ({
      ...preview(h.source.current),
      readSet: { ...h.source.current.readSet, host: 'different-host' }
    })
    await h.session.previewChange(change)
    expect(h.session.preview.value).toBeNull()
    expect(h.session.error.value).toContain('预览版本与当前配置不一致')
    await h.session.commit()
    expect(h.calls('commit')).toHaveLength(0)
  })
  it('checks actual preview and commit authorization before starting each request', async () => {
    const h = harness()
    await h.session.loadCatalog()
    denied.add('configuration.preview')
    await h.session.previewChange(change)
    expect(h.calls('preview')).toHaveLength(0)
    denied.clear()
    await h.session.previewChange(change)
    denied.add('configuration.commit')
    await h.session.commit()
    expect(h.calls('commit')).toHaveLength(0)
  })
})

describe('configuration change session transaction outcomes', () => {
  it('allows a new explicit preview after a confirmed precommit candidate_stale without resending', async () => {
    const h = harness()
    await h.ready()
    h.handlers.commit = () => {
      throw rejection(409, 'candidate_stale')
    }
    await h.session.commit()
    expect(h.session.issue.value).toBe('stale')
    expect(h.session.locked.value).toBe(false)
    expect(h.session.error.value).toContain('服务端未提交')
    await h.session.commit()
    await h.session.previewChange(change)
    expect(h.calls('commit')).toHaveLength(1)
    expect(h.calls('preview')).toHaveLength(1)
    h.source.current = catalog('process-1', 'r2')
    await h.session.loadCatalog()
    await h.session.previewChange(change)
    expect(h.session.preview.value?.readSet).toEqual(h.source.current.readSet)
    expect(h.session.issue.value).toBe('')
    expect(h.calls('commit')).toHaveLength(1)
    expect(h.calls('preview')).toHaveLength(2)
  })
  it.each([
    ['unclassified conflict', () => rejection(409, 'conflict')],
    ['network loss', () => new TypeError('lost commit response')],
    ['published outcome unknown', () => rejection(503, 'commit_outcome_unknown')]
  ])(
    'locks %s against repeat commit, refresh and ordinary same-process state',
    async (_reason, error) => {
      const h = harness()
      await h.ready()
      h.handlers.commit = () => {
        throw error()
      }
      await h.session.commit()
      expect(h.session.issue.value).toBe('unknown')
      expect(h.session.error.value).toContain('不要再次提交')
      consoleRestart.process({
        processEpoch: 'process-1',
        loadedRevision: 'config-r1',
        storedRevision: 'config-r1',
        requiresRestart: false,
        phase: 'active',
        recoveryRequired: false,
        transaction: { phase: 'clean' }
      })
      await h.session.loadCatalog()
      await h.session.previewChange(change)
      await h.session.commit()
      expect(h.session.reset()).toBe(false)
      expect(h.session.issue.value).toBe('unknown')
      expect(h.calls('catalog')).toHaveLength(1)
      expect(h.calls('preview')).toHaveLength(1)
      expect(h.calls('commit')).toHaveLength(1)
    }
  )
  it('locks recovery-required and gives an offline recovery instruction instead of retry', async () => {
    const h = harness()
    await h.ready()
    h.handlers.commit = () => {
      throw rejection(503, 'configuration_recovery_required')
    }
    await h.session.commit()
    expect(h.session.issue.value).toBe('recovery')
    expect(h.session.error.value).toContain('停止服务并完成恢复')
    expect(consoleRestart.state.recoveryRequired).toBe(true)
    await h.session.loadCatalog()
    await h.session.commit()
    expect(h.session.reset()).toBe(false)
    expect(h.calls('catalog')).toHaveLength(1)
    expect(h.calls('commit')).toHaveLength(1)
  })
  it('requires a clean new process and a freshly checked catalog before allowing a new operation', async () => {
    const h = harness()
    await h.ready()
    h.handlers.commit = () => {
      throw new TypeError('lost response')
    }
    await h.session.commit()
    expect(h.session.reset()).toBe(false)
    consoleRestart.process({
      processEpoch: 'process-2',
      loadedRevision: 'config-r2',
      storedRevision: 'config-r2',
      requiresRestart: false,
      phase: 'active',
      recoveryRequired: false,
      transaction: { phase: 'clean' }
    })
    h.session.processReloaded()
    expect(h.session.canStartAnother.value).toBe(false)
    expect(h.session.reset()).toBe(false)
    h.source.current = catalog('process-2', 'r2')
    await h.session.loadCatalog()
    expect(h.session.issue.value).toBe('unknown')
    expect(h.session.canStartAnother.value).toBe(true)
    expect(h.session.reset()).toBe(true)
    expect(h.session.issue.value).toBe('')
    expect(h.session.preview.value).toBeNull()
    await h.session.previewChange(change)
    expect(h.session.preview.value?.processEpoch).toBe('process-2')
    expect(h.calls('commit')).toHaveLength(1)
  })
  it('keeps the lock if the reloaded catalog still describes the old process', async () => {
    const h = harness()
    await h.ready()
    h.handlers.commit = () => {
      throw new TypeError('lost response')
    }
    await h.session.commit()
    consoleRestart.process({
      processEpoch: 'process-2',
      loadedRevision: 'config-r2',
      storedRevision: 'config-r2',
      requiresRestart: false,
      phase: 'active',
      recoveryRequired: false,
      transaction: { phase: 'clean' }
    })
    h.session.processReloaded()
    await h.session.loadCatalog()
    expect(h.session.catalog.value).toBeNull()
    expect(h.session.error.value).toContain('进程已改变')
    expect(h.session.reset()).toBe(false)
  })
})

describe('configuration change session cancellation and disposal', () => {
  it('cancels an unaccepted catalog read and ignores its late response', async () => {
    const h = harness(),
      old = deferred<unknown>()
    h.handlers.catalog = () => old.promise
    const pending = h.session.loadCatalog()
    const signal = h.calls('catalog')[0]![1]!.signal!
    expect(h.session.cancelReads()).toBe(true)
    expect(signal.aborted).toBe(true)
    old.resolve(catalog())
    await pending
    expect(h.session.catalog.value).toBeNull()
    expect(h.session.loading.value).toBe(false)
  })
  it('cancels an uncommitted preview on close without issuing any commit', async () => {
    const h = harness(),
      old = deferred<unknown>()
    await h.session.loadCatalog()
    h.handlers.preview = () => old.promise
    const pending = h.session.previewChange(change)
    const signal = h.calls('preview')[0]![1]!.signal!
    expect(h.session.cancelReads()).toBe(true)
    expect(signal.aborted).toBe(true)
    old.resolve(preview())
    await pending
    await h.session.commit()
    expect(h.session.preview.value).toBeNull()
    expect(h.session.previewing.value).toBe(false)
    expect(h.calls('commit')).toHaveLength(0)
  })
  it('does not abort pending writes or erase their unknown outcome when reads are cancelled', async () => {
    const h = harness(),
      write = deferred<unknown>()
    await h.ready()
    h.handlers.commit = () => write.promise
    const pending = h.session.commit()
    expect(h.session.cancelReads()).toBe(false)
    expect(h.calls('commit')[0]![1]!.signal).toBeUndefined()
    write.reject(new TypeError('response lost'))
    await pending
    expect(h.session.issue.value).toBe('unknown')
    expect(consoleRestart.state.phase).toBe('uncertain')
    await h.session.commit()
    expect(h.calls('commit')).toHaveLength(1)
  })
  it('retains the global unknown write lock after the local UI is disposed', async () => {
    const h = harness(),
      write = deferred<unknown>()
    await h.ready()
    h.handlers.commit = () => write.promise
    const pending = h.session.commit()
    h.session.dispose()
    write.reject(new TypeError('response lost after navigation'))
    await pending
    expect(consoleRestart.state.phase).toBe('uncertain')
    expect(consoleRestart.blocked.value).toBe(true)
    await h.session.commit()
    const next = harness()
    await next.session.loadCatalog()
    expect(next.calls('catalog')).toHaveLength(0)
    expect(h.calls('commit')).toHaveLength(1)
  })
})
