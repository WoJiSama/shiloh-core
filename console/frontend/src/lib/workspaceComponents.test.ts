import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import { NButton, NInput } from 'naive-ui'
import RobotScene from '../components/RobotScene.vue'
import WorkspaceRobots from '../pages/WorkspaceRobots.vue'
import WorkspaceRobot from '../pages/WorkspaceRobot.vue'
import WorkspaceOverview from '../pages/WorkspaceOverview.vue'
import WorkspaceShell from '../components/WorkspaceShell.vue'
import StandaloneProfiles from '../components/StandaloneProfiles.vue'
import StandalonePersonaConfig from '../components/StandalonePersonaConfig.vue'
import TrusteeshipPage from '../pages/TrusteeshipPage.vue'
import ConsoleFeaturePage from '../pages/ConsoleFeaturePage.vue'
import EmbeddedPage from '../pages/EmbeddedPage.vue'
import CapabilityGate from '../components/CapabilityGate.vue'
import { workspace } from './workspace'
import { consoleRestart } from './consoleRestart'
import { api } from './api'
import { parseWorkspace, robotLocation } from './workspaceModel'
const { warning, notice } = vi.hoisted(() => ({ warning: vi.fn(), notice: vi.fn() }))
vi.mock('./api', async () => ({
  api: vi.fn(),
  authState: (await vi.importActual<typeof import('vue')>('vue')).ref(null),
  imageUrl: (path: string) => path,
  clearToken: vi.fn()
}))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<typeof import('naive-ui')>('naive-ui')),
  useDialog: () => ({ warning }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: notice })
}))
function scene(agentId = 'alice', accountId = '19001111', kind = 'group') {
  return {
    scopeKey: JSON.stringify([agentId, 'qq', 'global', accountId, kind, '33001111']),
    bindingToken: 'displayed-' + accountId,
    binding: {
      source: 'configured' as const,
      id: 'binding-' + accountId,
      revision: 'r1',
      agentId,
      personaId: 'shared',
      connectionId: accountId,
      target: {
        account: { platform: 'qq', namespace: 'global', id: accountId },
        kind,
        id: '33001111'
      }
    }
  }
}
function data() {
  const a = scene(),
    b = scene('bob', '19002222')
  return parseWorkspace({
    mode: 'standalone',
    version: 1,
    observedAt: 1,
    revision: 'workspace-r1',
    agents: [
      {
        id: 'alice',
        name: '希洛',
        personaId: 'shared',
        personaName: '同一模板',
        conversations: [a]
      },
      { id: 'bob', name: '阿白', personaId: 'shared', personaName: '同一模板', conversations: [b] }
    ],
    connections: [a, b].map((row) => ({
      id: row.binding.connectionId,
      account: row.binding.target.account,
      state: 'unknown',
      conversationCount: 1,
      capabilities: []
    })),
    capabilities: [
      'simulation.group-read',
      'simulation.group-write',
      'profiles.read',
      'profiles.delete',
      'profiles.delete-field',
      'commitments.cancel',
      'delegated.delete'
    ].map((operation) => ({
      operation,
      scope: 'conversation',
      effect: operation.includes('read') ? 'read' : 'write',
      status: 'available',
      reason: '',
      authorizedScopes: [a.scopeKey, b.scopeKey]
    })),
    cognition: { status: 'planned' },
    configState: {
      processEpoch: 'p1',
      loadedRevision: 'r1',
      storedRevision: 'r1',
      requiresRestart: false,
      phase: 'active'
    }
  })
}
const result = (row = scene(), extra = {}) => ({
  scopeKey: row.scopeKey,
  bindingToken: row.bindingToken,
  active: true,
  running: false,
  unreadCount: 0,
  character: { paused: false, memories: [], goals: [], receipts: [] },
  ...extra
})
const wrappers: VueWrapper[] = []
function page(component: any, props = {}, plugins: any[] = []) {
  const wrapper = mount(component, {
    props,
    global: {
      plugins,
      stubs: { RouterLink: plugins.length ? false : { template: '<a><slot /></a>' } }
    }
  })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  workspace.reset()
  workspace.mode.value = 'standalone'
  workspace.data.value = data()
  Object.assign(consoleRestart.state, {
    standalone: true,
    phase: 'active',
    processEpoch: 'p1',
    committedRevision: '',
    generation: 0,
    reloadGeneration: 0
  })
  warning.mockReset()
  notice.mockReset()
  vi.mocked(api).mockReset()
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  workspace.reset()
  Object.assign(consoleRestart.state, { standalone: false, phase: 'active' })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
describe('robot workspace components', () => {
  it('renders separate people sharing one template without inventing online or activity state', () => {
    const wrapper = page(WorkspaceRobots)
    expect(wrapper.findAll('.robot-card')).toHaveLength(2)
    expect(wrapper.text()).toContain('希洛')
    expect(wrapper.text()).toContain('阿白')
    expect(wrapper.text()).toContain('状态未知')
    expect(wrapper.text()).not.toContain('在线')
    expect(api).not.toHaveBeenCalled()
  })
  it('visibly distinguishes same-name people in cards, overview, detail, breadcrumb and search', async () => {
    const snapshot = data()
    snapshot.agents.forEach((agent) => (agent.name = '本地联调角色'))
    workspace.data.value = snapshot
    const labels = ['本地联调角色（本人标识 · alice）', '本地联调角色（本人标识 · bob）']
    const cards = page(WorkspaceRobots)
    expect(cards.findAll('h2').map((heading) => heading.text())).toEqual(labels)
    const overview = page(WorkspaceOverview)
    labels.forEach((label) => expect(overview.text()).toContain(label))
    cards.unmount()
    overview.unmount()
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/robots/:id/:tab', component: { template: '<div />' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
      ]
    })
    await router.push('/robots/alice/home')
    await router.isReady()
    const detail = page(WorkspaceRobot, {}, [router])
    expect(detail.find('h1').text()).toBe(labels[0])
    vi.stubGlobal('__CONSOLE_BUILD__', { revision: 'test', at: '2026-11-18T00:00:00Z' })
    vi.mocked(api).mockResolvedValue(snapshot)
    const shell = mount(WorkspaceShell, {
      props: { appearance: 'light' },
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: { RouterView: true }
      }
    })
    wrappers.push(shell)
    await flushPromises()
    expect(shell.find('.breadcrumbs').text()).toContain(labels[0])
    await shell.find('.search-trigger').trigger('click')
    await flushPromises()
    const search = document.body.querySelector('.search-results')
    labels.forEach((label) => expect(search?.textContent).toContain(label))
    expect(document.title).toContain(labels[0])
  })
  it('keeps complete displayed selectors on reads and character writes', async () => {
    const row = scene()
    vi.mocked(api).mockImplementation(async (_path, options) =>
      options?.method === 'POST' ? { ok: true } : result()
    )
    const wrapper = page(RobotScene, { conversation: row, section: 'actions' })
    await flushPromises()
    const read = vi.mocked(api).mock.calls[0]!
    const query = new URL(read[0], 'http://console').searchParams
    expect(query.get('scopeKey')).toBe(row.scopeKey)
    expect(query.get('bindingToken')).toBe(row.bindingToken)
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '暂停此会话行动')!
      .trigger('click')
    await flushPromises()
    const mutation = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(JSON.parse(String(mutation[1]!.body))).toEqual({
      scopeKey: row.scopeKey,
      bindingToken: row.bindingToken,
      action: 'character',
      operation: 'pause'
    })
  })
  it('keeps a write disabled when only another account in the same group is authorized', async () => {
    workspace.data.value!.capabilities.find(
      (item) => item.operation === 'simulation.group-write'
    )!.authorizedScopes = [scene('bob', '19002222').scopeKey]
    vi.mocked(api).mockResolvedValue(result())
    const wrapper = page(RobotScene, { conversation: scene(), section: 'actions' })
    await flushPromises()
    const button = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '暂停此会话行动')!
    expect(button.props('disabled')).toBe(true)
    await button.trigger('click')
    await flushPromises()
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(0)
  })
  it('shows the actual epistemic label, evidence references and goal association', async () => {
    vi.mocked(api).mockResolvedValue(
      result(scene(), {
        character: {
          paused: false,
          memories: [
            {
              id: 'm1',
              content: '暂时判断',
              kind: 'opinion',
              epistemic: 'inferred',
              evidenceRefs: ['message:source-1'],
              createdAt: 1
            }
          ],
          goals: [],
          receipts: [
            {
              id: 'r1',
              toolName: 'tool',
              status: 'unknown',
              summary: '等待核实',
              at: 1,
              goalId: 'goal-1'
            }
          ]
        }
      })
    )
    const wrapper = page(RobotScene, { conversation: scene(), section: 'self' })
    await flushPromises()
    expect(wrapper.text()).toContain('暂时判断')
    expect(wrapper.text()).toContain('message:source-1')
    await wrapper.setProps({ section: 'actions' })
    await flushPromises()
    expect(wrapper.text()).toContain('结果未知')
    expect(wrapper.text()).toContain('goal-1')
  })
  it('discards a late scene response after the complete displayed conversation changes', async () => {
    workspace.data
      .value!.capabilities.find((item) => item.operation === 'simulation.group-read')!
      .authorizedScopes!.push(scene('alice', '19003333').scopeKey)
    let resolve!: (value: any) => void
    vi.mocked(api)
      .mockImplementationOnce(() => new Promise((finish) => (resolve = finish)))
      .mockResolvedValue(
        result(scene('alice', '19003333'), {
          character: {
            paused: false,
            memories: [{ id: 'fresh', content: 'new context', kind: 'interest', createdAt: 1 }],
            goals: [],
            receipts: []
          }
        })
      )
    const wrapper = page(RobotScene, { conversation: scene(), section: 'self' })
    await wrapper.setProps({ conversation: scene('alice', '19003333') })
    await flushPromises()
    resolve(
      result(scene(), {
        character: {
          paused: false,
          memories: [
            { id: 'old', content: 'stale private context', kind: 'interest', createdAt: 1 }
          ],
          goals: [],
          receipts: []
        }
      })
    )
    await flushPromises()
    expect(wrapper.text()).toContain('new context')
    expect(wrapper.text()).not.toContain('stale private context')
  })
  it('shows unavailable errors rather than an empty scene and never calls simulation for private scenes', async () => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error('实际读取不可用'), { status: 503 }))
    const failed = page(RobotScene, { conversation: scene(), section: 'self' })
    await flushPromises()
    expect(failed.text()).toContain('实际读取不可用')
    expect(failed.text()).not.toContain('没有可见的自我记录')
    vi.mocked(api).mockClear()
    const privateView = page(RobotScene, {
      conversation: scene('alice', '19001111', 'private'),
      section: 'self'
    })
    await flushPromises()
    expect(privateView.text()).toContain('尚未提供')
    expect(api).not.toHaveBeenCalled()
  })
  it('locks an uncertain mutation without automatically retrying it', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') throw new Error('lost response')
      return result()
    })
    const wrapper = page(RobotScene, { conversation: scene(), section: 'actions' })
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '暂停此会话行动')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('操作结果待核对')
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(1)
  })
  it('pauses scene refresh while a write is pending and retains an unknown result', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(api).mockImplementation(async (_path, options) =>
      options?.method === 'POST' ? new Promise((_, fail) => (reject = fail)) : result()
    )
    const wrapper = page(RobotScene, { conversation: scene(), section: 'actions' })
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '暂停此会话行动')!
      .trigger('click')
    await flushPromises()
    const refresh = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '重新读取')!
    expect(refresh.props('disabled')).toBe(true)
    refresh.vm.$emit('click')
    workspace.data.value = data()
    await flushPromises()
    workspace.error.value = 'workspace refresh failed'
    await flushPromises()
    workspace.error.value = ''
    await flushPromises()
    expect(api).toHaveBeenCalledTimes(2)
    reject(new Error('lost write response'))
    await flushPromises()
    expect(wrapper.text()).toContain('操作结果待核对')
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('keeps opened editors mounted and inert after retirement so drafts survive', async () => {
    const wrapper = page(CapabilityGate, { operation: 'profiles.read' })
    expect(wrapper.find('div[inert]').exists()).toBe(false)
    consoleRestart.state.phase = 'uncertain'
    await flushPromises()
    expect(wrapper.text()).toContain('当前执行已暂停')
    expect(wrapper.find('div[inert]').exists()).toBe(true)
  })
  it('rejects a stale deep link without selecting another account that shares the same group', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/robots/:id/:tab', component: WorkspaceRobot },
        { path: '/robots', component: { template: '<div />' } }
      ]
    })
    await router.push({
      path: '/robots/alice/self',
      query: { scopeKey: scene().scopeKey, bindingToken: 'old' }
    })
    await router.isReady()
    const wrapper = page(WorkspaceRobot, {}, [router])
    await flushPromises()
    expect(wrapper.text()).toContain('会话链接已失效')
    expect(api).not.toHaveBeenCalled()
    const location = robotLocation(workspace.data.value!.agents[0]!, 'self', scene())
    await router.push(location)
    vi.mocked(api).mockResolvedValue(result())
    await flushPromises()
    expect(wrapper.findAll('.robot-scene')).toHaveLength(1)
    const tabs = wrapper.findAllComponents(RouterLink).filter((link) => link.text() === '行动')
    expect((tabs[0]?.props('to') as { query: { bindingToken: string } }).query.bindingToken).toBe(
      scene().bindingToken
    )
  })
  it('restores scoped memory and trusteeship panels from URLs and clears panels on tab changes', async () => {
    const row = scene()
    workspace.data.value!.capabilities.push({
      operation: 'trusteeship.read',
      scope: 'global',
      effect: 'read',
      status: 'available',
      reason: ''
    })
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/api/person-profiles') return { profiles: [profile(row)] }
      if (path === '/api/trusteeship/overview') return trusteeship()
      return result(row)
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/robots/:id/:tab', component: { template: '<div />' } },
        { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
      ]
    })
    const location = robotLocation(workspace.data.value!.agents[0]!, 'self', row)
    await router.push({ ...location, query: { ...location.query, panel: 'person-profiles' } })
    await router.isReady()
    let wrapper = page(WorkspaceRobot, {}, [router])
    await flushPromises()
    expect(wrapper.findComponent(StandaloneProfiles).props('conversationScopes')).toEqual([row])
    expect(wrapper.findAll('h1')).toHaveLength(1)
    await wrapper
      .findAllComponents(RouterLink)
      .find((link) => link.text() === '查看全部会话')!
      .trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ panel: 'person-profiles' })
    expect(wrapper.findComponent(StandaloneProfiles).exists()).toBe(true)
    await router.push({ ...location, query: { ...location.query, panel: 'person-profiles' } })
    await flushPromises()
    await wrapper
      .findAllComponents(RouterLink)
      .find((link) => link.text() === '行动')!
      .trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual(location.query)
    expect(wrapper.findAllComponents(NButton).some((button) => button.text() === '收起')).toBe(
      false
    )
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '托付与承诺')!
      .trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ ...location.query, panel: 'trusteeship' })
    wrapper.unmount()
    wrapper = page(WorkspaceRobot, {}, [router])
    await flushPromises()
    expect(wrapper.findComponent(TrusteeshipPage).props('conversationScopes')).toEqual([row])
    expect(wrapper.findAll('h1')).toHaveLength(1)
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '收起')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(TrusteeshipPage).exists()).toBe(false)
    expect(router.currentRoute.value.query).toEqual(location.query)
  })
  it.each(['conversations', 'self', 'actions'])(
    'links %s status to full management with the displayed binding and robot return path',
    async (tab) => {
      vi.mocked(api).mockResolvedValue(result())
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/robots/:id/:tab', component: { template: '<div />' } },
          { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
        ]
      })
      const location = robotLocation(workspace.data.value!.agents[0]!, tab, scene())
      await router.push(location)
      await router.isReady()
      const wrapper = page(WorkspaceRobot, {}, [router])
      await flushPromises()
      const manage = wrapper
        .findAllComponents(RouterLink)
        .find((link) => link.text() === '管理此会话 →')!
      expect(manage.props('to')).toEqual({
        path: '/simulation',
        query: { agentId: 'alice', returnTab: tab, ...location.query }
      })
      const privateView = page(RobotScene, {
        conversation: scene('alice', '19001111', 'private'),
        section: 'conversations',
        manageTo: '/simulation'
      })
      expect(privateView.text()).not.toContain('管理此会话')
    }
  )
  it('returns from shared resources to the same robot and rejects stale or foreign selectors', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    const location = robotLocation(workspace.data.value!.agents[0]!, 'boundaries', scene())
    await router.push({
      path: '/persona',
      query: { agentId: 'alice', returnTab: 'boundaries', ...location.query }
    })
    await router.isReady()
    const wrapper = page(ConsoleFeaturePage, { feature: 'persona' }, [router])
    expect(wrapper.findComponent(RouterLink).props('to')).toEqual(location)
    expect(wrapper.findComponent(RouterLink).text()).toContain('返回机器人')
    await router.push({
      path: '/persona',
      query: {
        agentId: 'alice',
        returnTab: 'boundaries',
        ...robotLocation(workspace.data.value!.agents[1]!, 'home', scene('bob', '19002222')).query
      }
    })
    await flushPromises()
    expect(wrapper.findComponent(RouterLink).props('to')).toEqual({
      path: '/robots/alice/boundaries',
      query: {}
    })
    await router.push({
      path: '/persona',
      query: { agentId: 'missing', returnTab: 'https://example.test' }
    })
    await flushPromises()
    expect((wrapper.findComponent(RouterLink).props('to') as { path: string }).path).toBe(
      '/resources'
    )
  })
  it('opens the linked robot persona instead of the first template in the library', () => {
    const wrapper = shallowMount(StandalonePersonaConfig, {
      props: {
        initial: {
          mode: 'standalone',
          processEpoch: 'p1',
          configRevision: 'r1',
          revision: 'library-r1',
          personas: [
            { id: 'other', name: '其他模板' },
            { id: 'shared', name: '当前机器人的模板' }
          ],
          defaultPersona: {}
        },
        initialPersonaId: 'shared'
      },
      global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
    })
    wrappers.push(wrapper)
    expect(wrapper.find('.template-editor h2').text()).toBe('当前机器人的模板')
  })
  it('keeps module navigation and search available and assigns observation details to runtime', async () => {
    const snapshot = data()
    vi.mocked(api).mockResolvedValue(snapshot)
    vi.stubGlobal('__CONSOLE_BUILD__', { revision: 'test', at: '2026-11-18T00:00:00Z' })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    await router.push('/observe/details')
    await router.isReady()
    const shell = mount(WorkspaceShell, {
      props: { appearance: 'light' },
      attachTo: document.body,
      global: { plugins: [router], stubs: { RouterView: true } }
    })
    wrappers.push(shell)
    await flushPromises()
    expect(shell.find('.navigation .active').text()).toBe('运行中心')
    expect(shell.find('.workspace-subnav .active').text()).toBe('运行观测')
    expect(shell.find('.workspace-subnav').text()).toContain('托付与承诺')
    await router.push('/ai')
    expect(shell.find('.workspace-subnav .active').text()).toBe('模型资源')
    expect(shell.find('.workspace-subnav').text()).toContain('记忆检索')
    await shell.find('.search-trigger').trigger('click')
    await flushPromises()
    shell
      .findAllComponents(NInput)
      .find((input) => input.props('placeholder') === '模块、名字、连接或完整会话标识')!
      .vm.$emit('update:value', '费用')
    await flushPromises()
    expect(document.querySelector('.search-results')?.textContent).toContain('模型用量')
    ;(document.querySelector('.search-results button') as HTMLButtonElement).click()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/tokens')
    const details = page(EmbeddedPage, {}, [router])
    expect(details.find('iframe').exists()).toBe(false)
    expect(details.text()).toContain('尚未提供完整运行明细')
  })
})
function profile(row = scene(), text = '喜欢天文') {
  return {
    scopeKey: row.scopeKey,
    bindingToken: row.bindingToken,
    userId: 'person-1',
    identity: { botId: 'owner', personaId: 'shared' },
    sourceScene: { kind: 'group', id: 'source-scene' },
    entries: [
      {
        id: 'entry-1',
        category: 'interest',
        text,
        evidenceKind: 'self',
        source: {
          scene: { kind: 'group', id: 'source-scene' },
          authorId: 'person-1',
          messageId: 'message-1',
          at: 1,
          excerpt: '我喜欢天文'
        }
      }
    ]
  }
}
function sameGroupSources() {
  const main = scene('alice', '19001111'),
    extra = scene('alice', '19002222'),
    snapshot = data()
  main.binding.connectionId = 'main'
  extra.binding.connectionId = 'extra'
  snapshot.agents[0]!.conversations = [main, extra]
  snapshot.agents[1]!.conversations = []
  snapshot.connections[0]!.id = 'main'
  snapshot.connections[1]!.id = 'extra'
  snapshot.capabilities.forEach((item) => (item.authorizedScopes = [main.scopeKey, extra.scopeKey]))
  workspace.data.value = snapshot
  return [main, extra] as const
}
function expectExtraSource(content: string) {
  expect(content).toContain('连接 extra')
  expect(content).toContain('账号 qq / global / 19002222')
  expect(content).toContain('群聊 33001111')
  expect(content).not.toContain('连接 main')
  expect(content).not.toContain('19001111')
}
describe('destructive confirmation source identity', () => {
  it.each(['删除此条', '清空当前来源记录'])(
    'names the exact connection and account when confirming profile %s in a shared group',
    async (action) => {
      const [main, extra] = sameGroupSources()
      vi.mocked(api).mockResolvedValue({ profiles: [profile(main), profile(extra)] })
      const wrapper = page(StandaloneProfiles)
      await flushPromises()
      const selected = wrapper
        .findAll('section.panel')
        .find((row) => row.text().includes('19002222'))!
      expect(selected.text()).toContain('19002222')
      await wrapper
        .findAllComponents(NButton)
        .filter((button) => button.text() === action)[1]!
        .trigger('click')
      const confirmation = warning.mock.calls[0]![0]
      expectExtraSource(confirmation.content)
      await confirmation.onPositiveClick()
      const mutation = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
      expect(JSON.parse(String(mutation[1]!.body))).toMatchObject({
        userId: 'person-1',
        scopeKey: extra.scopeKey,
        bindingToken: extra.bindingToken
      })
    }
  )
  it.each(['取消', '删除'])(
    'names the exact connection and account when confirming trusteeship %s in a shared group',
    async (action) => {
      const sources = sameGroupSources(),
        overview = trusteeship(),
        base = overview.commitments[0]!
      const payload = {
        ...overview,
        commitments: sources.map((source) => ({
          ...base,
          ...source,
          groupId: source.scopeKey,
          id: source.binding.connectionId + '-task',
          account: source.binding.target.account,
          conversation: source.binding.target
        })),
        delegated: sources.map((source) => ({
          ...source,
          groupId: source.scopeKey,
          entries: [
            {
              id: source.binding.connectionId + '-note',
              owner: 'person-1',
              ownerName: '用户',
              content: '同一条托付',
              dueAt: 0,
              status: 'active',
              createdAt: 1
            }
          ]
        }))
      }
      vi.mocked(api).mockResolvedValue(payload)
      const wrapper = page(TrusteeshipPage)
      await flushPromises()
      await wrapper
        .findAllComponents(NButton)
        .filter((button) => button.text() === action)[1]!
        .trigger('click')
      const confirmation = warning.mock.calls[0]![0]
      expectExtraSource(confirmation.content)
      await confirmation.onPositiveClick()
      const mutation = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
      expect(JSON.parse(String(mutation[1]!.body))).toMatchObject({
        id: action === '取消' ? 'extra-task' : 'extra-note',
        scopeKey: sources[1].scopeKey,
        bindingToken: sources[1].bindingToken
      })
    }
  )
  it.each(['self', 'actions'] as const)(
    'names the exact connection and account when confirming scene %s controls in a shared group',
    async (section) => {
      const [, extra] = sameGroupSources()
      vi.mocked(api).mockResolvedValue(
        result(extra, {
          character: {
            paused: false,
            memories: [{ id: 'm1', content: '同群记忆', kind: 'interest', createdAt: 1 }],
            goals: [{ id: 'g1', title: '同群目标', status: 'active', nextStep: '继续' }],
            receipts: []
          }
        })
      )
      const wrapper = page(RobotScene, { conversation: extra, section })
      await flushPromises()
      await wrapper
        .findAllComponents(NButton)
        .find((button) => button.text() === (section === 'self' ? '删除' : '停止目标'))!
        .trigger('click')
      const confirmation = warning.mock.calls[0]![0]
      expectExtraSource(confirmation.content)
      await confirmation.onPositiveClick()
      const mutation = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
      expect(JSON.parse(String(mutation[1]!.body))).toMatchObject({
        scopeKey: extra.scopeKey,
        bindingToken: extra.bindingToken,
        operation: section === 'self' ? 'delete-memory' : 'cancel-goal'
      })
    }
  )
})
describe('actual source-scoped person memory', () => {
  it.each(['删除此条', '清空当前来源记录'])(
    'explains an invalidated profile %s confirmation after refreshing the same source',
    async (action) => {
      vi.mocked(api).mockResolvedValue({ profiles: [profile()] })
      const wrapper = page(StandaloneProfiles)
      await flushPromises()
      await wrapper
        .findAllComponents(NButton)
        .find((button) => button.text() === action)!
        .trigger('click')
      const confirm = warning.mock.calls[0]![0].onPositiveClick
      await wrapper
        .findAllComponents(NButton)
        .find((button) => button.text() === '重新读取')!
        .trigger('click')
      await flushPromises()
      await confirm()
      expect(notice).toHaveBeenCalledWith('列表已更新，请核对当前来源后重新操作。')
      expect(
        vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
      ).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(2)
    }
  )
  it('shows actual entries and their sources, excludes foreign ownership, and deletes by exact entry ID', async () => {
    vi.mocked(api).mockResolvedValue({
      profiles: [profile(), profile(scene('bob', '19002222'), 'foreign record')]
    })
    const wrapper = page(StandaloneProfiles, { conversationScopes: [scene()] })
    await flushPromises()
    expect(wrapper.text()).toContain('喜欢天文')
    expect(wrapper.text()).toContain('source-scene')
    expect(wrapper.text()).toContain('entry-1')
    expect(wrapper.text()).not.toContain('foreign record')
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '删除此条')!
      .trigger('click')
    await flushPromises()
    expect(warning.mock.calls[0]![0].content).toContain('其他来源会话的记录不在本次删除范围内')
    await warning.mock.calls[0]![0].onPositiveClick()
    await flushPromises()
    const mutation = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(JSON.parse(String(mutation[1]!.body))).toEqual({
      userId: 'person-1',
      scopeKey: scene().scopeKey,
      bindingToken: scene().bindingToken,
      field: 'entries',
      value: 'entry-1'
    })
  })
  it('revokes displayed profile entries and pending confirmations when the exact source is removed', async () => {
    vi.mocked(api).mockResolvedValue({ profiles: [profile()] })
    const wrapper = page(StandaloneProfiles, { conversationScopes: [scene()] })
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '删除此条')!
      .trigger('click')
    await flushPromises()
    const confirm = warning.mock.calls[0]![0].onPositiveClick
    expect(wrapper.text()).toContain('喜欢天文')
    await wrapper.setProps({ conversationScopes: [] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('喜欢天文')
    await confirm()
    await flushPromises()
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(0)
  })
  it('shows 503 as a failure and sends no delete when the read is unavailable', async () => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error('人物存储暂不可用'), { status: 503 }))
    const wrapper = page(StandaloneProfiles)
    await flushPromises()
    expect(wrapper.text()).toContain('人物存储暂不可用')
    expect(wrapper.text()).not.toContain('没有人物记忆')
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(0)
  })
  it('pauses profile refresh during deletion and locks its unknown outcome', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(api).mockImplementation(async (_path, options) =>
      options?.method === 'POST'
        ? new Promise((_, fail) => (reject = fail))
        : { profiles: [profile()] }
    )
    const wrapper = page(StandaloneProfiles)
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '删除此条')!
      .trigger('click')
    const pending = warning.mock.calls[0]![0].onPositiveClick()
    await flushPromises()
    const refresh = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '重新读取')!
    expect(refresh.props('disabled')).toBe(true)
    refresh.vm.$emit('click')
    await flushPromises()
    expect(api).toHaveBeenCalledTimes(2)
    reject(new Error('lost delete response'))
    await pending
    await flushPromises()
    expect(wrapper.text()).toContain('删除结果待核对')
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('clears profile records and old confirmations when a new process is accepted', async () => {
    vi.mocked(api).mockResolvedValueOnce({ profiles: [profile()] })
    const wrapper = page(StandaloneProfiles)
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '删除此条')!
      .trigger('click')
    const confirm = warning.mock.calls[0]![0].onPositiveClick
    vi.mocked(api).mockImplementation(() => new Promise(() => {}))
    consoleRestart.process({
      processEpoch: 'p2',
      loadedRevision: 'r2',
      storedRevision: 'r2',
      phase: 'active',
      requiresRestart: false
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('喜欢天文')
    await confirm()
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(0)
    expect(api).toHaveBeenCalledTimes(2)
  })
})

function trusteeship() {
  return {
    commitments: [
      {
        ...scene(),
        groupId: '33001111',
        id: 'task-1',
        creatorId: 'person-1',
        creatorName: '用户',
        intent: '提醒',
        schedule: '一次',
        deliver: 'agent',
        nextRunAt: 0,
        expiryAt: 0,
        status: 'active',
        lastResult: '',
        retryCount: 0
      }
    ],
    delegated: [],
    failures: [],
    config: {
      maxActivePerGroup: 1,
      maxPerCreator: 1,
      defaultExpiryDays: 1,
      maxPerGroupDelegated: 1,
      maxPerOwnerDelegated: 1
    }
  }
}
describe('source-scoped trusteeship confirmation', () => {
  it.each(['取消', '删除'])(
    'explains an invalidated trusteeship %s confirmation after the automatic refresh',
    async (action) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      vi.mocked(api).mockResolvedValue({
        ...trusteeship(),
        delegated: [
          {
            ...scene(),
            groupId: scene().scopeKey,
            entries: [
              {
                id: 'note-1',
                owner: 'person-1',
                ownerName: '用户',
                content: '提醒',
                dueAt: 0,
                status: 'active',
                createdAt: 1
              }
            ]
          }
        ]
      })
      const wrapper = page(TrusteeshipPage)
      await flushPromises()
      await wrapper
        .findAllComponents(NButton)
        .find((button) => button.text() === action)!
        .trigger('click')
      const confirm = warning.mock.calls[0]![0].onPositiveClick
      await vi.advanceTimersByTimeAsync(30000)
      await flushPromises()
      await confirm()
      expect(notice).toHaveBeenCalledWith('列表已更新，请核对当前来源后重新操作。')
      expect(
        vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
      ).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(2)
    }
  )
  it('does not confirm a stale action after the source page has unmounted', async () => {
    vi.mocked(api).mockResolvedValue(trusteeship())
    const wrapper = page(TrusteeshipPage, { conversationScopes: [scene()] })
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '取消')!
      .trigger('click')
    await flushPromises()
    const confirm = warning.mock.calls[0]![0].onPositiveClick
    wrapper.unmount()
    await confirm()
    await flushPromises()
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(0)
    expect(notice).not.toHaveBeenCalled()
  })
  it.each(['removed source', 'new process'])(
    'revokes old rows and confirmation after %s',
    async (change) => {
      vi.mocked(api).mockResolvedValueOnce(trusteeship())
      const wrapper = page(TrusteeshipPage)
      await flushPromises()
      await wrapper
        .findAllComponents(NButton)
        .find((button) => button.text() === '取消')!
        .trigger('click')
      const confirm = warning.mock.calls[0]![0].onPositiveClick
      vi.mocked(api).mockImplementation(() => new Promise(() => {}))
      if (change === 'removed source') {
        const next = data()
        next.agents[0]!.conversations = []
        workspace.data.value = next
      } else
        consoleRestart.process({
          processEpoch: 'p2',
          loadedRevision: 'r2',
          storedRevision: 'r2',
          phase: 'active',
          requiresRestart: false
        })
      await flushPromises()
      expect(wrapper.text()).not.toContain('提醒')
      await confirm()
      await flushPromises()
      expect(
        vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
      ).toHaveLength(0)
      expect(api).toHaveBeenCalledTimes(2)
    }
  )
  it('pauses both timer and manual refresh during a pending cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let reject!: (cause: Error) => void
    vi.mocked(api).mockImplementation(async (_path, options) =>
      options?.method === 'POST' ? new Promise((_, fail) => (reject = fail)) : trusteeship()
    )
    const wrapper = page(TrusteeshipPage)
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '取消')!
      .trigger('click')
    const pending = warning.mock.calls[0]![0].onPositiveClick()
    await flushPromises()
    const refresh = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '重新读取')!
    expect(refresh.props('disabled')).toBe(true)
    refresh.vm.$emit('click')
    await vi.advanceTimersByTimeAsync(30000)
    expect(api).toHaveBeenCalledTimes(2)
    reject(new Error('lost cancellation response'))
    await pending
    await flushPromises()
    expect(wrapper.text()).toContain('操作结果待核对')
    const cancel = wrapper.findAllComponents(NButton).find((button) => button.text() === '取消')!
    expect(cancel.props('disabled')).toBe(true)
    await cancel.trigger('click')
    expect(
      vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')
    ).toHaveLength(1)
  })
})
