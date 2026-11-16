import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRepositoryTools } from '../dist/backend/modules/tools/infrastructure/agentRepositoryTools.js'

const token = 'ghp_private-fixture-token-123456'
const otherSecret = 'onebot-private-fixture-token-654321'
const repoUrl = 'https://github.com/example/project'
const apiUrl = 'https://api.github.com/repos/example/project'
const PRIVATE = 'provider-private-detail-never-disclose'
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const base = (overrides = {}) => ({ full_name: 'example/project', name: 'project', private: false, visibility: 'public',
  description: '公开项目的原始说明', html_url: repoUrl, default_branch: 'main', stargazers_count: 23,
  forks_count: 4, subscribers_count: 8, open_issues_count: 6, language: 'TypeScript', archived: false,
  created_at: '2024-01-02T03:04:05Z', updated_at: '2026-11-15T03:04:05Z', license: { name: 'MIT' }, ...overrides,
})
const commits = () => [{ sha: 'abcdef1234567890', html_url: `${repoUrl}/commit/abcdef1234567890`,
  commit: { message: '修复公开缺陷\n不应当作另一条提交', author: { name: '公开作者', date: '2026-11-15T02:30:00Z' } },
}]
const branches = () => [{ name: 'main' }, { name: 'develop' }]
const contributors = () => [{ login: 'public-contributor', contributions: 17, html_url: 'https://github.com/public-contributor' }]
function context(overrides = {}) {
  return { binding: { source: 'configured', id: 'private-binding-id', agentId: 'private-agent', revision: 'private-revision',
    personaId: 'private-persona', connectionId: 'private-connection', target: {
      account: { platform: 'fixture', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-conversation',
    } }, actor: { kind: 'user', user: { platform: 'fixture', namespace: 'private-namespace', id: 'private-actor' } },
  signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides }
}
function tool(options = {}) {
  return createAgentRepositoryTools({ github: { enabled: true }, ...options }).builtIn.find(item => item.name === 'githubRepoTool')
}
function transport(overrides = {}) {
  const received = []
  return { received, async fetchImpl(url, init) {
    const path = String(url)
    received.push({ url: path, init })
    if (Object.hasOwn(overrides, path)) {
      const result = overrides[path]
      return typeof result === 'function' ? result(init) : json(result)
    }
    if (path === apiUrl) return json(base())
    if (path === `${apiUrl}/commits?per_page=5`) return json(commits())
    if (path === `${apiUrl}/branches?per_page=100`) return json(branches())
    if (path === `${apiUrl}/contributors?per_page=5`) return json(contributors())
    assert.fail(`unexpected outbound request: ${path}`)
  } }
}
function variants(secret) {
  return [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
    [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]
}
function safe(result) {
  assert.equal(typeof result.content, 'string')
  assert.doesNotMatch(result.content, /provider-private-detail|private-binding|private-revision|private-persona|private-connection/u)
  for (const value of [...variants(token), ...variants(otherSecret)]) assert.ok(!result.content.includes(value))
}

test('repository lookup is absent by default and only exposes its explicitly enabled closed GitHub schema', () => {
  assert.deepEqual(createAgentRepositoryTools(), { builtIn: [] })
  const registry = createAgentRepositoryTools({ github: { enabled: true } })
  assert.deepEqual(registry.builtIn.map(item => item.name), ['githubRepoTool'])
  const item = registry.builtIn[0]
  assert.equal(item.parameters.type, 'object')
  assert.equal(item.parameters.additionalProperties, false)
  assert.deepEqual(item.parameters.required, ['repoUrl'])
  assert.deepEqual(Object.keys(item.parameters.properties), ['repoUrl'])
})

test('GitHub sends only four fixed read-only API requests and returns sourced public facts with sample and time labels', async () => {
  const remote = transport(), usage = []
  let checks = 0
  const result = await tool({ github: { enabled: true, token }, fetchImpl: remote.fetchImpl })
    .execute({ repoUrl }, context({ async ensureCurrent() { checks++ }, recordUsage: (...args) => usage.push(args) }))
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(remote.received.map(row => row.url).sort(), [apiUrl, `${apiUrl}/commits?per_page=5`,
    `${apiUrl}/branches?per_page=100`, `${apiUrl}/contributors?per_page=5`].sort())
  for (const { url, init } of remote.received) {
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    const headers = new Headers(init.headers)
    assert.ok(headers.get('authorization')?.endsWith(token))
    assert.equal(headers.get('cookie'), null)
    assert.equal(init.body, undefined)
    assert.doesNotMatch(JSON.stringify({ url, headers: [...headers].filter(([key]) => key !== 'authorization') }), /private-|fixture/u)
  }
  assert.ok(checks >= remote.received.length, 'each actual request needs a stored-permission check')
  assert.match(result.content, /公开项目的原始说明/u)
  assert.match(result.content, /修复公开缺陷/u)
  assert.match(result.content, /public-contributor/u)
  assert.match(result.content, /分支.*样本|样本.*分支/u)
  assert.match(result.content, /来源/u)
  assert.ok(result.content.includes(repoUrl))
  assert.match(result.content, /北京时间/u)
  assert.match(result.content, /不可信|未经核实/u)
  assert.deepEqual(usage, [], 'public API reads must not manufacture model usage')
  safe(result)
})

test('canonical HTTPS repository URLs accept an optional git suffix or trailing slash without sending ambient credentials', async () => {
  for (const suffix of ['', '/', '.git', '.git/']) {
    const remote = transport()
    const result = await tool({ fetchImpl: remote.fetchImpl }).execute({ repoUrl: repoUrl + suffix }, context())
    assert.equal(result.status, 'succeeded', suffix)
    assert.equal(remote.received[0].url, apiUrl)
    for (const { init } of remote.received) assert.equal(new Headers(init.headers).get('authorization'), null)
  }
})

test('noncanonical URLs, extra paths and malformed parameters fail before any request', async () => {
  let requests = 0
  const item = tool({ fetchImpl: async () => { requests++; return json(base()) } })
  for (const input of [null, [], {}, { repoUrl: 3 }, { repoUrl: '' }, { repoUrl: ' ' }, { repoUrl, endpoint: apiUrl },
    ...['http://github.com/example/project', 'https://user:password@github.com/example/project',
      'https://github.com.evil.example/example/project', 'https://evil.example/github.com/example/project',
      'https://github.com:8443/example/project', 'https://github.com/example/project?tab=readme',
      'https://github.com/example/project#readme', 'https://github.com/example/project/issues',
      'https://github.com/example/project/releases/latest', 'https://github.com/example/project/tree/main',
      'https://github.com/example', 'https://github.com/example//project', 'https://github.com/example/project//',
      'https://github.com/example/%2fproject', 'https://github.com/example/..', 'https://github.com/example/project\\x',
      'https://github.com/example/project\n', ` ${repoUrl}`, `${repoUrl} `, 'file:///tmp/project',
      `https://github.com/example/${'x'.repeat(2049)}`,
    ].map(value => ({ repoUrl: value })),
  ]) {
    const result = await item.execute(input, context())
    assert.equal(result.status, 'failed', JSON.stringify(input))
    safe(result)
  }
  assert.equal(requests, 0)
})

test('only an identity-matched explicitly public repository is eligible for optional API reads', async () => {
  for (const payload of [null, [], {}, { message: PRIVATE }, base({ full_name: 'another/project' }),
    base({ full_name: 'example/another' }), base({ full_name: undefined }), base({ private: undefined }),
    base({ private: 'false' }), base({ private: true }), base({ visibility: 'private' }), base({ visibility: 'internal' }),
    { ...base(), error: { message: PRIVATE } },
  ]) {
    let requests = 0
    const result = await tool({ fetchImpl: async () => { requests++; return json(payload) } }).execute({ repoUrl }, context())
    assert.equal(result.status, 'failed', JSON.stringify(payload))
    assert.equal(requests, 1)
    safe(result)
  }
})

test('failed or malformed optional endpoints preserve primary facts but report unavailable evidence instead of zeros or total branch counts', async () => {
  const remote = transport({
    [`${apiUrl}/commits?per_page=5`]: async () => new Response(PRIVATE, { status: 503 }),
    [`${apiUrl}/branches?per_page=100`]: { message: PRIVATE },
    [`${apiUrl}/contributors?per_page=5`]: async () => { throw new Error(PRIVATE) },
  })
  const result = await tool({ fetchImpl: remote.fetchImpl }).execute({ repoUrl }, context())
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /公开项目的原始说明/u)
  assert.ok((result.content.match(/未取得/gu) ?? []).length >= 3)
  assert.doesNotMatch(result.content, /(?:分支总数|分支数量)\s*[:：]?\s*0/u)
  assert.equal(remote.received.length, 4, 'optional errors do not trigger retry or other endpoint probes')
  safe(result)
})

test('empty optional arrays are distinct from unavailable data and a hundred branches remain a bounded sample', async () => {
  const remote = transport({
    [`${apiUrl}/commits?per_page=5`]: [], [`${apiUrl}/contributors?per_page=5`]: [],
    [`${apiUrl}/branches?per_page=100`]: Array.from({ length: 100 }, (_, index) => ({ name: `sample-branch-${index}` })),
  })
  const result = await tool({ fetchImpl: remote.fetchImpl }).execute({ repoUrl }, context())
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /分支.*样本|样本.*分支/u)
  assert.doesNotMatch(result.content, /(?:分支总数|分支数量)\s*[:：]?\s*100/u)
  assert.doesNotMatch(result.content, /未取得/u)
  safe(result)
})

test('malformed optional rows cannot become invented commits, contributors or branch samples', async () => {
  for (const [path, payload] of [
    ['commits?per_page=5', [{}]], ['commits?per_page=5', [{ sha: 'abc', commit: null }]],
    ['branches?per_page=100', [{}]], ['branches?per_page=100', [{ name: 3 }]],
    ['contributors?per_page=5', [{}]], ['contributors?per_page=5', [{ login: 'unverified-contributor', contributions: -1 }]],
  ]) {
    const remote = transport({ [`${apiUrl}/${path}`]: payload })
    const result = await tool({ fetchImpl: remote.fetchImpl }).execute({ repoUrl }, context())
    assert.equal(result.status, 'succeeded', path)
    assert.match(result.content, /未取得/u)
    assert.doesNotMatch(result.content, /unverified-contributor/u)
    safe(result)
  }
})

test('configured and encoded host credentials are rejected in the complete input before truncation or transport', async () => {
  let requests = 0
  const item = tool({ github: { enabled: true, token }, secrets: [otherSecret], fetchImpl: async () => { requests++; return json(base()) } })
  for (const secret of [token, otherSecret]) for (const value of variants(secret)) {
    const result = await item.execute({ repoUrl: `https://github.com/example/${value}` }, context())
    assert.equal(result.status, 'failed')
    safe(result)
  }
  const result = await item.execute({ repoUrl: `${repoUrl}${'x'.repeat(4000)}${otherSecret}` }, context())
  assert.equal(result.status, 'failed')
  safe(result)
  assert.equal(requests, 0)
})

test('provider JSON is checked for credentials before output field selection or truncation', async () => {
  for (const secret of [token, otherSecret]) for (const value of variants(secret)) for (const field of ['description', 'ignoredProviderField']) {
    let requests = 0
    const result = await tool({ github: { enabled: true, token }, secrets: [otherSecret], fetchImpl: async () => {
      requests++; return json(base({ [field]: `${'公开资料'.repeat(5000)}${value}` }))
    } }).execute({ repoUrl }, context())
    assert.equal(result.status, 'failed', field)
    assert.equal(requests, 1)
    safe(result)
  }
})

test('credentials hidden in optional results cannot survive partial-result handling', async () => {
  for (const value of [...variants(token), ...variants(otherSecret)]) {
    const remote = transport({ [`${apiUrl}/commits?per_page=5`]: [{ ...commits()[0], ignored: value }] })
    const result = await tool({ github: { enabled: true, token }, secrets: [otherSecret], fetchImpl: remote.fetchImpl })
      .execute({ repoUrl }, context())
    assert.equal(result.status, 'failed')
    safe(result)
  }
})

test('primary HTTP failures, redirected responses and raw exceptions return safe failure without retries', async () => {
  for (const respond of [
    async () => new Response(`${PRIVATE} ${token}`, { status: 429 }),
    async () => new Response(`${PRIVATE} ${token}`, { status: 302, headers: { location: 'https://trap.example/secret' } }),
    async () => { throw new Error(`${PRIVATE} ${token}`) },
    async () => new Response('<html>not-json</html>'),
    async () => { const response = json(base()); Object.defineProperty(response, 'redirected', { value: true }); return response },
    async () => { const response = json(base()); Object.defineProperty(response, 'url', { value: 'https://trap.example/repo' }); return response },
  ]) {
    let requests = 0
    const result = await tool({ github: { enabled: true, token }, fetchImpl: async (...args) => { requests++; return respond(...args) } })
      .execute({ repoUrl }, context())
    assert.equal(result.status, 'failed')
    assert.equal(requests, 1)
    safe(result)
  }
})

test('stale, aborted or asynchronously refused authority never dispatches the primary request', async () => {
  let requests = 0
  const item = tool({ fetchImpl: async () => { requests++; return json(base()) } })
  for (const override of [{ isCurrent: () => false }, { signal: AbortSignal.abort() },
    { async ensureCurrent() { throw new Error(PRIVATE) } },
    { isCurrent: () => { throw new Error(PRIVATE) } },
  ]) {
    const result = await item.execute({ repoUrl }, context(override))
    assert.equal(result.status, 'failed')
    safe(result)
  }
  assert.equal(requests, 0)
})

test('permission changes after a primary response or during an optional response discard the complete result', async () => {
  for (const phase of ['primary', 'optional']) {
    let current = true, requests = 0
    const remote = transport()
    const result = await tool({ fetchImpl: async (...args) => {
      const response = await remote.fetchImpl(...args)
      requests++
      if (phase === 'primary' || String(args[0]) !== apiUrl) current = false
      return response
    } }).execute({ repoUrl }, context({ isCurrent: () => current, async ensureCurrent() { if (!current) throw new Error(PRIVATE) } }))
    assert.equal(result.status, 'failed', phase)
    if (phase === 'primary') assert.equal(requests, 1)
    else assert.ok(requests >= 2)
    assert.doesNotMatch(result.content, /公开项目的原始说明|修复公开缺陷|public-contributor/u)
    safe(result)
  }
})

test('caller cancellation and a shortened total deadline release hung fetch, body and stored-permission waits', { timeout: 5000 }, async () => {
  for (const phase of ['fetch', 'body', 'authority']) for (const interruption of ['caller', 'deadline']) {
    const controller = new AbortController(), entered = Promise.withResolvers()
    let requests = 0, signal, cancelled = false
    const item = tool({ timeoutMs: interruption === 'deadline' ? 20 : 1000, fetchImpl: async (_url, init) => {
      requests++; signal = init.signal; entered.resolve()
      if (phase === 'fetch') return new Promise(() => {})
      return new Response(new ReadableStream({ cancel() { cancelled = true } }))
    } })
    const operation = item.execute({ repoUrl }, context({ signal: controller.signal,
      ...(phase === 'authority' ? { async ensureCurrent() { entered.resolve(); return new Promise(() => {}) } } : {}),
    }))
    await entered.promise
    if (interruption === 'caller') controller.abort()
    const result = await operation
    assert.equal(result.status, 'failed', `${phase}/${interruption}`)
    if (phase === 'authority') assert.equal(requests, 0)
    else { assert.equal(requests, 1); assert.equal(signal.aborted, true) }
    if (phase === 'body') assert.equal(cancelled, true)
    safe(result)
  }
})

test('a stored-permission grant that completes after cancellation cannot resurrect a request', async () => {
  const controller = new AbortController(), started = Promise.withResolvers(), release = Promise.withResolvers()
  let requests = 0
  const operation = tool({ fetchImpl: async () => { requests++; return json(base()) } }).execute({ repoUrl }, context({
    signal: controller.signal, async ensureCurrent() { started.resolve(); await release.promise },
  }))
  await started.promise
  controller.abort()
  const result = await operation
  assert.equal(result.status, 'failed')
  release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 0)
  safe(result)
})

test('oversized declared and streamed primary bodies are cancelled at one MiB without optional requests', async () => {
  for (const declared of [false, true]) {
    let requests = 0, cancelled = false
    const result = await tool({ fetchImpl: async () => {
      requests++
      return new Response(new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
        cancel() { cancelled = true },
      }), declared ? { headers: { 'content-length': String(1024 * 1024 + 1) } } : undefined)
    } }).execute({ repoUrl }, context())
    assert.equal(result.status, 'failed')
    assert.equal(requests, 1)
    assert.equal(cancelled, true)
    safe(result)
  }
})

test('oversized optional content is unavailable instead of being truncated into success data', async () => {
  let cancelled = false
  const remote = transport({ [`${apiUrl}/commits?per_page=5`]: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled = true },
  })) })
  const result = await tool({ fetchImpl: remote.fetchImpl }).execute({ repoUrl }, context())
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /未取得/u)
  assert.match(result.content, /公开项目的原始说明/u)
  assert.equal(cancelled, true)
  assert.equal(remote.received.length, 4)
  safe(result)
})

test('a primary fetch resolving after cancellation is cancelled and cannot initiate optional requests', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  let requests = 0, cancelled = false
  const operation = tool({ fetchImpl: async () => { requests++; entered.resolve(); return release.promise } })
    .execute({ repoUrl }, context({ signal: controller.signal }))
  await entered.promise
  controller.abort()
  const result = await operation
  release.resolve(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(result.status, 'failed')
  assert.equal(requests, 1)
  assert.equal(cancelled, true)
  safe(result)
})
