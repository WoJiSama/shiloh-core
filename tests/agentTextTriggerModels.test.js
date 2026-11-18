import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createAgentTextTriggerModels } = await load('modules/conversation/infrastructure/agentTextTriggerModels.js')
const { createPersonaSnapshot } = await load('modules/conversation/infrastructure/personaSnapshot.js')

function fixture(options = {}) {
  const account = { platform: 'fixture', namespace: 'gate', id: 'bot' }, target = { account, kind: 'group', id: 'room' }
  const binding = { source: 'configured', id: 'binding', revision: 'rev1', personaId: 'default', agentId: 'role', connectionId: 'connection', target }
  const incoming = { version: 1, conversation: target, sender: { ...account, id: 'human' }, messageId: 'source', occurredAt: Date.now(),
    text: '那刚才的事情呢？', parts: [], mentions: [], directedToAccount: false }
  const persona = createPersonaSnapshot({ botId: 'fixture:gate:bot', persona: { name: '本账号角色', preferences: ['偏好安静聊天'] }, systemContent: '', binding })
  const requests = [], diagnostics = [], controller = new AbortController()
  let current = true, ensured = 0
  const input = { binding, incoming, persona, phase: 'focus', reason: 'continuation_strong', history: [{ speakerId: 'human', text: '刚才的话题' }],
    recentReplies: 2, recentIncoming: 8, signal: controller.signal, isCurrent: () => current,
    async ensureCurrent() { ensured++; if (!current) throw Error('revoked') } }
  const api = createAgentTextTriggerModels({ allowsText: text => !text.includes('SECRET'), diagnostics: { emit: event => diagnostics.push(event) },
    async model(request, receivedTarget, signal, guard, ensure) {
      assert.deepEqual(receivedTarget, target); assert.equal(guard(), true); assert.equal(signal.aborted, false)
      await ensure(); requests.push(request)
      return options.model ? options.model(request, () => { current = false }, controller) :
        { choices: [{ message: { content: JSON.stringify(options.output ?? { decision: 'continue', reason: '自然接话' }) } }] }
    } })
  return { input, api, requests, diagnostics, revoke() { current = false }, get ensured() { return ensured } }
}

test('neutral gate is tool-free, uses the receiving persona and keeps chat data delimited', async () => {
  const f = fixture(); const result = await f.api.gate(f.input)
  assert.equal(result.decision, 'continue'); assert.equal(f.requests.length, 1); assert.ok(f.ensured >= 3)
  assert.deepEqual(f.requests[0].tools, []); assert.equal(f.requests[0].tool_choice, 'none')
  assert.match(f.requests[0].messages[0].content, /本账号角色/u); assert.match(f.requests[0].messages[0].content, /偏好安静聊天/u)
  assert.equal(JSON.parse(f.requests[0].messages[1].content).current.text, f.input.incoming.text)
})

test('strict tracking requires a sole boolean result and does not accept substring true', async () => {
  for (const [output, talking] of [[{ talking: true }, true], [{ talking: false }, false], [{ talking: 'true' }, false], [{ talking: true, action: 'send' }, false], [{ decision: 'continue' }, false]]) {
    const f = fixture({ output }); assert.equal(await f.api.tracking({ ...f.input, history: [{ user: '此前发言', reply: '角色回复' }] }), talking)
  }
})

test('malformed, expanded, tool-bearing and leaking model responses keep the gate silent', async () => {
  for (const response of [
    { error: 'provider SECRET' }, { choices: [] }, { choices: [{ message: { content: 'prefix {"decision":"continue"}' } }] },
    { choices: [{ message: { content: '{"decision":"continue","command":"send"}' } }] },
    { choices: [{ message: { content: '{"decision":"continue","reason":"SECRET"}' } }] },
    { choices: [{ message: { content: '{"decision":"continue"}', tool_calls: [{ function: { name: 'send' } }] } }] },
    { choices: [{ message: { content: '{"decision":"wait","wait_seconds":600}' } }] },
    { choices: [{ message: { content: '{"decision":"wait","wait_seconds":"5"}' } }] },
  ]) {
    const f = fixture({ model: () => response }); assert.equal((await f.api.gate(f.input)).decision, 'no_action')
    assert.equal(JSON.stringify(f.diagnostics).includes('SECRET'), false)
  }
})

test('a gate cannot use another binding/persona, foreign source or withdrawn context', async () => {
  for (const kind of ['persona', 'source', 'context', 'pending']) {
    const f = fixture({ model(_request, revoke) { revoke(); return { choices: [{ message: { content: '{"decision":"continue"}' } }] } } })
    if (kind === 'persona') f.input.persona = { ...f.input.persona, binding: { ...f.input.binding, connectionId: 'other' } }
    if (kind === 'source') f.input.incoming = { ...f.input.incoming, sender: { ...f.input.incoming.sender, namespace: 'foreign' } }
    if (kind === 'context') f.revoke()
    assert.equal((await f.api.gate(f.input)).decision, 'no_action')
    assert.equal(f.requests.length, kind === 'pending' ? 1 : 0)
  }
})

test('wait is bounded and a model interpretation addressed to another member cannot continue', async () => {
  const waiting = fixture({ output: { decision: 'wait', wait_seconds: 4 } })
  assert.deepEqual(await waiting.api.gate(waiting.input), { decision: 'wait', reason: 'gate_wait', waitMs: 4000 })
  const other = fixture({ output: { decision: 'continue', social: { act: 'conversation', target: 'other', targetUserIds: ['friend'], confidence: 1 } } })
  assert.equal((await other.api.gate(other.input)).decision, 'no_action')
})
