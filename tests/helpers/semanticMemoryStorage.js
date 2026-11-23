import assert from 'node:assert/strict'
import { importBilibiliHost as load } from './bilibiliQualitySource.mjs'

const { semanticVectorSourceDigest, unpackSemanticVector } = await load('modules/memory/infrastructure/agentSemanticVectorStorage.js')

/** Inspect physical rows and vector fields even when a cleanup fence hides them from the store. */
export async function readPersistedSemanticState(reader, prefix, id) {
  const root = prefix + 'agent:semantic-memory:v1:'
  const [source, vectors, revision] = await reader.multi().get(root + 'state:' + id)
    .hGetAll(root + 'vectors:' + id).get(root + 'vector-revision:' + id).exec()
  const entries = Object.entries(vectors)
  assert.equal(entries.length > 0, revision !== null)
  if (source === null) {
    assert.equal(entries.length, 0)
    return undefined
  }
  const state = JSON.parse(source)
  const rows = new Map(state.rows.map(row => [row.messageId, row]))
  for (const [messageId, packed] of entries) {
    const row = rows.get(messageId)
    const entry = unpackSemanticVector(packed)
    assert.ok(row && entry)
    assert.equal(entry.sourceDigest, semanticVectorSourceDigest(row))
    assert.equal(row.vector, undefined)
    row.vector = entry.vector
    row.providerId = entry.providerId
  }
  return state
}
