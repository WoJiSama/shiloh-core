import type { AgentBindingSnapshot, PlatformUserRef } from './agentBinding.js'
import type { DeliveryReceipt } from './delivery.js'
import type { AgentFileUpload, FileDeliveryReceipt } from './agentFileDelivery.js'
import type { MessageBundleItem } from './platformMessage.js'
import type { ConversationMemberSnapshot, ConversationMembersSnapshot } from './platformConnection.js'
import type { AgentFileBytes, AgentFileListing, AgentFileRequest } from './agentFiles.js'
import type { AgentAudioBytes, AgentVideoBytes } from './agentMedia.js'
import type { AgentMusicCard } from './agentMusic.js'
import type { AgentMediaRelayPlan } from './agentMediaRelay.js'
import type { PersonaGuardConfig } from './persona.js'

export interface AgentToolMessage {
  readonly text: string
  readonly mentionUserIds?: readonly string[]
}

export interface AgentToolRequest {
  readonly messageId: string
  readonly text: string
  readonly mentions: readonly PlatformUserRef[]
  readonly replyAuthor?: PlatformUserRef
}

export interface AgentToolContext {
  readonly binding: AgentBindingSnapshot
  readonly actor: { readonly kind: 'user' | 'autonomous' | 'commitment'; readonly user?: PlatformUserRef }
  readonly signal: AbortSignal
  /** Verified current user request, never a model-supplied identity or prior wake. */
  readonly request?: AgentToolRequest
  readonly botUserId?: string
  /** Captured role presentation only; no system prompt, native event or mutable persona source. */
  readonly persona?: { readonly name: string; readonly version: string; readonly aliases?: readonly string[]; readonly guard?: Readonly<PersonaGuardConfig> }
  /** Recheck immediately before each external request or side effect. */
  isCurrent(): boolean
  /** Recheck stored activity/source permissions before every external step. */
  ensureCurrent?(): Promise<void>
  /** Attribute a provider call to this conversation's existing token ledger. */
  recordUsage?(model: string, usage: unknown): void
  /** Deliver validated inline image bytes through this tool call's existing send permissions and budget. */
  sendImage?(image: { readonly mime: string; readonly base64: string }): Promise<DeliveryReceipt>
  /** Upload controlled bytes to this turn's fixed conversation, sharing its send budget and unknown-result fence.
   * Binary producers must apply their output policy before encoding; text bodies are checked by the host. */
  sendFile?(file: AgentFileUpload): Promise<FileDeliveryReceipt>
  /** Playable media bytes through the fixed conversation's existing queue and send budget. */
  sendAudio?(audio: AgentAudioBytes): Promise<DeliveryReceipt>
  sendVideo?(video: AgentVideoBytes): Promise<DeliveryReceipt>
  /** A provider-produced music card, sharing this turn's fixed group and send budget. */
  sendMusic?(music: AgentMusicCard): Promise<DeliveryReceipt>
  /** One validated forward in this human group turn's fixed conversation and send budget. */
  sendMediaRelay?(plan: AgentMediaRelayPlan): Promise<DeliveryReceipt>
  /** Reauthorize a known source in this binding without disclosing its current contents. */
  isSourceAvailable?(source: { readonly messageId: string; readonly author: PlatformUserRef }): Promise<boolean>
  /** Send one bounded bundle to this turn's fixed conversation, using its existing send budget. */
  sendBundle?(items: readonly MessageBundleItem[]): Promise<DeliveryReceipt>
  /** Read attachments of a message already visible in this turn; bytes never enter the conversation history. */
  readImages?(sourceSeq: number): Promise<readonly { readonly mime: string; readonly base64: string }[]>
  /** Fresh evidence from this binding's group only. */
  readMember?(userId: string): Promise<ConversationMemberSnapshot | undefined>
  listMembers?(): Promise<ConversationMembersSnapshot | undefined>
  /** One text/mention message through the existing fixed-target send queue. */
  sendMessage?(message: AgentToolMessage): Promise<DeliveryReceipt>
  /** Source-backed history in this turn's fixed scope. Results are ephemeral and reauthorized before use. */
  readHistory?(input: Record<string, unknown>): Promise<string>
  /** Current/reply/recent human file, current repository entry or explicitly supplied public URL. */
  readFile?(input: AgentFileRequest): Promise<AgentFileBytes>
  /** Only this binding's shared repository; names/paths are untrusted temporary data. */
  listFiles?(input: { readonly query?: string; readonly folderPath?: string }): Promise<AgentFileListing>
}

export interface AgentToolResult {
  readonly status: 'succeeded' | 'failed' | 'unknown'
  readonly content: string
}

/** Host implementations receive scoped identities, never a native platform event. */
export interface AgentTool {
  readonly name: string
  readonly description: string
  /** Declare temporary source-backed data before execution; grants file ports and prevents durable receipts/derived state. */
  readonly dataPolicy?: 'ephemeral'
  /** Optional execution deadline in milliseconds, from 1 to 240000; defaults to 45000. */
  readonly timeoutMs?: number
  readonly parameters: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
    readonly additionalProperties?: boolean
  }
  execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>
}

export interface AgentToolRegistry {
  /** First-party capabilities follow the existing open tool policy. */
  readonly builtIn?: readonly AgentTool[]
  /** Custom capabilities require explicit extraTools/allowTools authorization. */
  readonly custom?: readonly AgentTool[]
}
