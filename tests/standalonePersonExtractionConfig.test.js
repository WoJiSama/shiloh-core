import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { defaultSimRuntimeConfig } from '../dist/backend/modules/simulation/domain/simConfig.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-person-extraction-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_MODEL_KEY: 'main-key', TEST_EXTRACTION_KEY: 'extraction-key' }
  const backend = { baseUrl: 'https://memory.example/v1', name: 'person-extractor', apiKeyEnv: 'TEST_EXTRACTION_KEY' }
  function read(personMemoryExtraction, { simulation, memorySystem, credentials = env, options } = {}) {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, instance: 'person-extraction-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(personMemoryExtraction === undefined ? {} : { personMemoryExtraction }),
      ...(simulation === undefined ? {} : { simulation }),
      ...(memorySystem === undefined ? {} : { memorySystem }),
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read, backend, env }
}

test('standalone person extraction requires an explicit backend and preserves the existing feature switch', t => {
  const { read, backend } = fixture(t)
  const absent = read()
  assert.equal(absent.personMemoryExtraction, undefined)
  assert.equal(Object.hasOwn(absent, 'personMemoryExtraction'), false)
  assert.equal(defaultSimRuntimeConfig(absent.simulation).personProfile.enabled, true)
  assert.equal(read(undefined, { simulation: { personProfile: { enabled: true } } }).personMemoryExtraction, undefined)
  const configured = read(backend)
  assert.deepEqual(configured.personMemoryExtraction, {
    apiUrl: 'https://memory.example/v1', model: 'person-extractor', apiKey: 'extraction-key', apiKeyEnv: 'TEST_EXTRACTION_KEY',
  })
  assert.equal(configured.execution.chatAiConfig.chatApiModel, 'main-model')
  assert.equal(configured.execution.chatAiConfig.chatApiKey, 'main-key')
  const disabled = read(backend, { simulation: { personProfile: { enabled: false } } })
  assert.equal(defaultSimRuntimeConfig(disabled.simulation).personProfile.enabled, false)
  assert.equal(disabled.personMemoryExtraction.model, 'person-extractor')
})

test('text person learning preserves the disabled default and validates its independent batching settings', t => {
  const { read, backend } = fixture(t)
  assert.deepEqual(read(backend).memorySystem, {})
  const settings = { enabled: true, userExtractDebounceSeconds: 90, userExtractMaxBatchMessages: 6 }
  assert.deepEqual(read(backend, { memorySystem: settings }).memorySystem, settings)
  assert.deepEqual(read(undefined, { memorySystem: { enabled: true } }).memorySystem, { enabled: true })
  assert.equal(read(undefined, { memorySystem: { enabled: true } }).personMemoryExtraction, undefined)
  for (const memorySystem of [null, false, [], 'yes', { enabled: 1 }, { enabled: true, apiKey: 'secret' },
    { userExtractDebounceSeconds: -1 }, { userExtractDebounceSeconds: 3601 }, { userExtractDebounceSeconds: 1.1 },
    { userExtractMaxBatchMessages: 0 }, { userExtractMaxBatchMessages: 41 }, { userExtractMaxBatchMessages: '6' }]) {
    assert.throws(() => read(backend, { memorySystem }))
  }
  assert.deepEqual(read(backend, { memorySystem: { userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 40 } }).memorySystem,
    { userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 40 })
})

test('declared person extraction validates its credentials without falling back to the main backend', t => {
  const { read, backend } = fixture(t)
  const mainOnly = { TEST_MODEL_KEY: 'main-key' }
  assert.throws(() => read(backend, { credentials: mainOnly }), /环境变量 TEST_EXTRACTION_KEY 缺少模型 API Key/u)
  assert.throws(() => read(backend, { credentials: mainOnly, simulation: { personProfile: { enabled: false } } }), /TEST_EXTRACTION_KEY/u)
  assert.throws(() => read({}), /personMemoryExtraction.baseUrl/u)
  const preview = read(backend, { credentials: {}, options: { requireCredentials: false } })
  assert.equal(preview.personMemoryExtraction.apiKey, '')
  assert.equal(preview.personMemoryExtraction.model, 'person-extractor')
  assert.equal(preview.execution.chatAiConfig.chatApiKey, '')
  assert.equal(read(undefined, { credentials: {}, options: { requireCredentials: false } }).personMemoryExtraction, undefined)
})

test('person extraction accepts only three explicit model fields and validates migration preview format', t => {
  const { read, backend } = fixture(t)
  const preview = { credentials: {}, options: { requireCredentials: false } }
  for (const invalid of [null, false, [], 'memory', 42,
    { ...backend, apiKey: 'raw-extraction-key' }, { ...backend, enabled: false },
    { ...backend, timeoutMs: 5000 }, { ...backend, name: '' },
    { ...backend, name: ' ' }, { ...backend, apiKeyEnv: 'bad-name' },
    { ...backend, apiKeyEnv: '' }, { ...backend, apiKeyEnv: 42 },
  ]) {
    assert.throws(() => read(invalid))
    assert.throws(() => read(invalid, preview))
  }
  for (const baseUrl of ['file:///tmp/key', 'not-a-url', 'https://user:password@memory.example/v1',
    'https://memory.example/v1?api_key=value', 'https://memory.example/v1#fragment']) {
    assert.throws(() => read({ ...backend, baseUrl }), error => !error.message.includes('password'))
    assert.throws(() => read({ ...backend, baseUrl }, preview))
  }
  assert.throws(() => read({ ...backend, apiKey: 'raw-extraction-key' }), error =>
    /personMemoryExtraction 仅支持 baseUrl、name 和 apiKeyEnv/u.test(error.message) && !error.message.includes('raw-extraction-key'))
})
