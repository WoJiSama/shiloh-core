export interface ConsoleConversationSelector {
  scopeKey?: string
  bindingToken?: string
}

interface ConsoleBinding {
  scopeKey: string
  bindingToken: string
  binding: {
    source: 'configured'
    id: string
    revision: string
    agentId: string
    personaId: string
    connectionId: string
    target: {
      account: { platform: string; namespace: string; id: string }
      kind: string
      id: string
    }
  }
}

export class ConsoleBindingError extends Error {
  constructor(readonly status: 409 | 503) {
    super(
      status === 409
        ? '会话绑定未明确或已变化，请重新读取该会话后重试'
        : '无法读取完整会话绑定，请稍后重试'
    )
  }
}
const conflict = () => new ConsoleBindingError(409)
const unavailable = () => new ConsoleBindingError(503)
const base = 'http://console.invalid'
const overviewPaths = new Set([
  '/api/simulation/overview',
  '/api/trusteeship/overview',
  '/api/person-profiles',
  '/api/groups',
  '/api/style/overview'
])
const writePaths = new Set([
  '/api/simulation/group',
  '/api/style/block-word',
  '/api/trusteeship/commitment-cancel',
  '/api/trusteeship/delegated-delete',
  '/api/person-profiles/delete',
  '/api/person-profiles/delete-field'
])
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function token(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' &&
    !!value &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
}
function classify(path: string, options: RequestInit) {
  const url = new URL(path, base),
    method = (options.method ?? 'GET').toUpperCase()
  if (url.origin !== base)
    return { url, method, scoped: false, overview: false, routeGroup: undefined }
  const admin = /^\/api\/groups\/([^/]+)\/admin$/u.exec(url.pathname)
  return {
    url,
    method,
    scoped:
      ((method === 'GET' || method === 'PUT') && !!admin) ||
      (method === 'GET' && url.pathname === '/api/simulation/group') ||
      (method === 'POST' && writePaths.has(url.pathname)),
    overview: method === 'GET' && overviewPaths.has(url.pathname),
    routeGroup: admin ? decodeURIComponent(admin[1]) : undefined
  }
}
function directory(payload: unknown): Map<string, ConsoleBinding> {
  if (!record(payload) || !Array.isArray(payload.bindings) || payload.bindings.length > 10_000)
    throw unavailable()
  const result = new Map<string, ConsoleBinding>()
  for (const value of payload.bindings) {
    if (
      !record(value) ||
      !token(value.scopeKey) ||
      !token(value.bindingToken, 8192) ||
      !record(value.binding)
    )
      throw unavailable()
    const binding = value.binding,
      target = binding.target
    if (
      binding.source !== 'configured' ||
      !record(target) ||
      !record(target.account) ||
      !['group', 'private', 'channel', 'thread'].includes(String(target.kind)) ||
      ![
        binding.id,
        binding.revision,
        binding.agentId,
        binding.personaId,
        binding.connectionId,
        target.id,
        target.account.platform,
        target.account.namespace,
        target.account.id
      ].every((item) => token(item))
    )
      throw unavailable()
    const key = JSON.stringify([
      binding.agentId,
      target.account.platform,
      target.account.namespace,
      target.account.id,
      target.kind,
      target.id
    ])
    if (key !== value.scopeKey || result.has(key)) throw unavailable()
    // Keep an owned snapshot. Browser/request code cannot mutate the directory's account or revision.
    result.set(key, JSON.parse(JSON.stringify(value)) as ConsoleBinding)
  }
  return result
}
function requestFields(url: URL, options: RequestInit, routeGroup?: string) {
  let body: Record<string, unknown> = {}
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body !== 'string') throw conflict()
    let parsed: unknown
    try {
      parsed = JSON.parse(options.body)
    } catch {
      throw conflict()
    }
    if (!record(parsed)) throw conflict()
    body = parsed
  }
  const field = (key: string, maximum = 4096): string | undefined => {
    const query = url.searchParams.getAll(key),
      supplied = body[key]
    if (
      query.length > 1 ||
      (supplied !== undefined && !token(supplied, maximum)) ||
      query.some((value) => !token(value, maximum)) ||
      (query.length && supplied !== undefined && query[0] !== supplied)
    )
      throw conflict()
    return query[0] ?? (supplied as string | undefined)
  }
  const scopeKey = field('scopeKey'),
    bindingToken = field('bindingToken', 8192)
  const aliases = [field('group'), field('groupId'), routeGroup].filter(
    (value): value is string => value !== undefined
  )
  // Missing explicit scope is resolved only by a complete group key; never by a bare platform ID.
  const selected = scopeKey ?? aliases[0]
  if (!selected || !token(selected)) throw conflict()
  return { body, scopeKey: selected, bindingToken, aliases }
}

/** Session-local selector state. Directory refreshes never upgrade the version displayed by a page. */
export function createConsoleBindings(
  loadDirectory: (signal?: AbortSignal | null) => Promise<unknown>
) {
  let mode: 'unknown' | 'legacy' | 'standalone' = 'unknown'
  const legacy = () => mode === 'legacy'
  let entries = new Map<string, ConsoleBinding>()
  const initial = new Map<string, string>(),
    lists = new Map<string, string>(),
    details = new Map<string, string>()
  async function refresh(signal?: AbortSignal | null) {
    if (mode === 'legacy') return
    let payload: unknown
    try {
      payload = await loadDirectory(signal)
    } catch (error) {
      if (mode === 'unknown' && record(error) && error.status === 404) {
        mode = 'legacy'
        return
      }
      throw error
    }
    mode = 'standalone'
    const next = directory(payload)
    entries = next
    for (const entry of next.values())
      if (!initial.has(entry.scopeKey)) initial.set(entry.scopeKey, entry.bindingToken)
  }
  return {
    async prepare(
      path: string,
      options: RequestInit = {}
    ): Promise<{ path: string; options: RequestInit }> {
      const route = classify(path, options)
      if ((!route.scoped && !route.overview) || legacy()) return { path, options }
      options.signal?.throwIfAborted()
      // Capture the displayed version before awaiting a directory request or a background overview refresh.
      let fields: ReturnType<typeof requestFields> | undefined,
        invalid = false
      if (route.scoped) {
        try {
          fields = requestFields(route.url, options, route.routeGroup)
        } catch {
          invalid = true
        }
      }
      const displayed = fields
        ? (details.get(fields.scopeKey) ??
          lists.get(fields.scopeKey) ??
          initial.get(fields.scopeKey))
        : undefined
      await refresh(options.signal)
      options.signal?.throwIfAborted()
      if (legacy() || !route.scoped) return { path, options }
      if (invalid || !fields) throw conflict()
      const selected = entries.get(fields.scopeKey)
      if (
        !selected ||
        fields.aliases.some(
          (value) => value !== selected.scopeKey && value !== selected.binding.target.id
        )
      )
        throw conflict()
      const bindingToken =
        fields.bindingToken ??
        (route.method === 'GET'
          ? selected.bindingToken
          : (displayed ?? initial.get(selected.scopeKey)))
      if (!bindingToken) throw conflict()
      if (route.method === 'GET') {
        route.url.searchParams.set('scopeKey', selected.scopeKey)
        route.url.searchParams.set('bindingToken', bindingToken)
        return { path: `${route.url.pathname}${route.url.search}${route.url.hash}`, options }
      }
      // Query selectors are replaced with the same values in JSON, so no conflicting second authority is sent.
      route.url.searchParams.delete('scopeKey')
      route.url.searchParams.delete('bindingToken')
      return {
        path: `${route.url.pathname}${route.url.search}${route.url.hash}`,
        options: {
          ...options,
          body: JSON.stringify({ ...fields.body, scopeKey: selected.scopeKey, bindingToken })
        }
      }
    },
    observe(path: string, options: RequestInit, payload: unknown) {
      if (mode !== 'standalone' || !record(payload)) return
      const route = classify(path, options)
      if (route.method !== 'GET' || (!route.overview && !route.scoped)) return
      const pin = route.scoped ? details : lists
      // A successful scoped read was checked by the server against these exact selectors.
      // Group-admin responses need not repeat their binding outside the query.
      if (route.scoped) {
        const key = route.url.searchParams.get('scopeKey'),
          version = route.url.searchParams.get('bindingToken')
        if (token(key) && entries.has(key) && token(version, 8192)) pin.set(key, version)
      }
      const rows = route.scoped
        ? [payload]
        : route.url.pathname === '/api/trusteeship/overview'
          ? [
              ...(Array.isArray(payload.commitments) ? payload.commitments : []),
              ...(Array.isArray(payload.delegated) ? payload.delegated : [])
            ]
          : route.url.pathname === '/api/person-profiles'
            ? payload.profiles
            : payload.groups
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!record(row)) continue
        const key = row.scopeKey ?? row.groupId ?? row.id
        if (token(key) && entries.has(key) && token(row.bindingToken, 8192))
          pin.set(key, row.bindingToken)
      }
    },
    reset() {
      mode = 'unknown'
      entries.clear()
      initial.clear()
      lists.clear()
      details.clear()
    }
  }
}
