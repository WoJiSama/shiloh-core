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
