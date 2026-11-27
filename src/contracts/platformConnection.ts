import type { ConversationAddress, PlatformConnection, PlatformUserRef } from './agentBinding.js'
import type { IncomingMessage, MessageActionOptions, MessageActionPort } from './platformMessage.js'
import type { AgentFileBytes, ConversationFileCatalog, ConversationFileEntry, ConversationFileReadOptions, FileReadGuard, MessageFileReadOptions } from './agentFiles.js'
import type { AgentMusicShare } from './agentMusicExtraction.js'
import type { AgentMediaShare, AgentMediaShareAccess } from './agentMediaRelayWorkflow.js'
import type { AgentMessageVideo, MessageVideoReadOptions } from './agentVideo.js'
import type { AgentGiftDeliveryPort } from './agentQqGift.js'
import type { AgentQzoneProvider } from './agentQzone.js'
import type { AgentRedPacketPort, AgentRedPacketSnapshot } from './agentQqRedPacket.js'
import type { InteractionReceipt } from './agentInteraction.js'

export type PlatformConversationEvent =
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'recall'; target: ConversationAddress; messageId: string }
  | PlatformNudgeEvent
  | { readonly kind: 'red-packet'; readonly target: ConversationAddress; readonly packet: AgentRedPacketSnapshot }

/** An interaction directed to this account with no replyable message. */
export interface PlatformNudgeEvent {
  readonly kind: 'nudge'
  readonly target: ConversationAddress
  readonly sender: PlatformUserRef
  readonly senderName?: string
  readonly occurredAt: number
}

export interface ForwardReference {
  readonly messageId: string
  readonly forwardId: string
}

export interface ForwardContent {
  readonly entries: readonly {
    readonly text: string
    readonly senderName?: string
    readonly occurredAt?: number
    readonly depth: number
  }[]
  readonly partial: boolean
}

export interface MessageImage {
  readonly mime: string
  readonly base64: string
  /** Optional platform-neutral rendering hint; native parameters belong to adapters. */
  readonly presentation?: 'sticker'
}

/** Fresh ownership evidence contains no message body, resource or quoted content. */
export interface OwnMessageSnapshot {
  readonly conversation: ConversationAddress
  readonly messageId: string
  readonly author: PlatformUserRef
  readonly occurredAt: number
}

export interface OwnTextDeliveryProof {
  readonly sha256: string
  readonly from: number
  readonly until: number
  readonly mentionId?: string
}

export const messageImageReadSteps = {
  image_message_lookup_failed: 'image_message_lookup',
  image_attachment_missing: 'image_attachment_select',
  image_source_mismatch: 'image_source_authorization',
  image_source_privacy_denied: 'image_source_authorization',
  image_source_check_failed: 'image_source_authorization',
  image_source_changed: 'image_source_authorization',
  image_reference_unsupported: 'image_attachment_select',
  image_url_rejected: 'image_address_validation',
  image_dns_failed: 'image_address_validation',
  image_read_timeout: 'image_attachment_read',
  image_download_failed: 'image_download',
  image_download_http_error: 'image_download',
  image_bytes_invalid: 'image_bytes_validation',
} as const
export interface MessageImageReadFailure {
  readonly code: keyof typeof messageImageReadSteps
  readonly httpStatus?: number
}

export interface MessageImageReadOptions extends MessageActionOptions {
  /** Cancel source lookup, DNS and any in-flight image body read. */
  readonly signal?: AbortSignal
  /** The adapter checks the verified source against the caller's policy before retrieving its image. */
  allowsSource(source: IncomingMessage): Promise<boolean>
  /** Fixed reason metadata from the first unsuccessful step. Never includes the address or attachment. */
  reportFailure?(failure: MessageImageReadFailure): void
}

export interface MusicShareReadOptions extends MessageActionOptions {
  readonly signal: AbortSignal
  /** Authorize the verified source before parsing, and again after asynchronous source-policy work. */
  allowsSource(source: IncomingMessage): Promise<boolean>
}

export interface MediaShareReadOptions extends MessageActionOptions {
  readonly signal: AbortSignal
  readonly expectedSource: { readonly author: PlatformUserRef; readonly occurredAt: number }
  allowsSource(source: IncomingMessage): Promise<boolean>
}

export interface ConversationMemberProfile {
  readonly nickname?: string
  readonly conversationName?: string
  readonly title?: string
  readonly level?: string
  /** Verified platform timestamps in milliseconds; missing or zero values are omitted. */
  readonly joinedAt?: number
  readonly lastSpokeAt?: number
  readonly mutedUntil?: number
  readonly gender?: 'male' | 'female' | 'unknown'
  readonly age?: number
  readonly region?: string
}

export interface ConversationMember {
  readonly user: PlatformUserRef
  readonly displayName: string
  readonly role: 'owner' | 'admin' | 'member' | 'unknown'
  /** Lists expose only names; individual reads may include additional platform-provided details. */
  readonly profile?: ConversationMemberProfile
}

export interface ConversationMemberSnapshot {
  readonly target: ConversationAddress
  readonly observedAt: number
  readonly member: ConversationMember
}

export interface ConversationMembersSnapshot {
  readonly target: ConversationAddress
  readonly observedAt: number
  readonly members: readonly ConversationMember[]
  readonly complete: true
}

export interface ConversationMemberReadOptions extends MessageActionOptions {
  readonly signal: AbortSignal
}

export interface PlatformConnectionAdapter extends PlatformConnection {
  readonly botUserId: string
  readonly botName: string
  /** Cached display metadata for one configured address. This does not attest membership or grant authority. */
  conversationName?(target: ConversationAddress): string | undefined
  readonly actions: MessageActionPort
  /** If provided, gates message admission and makes allowed messages eligible for a text reply. */
  allowsReply?(incoming: IncomingMessage): boolean
  /** Explicitly declared platform extensions; omission keeps each capability unavailable. */
  readonly gift?: AgentGiftDeliveryPort
  readonly qzone?: AgentQzoneProvider
  readonly redPackets?: AgentRedPacketPort & { revoke(target: ConversationAddress, messageId?: string): void }
  /** Clear ephemeral wallet credentials and in-flight reads without erasing durable effect receipts. */
  invalidateRedPacketSources?(): void
  /** Synchronously resolve the verified and stable one-to-one peer for this account's private conversation.
   * Return undefined when unverified. Omission declares that private conversation IDs are the verified participant IDs. */
  resolvePrivatePeer?(target: ConversationAddress): PlatformUserRef | undefined
  /** Prove an unprompted private send still goes to a current friend. */
  verifyPrivateFriend?(target: ConversationAddress, options: ConversationMemberReadOptions): Promise<boolean>
  /** The adapter verifies the bot's and member's current roles and the original source. */
  moderateMessage?(source: IncomingMessage, action: 'recall' | 'mute' | 'unmute',
    guard: { signal: AbortSignal; isCurrent(): boolean; ensureCurrent(): Promise<void> }): Promise<InteractionReceipt>
  /** Optional read of one already referenced message. The adapter must verify its full conversation address. */
  readMessage?(target: ConversationAddress, messageId: string, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<IncomingMessage | undefined>
  /** Verify an already referenced self-authored message in this exact conversation. */
  readOwnMessage?(target: ConversationAddress, messageId: string, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<OwnMessageSnapshot | undefined>
  /** Bounded lookup for an uncertain self-authored text send, with a fresh conversation and exact body proof. */
  findOwnTextDelivery?(target: ConversationAddress, proof: OwnTextDeliveryProof,
    options: { readonly signal: AbortSignal; isCurrent(): boolean }): Promise<OwnMessageSnapshot | undefined>
  /** Read a forwarded bundle attached to a verified message in this conversation. */
  readForward?(target: ConversationAddress, source: ForwardReference, options?: MessageActionOptions): Promise<ForwardContent | undefined>
  /** Materialize image parts of one message after verifying its conversation and source. */
  readMessageImages?(target: ConversationAddress, messageId: string, options: MessageImageReadOptions): Promise<readonly MessageImage[] | undefined>
  /** First video from the verified current/reply/forward chain; inspect never retrieves video bytes. */
  readMessageVideo?(target: ConversationAddress, messageId: string, options: MessageVideoReadOptions): Promise<AgentMessageVideo | undefined>
  /** Read a bounded official music reference from one verified group or friend-private message. */
  readMusicShare?(target: ConversationAddress, messageId: string, options: MusicShareReadOptions): Promise<{ readonly message: IncomingMessage; readonly share: AgentMusicShare } | undefined>
  readMediaShare?(target: ConversationAddress, messageId: string, options: MediaShareReadOptions): Promise<{ readonly message: IncomingMessage; readonly share: AgentMediaShare; readonly access?: AgentMediaShareAccess } | undefined>
  readMessageFile?(target: ConversationAddress, messageId: string, fileIndex: number, options: MessageFileReadOptions): Promise<AgentFileBytes | undefined>
  /** Bounded current repository of this exact conversation; no arbitrary platform path/API input. */
  listConversationFiles?(target: ConversationAddress, options: FileReadGuard): Promise<ConversationFileCatalog | undefined>
  readConversationFile?(target: ConversationAddress, entry: ConversationFileEntry, options: ConversationFileReadOptions): Promise<AgentFileBytes | undefined>
  /** Fresh member evidence for this exact account and conversation. Missing evidence never grants authority. */
  readConversationMember?(target: ConversationAddress, user: PlatformUserRef, options: ConversationMemberReadOptions): Promise<ConversationMemberSnapshot | undefined>
  /** A complete current member list; unsupported, cancelled or incomplete reads return undefined. */
  listConversationMembers?(target: ConversationAddress, options: ConversationMemberReadOptions): Promise<ConversationMembersSnapshot | undefined>
  start(accept: (event: PlatformConversationEvent) => Promise<void>): Promise<void>
  isReady(): boolean
  stop(): void
}
