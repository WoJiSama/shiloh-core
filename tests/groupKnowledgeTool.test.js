import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupKnowledgeTool } from '../dist/backend/modules/memory/infrastructure/groupKnowledgeTool.js'
import { createGroupTextTools } from '../dist/backend/modules/conversation/infrastructure/groupTextTools.js'

function fixture(options = {}) {
  const target = { account: { platform: 'fixture', namespace: 'knowledge', id: 'bot' }, kind: 'group', id: 'room' }
  const entry = { id: 'workflow-1', kind: 'workflow', condition: '会议通知', targetUserIds: ['member-a', 'member-b'] }
  const sends = [], checks = [], mutations = []
  let live = true, lists = 0, claims = 0
  const context = { binding: { target }, actor: { kind: 'user', user: { ...target.account, id: 'speaker' } },
    requestMessageId: 'genuine-message', userText: '请现在通知会议组：明天九点开会', signal: new AbortController().signal,
    isCurrent: () => live, ensureCurrent: async () => { if (!live) throw Error('stale') }, allowsText: () => true }
  const tool = createGroupKnowledgeTool({
    management: {
      async list(received) {
        assert.equal(received.requestMessageId, 'genuine-message')
        lists++
        return { status: 'listed', entries: options.entries ? options.entries(lists, entry) : [entry] }
      },
      async delete(input, received) { mutations.push({ input, received }); return { status: 'deleted', deleted: 2 } },
      async forget(input, received) { mutations.push({ input, received }); return { status: 'ambiguous' } },
      async clear(input, received) { mutations.push({ input, received }); return { status: 'cleared', deleted: 3 } },
    },
    async member(received, id, signal, guard) {
      assert.deepEqual(received, target)
      assert.equal(signal, context.signal)
      assert.equal(guard(), true)
      checks.push(id)
      return options.member ? options.member(id, () => { live = false }) : { member: { user: { ...target.account, id } } }
    },
    actions: { async send(action, guard) { assert.equal(guard.isCurrent(), true); sends.push(action); return options.receipt ?? { state: 'sent', messageId: 'sent' } } },
  })
  const placeholder = { parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'] }, validateParameters: () => true }
  const tools = createGroupTextTools({ commitment: placeholder, memory: placeholder, knowledge: tool })
  return { tool, tools, sends, checks, mutations, context, notify: { action: 'notify', id: entry.id, requestExcerpt: '请现在通知会议组', content: '明天九点开会' },
    textContext: { binding: context.binding, speakerId: 'speaker', userText: context.userText, requestMessageId: context.requestMessageId,
      signal: context.signal, isCurrent: context.isCurrent, allowsText: context.allowsText, claimAction: async () => { claims++; return claims === 1 } },
    claims: () => claims }
}

test('workflow notification sends fresh verified targets once with the genuine reply source', async () => {
  const f = fixture()
  assert.equal(await f.tool.executeForRequest(f.notify, f.context), '已按本条请求通知工作流中的成员。')
  assert.deepEqual(f.checks, ['member-a', 'member-b'])
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].replyTo, 'genuine-message')
  assert.deepEqual(f.sends[0].parts.map(part => part.kind), ['mention', 'mention', 'text'])
  assert.deepEqual(f.sends[0].parts[0].user, { ...f.context.binding.target.account, id: 'member-a' })
})

test('saved teaching alone, autonomous execution, invented quotes and text cannot authorize notification', async () => {
  for (const change of [
    { context: { actor: { kind: 'autonomous' } } },
    { input: { requestExcerpt: '历史里教过这条通知' } },
    { input: { content: '原消息中没有的正文' } },
    { context: { allowsText: () => false } },
  ]) {
    const f = fixture()
    await f.tool.executeForRequest({ ...f.notify, ...change.input }, { ...f.context, ...change.context })
    assert.equal(f.sends.length, 0)
  }
})

test('membership loss, workflow deletion and scope cancellation each stop the send', async () => {
  for (const options of [
    { member: () => undefined },
    { entries: (count, entry) => count === 1 ? [entry] : [] },
    { member: (_id, cancel) => { cancel(); return { member: {} } } },
  ]) {
    const f = fixture(options)
    await f.tool.executeForRequest(f.notify, f.context)
    assert.equal(f.sends.length, 0)
  }
})

test('unknown notification receipt never retries the side effect', async () => {
  const f = fixture({ receipt: { state: 'unknown' } })
  assert.match(await f.tool.executeForRequest(f.notify, f.context), /结果未确认/u)
  assert.equal(f.sends.length, 1)
})

test('clear confirmation must appear in the new genuine message, and ambiguity does not delete', async () => {
  const f = fixture()
  assert.match(await f.tool.executeForRequest({ action: 'clear', confirmationId: 'invented-code' }, f.context), /另一条新消息/u)
  assert.equal(f.mutations.length, 0)
  assert.match(await f.tool.executeForRequest({ action: 'forget', subject: '会议' }, f.context), /准确编号/u)
  assert.equal(f.mutations.length, 1)
})

test('group text must explicitly expose knowledge and durably claim the action before executing', async () => {
  const f = fixture()
  assert.equal(f.tools.definitions([]).length, 0)
  assert.equal(f.tools.definitions(['groupKnowledgeTool'], true).length, 0)
  assert.equal(f.tools.definitions(['groupKnowledgeTool'])[0].function.name, 'groupKnowledgeTool')
  const call = { type: 'function', function: { name: 'groupKnowledgeTool', arguments: JSON.stringify(f.notify) } }
  assert.match((await f.tools.execute(call, [], f.textContext)).text, /没有开放/u)
  assert.equal(f.claims(), 0)
  assert.equal((await f.tools.execute(call, ['groupKnowledgeTool'], f.textContext)).attempted, true)
  assert.equal(f.claims(), 1)
  assert.equal(f.sends.length, 1)
  assert.equal(await f.tools.execute(call, ['groupKnowledgeTool'], f.textContext), undefined)
  assert.equal(f.sends.length, 1)
})
