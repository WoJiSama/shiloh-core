import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NButton, NDrawer, NInput, NSelect } from 'naive-ui'
import WorkspaceOnboarding from '../components/WorkspaceOnboarding.vue'
import WorkspaceConnections from '../pages/WorkspaceConnections.vue'
import WorkspaceRobots from '../pages/WorkspaceRobots.vue'
import SchemaField from '../components/SchemaField.vue'
import { workspace } from './workspace'
import { consoleRestart } from './consoleRestart'
import { hasUnsavedChanges } from '../composables/useUnsavedGuard'
import { api } from './api'
import { configurationScopeKey } from './workspaceChangeModel'
const { warning, notice } = vi.hoisted(() => ({ warning: vi.fn(), notice: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<typeof import('naive-ui')>('naive-ui')),
  useDialog: () => ({ warning }),
  useMessage: () => ({ warning: notice })
}))
function catalog() {
  return {
    mode: 'standalone',
    revision: 'configuration-r1',
    configRevision: 'config-r1',
    processEpoch: 'p1',
    readSet: { host: 'host-r1', personas: 'personas-r1', bindings: 'bindings-r1' },
    agents: [{ agentId: 'daily', personaId: 'default' }],
    personas: [
      { id: 'default', name: '日常' },
      { id: 'shared', name: '研究' }
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
function preview(change: any) {
  const base = catalog(),
    connection = change.connection
  const oldConversation = {
    agentId: 'daily',
    connectionId: 'main',
    target: {
      account: base.connections[0]!.account,
      kind: 'group',
      id: '310911'
    }
  }
  const added =
    change.kind === 'connection.add'
      ? change.conversations.map((row: any) => ({
          agentId: change.agentId,
          connectionId: connection.id,
          target: {
            account: { platform: 'qq', namespace: 'global', id: connection.accountId },
            kind: row.kind,
            id: row.conversationId
          }
        }))
      : []
  return {
    ...base,
    previewId: 'preview-owned-by-server',
    candidateDigest: 'server-candidate-digest',
    expiresAt: Date.now() + 600000,
    requiresRestart: true,
    agents: undefined,
    personas: undefined,
    connections: undefined,
    changes:
      change.kind === 'connection.add'
        ? [
            {
              file: 'host',
              path: 'connections[1]',
              action: 'add',
              before: null,
              after: connection
            },
            {
              file: 'bindings',
              path: 'bindings[1]',
              action: 'add',
              before: null,
              after: { agentId: change.agentId, connectionId: connection.id }
            }
          ]
        : [
            {
              file: 'bindings',
              path: 'agents[1]',
              action: 'add',
              before: null,
              after: { id: change.agentId, personaId: change.personaId }
            },
            ...(change.newPersona
              ? [
                  {
                    file: 'personas',
                    path: 'personas[1]',
                    action: 'add',
                    before: null,
                    after: change.newPersona
                  }
                ]
              : [])
          ],
    affected: {
      agents: change.kind === 'connection.add' ? ['daily'] : ['daily', change.agentId],
      connections: [
        { id: 'main', account: base.connections[0]!.account },
        ...(connection ? [{ id: connection.id, account: added[0].target.account }] : [])
      ],
      conversations: [oldConversation, ...added]
    },
    permissions: added.map((row: any) => ({
      scopeKey: configurationScopeKey(row),
      mode: row.target.kind === 'group' ? 'simulation' : 'private-disabled',
      tools: row.target.kind === 'group' ? ['simReply'] : [],
      note: '本次不新增工具授权；整个宿主等待重启。'
    }))
  }
}
function safePreview(change: any) {
  return JSON.parse(JSON.stringify(preview(change)))
}
const wrappers: VueWrapper[] = []
function page(kind: 'connection.add' | 'agent.create' = 'connection.add', show = true) {
  const wrapper = mount(WorkspaceOnboarding, { props: { kind, show }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
const text = () => document.body.textContent ?? ''
function button(wrapper: VueWrapper, label: string) {
  return wrapper.findAllComponents(NButton).find((item) => item.text() === label)!
}
async function input(wrapper: VueWrapper, label: string, value: string) {
  wrapper
    .findAllComponents(NInput)
    .find((item) => item.attributes('aria-label') === label)!
    .vm.$emit('update:value', value)
  await flushPromises()
}
async function select(wrapper: VueWrapper, label: string, value: string) {
  wrapper
    .findAllComponents(NSelect)
    .find((item) => item.attributes('aria-label') === label)!
    .vm.$emit('update:value', value)
  await flushPromises()
}
async function connectionDraft(wrapper: VueWrapper) {
  await select(wrapper, '连接所属本人', 'daily')
  await input(wrapper, '新连接标识', 'extra')
  await input(wrapper, '新增 QQ 账号', '19000912')
  await input(wrapper, 'WebSocket 地址', 'ws://127.0.0.1:3002')
  await input(wrapper, '会话 1 编号', '310911')
}
async function review(wrapper: VueWrapper) {
  await button(wrapper, '生成服务端预览').trigger('click')
  await flushPromises()
}
async function accept(wrapper: VueWrapper) {
  const checkbox = document.body.querySelector<HTMLInputElement>('.configuration-review input')!
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
  await button(wrapper, '确认提交此候选').trigger('click')
  await flushPromises()
}
function setupApi() {
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/api/configuration/catalog') return catalog()
    if (path === '/api/configuration/preview')
      return safePreview(JSON.parse(String(options?.body)).change)
    if (path === '/api/configuration/commit')
      return {
        changed: 2,
        requiresRestart: true,
        committedRevision: 'config-r2',
        processEpoch: 'p1',
        transactionId: 'transaction-new-config',
        view: {
          ...catalog(),
          configRevision: 'config-r2',
          revision: 'configuration-r2',
          readSet: { host: 'host-r2', personas: 'personas-r1', bindings: 'bindings-r2' }
        }
      }
    throw new Error('unexpected API: ' + path)
  })
}
beforeEach(() => {
  workspace.reset()
  workspace.mode.value = 'standalone'
  workspace.data.value = {
    mode: 'standalone',
    version: 1,
    observedAt: 1,
    revision: 'workspace-r1',
    agents: [
      { id: 'daily', name: '日常', personaId: 'default', personaName: '日常', conversations: [] }
    ],
    connections: [],
    cognition: { status: 'planned' },
    configState: {
      processEpoch: 'p1',
      loadedRevision: 'config-r1',
      storedRevision: 'config-r1',
      phase: 'active',
      requiresRestart: false
    },
    capabilities: ['configuration.read', 'configuration.preview', 'configuration.commit'].map(
      (operation) => ({
        operation,
        scope: 'global',
        effect: operation === 'configuration.read' ? 'read' : 'write',
        status: 'available',
        reason: ''
      })
    )
  }
  Object.assign(consoleRestart.state, {
    standalone: true,
    phase: 'active',
    processEpoch: 'p1',
    committedRevision: '',
    generation: 0,
    reloadGeneration: 0,
    recoveryRequired: false,
    transaction: { phase: 'clean' }
  })
  warning.mockReset()
  notice.mockReset()
  vi.mocked(api).mockReset()
  setupApi()
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
describe('workspace configuration onboarding', () => {
  it('adds a second account to the same person with explicit sources and submits only the server candidate', async () => {
    const wrapper = page()
    await flushPromises()
    await connectionDraft(wrapper)
    await review(wrapper)
    const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/preview'))!
    expect(JSON.parse(String(request[1]!.body))).toEqual({
      revision: 'configuration-r1',
      change: {
        kind: 'connection.add',
        agentId: 'daily',
        connection: {
          id: 'extra',
          accountId: '19000912',
          transport: 'forward-websocket',
          url: 'ws://127.0.0.1:3002'
        },
        conversations: [{ kind: 'group', conversationId: '310911' }]
      }
    })
    expect(text()).toContain('连接 extra · 账号 qq / global / 19000912 · 群聊 310911')
    expect(text()).toContain('连接 main · 账号 qq / global / 19000911 · 群聊 310911')
    expect(text()).toContain('本次不新增工具授权')
    expect(text()).toContain('已有会话：本次不新增授权')
    expect(text()).toContain('变更前')
    expect(text()).toContain('变更后')
    expect(button(wrapper, '确认提交此候选').props('disabled')).toBe(true)
    await accept(wrapper)
    const commit = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/commit'))!
    expect(JSON.parse(String(commit[1]!.body))).toEqual({
      previewId: 'preview-owned-by-server',
      revision: 'configuration-r1',
      candidateDigest: 'server-candidate-digest',
      readSet: { host: 'host-r1', personas: 'personas-r1', bindings: 'bindings-r1' }
    })
    expect(text()).toContain('配置已保存')
    expect(text()).toContain('transaction-new-config')
    expect(workspace.data.value!.connections).toEqual([])
    expect(hasUnsavedChanges()).toBe(false)
  })
  it.each(['existing', 'new'])(
    'creates a person with %s template as one candidate',
    async (source) => {
      const wrapper = page('agent.create')
      await flushPromises()
      await input(wrapper, '新本人标识', 'research')
      if (source === 'new') {
        await select(wrapper, '新人设来源', 'new')
        await input(wrapper, '新模板标识', 'research-template')
        await input(wrapper, '新人设名称', '研究人设')
        const identity = wrapper
          .findAllComponents(SchemaField)
          .find((field) => field.props('field').field === 'identity')!
        identity.vm.$emit('update:modelValue', '谨慎研究')
        await flushPromises()
      } else await select(wrapper, '复用人设模板', 'shared')
      await review(wrapper)
      const call = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/preview'))!
      expect(JSON.parse(String(call[1]!.body)).change).toEqual(
        source === 'new'
          ? {
              kind: 'agent.create',
              agentId: 'research',
              personaId: 'research-template',
              newPersona: { id: 'research-template', name: '研究人设', identity: '谨慎研究' }
            }
          : { kind: 'agent.create', agentId: 'research', personaId: 'shared' }
      )
      expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/persona/library')).toBe(
        false
      )
      expect(text()).toContain('本次不新增会话或会话权限')
      await accept(wrapper)
      expect(text()).toContain('配置已保存')
    }
  )
  it('discards the reviewed candidate when a draft changes and ignores a late preview after closing', async () => {
    const wrapper = page()
    await flushPromises()
    await connectionDraft(wrapper)
    await review(wrapper)
    await input(wrapper, '新连接标识', 'extra-updated')
    expect(document.body.querySelector('.candidate-preview')).toBeNull()
    let finish!: (value: unknown) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    await review(wrapper)
    wrapper.findComponent(NDrawer).vm.$emit('update:show', false)
    await flushPromises()
    expect(warning).toHaveBeenCalledOnce()
    await warning.mock.calls[0]![0].onPositiveClick()
    expect(wrapper.emitted('update:show')!.at(-1)).toEqual([false])
    await wrapper.setProps({ show: false })
    finish(
      safePreview({
        kind: 'connection.add',
        agentId: 'daily',
        connection: { id: 'extra-updated', accountId: '19000912' },
        conversations: [{ kind: 'group', conversationId: '310911' }]
      })
    )
    await flushPromises()
    await wrapper.setProps({ show: true })
    await flushPromises()
    expect(
      wrapper
        .findAllComponents(NInput)
        .find((item) => item.attributes('aria-label') === '新连接标识')!
        .props('value')
    ).toBe('extra-updated')
    expect(document.body.querySelector('.candidate-preview')).toBeNull()
    expect(hasUnsavedChanges()).toBe(true)
  })
  it('guards drawer close and navigation during a pending commit, then locks an unknown result', async () => {
    const wrapper = page()
    await flushPromises()
    await connectionDraft(wrapper)
    await review(wrapper)
    let reject!: (cause: Error) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise((_, fail) => (reject = fail)))
    await accept(wrapper)
    expect(wrapper.findComponent(NDrawer).props('maskClosable')).toBe(false)
    expect(wrapper.findComponent(NDrawer).props('closeOnEsc')).toBe(false)
    expect(hasUnsavedChanges()).toBe(true)
    wrapper.findComponent(NDrawer).vm.$emit('update:show', false)
    await flushPromises()
    expect(wrapper.emitted('update:show')).toBeUndefined()
    expect(notice).toHaveBeenCalledWith('正在提交配置，请等待结果；不要重复操作。')
    reject(new Error('response lost'))
    await flushPromises()
    expect(text()).toContain('提交结果未知，已锁定提交')
    expect(button(wrapper, '确认提交此候选')).toBeUndefined()
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1)
    expect(hasUnsavedChanges()).toBe(true)
  })
  it.each(['candidate_stale', 'conflict', 'configuration_recovery_required'])(
    'presents %s with its correct retry boundary',
    async (code) => {
      const wrapper = page()
      await flushPromises()
      await connectionDraft(wrapper)
      await review(wrapper)
      vi.mocked(api).mockRejectedValueOnce({
        status: code === 'configuration_recovery_required' ? 503 : 409,
        details: { error: code }
      })
      await accept(wrapper)
      expect(text()).toContain(
        code === 'candidate_stale'
          ? '服务端未提交'
          : code === 'conflict'
            ? '提交结果未知'
            : '需要离线恢复'
      )
      expect(button(wrapper, '确认提交此候选')).toBeUndefined()
      expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/commit'))).toHaveLength(1)
      const draft = wrapper
        .findAllComponents(NInput)
        .find((item) => item.attributes('aria-label') === '新连接标识')!
      expect(draft.props('value')).toBe('extra')
      expect(draft.props('disabled')).toBe(code !== 'candidate_stale')
    }
  )
  it('re-reads the catalog on a verified process reload while retaining the unfinished draft', async () => {
    const wrapper = page('agent.create')
    await flushPromises()
    await input(wrapper, '新本人标识', 'research')
    await review(wrapper)
    consoleRestart.state.processEpoch = 'p2'
    consoleRestart.state.generation++
    vi.mocked(api).mockResolvedValueOnce({
      ...catalog(),
      processEpoch: 'p2',
      revision: 'configuration-r2'
    })
    consoleRestart.state.reloadGeneration++
    await flushPromises()
    expect(document.body.querySelector('.candidate-preview')).toBeNull()
    expect(
      wrapper
        .findAllComponents(NInput)
        .find((item) => item.attributes('aria-label') === '新本人标识')!
        .props('value')
    ).toBe('research')
    expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/catalog'))).toHaveLength(2)
    expect(hasUnsavedChanges()).toBe(true)
  })
  it('requires read, preview and commit permissions for entry and preserves responsive drawer sizing', async () => {
    workspace.data.value!.capabilities.find(
      (item) => item.operation === 'configuration.commit'
    )!.status = 'forbidden'
    const robots = mount(WorkspaceRobots, {
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    wrappers.push(robots)
    expect(button(robots, '创建本人').props('disabled')).toBe(true)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: WorkspaceConnections }]
    })
    await router.push('/connections')
    await router.isReady()
    const connections = mount(WorkspaceConnections, { global: { plugins: [router] } })
    wrappers.push(connections)
    expect(button(connections, '新增 QQ 连接').props('disabled')).toBe(true)
    expect(api).not.toHaveBeenCalled()
    const drawer = page('agent.create', false)
    expect(drawer.findComponent(NDrawer).props('width')).toBe('min(880px, 100vw)')
    expect(api).not.toHaveBeenCalled()
  })
  it('shows unavailable catalog as failure rather than an empty creation form', async () => {
    vi.mocked(api).mockRejectedValueOnce({ status: 503, details: { error: 'unavailable' } })
    const wrapper = page()
    await flushPromises()
    expect(text()).toContain('配置服务暂时不可用')
    expect(button(wrapper, '生成服务端预览')).toBeUndefined()
  })
})
