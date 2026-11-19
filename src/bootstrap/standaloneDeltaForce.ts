import type { AgentDeltaForceConfig } from '../modules/games/infrastructure/agentDeltaForceTools.js'

/** Explicit host configuration only; never reads a legacy file or credential from cwd. */
export function readStandaloneDeltaForceConfig(value: unknown, env: NodeJS.ProcessEnv, requireCredentials = true): AgentDeltaForceConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tools.deltaForce 配置无效')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['enabled', 'apiBaseUrl', 'apiKeyEnv', 'timeoutMs', 'objectCacheEnabled', 'objectCacheRefreshMinutes'].includes(key)) || typeof raw.enabled !== 'boolean') throw new Error('tools.deltaForce 含不支持的字段')
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const selected = raw[key] ?? fallback
    if (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`tools.deltaForce.${key} 超出范围`)
    return selected
  }
  const timeoutMs = integer('timeoutMs', 10_000, 1000, 60_000), objectCacheRefreshMinutes = integer('objectCacheRefreshMinutes', 360, 10, 1440)
  if (raw.objectCacheEnabled !== undefined && typeof raw.objectCacheEnabled !== 'boolean') throw new Error('tools.deltaForce.objectCacheEnabled 应为布尔值')
  if (!raw.enabled) return undefined
  if (typeof raw.apiBaseUrl !== 'string' || raw.apiBaseUrl.length > 2048 || /[\s\\]/u.test(raw.apiBaseUrl)) throw new Error('tools.deltaForce.apiBaseUrl 无效')
  let url: URL
  try { url = new URL(raw.apiBaseUrl) } catch { throw new Error('tools.deltaForce.apiBaseUrl 无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('tools.deltaForce.apiBaseUrl 不接受凭据、查询参数或片段')
  if (typeof raw.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(raw.apiKeyEnv)) throw new Error('tools.deltaForce.apiKeyEnv 必须引用环境变量名')
  const apiKey = env[raw.apiKeyEnv] ?? ''
  if (apiKey && !/^[\x21-\x7e]{1,8192}$/u.test(apiKey) || !apiKey && requireCredentials) throw new Error('tools.deltaForce 的环境变量凭据缺失或无效')
  return { enabled: true, apiBaseUrl: url.href.replace(/\/+$/u, ''), apiKey, timeoutMs, objectCacheEnabled: raw.objectCacheEnabled !== false, objectCacheRefreshMinutes }
}
