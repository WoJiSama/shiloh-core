import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type {
  AgentConsoleAuthAction, AgentConsoleContext, AgentConsoleCredentials, AgentConsoleGuard, AgentConsoleJson,
  AgentConsoleMethod, AgentConsolePorts, AgentConsolePrincipal, AgentConsoleRequest, AgentConsoleResponse, AgentConsoleService,
} from '../contracts/agentConsole.js'
import { serveFrontend } from '../modules/platform/infrastructure/console/frontendStatic.js'
import { agentBindingToken, agentConversationKey, conversationAddressKey, decodeAgentConversationKey } from '../modules/runtime/domain/agentBindings.js'
import { createSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'

const statuses = { unauthorized: 401, forbidden: 403, invalid_request: 400, conflict: 409, unavailable: 503,
  not_found: 404, method_not_allowed: 405, body_too_large: 413, request_failed: 500, commit_outcome_unknown: 503, configuration_recovery_required: 503, candidate_stale: 409 } as const
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const authActions = new Set(['setup', 'login', 'logout', 'password'])
const selectors = new Set(['scopeKey', 'bindingToken'])
const maximumBody = 20 * 1024 * 1024
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }

function plain(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail('invalid_request')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) return fail('invalid_request')
    result[key] = field.value
  }
  return result
}

function token(input: unknown, limit = 4096): string {
  if (typeof input !== 'string' || !input || input.length > limit || input.trim() !== input || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) return fail('invalid_request')
  return input
}

function bindingCopy(input: AgentBindingSnapshot): AgentBindingSnapshot {
  const row = plain(input), target = plain(row.target), account = plain(target.account)
  const result = { source: row.source, id: token(row.id), revision: token(row.revision), agentId: token(row.agentId, 64),
    personaId: token(row.personaId, 128), connectionId: token(row.connectionId, 64),
    target: { account: { platform: token(account.platform, 64), namespace: token(account.namespace, 128), id: token(account.id, 128) },
      kind: target.kind, id: token(target.id, 128) } }
  if (result.source !== 'configured' || typeof result.target.kind !== 'string') return fail('conflict')
  const scope = decodeAgentConversationKey(agentConversationKey(result as AgentBindingSnapshot))
  if (!scope || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(result.connectionId)) return fail('conflict')
  return Object.freeze({ ...result, source: 'configured', target: Object.freeze({ ...scope.target, account: Object.freeze(scope.target.account) }) })
}

function principalCopy(input: AgentConsolePrincipal): AgentConsolePrincipal {
  const row = plain(input)
  if (row.via !== 'session' && row.via !== 'token' || row.username !== null && typeof row.username !== 'string') return fail('unauthorized')
  return Object.freeze({ id: token(row.id, 256), username: row.username === null ? null : token(row.username, 256), via: row.via })
}

function credentialValues(credentials?: AgentConsoleCredentials, issuedCookie?: string): string[] {
  const values = credentials?.token ? [credentials.token] : []
  for (const part of [...(credentials?.cookie.split(';') ?? []), ...(issuedCookie ? [issuedCookie.split(';')[0]!] : [])]) {
    const offset = part.indexOf('=')
    if (offset < 1) continue
    const value = part.slice(offset + 1).trim()
    if (value.length >= 8) {
      values.push(value)
      try { values.push(decodeURIComponent(value)) } catch { /* The opaque raw value is still filtered. */ }
    }
  }
  return values
}

function bodySecrets(input: unknown, privateField = false, output: string[] = [], depth = 0): string[] {
  if (depth > 32) return fail('invalid_request')
  if (typeof input === 'string') { if (privateField && input) output.push(input); return output }
  if (Array.isArray(input)) { for (const value of input) bodySecrets(value, privateField, output, depth + 1); return output }
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      bodySecrets(value, privateField || /(?:^|[._-])(?:api[-_]?key|access[-_]?token|token|password|oldPassword|newPassword|secret|secrets|cookie|authorization)$/iu.test(key), output, depth + 1)
    }
  }
  return output
}

function exposesCredential(body: string | Uint8Array, credentials?: AgentConsoleCredentials, issuedCookie?: string, submitted: readonly string[] = []): boolean {
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
  return [...credentialValues(credentials, issuedCookie), ...submitted].some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1)))
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  if (req.headers['content-length'] !== undefined && (!/^[0-9]+$/u.test(req.headers['content-length']) || Number(req.headers['content-length']) > limit)) {
    req.resume(); return fail('body_too_large')
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0, exceeded = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) { if (!exceeded) { exceeded = true; chunks.length = 0; reject(new AgentConsoleError('body_too_large')) }; return }
      if (!exceeded) chunks.push(chunk)
    })
    req.once('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)) })
    req.once('error', () => reject(new AgentConsoleError('invalid_request')))
    req.once('aborted', () => reject(new AgentConsoleError('invalid_request')))
  })
}

function jsonBody(bytes: Buffer, contentType: string): Record<string, AgentConsoleJson> {
  if (!bytes.length) return Object.create(null) as Record<string, AgentConsoleJson>
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) return fail('invalid_request')
  try { return plain(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) as Record<string, AgentConsoleJson> }
  catch { return fail('invalid_request') }
}

function compile(service: AgentConsoleService) {
  if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(service.operation) || !methods.has(service.method) ||
      !['global', 'conversation'].includes(service.scope) || !/^\/(?:api|bl-chat|img)\//u.test(service.path) ||
      /[?#\\\u0000-\u0020]/u.test(service.path) || service.path === '/api/auth' || service.path.startsWith('/api/auth/') ||
      service.path === '/api/bindings' || service.path.startsWith('/api/bindings/') || service.path.endsWith('/') ||
      service.body !== undefined && !['json', 'bytes'].includes(service.body) ||
      service.method === 'GET' && service.body !== undefined ||
      service.handle !== undefined && typeof service.handle !== 'function' ||
      service.maxBodyBytes !== undefined && (!Number.isSafeInteger(service.maxBodyBytes) || service.maxBodyBytes < 1 || service.maxBodyBytes > maximumBody)) throw new Error('控制台服务定义无效')
  const params = new Set<string>()
  const segments = service.path.split('/').slice(1).map(segment => {
    if (!segment || segment === '.' || segment === '..' || segment.includes('%')) throw new Error('控制台服务路径无效')
    if (!segment.startsWith(':')) return { literal: segment }
    const name = segment.slice(1)
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) || params.has(name)) throw new Error('控制台服务路径参数无效')
    params.add(name)
    return { param: name }
  })
  return { service: Object.freeze({ ...service }), segments }
}

/** HTTP only: services own durable state, current authorization, config CAS and native dispatch. */
export function createStandaloneAgentConsole(options: AgentConsolePorts & { frontendDir: string; host?: string; port?: number }) {
  function currentGuard(signal: AbortSignal, isCurrent: () => boolean): AgentConsoleGuard {
    return createSynchronousGuard(signal, () => {
      if (!isCurrent()) fail('conflict')
    }, () => fail('conflict'))
  }
  const host = options.host ?? '127.0.0.1', port = options.port ?? 8787
  if (!host || /[\u0000-\u0020\u007f]/u.test(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535 || !path.isAbsolute(options.frontendDir)) throw new Error('控制台监听地址或前端目录无效')
  if (!Array.isArray(options.services) || options.services.length > 256) throw new Error('控制台服务数量无效')
  const supplied = options.services.map(compile)
  const installed = new Map(supplied.map(route => [route.service.operation, route]))
  if (installed.size !== supplied.length) throw new Error('控制台服务操作重复')
  for (const definition of AGENT_CONSOLE_SERVICES) {
    const current = installed.get(definition.operation)
    if (!current) installed.set(definition.operation, compile(definition))
    else if (current.service.path !== definition.path || current.service.method !== definition.method || current.service.scope !== definition.scope ||
        current.service.body !== definition.body) throw new Error('控制台服务不能改变已有操作的路径或权限范围')
  }
  const routes = [...installed.values()], keys = routes.map(route => `${route.service.method} ${route.segments.map(segment => segment.literal ?? ':').join('/')}`)
  if (new Set(keys).size !== keys.length) throw new Error('控制台服务路径重复')
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  let listening: Promise<AddressInfo> | undefined
  const active = new Set<AbortController>()
  const authorityCurrent = () => {
    try { return !lifetime.signal.aborted && !options.authority.signal.aborted && options.authority.isCurrent() === true }
    catch { return false }
  }
  const bindingCurrent = (binding: AgentBindingSnapshot) => {
    try {
      const live = options.bindings.resolve(binding.target)
      return !!live && agentBindingToken(live) === agentBindingToken(binding) && agentConversationKey(live) === agentConversationKey(binding) &&
        conversationAddressKey(live.target) === conversationAddressKey(binding.target)
    } catch { return false }
  }
  function hostGuard(signal: AbortSignal): AgentConsoleGuard {
    return currentGuard(signal, () => !signal.aborted && authorityCurrent())
  }
  function send(res: http.ServerResponse, status: number, body: string | Uint8Array, contentType: string) {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  function json(res: http.ServerResponse, value: AgentConsoleJson, status = 200, credentials?: AgentConsoleCredentials, guard?: AgentConsoleGuard, submitted?: readonly string[]) {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || Buffer.byteLength(serialized) > maximumBody ||
        exposesCredential(serialized, credentials, undefined, submitted) || !options.allowsResponse(serialized, 'application/json')) fail('request_failed')
    guard?.ensureCurrent()
    send(res, status, serialized, 'application/json; charset=utf-8')
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, controller: AbortController) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 16_384) return fail('invalid_request')
    const url = new URL(req.url, 'http://console.invalid')
    if (url.hash || /%(?:2f|5c|00)/iu.test(url.pathname) || url.pathname.includes('\\')) return fail('invalid_request')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['sec-fetch-site'] === 'cross-site') return fail('forbidden')
      if (req.headers.origin !== undefined) {
        let origin: URL
        try { origin = new URL(req.headers.origin) } catch { return fail('forbidden') }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) return fail('forbidden')
      }
    }
    const query: Record<string, string> = Object.create(null)
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key) || key.length > 128 || value.length > 8192) return fail('invalid_request')
      query[key] = value
    }
    const headerToken = req.headers['x-console-token']
    if (headerToken !== undefined && typeof headerToken !== 'string' || headerToken && query.token && headerToken !== query.token) return fail('invalid_request')
    const credentials = Object.freeze({ token: headerToken || query.token || '', cookie: req.headers.cookie ?? '' })
    if (credentials.token.length > 8192 || credentials.cookie.length > 16_384) return fail('invalid_request')
    delete query.token
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveFrontend(req, res, url.pathname, options.frontendDir)) return
    }
    const guard = hostGuard(AbortSignal.any([controller.signal, lifetime.signal, options.authority.signal]))
    guard.ensureCurrent()
    if (url.pathname === '/api/auth/state') {
      if (req.method !== 'GET') return fail('method_not_allowed')
      const state = await options.auth.state(credentials, guard)
      guard.ensureCurrent()
      if (typeof state.hasUser !== 'boolean' || typeof state.tokenWorks !== 'boolean' ||
          state.username !== null && typeof state.username !== 'string' || ![null, 'session', 'token'].includes(state.via)) return fail('request_failed')
      return json(res, { hasUser: state.hasUser, username: state.username, tokenWorks: state.tokenWorks, via: state.via }, 200, credentials, guard)
    }
    if (url.pathname.startsWith('/api/auth/')) {
      const action = url.pathname.slice('/api/auth/'.length) as AgentConsoleAuthAction
      if (!authActions.has(action)) return fail('not_found')
      if (req.method !== 'POST') return fail('method_not_allowed')
      const principal = await options.auth.authenticate(credentials, guard)
      guard.ensureCurrent()
      const actor = principal && principalCopy(principal)
      if (action === 'password' && actor?.via !== 'session') return fail('unauthorized')
      const body = jsonBody(await readBody(req, 64 * 1024), req.headers['content-type'] ?? '')
      const fields = action === 'login' || action === 'setup' ? ['username', 'password'] : action === 'password' ? ['oldPassword', 'newPassword'] : []
      if (Object.keys(body).some(key => !fields.includes(key) || typeof body[key] !== 'string')) return fail('invalid_request')
      const current = () => guard.isCurrent() && (!actor || options.auth.isCurrent(actor))
      const context = { ...guard, ...(actor ? { principal: actor } : {}), isCurrent: current,
        ensureCurrent: () => { if (!current()) fail('conflict') } }
      context.ensureCurrent()
      const result = await options.auth.run(action, Object.freeze(body), credentials, context)
      // Logout/password may intentionally revoke this session; only host authority is checked afterward.
      guard.ensureCurrent()
      if (result.cookie !== undefined) {
        if (typeof result.cookie !== 'string' || result.cookie.length > 8192 || /[\r\n\u0000]/u.test(result.cookie) ||
            !/;\s*HttpOnly(?:;|$)/iu.test(result.cookie) || !/;\s*SameSite=(?:Strict|Lax)(?:;|$)/iu.test(result.cookie)) return fail('request_failed')
      }
      const payload: Record<string, AgentConsoleJson> = { ok: true }
      if (result.username !== undefined) payload.username = token(result.username, 256)
      if (result.message !== undefined) payload.message = token(result.message, 2000)
      // Serialize/filter first so a rejected auth result cannot issue a cookie.
      const serialized = JSON.stringify(payload)
      if (exposesCredential(serialized, credentials, result.cookie, bodySecrets(body)) || !options.allowsResponse(serialized, 'application/json')) return fail('request_failed')
      guard.ensureCurrent()
      if (result.cookie !== undefined) res.setHeader('set-cookie', result.cookie)
      return send(res, 200, serialized, 'application/json; charset=utf-8')
    }
    const authenticated = await options.auth.authenticate(credentials, guard)
    guard.ensureCurrent()
    if (!authenticated) return fail('unauthorized')
    const principal = principalCopy(authenticated)
    const baseActorCurrent = () => {
      try { return !res.destroyed && !res.writableEnded && guard.isCurrent() && options.auth.isCurrent(principal) === true } catch { return false }
    }
    // These host-owned read views describe the loaded/stored versions after execution retirement.
    // They retain the real request/session/host guard and never execute Core management commands.
    const stateRequest = req.method === 'GET' && ['/api/config-state', '/api/workspace', '/api/observe/summary'].includes(url.pathname)
    const executionCurrent = () => { try { return !options.execution || !options.execution.signal.aborted && options.execution.isCurrent() === true } catch { return false } }
    const actorCurrent = () => baseActorCurrent() && (stateRequest || executionCurrent())
    const responseAuthority: AgentConsoleGuard = currentGuard(guard.signal, baseActorCurrent)
    const actorGuard: AgentConsoleGuard = currentGuard(guard.signal, actorCurrent)
    function boundGuard(binding?: AgentBindingSnapshot): AgentConsoleGuard {
      return currentGuard(guard.signal, () => actorCurrent() && (!binding || bindingCurrent(binding)))
    }
    async function authorize(operation: string, binding?: AgentBindingSnapshot) {
      const permissionGuard = boundGuard(binding)
      permissionGuard.ensureCurrent()
      const result = await options.auth.authorize(principal, operation, binding, permissionGuard)
      permissionGuard.ensureCurrent()
      if (result === 'unavailable') return fail('unavailable')
      if (result !== 'allowed') return fail('forbidden')
    }
    if (url.pathname === '/api/bindings') {
      if (req.method !== 'GET') return fail('method_not_allowed')
      if (Object.keys(query).length) return fail('invalid_request')
      await authorize('bindings.list')
      const listed = options.bindings.list()
      if (!Array.isArray(listed) || listed.length > 10_000) return fail('unavailable')
      const output: AgentConsoleJson[] = [], seen = new Set<string>()
      for (const entry of listed) {
        const binding = bindingCopy(entry), scopeKey = agentConversationKey(binding), bindingToken = agentBindingToken(binding)
        if (seen.has(scopeKey)) return fail('conflict')
        seen.add(scopeKey)
        const permissionGuard = boundGuard(binding)
        permissionGuard.ensureCurrent()
        const allowed = await options.auth.authorize(principal, 'bindings.read', binding, permissionGuard)
        permissionGuard.ensureCurrent()
        if (allowed === 'unavailable') return fail('unavailable')
        if (allowed !== 'allowed') continue
        const live = options.bindings.resolve(binding.target)
        if (!live || agentBindingToken(live) !== bindingToken || agentConversationKey(live) !== scopeKey) return fail('conflict')
        output.push({ scopeKey, bindingToken, binding: binding as unknown as AgentConsoleJson })
      }
      for (const entry of output) {
        const item = entry as { binding: unknown; scopeKey: string; bindingToken: string }, binding = item.binding as AgentBindingSnapshot
        const live = options.bindings.resolve(binding.target)
        if (!live || agentBindingToken(live) !== item.bindingToken || agentConversationKey(live) !== item.scopeKey) return fail('conflict')
      }
      actorGuard.ensureCurrent()
      return json(res, { bindings: output }, 200, credentials, actorGuard)
    }
    let segments: string[]
    try { segments = url.pathname.split('/').slice(1).map(segment => decodeURIComponent(segment)) } catch { return fail('invalid_request') }
    const matching = routes.filter(route => route.segments.length === segments.length && route.segments.every((segment, index) => segment.param || segment.literal === segments[index]))
    const candidates = matching.filter(route => route.service.method === req.method)
    if (candidates.length > 1) return fail('conflict')
    const selected = candidates[0]
    if (!selected) return fail(matching.length ? 'method_not_allowed' : 'not_found')
    const { service } = selected
    const params: Record<string, string> = Object.create(null)
    selected.segments.forEach((segment, index) => { if (segment.param) params[segment.param] = token(segments[index], 256) })
    let body: Record<string, AgentConsoleJson> = Object.create(null) as Record<string, AgentConsoleJson>, bytes: Buffer | undefined
    if (service.method !== 'GET') {
      const input = await readBody(req, service.maxBodyBytes ?? 2 * 1024 * 1024)
      if (service.body === 'bytes') bytes = input
      else body = jsonBody(input, req.headers['content-type'] ?? '')
    }
    let binding: AgentBindingSnapshot | undefined
    if (service.scope === 'conversation') {
      const scopeKey = query.scopeKey ?? body.scopeKey, expected = query.bindingToken ?? body.bindingToken
      if (query.scopeKey !== undefined && body.scopeKey !== undefined && query.scopeKey !== body.scopeKey ||
          query.bindingToken !== undefined && body.bindingToken !== undefined && query.bindingToken !== body.bindingToken) return fail('invalid_request')
      const scope = decodeAgentConversationKey(token(scopeKey)), expectedToken = token(expected, 8192)
      if (!scope) return fail('invalid_request')
      const live = options.bindings.resolve(scope.target)
      if (!live || agentConversationKey(live) !== scopeKey || agentBindingToken(live) !== expectedToken) return fail('conflict')
      binding = bindingCopy(live)
    } else if ([...selectors].some(key => Object.hasOwn(query, key) || Object.hasOwn(body, key))) return fail('invalid_request')
    for (const key of selectors) { delete query[key]; delete body[key] }
    await authorize(service.operation, binding)
    const context: AgentConsoleContext = Object.freeze({ principal, ...(binding ? { binding } : {}), ...boundGuard(binding) })
    context.ensureCurrent()
    if (!service.handle) return fail('unavailable')
    const request: AgentConsoleRequest = Object.freeze({ method: req.method as AgentConsoleMethod, pathname: url.pathname,
      params: Object.freeze(params), query: Object.freeze(query), body: Object.freeze(body), ...(bytes ? { bytes: Uint8Array.from(bytes), contentType: req.headers['content-type'] ?? '' } : {}) })
    const checkResponse = (serialized: string) => {
      if (Buffer.byteLength(serialized) > maximumBody || exposesCredential(serialized, credentials, undefined, bodySecrets(body)) || !options.allowsResponse(serialized, 'application/json')) fail('request_failed')
    }
    options.commits?.open(context, request, service.operation, responseAuthority, checkResponse)
    const closeCommit = () => options.commits?.close(context)
    context.signal.addEventListener('abort', closeCommit, { once: true })
    try {
      const result: AgentConsoleResponse = await service.handle(request, context)
      if (options.commits?.isCommitted(result)) {
        const verified = options.commits.verify(result, context, true)
        return send(res, verified.status, verified.body, 'application/json; charset=utf-8')
      }
      context.ensureCurrent()
      const status = result.status ?? 200
      if (!Number.isInteger(status) || status < 200 || status > 599 || [204, 205, 304].includes(status)) return fail('request_failed')
      if (result.kind === 'json') return json(res, result.value, status, credentials, context, bodySecrets(body))
      if (result.kind !== 'bytes' || !(result.value instanceof Uint8Array) || result.value.byteLength > maximumBody ||
          !/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9= ._-]+)?$/iu.test(result.contentType) ||
          exposesCredential(result.value, credentials, undefined, bodySecrets(body)) || !options.allowsResponse(result.value, result.contentType)) return fail('request_failed')
      context.ensureCurrent()
      return send(res, status, result.value, result.contentType)
    } finally { context.signal.removeEventListener('abort', closeCommit); closeCommit() }
  }
  const server = http.createServer({ maxHeaderSize: 32 * 1024 }, (req, res) => {
    const controller = new AbortController()
    active.add(controller)
    const disconnect = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', disconnect)
    void handle(req, res, controller).catch(error => {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      const code = error instanceof AgentConsoleError && Object.hasOwn(statuses, error.code) ? error.code : 'request_failed'
      send(res, statuses[code] ?? 500, JSON.stringify({ error: code, ...(['commit_outcome_unknown', 'configuration_recovery_required'].includes(code) ? { requiresRestart: true } : {}),
        ...(code === 'configuration_recovery_required' ? { recoveryRequired: true } : {}) }), 'application/json; charset=utf-8')
    }).finally(() => { controller.abort(); active.delete(controller); res.off('close', disconnect) })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  async function close(): Promise<void> {
    if (closing) return closing
    lifetime.abort()
    for (const controller of active) controller.abort()
    options.authority.signal.removeEventListener('abort', stop)
    closing = (async () => {
      if (listening) await listening.catch(() => {})
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    })()
    return closing
  }
  const stop = () => { void close().catch(() => {}) }
  options.authority.signal.addEventListener('abort', stop, { once: true })
  async function listen(): Promise<AddressInfo> {
    if (!authorityCurrent()) return fail('unavailable')
    if (server.listening) return server.address() as AddressInfo
    if (listening) return listening
    listening = new Promise<AddressInfo>((resolve, reject) => {
      const error = (failure: Error) => { server.off('listening', ready); reject(failure) }
      const ready = () => { server.off('error', error); if (!authorityCurrent()) { reject(new AgentConsoleError('unavailable')); stop(); return }; resolve(server.address() as AddressInfo) }
      server.once('error', error); server.once('listening', ready); server.listen(port, host)
    })
    return listening
  }
  return { server, listen, close }
}
