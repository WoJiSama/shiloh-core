import type { AgentBindingSnapshot, PlatformUserRef } from './agentBinding.js'
import type { AgentToolContext } from './agentTool.js'

/** Structural storage port; the host's leased Redis storage satisfies it. */
export interface AgentGiftStorage {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export type AgentGiftType = 'champagne' | 'hammer' | 'space' | 'party' | 'camping' | 'dragon' | 'supercar' | 'helicopter'

/** The legacy packet is a display effect. These numbers prove no payment or deduction. */
export interface AgentGiftDisplay {
  readonly name: string
  readonly coinValue: number
  readonly tianquanId: number
  readonly displayValue: number
}

export const AGENT_GIFT_CATALOG: Readonly<Record<AgentGiftType, AgentGiftDisplay>> = Object.freeze({
  champagne: Object.freeze({ name: '香槟', coinValue: 182, tianquanId: 2179, displayValue: 199999 }),
  hammer: Object.freeze({ name: '风暴战锤', coinValue: 1388, tianquanId: 2025, displayValue: 1388 }),
  space: Object.freeze({ name: '遨游太空', coinValue: 1888, tianquanId: 1682, displayValue: 1888 }),
  party: Object.freeze({ name: '蹦迪派对', coinValue: 2999, tianquanId: 2026, displayValue: 2999 }),
  camping: Object.freeze({ name: '露营', coinValue: 388, tianquanId: 2023, displayValue: 388 }),
  dragon: Object.freeze({ name: '龙腾万里', coinValue: 11888, tianquanId: 1633, displayValue: 199999 }),
  supercar: Object.freeze({ name: '超级跑车', coinValue: 1314, tianquanId: 2027, displayValue: 1314 }),
  helicopter: Object.freeze({ name: '直升机', coinValue: 18880, tianquanId: 1000000110, displayValue: 18888 }),
})

/** A model may select a current recipient and a fixed effect, never its display names or sender. */
export interface AgentGiftPlan {
  readonly version: 1
  readonly recipient: PlatformUserRef
  readonly giftType: AgentGiftType
}

/** Source identity is captured by the host from a current, authorized human turn. */
export interface AgentGiftAction {
  readonly version: 1
  readonly kind: 'qq.gift-display'
  readonly binding: AgentBindingSnapshot
  readonly source: { readonly messageId: string; readonly author: PlatformUserRef }
  readonly plan: AgentGiftPlan
}

/** Confirmation means the native API accepted this display packet, not a client render or payment. */
export type AgentGiftReceipt =
  | { readonly state: 'confirmed'; readonly evidence: 'packet-accepted' }
  | { readonly state: 'failed'; readonly code?: string }
  | { readonly state: 'unknown' }

export interface AgentGiftResult {
  readonly state: 'confirmed' | 'failed' | 'unknown'
  readonly completed: 0 | 1
  readonly code?: string
}

export interface AgentGiftGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  /** Recheck binding, original source, privacy, configuration, explicit authorization and budget. */
  ensureCurrent(): Promise<void>
}

export type AgentGiftDeliveryPort = (action: AgentGiftAction, guard: AgentGiftGuard) => Promise<AgentGiftReceipt>

/** Host integration seam; the host builds an action from this scoped human request. */
export type AgentGiftToolExecutor = (plan: AgentGiftPlan, context: AgentToolContext) => Promise<AgentGiftResult>
