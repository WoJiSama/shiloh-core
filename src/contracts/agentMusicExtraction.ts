import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { AgentToolContext } from './agentTool.js'

/** An already-visible official music reference; contains no native event or account credentials. */
export interface AgentMusicShare {
  readonly provider: 'netease'
  readonly reference: { readonly kind: 'song' | 'program'; readonly id: string } | { readonly kind: 'audio'; readonly url: string }
  readonly title?: string
  readonly artist?: string
}

/** Owned complete audio bytes for file upload, separate from playable-record delivery. */
export interface AgentAudioAttachment {
  readonly name: string
  readonly mime: string
  readonly base64: string
}

export interface SendAudioFileAction {
  readonly version: 1
  readonly kind: 'audio-file.upload'
  readonly target: ConversationAddress
  readonly attachment: AgentAudioAttachment
  readonly binding?: AgentBindingSnapshot
}

export interface AgentMusicExtractionConfig {
  readonly enabled: boolean
  readonly operators: readonly PlatformUserRef[]
}

export type AgentMusicExtractionContext = Pick<AgentToolContext, 'signal' | 'isCurrent' | 'ensureCurrent'>
