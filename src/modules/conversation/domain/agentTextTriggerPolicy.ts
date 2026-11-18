import type { PlatformUserRef } from '../../../contracts/agentBinding.js'
import type {
  AgentTextTriggerDecision, AgentTextTriggerInput, AgentTextTriggerPrefilter,
  AgentTextTriggerReply, AgentTextTriggerState, ResolvedAgentTextTriggerConfig,
} from '../../../contracts/agentTextTrigger.js'
import {
  agentBindingToken, conversationAddressKey,
} from '../../runtime/domain/agentBindings.js'
import {
  extractChatKeywords, isFeedbackMessage, isLikelyFollowupMessage, isParenthesizedAside, isQuestionMessage,
  looksDirectedAtBotByPronoun, looksGroupAddressed, PREVIOUS_SPEAKER_REPLY_PATTERNS,
} from './messageIntent.js'

const shanghaiClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function createAgentTextTriggerState(): AgentTextTriggerState {
  return { bindingToken: null, targetKey: null, pendingCount: 0, lastMsgAt: 0, lastBotReplyAt: 0, lastBotReplyToUserId: null,
    lastBotReplyKeywords: [], lastGateNoActionAt: 0, conversationPhase: 'cold', phaseUntil: 0, focusReplyCount: 0,
    consecutiveNoAction: 0, lastRepeatJoinAt: 0, recentIncomingTimestamps: [], recentReplyTimestamps: [], replyLatencies: [],
    recentMessages: [], observedMessageKeys: [], topics: [] }
}
function sameUser(user: PlatformUserRef | undefined, account: PlatformUserRef): boolean {
  return !!user && user.platform === account.platform && user.namespace === account.namespace && user.id === account.id
}
function phase(state: AgentTextTriggerState, now: number, config: ResolvedAgentTextTriggerConfig): void {
  while (state.phaseUntil && now > state.phaseUntil) {
    if (state.conversationPhase === 'focus') {
      state.conversationPhase = 'fading'; state.phaseUntil += config.smart.fadingDurationMs; state.consecutiveNoAction = 0
    } else {
      state.conversationPhase = 'cold'; state.phaseUntil = 0; state.focusReplyCount = 0; state.consecutiveNoAction = 0
    }
  }
}
function signals(input: AgentTextTriggerInput) {
  const { message, binding, config } = input, text = message.text.toLowerCase()
  const at = message.directedToAccount || message.mentions.some(user => sameUser(user, binding.target.account)) ||
    message.parts.some(part => part.kind === 'mention' && part.user !== 'everyone' && sameUser(part.user, binding.target.account))
  const quote = sameUser(message.quote?.author, binding.target.account) || input.quotesBot === true && !!message.quote?.messageId
  const name = input.personaName ?? input.persona?.personaName ?? input.persona?.persona.name ?? ''
  const named = !!name && text.includes(name.toLowerCase())
  const prefix = config.triggerPrefixes.some(value => text.includes(value.toLowerCase()))
  return { at, quote, named, prefix, explicit: at || quote || named || prefix }
}
function prefilter(input: AgentTextTriggerInput, signal: ReturnType<typeof signals>): AgentTextTriggerPrefilter {
  const { message, binding, config, state, now } = input, smart = config.smart, text = message.text.trim()
  if (sameUser(message.sender, binding.target.account)) return { kind: 'bot_self_echo', reason: 'sender_is_self' }
  if (isParenthesizedAside(text)) return { kind: 'aside_content', reason: 'parenthesized_aside' }
  const other = message.mentions.some(user => !sameUser(user, binding.target.account)) ||
    message.parts.some(part => part.kind === 'mention' && (part.user === 'everyone' || !sameUser(part.user, binding.target.account)))
  if (smart.skipWhenAddressedOther && other && !signal.explicit) return { kind: 'addressed_other', reason: 'at_other_user' }
  if (smart.skipWhenEmptyText && !text && !signal.at && !signal.quote) {
    return message.parts.some(part => part.kind === 'forward') ? { kind: 'regular', reason: 'forward_context' } : { kind: 'empty_content', reason: 'no_text' }
  }
  if (!signal.explicit && message.quote?.author && !signal.quote) return { kind: 'addressed_other', reason: 'reply_other_user' }
  const since = state.lastBotReplyAt ? now - state.lastBotReplyAt : Infinity
  const same = state.lastBotReplyToUserId === message.sender.id
  if (!signal.explicit && !same && !looksGroupAddressed(text) && looksDirectedAtBotByPronoun(text)) return { kind: 'likely_addressed_other', reason: 'pronoun_without_bot_anchor' }
  const previous = state.recentMessages.at(-1)
  if (!signal.explicit && !same && previous && previous.userId !== message.sender.id && previous.userId !== binding.target.account.id &&
      now >= previous.at && now - previous.at <= 120_000 && !looksGroupAddressed(text) &&
      (PREVIOUS_SPEAKER_REPLY_PATTERNS.some(pattern => pattern.test(text)) || text.length <= 18 && !isQuestionMessage(text))) {
    return { kind: 'likely_addressed_other', reason: 'reply_previous_speaker' }
  }
  if (signal.at) return { kind: 'continuation_strong', reason: 'at_bot' }
  if (signal.quote) return { kind: 'continuation_strong', reason: 'reply_bot' }
  if (since >= 0 && since <= smart.continuationLookbackMs && same && smart.continuationFollowupMatch && isLikelyFollowupMessage(text)) return { kind: 'continuation_strong', reason: 'R0_same_user_followup' }
  if (since >= 0 && smart.quickResponseMs > 0 && since <= smart.quickResponseMs && (same || signal.named || signal.prefix)) return { kind: 'continuation_strong', reason: 'R1_quick_response' }
  if (since >= 0 && since <= smart.continuationLookbackMs && (same || signal.explicit)) {
    const keyword = smart.continuationKeywordMatch ? state.lastBotReplyKeywords.find(word => !!word && text.includes(word)) : undefined
    if (keyword) return { kind: 'continuation_strong', reason: `R2_keyword:${keyword}` }
    if (smart.continuationQuestionMatch && isQuestionMessage(text)) return { kind: 'continuation_strong', reason: 'R3_question' }
    if (smart.continuationFeedbackMatch && isFeedbackMessage(text)) return { kind: 'continuation_strong', reason: 'R4_feedback' }
  }
  return { kind: 'regular', reason: '' }
}
function talkValue(input: AgentTextTriggerInput, hhmm: string): number {
  const { config, binding } = input, smart = config.smart
  const explicitBinding = smart.groupTalkValues.find(entry => 'bindingId' in entry && entry.bindingId === binding.id)
  const override = explicitBinding ?? smart.groupTalkValues.find(entry => 'target' in entry && conversationAddressKey(entry.target) === conversationAddressKey(binding.target))
  if (override) return override.value
  if (smart.enableTalkValueRules) {
    for (const rule of smart.talkValueRules) {
      const [start, end] = rule.range.split('-') as [string, string]
      if (start <= end ? hhmm >= start && hhmm <= end : hhmm >= start || hhmm <= end) return rule.value
    }
  }
  return smart.talkValue
}
function trim(state: AgentTextTriggerState, now: number): void {
  state.recentReplyTimestamps = state.recentReplyTimestamps.filter(at => at <= now && at > now - 600_000).slice(-1000)
  state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(at => at <= now && at > now - 300_000).slice(-10_000)
  state.replyLatencies = state.replyLatencies.filter(value => value.at <= now && value.at >= now - 600_000).slice(-50)
  state.topics = state.topics.filter(value => value.at <= now && value.at >= now - 1_800_000).slice(-256)
}

/** Mutates only caller-owned in-memory state; no model, timers, sends or ambient randomness. */
export function evaluateAgentTextTrigger(input: AgentTextTriggerInput): AgentTextTriggerDecision {
  const { message, binding, state, config, now } = input, targetKey = conversationAddressKey(message.conversation)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('textTrigger.now 无效')
  const bindingValid = input.bindingToken === agentBindingToken(binding) && targetKey === conversationAddressKey(binding.target) &&
    message.sender.platform === binding.target.account.platform && message.sender.namespace === binding.target.account.namespace &&
    (!message.binding || agentBindingToken(message.binding) === input.bindingToken && conversationAddressKey(message.binding.target) === targetKey) &&
    (!input.persona?.binding || agentBindingToken(input.persona.binding) === input.bindingToken && conversationAddressKey(input.persona.binding.target) === targetKey)
  if (bindingValid && (state.bindingToken !== input.bindingToken || state.targetKey !== targetKey)) {
    Object.assign(state, createAgentTextTriggerState(), { bindingToken: input.bindingToken, targetKey })
  }
  if (bindingValid) { trim(state, now); phase(state, now, config) }
  const previousLastMsgAt = state.lastMsgAt, signal = signals(input)
  const filtered = bindingValid ? prefilter(input, signal) : { kind: 'invalid_binding', reason: 'binding_changed' }
  const duplicate = !!message.messageId && state.observedMessageKeys.includes(message.messageId)
  const observe = bindingValid && input.observe !== false && !duplicate
  const ignored = ['invalid_binding', 'bot_self_echo', 'aside_content', 'addressed_other', 'likely_addressed_other', 'empty_content'].includes(filtered.kind)
  if (observe) {
    state.lastMsgAt = now; state.recentIncomingTimestamps.push(now)
    if (message.messageId) { state.observedMessageKeys.push(message.messageId); state.observedMessageKeys = state.observedMessageKeys.slice(-128) }
    if (!ignored) {
      state.pendingCount = Math.min(1_000_000, state.pendingCount + 1)
      for (const word of extractChatKeywords(message.text, 4)) {
        const entry = state.topics.find(value => value.word === word)
        if (entry) { entry.count++; entry.at = now } else state.topics.push({ word, count: 1, firstAt: now, at: now })
      }
      state.topics = state.topics.slice(-256)
    }
  }
  const hhmm = shanghaiClock.format(now), hour = Number(hhmm.slice(0, 2)), value = talkValue(input, hhmm)
  const rawThreshold = Math.max(1, Math.ceil(1 / value))
  let threshold = state.conversationPhase === 'fading' ? Math.max(1, Math.floor(rawThreshold / 2)) : rawThreshold
  const attention = config.smart.attentionDrift.enabled ? state.topics.filter(entry => entry.firstAt <= now && entry.firstAt >= now - config.smart.attentionDrift.windowMinutes * 60_000 && entry.count >= 2)
    .sort((a, b) => b.count - a.count)[0] : undefined
  if (attention && config.smart.attentionDrift.level === 'strong') threshold = Math.max(1, threshold - 1)
  const average = state.replyLatencies.length ? state.replyLatencies.reduce((sum, row) => sum + row.ms, 0) / state.replyLatencies.length : 0
  const idleHit = config.smart.idleCompensationEnabled && !!previousLastMsgAt && state.pendingCount + Math.max(0, now - previousLastMsgAt) / (average || config.smart.avgLatencyDefaultMs) >= threshold
  const stats = { recentReplyCount: state.recentReplyTimestamps.length, groupMsgRate5min: state.recentIncomingTimestamps.length,
    avgReplyLatencyMs: average, sinceLastBotReplyMs: state.lastBotReplyAt ? Math.max(0, now - state.lastBotReplyAt) : null,
    sinceLastMsgMs: previousLastMsgAt ? Math.max(0, now - previousLastMsgAt) : null, hourMinute: hhmm, isLateNight: hour >= 23 || hour < 6,
    ...(attention ? { attention: { word: attention.word, count: attention.count, firstAt: attention.firstAt } } : {}) }
  const decide = (kind: AgentTextTriggerDecision['kind'], reason: string, text?: string): AgentTextTriggerDecision => ({ kind, reason, prefilter: filtered,
    phase: state.conversationPhase, threshold, talkValue: value, idleHit, stats, ...(text === undefined ? {} : { text }) })
  let decision: AgentTextTriggerDecision
  if (ignored) decision = decide('skip', filtered.reason)
  else if (duplicate && input.observe !== false) decision = decide('skip', 'duplicate_source')
  else if (config.mode === 'strict') decision = signal.at || signal.quote || signal.prefix || signal.named
    ? decide('forced', 'direct_trigger') : decide('skip', 'strict_unaddressed')
  else {
    const continuationForce = filtered.kind === 'continuation_strong' && ['at_bot', 'reply_bot', 'R0_same_user_followup'].includes(filtered.reason)
    const forced = continuationForce || config.smart.inevitableAtReply && (signal.at || signal.quote || signal.prefix) || config.smart.mentionedNameReply && signal.named
    const forceGate = filtered.kind === 'continuation_strong'
    if (forced) decision = decide('forced', continuationForce ? filtered.reason : 'direct_trigger')
    else {
      // The legacy detection window includes the current message, which is appended below.
      const text = message.text.trim(), recent = state.recentMessages.slice(-(config.smart.repeatDetectionWindow - 1))
      const users = new Set(recent.filter(row => row.text === text && row.userId !== binding.target.account.id).map(row => row.userId))
      users.add(message.sender.id)
      const repeat = config.smart.repeatJoinEnabled && !signal.explicit && !!text && text.length <= config.smart.repeatMaxTextLength && users.size >= config.smart.repeatMinCount &&
        (!state.lastRepeatJoinAt || now - state.lastRepeatJoinAt >= config.smart.repeatJoinCooldownMs) &&
        input.random !== undefined && Number.isFinite(input.random) && input.random >= 0 && input.random < 1 && input.random < config.smart.repeatJoinProbability
      if (state.recentReplyTimestamps.length >= config.smart.maxRepliesPer10Min) {
        state.conversationPhase = 'fading'; state.phaseUntil = now + config.smart.rateLimitCooldownMs; state.pendingCount = 0
        decision = decide('skip', 'rate_limit')
      } else if (repeat) decision = decide('repeat', 'group_repeat', text)
      else if (!forceGate && state.lastGateNoActionAt && now - state.lastGateNoActionAt < config.smart.timingGateCooldownSeconds * 1000) decision = decide('skip', 'gate_cooldown')
      else if (!forceGate && state.pendingCount < threshold && !idleHit) decision = decide('skip', 'below_threshold')
      else decision = decide('gate', forceGate ? filtered.reason : idleHit ? 'idle_compensation' : 'threshold')
    }
  }
  if (observe && !['bot_self_echo', 'aside_content', 'invalid_binding'].includes(filtered.kind) && message.text.trim()) {
    state.recentMessages.push({ userId: message.sender.id, text: message.text.trim(), at: now }); state.recentMessages = state.recentMessages.slice(-10)
  }
  return decision
}

/** Gate outcomes consume no outbound quota; confirmed delivery is recorded separately. */
export function recordAgentTextTriggerGate(state: AgentTextTriggerState, decision: 'continue' | 'no_action' | 'wait', now: number,
  config: ResolvedAgentTextTriggerConfig): void {
  if (!Number.isSafeInteger(now) || now < 0 || !['continue', 'no_action', 'wait'].includes(decision)) throw new Error('textTrigger.gate 无效')
  state.pendingCount = 0
  if (decision !== 'no_action') { state.consecutiveNoAction = 0; return }
  state.lastGateNoActionAt = now
  if (state.conversationPhase === 'focus' && ++state.consecutiveNoAction >= config.smart.focusMaxNoAction) {
    state.conversationPhase = 'fading'; state.phaseUntil = now + config.smart.fadingDurationMs; state.consecutiveNoAction = 0
  }
}

/** Call only after a real sent receipt. Failed/unknown dispatches must never reach this function. */
export function recordAgentTextTriggerReply(state: AgentTextTriggerState, reply: AgentTextTriggerReply, config: ResolvedAgentTextTriggerConfig): boolean {
  if (!Number.isSafeInteger(reply.now) || reply.now < 0 || reply.bindingToken !== state.bindingToken ||
      conversationAddressKey(reply.message.conversation) !== state.targetKey) return false
  trim(state, reply.now)
  state.recentReplyTimestamps.push(reply.now); state.pendingCount = 0; state.lastGateNoActionAt = 0; state.consecutiveNoAction = 0
  state.lastBotReplyAt = reply.now; state.lastBotReplyToUserId = reply.message.sender.id
  state.lastBotReplyKeywords = extractChatKeywords(reply.text, config.smart.continuationKeywordMaxCount)
  if (reply.latencyMs !== undefined && Number.isFinite(reply.latencyMs) && reply.latencyMs > 0) {
    state.replyLatencies.push({ at: reply.now, ms: reply.latencyMs }); state.replyLatencies = state.replyLatencies.slice(-50)
  }
  if (reply.repeat) { state.lastRepeatJoinAt = reply.now; return true }
  if (reply.forced && state.conversationPhase !== 'focus') state.focusReplyCount = 0
  state.conversationPhase = 'focus'; state.phaseUntil = reply.now + config.smart.focusDurationMs
  if (!reply.forced && ++state.focusReplyCount >= config.smart.focusMaxReplies) {
    state.conversationPhase = 'fading'; state.phaseUntil = reply.now + config.smart.fadingDurationMs
  }
  return true
}
