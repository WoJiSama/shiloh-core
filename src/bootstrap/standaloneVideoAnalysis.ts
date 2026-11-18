import type { AgentVideoAnalysisConfig } from '../modules/media/infrastructure/agentVideoAnalysis.js'
import { validateAgentVideoUploadHosts } from '../modules/media/infrastructure/agentVideoAnalysis.js'

/** Explicit service authority; disabled declarations never resolve environment credentials. */
export function readStandaloneVideoAnalysisConfig(value: unknown, env: NodeJS.ProcessEnv, requireCredentials = true): AgentVideoAnalysisConfig | undefined {
  if (value === undefined) return undefined
  const fail = () => new Error('tools.videoAnalysis 配置无效')
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['enabled', 'baseUrl', 'name', 'apiKeyEnv', 'inputMode', 'uploadHosts'].includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw fail()
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean' || raw.inputMode !== undefined && !['inline', 'bigmodel-upload'].includes(raw.inputMode as string)) throw fail()
  if (raw.uploadHosts !== undefined && (!Array.isArray(raw.uploadHosts) || raw.uploadHosts.some(host => typeof host !== 'string'))) throw fail()
  const uploadHosts = raw.uploadHosts === undefined ? undefined : validateAgentVideoUploadHosts(raw.uploadHosts as string[])
  let baseUrl: string | undefined, name: string | undefined, reference: string | undefined
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== 'string' || !raw.baseUrl || raw.baseUrl.length > 2048 || /[\s\\?#\u0000-\u001f\u007f]/u.test(raw.baseUrl)) throw fail()
    let endpoint: URL; try { endpoint = new URL(raw.baseUrl) } catch { throw fail() }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fail()
    baseUrl = endpoint.href
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(raw.name)) throw fail()
    name = raw.name.trim()
  }
  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(raw.apiKeyEnv)) throw fail()
    reference = raw.apiKeyEnv
  }
  if (!raw.enabled) return undefined
  if (!baseUrl || !name || !reference) throw new Error('启用 tools.videoAnalysis 需要 baseUrl、name 和 apiKeyEnv')
  const apiKey = env[reference]?.trim() ?? ''
  if (requireCredentials && !apiKey) throw new Error(`环境变量 ${reference} 缺少视频分析 API Key`)
  if (apiKey && !/^[\x21-\x7e]{1,8192}$/u.test(apiKey)) throw fail()
  return Object.freeze({ enabled: true, baseUrl, name, apiKey, inputMode: (raw.inputMode as 'inline' | 'bigmodel-upload' | undefined) ?? 'inline',
    ...(uploadHosts ? { uploadHosts } : {}),
  })
}
