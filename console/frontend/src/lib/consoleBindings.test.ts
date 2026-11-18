import { describe, expect, it, vi } from 'vitest'
import { createConsoleBindings } from './consoleBindings'

const binding = (accountId = '123456', revision = 'one', agentId = 'alice') => ({
  source: 'configured',
  id: 'binding',
  revision,
  agentId,
  personaId: 'default',
  connectionId: `qq-${accountId}`,
  target: {
    account: { platform: 'qq', namespace: 'global', id: accountId },
    kind: 'group',
    id: '999999'
  }
})
const entry = (accountId = '123456', revision = 'one', agentId = 'alice') => {
  const selected = binding(accountId, revision, agentId)
  return {
    scopeKey: JSON.stringify([agentId, 'qq', 'global', accountId, 'group', '999999']),
    bindingToken: `token-${accountId}-${revision}-${agentId}`,
    binding: selected
  }
}
const body = (fields: Record<string, unknown>) => ({ method: 'POST', body: JSON.stringify(fields) })
const parsed = (request: { options: RequestInit }) => JSON.parse(String(request.options.body))

describe('complete console conversation selectors', () => {
  it('uses only an exact complete scope and never guesses a bare group, even for one binding', async () => {
    const item = entry(),
      load = vi.fn(async () => ({ bindings: [item] })),
      client = createConsoleBindings(load)
    for (const fields of [{ group: '999999' }, {}, { userId: '777' }])
      await expect(client.prepare('/api/simulation/group', body(fields))).rejects.toMatchObject({
        status: 409
      })
    const selected = await client.prepare(
      '/api/simulation/group',
      body({ group: item.scopeKey, action: 'enable' })
    )
    expect(parsed(selected)).toEqual({
      group: item.scopeKey,
      action: 'enable',
      scopeKey: item.scopeKey,
      bindingToken: item.bindingToken
    })
    const withRaw = await client.prepare(
      '/api/style/block-word',
      body({ scopeKey: item.scopeKey, group: '999999', word: '测试' })
    )
    expect(parsed(withRaw).bindingToken).toBe(item.bindingToken)
    await expect(
      client.prepare(
        '/api/style/block-word',
        body({ scopeKey: item.scopeKey, group: '888888', word: '测试' })
      )
    ).rejects.toMatchObject({ status: 409 })
  })
  it('keeps identical platform group IDs on different accounts and agents distinct', async () => {
    const [one, two, three] = [entry(), entry('222222'), entry('123456', 'one', 'bob')]
    const client = createConsoleBindings(async () => ({ bindings: [one, two, three] }))
    for (const item of [one, two, three]) {
      const selected = await client.prepare(
        '/api/trusteeship/delegated-delete',
        body({ scopeKey: item.scopeKey, id: 'same-id' })
      )
      expect(parsed(selected)).toMatchObject({
        scopeKey: item.scopeKey,
        bindingToken: item.bindingToken,
        id: 'same-id'
      })
    }
    await expect(
      client.prepare(
        '/api/trusteeship/commitment-cancel',
        body({ id: 'same-id', groupId: '999999' })
      )
    ).rejects.toMatchObject({ status: 409 })
  })
  it('adds query selectors to scoped reads and JSON selectors to scoped writes only', async () => {
    const item = entry(),
      client = createConsoleBindings(async () => ({ bindings: [item] }))
    const read = await client.prepare(
      `/api/simulation/group?group=${encodeURIComponent(item.scopeKey)}`
    )
    const query = new URL(read.path, 'http://localhost').searchParams
    expect(query.get('scopeKey')).toBe(item.scopeKey)
    expect(query.get('bindingToken')).toBe(item.bindingToken)
    const admin = await client.prepare(`/api/groups/${encodeURIComponent(item.scopeKey)}/admin`, {
      method: 'PUT',
      body: '{"baseRevision":"draft-1"}'
    })
    expect(parsed(admin)).toMatchObject({
      baseRevision: 'draft-1',
      scopeKey: item.scopeKey,
      bindingToken: item.bindingToken
    })
    for (const [path, options] of [
      ['/api/config/general', { method: 'PUT', body: '{}' }],
      ['/api/simulation/budget-default', body({ cny: 5 })],
      ['/api/person-profiles', {}]
    ] as const) {
      const result = await client.prepare(path, options)
      expect(result).toEqual({ path, options })
    }
  })
  it('preserves explicitly displayed old binding tokens and rejects duplicate/conflicting selectors', async () => {
    const latest = entry('123456', 'new'),
      client = createConsoleBindings(async () => ({ bindings: [latest] }))
    const selected = await client.prepare(
      '/api/person-profiles/delete',
      body({ scopeKey: latest.scopeKey, bindingToken: 'old-displayed-token', userId: '777' })
    )
    expect(parsed(selected).bindingToken).toBe('old-displayed-token')
    const query = `?scopeKey=${encodeURIComponent(latest.scopeKey)}&bindingToken=old-displayed-token`
    const moved = await client.prepare(
      '/api/trusteeship/commitment-cancel' + query,
      body({ id: 'task' })
    )
    expect(moved.path).toBe('/api/trusteeship/commitment-cancel')
    expect(parsed(moved).bindingToken).toBe('old-displayed-token')
    for (const [path, options] of [
      [
        '/api/person-profiles/delete' + query,
        body({ scopeKey: latest.scopeKey, bindingToken: 'new-token' })
      ],
      [
        `/api/simulation/group?scopeKey=${encodeURIComponent(latest.scopeKey)}&scopeKey=${encodeURIComponent(latest.scopeKey)}`,
        {}
      ],
      ['/api/person-profiles/delete', body({ scopeKey: latest.scopeKey, bindingToken: null })],
      ['/api/person-profiles/delete', { method: 'POST', body: '[]' }]
    ] as const)
      await expect(client.prepare(path, options)).rejects.toMatchObject({ status: 409 })
  })
  it('pins shown detail versions across new directory/list responses and refreshes only when detail is reread', async () => {
    let item = entry(),
      client = createConsoleBindings(async () => ({ bindings: [item] }))
    await client.prepare('/api/simulation/overview')
    client.observe(
      '/api/simulation/overview',
      {},
      {
        groups: [
          { groupId: item.scopeKey, scopeKey: item.scopeKey, bindingToken: item.bindingToken }
        ]
      }
    )
    const path = `/api/simulation/group?group=${encodeURIComponent(item.scopeKey)}`
    await client.prepare(path)
    client.observe(
      path,
      {},
      { groupId: item.scopeKey, scopeKey: item.scopeKey, bindingToken: item.bindingToken }
    )
    const old = item.bindingToken
    item = entry('123456', 'new')
    await client.prepare('/api/simulation/overview')
    client.observe(
      '/api/simulation/overview',
      {},
      {
        groups: [
          { groupId: item.scopeKey, scopeKey: item.scopeKey, bindingToken: item.bindingToken }
        ]
      }
    )
    expect(
      parsed(
        await client.prepare(
          '/api/simulation/group',
          body({ group: item.scopeKey, action: 'reset' })
        )
      ).bindingToken
    ).toBe(old)
    const reread = await client.prepare(path)
    expect(new URL(reread.path, 'http://localhost').searchParams.get('bindingToken')).toBe(
      item.bindingToken
    )
    client.observe(
      path,
      {},
      { groupId: item.scopeKey, scopeKey: item.scopeKey, bindingToken: item.bindingToken }
    )
    expect(
      parsed(
        await client.prepare(
          '/api/simulation/group',
          body({ group: item.scopeKey, action: 'reset' })
        )
      ).bindingToken
    ).toBe(item.bindingToken)
  })
  it('captures a displayed version before asynchronous directory/background reads can change pins', async () => {
    let item = entry(),
      resolve: ((payload: unknown) => void) | undefined
    let block = false
    const client = createConsoleBindings(() =>
      block
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({ bindings: [item] })
    )
    await client.prepare('/api/simulation/overview')
    client.observe(
      '/api/simulation/overview',
      {},
      { groups: [{ scopeKey: item.scopeKey, bindingToken: item.bindingToken }] }
    )
    const old = item.bindingToken
    block = true
    const pending = client.prepare(
      '/api/simulation/group',
      body({ group: item.scopeKey, action: 'disable' })
    )
    item = entry('123456', 'new')
    client.observe(
      '/api/simulation/overview',
      {},
      { groups: [{ scopeKey: item.scopeKey, bindingToken: item.bindingToken }] }
    )
    resolve!({ bindings: [item] })
    expect(parsed(await pending).bindingToken).toBe(old)
  })
  it('refreshes group-admin drafts only after a successful read with its checked binding token', async () => {
    let item = entry(),
      client = createConsoleBindings(async () => ({ bindings: [item] }))
    const path = `/api/groups/${encodeURIComponent(item.scopeKey)}/admin`
    const oldRead = await client.prepare(path)
    client.observe(oldRead.path, oldRead.options, { groups: [] })
    const old = item.bindingToken
    item = entry('123456', 'new')
    expect(parsed(await client.prepare(path, { method: 'PUT', body: '{}' })).bindingToken).toBe(old)
    const newRead = await client.prepare(path)
    client.observe(newRead.path, newRead.options, { groups: [] })
    expect(parsed(await client.prepare(path, { method: 'PUT', body: '{}' })).bindingToken).toBe(
      item.bindingToken
    )
  })
  it('falls back only on a first directory 404 and never downgrades a known standalone server', async () => {
    const load = vi.fn(async () => {
        throw { status: 404 }
      }),
      legacy = createConsoleBindings(load),
      options = body({ id: 'task' })
    expect(await legacy.prepare('/api/trusteeship/commitment-cancel', options)).toEqual({
      path: '/api/trusteeship/commitment-cancel',
      options
    })
    await legacy.prepare('/api/person-profiles/delete', body({ userId: '777' }))
    expect(load).toHaveBeenCalledOnce()
    const item = entry(),
      dynamic = vi
        .fn()
        .mockResolvedValueOnce({ bindings: [item] })
        .mockRejectedValueOnce({ status: 404 }),
      standalone = createConsoleBindings(dynamic)
    await standalone.prepare('/api/simulation/overview')
    await expect(
      standalone.prepare(
        '/api/person-profiles/delete',
        body({ scopeKey: item.scopeKey, userId: '777' })
      )
    ).rejects.toMatchObject({ status: 404 })
  })
  it('does not fallback on authorization, service, network or malformed directory failures', async () => {
    for (const error of [{ status: 401 }, { status: 503 }, new Error('offline')]) {
      const client = createConsoleBindings(async () => {
        throw error
      })
      await expect(client.prepare('/api/simulation/group', body({ group: '999999' }))).rejects.toBe(
        error
      )
    }
    for (const payload of [
      {},
      { bindings: [entry(), entry()] },
      { bindings: [{ ...entry(), scopeKey: '999999' }] },
      { bindings: [{ ...entry(), binding: { ...binding(), revision: undefined } }] }
    ]) {
      const client = createConsoleBindings(async () => payload)
      await expect(
        client.prepare('/api/simulation/group', body({ group: '999999' }))
      ).rejects.toMatchObject({ status: 503 })
    }
  })
  it('rejects a removed complete scope and never selects an available replacement account or agent', async () => {
    let items = [entry()],
      client = createConsoleBindings(async () => ({ bindings: items })),
      old = items[0]
    await client.prepare('/api/simulation/overview')
    items = [entry('222222'), entry('123456', 'new', 'bob')]
    await expect(
      client.prepare('/api/simulation/group', body({ group: old.scopeKey, action: 'enable' }))
    ).rejects.toMatchObject({ status: 409 })
  })
})
