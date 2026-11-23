import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface StandaloneQqLoginConfig {
  readonly connectionId: string
  readonly accountId: string
  readonly port: number
  readonly tokenEnv: string
  readonly container?: string
  readonly companion?: string
}

export interface StandaloneAgentConsoleConfig {
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly frontendDir: string
  readonly userFile: string
  readonly tokenEnv?: string
  readonly legacyUserFile?: string
  readonly allowSetup: boolean
  readonly secureCookies: boolean
  readonly qqLogin: readonly StandaloneQqLoginConfig[]
}

export function readStandaloneAgentConsoleConfig(value: unknown, options: {
  directory: string; dataDir: string; env: Readonly<Record<string, string | undefined>>; requireCredentials: boolean
}): StandaloneAgentConsoleConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('console 必须是配置对象')
  const raw = (value ?? {}) as Record<string, unknown>
  if (Object.keys(raw).some(key => !['enabled', 'host', 'port', 'frontendDir', 'userFile', 'tokenEnv', 'legacyUserFile', 'allowSetup', 'secureCookies', 'qqLogin'].includes(key)) ||
      ['enabled', 'allowSetup', 'secureCookies'].some(key => raw[key] !== undefined && typeof raw[key] !== 'boolean')) throw new Error('console 包含无效字段')
  const enabled = raw.enabled === true
  const host = raw.host === undefined ? '127.0.0.1' : raw.host
  if (typeof host !== 'string' || !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('console.host 仅支持显式监听地址')
  const port = raw.port === undefined ? 8787 : raw.port
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('console.port 必须是 1–65535 的整数')
  if (raw.tokenEnv !== undefined && (typeof raw.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(raw.tokenEnv))) throw new Error('console.tokenEnv 必须是环境变量名')
  const tokenEnv = raw.tokenEnv as string | undefined
  const configuredToken = tokenEnv === undefined ? undefined : options.env[tokenEnv]
  if (enabled && tokenEnv && options.requireCredentials && !configuredToken) throw new Error('控制台令牌环境变量缺失')
  if (enabled && configuredToken && !/^[\x21-\x7e]{16,8192}$/u.test(configuredToken)) throw new Error('控制台令牌格式无效')
  if (raw.allowSetup === true && !['127.0.0.1', '::1'].includes(host)) throw new Error('console.allowSetup 仅允许回环地址')
  const loginRows = raw.qqLogin === undefined ? [] : raw.qqLogin
  if (!Array.isArray(loginRows) || loginRows.length > 32) throw new Error('console.qqLogin 需要至多 32 条 QQ 登录配置')
  const qqLogin = (loginRows as unknown[]).map((value): StandaloneQqLoginConfig => {
    const row = value as Record<string, unknown> | null
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['connectionId', 'accountId', 'port', 'tokenEnv', 'container', 'companion'].includes(key)) ||
        typeof row.connectionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(row.connectionId) ||
        typeof row.accountId !== 'string' || !/^[1-9]\d{4,11}$/u.test(row.accountId) ||
        typeof row.port !== 'number' || !Number.isSafeInteger(row.port) || row.port < 1 || row.port > 65_535 || row.port === port ||
        typeof row.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(row.tokenEnv)) {
      throw new Error('console.qqLogin 需要连接 ID、QQ 号字符串、NapCat 本机 WebUI 端口和令牌环境变量名')
    }
    const containerName = (value: unknown, prefix: RegExp): string | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== 'string' || !prefix.test(value)) throw new Error('QQ 托管容器名称无效')
      return value
    }
    const container = containerName(row.container, /^(?:napcat|napcat-[1-9]\d{4,11}|shiloh-qq-[1-9]\d{4,11})$/u)
    const companion = containerName(row.companion, /^mihomo-(?:main|[1-9]\d{4,11})$/u)
    if (companion && !container || container !== undefined && container !== 'napcat' && !container.endsWith('-' + row.accountId)) {
      throw new Error('QQ 托管容器与账号绑定不一致')
    }
    const credential = options.env[row.tokenEnv]
    if (enabled && options.requireCredentials && !credential) throw new Error('QQ 登录服务缺少 NapCat WebUI 令牌')
    if (credential && !/^[\x21-\x7e]{6,1024}$/u.test(credential)) throw new Error('NapCat WebUI 令牌格式无效')
    return Object.freeze({ connectionId: row.connectionId, accountId: row.accountId, port: row.port, tokenEnv: row.tokenEnv,
      ...(container ? { container } : {}), ...(companion ? { companion } : {}) })
  })
  if (new Set(qqLogin.map(item => item.connectionId)).size !== qqLogin.length ||
      new Set(qqLogin.map(item => item.port)).size !== qqLogin.length ||
      new Set(qqLogin.flatMap(item => item.container ? [item.container] : [])).size !== qqLogin.filter(item => item.container).length) throw new Error('QQ 登录连接、本机端口和容器不能重复')
  const file = (key: string, fallback?: string): string => {
    const value = raw[key] ?? fallback
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`console.${key} 路径无效`)
    return path.resolve(options.directory, value)
  }
  return Object.freeze({ enabled, host, port: Number(port),
    frontendDir: file('frontendDir', fileURLToPath(new URL('../../../console/frontend/dist/', import.meta.url))), userFile: file('userFile', path.join(options.dataDir, 'console', 'users.json')),
    ...(tokenEnv ? { tokenEnv } : {}), ...(raw.legacyUserFile === undefined ? {} : { legacyUserFile: file('legacyUserFile') }),
    allowSetup: raw.allowSetup === true, secureCookies: raw.secureCookies === true, qqLogin: Object.freeze(qqLogin) })
}
