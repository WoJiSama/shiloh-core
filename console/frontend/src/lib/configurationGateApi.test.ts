import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ConfigRestartBanner from '../components/ConfigRestartBanner.vue'
import { api, clearToken } from './api'
import { consoleRestart } from './consoleRestart'
import { configurationLabel } from './workspace'
import { parseWorkspace } from './workspaceModel'

const commitPath = '/api/configuration/commit'
const previewPath = '/api/configuration/preview'
const catalogPath = '/api/configuration/catalog'
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const processState = (processEpoch = 'p1', extra = {}) => ({
  processEpoch,
  loadedRevision: 'r2',
  storedRevision: 'r2',
  requiresRestart: false,
  phase: 'active',
  recoveryRequired: false,
  transaction: { phase: 'clean' },
  ...extra
})
const catalog = (processEpoch = 'p1') => ({
  mode: 'standalone',
  revision: 'catalog-r2',
  configRevision: 'r2',
  processEpoch,
  readSet: { host: 'host-r2', personas: 'personas-r1', bindings: 'bindings-r2' },
  agents: [],
  personas: [{ id: 'default', name: '默认' }],
  connections: [
    {
      id: 'main',
      account: { platform: 'qq', namespace: 'global', id: '123456' },
      transport: 'forward-websocket'
    }
  ],
  capabilities: { requiresRestart: true, atomicMultiFile: true }
})
const committed = () => ({
  changed: 1,
  requiresRestart: true,
  committedRevision: 'r2',
  processEpoch: 'p1',
  transactionId: 'tx-1',
  view: catalog()
})
const post = () => ({ method: 'POST', body: JSON.stringify({ previewId: 'preview-1' }) })
const preview = () => ({
  mode: 'standalone',
  processEpoch: 'p1',
  previewId: 'preview-1',
  candidateDigest: 'digest-1',
  requiresRestart: true
})
const mounted: VueWrapper[] = []
beforeEach(() => {
  clearToken()
  Object.assign(consoleRestart.state, {
    standalone: false,
    phase: 'active',
    processEpoch: '',
    committedRevision: '',
    recoveryRequired: false,
    transaction: { phase: 'clean' },
    generation: 0,
    reloadGeneration: 0
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
})
const active = () => consoleRestart.process(processState())

describe('configuration API epoch gate', () => {
  it('validates a commit receipt before exposing it even before an epoch is established', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...committed(), transactionId: undefined }))
    )

    await expect(api(commitPath, post())).rejects.toThrow(/配置候选响应不完整或来源不一致/)
  })

  it('saves POST commit, validates its receipt, and blocks catalog and another preview immediately', async () => {
    active()
    let finish!: (value: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)))
    vi.stubGlobal('fetch', fetcher)
    const pending = api(commitPath, post())

    expect(consoleRestart.state.phase).toBe('saving')
    await expect(api(catalogPath)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(api(previewPath, post())).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    expect(fetcher).toHaveBeenCalledOnce()
    finish(response(committed()))
    await expect(pending).resolves.toEqual(committed())
    expect(consoleRestart.state.phase).toBe('restart-required')
    expect(consoleRestart.state.committedRevision).toBe('r2')
    expect(consoleRestart.blocked.value).toBe(true)
  })

  it('does not enter saving or change generation for POST preview', async () => {
    active()
    const generation = consoleRestart.state.generation
    let finish!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)))
    )
    const pending = api(previewPath, post())

    expect(consoleRestart.state.phase).toBe('active')
    expect(consoleRestart.state.generation).toBe(generation)
    await flushPromises()
    finish(response(preview()))
    await expect(pending).resolves.toEqual(preview())
    expect(consoleRestart.blocked.value).toBe(false)
  })

  it('leaves preview candidate_stale available for a fresh preview without a write ticket', async () => {
    active()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'candidate_stale' }, 409))
    )
    const generation = consoleRestart.state.generation

    await expect(api(previewPath, post())).rejects.toMatchObject({ status: 409 })

    expect(consoleRestart.state.generation).toBe(generation)
    expect(consoleRestart.state.phase).toBe('active')
    expect(consoleRestart.blocked.value).toBe(false)
  })

  it('returns to active only after a new commit explicitly reports candidate_stale', async () => {
    active()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'candidate_stale' }, 409))
      .mockResolvedValueOnce(response(preview()))
    vi.stubGlobal('fetch', fetcher)

    await expect(api(commitPath, post())).rejects.toMatchObject({
      status: 409,
      details: { error: 'candidate_stale' }
    })
    expect(consoleRestart.state.phase).toBe('active')
    await expect(api(previewPath, post())).resolves.toEqual(preview())
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    [commitPath, 'POST', { error: 'conflict' }],
    [commitPath, 'POST', {}],
    [commitPath, 'POST', { error: 'conflict', code: 'candidate_stale' }],
    ['/api/config/dice', 'PUT', { error: 'candidate_stale' }]
  ])('keeps a 409 unknown for %s %s and receipt %#', async (path, method, details) => {
    active()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(details, 409))
    )

    await expect(api(path, { method, body: '{}' })).rejects.toMatchObject({ status: 409 })

    expect(consoleRestart.state.phase).toBe('uncertain')
    expect(consoleRestart.blocked.value).toBe(true)
  })

  it.each([commitPath, previewPath, catalogPath])(
    'locks an explicit offline-recovery response from %s',
    async (path) => {
      active()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response({ error: 'configuration_recovery_required' }, 503))
      )

      await expect(api(path, path === catalogPath ? {} : post())).rejects.toMatchObject({
        status: 503
      })

      expect(consoleRestart.state.recoveryRequired).toBe(true)
      expect(consoleRestart.state.phase).toBe('uncertain')
      expect(consoleRestart.state.transaction.phase).toBe('recovery-required')
      expect(configurationLabel()).toBe('待离线恢复')
      expect(consoleRestart.blocked.value).toBe(true)
    }
  )

  it.each(['commit_outcome_unknown', 'unavailable'])(
    'keeps the commit result unknown for 503 %s',
    async (error) => {
      active()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response({ error }, 503))
      )

      await expect(api(commitPath, post())).rejects.toMatchObject({ status: 503 })

      expect(consoleRestart.state.recoveryRequired).toBe(false)
      expect(consoleRestart.state.phase).toBe('uncertain')
      expect(consoleRestart.blocked.value).toBe(true)
    }
  )

  it('retains an unknown commit after network failure and unlocks only a clean new process', async () => {
    active()
    const network = new TypeError('lost commit response')
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(network)
      .mockResolvedValueOnce(response(processState()))
      .mockResolvedValueOnce(response(processState('p2')))
    vi.stubGlobal('fetch', fetcher)

    await expect(api(commitPath, post())).rejects.toBe(network)
    await api('/api/config-state')
    expect(consoleRestart.state.phase).toBe('uncertain')
    expect(consoleRestart.blocked.value).toBe(true)
    await api('/api/config-state')
    expect(consoleRestart.state.processEpoch).toBe('p2')
    expect(consoleRestart.state.phase).toBe('active')
    expect(consoleRestart.state.reloadGeneration).toBe(1)
  })

  it.each([
    ['transaction ID missing', { ...committed(), transactionId: undefined }],
    ['view missing', { ...committed(), view: undefined }],
    [
      'view exposes an unsupported connection field',
      {
        ...committed(),
        view: {
          ...catalog(),
          connections: [{ ...catalog().connections[0], accessToken: 'private-token' }]
        }
      }
    ],
    ['view and receipt revision mismatch', { ...committed(), committedRevision: 'other-r2' }],
    ['view and receipt epoch mismatch', { ...committed(), view: catalog('p2') }]
  ])('keeps a malformed commit receipt unknown: %s', async (_label, value) => {
    active()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(value))
    )

    await expect(api(commitPath, post())).rejects.toThrow(/配置候选响应不完整或来源不一致/)

    expect(consoleRestart.state.phase).toBe('uncertain')
    expect(consoleRestart.state.committedRevision).toBe('')
    expect(consoleRestart.blocked.value).toBe(true)
  })

  it('does not let an old config-state response clear an unknown commit', async () => {
    active()
    let finish!: (value: Response) => void
    const fetcher = vi.fn(async (path: string) => {
      if (path === '/api/config-state')
        return new Promise<Response>((resolve) => (finish = resolve))
      throw new TypeError('lost commit response')
    })
    vi.stubGlobal('fetch', fetcher)
    const earlier = api('/api/config-state')
    const rejected = expect(earlier).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    await expect(api(commitPath, post())).rejects.toThrow('lost commit response')
    finish(response(processState('p2')))
    await rejected

    expect(consoleRestart.state.processEpoch).toBe('p1')
    expect(consoleRestart.state.phase).toBe('uncertain')
  })

  it('does not let a late commit receipt change the new process accepted while saving', async () => {
    active()
    let finish!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path === commitPath
          ? new Promise<Response>((resolve) => (finish = resolve))
          : response(processState('p2'))
      )
    )
    const pending = api(commitPath, post())
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    await api('/api/config-state')
    finish(response(committed()))
    await rejected

    expect(consoleRestart.state.processEpoch).toBe('p2')
    expect(consoleRestart.state.phase).toBe('active')
    expect(consoleRestart.state.recoveryRequired).toBe(false)
    expect(consoleRestart.state.reloadGeneration).toBe(1)
  })

  it('invalidates catalog reads refused by a retired execution epoch', async () => {
    active()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'conflict' }, 409))
    )

    await expect(api(catalogPath)).rejects.toMatchObject({ status: 409 })

    expect(consoleRestart.state.phase).toBe('restart-required')
    expect(consoleRestart.blocked.value).toBe(true)
  })
})

describe('offline configuration recovery after reload', () => {
  it('loads validated recovery metadata, keeps same-epoch checks locked, and provides no online recovery', async () => {
    const recovery = processState('p1', {
      phase: 'uncertain',
      requiresRestart: true,
      recoveryRequired: true,
      transaction: { phase: 'blocked', txId: 'tx-1', direction: 'undo', reason: 'source_changed' }
    })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(recovery))
      .mockResolvedValueOnce(response(processState()))
      .mockResolvedValueOnce(response(processState('p2')))
    vi.stubGlobal('fetch', fetcher)
    await api('/api/config-state')
    expect(consoleRestart.state.transaction).toEqual(recovery.transaction)
    expect(consoleRestart.state.recoveryRequired).toBe(true)
    const wrapper = mount(ConfigRestartBanner, {
      global: {
        stubs: {
          NAlert: { props: ['title'], template: '<section>{{ title }}<slot /></section>' },
          NButton: { template: '<button><slot /></button>' }
        }
      }
    })
    mounted.push(wrapper)

    expect(wrapper.text()).toContain('请停止服务')
    expect(wrapper.text()).toContain('离线处理')
    expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['检查服务状态'])
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(consoleRestart.state.recoveryRequired).toBe(true)
    expect(consoleRestart.blocked.value).toBe(true)
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(consoleRestart.state.recoveryRequired).toBe(false)
    expect(consoleRestart.blocked.value).toBe(false)
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/config-state',
      '/api/config-state',
      '/api/config-state'
    ])
  })

  it('reuses process-state validation for workspace snapshots', () => {
    const view = {
      mode: 'standalone',
      version: 1,
      observedAt: 1,
      revision: 'workspace-r2',
      agents: [],
      connections: [],
      capabilities: [],
      cognition: { status: 'planned' },
      configState: processState('p1', {
        phase: 'uncertain',
        requiresRestart: true,
        recoveryRequired: true,
        transaction: { phase: 'recovery-required', txId: 'tx-1', direction: 'redo' }
      })
    }

    expect(parseWorkspace(view).configState.transaction).toEqual(view.configState.transaction)
    expect(() =>
      parseWorkspace({
        ...view,
        configState: { ...view.configState, transaction: { phase: 'unknown' } }
      })
    ).toThrow(/工作区响应不完整或身份不一致/)
  })
})
