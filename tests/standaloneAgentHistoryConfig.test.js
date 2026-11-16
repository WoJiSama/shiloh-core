import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

const defaults = { enabled: false, retentionDays: 30, maxMessagesPerConversation: 1000, timeoutMs: 5000 }

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  function read(history, { credentials = { TEST_MODEL_KEY: 'main-secret-value' }, options } = {}) {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, instance: 'history-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(history === undefined ? {} : { history }),
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read }
}

test('history is opt-in and supplies bounded defaults', t => {
  const { read } = fixture(t)
  assert.deepEqual(read().history, defaults)
  assert.deepEqual(read({}).history, defaults)
  assert.deepEqual(read({ enabled: false }).history, defaults)
  assert.deepEqual(read({ enabled: true }).history, { ...defaults, enabled: true })
})

test('enabled history requires no vector backend or additional credential reads', t => {
  const { read } = fixture(t)
  const credentialReads = []
  const credentials = new Proxy({ TEST_MODEL_KEY: 'main-secret-value' }, {
    get(target, key) {
      credentialReads.push(key)
      assert.ok(['TEST_MODEL_KEY', 'BL_AGENT_REDIS_URL'].includes(key), `unexpected credential read: ${String(key)}`)
      return Reflect.get(target, key)
    },
  })
  const configured = read({ enabled: true }, { credentials })
  assert.deepEqual(configured.history, { ...defaults, enabled: true })
  assert.equal(configured.semanticMemory.enabled, false)
  assert.equal(Object.hasOwn(configured.semanticMemory, 'embedding'), false)
  assert.equal(Object.hasOwn(configured.semanticMemory, 'rerank'), false)
  assert.deepEqual(credentialReads, ['TEST_MODEL_KEY', 'BL_AGENT_REDIS_URL'])
})

test('history preview works without credentials or vector configuration', t => {
  const { read } = fixture(t)
  const configured = read({ enabled: true }, { credentials: {}, options: { requireCredentials: false } })
  assert.deepEqual(configured.history, { ...defaults, enabled: true })
  assert.equal(configured.semanticMemory.enabled, false)
  assert.equal(Object.hasOwn(configured.semanticMemory, 'embedding'), false)
})

test('history settings enforce every integer boundary without coercion', t => {
  const { read } = fixture(t)
  const ranges = { retentionDays: [1, 90], maxMessagesPerConversation: [50, 2000], timeoutMs: [100, 30_000] }
  for (const enabled of [false, true]) {
    for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
      for (const value of [minimum, maximum]) assert.equal(read({ enabled, [key]: value }).history[key], value)
      for (const value of [minimum - 1, maximum + 1, minimum + 0.5, String(minimum), null, true]) {
        assert.throws(() => read({ enabled, [key]: value }), new RegExp(`history\\.${key}`, 'u'))
      }
    }
  }
})

test('history rejects invalid section shapes and non-boolean switches', t => {
  const { read } = fixture(t)
  for (const history of [null, false, true, [], 'enabled', 1, { enabled: null }, { enabled: 1 }, { enabled: 'true' }]) {
    assert.throws(() => read(history))
    assert.throws(() => read(history, { credentials: {}, options: { requireCredentials: false } }))
  }
})

test('history whitelist excludes backend declarations, credentials and unrelated options', t => {
  const { read } = fixture(t)
  for (const key of ['embedding', 'rerank', 'backend', 'baseUrl', 'endpoint', 'apiKey', 'apiKeyEnv', 'topK', 'minScore']) {
    for (const enabled of [false, true]) {
      const history = { enabled, [key]: 'private-value' }
      assert.throws(() => read(history), error => /history/u.test(error.message) && !error.message.includes('private-value'))
      assert.throws(() => read(history, { credentials: {}, options: { requireCredentials: false } }), /history/u)
    }
  }
})
