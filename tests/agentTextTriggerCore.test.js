import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')
const { personMemoryCommandText } = await load('modules/memory/domain/personMemoryCommands.js')
const redisTest = { skip: !redisAvailable, timeout: 25000 }
const replyText = '这是本次确认的普通会话回复。'
const answer = content => ({ choices: [{ message: { content } }] })
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
let sequence = 0

async function waitFor(probe, message, details = () => '') {
  const deadline = performance.now() + 7000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(message + ': ' + details())
}

async function fixture(t, settings = {}) {
  let host, consume, ready = false, current = true, stopped = false
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(async () => { release.resolve(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'text-trigger-core'), inbox = createAgentInbox(redis.storage)
  const account = { platform: 'fixture', namespace: 'text-trigger-core', id: 'bot' }, user = { ...account, id: 'human' }
  const group = { account, kind: 'group', id: 'room' }, other = { ...group, id: 'other-room' }, privateTarget = { account, kind: 'private', id: user.id }
  const targets = [group, other, privateTarget]
  const directoryConfig = { version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: targets.map(target => ({ connectionId: 'main', kind: target.kind, conversationId: target.id, agentId: 'daily' })) }
  let directory = createAgentBindingDirectory(directoryConfig, 'initial')
  const config = { mode: settings.mode ?? 'smart', tracking: { enabled: settings.tracking === true, throttleMs: 0, batchDelayMs: 0 },
    smart: { talkValue: 1, directTriggerMergeMs: settings.mergeMs ?? 0, toolRequestMergeMs: 0, replyDebounceMs: 0,
      deferredGateEnabled: false, repeatJoinEnabled: false, idleCompensationEnabled: false, timingGateCooldownSeconds: 0 } }
  const requests = [], sends = [], sources = new Map(), logs = [], side = [], order = []
  const adapter = { id: 'main', account, botUserId: account.id, botName: '隔离会话角色', isReady: () => ready,
    start(callback) { consume = callback; ready = true }, stop() { ready = false },
    async readMessage(target, id, guard) { return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(sourceKey(target, id))) },
    async readConversationMember(target, subject, guard) { return guard?.isCurrent?.() === false ? undefined : { target, observedAt: Date.now(), member: { user: subject, role: 'member' } } },
    actions: { async send(action, guard) {
      await guard?.ensureCurrent?.()
      if (guard?.isCurrent?.() === false) return { state: 'failed', code: 'stale' }
      sends.push(structuredClone(action)); order.push({ kind: 'send', target: action.target.id })
      return settings.unknown ? { state: 'unknown' } : { state: 'sent', messageId: 'out-' + sends.length }
    } },
  }
  host = createAgentRuntime({ storage: redis.storage, adapters: [adapter], isExecutionCurrent: redis.isCurrent,
    ...(settings.omitConfig ? {} : { textTrigger: config }), isTextTriggerCurrent: () => current,
    ...(settings.noSideModel ? {} : { async textTriggerModel(request, target, signal, isCurrent, ensureCurrent) {
      assert.equal(isCurrent(), true); await ensureCurrent(); side.push({ request: structuredClone(request), target: structuredClone(target), signal })
      order.push({ kind: 'trigger', target: target.id })
      if (settings.holdGate) { entered.resolve(); await release.promise }
      return answer(JSON.stringify(settings.mode === 'strict' ? { talking: true } : { decision: 'continue', reason: '同一来源可自然回应' }))
    } }),
    memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
    groupLog: { enabled: false }, privateChatEnabled: true, useTextGroup: target => target.kind === 'group', textGroupRevision: 'trigger-core-test',
    resolvePersona: target => { const binding = directory.resolve(target); return binding && { binding, persona: { name: '隔离会话角色' }, systemContent: '当前会话来自隔离测试，请正常回复。' } },
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
      wakeGate: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({}),
    logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
    async YTapi(request) { requests.push(structuredClone(request)); order.push({ kind: 'main', text: JSON.stringify(request.messages) }); return answer(replyText) },
  })
  const queues = ['group-log', 'group-text', 'simulation', 'private', 'privacy'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  const f = { ...redis, host, inbox, account, user, group, other, privateTarget, config, requests, sends, side, order, logs, entered, release,
    message(text = '这是一个完整独立的群聊话题，期待自然回复', extra = {}) { return { version: 1, conversation: group, sender: user, senderName: '真人',
      messageId: 'source-' + ++sequence, occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...extra } },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await consume({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await consume({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    rebind() { directory = createAgentBindingDirectory({ ...directoryConfig, bindings: directoryConfig.bindings.map(binding => ({ ...binding, agentId: 'other' })) }, 'changed') },
    disable() { current = false },
    async inboxesEmpty() { await waitFor(async () => Number(await redis.reader.eval('local total=0; for _,key in ipairs(KEYS) do total=total+redis.call("LLEN",key) end; return total',
      { keys: queues, arguments: [] })) === 0, 'Core inbox did not drain', () => logs.slice(-5).join('\n')) },
    async confirmed(message) { await waitFor(() => inbox.isTextReplyConfirmed(message.conversation, message.messageId), 'text reply was not confirmed', () => logs.slice(-5).join('\n')) },
    async stop() { if (stopped) return; stopped = true; release.resolve(); await host.stop() },
    ordinarySends() { return sends.filter(action => action.parts.some(part => part.kind === 'text' && part.text === replyText)) },
  }
  await host.start(); return f
}

test('Core smart auto participation uses a dedicated tool-free gate then the ordinary reply model', redisTest, async t => {
  const f = await fixture(t), source = f.message()
  await f.emit(source); await f.confirmed(source); await f.stop()
  assert.equal(f.side.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.ordinarySends().length, 1)
  assert.deepEqual(f.side[0].request.tools, []); assert.equal(f.side[0].request.tool_choice, 'none')
  assert.deepEqual(f.order.map(row => row.kind), ['trigger', 'main', 'send'])
  assert.equal(f.ordinarySends()[0].replyTo, undefined, 'automatic participation preserves the configured no-quote behavior')
  assert.match(JSON.stringify(f.requests[0].messages), /完整独立的群聊话题/u)
})

test('Core strict tracking accepts only the confirmed speaker and filters the dedicated model history to that person', redisTest, async t => {
  const f = await fixture(t, { mode: 'strict', tracking: true }), direct = f.message('请开始这一轮明确对话', { directedToAccount: true })
  await f.emit(direct); await f.confirmed(direct)
  const other = f.message('另一个人展开了与刚才无关的新话题完整陈述', { sender: { ...f.account, id: 'other-human' } })
  await f.emit(other); await f.inboxesEmpty(); await delay(50)
  assert.equal(f.side.length, 0); assert.equal(f.requests.length, 1)
  const followup = f.message('沿着刚才的话题再聊聊我的具体情况和补充信息')
  await f.emit(followup); await f.confirmed(followup); await f.stop()
  assert.equal(f.side.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.ordinarySends().length, 2)
  const data = JSON.parse(f.side[0].request.messages.find(message => message.role === 'user').content)
  assert.equal(data.current.speakerId, f.user.id); assert.equal(data.history.length, 1)
  assert.equal(JSON.stringify(data).includes(other.text), false)
})

test('Core without a dedicated trigger model stays silent for auto participation while direct requests still work', redisTest, async t => {
  const f = await fixture(t, { noSideModel: true }), automatic = f.message()
  await f.emit(automatic); await f.inboxesEmpty(); await delay(50)
  assert.equal(f.requests.length, 0)
  const direct = f.message('这是明确给机器人的请求', { directedToAccount: true })
  await f.emit(direct); await f.confirmed(direct); await f.stop()
  assert.equal(f.side.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.ordinarySends().length, 1)
})

test('Core without text-trigger configuration preserves the previous direct-only group entry', redisTest, async t => {
  const f = await fixture(t, { omitConfig: true }), ignored = f.message()
  await f.emit(ignored); await f.inboxesEmpty(); await delay(50)
  assert.equal(f.requests.length, 0)
  const direct = f.message('明确对话', { directedToAccount: true }); await f.emit(direct); await f.confirmed(direct); await f.stop()
  assert.equal(f.side.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.ordinarySends()[0].replyTo, direct.messageId)
})

test('Core merge waiting never blocks another group on the same native account', redisTest, async t => {
  const f = await fixture(t, { mode: 'strict', mergeMs: 400 })
  const waiting = f.message('请听完我完整说明的这一件事', { directedToAccount: true })
  await f.emit(waiting)
  const immediate = f.message('请搜索这个公开资料', { conversation: f.other, directedToAccount: true })
  await f.emit(immediate); await f.confirmed(immediate); await f.confirmed(waiting); await f.stop()
  assert.deepEqual(f.ordinarySends().map(action => action.target.id), [f.other.id, f.group.id])
  assert.equal(f.side.length, 0); assert.equal(f.requests.length, 2)
})

for (const fence of ['recall', 'forget', 'disable-memory', 'binding', 'configuration']) test(`Core ${fence} during gate waiting prevents every later reply model and native send`, redisTest, async t => {
  const f = await fixture(t, { holdGate: true }), source = f.message()
  await f.emit(source); await f.entered.promise
  if (fence === 'recall') await f.recall(source)
  else if (fence === 'binding') f.rebind()
  else if (fence === 'configuration') f.disable()
  else {
    await f.emit(f.message(personMemoryCommandText[fence === 'forget' ? 'forget' : 'disable']))
    await f.inboxesEmpty()
  }
  f.release.resolve(); await f.inboxesEmpty()
  await waitFor(() => f.side[0].signal.aborted, 'revoked trigger job did not retire before host shutdown')
  await f.stop()
  assert.equal(f.side.length, 1); assert.equal(f.requests.length, 0); assert.deepEqual(f.ordinarySends(), [])
})

test('Core acknowledges a known forgotten direct source without blocking a fresh direct source in another group', redisTest, async t => {
  const f = await fixture(t, { mode: 'strict' })
  const forget = f.message(personMemoryCommandText.forget)
  await f.emit(forget); await f.inboxesEmpty()
  assert.equal(f.requests.length, 0); assert.deepEqual(f.ordinarySends(), [])
  const afterForgetSends = f.sends.length
  const stale = f.message('隐私清空之前已存在的明确直接请求', {
    directedToAccount: true, occurredAt: forget.occurredAt - 1000,
  })
  const fresh = f.message('另一个群在隐私清空后发出的全新直接请求', {
    conversation: f.other, directedToAccount: true,
  })
  await f.emit(stale); await f.emit(fresh)
  await waitFor(() => f.inbox.isTextReplyConfirmed(fresh.conversation, fresh.messageId),
    'fresh source stalled behind a known forgotten source', () => JSON.stringify({
      modelCalls: f.requests.length, ordinarySends: f.ordinarySends().length, recentLogs: f.logs.slice(-5),
    }))
  await f.inboxesEmpty(); await f.stop()
  assert.equal(f.requests.length, 1); assert.equal(f.side.length, 0)
  assert.equal(f.sends.length - afterForgetSends, 1); assert.equal(f.ordinarySends().length, 1)
  assert.equal(f.ordinarySends()[0].replyTo, fresh.messageId); assert.deepEqual(f.ordinarySends()[0].target, fresh.conversation)
  const prompt = JSON.stringify(f.requests[0].messages)
  assert.ok(prompt.includes(fresh.text)); assert.equal(prompt.includes(stale.text), false)
  assert.equal(await f.inbox.isTextReplyConfirmed(stale.conversation, stale.messageId), false)
})

test('Core unknown delivery neither retries the source nor creates a confirmed strict tracking session', redisTest, async t => {
  const f = await fixture(t, { mode: 'strict', tracking: true, unknown: true }), source = f.message('明确请求', { directedToAccount: true })
  await f.emit(source); await waitFor(() => f.ordinarySends().length === 1, 'initial unknown native send missing')
  await f.inboxesEmpty(); await delay(50)
  await f.emit(source)
  await f.emit(f.message('这是同一个人在结果未知之后提出的另一段完整补充内容'))
  await f.inboxesEmpty(); await f.stop()
  assert.equal(f.requests.length, 1); assert.equal(f.side.length, 0); assert.equal(f.ordinarySends().length, 1)
  assert.equal(await f.inbox.isTextReplyConfirmed(f.group, source.messageId), false)
})

test('Core private chat keeps its ordinary peer path when group smart triggering is configured', redisTest, async t => {
  const f = await fixture(t), source = f.message('这段话来自真实绑定的好友私聊', { conversation: f.privateTarget })
  await f.emit(source); await f.confirmed(source); await f.stop()
  assert.equal(f.requests.length, 1); assert.equal(f.side.length, 0)
  assert.equal(f.ordinarySends()[0].target.kind, 'private'); assert.equal(f.ordinarySends()[0].target.id, f.user.id)
})
