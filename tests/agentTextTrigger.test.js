import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentTextTrigger } = await load('modules/conversation/infrastructure/agentTextTrigger.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const epoch = Date.parse('2026-11-17T04:00:00Z')
const account = { platform: 'fixture', namespace: 'trigger-scheduler', id: 'bot' }
const target = { account, kind: 'group', id: 'room' }
let sequence = 0
const bindingFor = (conversation = target, extra = {}) => ({ source: 'configured', id: conversationAddressKey(conversation),
  revision: 'v1', agentId: 'daily', personaId: 'persona', connectionId: 'connection', target: conversation, ...extra })
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve() }

function fixture(options = {}) {
  let at = epoch, timerId = 0, configuration = options.config ?? { mode: 'smart', smart: {
    talkValue: 1, repeatJoinEnabled: false, idleCompensationEnabled: false,
    directTriggerMergeMs: 0, toolRequestMergeMs: 0, replyDebounceMs: 0, deferredGateEnabled: false,
  } }
  const scheduled = new Map(), calls = { history: [], gate: [], tracking: [], reply: [], repeat: [] }, contexts = []
  const timers = {
    set(callback, delay) { const id = ++timerId; scheduled.set(id, { callback, dueAt: at + delay }); return id },
    clear(id) { scheduled.delete(id) },
  }
  const port = (name, fallback) => async (input, guard) => {
    calls[name].push({ input, guard }); await guard.ensureCurrent()
    return options[name] ? options[name](input, guard) : fallback(input)
  }
  const runtime = createAgentTextTrigger({ config: () => configuration, now: () => at, random: () => 0,
    timers, ...(options.limits ? { limits: options.limits } : {}),
    readHistory: port('history', () => []), gate: port('gate', () => ({ decision: 'continue', reason: 'fixture' })),
    tracking: port('tracking', () => true), reply: port('reply', () => ({ state: 'sent', text: '确认回复', messageId: 'reply-' + ++sequence })),
    repeat: port('repeat', () => ({ state: 'sent', text: '复读已确认', messageId: 'repeat-' + ++sequence })),
  })
  function capture(text = '这是一条独立的新话题消息，内容足够完整', extra = {}, settings = {}) {
    const controller = new AbortController(), conversation = extra.conversation ?? target
    const incoming = Object.freeze({ version: 1, conversation, sender: { ...account, id: 'human' }, text,
      messageId: 'source-' + ++sequence, occurredAt: at, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...extra })
    const state = { valid: true, releases: 0, ensures: 0 }
    const context = { incoming, selected: { binding: settings.binding ?? bindingFor(conversation), persona: { name: '希洛' } }, signal: controller.signal,
      isCurrent() { if (settings.throwCurrent) throw Error('guard error'); return state.valid },
      async ensureCurrent() { state.ensures++; if (settings.ensure) await settings.ensure(); if (!state.valid || controller.signal.aborted) throw Error('revoked') },
      release() { state.releases++; controller.abort() },
    }
    const held = { incoming, context, state, controller }; contexts.push(held); return held
  }
  function admit(text, extra, settings) { const held = capture(text, extra, settings); runtime.admit(held.context); return held }
  async function advance(ms) {
    const end = at + ms
    for (let steps = 0; steps < 10000; steps++) {
      await flush()
      const next = [...scheduled].filter(([, timer]) => timer.dueAt <= end).sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
      if (!next) { at = end; await flush(); return }
      at = next[1].dueAt; scheduled.delete(next[0]); next[1].callback()
    }
    throw Error('timer loop')
  }
  return { runtime, admit, capture, advance, calls, contexts, scheduled, now: () => at, setConfig(value) { configuration = value } }
}
const smart = (values = {}) => ({ mode: 'smart', smart: { talkValue: 1, repeatJoinEnabled: false, idleCompensationEnabled: false,
  directTriggerMergeMs: 0, toolRequestMergeMs: 0, replyDebounceMs: 0, deferredGateEnabled: false, ...values } })
const strict = (extra = {}) => ({ mode: 'strict', smart: { directTriggerMergeMs: 0, toolRequestMergeMs: 0 }, ...extra })

test('admission never awaits a gate and a different conversation proceeds independently', async () => {
  const gate = pending(), f = fixture({ gate: input => input.incoming.conversation.id === 'room' ? gate.promise : { decision: 'continue', reason: 'other' } })
  try {
    const first = f.admit()
    assert.equal(first.state.releases, 0)
    await flush(); assert.equal(f.calls.gate.length, 1)
    f.admit(undefined, { conversation: { ...target, id: 'another' } }); await flush()
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming.conversation.id, 'another')
    gate.resolve({ decision: 'continue', reason: 'ready' }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 2); assert.equal(first.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('same-speaker direct bursts merge original objects while other speakers keep separate jobs', async () => {
  const f = fixture({ config: smart({ directTriggerMergeMs: 100 }) })
  try {
    const first = f.admit('希洛，第一条', { directedToAccount: true }); await f.advance(20)
    const second = f.admit('希洛，第二条', { directedToAccount: true })
    const third = f.admit('希洛，其他用户', { directedToAccount: true, sender: { ...account, id: 'other' } })
    f.admit('这是一条普通群聊消息，不能覆盖直接触发', { sender: { ...account, id: 'third' } }); await flush()
    assert.equal(f.calls.reply.length, 1, 'ordinary chatter can complete before the direct merge deadline')
    await f.advance(100)
    const direct = f.calls.reply.filter(call => call.input.reason === 'direct')
    assert.equal(direct.length, 2)
    assert.deepEqual(direct[0].input.sources, [first.incoming, second.incoming]); assert.equal(direct[0].input.incoming, second.incoming)
    assert.equal(direct[0].input.sources[0], first.incoming); assert.deepEqual(direct[1].input.sources, [third.incoming])
    assert.equal(first.state.releases, 1); assert.equal(second.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('explicit tool requests use their shorter merge delay without synthesizing text or mention flags', async () => {
  const f = fixture({ config: smart({ directTriggerMergeMs: 100, toolRequestMergeMs: 20 }) })
  try {
    const source = f.admit('帮我搜索火星新闻', { directedToAccount: true })
    await f.advance(19); assert.equal(f.calls.reply.length, 0)
    await f.advance(1); assert.equal(f.calls.reply.length, 1)
    assert.equal(f.calls.reply[0].input.incoming, source.incoming); assert.equal(f.calls.reply[0].input.incoming.text, '帮我搜索火星新闻')
  } finally { await f.runtime.stop() }
})

test('a late optional gate result is fenced after newer chatter and cannot dispatch', async () => {
  const obsolete = pending(), f = fixture({ gate: input => input.incoming.text.includes('旧的') ? obsolete.promise : { decision: 'continue', reason: 'latest' } })
  try {
    const first = f.admit('这是旧的独立新话题消息，内容足够完整'); await flush()
    const latest = f.admit('这是新的独立新话题消息，内容足够完整'); await flush()
    assert.equal(f.calls.gate[0].guard.signal.aborted, true); assert.equal(first.state.releases, 1)
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, latest.incoming)
    obsolete.resolve({ decision: 'continue', reason: 'late' }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 1)
  } finally { await f.runtime.stop() }
})

test('queued optional checks coalesce while an owned direct reply is running', async () => {
  const response = pending(), f = fixture({ reply: input => input.reason === 'direct' ? response.promise : { state: 'sent', text: '最新回复' } })
  try {
    f.admit('直接触发', { directedToAccount: true }); await flush()
    const old = f.admit('旧的普通群聊消息，内容足够完整')
    const latest = f.admit('最新普通群聊消息，内容足够完整'); await flush()
    assert.equal(old.state.releases, 1); assert.equal(f.calls.gate.length, 0)
    response.resolve({ state: 'sent', text: '直接确认' }); await f.runtime.drain()
    assert.equal(f.calls.gate.length, 1); assert.equal(f.calls.gate[0].input.incoming, latest.incoming)
  } finally { await f.runtime.stop() }
})

test('debounce interruptions stop at the configured cap and later chatter cannot create duplicate optional replies', async () => {
  const f = fixture({ config: smart({ replyDebounceMs: 100, maxConsecutiveInterrupts: 2 }) })
  try {
    const first = f.admit(); await flush(); await f.advance(10)
    const second = f.admit(); await flush(); await f.advance(10)
    const third = f.admit(); await flush(); await f.advance(10)
    const fourth = f.admit(); await flush()
    assert.equal(first.state.releases, 1); assert.equal(second.state.releases, 1); assert.equal(fourth.state.releases, 1)
    await f.advance(100)
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, third.incoming)
    assert.equal(f.calls.gate.length, 3)
  } finally { await f.runtime.stop() }
})

test('debounce interruption cap never overrides source recall and direct triggers supersede optional debounce', async () => {
  const f = fixture({ config: smart({ replyDebounceMs: 100, maxConsecutiveInterrupts: 1 }) })
  try {
    f.admit(); await flush(); const guarded = f.admit(); await flush()
    f.admit(); await flush(); guarded.controller.abort(); await f.advance(100)
    assert.equal(f.calls.reply.length, 0)
    f.admit(); await flush(); f.admit('原始直接触发', { directedToAccount: true }); await flush(); await f.advance(100)
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.reason, 'direct')
  } finally { await f.runtime.stop() }
})

test('wait rechecks preserve original identity and never count the same incoming source twice', async () => {
  const f = fixture({ gate: (_input, _guard) => f.calls.gate.length === 1 ? { decision: 'wait', reason: 'later', waitMs: 3000 } : { decision: 'continue', reason: 'ready' } })
  try {
    const source = f.admit(); await f.runtime.drain()
    assert.equal(source.state.releases, 0); assert.equal(f.calls.reply.length, 0)
    await f.advance(3000)
    assert.equal(f.calls.gate.length, 2); assert.equal(f.calls.gate[1].input.incoming, source.incoming)
    assert.equal(f.calls.gate[1].input.decision.stats.groupMsgRate5min, 1)
    assert.equal(source.incoming.directedToAccount, false); assert.deepEqual(f.calls.reply[0].input.sources, [source.incoming])
    await f.advance(15000); assert.equal(f.calls.reply.length, 1); assert.equal(source.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('same-speaker direct trigger adopts waiting sources and cancels their redundant later gate', async () => {
  const f = fixture({ gate: () => ({ decision: 'wait', reason: 'waiting', waitMs: 3000 }) })
  try {
    const waiting = f.admit(); await f.runtime.drain()
    const direct = f.admit('直接补充完整问题', { directedToAccount: true }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 1); assert.deepEqual(f.calls.reply[0].input.sources, [waiting.incoming, direct.incoming])
    assert.equal(f.calls.reply[0].input.incoming, direct.incoming)
    await f.advance(10000); assert.equal(f.calls.gate.length, 1); assert.equal(f.calls.reply.length, 1)
    assert.equal(waiting.state.releases, 1); assert.equal(direct.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('direct trigger can adopt an active waiting recheck before dispatch and fences the late gate', async () => {
  const old = pending(), f = fixture({ gate: () => f.calls.gate.length === 1 ? { decision: 'wait', reason: 'later', waitMs: 3000 } : old.promise })
  try {
    const waiting = f.admit(); await f.runtime.drain(); await f.advance(3000)
    assert.equal(f.calls.gate.length, 2)
    const direct = f.admit('直接补充', { directedToAccount: true }); await flush()
    assert.equal(f.calls.reply.length, 1); assert.deepEqual(f.calls.reply[0].input.sources, [waiting.incoming, direct.incoming])
    old.resolve({ decision: 'continue', reason: 'stale' }); await f.runtime.drain(); assert.equal(f.calls.reply.length, 1)
  } finally { await f.runtime.stop() }
})

test('cold deferred gate retains the human source and applies no synthetic direct trigger', async () => {
  const f = fixture({ config: smart({ talkValue: 0.01, deferredGateEnabled: true, minDeferredMs: 100, maxDeferredMs: 100 }) })
  try {
    const source = f.admit(); await f.runtime.drain(); assert.equal(f.calls.gate.length, 0)
    await f.advance(100)
    assert.equal(f.calls.gate.length, 1); assert.equal(f.calls.gate[0].input.incoming, source.incoming)
    assert.equal(f.calls.gate[0].input.incoming.occurredAt, epoch); assert.equal(f.calls.gate[0].input.incoming.directedToAccount, false)
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.reason, 'smart')
    await f.advance(1000); assert.equal(f.calls.reply.length, 1)
  } finally { await f.runtime.stop() }
})

test('a newer cold message replaces the deferred source instead of scheduling two continuations', async () => {
  const f = fixture({ config: smart({ talkValue: 0.01, deferredGateEnabled: true, minDeferredMs: 100, maxDeferredMs: 100 }) })
  try {
    const first = f.admit(); await f.runtime.drain(); await f.advance(50)
    const next = f.admit(); await f.runtime.drain(); assert.equal(first.state.releases, 1)
    await f.advance(100); assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, next.incoming)
  } finally { await f.runtime.stop() }
})

test('new chatter fences an already running deferred gate before replacing its retained source', async () => {
  const previous = pending(), f = fixture({ config: smart({ talkValue: 0.01, deferredGateEnabled: true, minDeferredMs: 100, maxDeferredMs: 100 }),
    gate: () => f.calls.gate.length === 1 ? previous.promise : { decision: 'continue', reason: 'latest' } })
  try {
    const first = f.admit(); await f.runtime.drain(); await f.advance(100)
    assert.equal(f.calls.gate.length, 1)
    const latest = f.admit(); await flush()
    assert.equal(f.calls.gate[0].guard.signal.aborted, true); assert.equal(first.state.releases, 1)
    previous.resolve({ decision: 'continue', reason: 'stale' }); await f.advance(100)
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, latest.incoming)
  } finally { await f.runtime.stop() }
})

test('scheduled wait obeys a fresh rate-limit veto instead of blindly calling the gate again', async () => {
  const f = fixture({ config: smart({ maxRepliesPer10Min: 1 }), gate: () => ({ decision: 'wait', reason: 'later', waitMs: 3000 }) })
  try {
    const waiting = f.admit(); await f.runtime.drain()
    f.admit('其他用户直接触发', { directedToAccount: true, sender: { ...account, id: 'other' } }); await f.runtime.drain()
    await f.advance(3000)
    assert.equal(f.calls.gate.length, 1); assert.equal(f.calls.reply.length, 1); assert.equal(waiting.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('strict tracking starts only from a confirmed direct reply and uses same-speaker confirmed history', async () => {
  const history = [ { user: '旧问题', reply: '旧回答', speakerId: 'human', replyId: 'old' },
    { user: '别人问题', reply: '别人回答', speakerId: 'other', replyId: 'other-reply' }, { user: '未知用户', reply: '未知回答' } ]
  const f = fixture({ config: strict({ tracking: { enabled: true, batchDelayMs: 100, throttleMs: 3000, timeoutMs: 5000 } }), history: () => history })
  try {
    f.admit('没有确认回复前的普通消息'); await f.runtime.drain(); assert.equal(f.calls.tracking.length, 0)
    f.admit('直接触发建立追踪', { directedToAccount: true }); await f.runtime.drain()
    const source = f.admit('同一用户的新话题消息，内容足够完整'); await f.runtime.drain()
    f.admit('其他用户的新话题消息，内容足够完整', { sender: { ...account, id: 'other' } }); await f.runtime.drain()
    const batched = f.admit('同一用户的第二条消息，内容足够完整'); await f.runtime.drain(); await f.advance(100)
    assert.equal(f.calls.tracking.length, 1); assert.deepEqual(f.calls.tracking[0].input.history, [history[0]])
    assert.deepEqual(f.calls.tracking[0].input.sources, [source.incoming, batched.incoming]); assert.equal(f.calls.reply[1].input.reason, 'tracking')
    await f.advance(5001); f.admit('追踪窗口已经过期的新话题消息'); await f.runtime.drain(); assert.equal(f.calls.tracking.length, 1)
  } finally { await f.runtime.stop() }
})

test('strict tracking throttle applies after a negative judgment and unknown direct delivery creates no tracking', async () => {
  let outcome = 'unknown'
  const f = fixture({ config: strict({ tracking: { enabled: true, batchDelayMs: 0, throttleMs: 3000 } }),
    history: () => [{ user: '问题', reply: '回答', speakerId: 'human' }], reply: () => ({ state: outcome, text: '候选回复' }), tracking: () => false })
  try {
    f.admit('直接触发未知', { directedToAccount: true }); await f.runtime.drain(); f.admit(); await f.runtime.drain()
    assert.equal(f.calls.tracking.length, 0)
    outcome = 'sent'; f.admit('已确认直接触发', { directedToAccount: true }); await f.runtime.drain()
    f.admit(); await f.runtime.drain(); assert.equal(f.calls.tracking.length, 1)
    f.admit(); await f.runtime.drain(); assert.equal(f.calls.tracking.length, 1)
    await f.advance(3000); f.admit(); await f.runtime.drain(); assert.equal(f.calls.tracking.length, 2)
  } finally { await f.runtime.stop() }
})

test('quote ID requires guarded bot history while an arbitrary quote stays unaddressed in strict mode', async () => {
  const f = fixture({ config: strict(), history: () => [{ user: '问题', reply: '回答', speakerId: 'human', replyId: 'confirmed' }] })
  try {
    f.admit('任意引用', { quote: { messageId: 'arbitrary', parts: [] } }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 0)
    const proven = f.admit('已确认引用', { quote: { messageId: 'confirmed', parts: [] } }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, proven.incoming)
  } finally { await f.runtime.stop() }
})

test('ordinary chatter cannot discard a quoted direct source while guarded quote ownership is still resolving', async () => {
  const history = pending(), f = fixture({ config: smart(), history: input => input.incoming.quote ? history.promise : [] })
  try {
    const quoted = f.admit('原始引用追问', { quote: { messageId: 'confirmed', parts: [] } }); await flush()
    f.admit('新来的普通群聊消息，内容足够完整'); await flush()
    assert.equal(f.calls.history[0].guard.signal.aborted, false)
    history.resolve([{ user: '问题', reply: '回答', speakerId: 'human', replyId: 'confirmed' }]); await f.runtime.drain()
    const direct = f.calls.reply.find(call => call.input.reason === 'direct')
    assert.ok(direct); assert.equal(direct.input.incoming, quoted.incoming); assert.equal(quoted.state.releases, 1)
  } finally { await f.runtime.stop() }
})

test('recalling any merged source cancels the whole burst before history, model, or send', async () => {
  const f = fixture({ config: smart({ directTriggerMergeMs: 100 }) })
  try {
    const first = f.admit('第一条', { directedToAccount: true }), second = f.admit('第二条', { directedToAccount: true })
    first.controller.abort(); await f.advance(100)
    for (const calls of Object.values(f.calls)) assert.equal(calls.length, 0)
    assert.equal(first.state.releases, 1); assert.equal(second.state.releases, 1)
  } finally { await f.runtime.stop() }
})

for (const action of ['account', 'binding', 'config', 'guard']) test(`${action} invalidation fences a pending gate and every later side effect`, async () => {
  const gate = pending(), f = fixture({ gate: () => gate.promise })
  try {
    const source = f.admit(); await flush(); assert.equal(f.calls.gate.length, 1)
    if (action === 'account') f.runtime.invalidateAccount(account)
    if (action === 'binding') {
      f.admit('新绑定的无效消息', { sender: account }, { binding: bindingFor(target, { revision: 'v2' }) })
    }
    if (action === 'config') f.setConfig(strict())
    if (action === 'guard') source.state.valid = false
    gate.resolve({ decision: 'continue', reason: 'late' }); await f.runtime.drain()
    assert.equal(f.calls.reply.length, 0); assert.equal(source.state.releases, 1)
  } finally { await f.runtime.stop() }
})

for (const outcome of ['unknown', 'failed', 'cancelled']) test(`${outcome} receipt has no automatic replay and consumes no confirmed reply state`, async () => {
  const f = fixture({ reply: () => ({ state: outcome, text: '未确认文本' }) })
  try {
    const source = f.admit(); await f.runtime.drain(); f.runtime.admit(source.context); await f.advance(10000)
    assert.equal(f.calls.reply.length, 1)
    f.admit(); await f.runtime.drain()
    assert.equal(f.calls.gate[1].input.metrics.lastReplyAt, 0); assert.equal(f.calls.gate[1].input.decision.stats.recentReplyCount, 0)
  } finally { await f.runtime.stop() }
})

test('confirmed receipts alone update next-run metrics and quota', async () => {
  const f = fixture()
  try {
    f.admit('已确认直接回复', { directedToAccount: true }); await f.runtime.drain(); await f.advance(50)
    f.admit(); await f.runtime.drain()
    assert.equal(f.calls.gate[0].input.metrics.lastReplyAt, epoch); assert.equal(f.calls.gate[0].input.metrics.lastReplyToUserId, 'human')
    assert.equal(f.calls.gate[0].input.decision.stats.recentReplyCount, 1)
  } finally { await f.runtime.stop() }
})

test('stop aborts a hung gate, drains ignored cancellation, clears timers and releases captures exactly once', async () => {
  const gate = pending(), f = fixture({ gate: () => gate.promise })
  const first = f.admit(); await flush(); f.admit('待处理直接消息', { directedToAccount: true })
  await f.runtime.stop()
  assert.equal(f.calls.gate[0].guard.signal.aborted, true); assert.equal(f.scheduled.size, 0)
  assert.ok(f.contexts.every(source => source.state.releases === 1)); assert.equal(first.state.releases, 1)
  gate.resolve({ decision: 'continue', reason: 'late' }); await flush(); assert.equal(f.calls.reply.length, 0)
  const rejected = f.admit(); assert.equal(rejected.state.releases, 1)
})

test('source TTL bounds pending merges and running history, with no model after history timeout', async () => {
  const history = pending(), f = fixture({ limits: { sourceTtlMs: 100 }, history: () => history.promise })
  try {
    const source = f.admit('直接触发', { directedToAccount: true }); await flush(); await f.advance(100); await f.runtime.drain()
    assert.equal(source.state.releases, 1); assert.equal(f.calls.history[0].guard.signal.aborted, true)
    history.resolve([]); await flush(); assert.equal(f.calls.gate.length, 0); assert.equal(f.calls.reply.length, 0)
  } finally { await f.runtime.stop() }
  const queued = fixture({ limits: { sourceTtlMs: 50 }, config: smart({ directTriggerMergeMs: 100 }) })
  try {
    const source = queued.admit('直接触发', { directedToAccount: true }); await queued.advance(50)
    assert.equal(source.state.releases, 1); assert.equal(queued.calls.history.length, 0)
  } finally { await queued.runtime.stop() }
})

test('watchdog deadline is shared by history and gate instead of renewing for each awaited stage', async () => {
  const history = pending(), gate = pending(), f = fixture({ config: smart({ smartLockTimeoutMs: 100 }), history: () => history.promise, gate: () => gate.promise })
  try {
    const source = f.admit(); await flush(); await f.advance(70); history.resolve([]); await flush()
    assert.equal(f.calls.gate.length, 1); await f.advance(30); await f.runtime.drain()
    assert.equal(source.state.releases, 1); assert.equal(f.calls.gate[0].guard.signal.aborted, true)
    gate.resolve({ decision: 'continue', reason: 'too late' }); await flush(); assert.equal(f.calls.reply.length, 0)
  } finally { await f.runtime.stop() }
})

test('hung captured ensure does not prevent stop from draining', async () => {
  const ensure = pending(), f = fixture()
  const source = f.admit(undefined, {}, { ensure: () => ensure.promise }); await flush()
  await f.runtime.stop(); assert.equal(source.state.releases, 1); assert.equal(f.scheduled.size, 0)
  ensure.resolve(); await flush(); assert.equal(f.calls.history.length, 0)
})

test('pending capture, merge size, and conversation limits release owned sources without leaking timers', async () => {
  const f = fixture({ limits: { maxPendingPerConversation: 2, maxConversations: 1 }, config: smart({ directTriggerMergeMs: 100 }) })
  try {
    const first = f.admit('直接1', { directedToAccount: true }), second = f.admit('直接2', { directedToAccount: true })
    const overflow = f.admit('直接3', { directedToAccount: true }); assert.equal(overflow.state.releases, 1)
    const next = f.admit('其他会话', { directedToAccount: true, conversation: { ...target, id: 'other-room' } })
    assert.equal(first.state.releases, 1); assert.equal(second.state.releases, 1)
    await f.advance(100); assert.equal(f.calls.reply.length, 1); assert.equal(f.calls.reply[0].input.incoming, next.incoming)
  } finally { await f.runtime.stop() }
  const capped = fixture({ config: smart({ directTriggerMergeMs: 100, directTriggerMergeMaxMessages: 2 }) })
  try {
    const first = capped.admit('一', { directedToAccount: true }), second = capped.admit('二', { directedToAccount: true }), third = capped.admit('三', { directedToAccount: true })
    assert.equal(first.state.releases, 1); await capped.advance(100)
    assert.deepEqual(capped.calls.reply[0].input.sources, [second.incoming, third.incoming])
  } finally { await capped.runtime.stop() }
})

test('local source dedupe stays bounded while Core retains final durable reply ownership', async () => {
  const f = fixture({ config: strict() })
  try {
    const source = f.admit(); await f.runtime.drain()
    const duplicate = f.capture(source.incoming.text, { messageId: source.incoming.messageId }); f.runtime.admit(duplicate.context)
    assert.equal(duplicate.state.releases, 1); assert.equal(f.calls.history.length, 1)
    for (let index = 0; index < 4096; index++) { f.admit(); await f.runtime.drain() }
    const afterWindow = f.capture(source.incoming.text, { messageId: source.incoming.messageId }); f.runtime.admit(afterWindow.context); await f.runtime.drain()
    assert.equal(f.calls.history.length, 4098); assert.equal(f.calls.reply.length, 0)
  } finally { await f.runtime.stop() }
})

test('invalid initial guards and malformed source times release safely without model work', async () => {
  const f = fixture()
  try {
    const invalid = f.admit(undefined, {}, { throwCurrent: true }); assert.equal(invalid.state.releases, 1)
    for (const occurredAt of [0, NaN, epoch - 3600000]) assert.equal(f.admit(undefined, { occurredAt }).state.releases, 1)
    await f.runtime.drain(); assert.equal(f.calls.history.length, 0)
  } finally { await f.runtime.stop() }
})
