import type { AgentLocalEmojiModel } from '../contracts/agentLocalEmoji.js'
import type { AgentLocalEmojiRuntimeOptions } from '../modules/emoji/infrastructure/agentLocalEmojiRuntime.js'

const fail = () => new Error('tools.localEmoji 配置无效')
const booleanFields = ['autoCollect', 'visionTagOnAdd', 'vlmGifStrip', 'useEmbedding', 'contentFiltration', 'contentSafetyFilter',
  'doReplace', 'enableMaintenance', 'stalePruneEnabled', 'avoidRecentEnabled', 'rateLimitEnabled', 'sendAsSticker'] as const
const integers: Readonly<Record<string, readonly [number, number]>> = { maxItems: [1, 10000], selectionTopK: [1, 100], checkIntervalMinutes: [1, 10080],
  staleDays: [1, 3650], staleCandidatePoolSize: [1, 10000], stalePruneCount: [0, 10000], minItemsToKeep: [0, 10000],
  avoidRecentCount: [0, 10000], avoidRecentTtlMinutes: [0, 10080], followUpDelayMinMs: [0, 10000], followUpDelayMaxMs: [0, 10000],
  rateLimitWindowMinutes: [1, 10080], rateLimitMaxPerWindow: [1, 10000] }
const fractions = ['embeddingThreshold', 'contentFilterMinConfidence', 'familiarityBias']
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail()
  return value as Record<string, unknown>
}
export interface StandaloneLocalEmojiConfig {
  readonly enabled: boolean
  readonly config: AgentLocalEmojiRuntimeOptions['config']
  readonly analysis?: AgentLocalEmojiModel
  readonly embedding?: AgentLocalEmojiModel
  readonly tools?: AgentLocalEmojiModel
}
export function readStandaloneLocalEmojiConfig(value: unknown, env: NodeJS.ProcessEnv, requireCredentials: boolean): StandaloneLocalEmojiConfig {
  if (value === undefined) return Object.freeze({ enabled: false, config: {} })
  const input = object(value)
  if (Object.keys(input).some(key => !['enabled', 'config', 'analysis', 'embedding', 'tools'].includes(key)) || typeof input.enabled !== 'boolean') throw fail()
  const config = input.config === undefined ? {} : object(input.config)
  for (const [key, value] of Object.entries(config)) {
    if ((booleanFields as readonly string[]).includes(key)) { if (typeof value !== 'boolean') throw fail() }
    else if (integers[key]) { const [min, max] = integers[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw fail() }
    else if (fractions.includes(key)) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw fail() }
    else if (['admissionExtraAllow', 'admissionExtraReject'].includes(key)) {
      if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string' || item.length > 512)) throw fail()
    } else throw fail()
  }
  if (Number(config.followUpDelayMinMs ?? 300) > Number(config.followUpDelayMaxMs ?? 1200)) throw fail()
  const model = (value: unknown, embedding: boolean): AgentLocalEmojiModel | undefined => {
    if (value === undefined) return undefined
    const row = object(value)
    if (Object.keys(row).some(key => !['baseUrl', 'name', 'apiKeyEnv'].includes(key)) ||
        typeof row.baseUrl !== 'string' || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 ||
        typeof row.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(row.apiKeyEnv)) throw fail()
    const url = new URL(row.baseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        embedding && !url.pathname.endsWith('/embeddings')) throw fail()
    const apiKey = env[row.apiKeyEnv]?.trim() ?? ''
    if (requireCredentials && !apiKey) throw new Error(`环境变量 ${row.apiKeyEnv} 缺少本地表情模型凭据`)
    return Object.freeze({ baseUrl: url.href, model: row.name.trim(), apiKey })
  }
  const analysis = model(input.analysis, false), embedding = model(input.embedding, true), tools = model(input.tools, false)
  if (input.enabled && ((config.contentFiltration !== false || config.visionTagOnAdd !== false) && !analysis ||
      config.useEmbedding !== false && !embedding || config.doReplace === true && !tools)) throw fail()
  return Object.freeze({ enabled: input.enabled, config: Object.freeze(structuredClone(config)),
    ...(analysis ? { analysis } : {}), ...(embedding ? { embedding } : {}), ...(tools ? { tools } : {}) })
}
