import assert from 'node:assert/strict'
import test from 'node:test'
import YAML from 'yaml'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentFeatureSwitches, normalizeAgentFeatureSwitches } = await load('modules/tools/domain/agentFeatureSwitches.js')
const account = { platform: 'qq', namespace: 'global', id: '123456' }
const group = { account, kind: 'group', id: '313001' }
const other = { ...group, id: '313002' }
const privateChat = { ...group, kind: 'private' }

test('feature switches preserve existing eligibility and support a global default with per-item exceptions', () => {
  const inherited = createAgentFeatureSwitches(undefined)
  assert.equal(inherited.feature('mediaRelay', group), true)
  assert.equal(inherited.tool('mcp_new', privateChat), true)

  const policy = createAgentFeatureSwitches({ default: 'off', features: { mediaRelay: { mode: 'groups', groups: [group.id] } },
    tools: { webParserTool: { mode: 'all' }, searchVideoTool: { mode: 'groups', groups: [other.id] } } })
  assert.equal(policy.feature('mediaRelay', group), true)
  assert.equal(policy.feature('mediaRelay', { ...group, account: { ...account, id: '234567' } }), true)
  assert.equal(policy.feature('mediaRelay', other), false)
  assert.equal(policy.feature('mediaRelay', privateChat), false)
  assert.equal(policy.feature('mediaRelay', { ...group, account: { ...account, platform: 'fixture' } }), false)
  assert.equal(policy.feature('mediaRelay', { ...group, account: { ...account, namespace: 'other' } }), false)
  assert.equal(policy.feature('dice', group), false)
  assert.equal(policy.tool('webParserTool', privateChat), true)
  assert.equal(policy.tool('searchVideoTool', group), false)
  assert.equal(policy.tool('searchVideoTool', other), true)
  assert.equal(policy.tool('mcp_new', group), false)
  assert.equal(createAgentFeatureSwitches({ tools: { mcp_new: { mode: 'off' } } }).tool('mcp_new', group), false)
})

test('standalone host validates a saved switch policy and writes only edited YAML fields', async () => {
  const [{ writeFeatureSwitches }, { createStandaloneAgentCandidateValidator }] = await Promise.all([
    load('bootstrap/standaloneAgentFeatureSwitches.js'), load('bootstrap/standaloneAgentConfig.js'),
  ])
  const bindings = YAML.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'qq', agentId: 'daily', kind: 'group', conversationId: group.id }] })
  const host = '# preserved host comment\n' + YAML.stringify({ version: 1, instance: 'switches-fixture',
    model: { baseUrl: 'https://model.example/v1', name: 'fixture', apiKeyEnv: 'TEST_MODEL_KEY' },
    connections: [{ id: 'qq', url: 'ws://127.0.0.1:3001/onebot' }],
    featureSwitches: { tools: { searchVideoTool: { mode: 'groups', groups: [group.id] } } } })
  const validate = createStandaloneAgentCandidateValidator('agent-host.yaml', {}, { requireCredentials: false })
  const previous = validate({ host, bindings }).featureSwitches
  const doc = YAML.parseDocument(host)
  const next = normalizeAgentFeatureSwitches({ default: 'off', features: { mediaRelay: { mode: 'groups', groups: [group.id] } },
    tools: { searchVideoTool: { mode: 'all' } } })
  assert.equal(writeFeatureSwitches(doc, previous, next), 3)
  const updated = doc.toString()
  assert.match(updated, /^# preserved host comment/u)
  assert.deepEqual(validate({ host: updated, bindings }).featureSwitches, next)
  assert.deepEqual(YAML.parse(updated), { ...YAML.parse(host), featureSwitches: JSON.parse(JSON.stringify(next)) })
  const reset = normalizeAgentFeatureSwitches({ default: 'off' })
  assert.equal(writeFeatureSwitches(doc, next, reset), 2)
  assert.deepEqual(validate({ host: doc.toString(), bindings }).featureSwitches, reset)
  assert.equal(writeFeatureSwitches(doc, reset, reset), 0)

  doc.delete('featureSwitches')
  const inherited = validate({ host: doc.toString(), bindings }).featureSwitches
  assert.equal(inherited.default, 'all')
  assert.equal(writeFeatureSwitches(doc, inherited, next), 3)
  assert.deepEqual(validate({ host: doc.toString(), bindings }).featureSwitches, next)
})

test('invalid switch policies fail configuration validation', () => {
  for (const value of [null, { default: 'groups' }, { features: { unknown: { mode: 'all' } } },
    { tools: { searchVideoTool: { mode: 'groups' } } }, { tools: { searchVideoTool: { mode: 'groups', groups: [313002] } } },
    { tools: { searchVideoTool: { mode: 'off', groups: [group.id] } } }]) {
    assert.throws(() => normalizeAgentFeatureSwitches(value), /featureSwitches/u)
  }
})
