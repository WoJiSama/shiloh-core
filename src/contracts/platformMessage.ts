import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { DeliveryReceipt } from './delivery.js'
import type { FileDeliveryReceipt, SendFileAction } from './agentFileDelivery.js'
import type { SendMediaAction } from './agentMedia.js'
import type { SendMusicAction } from './agentMusic.js'
import type { SendAudioFileAction } from './agentMusicExtraction.js'
import type { SendMediaRelayAction } from './agentMediaRelay.js'
import type { SendRequesterArchiveAction } from './agentTorrent.js'

export type MessageResource =
  | { readonly kind: 'url'; readonly value: string }
  | { readonly kind: 'reference'; readonly value: string }

export type MessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mention'; readonly user: PlatformUserRef | 'everyone' }
  | { readonly kind: 'image' | 'audio' | 'video' | 'file'; readonly resource?: MessageResource; readonly name?: string }
  | { readonly kind: 'forward'; readonly id: string }
  | { readonly kind: 'extension'; readonly platform: string; readonly type: string }

export interface MessageQuote {
  readonly messageId?: string
  readonly author?: PlatformUserRef
  readonly authorName?: string
  readonly text?: string
  readonly parts: readonly MessagePart[]
}

/** The conversation and actor are resolved by an adapter before business code sees the event. */
export interface IncomingMessage {
  readonly version: 1
  readonly conversation: ConversationAddress
  readonly sender: PlatformUserRef
  readonly senderName?: string
  readonly messageId?: string
  readonly occurredAt: number
  readonly text: string
  readonly parts: readonly MessagePart[]
  readonly mentions: readonly PlatformUserRef[]
  readonly directedToAccount: boolean
  readonly quote?: MessageQuote
  readonly binding?: AgentBindingSnapshot
}

export type OutgoingPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'mention'; readonly user: PlatformUserRef | 'everyone' }
  | { readonly kind: 'image' | 'audio' | 'video' | 'file'; readonly resource: MessageResource; readonly name?: string }
  | { readonly kind: 'extension'; readonly platform: string; readonly type: string; readonly ref: string }

export interface SendMessageAction {
  readonly version: 1
  readonly kind: 'message.send'
  readonly target: ConversationAddress
  readonly parts: readonly OutgoingPart[]
  readonly replyTo?: string
  readonly binding?: AgentBindingSnapshot
}

/** A bounded, platform-neutral bundle uses inline bytes and never supplies node authors. */
export type MessageBundlePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly mime: string; readonly base64: string }

export interface MessageBundleItem {
  readonly parts: readonly MessageBundlePart[]
}

export interface SendMessageBundleAction {
  readonly version: 1
  readonly kind: 'message.bundle.send'
  readonly target: ConversationAddress
  readonly items: readonly MessageBundleItem[]
  readonly binding?: AgentBindingSnapshot
}

export interface MessageActionOptions {
  /** Recheck synchronously immediately before transport, including after any adapter queue. */
  readonly isCurrent?: () => boolean
}

export interface MessageActionPort {
  send(action: SendMessageAction, options?: MessageActionOptions): Promise<DeliveryReceipt>
  sendBundle?(action: SendMessageBundleAction, options?: MessageActionOptions): Promise<DeliveryReceipt>
  /** Upload owned bytes to this action's fixed conversation, retaining file evidence separately. */
  sendFile?(action: SendFileAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<FileDeliveryReceipt>
  /** Send playable media from bounded owned bytes to this exact conversation. */
  sendMedia?(action: SendMediaAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<DeliveryReceipt>
  /** Send a provider music card to this action's exact conversation. */
  sendMusic?(action: SendMusicAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<DeliveryReceipt>
  /** Upload complete owned audio bytes, retaining a file receipt separately from playable media. */
  sendAudioFile?(action: SendAudioFileAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<FileDeliveryReceipt>
  /** One fixed-conversation relay call from opaque host-owned resources, with no implicit retries. */
  sendMediaRelay?(action: SendMediaRelayAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<DeliveryReceipt>
  /** Private upload only to the sender proven by this action's original bound group source. */
  sendRequesterArchive?(action: SendRequesterArchiveAction, options?: MessageActionOptions & { readonly signal?: AbortSignal }): Promise<FileDeliveryReceipt>
}
