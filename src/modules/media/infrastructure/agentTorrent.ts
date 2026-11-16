/** Trusted-host Core preparation. This entry does not register a model tool or select a recipient. */
export { createAgentTorrentProvider } from './agentTorrentProvider.js'
export type { AgentTorrentProviderOptions } from './agentTorrentProvider.js'
export { validateAgentTorrentConfig, validateAgentTorrentMetadata, validateAgentTorrentArchive, validateAgentPreparedTorrent,
  parseAgentTorrentMagnet, parseAgentTorrentSelection, MAX_AGENT_TORRENT_ARCHIVE_BYTES, MAX_AGENT_TORRENT_FILES } from '../domain/agentTorrent.js'
export type { AgentTorrentConfig, AgentTorrentMetadata, AgentTorrentFile, AgentTorrentArchive, AgentPreparedTorrent,
  AgentTorrentProvider, SendRequesterArchiveAction } from '../../../contracts/agentTorrent.js'
