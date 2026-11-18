import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scopeKey = JSON.stringify(['alice', 'qq', 'global', '123456', 'group', '999999'])
const item = {
  scopeKey,
  bindingToken: 'latest-version',
  binding: {
    source: 'configured',
    id: 'bound',
    revision: 'two',
    agentId: 'alice',
    personaId: 'default',
    connectionId: 'qq-main',
    target: {
      account: { platform: 'qq', namespace: 'global', id: '123456' },
      kind: 'group',
      id: '999999'
    }
  }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', { getItem: () => null })
})
afterEach(() => vi.unstubAllGlobals())

describe('conversation binding API integration', () => {
  it('sends automatic selectors on existing simulation requests with their JSON content type intact', async () => {
    const fetcher = vi.fn(async (path, options?: RequestInit) =>
      path === '/api/bindings' ? response({ bindings: [item] }) : response({ message: 'done' })
    )
    vi.stubGlobal('fetch', fetcher)
    const { api } = await import('./api')
    await api('/api/simulation/group', {
      method: 'POST',
      body: JSON.stringify({ group: scopeKey, action: 'pause' }),
      headers: { 'x-test': 'kept' }
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [path, request] = fetcher.mock.calls[1]
    expect(path).toBe('/api/simulation/group')
    expect(JSON.parse(String(request?.body))).toEqual({
      group: scopeKey,
      action: 'pause',
      scopeKey,
      bindingToken: 'latest-version'
    })
    expect((request?.headers as Headers).get('content-type')).toBe('application/json')
    expect((request?.headers as Headers).get('x-test')).toBe('kept')
  })
  it('returns a 409 without a destructive request when a profile has no exact binding', async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) =>
      response({ bindings: [item] })
    )
    vi.stubGlobal('fetch', fetcher)
    const { api, ApiError } = await import('./api')
    const operation = api('/api/person-profiles/delete', {
      method: 'POST',
      body: '{"userId":"777"}'
    })
    await expect(operation).rejects.toBeInstanceOf(ApiError)
    await expect(operation).rejects.toMatchObject({ status: 409, details: { code: 'conflict' } })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/bindings')
  })
  it('preserves a row token and lets the independent server reject a stale binding', async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) =>
      path === '/api/bindings'
        ? response({ bindings: [item] })
        : response({ error: 'conflict' }, 409)
    )
    vi.stubGlobal('fetch', fetcher)
    const { api } = await import('./api')
    await expect(
      api('/api/trusteeship/commitment-cancel', {
        method: 'POST',
        body: JSON.stringify({ scopeKey, bindingToken: 'old-row-version', id: 'task' })
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).bindingToken).toBe(
      'old-row-version'
    )
  })
  it('keeps legacy routes unchanged only after a 404 binding directory', async () => {
    const fetcher = vi.fn(async (path: string, options?: RequestInit) =>
      path === '/api/bindings' ? response({ error: 'not_found' }, 404) : response({ ok: true })
    )
    vi.stubGlobal('fetch', fetcher)
    const { api } = await import('./api'),
      options = { method: 'POST', body: '{"id":"legacy-task"}' }
    await api('/api/trusteeship/commitment-cancel', options)
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(options.body)
    await api('/api/person-profiles/delete', { method: 'POST', body: '{"userId":"777"}' })
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/bindings',
      '/api/trusteeship/commitment-cancel',
      '/api/person-profiles/delete'
    ])
  })
  it('propagates independent 401/503 failures and sends no fallback mutation', async () => {
    const unauthorized = vi.fn()
    window.addEventListener('console:unauthorized', unauthorized)
    try {
      for (const status of [401, 503]) {
        vi.resetModules()
        const fetcher = vi.fn(async () => response({ error: 'unavailable' }, status))
        vi.stubGlobal('fetch', fetcher)
        const { api } = await import('./api')
        await expect(
          api('/api/simulation/group', { method: 'POST', body: '{"group":"999999"}' })
        ).rejects.toMatchObject({ status })
        expect(fetcher).toHaveBeenCalledOnce()
      }
      expect(unauthorized).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('console:unauthorized', unauthorized)
    }
  })
  it('passes cancellation through the directory request and never starts the selected mutation after abort', async () => {
    const controller = new AbortController(),
      fetcher = vi.fn(async (path, options?: RequestInit) => {
        expect(options?.signal).toBe(controller.signal)
        controller.abort()
        return response({ bindings: [item] })
      })
    vi.stubGlobal('fetch', fetcher)
    const { api } = await import('./api')
    await expect(
      api('/api/person-profiles/delete', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ scopeKey, userId: '777' })
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
