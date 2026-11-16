import type { AgentMediaRelayPlan, AgentMediaResourceContext } from './agentMediaRelay.js'

/** Syntax-only reference from a verified platform message, never a download URL. */
export type AgentMediaShare = {
  readonly provider: 'bilibili'
  readonly reference: { readonly kind: 'video' | 'episode' | 'short'; readonly id: string }
} | {
  readonly provider: 'douyin'
  readonly reference: { readonly kind: 'video' | 'note' | 'short'; readonly id: string }
} | {
  readonly provider: 'xiaohongshu'
  readonly reference: { readonly kind: 'note' | 'short'; readonly id: string }
} | {
  readonly provider: 'youtube'
  readonly reference: { readonly kind: 'video'; readonly id: string }
} | {
  readonly provider: 'pixiv'
  readonly reference: { readonly kind: 'artwork'; readonly id: string }
}

/** Short-lived source access, never part of a durable share or outgoing plan. */
export interface AgentMediaShareAccess {
  readonly provider: 'xiaohongshu'
  /** Decoded once from the verified source; URL construction encodes once. */
  readonly xsecToken?: string
  readonly xsecSource?: string
  readonly mediaKind?: 'image' | 'video'
}

export interface AgentMediaRelayPrepareContext extends AgentMediaResourceContext {
  /** Re-reads and authorizes the exact source; no source body is exposed to providers. */
  readSourceAccess?(): Promise<Readonly<AgentMediaShareAccess> | undefined>
}

export interface AgentMediaRelayConfig {
  readonly enabled: boolean
  /** Omission preserves the original Bilibili-only activation boundary. */
  readonly providers?: readonly AgentMediaShare['provider'][]
}

/** All bytes remain leased until the complete delivery/fallback attempt ends. */
export interface AgentPreparedMediaRelay {
  readonly status: 'ready' | 'metadata-only' | 'preview' | 'restricted'
  readonly pageUrl: string
  readonly infoText: string
  readonly plan: AgentMediaRelayPlan
  release(): Promise<void>
}

export interface AgentMediaRelayProvider {
  prepare(share: AgentMediaShare, context: AgentMediaRelayPrepareContext): Promise<AgentPreparedMediaRelay>
}
