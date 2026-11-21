import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton, NInput, NSelect, NTabs } from 'naive-ui'
import SchemaPage from '../pages/SchemaPage.vue'
import App from '../App.vue'
import AiPage from '../pages/AiPage.vue'
import PersonaPage from '../pages/PersonaPage.vue'
import SchemaField from '../components/SchemaField.vue'
import SaveBar from '../components/SaveBar.vue'
import { api } from './api'
import { consoleRestart } from './consoleRestart'
import { createWorkspaceStore, workspace } from './workspace'
import { clone, type SchemaView } from './schemaState'

vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<typeof import('naive-ui')>('naive-ui')),
  useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() })
}))
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const workspaceView = (processEpoch = 'p1') => ({
  mode: 'standalone',
  version: 1,
  observedAt: 1,
  revision: 'r1',
  agents: [],
  connections: [],
  capabilities: [],
  cognition: { status: 'planned' },
  configState: {
    processEpoch,
    loadedRevision: 'r1',
    storedRevision: 'r1',
    requiresRestart: false,
    phase: 'active'
  }
})
const common = { mode: 'standalone' as const, processEpoch: 'p1', configRevision: 'r1' }
const schema: SchemaView = {
  ...common,
  key: 'dice',
  title: '骰子',
  revision: 'dice-r1',
  groups: [
    {
      label: '掷骰设置',
      fields: [
        { field: 'dice.enabled', label: '启用骰子', component: 'Switch', value: false },
        { field: 'dice.maxRounds', label: '最大轮数', component: 'InputNumber', value: 3 }
      ]
    }
  ]
}
const library = {
  ...common,
  revision: 'library-r1',
  defaultPersona: { name: '默认' },
  personas: [{ id: 'alice', name: 'Alice', identity: 'old' }]
}
const ai = {
  ...common,
  definitions: [{ configKey: 'model', title: '对话模型' }],
  sections: {
    model: [
      {
        baseUrl: 'https://model.example/v1',
        name: 'old-model',
        apiKeyEnv: 'MODEL_KEY',
        apiKeyConfigured: true
      }
    ]
  },
  revisions: { model: 'model-r1' }
}
const assignments = {
  ...common,
  revision: 'bindings-r1',
  personas: [
    { id: 'default', name: '默认' },
    { id: 'alice', name: 'Alice' }
  ],
  agents: [
    {
      agentId: 'agent-a',
      personaId: 'default',
      targets: [
        {
          connectionId: 'qq-main',
          scopeKey: 'full-scope',
          bindingToken: 'binding-r1',
          target: {
            account: { platform: 'qq', namespace: 'global', id: '123456' },
            kind: 'group',
            id: '999999'
          }
        }
      ]
    }
  ]
}
const commit = (view: unknown, requiresRestart = true) => ({
  changed: requiresRestart ? 1 : 0,
  requiresRestart,
  committedRevision: 'r2',
  processEpoch: 'p1',
  view
})
const mounted: VueWrapper[] = []
beforeEach(() => {
  workspace.reset()
  Object.assign(consoleRestart.state, {
    standalone: false,
    phase: 'active',
    processEpoch: '',
    committedRevision: '',
    generation: 0,
    reloadGeneration: 0
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
const page = (component: any, props = {}) => {
  const wrapper = mount(component, {
    props,
    attachTo: document.body,
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } }
  })
  mounted.push(wrapper)
  return wrapper
}
describe('standalone persistence page requests', () => {
  it('rechecks the generation at the workspace acceptance point after the loader settles', async () => {
    let finish!: (value: unknown) => void
    consoleRestart.process(workspaceView('p1').configState)
    const accepted = vi.fn((value) => consoleRestart.process(value.configState))
    const store = createWorkspaceStore(
      () => new Promise((resolve) => (finish = resolve)),
      accepted,
      () => consoleRestart.state.generation
    )
    const pending = store.load()
    finish(workspaceView('p1'))
    consoleRestart.process(workspaceView('p2').configState)
    consoleRestart.failed(consoleRestart.begin(), new Error('lost save response'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(accepted).not.toHaveBeenCalled()
    expect(store.data.value).toBeNull()
    expect(consoleRestart.state.processEpoch).toBe('p2')
    expect(consoleRestart.state.phase).toBe('uncertain')
  })
  it('rejects a sole old workspace read when a new epoch and unknown save have already been accepted', async () => {
    let finishOld!: (value: Response) => void
    consoleRestart.process(workspaceView('p1').configState)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options?: RequestInit): Promise<Response> => {
        if (path === '/api/workspace') return new Promise((resolve) => (finishOld = resolve))
        if (path === '/api/config-state') return response(workspaceView('p2').configState)
        if (path === '/api/config/dice' && options?.method === 'PUT')
          throw new TypeError('lost save response')
        throw new Error('unexpected request: ' + path)
      })
    )
    const oldRead = workspace.load()
    const rejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    await api('/api/config-state')
    await expect(api('/api/config/dice', { method: 'PUT', body: '{}' })).rejects.toThrow(
      'lost save response'
    )
    finishOld(response(workspaceView('p1')))
    await rejected
    expect(consoleRestart.state.processEpoch).toBe('p2')
    expect(consoleRestart.state.phase).toBe('uncertain')
    await expect(api('/api/config/dice', { method: 'PUT', body: '{}' })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
  it('ignores an out-of-order workspace and old config-state after an unknown save in a newer process', async () => {
    let oldWorkspace!: (value: Response) => void,
      newWorkspace!: (value: Response) => void,
      oldState!: (value: Response) => void
    let reads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options?: RequestInit): Promise<Response> => {
        if (path === '/api/workspace')
          return new Promise((resolve) => {
            if (++reads === 1) oldWorkspace = resolve
            else newWorkspace = resolve
          })
        if (path === '/api/config-state') return new Promise((resolve) => (oldState = resolve))
        if (path === '/api/config/dice' && options?.method === 'PUT')
          throw new TypeError('lost save response')
        throw new Error('unexpected request: ' + path)
      })
    )
    const earlier = workspace.load(),
      later = workspace.load()
    await flushPromises()
    newWorkspace(response(workspaceView('p2')))
    await later
    expect(consoleRestart.state.processEpoch).toBe('p2')
    const lateState = api('/api/config-state')
    const stateRejection = expect(lateState).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    await expect(api('/api/config/dice', { method: 'PUT', body: '{}' })).rejects.toThrow(
      'lost save response'
    )
    expect(consoleRestart.state.phase).toBe('uncertain')
    oldWorkspace(response(workspaceView('p1')))
    oldState(response(workspaceView('p1').configState))
    await earlier
    await stateRejection
    expect(workspace.data.value!.configState.processEpoch).toBe('p2')
    expect(consoleRestart.state.processEpoch).toBe('p2')
    expect(consoleRestart.state.phase).toBe('uncertain')
    await expect(api('/api/config/dice', { method: 'PUT', body: '{}' })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
  it('probes status before showing the shell and freezes a retired process after page reload', async () => {
    const fetcher = vi.fn(async (path: string) =>
      response(
        path === '/api/auth/state'
          ? { username: 'admin', tokenWorks: false, hasUser: true }
          : {
              mode: 'standalone',
              version: 1,
              observedAt: 1,
              revision: 'r2',
              agents: [],
              connections: [],
              capabilities: [],
              cognition: { status: 'planned' },
              configState: {
                processEpoch: 'p1',
                loadedRevision: 'r1',
                storedRevision: 'r2',
                requiresRestart: true,
                phase: 'restart-required'
              }
            }
      )
    )
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(App, { global: { stubs: { AppShell: true, AuthPage: true } } })
    mounted.push(wrapper)
    await flushPromises()
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/auth/state', '/api/workspace'])
    expect(consoleRestart.state.phase).toBe('restart-required')
    expect(wrapper.text()).toContain('等待重启')
    expect(wrapper.find('app-shell-stub').attributes()).not.toHaveProperty('inert')
    await expect(api('/api/config/dice', { method: 'PUT', body: '{}' })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
  it('keeps the legacy shell usable when the status endpoint returns 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path === '/api/auth/state'
          ? response({ username: 'admin', tokenWorks: false, hasUser: true })
          : response({ error: 'not_found' }, 404)
      )
    )
    const wrapper = mount(App, { global: { stubs: { AppShell: true, AuthPage: true } } })
    mounted.push(wrapper)
    await flushPromises()
    expect(consoleRestart.state.standalone).toBe(false)
    expect(consoleRestart.blocked.value).toBe(false)
    expect(wrapper.find('app-shell-stub').attributes()).not.toHaveProperty('inert')
  })
  it('freezes configuration reads rejected by a retired standalone epoch', async () => {
    consoleRestart.process({
      processEpoch: 'p1',
      loadedRevision: 'r1',
      storedRevision: 'r1',
      requiresRestart: false,
      phase: 'active'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: 'conflict' }, 409))
    )
    await expect(api('/api/config/dice')).rejects.toMatchObject({ status: 409 })
    expect(consoleRestart.state.phase).toBe('restart-required')
  })
  it('uses the committed schema view, freezes globally and discards a late old read without another GET', async () => {
    let finishSave!: (value: Response) => void, finishRead!: (value: Response) => void
    const fetcher = vi.fn(async (path: string, options?: RequestInit): Promise<Response> => {
      if (path === '/api/config/dice' && options?.method === 'PUT')
        return new Promise((resolve) => {
          finishSave = resolve
        })
      if (path === '/api/config/persona')
        return new Promise((resolve) => {
          finishRead = resolve
        })
      return response(schema)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(SchemaPage, { kind: 'dice' })
    await flushPromises()
    const oldRead = api('/api/config/persona')
    const readRejected = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' })
    wrapper.findAllComponents(SchemaField)[0].vm.$emit('update:modelValue', true)
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(consoleRestart.state.phase).toBe('saving')
    await expect(api('/api/person-profiles/delete', { method: 'POST' })).rejects.toMatchObject({
      name: 'AbortError'
    })
    const next = clone(schema)
    next.revision = 'dice-r2'
    next.groups[0].fields[0].value = true
    finishSave(response(commit(next)))
    await flushPromises()
    expect(consoleRestart.state.phase).toBe('restart-required')
    expect(wrapper.findComponent(SaveBar).props('dirty')).toBe(0)
    expect(wrapper.findComponent(SaveBar).props('disabled')).toBe(true)
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/config/dice')).toHaveLength(2)
    finishRead(response({ ...schema, key: 'persona' }))
    await readRejected
  })
  it('keeps a draft and blocks retries after an unknown committed outcome', async () => {
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) =>
      options?.method === 'PUT'
        ? response({ error: 'commit_outcome_unknown' }, 500)
        : response(schema)
    )
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(SchemaPage, { kind: 'dice' })
    await flushPromises()
    wrapper.findAllComponents(SchemaField)[0].vm.$emit('update:modelValue', true)
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(consoleRestart.state.phase).toBe('uncertain')
    expect(wrapper.findComponent(SaveBar).props('dirty')).toBe(1)
    expect(wrapper.text()).toContain('保存结果待核对')
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('renders a single environment-reference model and sends no raw key or legacy provider fields', async () => {
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const next = clone(ai)
        next.sections.model[0].name = 'new-model'
        return response(commit(next))
      }
      return response(ai)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(AiPage)
    await flushPromises()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('优先级')
    expect(wrapper.text()).not.toContain('测试当前草稿')
    const name = wrapper
      .findAllComponents(NInput)
      .find((input) => input.attributes('id') === 'standalone-model-name')!
    name.vm.$emit('update:value', 'new-model')
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      configKey: 'model',
      providers: [
        { baseUrl: 'https://model.example/v1', name: 'new-model', apiKeyEnv: 'MODEL_KEY' }
      ],
      revision: 'model-r1'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('重启服务后生效')
  })
  it('preserves another model slot draft and reloads only after a true new process', async () => {
    const initial = clone(ai)
    initial.definitions.push({ configKey: 'vision', title: '视觉模型' })
    Object.assign(initial.sections, {
      vision: [{ ...initial.sections.model[0], name: 'vision-old' }]
    })
    Object.assign(initial.revisions, { vision: 'vision-r1' })
    const after = clone(initial)
    after.sections.model[0].name = 'model-saved'
    let stateEpoch = 'p1',
      reads = 0
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/config-state')
        return response({
          processEpoch: stateEpoch,
          loadedRevision: 'r2',
          storedRevision: 'r2',
          requiresRestart: false,
          phase: 'active'
        })
      if (options?.method === 'PUT') return response(commit(after))
      reads++
      return response(
        reads === 1 ? initial : { ...after, processEpoch: 'p2', configRevision: 'r2' }
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(AiPage)
    await flushPromises()
    const tabs = wrapper.findComponent(NTabs)
    tabs.vm.$emit('update:value', 'vision')
    await flushPromises()
    const modelInput = () =>
      wrapper
        .findAllComponents(NInput)
        .find((input) => input.attributes('id') === 'standalone-model-name')!
    modelInput().vm.$emit('update:value', 'vision-draft')
    tabs.vm.$emit('update:value', 'model')
    await flushPromises()
    modelInput().vm.$emit('update:value', 'model-saved')
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(reads).toBe(1)
    await api('/api/config-state')
    await flushPromises()
    expect(reads).toBe(1)
    expect(consoleRestart.blocked.value).toBe(true)
    stateEpoch = 'p2'
    await api('/api/config-state')
    await flushPromises()
    expect(reads).toBe(2)
    expect(consoleRestart.blocked.value).toBe(false)
    tabs.vm.$emit('update:value', 'vision')
    await flushPromises()
    expect(modelInput().props('value')).toBe('vision-draft')
    expect(wrapper.findComponent(SaveBar).props('dirty')).toBe(1)
  })
  it.each([false, true])('shows the effective development model and saves its routing choice (configured=%s)', async configured => {
    const model = ai.sections.model[0]
    const initial = {
      ...ai,
      definitions: [...ai.definitions, { configKey: 'developmentModel', title: '开发', fallbackConfigKey: 'model' }],
      sections: { ...ai.sections, developmentModel: configured ? [{ ...model, name: 'code-model' }] : [] },
      revisions: { ...ai.revisions, developmentModel: 'dev-r1' },
    }
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) =>
      options?.method === 'PUT' ? response(commit(initial)) : response(initial)
    )
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(AiPage)
    await flushPromises()
    wrapper.findComponent(NTabs).vm.$emit('update:value', 'developmentModel')
    await flushPromises()
    expect(wrapper.text()).toContain(configured ? 'code-model' : 'old-model')
    const action = configured ? '改用主对话' : '配置开发模型'
    await wrapper.findAllComponents(NButton).find(button => button.text() === action)!.trigger('click')
    if (!configured) {
      const field = wrapper.findAllComponents(NInput).find(input => input.attributes('id') === 'standalone-model-name')!
      expect(field.props('value')).toBe('old-model')
      field.vm.$emit('update:value', 'code-model')
    }
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    const save = fetcher.mock.calls.find(([path, options]) => path === '/api/ai/config' && options?.method === 'PUT')
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({
      configKey: 'developmentModel', revision: 'dev-r1',
      providers: configured ? [] : [{ baseUrl: model.baseUrl, apiKeyEnv: model.apiKeyEnv, name: 'code-model' }],
    })
  })
  it('saves templates alone without legacy accounts or binding payloads', async () => {
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const next = clone(library)
        next.personas[0].name = 'Alice II'
        delete (next.personas[0] as Record<string, unknown>).identity
        return response(commit(next))
      }
      return response(library)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(PersonaPage)
    await flushPromises()
    expect(fetcher).toHaveBeenCalledOnce()
    const name = wrapper
      .findAllComponents(NInput)
      .find((input) => input.attributes('id') === 'template-name')!
    name.vm.$emit('update:value', 'Alice II')
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '恢复继承')!
      .trigger('click')
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      revision: 'library-r1',
      personas: [{ id: 'alice', name: 'Alice II' }]
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('shows complete target ownership and saves only explicit existing agent assignments', async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        const next = clone(assignments)
        next.agents[0].personaId = 'alice'
        return response(commit(next))
      }
      return response(path === '/api/persona/assignments' ? assignments : library)
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = page(PersonaPage)
    await flushPromises()
    wrapper.findComponent(NTabs).vm.$emit('update:value', 'assignments')
    await flushPromises()
    expect(wrapper.text()).toContain('qq/global/123456')
    expect(wrapper.text()).toContain('group · 999999')
    const selector = wrapper
      .findAllComponents(NSelect)
      .find((item) => item.attributes('aria-label') === '机器人 人设')!
    selector.vm.$emit('update:value', 'alice')
    await flushPromises()
    wrapper.findComponent(SaveBar).vm.$emit('save')
    await flushPromises()
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      revision: 'bindings-r1',
      agents: [{ agentId: 'agent-a', personaId: 'alice' }]
    })
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/persona/library',
      '/api/persona/assignments',
      '/api/persona/assignments'
    ])
  })
})
