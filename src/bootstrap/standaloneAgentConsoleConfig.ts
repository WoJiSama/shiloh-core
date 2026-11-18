import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
}

export function readStandaloneAgentConsoleConfig(value: unknown, options: {
  directory: string; dataDir: string; env: Readonly<Record<string, string | undefined>>; requireCredentials: boolean
}): StandaloneAgentConsoleConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('console 必须是配置对象')
  const raw = (value ?? {}) as Record<string, unknown>
  if (Object.keys(raw).some(key => !['enabled', 'host', 'port', 'frontendDir', 'userFile', 'tokenEnv', 'legacyUserFile', 'allowSetup', 'secureCookies'].includes(key)) ||
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
  const file = (key: string, fallback?: string): string => {
    const value = raw[key] ?? fallback
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`console.${key} 路径无效`)
    return path.resolve(options.directory, value)
  }
  return Object.freeze({ enabled, host, port: Number(port),
    frontendDir: file('frontendDir', fileURLToPath(new URL('../../../console/frontend/dist/', import.meta.url))), userFile: file('userFile', path.join(options.dataDir, 'console', 'users.json')),
    ...(tokenEnv ? { tokenEnv } : {}), ...(raw.legacyUserFile === undefined ? {} : { legacyUserFile: file('legacyUserFile') }),
    allowSetup: raw.allowSetup === true, secureCookies: raw.secureCookies === true })
}
