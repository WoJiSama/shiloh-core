import { normalizePixivCookie } from '../modules/media/infrastructure/agentPixivRelayHttp.js'
import { validateYoutubeProxyUrl } from '../modules/media/infrastructure/agentYoutubeRelayHttp.js'

export interface StandalonePixivToolsConfig {
  readonly enabled: boolean
  readonly allowRestricted: boolean
  readonly authCookie?: string
  readonly proxyUrl?: string
}
const failure = () => new Error('独立宿主 Pixiv 工具配置无效')
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['enabled', 'allowRestricted', 'cookieEnv', 'proxyEnv'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}

/** Pure opt-in declarations; a disabled tool never resolves its environment references. */
export function readStandalonePixivToolsConfig(input: unknown, env: NodeJS.ProcessEnv, requireCredentials = true): Readonly<StandalonePixivToolsConfig> {
  try {
    const value: Record<string, unknown> = input === undefined ? { enabled: false } : object(input)
    if (typeof value.enabled !== 'boolean' || value.allowRestricted !== undefined && typeof value.allowRestricted !== 'boolean') throw failure()
    const credentials: { authCookie?: string; proxyUrl?: string } = {}
    for (const [field, resolved, label] of [['cookieEnv', 'authCookie', 'Cookie'], ['proxyEnv', 'proxyUrl', '代理']] as const) {
      const reference = value[field]
      if (reference === undefined) continue
      if (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference)) throw failure()
      if (!value.enabled) continue
      const secret = env[reference]?.trim() ?? ''
      if (!secret) { if (requireCredentials) throw new Error(`环境变量 ${reference} 缺少 Pixiv ${label}`); continue }
      if (resolved === 'authCookie') credentials.authCookie = normalizePixivCookie(secret)
      else { validateYoutubeProxyUrl(secret); credentials.proxyUrl = secret }
    }
    return Object.freeze({ enabled: value.enabled, allowRestricted: value.allowRestricted === true, ...credentials })
  } catch (error) {
    if (error instanceof Error && /^环境变量 [A-Z_][A-Z0-9_]{0,127} 缺少 Pixiv (?:Cookie|代理)$/u.test(error.message)) throw error
    throw failure()
  }
}

export function standalonePixivToolsSecrets(config: StandalonePixivToolsConfig): readonly string[] {
  const secrets: string[] = []
  if (config.authCookie) {
    secrets.push(config.authCookie)
    for (const part of config.authCookie.split(';')) {
      const at = part.indexOf('='), value = part.slice(at + 1).trim()
      if (at > 0 && value) secrets.push(value)
    }
  }
  if (config.proxyUrl) {
    const proxy = new URL(config.proxyUrl)
    secrets.push(config.proxyUrl, proxy.href)
    for (const value of [proxy.username, proxy.password]) if (value) secrets.push(value, decodeURIComponent(value))
  }
  return [...new Set(secrets)]
}
