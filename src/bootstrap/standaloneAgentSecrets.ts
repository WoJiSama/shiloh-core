import { agentImageBackends } from '../modules/tools/infrastructure/agentImageTools.js'
import type { readStandaloneAgentConfig } from './standaloneAgentConfig.js'
import { standaloneMagnetSearchSecrets } from './standaloneMagnetSearch.js'
import { standaloneMediaRelaySecrets } from './standaloneMediaRelay.js'
import { standalonePixivToolsSecrets } from './standalonePixiv.js'

export function standaloneAgentSecrets(config: ReturnType<typeof readStandaloneAgentConfig>, env: NodeJS.ProcessEnv) {
  const musicCookie = config.tools.music?.cookie ?? ''
  const musicSecrets = musicCookie ? [musicCookie, ...musicCookie.split(';').flatMap(part => {
    const at = part.indexOf('='), key = part.slice(0, at).trim(), value = part.slice(at + 1).trim()
    return at > 0 && value && !['uin', 'wxuin', 'login_type', 'tmeLoginType', 'psrf_musickey_createtime'].includes(key) ? [value] : []
  })] : []
  const torrentProxy = config.torrentDownload.proxyUrl ? new URL(config.torrentDownload.proxyUrl) : undefined
  const proxySecrets = torrentProxy ? [torrentProxy.href, torrentProxy.username, torrentProxy.password].flatMap(value => {
    try { return [value, decodeURIComponent(value)] } catch { return [value] }
  }) : []
  return [config.characterConsistency?.apiKey, config.execution.chatAiConfig?.chatApiKey, config.vision?.apiKey,
    config.tools.localEmoji.analysis?.apiKey, config.tools.localEmoji.embedding?.apiKey, config.tools.localEmoji.tools?.apiKey,
    config.tools.search?.apiKey, config.tools.deltaForce?.apiKey, config.tools.github?.token,
    config.tools.modrinth?.translation.apiKey, config.personMemoryExtraction?.apiKey, config.midtermSummary?.apiKey, config.groupMemoryExtraction?.apiKey,
    ...[config.tools.images?.generation, config.tools.images?.edit].flatMap(value => agentImageBackends(value).map(backend => backend.apiKey)),
    config.tools.rendering?.mindMap?.apiKey,
    config.semanticMemory.embedding?.apiKey, config.semanticMemory.rerank?.apiKey, config.tools.voice?.accessToken, config.tools.voice?.authorization,
    ...musicSecrets, config.tools.videoAnalysis?.apiKey, config.textTriggerModel?.apiKey,
    config.console.tokenEnv ? env[config.console.tokenEnv] : undefined,
    ...standaloneMediaRelaySecrets(config.mediaRelay),
    ...(config.tools.pixiv ? standalonePixivToolsSecrets(config.tools.pixiv) : []),
    ...proxySecrets,
    ...(config.tools.magnetSearch ? standaloneMagnetSearchSecrets(config.tools.magnetSearch) : []),
    ...Object.values(config.tools.mcp?.servers ?? {}).flatMap(server => [...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})]),
    ...config.connections.map(connection => 'accessToken' in connection ? connection.accessToken : undefined)]
    .filter((key): key is string => typeof key === 'string' && !!key)
}
