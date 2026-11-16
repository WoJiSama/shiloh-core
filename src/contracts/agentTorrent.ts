import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { AgentMediaResourceContext } from './agentMediaRelay.js'

/** Deterministic group workflow; independent of model tool registration. */
export interface AgentTorrentConfig {
  readonly enabled: boolean
  readonly autoDetect?: boolean
  /** May shorten the default 30-minute selection lifetime. */
  readonly selectionTtlSeconds?: number
}
export interface AgentTorrentFile {
  readonly index: number
  readonly relativePath: readonly string[]
  readonly size: number
}
export interface AgentTorrentMetadata {
  readonly infoHash: string
  /** SHA256 of the complete verified torrent metadata, checked again for selections. */
  readonly fingerprint: string
  readonly name: string
  readonly files: readonly AgentTorrentFile[]
  readonly totalBytes: number
}
export interface AgentTorrentArchive {
  readonly name: string
  readonly mime: 'application/zip'
  readonly base64: string
}
export type AgentPreparedTorrent =
  | { readonly status: 'selection-required'; readonly metadata: AgentTorrentMetadata; readonly selectableIndexes: readonly number[] }
  | { readonly status: 'ready'; readonly metadata: AgentTorrentMetadata; readonly archive: AgentTorrentArchive }

/** Trusted Core implementation; paths, downloader APIs and network URLs never enter results. */
export interface AgentTorrentProvider {
  prepare(magnet: string, selection: { readonly indexes: readonly number[]; readonly expectedFingerprint: string } | undefined,
    context: AgentMediaResourceContext): Promise<AgentPreparedTorrent>
}
/** The destination is derived only from the verified source sender, never supplied by a model. */
export interface SendRequesterArchiveAction {
  readonly version: 1
  readonly kind: 'requester-archive.upload'
  readonly target: ConversationAddress
  readonly binding: AgentBindingSnapshot
  readonly source: { readonly messageId: string; readonly sender: PlatformUserRef; readonly occurredAt: number;
    /** Core pins the neutral source text across the adapter's first native reread. */
    readonly textSha256?: string }
  readonly archive: AgentTorrentArchive
}
