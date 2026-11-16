import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import type { ConversationAddress, PlatformConnection } from '../contracts/agentBinding.js'
import type { ExecutionConfig } from '../contracts/modelExecution.js'
import type { SimulationSection } from '../contracts/simulation.js'
import type { TextPersonMemoryConfig } from '../contracts/textPersonMemory.js'
import type { MidtermMemoryConfig, EpisodicMemoryConfig } from '../contracts/conversationMemory.js'
import type { GroupMemoryConfig } from '../contracts/groupMemory.js'
import type { AgentSemanticMemoryConfig } from '../contracts/semanticMemory.js'
import type { AgentHistoryConfig } from '../contracts/agentHistory.js'
import type { AgentImageBackend } from '../modules/tools/infrastructure/agentImageTools.js'
import type { AgentRenderingConfig } from '../modules/tools/infrastructure/agentRenderingTools.js'
import type { AgentMcpServerConfig } from '../modules/tools/infrastructure/agentMcpTools.js'
import { parseOneBotReverseUrl, parseOneBotUrl } from '../adapters/oneBotConnection.js'
import { qqId, validateQqBindingAddress } from '../adapters/qqIdentity.js'
import { createPersonaLibrary } from '../modules/conversation/infrastructure/personaLibrary.js'
import { decodeHostConfig } from '../modules/host/infrastructure/hostConfig.js'
import type { ForbiddenConfig } from '../modules/conversation/domain/forbiddenWordGuard.js'
import { resolveConfiguredAgentPersona } from '../modules/runtime/application/agentPersona.js'
import { conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { groupTextToolNames, type GroupTextToolName } from '../modules/conversation/infrastructure/groupTextTools.js'
import { createAgentBindingConfig } from '../modules/runtime/infrastructure/agentBindingConfig.js'
import { readStandaloneVoiceConfig } from './standaloneVoiceConfig.js'
import type { PersonaGuardConfig } from '../contracts/persona.js'
import type { AgentMusicConfig } from '../modules/media/infrastructure/agentMusicProvider.js'
import { validateMusicExtractionConfig } from '../modules/media/domain/musicExtractionConfig.js'
import { readStandaloneMediaRelayConfig } from './standaloneMediaRelay.js'
import { readStandaloneTorrentConfig } from './standaloneTorrent.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('独立宿主配置应为对象')
  return value as Record<string, unknown>
}

function envName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value)) throw new Error('凭据必须引用环境变量名')
  return value
}

function readModel(value: unknown, section: 'model' | 'vision' | 'characterConsistency' | 'personMemoryExtraction' | 'midtermSummary' | 'groupMemoryExtraction' | 'tools.search' | 'tools.images.generation' | 'tools.images.edit' | 'tools.modrinth.translation' | 'tools.rendering.mindMap', env: NodeJS.ProcessEnv, requireCredentials: boolean) {
  const model = object(value)
  if (['characterConsistency', 'personMemoryExtraction', 'midtermSummary', 'groupMemoryExtraction'].includes(section) && Object.keys(model).some(key => !['baseUrl', 'name', 'apiKeyEnv'].includes(key))) {
    throw new Error(`${section} 仅支持 baseUrl、name 和 apiKeyEnv`)
  }
  let apiUrl: URL
  try { apiUrl = new URL(typeof model.baseUrl === 'string' ? model.baseUrl : '') } catch { throw new Error(`${section}.baseUrl 必须是有效的模型服务 URL`) }
  if (!['http:', 'https:'].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) throw new Error(`${section}.baseUrl 不支持凭据、查询参数或片段`)
  if (typeof model.name !== 'string' || !model.name.trim()) throw new Error(`${section}.name 必须指定模型`)
  const keyName = envName(model.apiKeyEnv)
  const apiKey = env[keyName]?.trim() || ''
  if (!apiKey && requireCredentials) throw new Error(`环境变量 ${keyName} 缺少模型 API Key`)
  return { apiUrl: apiUrl.href, model: model.name.trim(), apiKey, apiKeyEnv: keyName }
}

function readMemorySection(value: unknown, section: string, booleans: readonly string[], integers: Readonly<Record<string, readonly [number, number]>>) {
  const config = value === undefined ? {} : object(value)
  if (Object.keys(config).some(key => !booleans.includes(key) && !Object.hasOwn(integers, key))) throw new Error(`${section} 包含不支持的字段`)
  for (const key of booleans) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${section}.${key} 必须是布尔值`)
  }
  for (const [key, [minimum, maximum]] of Object.entries(integers)) {
    const value = config[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)) {
      throw new Error(`${section}.${key} 必须是 ${minimum}–${maximum} 的整数`)
    }
  }
  return config
}

function readHistory(value: unknown): Required<AgentHistoryConfig> {
  const input: AgentHistoryConfig = readMemorySection(value, 'history', ['enabled'], {
    retentionDays: [1, 90], maxMessagesPerConversation: [50, 2000], timeoutMs: [100, 30_000],
  })
  return {
    enabled: input.enabled === true,
    retentionDays: input.retentionDays ?? 30,
    maxMessagesPerConversation: input.maxMessagesPerConversation ?? 1000,
    timeoutMs: input.timeoutMs ?? 5000,
  }
}

interface StandaloneSemanticModel {
  baseUrl: string
  name: string
  apiKey: string
  apiKeyEnv: string
}

export interface StandaloneSemanticMemoryConfig extends Required<AgentSemanticMemoryConfig> {
  embedding?: StandaloneSemanticModel
  rerank?: StandaloneSemanticModel
}

function readSemanticMemory(value: unknown, env: NodeJS.ProcessEnv, requireCredentials: boolean): StandaloneSemanticMemoryConfig {
  const input = value === undefined ? {} : object(value)
  const allowed = ['enabled', 'retentionDays', 'maxMessagesPerConversation', 'topK', 'minScore', 'timeoutMs', 'embedding', 'rerank']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('semanticMemory 包含不支持的字段')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('semanticMemory.enabled 必须是布尔值')
  const enabled = input.enabled === true
  function integer(key: string, minimum: number, maximum: number, fallback: number): number {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`semanticMemory.${key} 必须是 ${minimum}–${maximum} 的整数`)
    }
    return value
  }
  const minScore = input.minScore === undefined ? 0.35 : input.minScore
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error('semanticMemory.minScore 必须是 0–1 的有限数值')
  function backend(operation: 'embedding' | 'rerank'): StandaloneSemanticModel | undefined {
    if (input[operation] === undefined) return undefined
    const model = object(input[operation])
    const section = `semanticMemory.${operation}`
    if (Object.keys(model).some(key => !['baseUrl', 'name', 'apiKeyEnv'].includes(key))) throw new Error(`${section} 仅支持 baseUrl、name 和 apiKeyEnv`)
    let endpoint: URL
    try { endpoint = new URL(typeof model.baseUrl === 'string' ? model.baseUrl : '') } catch { throw new Error(`${section}.baseUrl 必须是有效的 HTTP(S) endpoint`) }
    const suffix = operation === 'embedding' ? '/embeddings' : '/rerank'
    if (typeof model.baseUrl !== 'string' || model.baseUrl.length > 2048 || /[\s\\?#]/u.test(model.baseUrl) ||
        !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith(suffix)) {
      throw new Error(`${section}.baseUrl 必须显式指向 ${suffix}，不支持凭据、查询参数或片段`)
    }
    if (typeof model.name !== 'string' || !model.name.trim() || model.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(model.name)) throw new Error(`${section}.name 必须指定有界模型名称`)
    const keyName = envName(model.apiKeyEnv)
    // A disabled feature validates declarations without reading credentials.
    const apiKey = enabled ? env[keyName]?.trim() || '' : ''
    if (enabled && requireCredentials && !apiKey) throw new Error(`环境变量 ${keyName} 缺少语义记忆 API Key`)
    if (apiKey.length > 8192 || /[\u0000-\u001f\u007f]/u.test(apiKey)) throw new Error(`${section} API Key 格式或长度无效`)
    return { baseUrl: endpoint.href, name: model.name.trim(), apiKey, apiKeyEnv: keyName }
  }
  const embedding = backend('embedding'), rerank = backend('rerank')
  if (enabled && !embedding) throw new Error('启用 semanticMemory.enabled 需要显式配置 embedding')
  return {
    enabled,
    retentionDays: integer('retentionDays', 1, 90, 30),
    maxMessagesPerConversation: integer('maxMessagesPerConversation', 50, 2000, 1000),
    topK: integer('topK', 1, 10, 5), minScore,
    timeoutMs: integer('timeoutMs', 200, 5000, 1000),
    ...(embedding ? { embedding } : {}), ...(rerank ? { rerank } : {}),
  }
}

function readMcp(value: unknown, env: NodeJS.ProcessEnv, requireCredentials: boolean, directory: string): { servers: Readonly<Record<string, AgentMcpServerConfig>> } | undefined {
  type DecodedServer = { -readonly [Key in keyof AgentMcpServerConfig]: AgentMcpServerConfig[Key] }
  const config = object(value)
  if (Object.keys(config).some(key => key !== 'servers')) throw new Error('tools.mcp 仅支持 servers')
  const servers = Object.entries(object(config.servers))
  if (servers.length > 8) throw new Error('MCP 最多配置 8 个服务器')
  const active: [string, AgentMcpServerConfig][] = []
  const bounded = (input: unknown, maximum: number, allowEmpty = false): input is string => typeof input === 'string' &&
    input.length <= maximum && (allowEmpty || input.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(input)
  for (const [name, value] of servers) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/u.test(name)) throw new Error('MCP 服务器名称无效')
    const server = object(value)
    const common = ['type', 'enabled', 'includeTools', 'excludeTools', 'connectTimeoutMs', 'toolCallTimeoutMs', 'autoReconnect', 'reconnectMaxAttempts']
    if (typeof server.type !== 'string' || !['stdio', 'http', 'sse'].includes(server.type)) throw new Error('MCP type 只接受 stdio、http 或 sse')
    const stdio = server.type === 'stdio'
    const allowed = [...common, ...(stdio ? ['command', 'args', 'cwd', 'envFrom'] : ['baseUrl', 'headersFromEnv'])]
    if (Object.keys(server).some(key => !allowed.includes(key))) throw new Error('MCP 服务器包含不支持的字段')
    for (const key of ['enabled', 'autoReconnect']) {
      if (server[key] !== undefined && typeof server[key] !== 'boolean') throw new Error(`MCP ${key} 必须是布尔值`)
    }
    const decoded: DecodedServer = { type: server.type as AgentMcpServerConfig['type'] }
    for (const key of ['includeTools', 'excludeTools'] as const) {
      const names = server[key]
      if (names === undefined) continue
      if (!Array.isArray(names) || names.length > 128 || names.some(item => !bounded(item, 128)) || new Set(names).size !== names.length) {
        throw new Error(`MCP ${key} 必须为不超过 128 个唯一非空工具名`)
      }
      decoded[key] = [...names] as string[]
    }
    for (const [key, maximum] of [['connectTimeoutMs', 30_000], ['toolCallTimeoutMs', 120_000], ['reconnectMaxAttempts', 3]] as const) {
      const number = server[key]
      if (number === undefined) continue
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (key === 'reconnectMaxAttempts' ? 0 : 100) || number > maximum) {
        throw new Error(`MCP ${key} 超出允许的整数范围`)
      }
      decoded[key] = number
    }
    if (typeof server.autoReconnect === 'boolean') decoded.autoReconnect = server.autoReconnect
    if (stdio) {
      if (!bounded(server.command, 4096)) throw new Error('MCP stdio.command 必须是有界非空字符串')
      decoded.command = server.command
      if (server.args !== undefined) {
        if (!Array.isArray(server.args) || server.args.length > 128 || server.args.some(item => !bounded(item, 4096, true))) throw new Error('MCP stdio.args 必须是不超过 128 项的有界字符串数组')
        decoded.args = [...server.args] as string[]
      }
      if (server.cwd !== undefined) {
        if (!bounded(server.cwd, 4096)) throw new Error('MCP stdio.cwd 必须是有界非空路径')
        decoded.cwd = path.resolve(directory, server.cwd)
      }
    } else {
      if (!bounded(server.baseUrl, 2048) || /[\s?#\\]/u.test(server.baseUrl)) throw new Error('MCP baseUrl 必须是有界 HTTP(S) URL')
      let url: URL
      try { url = new URL(server.baseUrl) } catch { throw new Error('MCP baseUrl 必须是有效的 HTTP(S) URL') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('MCP baseUrl 不支持凭据、查询参数或片段')
      decoded.baseUrl = url.href
    }
    const references = stdio ? server.envFrom : server.headersFromEnv
    if (references !== undefined) {
      const entries = Object.entries(object(references))
      if (entries.length > 32) throw new Error('MCP 环境变量映射最多 32 项')
      const resolved: [string, string][] = [], seen = new Set<string>()
      for (const [destination, reference] of entries) {
        if (stdio) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(destination)) throw new Error('MCP envFrom 目标变量名无效')
        } else {
          const lower = destination.toLowerCase()
          if (destination.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(destination) ||
              /^(?:host|content-length|cookie|set-cookie|connection|transfer-encoding|te|trailer|upgrade|expect|content-type|accept|proxy-authorization|proxy-authenticate|forwarded|last-event-id|mcp-session-id|mcp-protocol-version)$/u.test(lower) ||
              /^(?:sec-|proxy-|x-forwarded-|mcp-)/u.test(lower) || seen.has(lower)) throw new Error('MCP headersFromEnv 含无效、重复或保留的传输头')
          seen.add(lower)
        }
        const source = envName(reference)
        if (server.enabled === false) continue
        const secret = env[source] ?? ''
        if (!secret.trim() && requireCredentials) throw new Error(`环境变量 ${source} 缺少 MCP 凭据`)
        if (secret.length > (stdio ? 32_768 : 8192) || (stdio ? /\u0000/u : /[\u0000-\u001f\u007f]/u).test(secret)) throw new Error('MCP 环境变量内容格式或长度无效')
        resolved.push([destination, stdio ? secret : secret.trim()])
      }
      if (server.enabled !== false) {
        if (stdio) decoded.env = Object.fromEntries(resolved)
        else decoded.headers = Object.fromEntries(resolved)
      }
    }
    if (server.enabled !== false) active.push([name, decoded])
  }
  return active.length ? { servers: Object.fromEntries(active) } : undefined
}

function readTools(value: unknown, env: NodeJS.ProcessEnv, requireCredentials: boolean, directory: string) {
  const config = value === undefined ? {} : object(value)
  if (Object.keys(config).some(key => !['search', 'web', 'images', 'mcp', 'github', 'modrinth', 'rendering', 'excel', 'files', 'voice', 'music'].includes(key))) throw new Error('tools 仅支持 search、web、images、mcp、github、modrinth、rendering、excel、files、voice 和 music')
  const voice = readStandaloneVoiceConfig(config.voice, env, requireCredentials)
  let music: AgentMusicConfig | undefined
  if (config.music !== undefined) {
    const input = object(config.music)
    if (Object.keys(input).some(key => !['enabled', 'cookieEnv'].includes(key)) || typeof input.enabled !== 'boolean') throw new Error('tools.music 仅支持布尔字段 enabled 和可选 cookieEnv')
    const reference = input.cookieEnv === undefined ? undefined : envName(input.cookieEnv)
    if (input.enabled) {
      const cookie = reference ? env[reference]?.trim() || '' : ''
      if (reference && requireCredentials && !cookie) throw new Error(`环境变量 ${reference} 缺少 QQ 音乐 Cookie`)
      if (cookie && !/^[\x20-\x7e]{1,32768}$/u.test(cookie)) throw new Error('QQ 音乐 Cookie 格式或长度无效')
      music = { enabled: true, ...(cookie ? { cookie } : {}) }
    }
  }
  let files: { enabled: true; nativeFormats: ('doc' | 'rtf' | 'ocr' | 'dxf')[] } | undefined
  if (config.files !== undefined) {
    const input = object(config.files)
    if (Object.keys(input).some(key => !['enabled', 'nativeFormats'].includes(key)) || typeof input.enabled !== 'boolean') throw new Error('tools.files 仅支持布尔字段 enabled 和 nativeFormats')
    const nativeFormats = input.nativeFormats ?? []
    if (!Array.isArray(nativeFormats) || nativeFormats.length > 4 || new Set(nativeFormats).size !== nativeFormats.length ||
        nativeFormats.some(format => typeof format !== 'string' || !['doc', 'rtf', 'ocr', 'dxf'].includes(format))) throw new Error('tools.files.nativeFormats 仅支持不重复的 doc、rtf、ocr、dxf')
    if (input.enabled) files = { enabled: true, nativeFormats: [...nativeFormats] }
  }
  let excel: { enabled: true } | undefined
  if (config.excel !== undefined) {
    const input = object(config.excel)
    if (Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') throw new Error('tools.excel 仅支持布尔字段 enabled')
    if (input.enabled) excel = { enabled: true }
  }
  let rendering: AgentRenderingConfig | undefined
  if (config.rendering !== undefined) {
    const input = object(config.rendering)
    if (Object.keys(input).some(key => !['textImage', 'mindMap'].includes(key))) throw new Error('tools.rendering 仅支持 textImage 和 mindMap')
    let textImage: { enabled: true } | undefined
    if (input.textImage !== undefined) {
      const section = object(input.textImage)
      if (Object.keys(section).some(key => key !== 'enabled') || typeof section.enabled !== 'boolean') throw new Error('tools.rendering.textImage 仅支持布尔字段 enabled')
      if (section.enabled) textImage = { enabled: true }
    }
    let mindMap: AgentRenderingConfig['mindMap']
    if (input.mindMap !== undefined) {
      const section = object(input.mindMap)
      if (Object.keys(section).some(key => !['baseUrl', 'name', 'apiKeyEnv'].includes(key))) throw new Error('tools.rendering.mindMap 仅支持 baseUrl、name 和 apiKeyEnv')
      const model = readModel(section, 'tools.rendering.mindMap', env, requireCredentials)
      if (model.apiUrl.length > 2048 || /[\s\\]/u.test(String(section.baseUrl)) || model.model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model.model) ||
          model.apiKey && !/^[\x21-\x7e]{1,8192}$/u.test(model.apiKey)) throw new Error('思维导图模型名称或凭据格式无效')
      mindMap = { baseUrl: model.apiUrl, name: model.model, apiKey: model.apiKey }
    }
    if (textImage || mindMap) rendering = { ...(textImage ? { textImage } : {}), ...(mindMap ? { mindMap } : {}) }
  }
  let modrinth: { enabled: true; translation: { baseUrl: string; name: string; apiKey: string } } | undefined
  if (config.modrinth !== undefined) {
    const input = object(config.modrinth)
    if (Object.keys(input).some(key => !['enabled', 'translation'].includes(key)) || typeof input.enabled !== 'boolean') throw new Error('tools.modrinth 仅支持布尔字段 enabled 和 translation')
    let translation: { baseUrl: string; name: string; apiKey: string } | undefined
    if (input.translation !== undefined) {
      const backend = object(input.translation)
      if (Object.keys(backend).some(key => !['baseUrl', 'name', 'apiKeyEnv'].includes(key))) throw new Error('tools.modrinth.translation 仅支持 baseUrl、name 和 apiKeyEnv')
      // Validate disabled declarations without resolving their credentials.
      const model = readModel(backend, 'tools.modrinth.translation', input.enabled ? env : {}, input.enabled && requireCredentials)
      if (model.model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model.model) || model.apiKey.length > 8192 || /[\u0000-\u001f\u007f]/u.test(model.apiKey)) throw new Error('Modrinth 翻译模型名称或凭据格式无效')
      translation = { baseUrl: model.apiUrl, name: model.model, apiKey: model.apiKey }
    }
    if (input.enabled) {
      if (!translation) throw new Error('启用 tools.modrinth 需要显式 translation 模型')
      modrinth = { enabled: true, translation }
    }
  }
  let github: { enabled: true; token?: string } | undefined
  if (config.github !== undefined) {
    const input = object(config.github)
    if (Object.keys(input).some(key => !['enabled', 'tokenEnv'].includes(key)) || typeof input.enabled !== 'boolean') throw new Error('tools.github 仅支持布尔字段 enabled 和可选 tokenEnv')
    const tokenReference = input.tokenEnv === undefined ? undefined : envName(input.tokenEnv)
    if (input.enabled) {
      const token = tokenReference ? env[tokenReference] ?? '' : ''
      if (tokenReference && !token && requireCredentials) throw new Error(`环境变量 ${tokenReference} 缺少 GitHub 凭据`)
      if (token && !/^[\x21-\x7e]{1,8192}$/u.test(token)) throw new Error('GitHub 凭据格式或长度无效')
      github = { enabled: true, ...(token ? { token } : {}) }
    }
  }
  let search: { baseUrl: string; name: string; apiKey: string; webSearch?: 'auto' | 'on' | 'off' } | undefined
  if (config.search !== undefined) {
    const input = object(config.search)
    if (Object.keys(input).some(key => !['baseUrl', 'name', 'apiKeyEnv', 'webSearch'].includes(key))) {
      throw new Error('tools.search 仅支持 baseUrl、name、apiKeyEnv 和 webSearch')
    }
    const webSearch = input.webSearch
    if (webSearch !== undefined && webSearch !== 'auto' && webSearch !== 'on' && webSearch !== 'off') {
      throw new Error('tools.search.webSearch 只接受 auto、on 或 off')
    }
    const model = readModel(input, 'tools.search', env, requireCredentials)
    search = { baseUrl: model.apiUrl, name: model.model, apiKey: model.apiKey, ...(webSearch === undefined ? {} : { webSearch }) }
  }
  let web: { enabled: true } | undefined
  if (config.web !== undefined) {
    const input = object(config.web)
    if (Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') {
      throw new Error('tools.web 仅支持布尔字段 enabled')
    }
    if (input.enabled) web = { enabled: true }
  }
  let images: { generation?: AgentImageBackend; edit?: AgentImageBackend } | undefined
  if (config.images !== undefined) {
    const input = object(config.images)
    if (Object.keys(input).some(key => !['generation', 'edit'].includes(key))) throw new Error('tools.images 仅支持 generation 和 edit')
    images = {}
    for (const operation of ['generation', 'edit'] as const) {
      if (input[operation] === undefined) continue
      const backend = object(input[operation])
      if (Object.keys(backend).some(key => !['baseUrl', 'name', 'apiKeyEnv', 'protocol', 'size', 'quality'].includes(key))) throw new Error(`tools.images.${operation} 包含不支持的字段`)
      if (typeof backend.name !== 'string' || !backend.name.trim() || backend.name.length > 200) throw new Error('图片模型名称无效')
      if (backend.protocol !== undefined && (typeof backend.protocol !== 'string' || !['images', 'chat'].includes(backend.protocol))) throw new Error('图片协议只接受 images 或 chat')
      if (backend.size !== undefined && (typeof backend.size !== 'string' || !/^(?:auto|[1-9]\d{0,4}x[1-9]\d{0,4}|[1248]k)$/iu.test(backend.size))) throw new Error('图片尺寸格式无效')
      if (typeof backend.size === 'string' && backend.size.toLowerCase().includes('x')) {
        const [width, height] = backend.size.toLowerCase().split('x').map(Number)
        if (width! > 16_384 || height! > 16_384 || width! * height! > 64 * 1024 * 1024) throw new Error('图片尺寸超过画布上限')
      }
      if (backend.quality !== undefined && (typeof backend.quality !== 'string' || !['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(backend.quality))) throw new Error('图片质量配置无效')
      const selected = readModel(backend, `tools.images.${operation}`, env, requireCredentials)
      images[operation] = { baseUrl: selected.apiUrl, name: selected.model, apiKey: selected.apiKey,
        ...(backend.protocol === undefined ? {} : { protocol: backend.protocol as 'images' | 'chat' }),
        ...(typeof backend.size === 'string' ? { size: backend.size } : {}),
        ...(typeof backend.quality === 'string' ? { quality: backend.quality } : {}),
      }
    }
    if (!Object.keys(images).length) images = undefined
  }
  const mcp = config.mcp === undefined ? undefined : readMcp(config.mcp, env, requireCredentials, directory)
  return { ...(search ? { search } : {}), ...(web ? { web } : {}), ...(images ? { images } : {}), ...(mcp ? { mcp } : {}), ...(github ? { github } : {}), ...(modrinth ? { modrinth } : {}), ...(rendering ? { rendering } : {}), ...(excel ? { excel } : {}), ...(files ? { files } : {}), ...(voice ? { voice } : {}), ...(music ? { music } : {}) }
}

export function readStandaloneAgentConfig(file: string, env: NodeJS.ProcessEnv, options?: { requireCredentials?: boolean }) {
  const directory = path.dirname(file)
  const hostSource = fs.readFileSync(file, 'utf8')
  const document = YAML.parseDocument(hostSource)
  if (document.errors.length) throw new Error(`无法解析 ${path.basename(file)}`)
  const raw = object(document.toJS())
  if (raw.version !== 1 || typeof raw.instance !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.instance)) throw new Error('独立宿主配置需要 version: 1 和有效的 instance')
  const instance = raw.instance
  const dataDir = path.resolve(directory, typeof raw.dataDir === 'string' && raw.dataDir ? raw.dataDir : `data/${instance}`)
  const requireCredentials = options?.requireCredentials !== false
  const { apiUrl, model: modelName, apiKey, apiKeyEnv } = readModel(raw.model, 'model', env, requireCredentials)
  const vision = raw.vision === undefined ? undefined : readModel(raw.vision, 'vision', env, requireCredentials)
  const personMemoryExtraction = raw.personMemoryExtraction === undefined ? undefined
    : readModel(raw.personMemoryExtraction, 'personMemoryExtraction', env, requireCredentials)
  const midtermSummary = raw.midtermSummary === undefined ? undefined
    : readModel(raw.midtermSummary, 'midtermSummary', env, requireCredentials)
  const groupMemoryExtraction = raw.groupMemoryExtraction === undefined ? undefined
    : readModel(raw.groupMemoryExtraction, 'groupMemoryExtraction', env, requireCredentials)
  const groupMemory: GroupMemoryConfig = readMemorySection(raw.groupMemory, 'groupMemory', ['enabled'], {
    groupExtractMinIntervalMinutes: [0, 1440], groupExtractMaxBatchMessages: [1, 40],
  })
  const semanticMemory = readSemanticMemory(raw.semanticMemory, env, requireCredentials)
  const history = readHistory(raw.history)
  const musicExtraction = validateMusicExtractionConfig(raw.musicExtraction)
  const midtermMemory: MidtermMemoryConfig = readMemorySection(raw.midtermMemory, 'midtermMemory', ['enabled'], {
    minMessages: [4, 200], debounceMs: [5000, 3_600_000], maxSummaryChars: [120, 4000], bufferMaxLines: [50, 1000], retentionDays: [1, 30],
  })
  const episodicMemory: EpisodicMemoryConfig = readMemorySection(raw.episodicMemory, 'episodicMemory', ['enabled', 'proactiveEnabled'], {
    maxPerGroup: [20, 1000], recallDays: [1, 30],
  })
  const memorySystem: TextPersonMemoryConfig = raw.memorySystem === undefined ? {} : object(raw.memorySystem)
  if (Object.keys(memorySystem).some(key => !['enabled', 'userExtractDebounceSeconds', 'userExtractMaxBatchMessages'].includes(key)) ||
      (memorySystem.enabled !== undefined && typeof memorySystem.enabled !== 'boolean') ||
      (memorySystem.userExtractDebounceSeconds !== undefined && (!Number.isInteger(memorySystem.userExtractDebounceSeconds) || memorySystem.userExtractDebounceSeconds < 0 || memorySystem.userExtractDebounceSeconds > 3600)) ||
      (memorySystem.userExtractMaxBatchMessages !== undefined && (!Number.isInteger(memorySystem.userExtractMaxBatchMessages) || memorySystem.userExtractMaxBatchMessages < 1 || memorySystem.userExtractMaxBatchMessages > 40))) {
    throw new Error('memorySystem 仅支持 enabled、0–3600 秒防抖和 1–40 条批量上限')
  }
  const tools = readTools(raw.tools, env, requireCredentials, directory)
  const execution: ExecutionConfig = {
    providers: 'openai', useTools: true,
    chatAiConfig: { chatApiUrl: apiUrl, chatApiModel: modelName, chatApiKey: apiKey },
    toolsAiConfig: { toolsAiUrl: apiUrl, toolsAiModel: modelName, toolsAiApikey: apiKey },
  }
  const hostConfig = decodeHostConfig({ ...(raw.simulation === undefined ? {} : { simulation: object(raw.simulation) }), persona: raw.persona, forbiddenWords: raw.forbiddenWords })
  const personaGuard: PersonaGuardConfig | undefined = raw.personaGuard === undefined ? undefined : object(raw.personaGuard)
  if (personaGuard) {
    const booleans = ['enabled', 'stripSelfDoubt', 'stripCustomerTone', 'avoidUnpromptedIntimacy', 'rewriteHardRefusal']
    if (Object.keys(personaGuard).some(key => ![...booleans, 'maxPromptItems', 'badPatterns'].includes(key)) ||
        booleans.some(key => personaGuard[key] !== undefined && typeof personaGuard[key] !== 'boolean') ||
        personaGuard.maxPromptItems !== undefined && (typeof personaGuard.maxPromptItems !== 'number' || !Number.isInteger(personaGuard.maxPromptItems) || personaGuard.maxPromptItems < 0 || personaGuard.maxPromptItems > 8) ||
        personaGuard.badPatterns !== undefined && (!Array.isArray(personaGuard.badPatterns) || personaGuard.badPatterns.length > 100 || personaGuard.badPatterns.some(value => typeof value !== 'string' || value.length > 300))) throw new Error('personaGuard 包含不支持的字段或无效的守卫设置')
  }
  const simulation: SimulationSection = hostConfig.simulation ?? {}
  const reviewEnabled = simulation.consistency?.enabled === true
  if (reviewEnabled && raw.characterConsistency === undefined) throw new Error('启用 simulation.consistency.enabled 需要配置 characterConsistency')
  const reviewModel = raw.characterConsistency === undefined ? undefined
    : readModel(raw.characterConsistency, 'characterConsistency', env, reviewEnabled && requireCredentials)
  if (reviewModel?.apiKeyEnv === apiKeyEnv) throw new Error('characterConsistency.apiKeyEnv 必须与 model.apiKeyEnv 分开声明')
  const privateChat = raw.privateChat === undefined ? {} : object(raw.privateChat)
  if (Object.keys(privateChat).some(key => key !== 'enabled') || (privateChat.enabled !== undefined && typeof privateChat.enabled !== 'boolean')) {
    throw new Error('独立宿主的 privateChat 仅支持布尔字段 enabled，允许的好友由会话绑定声明')
  }
  if (raw.systemContent !== undefined && typeof raw.systemContent !== 'string') throw new Error('systemContent 必须是文本')
  const systemContent = typeof raw.systemContent === 'string' ? raw.systemContent : ''
  const readBindings = createAgentBindingConfig(path.join(directory, 'agent-bindings.yaml'), validateQqBindingAddress)
  const bindings = readBindings()
  if (!bindings) throw new Error('独立宿主需要同目录的 agent-bindings.yaml')
  const library = createPersonaLibrary({ libraryPath: path.join(directory, 'persona-library.yaml'), getBasePersona: () => hostConfig.persona ?? {} })
  if (!Array.isArray(raw.connections) || !raw.connections.length) throw new Error('独立宿主配置需要至少一个 connections 条目')
  const accountIds = new Set<string>()
  const connections = raw.connections.map(value => {
    const item = object(value)
    const connection: PlatformConnection | undefined = typeof item.id === 'string' ? bindings.connectionById(item.id) : undefined
    if (!connection || connection.account.platform !== 'qq' || connection.account.namespace !== 'global' || qqId(connection.account.id) !== connection.account.id) {
      throw new Error('连接必须引用 agent-bindings.yaml 中的 QQ 账号')
    }
    if (accountIds.has(connection.account.id)) throw new Error('同一 QQ 账号只能配置一个 OneBot 连接')
    accountIds.add(connection.account.id)
    if (item.transport !== undefined && item.transport !== 'forward-websocket' && item.transport !== 'reverse-websocket') {
      throw new Error('connections.transport 只支持 forward-websocket 或 reverse-websocket')
    }
    const reverse = item.transport === 'reverse-websocket'
    const url = (reverse ? parseOneBotReverseUrl : parseOneBotUrl)(typeof item.url === 'string' ? item.url : '').href
    const endpoint = { connection, url, ...(reverse ? { transport: 'reverse-websocket' as const } : {}) }
    if (item.accessTokenEnv === undefined) {
      if (reverse) throw new Error('反向 OneBot 连接必须声明 accessTokenEnv')
      return endpoint
    }
    const name = envName(item.accessTokenEnv)
    const accessToken = env[name]?.trim()
    if (!accessToken) {
      if (options?.requireCredentials === false) return endpoint
      throw new Error(`环境变量 ${name} 缺少 OneBot access token`)
    }
    return { ...endpoint, accessToken }
  })
  const mediaRelay = readStandaloneMediaRelayConfig(raw.mediaRelay, connections.map(({ connection }) => connection), env, requireCredentials)
  const torrentDownload = readStandaloneTorrentConfig(raw.torrentDownload, connections.map(({ connection }) => connection))
  if (mediaRelay.enabled && torrentDownload.enabled && mediaRelay.bridges.some(media => torrentDownload.bridges.some(torrent =>
    torrent.listen.host === media.listen.host && torrent.listen.port === media.listen.port))) throw new Error('媒体搬运和磁链 ZIP 桥须使用不同监听地址')
  const textGroups = new Map<string, readonly GroupTextToolName[]>()
  if (raw.textGroups !== undefined) {
    if (!Array.isArray(raw.textGroups)) throw new Error('textGroups 必须是会话列表')
    for (const value of raw.textGroups) {
      const item = object(value)
      const hostConnection = connections.find(({connection}) => connection.id === item.connectionId)
      if (Object.keys(item).some(key => !['connectionId', 'conversationId', 'tools'].includes(key)) ||
          !hostConnection || typeof item.conversationId !== 'string' || qqId(item.conversationId) !== item.conversationId) {
        throw new Error('textGroups 必须指定已在本宿主配置的 connectionId 和 QQ 群号字符串 conversationId')
      }
      const target = { account: hostConnection.connection.account, kind: 'group' as const, id: item.conversationId }
      const key = conversationAddressKey(target)
      if (textGroups.has(key) || !bindings.resolve(target)) throw new Error('textGroups 的会话必须已声明角色绑定且不能重复')
      const tools = item.tools === undefined ? [] : item.tools
      if (!Array.isArray(tools) || tools.some(tool => !groupTextToolNames.some(name => name === tool)) || new Set(tools).size !== tools.length) {
        throw new Error('textGroups.tools 只接受 commitmentTool、delegateMemoryTool 或 groupKnowledgeTool，工具名不能重复')
      }
      textGroups.set(key, Object.freeze([...tools]) as readonly GroupTextToolName[])
    }
  }
  const hostStat = textGroups.size ? fs.statSync(file, { bigint: true }) : undefined
  const textGroupRevision = hostStat && createHash('sha256')
    .update(JSON.stringify([String(hostStat.dev), String(hostStat.ino), String(hostStat.mtimeNs), String(hostStat.ctimeNs), [...textGroups].sort()]))
    .digest('hex')
  function resolvePersona(target: ConversationAddress) {
    const binding = readBindings()?.resolve(target)
    if (!binding) return undefined
    const { selected, scopeId } = resolveConfiguredAgentPersona(binding, library.detailById)
    return { binding, personaId: scopeId, persona: selected.persona, systemContent, ...(personaGuard ? { personaGuard } : {}) }
  }
  function checkBindings() {
    const counts = new Map(connections.map(({ connection }) => [connection.id, { simulationGroups: 0, textGroups: 0, friends: 0 }]))
    const current = readBindings()
    if (!current || current !== bindings) throw new Error('检查期间角色绑定文件已改变，请重试')
    for (const binding of current.listBindings()) {
      const { target, connectionId } = binding
      const count = counts.get(connectionId)
      if (!count) continue
      resolveConfiguredAgentPersona(binding, library.detailById)
      if (target.kind === 'group') {
        if (textGroups.has(conversationAddressKey(target))) count.textGroups++
        else count.simulationGroups++
      } else if (target.kind === 'private') {
        count.friends++
      }
    }
    return counts
  }
  const forbiddenWords: ForbiddenConfig = hostConfig.forbiddenWords ?? {}
  return {
    instance, dataDir, simulation, memorySystem, midtermMemory, episodicMemory, groupMemory, semanticMemory, history, musicExtraction, mediaRelay, torrentDownload, privateChatEnabled: privateChat.enabled === true, execution, vision, tools, connections, resolvePersona, checkBindings, forbiddenWords,
    hasMusicGroup(account: ConversationAddress['account']) {
      if (simulation.enabled === false) return false
      return readBindings()?.listBindings().some(binding => binding.target.kind === 'group' &&
        binding.target.account.platform === account.platform && binding.target.account.namespace === account.namespace && binding.target.account.id === account.id &&
        !textGroups.has(conversationAddressKey(binding.target)) && !!resolvePersona(binding.target)) === true
    },
    ...(personMemoryExtraction ? { personMemoryExtraction } : {}),
    ...(midtermSummary ? { midtermSummary } : {}),
    ...(groupMemoryExtraction ? { groupMemoryExtraction } : {}),
    ...(reviewEnabled && reviewModel ? { characterConsistency: { apiUrl: reviewModel.apiUrl, model: reviewModel.model, apiKey: reviewModel.apiKey } } : {}),
    isConfigCurrent: () => fs.readFileSync(file, 'utf8') === hostSource,
    ...(textGroupRevision ? {
      useTextGroup: (target: ConversationAddress) => textGroups.has(conversationAddressKey(target)),
      groupTextTools: (target: ConversationAddress) => textGroups.get(conversationAddressKey(target)) ?? [],
      textGroupRevision,
    } : {}),
    redisUrl: env.BL_AGENT_REDIS_URL || 'redis://127.0.0.1:6379',
  }
}
