import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import SemanticPage from '../pages/SemanticPage.vue'
import { api } from './api'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('naive-ui', async () => ({
  ...(await vi.importActual<typeof import('naive-ui')>('naive-ui')),
  useMessage: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ warning: vi.fn() })
}))
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.mocked(api).mockReset() })

async function evaluation(history: unknown[], versionedHistory: unknown[]) {
  vi.mocked(api).mockImplementation(async path => path.endsWith('/stats')
    ? { enabled: true, store: { chunks: 1 }, config: {} }
    : { history, versionedHistory })
  wrapper = mount(SemanticPage)
  await flushPromises()
  await wrapper.findAll('[aria-label="语义记忆工具"] [role="tab"]').find(tab => tab.text() === '评估历史')!.trigger('click')
  return wrapper
}

describe('semantic evaluation method boundaries', () => {
  it('labels legacy values and keeps versioned results outside the old metric table', async () => {
    const view = await evaluation([{ samples: 34, recallAt5Hybrid: 0.5 }], [
      { schemaVersion: 2, runtime: 'core', dataset: { id: 'fixed-v2' }, modes: { production: { hitAt5: 0.75 } } }
    ])
    expect(view.text()).toContain('历史值不可与 Core v2')
    expect(view.find('.evaluation-table').text()).toMatch(/50(?:\.0)?%/u)
    expect(view.find('.evaluation-table').text()).not.toContain('fixed-v2')
    const modern = view.findAll('details').find(details => details.text().includes('完整版本化报告'))!
    expect(modern.text()).toContain('fixed-v2')
    expect(modern.text()).toContain('0.75')
    expect(view.find('.evaluation-table').text()).toContain('—')
  })

  it('offers a runnable offline command without starting an online evaluation', async () => {
    const view = await evaluation([], [])
    expect(view.text()).toContain('旧在线自出题评估已停用')
    expect(view.text()).toContain('固定合成后端仅验证评估流程')
    expect(view.find('pre').text()).toContain('--output /tmp/core-retrieval-v2.json')
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/eval'))).toBe(false)
  })
})
