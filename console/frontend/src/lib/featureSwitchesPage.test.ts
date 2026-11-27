import { flushPromises, mount } from '@vue/test-utils'
import { NButton, NSelect } from 'naive-ui'
import { afterEach, expect, it, vi } from 'vitest'
import FeatureSwitchesPage from '../pages/FeatureSwitchesPage.vue'
import SaveBar from '../components/SaveBar.vue'
import { api } from './api'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./workspace', () => ({ capability: () => ({ status: 'available' }) }))

const endpoint = '/api/config/feature-switches'
const view = {
  revision: 'switches-r1',
  policy: { default: 'all', features: {}, tools: { mcp_example: { mode: 'off' } } },
  items: [
    { kind: 'features', name: 'mediaRelay', label: '自动视频与媒体搬运' },
    { kind: 'tools', name: 'mcp_example', label: 'mcp_example' }
  ],
  groups: ['318001', '318002']
}
let mounted: ReturnType<typeof mount> | undefined
afterEach(() => {
  mounted?.unmount()
  vi.mocked(api).mockReset()
})

it('saves a selected group for automatic relay alongside the existing tool rule', async () => {
  const policy = {
    ...view.policy,
    features: { mediaRelay: { mode: 'groups', groups: ['318002'] } }
  }
  vi.mocked(api)
    .mockResolvedValueOnce(view)
    .mockResolvedValueOnce({
      changed: 1,
      requiresRestart: true,
      view: { ...view, policy }
    })
  const wrapper = mount(FeatureSwitchesPage)
  mounted = wrapper
  await flushPromises()
  const relay = wrapper.get('.switch-row')
  relay.getComponent(NSelect).vm.$emit('update:value', 'groups')
  await wrapper.vm.$nextTick()
  const groupSelect = relay.findAllComponents(NSelect)[1]!
  expect(groupSelect.props('options')).toEqual(view.groups.map((id) => ({ value: id, label: id })))
  groupSelect.vm.$emit('update:value', ['318002'])
  await wrapper.vm.$nextTick()
  wrapper.getComponent(SaveBar).vm.$emit('save')
  await flushPromises()

  expect(api).toHaveBeenLastCalledWith(
    endpoint,
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ revision: view.revision, values: policy })
    })
  )
  expect(wrapper.text()).toContain('已保存，重启服务后生效')
})

it('allows resetting every tool and feature to the same global default', async () => {
  const policy = { default: 'off', features: {}, tools: {} }
  vi.mocked(api)
    .mockResolvedValueOnce(view)
    .mockResolvedValueOnce({ requiresRestart: true, view: { ...view, policy } })
  const wrapper = mount(FeatureSwitchesPage)
  mounted = wrapper
  await flushPromises()
  await wrapper
    .findAllComponents(NButton)
    .find((button) => button.text() === '全部关闭')!
    .trigger('click')
  expect(wrapper.text()).toContain('全局默认关闭')
  wrapper.getComponent(SaveBar).vm.$emit('save')
  await flushPromises()

  expect(api).toHaveBeenLastCalledWith(
    endpoint,
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ revision: view.revision, values: policy })
    })
  )
})
