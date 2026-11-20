import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createTextConversation } = await load('modules/conversation/infrastructure/textConversation.js')
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const toolCall = () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: 'cognition-tool', type: 'function', function: { name: 'commitmentTool', arguments: '{"action":"list"}' } },
] } }] })

function fixture(options = {}) {
  const now = Date.now(), account = { platform: 'qq', namespace: 'cognition-text', id: 'bot' }
  const target = { account, kind: 'group', id: 'room-b' }, sender = { ...account, id: 'user' }
  const binding = { source: 'configured', id: 'binding', revision: 'v1', personaId: 'default', agentId: 'daily', connectionId: 'connection', target }
  const incoming = { version: 1, conversation: target, sender, messageId: 'request', occurredAt: now, text: '请处理这件事',
    parts: [{ kind: 'text', text: '请处理这件事' }], mentions: [], directedToAccount: true }
  const selected = { binding, persona: { name: '希洛' }, systemContent: '说话简短自然。' }
  const requests = [], dispatched = [], sends = [], finish = [], history = [], episodes = [], group = [], learned = [], cognitive = []
  let state = 'pending', cached, cognitionCurrent = true, f
  const ports = {
    inbox: {
      async isTextReplyPending() { return state === 'pending' }, async isTextReplyConfirmed() { return state === 'confirmed' },
      async textActionReceipt() { return state === 'action' ? '' : state === 'result' ? cached : undefined },
      async textRecallVersion() { return 'v1' }, async loadTextHistory() { return undefined },
      async claimTextAction() { if (state !== 'pending') return false; state = 'action'; return true },
      async finishTextAction(_target, _id, _version, text) { assert.equal(state, 'action'); finish.push(text); state = 'result'; cached = text; return true },
      async claimTextReply(_target, _id, _version, receipt) {
        await options.claim?.(f)
        const expected = receipt === undefined ? 'pending' : receipt ? 'result' : 'action'
        if (state !== expected || expected === 'result' && cached !== receipt) return false
        state = 'attempted'; return true
      },
      async confirmTextReply() { if (state !== 'attempted') return false; state = 'confirmed'; return true },
      async saveTextHistory(_target, _version, entry) { history.push(entry) },
    },
    actions: { async send(action, guard) {
      sends.push({ action, guard }); await options.beforeTransport?.(f)
      await guard.ensureCurrent()
      dispatched.push(action); return { state: 'sent', messageId: 'sent-1' }
    } },
    personMemory: { async getSceneRedactions() { return { invalidatedAt: 0 } }, async query() { return { items: [] } } },
    bindingToken: () => 'binding-token', groupToolNames: () => options.tool ? ['commitmentTool'] : [],
    groupTools: {
      definitions: names => names.map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })),
      async execute(_call, _allowed, context) {
        await context.ensureCurrent()
        assert.equal(await context.claimAction(), true)
        await options.afterTool?.(f)
        return { text: '已经处理好了。', attempted: true, ...(options.failure ? { failure: 'unknown' } : {}) }
      },
    },
    isPrivatePeer: () => true, allowsText: () => true, async reserveGroupTurn() { return true }, now: () => now,
    async model(request, _target, _signal, check, ensure) {
      assert.equal(check(), true); await ensure(); requests.push(request)
      return options.tool && requests.length === 1 ? toolCall() : answer(options.failure ? '这次结果还未确认。' : '我也喜欢玩星露谷。')
    },
    async readCognition() { return options.cognition === false ? undefined : {
      text: '以下是带证据的记忆资料：喜欢星露谷。', nodes: [{ id: 'ordinary-interest' }], revision: 1,
      async isCurrent() { return cognitionCurrent },
    } },
    async recordCognitionReply(...args) { await args[4].ensureCurrent(); cognitive.push(args) },
    async recordGroupReply(...args) { group.push(args) }, async recordEpisode(...args) { episodes.push(args) },
    async learnConfirmed(...args) { learned.push(args) },
  }
  const run = () => createTextConversation(ports).reply(incoming, selected, () => true)
  f = { requests, dispatched, sends, finish, history, episodes, group, learned, cognitive,
    get state() { return state }, get cached() { return cached }, revoke() { cognitionCurrent = false }, reply: run }
  return f
}

test('cognition-derived final text avoids old episode/history caches while preserving confirmed inbound learning', async () => {
  const f = fixture()
  await f.reply()
  assert.equal(f.dispatched.length, 1)
  assert.equal(f.episodes.length, 0, 'narrative caches lack the cognition provenance needed to revoke derived replies')
  assert.deepEqual(f.history.map(entry => entry.turns), [[]])
  assert.equal(f.group.length, 1)
  assert.equal(f.learned.length, 1)
  assert.deepEqual(f.cognitive[0][5], ['ordinary-interest'])
})

test('final text without cognition keeps ordinary episode/history caches and inbound learning', async () => {
  const f = fixture({ cognition: false })
  await f.reply()
  assert.equal(f.dispatched.length, 1)
  assert.equal(f.episodes.length, 1)
  assert.equal(f.history[0].turns.length, 1)
  assert.equal(f.group.length, 1)
  assert.equal(f.learned.length, 1)
})

test('source revoked after a group tool runs prevents storing or sending its cognition-derived notification', async () => {
  const f = fixture({ tool: true, afterTool: owner => owner.revoke() })
  await f.reply()
  assert.equal(f.finish.length, 0)
  assert.equal(f.sends.length, 0)
  assert.equal(f.state, 'action')
  await f.reply()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 0, 'restart must not replay a notification from revoked cognition')
})

test('tool notifications recheck cognition in the transport guard and never persist their derived text', async () => {
  const f = fixture({ tool: true, beforeTransport: owner => owner.revoke() })
  await f.reply()
  assert.equal(f.finish.length, 0)
  assert.equal(f.sends.length, 1)
  assert.equal(f.dispatched.length, 0)
  assert.equal(f.cached, undefined)
  await f.reply()
  assert.equal(f.requests.length, 1)
  assert.equal(f.sends.length, 1)
})

test('confirmed cognition-dependent group tool notifications deliver from an attempted receipt without a replay cache', async () => {
  const f = fixture({ tool: true })
  await f.reply()
  assert.equal(f.dispatched.length, 1)
  assert.equal(f.finish.length, 0)
  assert.equal(f.cached, undefined)
  assert.equal(f.state, 'attempted')
  assert.deepEqual(f.episodes, [])
  assert.deepEqual(f.learned, [])
})

for (const failure of [false, true]) test(`interrupted cognition-derived ${failure ? 'failure explanation' : 'tool notification'} cannot resurrect after restart`, async () => {
  let interrupted = false
  const f = fixture({ tool: true, failure, claim() { if (!interrupted) { interrupted = true; throw Error('process interrupted before reply claim') } } })
  if (failure) await f.reply()
  else await assert.rejects(f.reply(), /process interrupted/)
  assert.equal(f.finish.length, 0)
  assert.equal(f.state, 'action')
  assert.equal(f.cached, undefined)
  f.revoke()
  const models = f.requests.length
  await f.reply()
  assert.equal(f.requests.length, models)
  assert.equal(f.sends.length, 0)
})

test('tools without cognition preserve the existing durable notification replay', async () => {
  let interrupted = false
  const f = fixture({ cognition: false, tool: true, claim() { if (!interrupted) { interrupted = true; throw Error('process interrupted before reply claim') } } })
  await assert.rejects(f.reply(), /process interrupted/)
  assert.equal(f.finish.length, 1)
  assert.equal(f.state, 'result')
  await f.reply()
  assert.equal(f.requests.length, 1)
  assert.equal(f.dispatched.length, 1)
  assert.equal(f.dispatched[0].parts[0].text, f.cached)
})
