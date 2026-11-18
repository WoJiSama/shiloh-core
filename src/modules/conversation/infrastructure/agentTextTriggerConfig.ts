import { types } from 'node:util'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentTextTriggerTalkOverride, ResolvedAgentTextTriggerConfig } from '../../../contracts/agentTextTrigger.js'
import { conversationAddressKey, decodeConversationAddressKey } from '../../runtime/domain/agentBindings.js'

const smartDefaults = {
  talkValue: 0.07, enableTalkValueRules: false, idleCompensationEnabled: true, avgLatencyDefaultMs: 60_000,
  timingGateCooldownSeconds: 5, gateContextSize: 10, waitToolEnabled: true, inevitableAtReply: true, mentionedNameReply: false,
  replyDebounceMs: 1500, directTriggerMergeMs: 1000, toolRequestMergeMs: 600, directTriggerMergeMaxMessages: 8,
  maxConsecutiveInterrupts: 3, activeChatTtlHours: 24, proactiveReplyNoQuote: true, smartLockTimeoutMs: 180_000, typingSpeed: 0,
  focusDurationMs: 180_000, fadingDurationMs: 90_000, focusMaxReplies: 4, focusMaxNoAction: 2, fadingForceGate: false,
  quickResponseMs: 30_000, continuationLookbackMs: 180_000, continuationFollowupMatch: true, continuationKeywordMatch: true,
  continuationQuestionMatch: true, continuationFeedbackMatch: true, continuationKeywordMaxCount: 5,
  maxRepliesPer10Min: 8, rateLimitCooldownMs: 300_000, deferredGateEnabled: true, minDeferredMs: 120_000, maxDeferredMs: 900_000,
  skipWhenAddressedOther: true, skipWhenEmptyText: true, promptHintBusyGroupRate: 30, promptHintRateLimitWarn: 5,
  repeatJoinEnabled: true, repeatDetectionWindow: 5, repeatMinCount: 3, repeatJoinProbability: 0.6,
  repeatJoinCooldownMs: 180_000, repeatMaxTextLength: 30,
} as const
const defaultRules = [{ range: '08:00-22:59', value: 0.07 }, { range: '23:00-23:59', value: 0.05 }, { range: '00:00-07:59', value: 0.034 }]

function invalid(path: string): never { throw new Error(`textTrigger.${path} 配置无效`) }
function object(input: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid(path)
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !field || !Object.hasOwn(field, 'value') || !field.enumerable) invalid(path)
    result[key] = field.value
  }
  return result
}
function array(input: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) invalid(path)
  const values: unknown[] = []
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) invalid(path)
    values.push(field.value)
  }
  return values
}
function numeric(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) invalid(path)
  return value
}
function address(input: unknown, path: string): ConversationAddress {
  const raw = object(input, path, ['account', 'kind', 'id']), account = object(raw.account, path + '.account', ['platform', 'namespace', 'id'])
  const key = JSON.stringify([account.platform, account.namespace, account.id, raw.kind, raw.id]), target = decodeConversationAddressKey(key)
  if (!target) invalid(path)
  return Object.freeze({ ...target, account: Object.freeze(target.account) })
}
function override(input: unknown, path: string): AgentTextTriggerTalkOverride {
  const raw = object(input, path, ['target', 'bindingId', 'value']), value = numeric(raw.value, path + '.value', 0.01, 1)
  if (Object.hasOwn(raw, 'target') === Object.hasOwn(raw, 'bindingId')) invalid(path)
  if (Object.hasOwn(raw, 'target')) return Object.freeze({ target: address(raw.target, path + '.target'), value })
  if (typeof raw.bindingId !== 'string' || !raw.bindingId || raw.bindingId.length > 4096 || raw.bindingId.trim() !== raw.bindingId || /[\u0000-\u001f\u007f]/u.test(raw.bindingId)) invalid(path + '.bindingId')
  return Object.freeze({ bindingId: raw.bindingId, value })
}

/** Strict, side-effect-free decoding; omitted configuration preserves direct-only group chat. */
export function resolveAgentTextTriggerConfig(input: unknown): ResolvedAgentTextTriggerConfig {
  const raw = input === undefined ? {} : object(input, 'root', ['mode', 'triggerPrefixes', 'tracking', 'smart'])
  const mode = raw.mode === undefined && !Object.hasOwn(raw, 'mode') ? 'strict' : raw.mode
  if (mode !== 'strict' && mode !== 'smart') invalid('mode')
  const prefixes = Object.hasOwn(raw, 'triggerPrefixes') ? array(raw.triggerPrefixes, 'triggerPrefixes', 64) : []
  if (!prefixes.every(value => typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value))) invalid('triggerPrefixes')
  const trackingRaw = Object.hasOwn(raw, 'tracking') ? object(raw.tracking, 'tracking', ['enabled', 'timeoutMs', 'throttleMs', 'batchDelayMs']) : {}
  if (Object.hasOwn(trackingRaw, 'enabled') && typeof trackingRaw.enabled !== 'boolean') invalid('tracking.enabled')
  const tracking = Object.freeze({ enabled: trackingRaw.enabled === true,
    timeoutMs: Object.hasOwn(trackingRaw, 'timeoutMs') ? numeric(trackingRaw.timeoutMs, 'tracking.timeoutMs', 1000, 86_400_000, true) : 120_000,
    throttleMs: Object.hasOwn(trackingRaw, 'throttleMs') ? numeric(trackingRaw.throttleMs, 'tracking.throttleMs', 0, 86_400_000, true) : 3000,
    batchDelayMs: Object.hasOwn(trackingRaw, 'batchDelayMs') ? numeric(trackingRaw.batchDelayMs, 'tracking.batchDelayMs', 0, 60_000, true) : 10_000,
  })
  const smartRaw = Object.hasOwn(raw, 'smart') ? object(raw.smart, 'smart', [...Object.keys(smartDefaults), 'attentionDrift', 'groupTalkValues', 'talkValueRules']) : {}
  const simple: Record<string, number | boolean> = { ...smartDefaults }
  for (const [key, fallback] of Object.entries(smartDefaults)) {
    if (!Object.hasOwn(smartRaw, key)) continue
    const value = smartRaw[key]
    if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean') invalid('smart.' + key)
      simple[key] = value
    } else {
      const probability = key === 'talkValue' || key === 'repeatJoinProbability'
      const fractional = probability || key === 'timingGateCooldownSeconds' || key === 'activeChatTtlHours' || key === 'typingSpeed'
      const zeroAllowed = ['replyDebounceMs', 'directTriggerMergeMs', 'toolRequestMergeMs', 'maxConsecutiveInterrupts', 'smartLockTimeoutMs', 'typingSpeed', 'quickResponseMs', 'timingGateCooldownSeconds', 'repeatJoinCooldownMs', 'repeatJoinProbability'].includes(key)
      simple[key] = numeric(value, 'smart.' + key, key === 'talkValue' ? 0.01 : zeroAllowed ? 0 : 1,
        probability ? 1 : key === 'activeChatTtlHours' ? 8760 : key === 'typingSpeed' ? 1000 : key === 'timingGateCooldownSeconds' ? 86_400 : 86_400_000, !fractional)
    }
  }
  for (const [key, low, high] of [['directTriggerMergeMaxMessages', 2, 20], ['repeatDetectionWindow', 2, 100], ['repeatMinCount', 2, 100],
    ['gateContextSize', 5, 100], ['continuationKeywordMaxCount', 1, 50], ['repeatMaxTextLength', 1, 1000],
    ['maxRepliesPer10Min', 1, 1000], ['focusMaxReplies', 1, 1000], ['focusMaxNoAction', 1, 1000]] as const) {
    numeric(simple[key], 'smart.' + key, low, high, true)
  }
  if (Number(simple.minDeferredMs) > Number(simple.maxDeferredMs)) invalid('smart.minDeferredMs')
  const attentionRaw = Object.hasOwn(smartRaw, 'attentionDrift') ? object(smartRaw.attentionDrift, 'smart.attentionDrift', ['enabled', 'level', 'windowMinutes']) : {}
  if (Object.hasOwn(attentionRaw, 'enabled') && typeof attentionRaw.enabled !== 'boolean') invalid('smart.attentionDrift.enabled')
  const level = attentionRaw.level === undefined && !Object.hasOwn(attentionRaw, 'level') ? 'normal' : attentionRaw.level
  if (level !== 'subtle' && level !== 'normal' && level !== 'strong') invalid('smart.attentionDrift.level')
  const attentionDrift = Object.freeze({ enabled: attentionRaw.enabled !== false, level,
    windowMinutes: Object.hasOwn(attentionRaw, 'windowMinutes') ? numeric(attentionRaw.windowMinutes, 'smart.attentionDrift.windowMinutes', 1, 1440) : 5 })
  const overrides: AgentTextTriggerTalkOverride[] = []
  if (Object.hasOwn(smartRaw, 'groupTalkValues')) {
    if (Array.isArray(smartRaw.groupTalkValues)) {
      array(smartRaw.groupTalkValues, 'smart.groupTalkValues', 256).forEach((value, index) => overrides.push(override(value, `smart.groupTalkValues[${index}]`)))
    } else {
      const map = object(smartRaw.groupTalkValues, 'smart.groupTalkValues')
      if (Object.keys(map).length > 256) invalid('smart.groupTalkValues')
      for (const [key, value] of Object.entries(map)) {
        const target = decodeConversationAddressKey(key)
        if (!target) invalid('smart.groupTalkValues')
        overrides.push(override({ target, value }, 'smart.groupTalkValues'))
      }
    }
  }
  const overrideKeys = overrides.map(value => 'target' in value ? 'target:' + conversationAddressKey(value.target) : 'binding:' + value.bindingId)
  if (new Set(overrideKeys).size !== overrideKeys.length) invalid('smart.groupTalkValues')
  const rules = Object.hasOwn(smartRaw, 'talkValueRules') ? array(smartRaw.talkValueRules, 'smart.talkValueRules', 128) : defaultRules
  const talkValueRules = rules.map((entry, index) => {
    const path = `smart.talkValueRules[${index}]`, value = object(entry, path, ['range', 'value'])
    if (typeof value.range !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.range)) invalid(path + '.range')
    return Object.freeze({ range: value.range, value: numeric(value.value, path + '.value', 0.01, 1) })
  })
  return Object.freeze({ mode, triggerPrefixes: Object.freeze([...new Set(prefixes as string[])]), tracking,
    smart: Object.freeze({ ...simple, attentionDrift, groupTalkValues: Object.freeze(overrides), talkValueRules: Object.freeze(talkValueRules) }) as ResolvedAgentTextTriggerConfig['smart'] })
}
