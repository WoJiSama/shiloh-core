import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { createAgentSimulationWakeGate } from '../dist/backend/modules/simulation/infrastructure/agentSimulationModels.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { commitmentRedis } from './helpers/commitmentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '985300001' }
const target = { account, kind: 'group', id: '984200001' }
const binding = { source: 'configured', id: 'group-fixture', revision: 'v1', agentId: 'shiloh', personaId: 'default', connectionId: 'fixture-qq', target }
const al = { ...account, id: '985301111' }, bo = { ...account, id: '985302222' }, ch = { ...account, id: '985303333' }
const names = new Map([[al.id, '小林'], [bo.id, '阿诚'], [ch.id, '阿月']])
const silent = { engage: false }

async function until(predicate, reason) {
  const expires = Date.now() + 8_000
  while (Date.now() < expires) {
    if (await predicate()) return
    await delay(15)
  }
  assert.fail(reason)
}

async function fixture(t, screen, probability = 0, ports = {}) {
  const map = new Map(), gates = [], requests = [], replies = [], failures = []
  let now = Date.UTC(2026, 10, 26, 10), id = 870081000
  const clock = () => now
  const shared = commitmentRedis(map, clock)
  const runtime = createSimulationRuntime({
    redis: { get: shared.get, set: shared.set, del: shared.del }, logger: { info() {}, warn() {}, error(...args) { failures.push(args) } },
    now: clock, random: () => 0, unifiedGroupChat: true, durableIngress: true,
    getSelf: () => ({ id: account.id, name: '希洛' }),
    getPersona: () => ({ binding, personaId: 'agent:shiloh', persona: { name: '希洛' }, systemContent: '' }),
    getExecutionConfig: () => ({ useTools: true }),
    getSection: () => ({ enabled: true, allGroups: true, wake: { probability, proactiveProbability: 0, batchWindowMs: 1000 },
      wakeGate: { enabled: true }, turn: { minSendGapMs: 0 }, reflection: { enabled: false }, lifeThreads: { enabled: false },
      mood: { enabled: false }, rhythm: { enabled: false }, personProfile: { enabled: false },
      userStyle: { enabled: false }, meme: { enabled: false } }),
    async wakeGateJudge(input) {
      gates.push(input.routing)
      try { return await screen(input.routing) }
      catch (error) { failures.push(error); throw error }
    },
    async YTapi(request) {
      const body = request.messages.find(message => message.role === 'user').content
      requests.push(body)
      const messages = body.includes('【旁听中的话题】') ? ['你们刚才聊的双人模式，我想试试一起存档。']
        : body.includes('那周日呢') ? ['周日也可以，上午怎么样？'] : ['周六八点开团。']
      return { choices: [{ message: { content: '', tool_calls: [{ id: String(++id), type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'chat', messages }),
      } }] } }] }
    },
    messageActions: { async send(action) {
      assert.deepEqual(action.target, target)
      const messageId = String(++id)
      replies.push({ id: messageId, text: action.parts.find(part => part.kind === 'text')?.text, replyTo: action.replyTo })
      return { state: 'sent', messageId }
    } },
    ...ports,
  })
  t.after(async () => { runtime.stop(); await runtime.drain(); assert.deepEqual(failures, []) })
  const key = simulationSessionKey(await runtime.conversationKey(target))
  const state = createDefaultSimSession(now)
  Object.assign(state, { botId: account.id, personaId: 'agent:shiloh', bindingToken: agentBindingToken(binding), bootstrapSent: true })
  state.wakeConfig.triggers.probability = probability
  map.set(key, JSON.stringify(state))
  async function receive(sender, text, { mentions = [], quote } = {}) {
    now += 1000
    const messageId = String(++id)
    await runtime.ingest({ version: 1, conversation: target, sender, senderName: names.get(sender.id), messageId,
      text, occurredAt: now, parts: [{ kind: 'text', text }], mentions, directedToAccount: mentions.includes(account),
      ...(quote ? { quote: { messageId: quote.id, author: quote.sender, authorName: names.get(quote.sender.id), text: quote.text, parts: [] } } : {}),
    })
    return { id: messageId, sender, text }
  }
  return { receive, gates, requests, replies, runtime, state: () => JSON.parse(map.get(key)) }
}

test('group replay keeps an implicit follow-up on its confirmed topic through a directed side conversation', async t => {
  const f = await fixture(t, route => {
    const focus = route.messages.find(item => item.seq === route.triggerSeq)
    if (focus.text === '吃了') return silent
    assert.equal(focus.text, '那周日呢？')
    assert.equal(route.reply, 'continuation')
    const aside = route.messages.find(item => item.text.includes('吃饭'))
    const answer = route.messages.find(item => item.text === '已经吃了')
    assert.deepEqual(aside.mentions, [focus.speaker])
    assert.equal(answer.replyToSpeaker, aside.speaker)
    assert.equal(answer.replyTo, aside.seq)
    const [previous] = route.previous
    assert.match(previous.question, /周六/u)
    assert.match(previous.answer, /八点/u)
    return { engage: true, selection: { mode: 'reply', seq: focus.seq, previousSeq: previous.sourceSeq } }
  })
  await f.receive(al, '周六几点开团？', { mentions: [account] })
  await until(() => f.state().confirmedGroupReplies?.length, 'expected confirmed response')
  const aside = await f.receive(bo, '你吃饭了吗？', { mentions: [al] })
  await f.receive(al, '已经吃了', { quote: aside })
  await f.receive(al, '吃了')
  await until(() => f.gates.length === 1 && !f.state().queuedIngressWake, 'side conversation should be ignored')
  assert.equal(f.replies.length, 1)
  await f.receive(al, '那个呢？')
  await until(() => !f.state().queuedIngressWake, 'an ambiguous pronoun should stay silent')
  assert.equal(f.gates.length, 1)
  const followUp = await f.receive(al, '那周日呢？')
  await until(() => f.replies.length === 2, 'the real follow-up was lost')
  assert.equal(f.replies[1].replyTo, followUp.id)
  assert.doesNotMatch(f.requests.at(-1), /已经吃了|吃饭|那个呢/u)
  assert.match(f.requests.at(-1), /周六八点开团/u)
  const original = f.replies[0]
  await f.receive(ch, '后来时间定了没有？', { quote: { ...original, sender: account } })
  await until(() => f.replies.length === 3, 'a direct quote did not get its own turn')
  assert.equal(f.gates.length, 2)
  assert.match(f.requests.at(-1), /周六几点开团/u)
  assert.doesNotMatch(f.requests.at(-1), /吃饭|那周日呢/u)
})

test('group replay distinguishes a case of mentioning the bot from choosing to join a relevant topic', async t => {
  const f = await fixture(t, route => {
    const focus = route.messages.find(item => item.seq === route.triggerSeq)
    if (focus?.text.includes('物流')) {
      assert.equal(route.reply, 'none')
      return silent
    }
    assert.equal(route.reply, 'none')
    const picked = route.messages.find(item => item.text.includes('双人模式'))
    return { engage: true, selection: { mode: 'join', seq: picked.seq } }
  }, 1)
  await f.receive(bo, '你知道希洛那边的物流到了吗？', { mentions: [ch] })
  await until(() => f.gates.length === 1 && !f.state().queuedIngressWake, 'explicit other chat should be screened')
  assert.deepEqual(f.requests, [])
  await f.receive(ch, '今晚要不要试试这个游戏的双人模式？')
  await until(() => f.replies.length === 1, 'the agent did not join')
  assert.match(f.requests.at(-1), /旁听中的话题/u)
  assert.match(f.requests.at(-1), /"kind"\s*:\s*"autonomous"/u)
  assert.doesNotMatch(f.requests.at(-1), /物流/u)
})

test('a delayed refusal from the gate keeps a later direct message queued', async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  t.after(() => resume.resolve())
  const f = await fixture(t, async () => { entered.resolve(); await resume.promise; return silent }, 1)
  await f.receive(bo, '明天这边换个车站。')
  try {
    await entered.promise
    await f.receive(al, '周六几点开团？', { mentions: [account] })
  } finally { resume.resolve() }
  await until(() => f.replies.length === 1, 'pending direct message should receive its own turn')
  assert.equal(f.gates.length, 1)
  assert.doesNotMatch(f.requests.at(-1), /车站/u)
})

test('an unavailable gate leaves a side conversation alone', async t => {
  const f = await fixture(t, undefined, 1, { wakeGateJudge: undefined })
  await f.receive(bo, '你看小林那边怎么样？', { mentions: [ch] })
  await until(() => !f.state().queuedIngressWake, 'the low-signal wake did not settle')
  await f.receive(al, '周六几点开团？', { mentions: [account] })
  await until(() => f.replies.length === 1, 'an explicit mention did not bypass the unavailable gate')
  assert.equal(f.requests.length, 1)
})

test('a confirmed reply that used group memory can anchor a topic without exposing its text to the gate', async t => {
  const f = await fixture(t, route => {
    const [previous] = route.previous
    assert.match(previous.question, /周六/u)
    assert.equal(previous.answer, undefined)
    return { engage: true, selection: { mode: 'reply', seq: route.triggerSeq, previousSeq: previous.sourceSeq } }
  }, 0, { readGroupMemory: async () => '本群有一段按权限读取的记忆。' })
  await f.receive(al, '周六几点开团？', { mentions: [account] })
  await until(() => f.state().confirmedGroupReplies?.length, 'the confirmed topic link is missing')
  const followUp = await f.receive(al, '那周日呢？')
  await until(() => f.replies.length === 2, 'the topic was lost after injecting group memory')
  assert.equal(f.replies[1].replyTo, followUp.id)
})

test('structured wake output binds the selected message and previous reply to the supplied window', async () => {
  const messages = [{ name: 'User A', text: '那周日呢？', atSelf: false }]
  const routing = { selfName: '希洛', triggerSeq: 19, reply: 'continuation', allowJoin: false, messages: [
    { seq: 19, speaker: 'p1', name: 'User A', text: '那周日呢？', atSelf: false, mentions: [], joinable: false, ageSeconds: 1 },
  ], previous: [{ sourceSeq: 7, speaker: 'p1', question: '周六几点开团？', answer: '晚上八点。' }] }
  let result
  const judge = createAgentSimulationWakeGate({ baseUrl: 'https://example.test/v1', name: 'fixture', apiKey: 'fixture-key',
    async fetchImpl(_url, init) {
      const request = JSON.parse(init.body)
      assert.deepEqual(JSON.parse(request.messages[1].content), routing)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
    },
  })
  const guard = { binding, target, signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
  for (const selection of [{ mode: 'reply', seq: 19 }, { mode: 'reply', seq: 19, previousSeq: 8 },
    { mode: 'reply', seq: 19, previousSeq: 7, contextSeqs: [400] }, { mode: 'join', seq: 19 }]) {
    result = { engage: true, selection }
    assert.equal(await judge({ messages, reason: 'continuation', routing }, undefined, guard), null)
  }
  const valid = { engage: true, selection: { mode: 'reply', seq: 19, previousSeq: 7 } }
  result = { engage: true, selection: { ...valid.selection, contextSeqs: [19] } }
  assert.deepEqual(await judge({ messages, reason: 'continuation', routing }, undefined, guard), valid)
})
