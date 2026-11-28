import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { createAgentSecretTextCheck } from '../dist/backend/modules/messaging/infrastructure/agentSecretText.js'

test('newly refreshed host credentials cannot enter an already registered public tool', async () => {
  const registered = ['initial-host-private-key'], calls = []
  const definition = { name: 'independentTool', description: 'External operation', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    async execute(input) { calls.push(structuredClone(input)); return { status: 'succeeded', content: 'done' } } }
  const tools = createAgentTools({ builtIn: [definition] }, {
    signal: new AbortController().signal,
    allowsInput: text => createAgentSecretTextCheck(registered)(text),
    context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true }),
  })
  const tool = tools.getExtraTools([definition.name])[0]
  assert.equal((await tool.execute({ query: 'ordinary query' }, {})).status, 'success')
  const refreshed = 'newly-refreshed-music-private-key/+='; registered.push(refreshed)
  const unicode = [...refreshed].map(value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  for (const query of [refreshed, JSON.stringify(refreshed), encodeURIComponent(refreshed), Buffer.from(refreshed).toString('base64'),
    unicode, JSON.stringify(unicode)]) {
    const result = await tool.execute({ query }, {})
    assert.equal(result.status, 'error'); assert.doesNotMatch(result.content, /newly-refreshed/)
  }
  assert.deepEqual(calls, [{ query: 'ordinary query' }])
})

test('literal credential matching handles pattern characters and combined escaping', () => {
  const secret = 'key.[sample](private)+?^$|\\end'
  const encoded = [...secret].map(char => '%' + char.charCodeAt().toString(16)).join('')
  const check = createAgentSecretTextCheck([secret, 'other-sealed-key'])
  for (const value of [secret, JSON.stringify(secret), encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'), encoded, 'stray % ' + encoded, encoded.replaceAll('%', '\\\\u0025')]) {
    assert.equal(check('before ' + value + ' after'), false)
  }
  assert.equal(check('keyXsampleprivateeeeeend and an unrelated \\u0025'), true)
  assert.equal(check('0.00001 -0.00001 0.00001\n'.repeat(20_000)), true)
})
