import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { readStandaloneLocalEmojiConfig: read } = await load('bootstrap/standaloneLocalEmoji.js')
const model = { baseUrl: 'https://model.example/v1', name: 'test-model', apiKeyEnv: 'EMOJI_TEST_KEY' }
const input = { enabled: true, config: { maxItems: 600, sendAsSticker: true, doReplace: true }, analysis: model,
  embedding: { ...model, baseUrl: 'https://model.example/v1/embeddings' }, tools: model }
test('standalone emoji configuration is opt-in, closed and resolves only explicit credentials', () => {
  assert.deepEqual(read(undefined, {}, true), { enabled: false, config: {} })
  const value = read(input, { EMOJI_TEST_KEY: 'test-credential-value' }, true)
  assert.equal(value.enabled, true); assert.equal(value.config.maxItems, 600)
  assert.equal(value.analysis.apiKey, 'test-credential-value')
  assert.equal(value.embedding.baseUrl, 'https://model.example/v1/embeddings')
  assert.equal(value.tools.model, 'test-model')
  assert.throws(() => read(input, {}, true), /EMOJI_TEST_KEY/u)
  assert.equal(read(input, {}, false).analysis.apiKey, '')
  input.config.maxItems = 599
  assert.equal(value.config.maxItems, 600); input.config.maxItems = 600
})
test('standalone emoji rejects legacy paths, implicit model fallback and malformed settings', () => {
  for (const bad of [{ ...input, url: 'https://other.example' }, { enabled: true },
    { ...input, config: { dbPath: '/etc/passwd' } }, { ...input, config: { storeDir: 'plugins/old' } },
    { ...input, config: { maxItems: 0 } }, { ...input, config: { useEmbedding: 'yes' } },
    { ...input, config: { embeddingThreshold: 1.01 } }, { ...input, config: { followUpDelayMinMs: 5000 } },
    { ...input, analysis: { ...model, apiKey: 'inline-secret' } },
    { ...input, analysis: { ...model, baseUrl: 'https://user:password@host.example/v1' } },
    { ...input, analysis: { ...model, baseUrl: 'https://host.example/v1?token=secret' } },
    { ...input, embedding: { ...model } }]) assert.throws(() => read(bad, { EMOJI_TEST_KEY: 'present' }, true))
})
