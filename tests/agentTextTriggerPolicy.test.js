import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentTextTriggerState: createState, evaluateAgentTextTrigger: evaluate,
  recordAgentTextTriggerReply: reply, recordAgentTextTriggerGate: gate } = await load('modules/conversation/domain/agentTextTriggerPolicy.js')
const { resolveAgentTextTriggerConfig: resolve } = await load('modules/conversation/infrastructure/agentTextTriggerConfig.js')
const { agentBindingToken, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const now = Date.parse('2026-11-17T04:00:00Z')
const account = { platform: 'fixture', namespace: 'trigger-policy', id: 'bot' }
const target = { account, kind: 'group', id: 'room' }
const bindingFor = (selected = target, extra = {}) => ({ source: 'configured', id: conversationAddressKey(selected), revision: 'v1',
  agentId: 'daily', personaId: 'persona', connectionId: 'connection', target: selected, ...extra })
const binding = bindingFor()
let sequence = 0
function message(text = '这是一条独立的新话题消息，内容足够完整', extra = {}) {
  return { version: 1, conversation: target, sender: { ...account, id: 'human' }, text,
    messageId: 'source-' + ++sequence, occurredAt: now, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...extra }
}
function input(extra = {}) {
  return { message: message(), binding, bindingToken: agentBindingToken(binding), personaName: '希洛', state: createState(),
    config: resolve({ mode: 'smart', smart: { repeatJoinEnabled: false, idleCompensationEnabled: false } }), now, ...extra }
}
function smart(values = {}, other = {}) { return resolve({ mode: 'smart', smart: { repeatJoinEnabled: false, idleCompensationEnabled: false, ...values }, ...other }) }
function confirmed(f, text = '已确认的机器人回复', extra = {}) {
  return reply(f.state, { message: f.message, bindingToken: f.bindingToken, text, now: f.now, forced: true, ...extra }, f.config)
}

test('defaults are strict, immutable and preserve legacy timing units without enabling tracking', () => {
  const config = resolve(undefined)
  assert.equal(config.mode, 'strict'); assert.deepEqual(config.triggerPrefixes, [])
  assert.deepEqual(config.tracking, { enabled: false, timeoutMs: 120000, throttleMs: 3000, batchDelayMs: 10000 })
  assert.equal(config.smart.talkValue, 0.07); assert.equal(config.smart.focusDurationMs, 180000)
  for (const value of [config, config.tracking, config.triggerPrefixes, config.smart, config.smart.attentionDrift, config.smart.talkValueRules, config.smart.talkValueRules[0]]) assert.equal(Object.isFrozen(value), true)
})

test('configuration rejects unknown, invalid and accessor fields without reading them', () => {
  const getter = {}; let touched = false
  Object.defineProperty(getter, 'mode', { enumerable: true, get() { touched = true; throw Error('unsafe') } })
  for (const value of [null, [], getter, new Proxy({}, {}), { future: true }, { mode: 'random' }, { mode: undefined }, { triggerPrefixes: [''] }, { triggerPrefixes: [3] },
    { tracking: null }, { tracking: { future: 1 } }, { tracking: { batchDelayMs: -1 } }, { tracking: { timeoutMs: NaN } },
    { smart: { future: 1 } }, { smart: { talkValue: 0 } }, { smart: { talkValue: 1.1 } }, { smart: { repeatJoinProbability: -0.1 } },
    { smart: { repeatDetectionWindow: 1 } }, { smart: { gateContextSize: 101 } }, { smart: { focusMaxReplies: 1.5 } },
    { smart: { minDeferredMs: 10, maxDeferredMs: 9 } }, { smart: { attentionDrift: { level: 'loud' } } },
    { smart: { talkValueRules: [{ range: '24:00-01:00', value: 0.1 }] } }, { smart: { talkValueRules: [{ range: '08:00-09:00', value: 0 }] } }]) {
    assert.throws(() => resolve(value), /textTrigger/u)
  }
  assert.equal(touched, false)
})

test('zero disables optional timers and probabilities; booleans and omitted arrays remain explicit', () => {
  const config = resolve({ tracking: { throttleMs: 0, batchDelayMs: 0 }, smart: { directTriggerMergeMs: 0, quickResponseMs: 0,
    replyDebounceMs: 0, smartLockTimeoutMs: 0, repeatJoinProbability: 0, repeatJoinCooldownMs: 0, timingGateCooldownSeconds: 0 } })
  assert.equal(config.smart.repeatJoinProbability, 0); assert.equal(config.tracking.batchDelayMs, 0)
  for (const value of [{ smart: { waitToolEnabled: 'false' } }, { tracking: { enabled: 1 } }, { smart: { attentionDrift: { enabled: 1 } } }]) assert.throws(() => resolve(value))
})

test('talk overrides use complete account addresses or explicit binding IDs and never raw group maps', () => {
  assert.throws(() => resolve({ smart: { groupTalkValues: { room: 1 } } }))
  assert.throws(() => resolve({ smart: { groupTalkValues: [{ group: 'room', value: 1 }] } }))
  assert.throws(() => resolve({ smart: { groupTalkValues: [{ target: { kind: 'group', id: 'room' }, value: 1 }] } }))
  assert.throws(() => resolve({ smart: { groupTalkValues: [{ target, value: 0.2 }, { target, value: 0.3 }] } }))
  const config = smart({ groupTalkValues: [{ target, value: 0.2 }, { bindingId: binding.id, value: 0.5 }] })
  assert.equal(evaluate(input({ config })).talkValue, 0.5)
  const another = { ...target, account: { ...account, id: 'another-bot' } }, b = bindingFor(another)
  assert.equal(evaluate(input({ config, binding: b, bindingToken: agentBindingToken(b), message: message(undefined, { conversation: another }) })).talkValue, 0.07)
  const map = resolve({ smart: { groupTalkValues: { [conversationAddressKey(target)]: 0.3 } } })
  assert.equal(evaluate(input({ config: map })).talkValue, 0.3)
})

test('time rules use Asia/Shanghai with inclusive endpoints and overnight ranges independently of process timezone', () => {
  const config = smart({ enableTalkValueRules: true, talkValueRules: [{ range: '23:00-07:59', value: 0.04 }, { range: '08:00-22:59', value: 0.2 }] })
  for (const [instant, hhmm, expected] of [['2026-11-17T15:00:00Z', '23:00', 0.04], ['2026-11-17T23:59:00Z', '07:59', 0.04],
    ['2026-11-18T00:00:00Z', '08:00', 0.2], ['2026-11-18T14:59:00Z', '22:59', 0.2]]) {
    const result = evaluate(input({ config, now: Date.parse(instant) }))
    assert.equal(result.talkValue, expected); assert.equal(result.stats.hourMinute, hhmm)
  }
})

test('strict mode triggers names, prefixes, verified bot quotes and mentions but never an arbitrary quote', () => {
  const config = resolve({ triggerPrefixes: ['Hey Bot'] })
  for (const m of [message('HEY BOT 帮我'), message('希洛 帮我'), message('帮我', { directedToAccount: true }),
    message('帮我', { mentions: [account] }), message('帮我', { quote: { messageId: 'own', author: account, parts: [] } })]) {
    assert.equal(evaluate(input({ config, message: m })).kind, 'forced')
  }
  const quoted = message('帮我', { quote: { messageId: 'opaque', parts: [] } })
  assert.equal(evaluate(input({ config, message: quoted })).kind, 'skip')
  assert.equal(evaluate(input({ config, message: quoted, quotesBot: true })).kind, 'forced')
  assert.equal(evaluate(input({ config, message: message('帮我'), quotesBot: true })).kind, 'skip')
})

test('self echoes and balanced parenthesized asides win over direct triggers in both modes', () => {
  for (const config of [resolve({}), smart()]) {
    const self = input({ config, message: message('希洛 测试', { sender: account, directedToAccount: true }) })
    assert.equal(evaluate(self).prefilter.kind, 'bot_self_echo'); assert.equal(self.state.pendingCount, 0)
    for (const text of ['(希洛 测试)', '（希洛 测试）', '(希洛) （你好）']) assert.equal(evaluate(input({ config, message: message(text, { directedToAccount: true }) })).reason, 'parenthesized_aside')
    assert.equal(evaluate(input({ config, message: message('(希洛 测试）', { directedToAccount: true }) })).kind, 'forced')
  }
})

test('foreign addresses, stale tokens and mismatched captured personas cannot advance state', () => {
  const f = input(), before = structuredClone(f.state)
  for (const changed of [{ bindingToken: 'old' }, { message: message(undefined, { conversation: { ...target, id: 'other' } }) },
    { message: message(undefined, { sender: { ...account, namespace: 'elsewhere', id: 'human' } }) },
    { persona: { binding: { ...binding, revision: 'old' } } }]) {
    assert.equal(evaluate({ ...f, ...changed }).reason, 'binding_changed'); assert.deepEqual(f.state, before)
  }
})

test('state resets with complete binding and account scope before a replacement can borrow prior history', () => {
  const f = input(); evaluate(f); confirmed(f, '旧人设关键词')
  const changed = bindingFor(target, { revision: 'v2' })
  const result = evaluate({ ...f, binding: changed, bindingToken: agentBindingToken(changed), message: message() })
  assert.equal(result.kind, 'skip'); assert.equal(f.state.lastBotReplyAt, 0); assert.equal(f.state.pendingCount, 1)
  const other = { ...target, account: { ...account, id: 'other-bot' } }, b = bindingFor(other)
  evaluate({ ...f, binding: b, bindingToken: agentBindingToken(b), message: message(undefined, { conversation: other }) })
  assert.equal(f.state.targetKey, conversationAddressKey(other)); assert.equal(f.state.recentIncomingTimestamps.length, 1)
})

test('addressed-other and empty messages do not accumulate pending threshold while forwards survive', () => {
  const f = input(), other = { ...account, id: 'another-person' }
  for (const m of [message('帮我', { mentions: [other] }), message('帮我', { quote: { author: other, parts: [] } }),
    message('', { parts: [{ kind: 'image' }] }), message('你刚才说什么')]) {
    assert.equal(evaluate({ ...f, message: m }).kind, 'skip'); assert.equal(f.state.pendingCount, 0)
  }
  assert.equal(evaluate({ ...f, message: message('', { parts: [{ kind: 'forward', id: 'forward' }] }) }).prefilter.reason, 'forward_context')
  assert.equal(f.state.pendingCount, 1)
  assert.equal(evaluate({ ...f, message: message('希洛，帮我', { mentions: [other] }) }).prefilter.kind, 'regular', 'an explicit name bypasses the other-user exclusion without inventing an earlier bot reply')
})

test('R0 same-user followup is forced from a confirmed reply and cannot be borrowed by a different user', () => {
  const f = input(); evaluate(f); confirmed(f)
  const followup = evaluate({ ...f, message: message('那你再解释一下'), now: now + 1000 })
  assert.equal(followup.kind, 'forced'); assert.equal(followup.reason, 'R0_same_user_followup')
  assert.equal(evaluate({ ...f, message: message('你刚才说什么', { sender: { ...account, id: 'other' } }), now: now + 1001 }).prefilter.kind, 'likely_addressed_other')
  assert.notEqual(evaluate({ ...f, message: message('那你再解释一下'), now: now + 180001 }).kind, 'forced')
})

test('quick response, keywords, questions and feedback request a gate unless R0 has stronger evidence', () => {
  for (const [text, offset, switches, expected] of [['继续聊聊', 1000, {}, 'R1_quick_response'], ['火星不错', 40000, {}, 'R2_keyword:火星'],
    ['好不好？', 40000, { continuationKeywordMatch: false }, 'R3_question'], ['好的', 40000, { continuationKeywordMatch: false, continuationQuestionMatch: false }, 'R4_feedback']]) {
    const f = input({ config: smart({ continuationFollowupMatch: false, ...switches }) }); evaluate(f); confirmed(f, '火星')
    const result = evaluate({ ...f, message: message(text), now: now + offset })
    assert.equal(result.kind, 'gate'); assert.equal(result.reason, expected)
  }
})

test('same persona name follows the captured binding instead of a global bot nickname', () => {
  const config = smart({ mentionedNameReply: true })
  assert.equal(evaluate(input({ config, personaName: '云雀', message: message('云雀 帮我') })).kind, 'forced')
  assert.notEqual(evaluate(input({ config, personaName: '云雀', message: message('希洛 帮我') })).kind, 'forced')
})

test('pending threshold, bounded source dedupe and observe:false scheduled reevaluation never double count', () => {
  const f = input({ config: smart({ talkValue: 0.5 }) }), first = evaluate(f)
  assert.equal(first.reason, 'below_threshold'); assert.equal(f.state.pendingCount, 1)
  assert.equal(evaluate(f).reason, 'duplicate_source'); assert.equal(f.state.pendingCount, 1)
  const rerun = evaluate({ ...f, observe: false }); assert.equal(rerun.reason, 'below_threshold'); assert.equal(f.state.pendingCount, 1)
  const second = evaluate({ ...f, message: message(), now: now + 1000 }); assert.equal(second.kind, 'gate'); assert.equal(f.state.pendingCount, 2)
  assert.equal(f.state.recentIncomingTimestamps.length, 2)
})

test('focus decays through fading into cold across a long gap and fading uses half threshold', () => {
  const f = input({ config: smart({ talkValue: 0.1, focusDurationMs: 1000, fadingDurationMs: 1000 }) }); evaluate(f); confirmed(f)
  const fading = evaluate({ ...f, message: message(), now: now + 1001 })
  assert.equal(fading.phase, 'fading'); assert.equal(fading.threshold, 5)
  const cold = evaluate({ ...f, message: message(), now: now + 2500 })
  assert.equal(cold.phase, 'cold'); assert.equal(cold.threshold, 10)
})

test('gate cooldown is bounded and explicit direct and proven continuation signals bypass it', () => {
  const f = input({ config: smart({ talkValue: 1, timingGateCooldownSeconds: 5 }) }); evaluate(f)
  gate(f.state, 'no_action', now, f.config)
  assert.equal(evaluate({ ...f, message: message(), now: now + 1000 }).reason, 'gate_cooldown')
  assert.equal(evaluate({ ...f, message: message(), now: now + 5000 }).kind, 'gate')
  assert.equal(evaluate({ ...f, message: message('希洛'), now: now + 1001, config: smart({ mentionedNameReply: true }) }).kind, 'forced')
})

test('idle compensation uses the prior message time and only recent confirmed reply latency samples', () => {
  const config = smart({ talkValue: 0.1, idleCompensationEnabled: true, avgLatencyDefaultMs: 1000 }), f = input({ config })
  evaluate(f)
  const result = evaluate({ ...f, message: message(), now: now + 10000 })
  assert.equal(result.idleHit, true); assert.equal(result.kind, 'gate')
  confirmed({ ...f, now: now + 10001 }, '确认', { latencyMs: 100 })
  const fresh = evaluate({ ...f, message: message(), now: now + 10002 })
  assert.equal(fresh.stats.avgReplyLatencyMs, 100)
  f.state.replyLatencies.push({ at: now - 600001, ms: 999999 })
  assert.equal(evaluate({ ...f, message: message(), now: now + 10003 }).stats.avgReplyLatencyMs, 100)
})

test('new attention keywords lower a strong threshold once and expire by Asia-independent elapsed time', () => {
  const f = input({ config: smart({ talkValue: 0.1, attentionDrift: { level: 'strong', windowMinutes: 1 } }) })
  evaluate({ ...f, message: message('火星 colonization 以及更多细节的话题内容') })
  const burst = evaluate({ ...f, message: message('火星 colonization 又出现了更多细节的话题内容'), now: now + 1000 })
  assert.equal(burst.threshold, 9); assert.equal(burst.stats.attention.count, 2)
  const expired = evaluate({ ...f, message: message('全新的独立足够长的话题介绍内容'), now: now + 61001 })
  assert.equal(expired.threshold, 10); assert.equal(expired.stats.attention, undefined)
})

test('only confirmed replies enter quota, current addressee, keywords and focus; force bypasses but counts', () => {
  const f = input({ config: smart({ talkValue: 1, maxRepliesPer10Min: 1 }) })
  assert.equal(evaluate(f).kind, 'gate'); assert.deepEqual(f.state.recentReplyTimestamps, []); assert.equal(f.state.lastBotReplyAt, 0)
  gate(f.state, 'continue', now, f.config); assert.equal(f.state.lastBotReplyAt, 0)
  assert.equal(confirmed(f, '火星'), true)
  assert.equal(f.state.recentReplyTimestamps.length, 1); assert.equal(f.state.conversationPhase, 'focus')
  assert.equal(evaluate({ ...f, message: message(), now: now + 1000 }).reason, 'rate_limit')
  assert.equal(evaluate({ ...f, message: message('直接请求', { directedToAccount: true }), now: now + 1001 }).kind, 'forced')
  confirmed({ ...f, now: now + 1001 }, '火星继续'); assert.equal(f.state.recentReplyTimestamps.length, 2)
  assert.equal(reply(f.state, { message: f.message, bindingToken: 'stale', text: '坏关键词', now: now + 1002, forced: true }, f.config), false)
  assert.equal(f.state.recentReplyTimestamps.length, 2); assert.equal(f.state.lastBotReplyKeywords.includes('坏关'), false)
})

test('focus reply and no-action caps transition only on their own confirmed or gate outcomes; wait is not rejection', () => {
  const f = input({ config: smart({ focusMaxReplies: 2, focusMaxNoAction: 2 }) }); evaluate(f); confirmed(f)
  gate(f.state, 'no_action', now + 1, f.config); gate(f.state, 'wait', now + 2, f.config)
  assert.equal(f.state.consecutiveNoAction, 0); assert.equal(f.state.conversationPhase, 'focus')
  gate(f.state, 'no_action', now + 3, f.config); gate(f.state, 'no_action', now + 4, f.config)
  assert.equal(f.state.conversationPhase, 'fading')
  confirmed({ ...f, now: now + 5 }); assert.equal(f.state.focusReplyCount, 0)
  confirmed({ ...f, now: now + 6 }, '回复', { forced: false }); assert.equal(f.state.conversationPhase, 'focus')
  confirmed({ ...f, now: now + 7 }, '回复', { forced: false }); assert.equal(f.state.conversationPhase, 'fading')
})

test('repeat joins require distinct human sources, explicit randomness and confirmation before cooldown or quota', () => {
  const repeated = '全体群友正在复读的这一句话长度超过十八字符但小于三十', f = input({ config: smart({ repeatJoinEnabled: true, repeatJoinProbability: 1 }) })
  evaluate({ ...f, message: message(repeated, { sender: { ...account, id: 'one' } }), random: 0 })
  evaluate({ ...f, message: message(repeated, { sender: { ...account, id: 'two' } }), random: 0, now: now + 1 })
  const m = message(repeated, { sender: { ...account, id: 'three' } })
  assert.notEqual(evaluate({ ...f, message: m, now: now + 2 }).kind, 'repeat')
  const repeatInput = { ...f, message: message(repeated, { sender: { ...account, id: 'four' } }), now: now + 3, random: 0 }
  assert.equal(evaluate(repeatInput).kind, 'repeat'); assert.equal(f.state.lastRepeatJoinAt, 0); assert.equal(f.state.recentReplyTimestamps.length, 0)
  confirmed(repeatInput, repeated, { forced: false, repeat: true })
  assert.equal(f.state.lastRepeatJoinAt, now + 3); assert.equal(f.state.recentReplyTimestamps.length, 1)
  assert.notEqual(evaluate({ ...f, message: message(repeated), random: 0, now: now + 4 }).kind, 'repeat')
  assert.equal(evaluate({ ...f, message: message(repeated, { directedToAccount: true }), random: 0, now: now + 5 }).kind, 'forced')
})

test('repeat excludes bot entries, same-user spam, zero probability and out-of-range random samples', () => {
  const text = '全体群友正在复读的这一句话长度超过十八字符但小于三十'
  for (const random of [undefined, -0.1, 1, NaN]) {
    const f = input({ config: smart({ repeatJoinEnabled: true, repeatJoinProbability: 1 }) }); evaluate(f)
    f.state.recentMessages = [{ userId: 'one', text, at: now }, { userId: 'two', text, at: now }]
    assert.notEqual(evaluate({ ...f, message: message(text), random }).kind, 'repeat')
  }
  const f = input({ config: smart({ repeatJoinEnabled: true, repeatJoinProbability: 0 }) }); evaluate(f)
  f.state.recentMessages = [{ userId: 'human', text, at: now }, { userId: 'bot', text, at: now }]
  assert.notEqual(evaluate({ ...f, message: message(text), random: 0 }).kind, 'repeat')
})

test('repeat detection window includes the current source and never borrows an older excluded speaker', () => {
  const text = '全体群友正在复读的这一句话长度超过十八字符但小于三十'
  const f = input({ config: smart({ repeatJoinEnabled: true, repeatJoinProbability: 1, repeatDetectionWindow: 2, repeatMinCount: 3 }) })
  evaluate(f)
  f.state.recentMessages = [{ userId: 'old', text, at: now }, { userId: 'recent', text, at: now }]
  assert.notEqual(evaluate({ ...f, message: message(text), random: 0 }).kind, 'repeat')
})
