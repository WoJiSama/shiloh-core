import type { AgentVoiceConfig, VoiceStyle } from '../modules/media/infrastructure/agentVoiceProvider.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tools.voice 配置应为对象')
  return value as Record<string, unknown>
}
const styleKeys = ['format', 'voiceType', 'sampleRate', 'speedRatio', 'pitchRatio', 'volumeRatio', 'emotion', 'prompt', 'resourceId']
function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
}
function style(input: Record<string, unknown>): VoiceStyle {
  const result: Record<string, unknown> = {}
  for (const key of styleKeys) {
    const value = input[key]
    if (value === undefined) continue
    if (key === 'format') {
      if (!['mp3', 'wav', 'ogg'].includes(String(value)) || typeof value !== 'string') throw new Error('tools.voice.format 仅支持 mp3、wav、ogg')
    } else if (['sampleRate', 'speedRatio', 'pitchRatio', 'volumeRatio'].includes(key)) {
      const [minimum, maximum] = key === 'sampleRate' ? [8000, 48000] : key === 'volumeRatio' ? [0.1, 3] : [0.5, 2]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum! || value > maximum! || key === 'sampleRate' && !Number.isInteger(value)) throw new Error(`tools.voice.${key} 超出允许范围`)
    } else if (!text(value, key === 'prompt' ? 1000 : 256, key === 'prompt' || key === 'emotion')) throw new Error(`tools.voice.${key} 必须是有界文本`)
    result[key] = value
  }
  return result as VoiceStyle
}

/** Credentials are resolved only for enabled voice; disabled declarations are still validated. */
export function readStandaloneVoiceConfig(value: unknown, env: NodeJS.ProcessEnv, requireCredentials: boolean): AgentVoiceConfig | undefined {
  if (value === undefined) return undefined
  const input = object(value)
  const keys = [...styleKeys.filter(key => key !== 'prompt'), 'enabled', 'provider', 'endpoint', 'appId', 'accessTokenEnv', 'authorizationEnv', 'uid', 'stylePrompt', 'maxTextLength', 'styles']
  if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.enabled !== 'boolean') throw new Error('tools.voice 含不支持字段或缺少布尔字段 enabled')
  if (input.provider !== undefined && input.provider !== 'volcengine') throw new Error('tools.voice.provider 仅支持 volcengine')
  const base = style(input)
  const enabled = input.enabled
  const decoded: Record<string, unknown> = { ...base, enabled, provider: 'volcengine' }
  if (input.endpoint !== undefined) {
    let endpoint: URL
    try { endpoint = new URL(String(input.endpoint)) } catch { throw new Error('tools.voice.endpoint 必须是 HTTP(S) URL') }
    if (!text(input.endpoint, 2048) || /[\s\\?#]/u.test(input.endpoint) || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('tools.voice.endpoint 不支持凭据、查询参数或片段')
    decoded.endpoint = endpoint.href
  }
  for (const key of ['appId', 'uid', 'stylePrompt']) if (input[key] !== undefined) {
    if (!text(input[key], key === 'stylePrompt' ? 1000 : 128, key === 'stylePrompt')) throw new Error(`tools.voice.${key} 必须是有界文本`)
    decoded[key] = input[key]
  }
  if (input.maxTextLength !== undefined) {
    if (typeof input.maxTextLength !== 'number' || !Number.isInteger(input.maxTextLength) || input.maxTextLength < 8 || input.maxTextLength > 300) throw new Error('tools.voice.maxTextLength 必须是 8–300 的整数')
    decoded.maxTextLength = input.maxTextLength
  }
  for (const [key, field] of [['accessTokenEnv', 'accessToken'], ['authorizationEnv', 'authorization']] as const) {
    const reference = input[key]
    if (reference !== undefined && (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference))) throw new Error(`tools.voice.${key} 必须引用环境变量名`)
    if (reference !== undefined && enabled) {
      const credential = env[String(reference)]?.trim() || ''
      if (requireCredentials && !credential) throw new Error(`环境变量 ${reference} 缺少语音服务凭据`)
      if (credential && !/^[\x21-\x7e]{1,8192}$/u.test(credential)) throw new Error('语音服务凭据格式或长度无效')
      decoded[field] = credential
    }
  }
  if (input.styles !== undefined) {
    const styles = object(input.styles), entries = Object.entries(styles)
    if (entries.length > 32 || entries.some(([key]) => !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(key))) throw new Error('tools.voice.styles 样式名或数量无效')
    decoded.styles = Object.fromEntries(entries.map(([name, value]) => {
      const entry = object(value)
      if (Object.keys(entry).some(key => !styleKeys.includes(key))) throw new Error('tools.voice.styles 含不支持的字段')
      return [name, style(entry)]
    }))
  }
  if (enabled && (!input.appId || !input.accessTokenEnv || !input.resourceId || !input.voiceType)) throw new Error('启用 tools.voice 需要 appId、accessTokenEnv、resourceId 和 voiceType')
  return enabled ? decoded as unknown as AgentVoiceConfig : undefined
}
