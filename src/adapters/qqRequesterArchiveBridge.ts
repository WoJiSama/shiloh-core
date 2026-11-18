import type { AgentMediaResourceContext } from '../contracts/agentMediaRelay.js'
import type { AgentTorrentArchive } from '../contracts/agentTorrent.js'
import { MAX_AGENT_TORRENT_ARCHIVE_BYTES, validateAgentTorrentArchive } from '../modules/media/domain/agentTorrent.js'
import { openQqBoundedFileBridge } from './qqBoundedFileBridge.js'

export const QQ_REQUESTER_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000
const failure = () => new Error('QQ 请求者压缩包临时资源不可用或操作已取消')
export interface QqRequesterArchiveLease {
  /** Private capability; never return to Core, tools, users or persistence. */
  readonly nativeUrl: string
  release(): Promise<void>
}
export interface QqRequesterArchiveBridgeOptions {
  readonly directory: string
  readonly listen: { readonly host: string; readonly port: number }
  readonly advertisedOrigin: string
  readonly allowedPeers: readonly string[]
  readonly maxTotalBytes?: number
  readonly maxArchives?: number
  readonly timeoutMs?: number
}
export interface QqRequesterArchiveBridge {
  stage(archive: AgentTorrentArchive, context: AgentMediaResourceContext): Promise<QqRequesterArchiveLease>
  close(): Promise<void>
}

/** ZIP limits, resource paths and public errors are independent from other file capabilities. */
export async function openQqRequesterArchiveBridge(options: QqRequesterArchiveBridgeOptions): Promise<QqRequesterArchiveBridge> {
  try {
    const bridge = await openQqBoundedFileBridge({ directory: options.directory, listen: options.listen,
      advertisedOrigin: options.advertisedOrigin, allowedPeers: options.allowedPeers,
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
      ...(options.maxArchives !== undefined ? { maxFiles: options.maxArchives } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }, { validate: validateAgentTorrentArchive, maxTotalBytes: 4 * MAX_AGENT_TORRENT_ARCHIVE_BYTES, maxFiles: 4,
      timeoutMs: QQ_REQUESTER_ARCHIVE_TIMEOUT_MS, resourcePath: 'qq-requester-archive', directoryPrefix: 'qq-requester-archive-',
    })
    return Object.freeze({
      async stage(archive: AgentTorrentArchive, context: AgentMediaResourceContext): Promise<QqRequesterArchiveLease> {
        try {
          const lease = await bridge.stage(archive, context)
          return Object.freeze({ nativeUrl: lease.nativeUrl, async release() { try { await lease.release() } catch { throw failure() } } })
        } catch { throw failure() }
      },
      async close() { try { await bridge.close() } catch { throw failure() } },
    })
  } catch { throw failure() }
}
