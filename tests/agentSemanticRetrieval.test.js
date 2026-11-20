import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { rankAgentSemanticEvidence } = await load('modules/memory/infrastructure/agentSemanticRetrieval.js')

const providerId = 'a'.repeat(64)
const source = (id, text, vector) => ({ id, row: { messageId: id, authorId: 'author', name: '', text, at: 1, vector, providerId } })

test('pure vector retrieves evidence omitted by the hybrid candidate cutoff', () => {
  const evidence = [source('semantic-target', 'a separate astronomical observation', [1, 0]),
    ...Array.from({ length: 35 }, (_, index) => source(`lexical-${index}`, 'orchard apple orchard', [0.8, 0.6]))]
  const hybrid = rankAgentSemanticEvidence(evidence, 'orchard', [1, 0], providerId, 0.35, 'hybrid')
  const vector = rankAgentSemanticEvidence(evidence, 'orchard', [1, 0], providerId, 0.35, 'vector')
  assert.equal(hybrid.some(hit => hit.chunk.id === 'semantic-target'), false)
  assert.equal(vector[0].chunk.id, 'semantic-target')
})

test('BM25 compares the full authorized corpus independently of the vector pool and dimension', () => {
  const evidence = [source('keyword-target', 'uncommon orchard evidence', [0, 1, 0]),
    ...Array.from({ length: 35 }, (_, index) => source(`vector-${index}`, 'astronomical observation', [1, 0]))]
  const vector = rankAgentSemanticEvidence(evidence, 'uncommon orchard', [1, 0], providerId, 0.35, 'vector')
  const bm25 = rankAgentSemanticEvidence(evidence, 'uncommon orchard', undefined, providerId, 0.35, 'bm25')
  assert.equal(vector.some(hit => hit.chunk.id === 'keyword-target'), false)
  assert.deepEqual(bm25.map(hit => hit.chunk.id), ['keyword-target'])
})

test('pure vector applies the cosine threshold before fusion can clamp negative scores', () => {
  const evidence = [source('opposite', 'unrelated', [-1, 0]), source('relevant', 'evidence', [1, 0])]
  const hits = rankAgentSemanticEvidence(evidence, 'evidence', [1, 0], providerId, 0, 'vector')
  assert.deepEqual(hits.map(hit => hit.chunk.id), ['relevant'])
})
