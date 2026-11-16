import type { ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { IncomingMessage } from './platformMessage.js'

/** In-memory only. Paths, provider URLs and file IDs never enter a model response. */
export interface AgentFileBytes {
  readonly name: string
  readonly mime: string
  readonly base64: string
  /** Assigned by the trusted resolver, never inferred from model parameters. */
  readonly origin?: 'current' | 'reply' | 'recent' | 'group_file' | 'explicit'
}
export interface AgentFileRequest {
  /** Optional syntax filter supplied by the consuming host tool; indexes retain original attachment positions. */
  readonly extensions?: readonly string[]
  readonly sourceSeq?: number
  /** One-based attachment index within the verified message. */
  readonly fileIndex?: number
  readonly fileName?: string
  readonly folderPath?: string
  /** Accepted only when present verbatim in the current verified human request. */
  readonly fileUrl?: string
}
export interface ConversationFileEntry {
  /** Opaque adapter reference; never supplied by the model. */
  readonly reference: string
  readonly name: string
  readonly folderPath: string
  readonly size: number
  readonly uploadedBy?: PlatformUserRef
  readonly uploadedAt?: number
}
export interface ConversationFileCatalog {
  readonly target: ConversationAddress
  readonly observedAt: number
  readonly files: readonly ConversationFileEntry[]
  readonly truncated: boolean
}
export interface AgentFileListing {
  readonly files: readonly { readonly name: string; readonly folderPath: string; readonly size: number }[]
  readonly totalFiles: number
  readonly truncated: boolean
}
export interface FileReadGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent?(): Promise<void>
}
export interface MessageFileReadOptions extends FileReadGuard {
  /** Authorize the adapter-reloaded source immediately before network/file access. */
  allowsSource(source: IncomingMessage): Promise<boolean>
}
export interface ConversationFileReadOptions extends FileReadGuard {
  /** Reauthorize the freshly listed entry before retrieval, not a model-supplied reference. */
  allowsFile(entry: ConversationFileEntry): Promise<boolean>
}
