import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextConversation } from '../dist/backend/modules/conversation/infrastructure/textConversation.js'
import { createAgentBindingDirectory } from '../dist/backend/core/index.js'

const original = '临时历史证据：雨燕计划在星期三抱石'
const derived = '查证答复：星期三安排已核实'
const call = (name, input, id = 'history-call') => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id, type: 'function', function: { name, arguments: JSON.stringify(input) } },
] } }] })
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })

function fixture(t, options = {}) {
  const now = Date.now(), account = { platform: 'fixture', namespace: 'history-text', id: 'bot' }
  const target = { account, kind: options.group ? 'group' : 'private', id: 'room' }
  const actor = { ...account, id: 'real-peer' }
  const binding = createAgentBindingDirectory({ version: 1,
    agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }],
  }, 'history-text-v1').resolve(target)
  const incoming = { version: 1, conversation: target, sender: actor, messageId: 'trigger', occurredAt: now,
    text: '请核实我之前抱石的安排', parts: [{ kind: 'text', text: '请核实我之前抱石的安排' }], mentions: [], directedToAccount: true }
  const requests = [], reads = [], sends = [], saved = [], episodes = [], learned = [], groups = []
  const permissions = { valid: true, checks: 0 }
  const runtime = createTextConversation({
    inbox: {
      async isTextReplyPending() { return true }, async isTextReplyConfirmed() { return false },
      async confirmTextReply() { return true }, async textActionReceipt() { return undefined },
      async textRecallVersion() { return 0 }, async loadTextHistory() { return undefined },
      async claimTextAction() { assert.fail('history must not claim a write action') }, async finishTextAction() { assert.fail('history must not persist an action result') },
      async claimTextReply() { return true }, async saveTextHistory(_target, _version, value) { saved.push(value) },
    },
    actions: { async send(action, guard) { assert.equal(guard.isCurrent(), true); sends.push(action); return { state: 'sent', messageId: 'reply' } } },
    personMemory: { async getSceneRedactions() { return { invalidatedAt: 0 } }, async query() { return { items: [] } } },
    bindingToken: () => 'binding-token', groupToolNames: () => [], isToolEnabled: options.isToolEnabled,
    groupTools: { definitions: () => [], async execute() { assert.fail('derived write must not reach group tools') } },
    isPrivatePeer: () => true, allowsText: () => true, async reserveGroupTurn() { return true }, now: () => now,
    async learnConfirmed() { learned.push(incoming.text) }, async recordEpisode(value) { episodes.push(value) }, async recordGroupReply(value) { groups.push(value) },
    async readHistory(message, input, guard, signal) {
      assert.equal(message, incoming); assert.equal(guard(), true); assert.equal(signal?.aborted ?? false, false)
      reads.push(input)
      return { text: JSON.stringify({ status: 'found', messages: [{ content: original, message_id: `source-${reads.length}` }], next_offsets: { recent: 1 } }),
        async isCurrent() { permissions.checks++; return permissions.valid && guard() } }
    },
    async model(request, _target, _signal, guard, ensure) {
      assert.equal(guard(), true); await ensure()
      requests.push(request)
      return options.model ? options.model({ request, requests, permissions, ensure })
        : requests.length < 3 ? call('chatHistoryTool', { question: '抱石', source: 'recent', keywords: ['抱石'], offset: requests.length - 1 }) : answer(derived)
    },
  })
  return { runtime, incoming, binding, requests, reads, sends, saved, episodes, learned, groups, permissions,
    reply: () => runtime.reply(incoming, { binding, persona: { name: '测试角色' }, systemContent: '' }, () => true) }
}

for (const group of [false, true]) test(`text history pages use revocable ephemeral evidence in ${group ? 'group' : 'private'} replies`, async t => {
  const f = fixture(t, { group })
  await f.reply()
  assert.equal(f.requests.length, 3); assert.equal(f.reads.length, 2); assert.equal(f.sends.length, 1)
  assert.ok(JSON.stringify(f.requests[1]).includes(original)); assert.ok(JSON.stringify(f.requests[2]).includes(original))
  assert.equal(f.sends[0].parts[0].text, derived)
  assert.ok(f.permissions.checks >= 6)
  assert.deepEqual(f.saved[0].turns, []); assert.deepEqual(f.episodes, []); assert.deepEqual(f.groups, [])
  assert.ok(!JSON.stringify(f.saved).includes(original)); assert.ok(!JSON.stringify(f.saved).includes(derived))
})

test('text history switch removes the tool and rejects a model call despite the available provider', async t => {
  const f = fixture(t, { isToolEnabled: name => name !== 'chatHistoryTool' })
  await f.reply()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].tools?.some(row => row.function.name === 'chatHistoryTool') ?? false, false)
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.sends, [])
})

test('text history rechecks source before a model compatibility retry and blocks delivery', async t => {
  const f = fixture(t, { async model({ requests, permissions, ensure }) {
    if (requests.length === 1) return call('chatHistoryTool', { question: '抱石', source: 'recent', keywords: ['抱石'] })
    permissions.valid = false
    await ensure() // the actual transport must call this before retrying
    assert.fail('revoked history reached retry')
  } })
  await f.reply()
  assert.equal(f.requests.length, 2); assert.deepEqual(f.sends, []); assert.deepEqual(f.saved, [])
})

test('text history cannot feed a subsequent write tool in the same turn', async t => {
  const f = fixture(t, { async model({ requests }) {
    return requests.length === 1 ? call('chatHistoryTool', { question: '抱石', source: 'recent' })
      : call('delegateMemoryTool', { action: 'remember', content: original })
  } })
  await f.reply()
  assert.deepEqual(f.sends, []); assert.deepEqual(f.saved, []); assert.deepEqual(f.episodes, [])
})
