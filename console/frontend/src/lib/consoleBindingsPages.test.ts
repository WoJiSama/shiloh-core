import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NButton } from 'naive-ui'
import TrusteeshipPage from '../pages/TrusteeshipPage.vue'
import PersonProfilesPage from '../pages/PersonProfilesPage.vue'
import { api } from './api'

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<typeof import('naive-ui')>('naive-ui')),
  useDialog: () => ({ warning }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() })
}))
let wrapper: VueWrapper | undefined
const scopeKey = JSON.stringify(['alice', 'qq', 'global', '123456', 'group', '999999']),
  bindingToken = 'displayed-old-version'
beforeEach(() => {
  vi.mocked(api).mockReset()
  warning.mockReset()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})
const mutations = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([, options]) => options?.method === 'POST')
    .map(([path, options]) => ({ path, body: JSON.parse(String(options?.body)) }))

describe('displayed row selectors on destructive console controls', () => {
  it('sends the displayed scope and version with both commitment and delegated-memory deletion', async () => {
    const shared = {
      groupId: scopeKey,
      scopeKey,
      bindingToken,
      agentId: 'alice',
      account: { platform: 'qq', namespace: 'global', id: '123456' },
      conversation: {
        kind: 'group',
        id: '999999',
        account: { platform: 'qq', namespace: 'global', id: '123456' }
      }
    }
    const overview = {
      commitments: [
        {
          ...shared,
          id: 'task',
          creatorId: '777',
          creatorName: '用户',
          intent: '提醒我',
          schedule: 'once',
          deliver: 'agent',
          nextRunAt: 1,
          expiryAt: 2,
          status: 'active',
          lastResult: '',
          retryCount: 0
        }
      ],
      failures: [],
      delegated: [
        {
          ...shared,
          entries: [
            {
              id: 'note',
              owner: '777',
              ownerName: '用户',
              content: '记住它',
              dueAt: 0,
              status: 'active',
              createdAt: 1
            }
          ]
        }
      ],
      config: {
        maxActivePerGroup: 1,
        maxPerCreator: 1,
        defaultExpiryDays: 7,
        maxPerGroupDelegated: 1,
        maxPerOwnerDelegated: 1
      }
    }
    vi.mocked(api).mockImplementation(async (_, options) =>
      options?.method === 'POST' ? {} : overview
    )
    wrapper = mount(TrusteeshipPage)
    await flushPromises()
    expect(wrapper.text()).not.toContain(scopeKey)
    expect(wrapper.text()).toContain('999999 · alice')
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '取消')!
      .trigger('click')
    await warning.mock.calls.at(-1)![0].onPositiveClick()
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '删除')!
      .trigger('click')
    await warning.mock.calls.at(-1)![0].onPositiveClick()
    await flushPromises()
    expect(mutations()).toEqual([
      {
        path: '/api/trusteeship/commitment-cancel',
        body: { id: 'task', groupId: scopeKey, scopeKey, bindingToken }
      },
      {
        path: '/api/trusteeship/delegated-delete',
        body: { id: 'note', groupId: scopeKey, scopeKey, bindingToken }
      }
    ])
  })
  it('keeps duplicate profile user IDs separate and sends the shown row selectors for field/person removal', async () => {
    const profiles = [
      { userId: '777', name: '第一账号', interests: ['散步'], taboos: [], scopeKey, bindingToken },
      {
        userId: '777',
        name: '另一账号',
        interests: ['旅行'],
        taboos: [],
        scopeKey: 'other-scope',
        bindingToken: 'other-version'
      }
    ]
    vi.mocked(api).mockImplementation(async (_, options) =>
      options?.method === 'POST' ? {} : { profiles }
    )
    wrapper = mount(PersonProfilesPage, { attachTo: document.body })
    await flushPromises()
    await wrapper
      .findAllComponents(NButton)
      .find((button) => button.text() === '详情')!
      .trigger('click')
    await flushPromises()
    const deleteField = wrapper.findAllComponents(NButton).find((button) => button.text() === '删')
    expect(deleteField).toBeTruthy()
    await deleteField!.trigger('click')
    await flushPromises()
    const deletePerson = wrapper
      .findAllComponents(NButton)
      .find((button) => button.text().includes('删除此人'))
    expect(deletePerson).toBeTruthy()
    await deletePerson!.trigger('click')
    await warning.mock.calls.at(-1)![0].onPositiveClick()
    await flushPromises()
    expect(mutations()).toEqual([
      {
        path: '/api/person-profiles/delete-field',
        body: { userId: '777', field: 'interests', value: '散步', scopeKey, bindingToken }
      },
      { path: '/api/person-profiles/delete', body: { userId: '777', scopeKey, bindingToken } }
    ])
  })
})
