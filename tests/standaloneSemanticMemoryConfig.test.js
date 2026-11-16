import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

const defaults = { enabled: false, retentionDays: 30, maxMessagesPerConversation: 1000, topK: 5, minScore: 0.35, timeoutMs: 1000 }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-semantic-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_MODEL_KEY: 'main-secret-value', TEST_EMBEDDING_KEY: 'embedding-secret-value', TEST_RERANK_KEY: 'rerank-secret-value' }
  const embedding = { baseUrl: 'https://embed.example/v1/embeddings', name: 'vector-fixture', apiKeyEnv: 'TEST_EMBEDDING_KEY' }
  const rerank = { baseUrl: 'https://rank.example/custom/rerank', name: 'rank-fixture', apiKeyEnv: 'TEST_RERANK_KEY' }
  function read(semanticMemory, { credentials = env, options } = {}) {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, instance: 'semantic-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(semanticMemory === undefined ? {} : { semanticMemory }),
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  return { read, embedding, rerank, env }
}

test('semantic configuration is explicitly disabled by default and supplies bounded defaults', t => {
  const { read } = fixture(t)
  assert.deepEqual(read().semanticMemory, defaults)
  assert.deepEqual(read({}).semanticMemory, defaults)
  assert.deepEqual(read({ enabled: false }).semanticMemory, defaults)
  assert.throws(() => read({ enabled: true }), /需要显式配置 embedding/u)
})

test('semantic enabled backends resolve only their explicit endpoints, models and credential references', t => {
  const { read, embedding, rerank, env } = fixture(t)
  const configured = read({ enabled: true, embedding, rerank }).semanticMemory
  assert.deepEqual(configured, { ...defaults, enabled: true,
    embedding: { ...embedding, apiKey: env.TEST_EMBEDDING_KEY }, rerank: { ...rerank, apiKey: env.TEST_RERANK_KEY } })
  const onlyEmbedding = read({ enabled: true, embedding }).semanticMemory
  assert.equal(onlyEmbedding.rerank, undefined)
  assert.equal(Object.hasOwn(onlyEmbedding, 'rerank'), false)
  assert.throws(() => read({ enabled: true, embedding }, { credentials: { TEST_MODEL_KEY: 'main-secret-value' } }), /TEST_EMBEDDING_KEY/u)
  assert.throws(() => read({ enabled: true, embedding, rerank }, { credentials: { TEST_MODEL_KEY: 'main', TEST_EMBEDDING_KEY: 'embed' } }), /TEST_RERANK_KEY/u)
  const sharedExplicit = read({ enabled: true, embedding, rerank: { ...rerank, apiKeyEnv: embedding.apiKeyEnv } }).semanticMemory
  assert.equal(sharedExplicit.rerank.apiKey, sharedExplicit.embedding.apiKey)
})

test('disabled semantic configuration does not read credentials and preview tolerates missing values', t => {
  const { read, embedding, rerank } = fixture(t)
  let semanticCredentialReads = 0
  const credentials = { TEST_MODEL_KEY: 'main-secret-value', get TEST_EMBEDDING_KEY() { semanticCredentialReads++; throw new Error('unexpected credential read') },
    get TEST_RERANK_KEY() { semanticCredentialReads++; throw new Error('unexpected credential read') } }
  assert.deepEqual(read({ embedding, rerank }, { credentials }).semanticMemory,
    { ...defaults, embedding: { ...embedding, apiKey: '' }, rerank: { ...rerank, apiKey: '' } })
  assert.equal(semanticCredentialReads, 0)
  const preview = read({ enabled: true, embedding, rerank }, { credentials: {}, options: { requireCredentials: false } }).semanticMemory
  assert.equal(preview.enabled, true)
  assert.equal(preview.embedding.apiKey, '')
  assert.equal(preview.rerank.apiKey, '')
})

test('semantic settings validate every numeric boundary without string or null coercion', t => {
  const { read } = fixture(t)
  const ranges = { retentionDays: [1, 90], maxMessagesPerConversation: [50, 2000], topK: [1, 10], timeoutMs: [200, 5000] }
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    for (const value of [minimum, maximum]) assert.equal(read({ [key]: value }).semanticMemory[key], value)
    for (const value of [minimum - 1, maximum + 1, minimum + 0.5, String(minimum), null, true]) assert.throws(() => read({ [key]: value }))
  }
  for (const value of [0, 1, 0.1234]) assert.equal(read({ minScore: value }).semanticMemory.minScore, value)
  for (const value of [-0.01, 1.01, '0.35', null, true]) assert.throws(() => read({ minScore: value }))
})

test('semantic section and backend declarations reject unsupported shape even while disabled or previewing', t => {
  const { read, embedding, rerank } = fixture(t)
  for (const config of [null, false, [], 'enabled', { enabled: 1 }, { apiKey: 'private-value' },
    { embedding: null }, { embedding: [] }, { embedding: {} }, { rerank: false },
    { embedding: { ...embedding, apiKey: 'private-value' } }, { rerank: { ...rerank, enabled: false } },
    { embedding: { ...embedding, name: '' } }, { embedding: { ...embedding, name: 'name\nvalue' } },
    { embedding: { ...embedding, apiKeyEnv: 'bad-name' } }, { rerank: { ...rerank, apiKeyEnv: 42 } },
  ]) {
    assert.throws(() => read(config), error => !error.message.includes('private-value'))
    assert.throws(() => read(config, { credentials: {}, options: { requireCredentials: false } }))
  }
})

test('semantic endpoints must name their exact operation without URL derivation or credential components', t => {
  const { read, embedding, rerank } = fixture(t)
  for (const [operation, backend] of [['embedding', embedding], ['rerank', rerank]]) {
    const other = operation === 'embedding' ? '/rerank' : '/embeddings'
    for (const baseUrl of ['not-a-url', 'file:///tmp/embeddings', 'https://service.example/v1',
      `https://service.example${other}`, `${backend.baseUrl}/`, `${backend.baseUrl}?api_key=private-value`, `${backend.baseUrl}#private-value`,
      backend.baseUrl.replace('https://', 'https://user:private-value@'), ` ${backend.baseUrl}`, backend.baseUrl.replace('https://', 'https:\\'),
    ]) {
      assert.throws(() => read({ [operation]: { ...backend, baseUrl } }), error => !error.message.includes('private-value'))
      assert.throws(() => read({ [operation]: { ...backend, baseUrl } }, { credentials: {}, options: { requireCredentials: false } }))
    }
  }
})
