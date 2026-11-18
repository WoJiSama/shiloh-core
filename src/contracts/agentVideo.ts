import type { PlatformUserRef } from './agentBinding.js'
import type { IncomingMessage } from './platformMessage.js'
import type { FileReadGuard } from './agentFiles.js'

/** Owned, turn-local input. No native path, signed URL or platform file ID. */
export interface AgentVideoInput {
  readonly mime: 'video/mp4' | 'video/webm'
  readonly base64: string
}

export interface AgentMessageVideo {
  /** Hash of the selected source, its node path/ancestors and native resource identity. */
  readonly fingerprint: string
  readonly origin: 'current' | 'reply' | 'forward'
  readonly video?: AgentVideoInput
}

export interface MessageVideoReadOptions extends FileReadGuard {
  /** Re-read provenance without retrieving or exposing bytes. */
  readonly inspectOnly?: boolean
  allowsSource(source: IncomingMessage): Promise<boolean>
  /** Forward-node identity is evidence from this root, never an original-message claim. */
  allowsForwardSource(source: { readonly author: PlatformUserRef; readonly occurredAt: number }): Promise<boolean>
}
