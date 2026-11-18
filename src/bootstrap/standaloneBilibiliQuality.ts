import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PlatformConnection } from '../contracts/agentBinding.js'
import type { AgentBilibiliQualityConfig } from '../contracts/agentBilibiliQuality.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { validateAgentBilibiliQualityConfig } from '../modules/media/infrastructure/agentBilibiliQualityPolicy.js'
import { openAgentBilibiliAuthService } from '../modules/media/infrastructure/agentBilibiliAuthService.js'

const failure = () => new Error('独立宿主 B站高清配置或授权目录不可用')

/** Own permission declarations without opening directories, sockets or credentials. */
export function readStandaloneBilibiliQualityConfig(input: unknown, connections: readonly PlatformConnection[]): Readonly<AgentBilibiliQualityConfig> {
  try {
    if (input === null) throw failure()
    const config = validateAgentBilibiliQualityConfig(input)
    const accounts = new Set(connections.map(connection => platformAccountKey(connection.account)))
    if (config.whitelist?.some(row => !accounts.has(platformAccountKey(row.target.account)))) throw failure()
    return config
  } catch { throw failure() }
}

/** Persistent authorization belongs to the leased instance, outside disposable media runs. */
export async function openStandaloneBilibiliAuth(options: Omit<Parameters<typeof openAgentBilibiliAuthService>[0], 'directory'> & {
  readonly config: AgentBilibiliQualityConfig
  readonly dataDir: string
  readonly instance: string
}) {
  if (!options.config.enabled) return undefined
  try {
    if (!options.isLeaseCurrent() || !path.isAbsolute(options.dataDir) || !options.instance) throw failure()
    const directory = path.resolve(options.dataDir)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 || await realpath(directory) !== directory || !options.isLeaseCurrent()) throw failure()
    const { config: _config, dataDir: _dataDir, instance: _instance, ...service } = options
    return await openAgentBilibiliAuthService({ ...service,
      directory: path.join(directory, `.agent-bilibili-auth-${createHash('sha256').update(options.instance).digest('hex').slice(0, 32)}`) })
  } catch { throw failure() }
}
