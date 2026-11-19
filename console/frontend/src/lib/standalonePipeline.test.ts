import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import PipelinePage from '../pages/PipelinePage.vue'
import { api } from './api'
import { parsePipelineSnapshot, pipelineStatusOptions } from './standalonePipeline'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('../pages/SchemaPage.vue', () => ({ default: { template: '<div>旧版策略与授权</div>' } }))
const at = 1794900000000
function inbox() {
  const account = { platform: 'qq', namespace: 'global', id: '10001' }
  return {
    id: 'inbox-1',
    kind: 'event',
    state: 'queued',
    agentId: 'alice',
    connectionId: 'qq-primary',
    account,
    conversation: { account, kind: 'private', id: '20001' },
    scopeKey: JSON.stringify(['alice', 'qq', 'global', '10001', 'private', '20001']),
    bindingToken: 'current-binding',
    queue: 'private',
    eventKind: 'message'
  }
}
function media() {
  return {
    ...inbox(),
    id: 'media-1',
    kind: 'delivery',
    state: 'unknown',
    provider: 'bilibili',
    createdAt: at,
    updatedAt: at + 1000,
    expiresAt: at + 86400000,
    attempts: 2,
    prepareFailures: 1,
    nextRetryAt: 0,
    effects: [{ effect: 'forward', state: 'unknown', beganAt: at, finishedAt: at + 1000 }]
  }
}
function summary() {
  return {
    version: 1,
    mode: 'standalone',
    observedAt: at + 2000,
    returned: 2,
    scanTruncated: false,
    jobs: [inbox(), media()],
    retention: {
      inbox: 'until-acknowledged',
      textQueueIdleSeconds: 3600,
      mediaRecordIdleSeconds: 604800,
      mediaTaskLifetimeSeconds: 86400
    }
  }
}
describe('Core pipeline response', () => {
  it('projects metadata only and does not manufacture inbox timestamps or attempts', () => {
    const raw = summary()
    Object.assign(raw.jobs[0], { body: 'secret body', sourceUrl: 'https://secret', nativeReceipt: {} })
    const snapshot = parsePipelineSnapshot(raw), row = snapshot.jobs[0]
    expect(row).not.toHaveProperty('body')
    expect(row).not.toHaveProperty('sourceUrl')
    expect(row).not.toHaveProperty('nativeReceipt')
    expect(row).not.toHaveProperty('attempts')
    expect(row).not.toHaveProperty('occurredAt')
    expect(row).not.toHaveProperty('updatedAt')
    expect(snapshot.retention).toEqual(raw.retention)
    if (snapshot.mode !== 'standalone') throw new Error('fixture')
    expect(snapshot.jobs[1]).toMatchObject({ attempts: 2, expiresAt: at + 86400000 })
  })
  it('rejects partial or conflicting account identities and unknown mode/version', () => {
    const raw = summary()
    raw.jobs[0].conversation.account = { ...raw.jobs[0].account, namespace: 'other' }
    expect(() => parsePipelineSnapshot(raw)).toThrow('身份不一致')
    expect(() => parsePipelineSnapshot({ ...summary(), mode: 'unexpected' })).toThrow()
    expect(() => parsePipelineSnapshot({ ...summary(), version: 2 })).toThrow()
  })
  it('uses only each mode’s states while preserving the old plugin fields and retention', () => {
    expect(pipelineStatusOptions('unknown').map((row) => row.value)).toEqual(['all'])
    expect(pipelineStatusOptions('standalone').map((row) => row.value)).toContain('unknown')
    expect(pipelineStatusOptions('standalone').map((row) => row.value)).not.toContain('retry_wait')
    expect(pipelineStatusOptions('legacy').map((row) => row.value)).toContain('retry_wait')
    const old = {
      returned: 1, scanTruncated: false,
      retention: { eventMinutes: 360, deliveryHours: 24 },
      jobs: [{ kind: 'delivery', id: 'old-1', state: 'uncertain', platform: 'qq', botId: '10', groupId: '20', attempts: 3, updatedAt: at, receiptMessageId: 'receipt-1', runtimeConfirmed: false }]
    }
    expect(parsePipelineSnapshot(old)).toEqual({ ...old, mode: 'legacy', jobs: [{ ...old.jobs[0], mode: 'legacy' }] })
  })
})
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue(summary())
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})
it('loads all states first, renders complete private identity and clears stale details when filtering', async () => {
  wrapper = mount(PipelinePage, { attachTo: document.body })
  expect(api).toHaveBeenCalledWith('/api/pipeline/jobs?kind=all&status=all&limit=100', expect.anything())
  await flushPromises()
  expect(wrapper.text()).toContain('Agent alice · 连接 qq-primary')
  expect(wrapper.text()).toContain('qq / global / 10001 · 私聊 20001')
  const eventRow = wrapper.find('[data-job-id="inbox-1"]')
  expect(eventRow.text()).toContain('未记录事件时间')
  expect(eventRow.text()).not.toContain('次')
  expect(wrapper.text()).toContain('2 次准备')
  expect(wrapper.text()).toContain('7 天')
  expect(wrapper.text()).toContain('任务执行期限为创建后 1 天')
  expect(wrapper.text()).toContain('记录消失不能证明发送成功')
  expect(wrapper.text()).toContain('执行截止时间不是记录过期时间')
  expect(wrapper.text()).not.toContain('旧版策略与授权')
  await wrapper.find('[data-job-id="media-1"]').trigger('click')
  await flushPromises()
  const drawer = new DOMWrapper(document.body.querySelector('.n-drawer-content')!)
  expect(drawer.text()).toContain('2（不是发送次数）')
  expect(drawer.text()).toContain('合并转发')
  expect(drawer.text()).toContain('结果未知')
  wrapper.findAllComponents(NSelect)[1].vm.$emit('update:value', 'unknown')
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith('/api/pipeline/jobs?kind=all&status=unknown&limit=100', expect.anything())
  expect(wrapper.findComponent({ name: 'Drawer' }).props('show')).toBe(false)
})
