import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAgentToolMessage } from '../dist/backend/modules/messaging/infrastructure/agentToolMessage.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

test('tool notifications own closed bounded data without invoking caller getters or iterators', () => {
  const source = { text: '集合', mentionUserIds: ['member/1', 'member/1'] }
  const result = validateAgentToolMessage(source)
  source.text = 'changed'; source.mentionUserIds[0] = 'other'
  assert.deepEqual(result, { text: '集合', mentionUserIds: ['member/1'] })
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.mentionUserIds))
  let invoked = false
  const getter = { get text() { invoked = true; return 'unsafe' } }
  const ids = ['member']; ids[Symbol.iterator] = function* () { invoked = true; yield 'different' }
  for (const value of [getter, { text: 'x', mentionUserIds: ids }, { text: 'x', mentionUserIds: new Array(1) },
    { text: 'x', mentionUserIds: ['everyone', ''] }, { text: 'x'.repeat(4001) }, { text: '', mentionUserIds: [] },
    { text: 'x', target: 'other-group' }, { text: 'x', mentionUserIds: Array(21).fill('member') }]) {
    assert.throws(() => validateAgentToolMessage(value))
  }
  assert.equal(invoked, false)
})

test('notification wrappers capture data before authorization and revoke all member capabilities after completion', async () => {
  const message = { text: '当前通知', mentionUserIds: ['member'] }
  let checks = 0, captured, context
  const registry = { builtIn: [{ name: 'messageProbe', description: 'Synthetic scoped notification',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, value) {
      context = value
      await value.readMember('member')
      await value.listMembers()
      await value.sendMessage(message)
      return { status: 'succeeded', content: 'done' }
    },
  }] }
  const tools = createAgentTools(registry, { signal: new AbortController().signal, context: () => ({
    binding: {}, actor: { kind: 'user' }, isCurrent: () => true,
    async ensureCurrent() { if (++checks === 6) { message.text = 'mutated'; message.mentionUserIds[0] = 'other' } },
    async readMember(_id, guard, signal) { assert.ok(guard() && !signal.aborted); return undefined },
    async listMembers(guard, signal) { assert.ok(guard() && !signal.aborted); return undefined },
    async sendMessage(value, guard, signal) { assert.ok(guard() && !signal.aborted); captured = value; return { state: 'sent', messageId: 'confirmed' } },
  }) })
  assert.equal((await tools.getExtraTools(['messageProbe'])[0].execute({}, {})).status, 'success')
  assert.deepEqual(captured, { text: '当前通知', mentionUserIds: ['member'] })
  assert.equal(context.signal.aborted, true)
  await assert.rejects(context.readMember('member'))
  await assert.rejects(context.listMembers())
  await assert.rejects(context.sendMessage({ text: 'late', mentionUserIds: ['member'] }))
})
