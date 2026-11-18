import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'
import type { IncomingMessage } from './platformMessage.js'
import type { PersonaSnapshot } from './persona.js'

export type AgentTextTriggerPhase = 'cold' | 'focus' | 'fading'
export type AgentTextTriggerTalkOverride =
  | { readonly target: ConversationAddress; readonly value: number }
  | { readonly bindingId: string; readonly value: number }

/** Frequency, continuation and scheduling knobs retain the legacy units in their names. */
export interface AgentTextTriggerSmartConfig {
  readonly talkValue?: number
  readonly groupTalkValues?: readonly AgentTextTriggerTalkOverride[] | Readonly<Record<string, number>>
  readonly enableTalkValueRules?: boolean
  readonly talkValueRules?: readonly { readonly range: string; readonly value: number }[]
  readonly idleCompensationEnabled?: boolean
  readonly avgLatencyDefaultMs?: number
  readonly timingGateCooldownSeconds?: number
  readonly gateContextSize?: number
  readonly waitToolEnabled?: boolean
  readonly inevitableAtReply?: boolean
  readonly mentionedNameReply?: boolean
  readonly attentionDrift?: { readonly enabled?: boolean; readonly level?: 'subtle' | 'normal' | 'strong'; readonly windowMinutes?: number }
  readonly replyDebounceMs?: number
  readonly directTriggerMergeMs?: number
  readonly toolRequestMergeMs?: number
  readonly directTriggerMergeMaxMessages?: number
  readonly maxConsecutiveInterrupts?: number
  readonly activeChatTtlHours?: number
  readonly proactiveReplyNoQuote?: boolean
  readonly smartLockTimeoutMs?: number
  readonly typingSpeed?: number
  readonly focusDurationMs?: number
  readonly fadingDurationMs?: number
  readonly focusMaxReplies?: number
  readonly focusMaxNoAction?: number
  readonly fadingForceGate?: boolean
  readonly quickResponseMs?: number
  readonly continuationLookbackMs?: number
  readonly continuationFollowupMatch?: boolean
  readonly continuationKeywordMatch?: boolean
  readonly continuationQuestionMatch?: boolean
  readonly continuationFeedbackMatch?: boolean
  readonly continuationKeywordMaxCount?: number
  readonly maxRepliesPer10Min?: number
  readonly rateLimitCooldownMs?: number
  readonly deferredGateEnabled?: boolean
  readonly minDeferredMs?: number
  readonly maxDeferredMs?: number
  readonly skipWhenAddressedOther?: boolean
  readonly skipWhenEmptyText?: boolean
  readonly promptHintBusyGroupRate?: number
  readonly promptHintRateLimitWarn?: number
  readonly repeatJoinEnabled?: boolean
  readonly repeatDetectionWindow?: number
  readonly repeatMinCount?: number
  readonly repeatJoinProbability?: number
  readonly repeatJoinCooldownMs?: number
  readonly repeatMaxTextLength?: number
}

export interface AgentTextTriggerConfig {
  readonly mode?: 'strict' | 'smart'
  readonly triggerPrefixes?: readonly string[]
  readonly tracking?: { readonly enabled?: boolean; readonly timeoutMs?: number; readonly throttleMs?: number; readonly batchDelayMs?: number }
  readonly smart?: AgentTextTriggerSmartConfig
}

export interface ResolvedAgentTextTriggerConfig {
  readonly mode: 'strict' | 'smart'
  readonly triggerPrefixes: readonly string[]
  readonly tracking: Readonly<Required<NonNullable<AgentTextTriggerConfig['tracking']>>>
  readonly smart: Readonly<Required<Omit<AgentTextTriggerSmartConfig, 'groupTalkValues' | 'attentionDrift' | 'talkValueRules'>> & {
    readonly groupTalkValues: readonly AgentTextTriggerTalkOverride[]
    readonly attentionDrift: Readonly<Required<NonNullable<AgentTextTriggerSmartConfig['attentionDrift']>>>
    readonly talkValueRules: readonly { readonly range: string; readonly value: number }[]
  }>
}

/** Owned by one full conversation/binding token. No timers, model calls or platform objects. */
export interface AgentTextTriggerState {
  bindingToken: string | null
  targetKey: string | null
  pendingCount: number
  lastMsgAt: number
  lastBotReplyAt: number
  lastBotReplyToUserId: string | null
  lastBotReplyKeywords: string[]
  lastGateNoActionAt: number
  conversationPhase: AgentTextTriggerPhase
  phaseUntil: number
  focusReplyCount: number
  consecutiveNoAction: number
  lastRepeatJoinAt: number
  recentIncomingTimestamps: number[]
  recentReplyTimestamps: number[]
  replyLatencies: { at: number; ms: number }[]
  recentMessages: { userId: string; text: string; at: number }[]
  observedMessageKeys: string[]
  topics: { word: string; count: number; firstAt: number; at: number }[]
}

export interface AgentTextTriggerPrefilter { readonly kind: string; readonly reason: string }
export interface AgentTextTriggerStats {
  readonly recentReplyCount: number
  readonly groupMsgRate5min: number
  readonly avgReplyLatencyMs: number
  readonly sinceLastBotReplyMs: number | null
  readonly sinceLastMsgMs: number | null
  readonly hourMinute: string
  readonly isLateNight: boolean
  readonly attention?: { readonly word: string; readonly count: number; readonly firstAt: number }
}

export interface AgentTextTriggerInput {
  readonly message: IncomingMessage
  readonly binding: AgentBindingSnapshot
  readonly bindingToken: string
  readonly persona?: PersonaSnapshot
  readonly personaName?: string
  /** Trusted caller checked quote.messageId against confirmed bot replies in this exact binding. */
  readonly quotesBot?: boolean
  readonly state: AgentTextTriggerState
  readonly config: ResolvedAgentTextTriggerConfig
  readonly now: number
  /** A supplied uniform [0,1) sample. Omission never invents randomness or joins a repeat. */
  readonly random?: number
  /** False for a scheduled gate recheck of an already observed message. */
  readonly observe?: boolean
}

export interface AgentTextTriggerDecision {
  readonly kind: 'forced' | 'gate' | 'skip' | 'repeat'
  readonly reason: string
  readonly prefilter: AgentTextTriggerPrefilter
  readonly phase: AgentTextTriggerPhase
  readonly threshold: number
  readonly talkValue: number
  readonly idleHit: boolean
  readonly stats: AgentTextTriggerStats
  /** Present only for a repeat; the caller still applies its outbound guard and confirmation. */
  readonly text?: string
}

export interface AgentTextTriggerReply {
  readonly message: IncomingMessage
  readonly bindingToken: string
  readonly text: string
  readonly now: number
  readonly forced: boolean
  readonly latencyMs?: number
  readonly repeat?: boolean
}
