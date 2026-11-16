import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conversation-memory-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_MODEL_KEY: 'main-key', TEST_SUMMARY_KEY: 'summary-key' }
  const backend = { baseUrl: 'https://summary.example/v1', name: 'conversation-summary', apiKeyEnv: 'TEST_SUMMARY_KEY' }
  function read(sections = {}, { credentials = env, options } = {}) {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, instance: 'conversation-memory-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...sections,
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read, backend, env }
}

test('standalone conversation memory keeps coordinator defaults and requires an explicit summary backend', t => {
  const { read, backend } = fixture(t)
  const absent = read()
  assert.deepEqual(absent.midtermMemory, {})
  assert.deepEqual(absent.episodicMemory, {})
  assert.equal(absent.midtermSummary, undefined)
  assert.equal(Object.hasOwn(absent, 'midtermSummary'), false)
  const local = read({ midtermMemory: { enabled: true }, episodicMemory: { enabled: true, proactiveEnabled: true } })
  assert.equal(local.midtermSummary, undefined, 'enabling memory never selects the main model for summarization')
  assert.deepEqual(local.episodicMemory, { enabled: true, proactiveEnabled: true })
  const configured = read({ midtermSummary: backend })
  assert.deepEqual(configured.midtermSummary, {
    apiUrl: 'https://summary.example/v1', model: 'conversation-summary', apiKey: 'summary-key', apiKeyEnv: 'TEST_SUMMARY_KEY',
  })
  assert.equal(configured.execution.chatAiConfig.chatApiModel, 'main-model')
  assert.equal(configured.execution.chatAiConfig.chatApiKey, 'main-key')
  assert.equal(read({ midtermSummary: backend, midtermMemory: { enabled: false } }).midtermSummary.model, 'conversation-summary')
})

test('standalone memory configuration preserves every supported setting without clamping or coercion', t => {
  const { read } = fixture(t)
  for (const [midtermMemory, episodicMemory] of [
    [{ enabled: false, minMessages: 4, debounceMs: 5000, maxSummaryChars: 120, bufferMaxLines: 50, retentionDays: 1 },
      { enabled: false, maxPerGroup: 20, recallDays: 1, proactiveEnabled: false }],
    [{ enabled: true, minMessages: 200, debounceMs: 3600000, maxSummaryChars: 4000, bufferMaxLines: 1000, retentionDays: 30 },
      { enabled: true, maxPerGroup: 1000, recallDays: 30, proactiveEnabled: true }],
    [{ enabled: true, minMessages: 15, debounceMs: 20000, maxSummaryChars: 500, bufferMaxLines: 200, retentionDays: 3 },
      { enabled: true, maxPerGroup: 200, recallDays: 7, proactiveEnabled: true }],
  ]) {
    const config = read({ midtermMemory, episodicMemory })
    assert.deepEqual(config.midtermMemory, midtermMemory)
    assert.deepEqual(config.episodicMemory, episodicMemory)
  }
})

test('standalone conversation memory accepts only its declared boolean and bounded integer fields', t => {
  const { read } = fixture(t)
  const sections = {
    midtermMemory: { booleans: ['enabled'], integers: { minMessages: [4, 200], debounceMs: [5000, 3600000], maxSummaryChars: [120, 4000], bufferMaxLines: [50, 1000], retentionDays: [1, 30] } },
    episodicMemory: { booleans: ['enabled', 'proactiveEnabled'], integers: { maxPerGroup: [20, 1000], recallDays: [1, 30] } },
  }
  for (const [section, { booleans, integers }] of Object.entries(sections)) {
    for (const value of [null, false, [], 'enabled', 42, { unknown: 1 }, { apiKey: 'raw-secret' }, { model: 'main-model' }]) {
      assert.throws(() => read({ [section]: value }), error => !error.message.includes('raw-secret'))
    }
    for (const field of booleans) {
      for (const value of ['false', 0, 1, null, [], {}]) {
        assert.throws(() => read({ [section]: { [field]: value } }), new RegExp(`${section}\\.${field}`, 'u'))
      }
    }
    for (const [field, [minimum, maximum]] of Object.entries(integers)) {
      for (const value of [minimum - 1, maximum + 1, minimum + 0.5, String(minimum), null, true, [], {}, NaN, Infinity]) {
        assert.throws(() => read({ [section]: { [field]: value } }), new RegExp(`${section}\\.${field}`, 'u'))
      }
    }
  }
})

test('declared summary backend requires its own credentials even if summaries are disabled and supports credential-free migration preview', t => {
  const { read, backend } = fixture(t)
  const credentials = { TEST_MODEL_KEY: 'main-key' }
  assert.throws(() => read({ midtermSummary: backend }, { credentials }), /环境变量 TEST_SUMMARY_KEY 缺少模型 API Key/u)
  assert.throws(() => read({ midtermSummary: backend, midtermMemory: { enabled: false } }, { credentials }), /TEST_SUMMARY_KEY/u)
  assert.throws(() => read({ midtermSummary: {} }), /midtermSummary.baseUrl/u)
  const preview = read({ midtermSummary: backend }, { credentials: {}, options: { requireCredentials: false } })
  assert.equal(preview.midtermSummary.apiKey, '')
  assert.equal(preview.midtermSummary.model, 'conversation-summary')
  assert.equal(preview.execution.chatAiConfig.chatApiKey, '')
  const absent = read({}, { credentials: {}, options: { requireCredentials: false } })
  assert.equal(absent.midtermSummary, undefined)
})

test('summary backend accepts only baseUrl, name and apiKeyEnv and rejects unsafe endpoints without exposing their contents', t => {
  const { read, backend } = fixture(t)
  const preview = { credentials: {}, options: { requireCredentials: false } }
  for (const invalid of [null, false, [], 'summary', 42,
    { ...backend, apiKey: 'raw-summary-key' }, { ...backend, enabled: false },
    { ...backend, timeoutMs: 1000 }, { ...backend, maxTokens: 1000 },
    { ...backend, name: '' }, { ...backend, name: ' ' },
    { ...backend, apiKeyEnv: 'bad-name' }, { ...backend, apiKeyEnv: '' }, { ...backend, apiKeyEnv: 42 },
  ]) {
    assert.throws(() => read({ midtermSummary: invalid }), error => !error.message.includes('raw-summary-key'))
    assert.throws(() => read({ midtermSummary: invalid }, preview))
  }
  for (const baseUrl of ['file:///tmp/private-secret', 'not-a-url', 'https://user:private-secret@summary.example/v1',
    'https://summary.example/v1?api_key=private-secret', 'https://summary.example/v1#private-secret']) {
    assert.throws(() => read({ midtermSummary: { ...backend, baseUrl } }), error => !error.message.includes('private-secret'))
    assert.throws(() => read({ midtermSummary: { ...backend, baseUrl } }, preview))
  }
  const fixed = read({ midtermSummary: { ...backend, baseUrl: 'https://summary.example/custom/chat/completions' } })
  assert.equal(fixed.midtermSummary.apiUrl, 'https://summary.example/custom/chat/completions')
  assert.throws(() => read({ midtermSummary: { ...backend, apiKey: 'raw-summary-key' } }),
    /midtermSummary 仅支持 baseUrl、name 和 apiKeyEnv/u)
})
