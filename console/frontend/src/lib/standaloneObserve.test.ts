import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NSelect } from 'naive-ui'
import ObservePage from '../pages/ObservePage.vue'
import { api } from './api'
import { workspace, capability } from './workspace'
import { consoleRestart } from './consoleRestart'
import { parseWorkspace } from './workspaceModel'
import {
  diagnosticLocation,
  diagnosticOutcomeLabel,
  diagnosticStatus,
  diagnosticTraceKey,
  parseStandaloneObserve
} from './standaloneObserve'

vi.mock('./api', () => ({ api: vi.fn() }))
function conversation(accountId = '10001') {
  return {
    scopeKey: JSON.stringify(['alice', 'qq', 'global', accountId, 'group', '20001']),
    bindingToken: `token-${accountId}`,
    binding: {
      source: 'configured' as const,
      id: 'same-binding-id',
      revision: 'binding-r1',
      agentId: 'alice',
      personaId: 'shared',
      connectionId: `qq-${accountId}`,
      target: {
        account: { platform: 'qq', namespace: 'global', id: accountId },
        kind: 'group',
        id: '20001'
      }
    }
  }
}
function workspaceData() {
  const conversations = [conversation(), conversation('10002')]
  return parseWorkspace({
    mode: 'standalone',
    version: 1,
    observedAt: 1,
    revision: 'workspace-r1',
    agents: [
      { id: 'alice', name: '希洛', personaId: 'shared', personaName: '同一模板', conversations }
    ],
    connections: conversations.map((row) => ({
      id: row.binding.connectionId,
      account: row.binding.target.account,
      state: 'connected',
      conversationCount: 1,
      capabilities: []
    })),
    capabilities: [
      {
        operation: 'observe.read',
        scope: 'global',
        status: 'available',
        effect: 'read',
        reason: 'authorized'
      },
      {
        operation: 'profiles.read',
        scope: 'conversation',
        status: 'available',
        effect: 'read',
        reason: 'authorized',
        authorizedScopes: conversations.map((row) => row.scopeKey)
      }
    ],
    cognition: { status: 'planned' },
    configState: {
      processEpoch: 'process-1',
      loadedRevision: 'config-r1',
      storedRevision: 'config-r1',
      phase: 'active',
      requiresRestart: false
    }
  })
}
function event(id = 'event-1', accountId = '10001') {
  const row = conversation(accountId)
  return {
    version: 1 as const,
    id,
    traceId: 'trace-shared-fixture',
    at: 1794900000000,
    scope: { kind: 'conversation' as const, binding: row.binding, messageId: 'source-1' },
    stage: 'delivery' as const,
    operation: 'send_send',
    outcome: 'succeeded' as const,
    configurationRevision: 'config-r0',
    durationMs: 12,
    delivery: { state: 'unknown' as const, code: 'native_unknown' },
    scopeKey: row.scopeKey,
    bindingToken: row.bindingToken,
    currentBinding: true
  }
}
function summary() {
  return {
    version: 1,
    mode: 'standalone',
    processEpoch: 'process-1',
    observedAt: 1794900001000,
    configuration: {
      loadedRevision: 'config-r1',
      storedRevision: 'config-r1',
      phase: 'active',
      requiresRestart: false
    },
    journal: {
      available: true,
      degraded: false,
      written: 30,
      failed: 0,
      lastWrittenAt: 1794900001000
    },
    scan: { truncated: false, invalidRecords: 0, scannedEvents: 4, hostCountersVisible: true },
    events: [
      event(),
      {
        ...event('event-start'),
        operation: 'text_turn',
        stage: 'runtime',
        outcome: 'started',
        delivery: undefined,
        at: 1794900000000 - 500
      },
      event('event-other-account', '10002'),
      {
        version: 1,
        id: 'event-host',
        traceId: 'host-trace',
        at: 1794900000001,
        scope: { kind: 'host' },
        stage: 'runtime',
        operation: 'host_stop',
        outcome: 'cancelled'
      }
    ]
  }
}
describe('standalone diagnostic response and ownership', () => {
  it('keeps old records unversioned and never infers a delivery receipt from operation completion', () => {
    const raw = summary()
    const { delivery: _delivery, configurationRevision: _revision, ...old } = event()
    raw.events = [old as ReturnType<typeof event>]
    const record = parseStandaloneObserve(raw).events[0]
    expect(record.configurationRevision).toBeUndefined()
    expect(record.delivery).toBeUndefined()
    expect(diagnosticOutcomeLabel(record)).toBe('操作完成')
    expect(diagnosticOutcomeLabel(record)).not.toContain('发送')
  })
  it('treats a real unknown receipt as unknown even when the callback completed', () => {
    const record = parseStandaloneObserve(summary()).events[0]
    expect(diagnosticStatus(record)).toBe('unknown')
    expect(diagnosticOutcomeLabel(record)).toBe('投递结果未知')
  })
  it('uses the full current binding and opaque version token for navigation', () => {
    const record = parseStandaloneObserve(summary()).events[0],
      snapshot = workspaceData()
    expect(diagnosticLocation(record, snapshot)).toEqual({
      path: '/robots/alice/conversations',
      query: {
        connection: 'qq-10001',
        scopeKey: conversation().scopeKey,
        bindingToken: 'token-10001'
      }
    })
    expect(diagnosticLocation({ ...record, bindingToken: 'token-10002' }, snapshot)).toBeUndefined()
    const changed = structuredClone(record)
    if (changed.scope.kind !== 'conversation') throw new Error('fixture')
    changed.scope.binding.revision = 'binding-r0'
    expect(diagnosticLocation(changed, snapshot)).toBeUndefined()
    changed.scope.binding = conversation('10002').binding
    expect(diagnosticLocation(changed, snapshot)).toBeUndefined()
    expect(diagnosticLocation({ ...record, currentBinding: false }, snapshot)).toBeUndefined()
  })
  it('does not combine equal trace and binding IDs across accounts or binding versions', () => {
    const [a, , b] = parseStandaloneObserve(summary()).events
    expect(a.traceId).toBe(b.traceId)
    expect(diagnosticTraceKey(a)).not.toBe(diagnosticTraceKey(b))
    const changed = structuredClone(a)
    if (changed.scope.kind !== 'conversation') throw new Error('fixture')
    changed.scope.binding.revision = 'new-binding-version'
    expect(diagnosticTraceKey(a)).not.toBe(diagnosticTraceKey(changed))
  })
  it('rejects inconsistent selectors and incomplete current links before rendering', () => {
    const raw = summary()
    raw.events[0] = { ...event(), scopeKey: conversation('10002').scopeKey }
    expect(() => parseStandaloneObserve(raw)).toThrow('身份不一致')
    raw.events[0] = { ...event(), bindingToken: '' }
    expect(() => parseStandaloneObserve(raw)).toThrow('不完整')
  })
  it('preserves unavailable journal state without manufacturing zero failures or healthy status', () => {
    const raw = {
      ...summary(),
      journal: { available: false },
      scan: { truncated: false, invalidRecords: 0, scannedEvents: 2, hostCountersVisible: false }
    }
    expect(parseStandaloneObserve(raw).journal).toEqual({ available: false })
    expect(parseStandaloneObserve(raw).scan.hostCountersVisible).toBe(false)
  })
  it('accepts the actual saving window without presenting it as a loaded configuration', () => {
    const raw = summary()
    raw.configuration.phase = 'saving'
    expect(parseStandaloneObserve(raw).configuration.phase).toBe('saving')
  })
  it('rejects duplicate records, invalid configuration state and unbounded responses', () => {
    const raw = summary()
    raw.events = [event(), event()]
    expect(() => parseStandaloneObserve(raw)).toThrow()
    raw.events = Array.from({ length: 201 }, (_, i) => event(`event-${i}`))
    expect(() => parseStandaloneObserve(raw)).toThrow()
    raw.events = [event()]
    raw.configuration.storedRevision = 'changed'
    expect(() => parseStandaloneObserve(raw)).toThrow()
  })
})
const wrappers: VueWrapper[] = []
async function page() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  await router.push('/observe')
  const wrapper = mount(ObservePage, {
    attachTo: document.body,
    global: { plugins: [router] }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  workspace.reset()
  workspace.mode.value = 'standalone'
  workspace.data.value = workspaceData()
  Object.assign(consoleRestart.state, {
    standalone: true,
    phase: 'active',
    processEpoch: 'process-1',
    committedRevision: '',
    generation: 0,
    recoveryRequired: false
  })
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue(summary())
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  workspace.reset()
  Object.assign(consoleRestart.state, {
    standalone: false,
    phase: 'active',
    recoveryRequired: false
  })
  vi.useRealTimers()
  document.body.innerHTML = ''
})
describe('standalone observation page', () => {
  it('displays measured and estimated context use, phase latency and priced-sample coverage', async () => {
    const sample = { requests: 1, inputTokens: { p50: 100, p95: 200 }, estimatedInputTokens: null,
      latencyMs: { p50: 25, p95: 70 }, requestBytes: { p50: 400, p95: 500 },
      systemBytes: { p50: 50, p95: 80 }, toolSchemaBytes: { p50: 40, p95: 60 } }
    const metric = { platform: 'dingtalk', scene: 'group', purpose: 'text', model: 'fixture-model', route: 'chat',
      first: sample, followup: { ...sample, inputTokens: null, estimatedInputTokens: { p50: 130, p95: 190 } },
      turns: { count: 1, inputTokens: null, estimatedInputTokens: { p50: 200, p95: 300 }, latencyMs: { p50: 50, p95: 140 } },
      savedBytes: 300, overflow: 1, repeatedReads: 2, cachePercent: 60, pricedCostMicroCny: 12500, priced: 1 }
    vi.mocked(api).mockResolvedValue({ ...summary(), contextMetrics: [metric] })
    const wrapper = await page()
    const result = wrapper.findAll('tr').find(row => row.text().includes('fixture-model'))?.text()
    expect(result).toContain('100 / 200 token')
    expect(result).toContain('130 / 190（估算） token')
    expect(result).toContain('25 / 70 ms')
    expect(result).toContain('50 / 140 ms')
    expect(result).toContain('超限 1 · 重读 2')
    expect(result).toContain('缓存 60%')
    expect(result).toContain('¥0.0125（1 次）')
    expect(() => parseStandaloneObserve({ ...summary(), contextMetrics: [{ ...metric, cachePercent: 101 }] })).toThrow()
  })
  it('looks up an exact query reference beyond the default list without claiming a complete history', async () => {
    const traceId = 'older-trace.42:check'
    const older = { ...event('older-event'), traceId }
    vi.mocked(api).mockImplementation(async (path) =>
      path === `/api/observe/summary?traceId=${encodeURIComponent(traceId)}`
        ? { ...summary(), events: [older], scan: { ...summary().scan, truncated: true } }
        : summary()
    )
    const wrapper = await page()
    expect(wrapper.find('[data-event-id="older-event"]').exists()).toBe(false)
    await wrapper.get('input[aria-label="查询编号"]').setValue(traceId)
    await wrapper.get('form.trace-lookup').trigger('submit')
    await flushPromises()
    expect(api).toHaveBeenLastCalledWith(
      `/api/observe/summary?traceId=${encodeURIComponent(traceId)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(
      wrapper.findAll('[data-event-id]').map((row) => row.attributes('data-event-id'))
    ).toEqual(['older-event'])
    expect(wrapper.text()).toContain('已达到本次读取上限')
    expect(wrapper.text()).toContain('qq / global / 10001')
    await wrapper.get('[data-action="recent-observations"]').trigger('click')
    await flushPromises()
    expect(api).toHaveBeenLastCalledWith('/api/observe/summary', expect.anything())
    expect(wrapper.find('[data-event-id="event-1"]').exists()).toBe(true)
  })
  it('cancels replaced queries, clears old details and ignores late responses', async () => {
    const pending = new Map<string, { signal: AbortSignal; resolve: (value: unknown) => void }>()
    vi.mocked(api).mockImplementation((path, options) =>
      path === '/api/observe/summary'
        ? Promise.resolve(summary())
        : new Promise((resolve) => pending.set(path, { signal: options!.signal!, resolve }))
    )
    const wrapper = await page()
    await wrapper.find('[data-event-id="event-1"] button').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('a.conversation-link')).not.toBeNull()
    await wrapper.get('input[aria-label="查询编号"]').setValue('old-trace')
    await wrapper.get('form.trace-lookup').trigger('submit')
    await flushPromises()
    expect(document.body.querySelector('a.conversation-link')).toBeNull()
    await wrapper.get('input[aria-label="查询编号"]').setValue('new-trace')
    await wrapper.get('form.trace-lookup').trigger('submit')
    await flushPromises()
    expect(pending.get('/api/observe/summary?traceId=old-trace')!.signal.aborted).toBe(true)
    pending.get('/api/observe/summary?traceId=new-trace')!.resolve({
      ...summary(),
      events: [{ ...event('new-result'), traceId: 'new-trace' }]
    })
    await flushPromises()
    pending.get('/api/observe/summary?traceId=old-trace')!.resolve({
      ...summary(),
      events: [{ ...event('stale-result'), traceId: 'old-trace' }]
    })
    await flushPromises()
    expect(wrapper.find('[data-event-id="new-result"]').exists()).toBe(true)
    expect(wrapper.find('[data-event-id="stale-result"]').exists()).toBe(false)
  })
  it('invalidates an in-flight lookup when authorization is no longer current', async () => {
    let complete!: (value: unknown) => void
    let signal!: AbortSignal
    vi.mocked(api).mockImplementation((path, options) =>
      path === '/api/observe/summary'
        ? Promise.resolve(summary())
        : new Promise((resolve) => {
            complete = resolve
            signal = options!.signal!
          })
    )
    const wrapper = await page()
    await wrapper.get('input[aria-label="查询编号"]').setValue('pending-trace')
    await wrapper.get('form.trace-lookup').trigger('submit')
    await flushPromises()
    workspace.error.value = '授权状态暂时无法核对'
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(wrapper.findAll('[data-event-id]')).toHaveLength(0)
    complete({ ...summary(), events: [{ ...event('revoked-result'), traceId: 'pending-trace' }] })
    await flushPromises()
    expect(wrapper.findAll('[data-event-id]')).toHaveLength(0)
    expect(wrapper.text()).toContain('授权状态待核对')
  })
  it('discards old process results and cancels the active request on unmount', async () => {
    const pending: { signal: AbortSignal; resolve: (value: unknown) => void }[] = []
    vi.mocked(api).mockImplementation(
      (_path, options) =>
        new Promise((resolve) => pending.push({ signal: options!.signal!, resolve }))
    )
    const wrapper = await page()
    consoleRestart.state.generation++
    consoleRestart.state.processEpoch = 'process-2'
    await flushPromises()
    expect(pending[0].signal.aborted).toBe(true)
    pending[0].resolve(summary())
    await flushPromises()
    expect(wrapper.findAll('[data-event-id]')).toHaveLength(0)
    expect(wrapper.text()).toContain('运行实例已改变')
    workspace.data.value = {
      ...workspaceData(),
      configState: { ...workspaceData().configState, processEpoch: 'process-2' }
    }
    await flushPromises()
    const active = pending.at(-1)!
    expect(active.signal.aborted).toBe(false)
    wrapper.unmount()
    expect(active.signal.aborted).toBe(true)
    active.resolve({ ...summary(), processEpoch: 'process-2' })
    await flushPromises()
    expect(document.body.querySelector('[data-event-id]')).toBeNull()
  })
  it('loads one independent summary without rendering legacy 48-hour statistics', async () => {
    const wrapper = await page()
    expect(api).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('近 48 小时')
    expect(wrapper.text()).toContain('记录数不等于聊天回合数')
    expect(wrapper.findAll('[data-event-id]')).toHaveLength(4)
    expect(wrapper.text()).toContain('投递结果未知')
    expect(wrapper.text()).toContain('config-r1')
    expect(wrapper.text()).toContain('qq-10001')
    expect(wrapper.text()).toContain('qq / global / 10002')
  })
  it('filters the returned records by complete account and real outcome', async () => {
    const wrapper = await page(),
      filters = wrapper.findAllComponents(NSelect)
    filters[1].vm.$emit('update:value', JSON.stringify(['qq', 'global', '10002']))
    await flushPromises()
    expect(
      wrapper.findAll('[data-event-id]').map((row) => row.attributes('data-event-id'))
    ).toEqual(['event-other-account'])
    filters[1].vm.$emit('update:value', 'all')
    filters[2].vm.$emit('update:value', 'unknown')
    await flushPromises()
    expect(wrapper.findAll('[data-event-id]')).toHaveLength(2)
  })
  it('opens an exact current conversation and isolates same-trace records from another account', async () => {
    const wrapper = await page()
    await wrapper.find('[data-event-id="event-1"] button').trigger('click')
    await flushPromises()
    const drawer = new DOMWrapper(document.body.querySelector('.n-drawer-content')!)
    expect(drawer.text()).toContain('config-r0')
    expect(drawer.text()).toContain('投递结果未知')
    expect(drawer.findAll('.trace-timeline li')).toHaveLength(2)
    const link = drawer.find('a.conversation-link')
    expect(link.attributes('href')).toContain('/robots/alice/conversations?connection=qq-10001')
    expect(decodeURIComponent(link.attributes('href')!)).toContain(conversation().scopeKey)
    expect(link.attributes('href')).toContain('token-10001')
    expect(drawer.text()).not.toContain('10002')
  })
  it('preserves journal order for random IDs recorded in the same millisecond', async () => {
    const completedId = '03c93bea-d515-4f54-a79e-0d6e449dc5c8'
    const raw = summary()
    // The reader returns newest first; IDs carry no chronological information.
    raw.events = [
      { ...event(completedId), operation: 'probe_complete', delivery: undefined },
      {
        ...event('b905d4dc-3493-40f6-bc3a-dc09cd37be90'),
        operation: 'probe_model',
        delivery: undefined
      },
      {
        ...event('f4fe9a7c-7355-47ae-a16b-95342419c9f0'),
        operation: 'probe_start',
        outcome: 'started',
        delivery: undefined
      }
    ]
    vi.mocked(api).mockResolvedValue(raw)
    const wrapper = await page()
    await wrapper.find(`[data-event-id="${completedId}"] button`).trigger('click')
    await flushPromises()
    const drawer = new DOMWrapper(document.body.querySelector('.n-drawer-content')!)
    expect(drawer.findAll('.timeline-heading strong').map((row) => row.text())).toEqual([
      'probe_start',
      'probe_model',
      'probe_complete'
    ])
  })
  it('hides stale deep links and never equates missing host permissions with healthy logging', async () => {
    vi.mocked(api).mockResolvedValue({
      ...summary(),
      journal: { available: false },
      scan: { truncated: true, invalidRecords: 0, scannedEvents: 2, hostCountersVisible: false }
    })
    const wrapper = await page()
    workspace.data.value = { ...workspaceData(), agents: [] }
    await wrapper.find('[data-event-id="event-1"] button').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('a.conversation-link')).toBeNull()
    expect(document.body.textContent).toContain('此记录未能与当前完整绑定核对')
    expect(wrapper.text()).toContain('未获宿主日志状态查看权限')
    expect(wrapper.text()).toContain('已达到本次读取上限')
    expect(wrapper.text()).not.toContain('0 次写入失败')
    expect(wrapper.text()).toContain('未提供宿主日志扫描统计')
  })
  it('keeps observation read-only after retirement and retains authorization and workspace-error checks', () => {
    consoleRestart.state.phase = 'restart-required'
    expect(capability('observe.read').status).toBe('available')
    expect(capability('profiles.read').status).toBe('restart-required')
    workspace.error.value = 'refresh failed'
    expect(capability('observe.read').status).toBe('unavailable')
    workspace.error.value = ''
    workspace.data.value!.capabilities[0].status = 'forbidden'
    expect(capability('observe.read').status).toBe('forbidden')
  })
  it('waits for host mode instead of sending a legacy request to a standalone response', async () => {
    workspace.mode.value = 'unknown'
    const wrapper = await page()
    expect(api).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    workspace.mode.value = 'standalone'
    await flushPromises()
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('retains the existing plugin observation response and page', async () => {
    workspace.mode.value = 'legacy'
    vi.mocked(api).mockResolvedValue({
      report: {
        turns: 0,
        intents: [],
        triggers: [],
        routes: [],
        fastPathSkipCount: 0,
        totalMs: { avg: 0, p95: 0 },
        modelStages: {},
        tools: { runs: 0, failures: 0, topFailures: [] },
        failureStages: [],
        outbound: { total: 0, avgPerTurn: 0 }
      },
      hours: [],
      recent: []
    })
    const wrapper = await page()
    expect(wrapper.text()).toContain('近 48 小时归档')
    expect(wrapper.find('.standalone-observe').exists()).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
  })
})
