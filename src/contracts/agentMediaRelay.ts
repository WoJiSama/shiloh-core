import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

/** Host-owned media. Opaque IDs never denote a URL, local path or platform file reference. */
export interface AgentMediaArtifact {
  readonly id: string
  readonly kind: 'image' | 'video'
  readonly mime: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface AgentMediaResourceContext {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent?(): Promise<void>
}

export interface AgentMediaArtifactLease {
  readonly artifact: AgentMediaArtifact
  /** Retain the same immutable bytes for a second preparation/delivery owner. */
  retain(): Promise<AgentMediaArtifactLease>
  release(): Promise<void>
}

export interface AgentMediaArtifactReader {
  readonly chunks: AsyncIterable<Uint8Array>
  close(): Promise<void>
}

/** Trusted host capability. No filesystem path crosses this interface. */
export interface AgentMediaResourcePort {
  open(artifact: AgentMediaArtifact, context: AgentMediaResourceContext): Promise<AgentMediaArtifactReader>
}

export type AgentMediaRelayPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly artifact: AgentMediaArtifact }
  | { readonly kind: 'video'; readonly artifact: AgentMediaArtifact; readonly thumbnail?: AgentMediaArtifact }

export interface AgentMediaRelayItem {
  readonly parts: readonly AgentMediaRelayPart[]
}

/** Ordered neutral preparation result; delivery selects no author, target, URL or path. */
export interface AgentMediaRelayPlan {
  readonly version: 1
  readonly items: readonly AgentMediaRelayItem[]
}

export interface SendMediaRelayAction {
  readonly version: 1
  readonly kind: 'media-relay.send'
  readonly target: ConversationAddress
  readonly mode: 'forward' | 'direct-video'
  readonly plan: AgentMediaRelayPlan
  readonly binding?: AgentBindingSnapshot
}
