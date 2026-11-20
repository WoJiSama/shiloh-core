import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { runAgentSemanticEvaluation, parseAgentSemanticEvaluationDataset, createSyntheticSemanticEvaluationBackend } = await load('modules/memory/infrastructure/agentSemanticEvaluation.js')
const { agentSemanticMemoryId } = await load('modules/memory/infrastructure/agentSemanticMemoryStore.js')
const dataset = JSON.parse(await fs.readFile(new URL('./fixtures/semantic-retrieval-benchmark.v2.json', import.meta.url), 'utf8'))
const metadata = { kind: 'synthetic', embedding: { model: 'test-fixed-vectors', endpoint: 'local' }, revision: 'test-v2' }
const run = (data, extra = {}) => runAgentSemanticEvaluation(data, { createBackend: createSyntheticSemanticEvaluationBackend, backendMetadata: metadata, ...extra })
const small = () => {
  const data = structuredClone(dataset)
  data.queries = data.queries.filter(query => ['meeting-multiple-evidence', 'no-answer-empty', 'private-self'].includes(query.id))
  return data
}

test('fixed Core benchmark measures each mode, final evidence and immutable state, without sending forbidden corpus to providers', async () => {
  const calls = []
  const report = await run(dataset, { createBackend() {
    const backend = createSyntheticSemanticEvaluationBackend()
    return { ...backend, async embed(texts, context) { calls.push(...texts); return backend.embed(texts, context) } }
  } })
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.runtime, 'core')
  assert.equal(report.evidence, 'deterministic-regression-only')
  assert.equal(report.trials.length, dataset.queries.length * 5)
  assert.equal(report.storageUnchanged, true)
  assert.equal(report.timingScope, 'read-and-revalidate')
  assert.match(report.dataset.hash, /^[a-f0-9]{64}$/)
  assert.match(report.preparation.corpusHash, /^[a-f0-9]{64}$/)
  for (const text of dataset.scopes.flatMap(scope => scope.rows.filter(row => row.recalled || row.revoked || row.forgotten || row.disabled).map(row => row.text))) assert.equal(calls.includes(text), false)
  for (const mode of Object.values(report.modes)) {
    assert.equal(mode.samples, dataset.queries.length)
    assert.equal(mode.errors, 0)
    assert.equal(mode.timeouts, 0)
    assert.equal(mode.forbiddenSourceRate, 0)
    assert.ok(mode.latencyP95Ms >= mode.latencyP50Ms)
  }
  assert.ok(report.trials.every(trial => trial.storageUnchanged && trial.stateHashBefore === trial.stateHashAfter && trial.trace))
  const empty = report.trials.filter(trial => trial.queryId === 'no-answer-empty')
  assert.ok(empty.every(trial => trial.status === 'ok' && trial.contextEmpty && trial.reason === 'no-authorized-evidence'))
  const sourceIds = report.trials.find(trial => trial.mode === 'production' && trial.queryId === 'private-authorized-self-history').trace.authorized
  const main = dataset.scopes.find(scope => scope.id === 'main')
  assert.ok(sourceIds.some(source => source.scopeId === agentSemanticMemoryId(main) && source.messageId === 'budget'))
  assert.equal(sourceIds.some(source => source.messageId === 'disabled'), false)
})

test('provider exceptions remain in positive and no-answer denominators, with independent client disposal', async () => {
  const data = small()
  data.queries = data.queries.filter(query => query.id !== 'no-answer-empty')
  const negative = structuredClone(data.queries[0]); negative.id = 'failure-no-answer'; negative.relevant = []; data.queries.push(negative)
  let factories = 0, disposed = 0
  const report = await run(data, { modes: ['production'], createBackend() {
    factories++
    const backend = createSyntheticSemanticEvaluationBackend(), preparation = factories === 1
    return { ...backend, async embed(texts, context) { if (!preparation) throw new Error('simulated provider failure'); return backend.embed(texts, context) }, dispose() { disposed++ } }
  } })
  assert.equal(report.trials.length, 3)
  assert.equal(report.modes.production.samples, 3)
  assert.equal(report.modes.production.answerableSamples, 2)
  assert.equal(report.modes.production.noAnswerSamples, 1)
  assert.equal(report.modes.production.errors, 3)
  assert.equal(report.modes.production.hitAt5, 0)
  assert.equal(report.modes.production.contextEvidenceRecall, 0)
  assert.equal(report.modes.production.noAnswerCorrectRate, 0)
  assert.equal(disposed, factories)
})

test('true timeout is reported and a stalled backend cannot make the offline run disappear', async () => {
  const data = small(); data.queries = data.queries.slice(0, 1); data.profiles.production.timeoutMs = 200
  let factories = 0
  const report = await run(data, { modes: ['production'], createBackend() {
    factories++
    const backend = createSyntheticSemanticEvaluationBackend(), preparation = factories === 1
    return { ...backend, async embed(texts, context) { return preparation ? backend.embed(texts, context) : new Promise(() => {}) } }
  } })
  assert.equal(report.modes.production.timeouts, 1)
  assert.equal(report.modes.production.hitAt5, 0)
  assert.equal(report.trials[0].status, 'timeout')
  assert.ok(report.trials[0].elapsedMs >= 180 && report.trials[0].elapsedMs < 1500)
})

test('warm-client trials explicitly separate warmup, keep all cases, and never reuse clients across modes', async () => {
  const data = small(); data.queries = data.queries.slice(0, 1)
  const counts = []
  const report = await run(data, { modes: ['hybrid', 'production'], cache: 'warm-client', createBackend() {
    const index = counts.push(0) - 1, backend = createSyntheticSemanticEvaluationBackend()
    return { ...backend, async embed(texts, context) { counts[index]++; return backend.embed(texts, context) } }
  } })
  assert.equal(report.cache.mode, 'warm-client')
  assert.equal(report.cache.serverCache, 'uncontrolled')
  assert.equal(counts.length, 3)
  assert.deepEqual(counts.slice(1), [2, 2])
  assert.ok(report.trials.every(trial => trial.warmupMs > 0 && trial.elapsedMs > 0))
})

test('partial evidence under the actual 5000 character projection is excluded from full context recall', async () => {
  const data = small(), scope = data.scopes.find(scope => scope.id === 'main')
  data.scopes = [scope]
  scope.rows = Array.from({ length: 6 }, (_, index) => ({ messageId: `long-${index}`, authorId: 'alice', name: 'alice', text: `shared ${index} ` + 'x'.repeat(1450), at: data.clockAt - 1000 }))
  data.queries = [{ id: 'long-projection', scope: 'main', query: 'shared', relevant: scope.rows.map(row => ({ scope: 'main', messageId: row.messageId })), forbidden: [] }]
  data.profiles.production.topK = 6
  const report = await run(data, { modes: ['production'] })
  const trial = report.trials[0]
  assert.equal(trial.trace.selected.length, 6)
  assert.equal(report.modes.production.evidenceRecallAt10, 1)
  assert.ok(report.modes.production.contextEvidenceRecall < 1)
  assert.equal(report.modes.production.completeContextRate, 0)
  assert.ok(trial.trace.projected.some(source => !source.complete))
})

test('dataset validation rejects broken evidence and duplicates before creating any provider', async () => {
  const data = small(); data.queries[0].relevant.push({ scope: 'missing', messageId: 'missing' })
  let calls = 0
  await assert.rejects(() => run(data, { createBackend() { calls++; return createSyntheticSemanticEvaluationBackend() } }), /evidence reference/)
  assert.equal(calls, 0)
  const duplicate = small(); duplicate.queries.push(structuredClone(duplicate.queries[0]))
  assert.throws(() => parseAgentSemanticEvaluationDataset(duplicate), /query/)
  const duplicateSource = small(), ref = duplicateSource.queries[0].relevant[0]
  duplicateSource.queries[0].relevant.push({ messageId: ref.messageId, scope: ref.scope })
  assert.throws(() => parseAgentSemanticEvaluationDataset(duplicateSource), /duplicate evidence/)
})

test('corpus message limits match production before preparing vectors or scoring recall', async () => {
  const data = small(), scope = data.scopes.find(scope => scope.id === 'main')
  data.scopes = [scope]
  scope.rows = Array.from({ length: 51 }, (_, index) => ({ messageId: `bounded-${index}`, authorId: 'alice', name: 'alice',
    text: index === 0 ? 'ancient unique observatory' : `retained garden ${index}`, at: data.clockAt - 1000 + index }))
  data.profiles.production.maxMessagesPerConversation = 50
  data.profiles.comparison.maxMessagesPerConversation = 50
  data.queries = [{ id: 'evicted-source', scope: 'main', query: 'ancient unique observatory',
    relevant: [{ scope: 'main', messageId: 'bounded-0' }], forbidden: [] }]
  const calls = []
  const report = await run(data, { modes: ['bm25'], createBackend() {
    const backend = createSyntheticSemanticEvaluationBackend()
    return { ...backend, async embed(texts, context) { calls.push(...texts); return backend.embed(texts, context) } }
  } })
  assert.equal(report.preparation.preparedSources, 50)
  assert.equal(calls.includes('ancient unique observatory'), false)
  assert.equal(report.trials[0].trace.authorized.some(source => source.messageId === 'bounded-0'), false)
  assert.equal(report.modes.bm25.hitAt5, 0)
  assert.equal(report.metricScope, 'selected-topK-and-complete-projection')
  assert.equal(report.modes.bm25.effectiveTopK, data.profiles.comparison.topK)
})

test('setup failures stay in quality denominators without inventing zero millisecond reads', async () => {
  const data = small(); data.queries = data.queries.slice(0, 1)
  let factories = 0
  const report = await run(data, { modes: ['production'], createBackend() {
    if (++factories > 1) throw new Error('client creation failed')
    return createSyntheticSemanticEvaluationBackend()
  } })
  assert.equal(report.modes.production.errors, 1)
  assert.equal(report.modes.production.answerableSamples, 1)
  assert.equal(report.modes.production.hitAt5, 0)
  assert.equal(report.modes.production.latencySamples, 0)
  assert.equal(report.modes.production.latencyP50Ms, null)
  assert.equal(report.trials[0].elapsedMs, null)
})

test('CLI help and old flags never load private plugin configuration or providers', () => {
  const help = spawnSync(process.execPath, ['scripts/semantic-memory-eval.mjs', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /isolated-client/)
  assert.match(help.stdout, /Synthetic results/)
  const legacy = spawnSync(process.execPath, ['scripts/semantic-memory-eval.mjs', '--rebuild'], { encoding: 'utf8' })
  assert.equal(legacy.status, 1)
  assert.match(legacy.stderr, /retired/)
  assert.doesNotMatch(legacy.stderr, /未找到 semanticMemory 配置/)
})
