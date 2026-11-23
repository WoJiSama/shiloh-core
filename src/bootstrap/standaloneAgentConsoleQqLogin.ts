import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { AGENT_CONSOLE_SERVICES, AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleContext, AgentConsoleRequest, AgentConsoleService } from '../contracts/agentConsole.js'
import type { PlatformConnectionAdapter } from '../contracts/platformConnection.js'
import type { StandaloneQqLoginConfig } from './standaloneAgentConsoleConfig.js'

const qr = createRequire(import.meta.url)('qrcode') as {
  toDataURL(text: string, options: { width: number; margin: number }): Promise<string>
}
const qrLifetimeMs = 100_000
const maximumResponseBytes = 16_384
type LoginState = 'connected' | 'connecting' | 'login-required' | 'awaiting-scan' | 'awaiting-confirmation' | 'account-mismatch'
type LoginView = { state: LoginState; qrImage?: string; remainingMs?: number }
type Route = 'auth/login' | 'QQLogin/CheckLoginStatus' | 'QQLogin/GetQQLoginInfo' | 'QQLogin/RefreshQRcode'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentConsoleError('unavailable')
  return value as Record<string, unknown>
}

async function readResponse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new AgentConsoleError('unavailable')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    if (!response.ok || !/^application\/json\b/iu.test(response.headers.get('content-type') ?? '')) throw new AgentConsoleError('unavailable')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximumResponseBytes) throw new AgentConsoleError('unavailable')
      chunks.push(value)
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } finally { await reader.cancel().catch(() => {}) }
}

function qqLoginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /\s/u.test(value)) throw new AgentConsoleError('unavailable')
  const url = new URL(value)
  if (url.origin !== 'https://txz.qq.com' || url.pathname !== '/p' || url.username || url.password || url.hash ||
      url.searchParams.getAll('k').length !== 1 || !url.searchParams.get('k')) throw new AgentConsoleError('unavailable')
  return url.href
}

function createNapCatLogin(config: StandaloneQqLoginConfig, token: string,
  adapter: Pick<PlatformConnectionAdapter, 'isReady'>, fetchImpl: typeof fetch, now: () => number) {
  const endpoint = 'http://127.0.0.1:' + config.port + '/api/'
  const hash = createHash('sha256').update(token + '.napcat').digest('hex')
  let credential: { value: string; expiresAt: number } | undefined
  let code: { url: string; image: string; expiresAt: number } | undefined
  let refreshing = false, retryAt = 0

  async function request(route: Route, context: AgentConsoleContext, body = {}, bearer?: string) {
    context.ensureCurrent()
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(route === 'QQLogin/RefreshQRcode' ? 12_000 : 4_000)])
    const response = await fetchImpl(endpoint + route, { method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) } })
    const payload = await readResponse(response)
    context.ensureCurrent()
    if (payload.code !== 0) {
      if (payload.message === 'Unauthorized') credential = undefined
      throw new AgentConsoleError('unavailable')
    }
    return record(payload.data)
  }

  async function authorized(route: Exclude<Route, 'auth/login'>, context: AgentConsoleContext) {
    if (!credential || credential.expiresAt <= now()) {
      const data = await request('auth/login', context, { hash })
      if (data.require2FA === true || typeof data.Credential !== 'string' ||
          !/^[a-zA-Z0-9+/_=-]{16,8192}$/u.test(data.Credential)) throw new AgentConsoleError('unavailable')
      credential = { value: data.Credential, expiresAt: now() + 50 * 60_000 }
    }
    return request(route, context, {}, credential.value)
  }

  function ready(): LoginView {
    code = undefined
    return { state: 'connected' }
  }

  function scanView(): LoginView {
    const remainingMs = (code?.expiresAt ?? 0) - now()
    if (code && remainingMs > 0) return { state: 'awaiting-scan', qrImage: code.image, remainingMs }
    code = undefined
    return { state: 'login-required' }
  }

  async function inspect(context: AgentConsoleContext): Promise<{ view: LoginView; qrcodeurl?: string }> {
    if (adapter.isReady()) return { view: ready() }
    if (refreshing) return { view: { state: 'connecting' } }
    const data = await authorized('QQLogin/CheckLoginStatus', context)
    if (adapter.isReady()) return { view: ready() }
    if (refreshing) return { view: { state: 'connecting' } }
    if (typeof data.isLogin !== 'boolean') throw new AgentConsoleError('unavailable')
    const phase = data.loginPhase
    if (data.isLogin) {
      code = undefined
      const identity = await authorized('QQLogin/GetQQLoginInfo', context)
      return { view: adapter.isReady() ? ready() : { state: String(identity.uin) === config.accountId ? 'connecting' : 'account-mismatch' } }
    }
    if (phase === 'qrcode_scanned') return { view: { state: 'awaiting-confirmation' } }
    if (phase === 'initializing' || phase === 'reconnecting' || phase === 'generating_qrcode') return { view: { state: 'connecting' } }
    const qrcodeurl = typeof data.qrcodeurl === 'string' ? data.qrcodeurl : ''
    if (qrcodeurl !== code?.url || data.loginError) code = undefined
    return { view: scanView(), qrcodeurl }
  }

  return {
    async status(context: AgentConsoleContext) { return (await inspect(context)).view },
    async refresh(context: AgentConsoleContext): Promise<LoginView> {
      const { view, qrcodeurl } = await inspect(context)
      if (refreshing) return { state: 'connecting' }
      if (view.state !== 'login-required' && view.state !== 'awaiting-scan' || now() < retryAt) return view
      refreshing = true
      retryAt = now() + 3_000
      code = undefined
      try {
        if (adapter.isReady()) return ready()
        const generated = await authorized('QQLogin/RefreshQRcode', context)
        if (adapter.isReady()) return ready()
        if (generated.restarting === true) return { state: 'connecting' }
        const url = qqLoginUrl(generated.qrcodeurl)
        if (url === qrcodeurl) throw new AgentConsoleError('unavailable')
        const image = await qr.toDataURL(url, { width: 320, margin: 4 })
        context.ensureCurrent()
        if (adapter.isReady()) return ready()
        code = { url, image, expiresAt: now() + qrLifetimeMs }
        return scanView()
      } finally { refreshing = false }
    },
  }
}

export function createStandaloneAgentConsoleQqLogin(options: {
  configs: readonly StandaloneQqLoginConfig[]
  adapters: readonly PlatformConnectionAdapter[]
  env: Readonly<Record<string, string | undefined>>
  fetchImpl?: typeof fetch
  now?: () => number
}) {
  const ports = new Map(options.configs.flatMap(config => {
    const adapter = options.adapters.find(row => row.id === config.connectionId && row.account.platform === 'qq' &&
      row.account.namespace === 'global' && row.account.id === config.accountId)
    const token = options.env[config.tokenEnv]
    return adapter && token
      ? [[config.connectionId, { accountId: config.accountId, login: createNapCatLogin(config, token, adapter, options.fetchImpl ?? fetch, options.now ?? Date.now) }] as const]
      : []
  }))
  const services = ports.size ? AGENT_CONSOLE_SERVICES.filter(row => row.operation === 'qq-login.read' || row.operation === 'qq-login.refresh').map(
    (definition): AgentConsoleService => ({ ...definition, ...(definition.method === 'POST' ? { maxBodyBytes: 512 } : {}),
      async handle(request: AgentConsoleRequest, context: AgentConsoleContext) {
        if (Object.keys(request.query).length || !request.body || typeof request.body !== 'object' ||
            Array.isArray(request.body) || Object.keys(request.body).length) throw new AgentConsoleError('invalid_request')
        const port = ports.get(request.params.connectionId ?? '')
        if (!port || request.params.accountId !== port.accountId) throw new AgentConsoleError('not_found')
        try {
          const view = await (definition.method === 'GET' ? port.login.status(context) : port.login.refresh(context))
          context.ensureCurrent()
          return { kind: 'json', value: { ...view, accountId: port.accountId } }
        } catch (error) {
          context.ensureCurrent()
          if (error instanceof AgentConsoleError) throw error
          throw new AgentConsoleError('unavailable')
        }
      },
    })) : []
  return { services, supports: (id: string) => ports.has(id) }
}
