import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, link, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { runCognitionImportCli } from '../scripts/import-cognition.mjs'

const domain = await load('modules/memory/domain/cognitionState.js')
const importer = await load('modules/memory/infrastructure/cognitionImport.js')
const { createCognitionStore } = await load('modules/memory/infrastructure/cognitionStore.js')
const { createEmptyCognitionState, invalidateCognitionState, recordCognitionSources, validateCognitionState } = domain
const { previewCognitionImport, applyCognitionImport } = importer
const agentId = 'shiloh', at = 1_800_000_000_000
const scope = { botId: 'old-bot', personaId: 'old-persona', groupId: 'old-room' }
const scene = { account: { platform: 'qq', namespace: 'global', id: 'bot-a' }, kind: 'group', id: 'room-a' }
const guard = { isCurrent: () => true }
function snapshot(overrides = {}) {
  return { schemaVersion: 1, agentId,
    mappings: [{ legacy: scope, agentId, conversation: scene, verified: true }],
    sources: [{ scope, ref: 'message:1', kind: 'message', nativeId: 'real-message-1', authorId: 'real-user-a', occurredAt: at,
      content: '我想下次试试这个游戏', revision: 1, participantIds: ['real-user-a'], status: 'active' }],
    memories: [{ scope, id: 'm1', kind: 'interest', content: '群友提到想试玩这个游戏', epistemic: 'reported', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at }],
    invalidations: [], ...overrides }
}
function receiptSource(status, overrides = {}) {
  return { scope, ref: 'receipt:r1', kind: 'receipt', nativeId: 'receipt:r1', authorId: scene.account.id,
    occurredAt: at, content: JSON.stringify({ toolName: 'search', status, summary: '真实工具回执', goalId: null }),
    revision: 1, participantIds: [], status: 'active', receiptStatus: status, ...overrides }
}
function storeFixture() {
  const kv = new Map(), control = { commits: 0, failWrite: false, beforeCommit: undefined }
  const redis = {
    async get(key) { return kv.get(key) ?? null },
    async set() { throw new Error('CAS required') },
    async eval(_script, { keys: [key], arguments: [exists, previous, mode, next] }) {
      await control.beforeCommit?.(key)
      if (exists === '0' ? kv.has(key) : kv.get(key) !== previous) return 0
      if (mode === 'set') {
        if (control.failWrite) throw new Error('write failed')
        kv.set(key, next); control.commits++
      }
      return 1
    },
  }
  return { kv, control, redis, store: createCognitionStore(redis) }
}
const apply = (store, input, revision = 0) => applyCognitionImport(store, input, { previewHash: previewCognitionImport(input).previewHash, expectedRevision: revision, guard })

test('preview is deterministic and read-only; one CAS imports scene evidence and correction history', async () => {
  const input = snapshot(), original = structuredClone(input), empty = createEmptyCognitionState(agentId)
  input.memories.push({ ...input.memories[0], id: 'm2', content: '后来决定先不玩', supersedes: 'm1', updatedAt: at + 1 })
  const preview = previewCognitionImport(input, empty)
  assert.equal(preview.applicable, true)
  assert.equal(preview.counts.plannedSources, 1)
  assert.equal(preview.counts.plannedNodes, 2)
  assert.equal(preview.skipped.length, 0)
  assert.equal(preview.nodes[0].status, 'superseded')
  assert.equal(preview.nodes[1].supersedes, preview.nodes[0].id)
  for (const node of preview.nodes) { assert.equal(node.audience, 'scene'); assert.deepEqual(node.conversation, scene) }
  assert.deepEqual(empty, createEmptyCognitionState(agentId))
  assert.deepEqual(input.sources, original.sources)
  const reordered = Object.fromEntries(Object.entries(input).reverse())
  assert.equal(previewCognitionImport(reordered).previewHash, preview.previewHash)
  const f = storeFixture(), state = await apply(f.store, input)
  assert.equal(state.revision, 1); assert.equal(f.control.commits, 1)
  assert.equal(state.nodes.length, 2); assert.equal(state.processed.length, 1)
  validateCognitionState(state)
})

test('missing, unverified, duplicate or cross-agent mappings cannot merge bot identities', () => {
  for (const mappings of [[], [{ legacy: scope, agentId, conversation: scene, verified: false }],
    [snapshot().mappings[0], snapshot().mappings[0]], [{ ...snapshot().mappings[0], agentId: 'other-bot' }]]) {
    const preview = previewCognitionImport(snapshot({ mappings }))
    assert.equal(preview.nodes.length, 0); assert.equal(preview.sources.length, 0)
    assert.ok(preview.skipped.some(skip => skip.collection === 'memories' && /mapping/u.test(skip.reason)))
  }
  const input = snapshot(), other = { ...scope, botId: 'different-old-bot' }
  input.sources.push({ ...input.sources[0], scope: other })
  input.memories.push({ ...input.memories[0], scope: other })
  const preview = previewCognitionImport(input)
  assert.equal(preview.sources.length, 1); assert.equal(preview.nodes.length, 1)
  assert.ok(preview.skipped.some(skip => skip.reason === 'missing-legacy-mapping'))
})

test('missing author/time/native evidence, global notes and ambiguous refs are skipped explicitly', () => {
  for (const override of [{ authorId: '' }, { occurredAt: 0 }, { nativeId: '' }, { ref: 'message:0' }]) {
    const input = snapshot(); Object.assign(input.sources[0], override)
    const preview = previewCognitionImport(input)
    assert.equal(preview.nodes.length, 0)
    assert.ok(preview.skipped.some(skip => skip.reason === 'missing-or-invalid-source-evidence'))
  }
  const input = snapshot(); input.sources.push({ ...input.sources[0], nativeId: 'conflicting-native-id' })
  input.memories.push({ ...input.memories[0], id: 'global', scope: { ...scope, groupId: '' }, evidenceRefs: [] })
  const preview = previewCognitionImport(input)
  assert.equal(preview.nodes.length, 0)
  assert.ok(preview.skipped.some(skip => skip.reason === 'ambiguous-source-reference'))
  assert.ok(preview.skipped.some(skip => skip.id === 'global' && skip.reason === 'invalid-memory'))
})

test('partial missing, revoked or stale evidence rejects the entire memory', () => {
  const input = snapshot()
  input.sources.push({ ...input.sources[0], ref: 'message:2', nativeId: 'real-message-2', status: 'revoked', content: '' })
  input.memories[0].evidenceRefs.push('message:2')
  const preview = previewCognitionImport(input)
  assert.equal(preview.nodes.length, 0)
  assert.equal(preview.sources.find(source => source.nativeId === 'real-message-2').status, 'revoked')
  assert.ok(preview.skipped.some(skip => skip.reason === 'unresolved-or-revoked-evidence'))
  const missing = snapshot(); missing.memories[0].evidenceRefs.push('message:999')
  assert.equal(previewCognitionImport(missing).nodes.length, 0)
  const clean = snapshot(), source = previewCognitionImport(clean).sources[0]
  const current = recordCognitionSources(createEmptyCognitionState(agentId), [{ ...source, revision: 2, content: '更新后的原文' }])
  const stale = previewCognitionImport(clean, current)
  assert.equal(stale.nodes.length, 0)
  assert.ok(stale.skipped.some(skip => skip.reason === 'stale-source-revision'))
})

test('observed history requires succeeded receipt and cannot upgrade a message or pending outcome', () => {
  const input = snapshot(); input.memories[0].epistemic = 'observed'
  assert.ok(previewCognitionImport(input).skipped.some(skip => skip.reason === 'observed-memory-requires-succeeded-receipt'))
  for (const receiptStatus of ['pending', 'unknown', 'failed']) {
    const candidate = structuredClone(input)
    candidate.sources.push(receiptSource(receiptStatus))
    candidate.memories[0].evidenceRefs.push('receipt:r1')
    assert.equal(previewCognitionImport(candidate).nodes.length, 0)
  }
  input.sources.push(receiptSource('succeeded'))
  input.memories[0].evidenceRefs.push('receipt:r1')
  assert.equal(previewCognitionImport(input).nodes.length, 1)
})

test('receipt evidence is structured, bot-authored and consistent with its actual outcome', () => {
  for (const override of [
    { receiptStatus: 'succeeded' }, { authorId: 'human-user' }, { participantIds: ['human-user'] },
    { nativeId: 'fabricated-receipt' }, { content: '任务已经成功' },
  ]) {
    const input = snapshot({ sources: [receiptSource('failed', override)] })
    input.memories[0].epistemic = 'observed'; input.memories[0].evidenceRefs = ['receipt:r1']
    const preview = previewCognitionImport(input)
    assert.equal(preview.sources.length, 0)
    assert.equal(preview.nodes.length, 0)
    assert.ok(preview.skipped.some(skip => skip.reason === 'missing-or-invalid-source-evidence'))
  }
  for (const status of ['unknown', 'failed']) {
    const input = snapshot({ sources: [receiptSource(status)] })
    input.memories[0].evidenceRefs = ['receipt:r1']
    const preview = previewCognitionImport(input)
    assert.equal(preview.nodes.length, 1)
    assert.equal(preview.nodes[0].epistemic, 'reported')
    assert.equal(JSON.parse(preview.sources[0].content).status, status)
  }
  const normalized = snapshot({ sources: [receiptSource('succeeded', {
    content: JSON.stringify({ summary: '真实工具回执', goalId: null, status: 'succeeded', toolName: 'search' }),
  })] })
  normalized.memories[0].epistemic = 'observed'; normalized.memories[0].evidenceRefs = ['receipt:r1']
  assert.equal(previewCognitionImport(normalized).sources[0].content, receiptSource('succeeded').content)
})

test('revoked receipts preserve empty-body tombstones while unresolved revoked identities block apply', async () => {
  const input = snapshot({ sources: [receiptSource('unknown', { status: 'revoked', content: '' })] })
  input.memories[0].evidenceRefs = ['receipt:r1']
  const preview = previewCognitionImport(input)
  assert.equal(preview.applicable, true)
  assert.equal(preview.sources[0].status, 'revoked')
  assert.equal(preview.sources[0].content, '')
  assert.equal(preview.nodes.length, 0)
  const saved = await apply(storeFixture().store, input)
  assert.equal(saved.sources[0].status, 'revoked')
  const invalid = snapshot({ sources: [receiptSource('unknown', { status: 'revoked', content: '', nativeId: 'wrong-identity' })] })
  assert.equal(previewCognitionImport(invalid).applicable, false)
  await assert.rejects(apply(storeFixture().store, invalid), /历史删除限制/u)
})

test('memory evidence chains flatten only verified raw sources; cycles, forks and missing corrections are rejected', () => {
  const input = snapshot()
  input.memories.push({ ...input.memories[0], id: 'm2', evidenceRefs: ['memory:m1'] })
  const preview = previewCognitionImport(input)
  assert.equal(preview.nodes.length, 2)
  assert.deepEqual(preview.nodes[0].sourceIds, preview.nodes[1].sourceIds)
  const cyclic = snapshot(); cyclic.memories[0].evidenceRefs = ['memory:m2']
  cyclic.memories.push({ ...cyclic.memories[0], id: 'm2', evidenceRefs: ['memory:m1'] })
  assert.equal(previewCognitionImport(cyclic).nodes.length, 0)
  const correction = snapshot(); correction.memories[0].supersedes = 'missing'
  assert.equal(previewCognitionImport(correction).nodes.length, 0)
  const fork = snapshot()
  fork.memories.push(...['m2', 'm3'].map(id => ({ ...fork.memories[0], id, supersedes: 'm1' })))
  const forkPreview = previewCognitionImport(fork)
  assert.equal(forkPreview.nodes.length, 1)
  assert.equal(forkPreview.nodes[0].status, 'active')
  assert.equal(forkPreview.skipped.filter(skip => skip.reason === 'ambiguous-correction-history').length, 2)
})

test('hash binds the complete JSON and expected revision is checked inside the only update', async () => {
  const input = snapshot(), preview = previewCognitionImport(input), f = storeFixture()
  const changed = structuredClone(input); changed.memories[0].content = '被调换的内容'
  await assert.rejects(applyCognitionImport(f.store, changed, { previewHash: preview.previewHash, expectedRevision: 0, guard }), /哈希不匹配/u)
  assert.throws(() => previewCognitionImport({ ...input, previewHash: preview.previewHash }), /快照格式/u)
  await assert.rejects(applyCognitionImport(f.store, input, { previewHash: preview.previewHash, expectedRevision: 1, guard }), /revision 已变化/u)
  assert.equal(f.control.commits, 0)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(applyCognitionImport(f.store, input, { previewHash: preview.previewHash, expectedRevision: 0, guard: { isCurrent: () => true, signal: controller.signal } }))
  assert.equal(f.control.commits, 0)
})

test('write failure is restartable; replay is idempotent and destination tombstones prevent resurrection', async () => {
  const input = snapshot(), f = storeFixture()
  f.control.failWrite = true
  await assert.rejects(apply(f.store, input), /write failed/u)
  assert.equal((await f.store.read(agentId)).processed.length, 0)
  f.control.failWrite = false
  const saved = await apply(f.store, input)
  const replay = await apply(f.store, input, saved.revision)
  assert.equal(replay.revision, 1); assert.equal(f.control.commits, 1)
  assert.equal(previewCognitionImport(input, replay).alreadyApplied, true)
  const erased = await f.store.update(agentId, state => invalidateCognitionState(state, { id: 'forget-user', conversation: scene, authorId: 'real-user-a', before: at }), guard)
  const reimport = snapshot(); reimport.memories[0].id = 'new-legacy-id'
  const preview = previewCognitionImport(reimport, erased)
  assert.equal(preview.nodes.length, 0)
  const result = await apply(f.store, reimport, erased.revision)
  assert.equal(result.sources[0].status, 'revoked'); assert.equal(result.sources[0].content, '')
  assert.ok(result.nodes.every(node => node.status === 'invalid'))
})

test('historical invalidations are applied before sources; malformed restrictions block every apply', async () => {
  const input = snapshot()
  input.invalidations.push({ id: 'old-erasure', scope, authorId: 'real-user-a', before: at })
  const preview = previewCognitionImport(input)
  assert.equal(preview.nodes.length, 0); assert.equal(preview.invalidations.length, 1)
  assert.equal(preview.sources[0].status, 'revoked')
  const f = storeFixture(), saved = await apply(f.store, input)
  assert.equal(saved.privacyRevision, 1)
  for (const restriction of [{ id: 'unknown-scope', scope: { ...scope, botId: 'unknown' }, before: at },
    { id: 'missing-ref', scope, before: at, sourceRefs: ['message:999'] }]) {
    const candidate = snapshot({ invalidations: [restriction] })
    assert.equal(previewCognitionImport(candidate).applicable, false)
    await assert.rejects(apply(storeFixture().store, candidate), /历史删除限制/u)
  }
})

test('concurrent destination erasure forces re-preview rather than applying a stale plan', async () => {
  const f = storeFixture(), input = snapshot(); let injected = false
  f.control.beforeCommit = async () => {
    if (injected) return
    injected = true
    const other = createCognitionStore(f.redis)
    await other.update(agentId, state => invalidateCognitionState(state, { id: 'concurrent-erase', before: at, conversation: scene }), guard)
  }
  // A separate Redis object is required to represent a separate host; using the
  // same object intentionally shares the store's in-process serialization queue.
  const independent = { ...f.redis }
  const original = f.control.beforeCommit
  f.control.beforeCommit = async key => {
    if (injected) return
    injected = true
    await createCognitionStore(independent).update(agentId, state => invalidateCognitionState(state, { id: 'concurrent-erase', before: at, conversation: scene }), guard)
  }
  assert.ok(original)
  await assert.rejects(apply(f.store, input), /revision 已变化/u)
  const state = await f.store.read(agentId)
  assert.equal(state.invalidations.length, 1); assert.equal(state.sources.length, 0); assert.equal(state.processed.length, 0)
})

test('offline CLI previews without writes, locks apply, atomically checkpoints and refuses source aliases', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cognition-import-'))
  try {
    const inputFile = path.join(directory, 'legacy.json'), outputFile = path.join(directory, 'cognition.json'), input = snapshot()
    const bytes = `${JSON.stringify(input)}\n`; await writeFile(inputFile, bytes)
    const messages = [], api = { ...domain, ...importer }, args = ['--input', inputFile, '--output', outputFile]
    await runCognitionImportCli(args, api, value => messages.push(value))
    assert.deepEqual(await readdir(directory), ['legacy.json'])
    const preview = messages[0]
    const applyArgs = [...args, '--apply', '--preview-hash', preview.previewHash, '--expected-revision', String(preview.destinationRevision)]
    await writeFile(`${outputFile}.import.lock`, 'another operator')
    await assert.rejects(runCognitionImportCli(applyArgs, api), /locked/u)
    assert.equal(await readFile(`${outputFile}.import.lock`, 'utf8'), 'another operator')
    await rm(`${outputFile}.import.lock`)
    await runCognitionImportCli(applyArgs, api, value => messages.push(value))
    const output = JSON.parse(await readFile(outputFile, 'utf8'))
    assert.equal(output.revision, 1); assert.equal(output.nodes.length, 1)
    assert.equal(await readFile(inputFile, 'utf8'), bytes)
    assert.deepEqual((await readdir(directory)).sort(), ['cognition.json', 'legacy.json'])
    await assert.rejects(runCognitionImportCli(applyArgs, api), /revision 已变化/u)
    const replayArgs = [...args, '--apply', '--preview-hash', preview.previewHash, '--expected-revision', '1']
    await runCognitionImportCli(replayArgs, api, value => messages.push(value))
    assert.equal(messages.at(-1).alreadyApplied, true)
    await assert.rejects(runCognitionImportCli(['--input', inputFile, '--output', inputFile], api), /overwrite/u)
    const hard = path.join(directory, 'hard.json'), symbolic = path.join(directory, 'sym.json')
    await link(inputFile, hard); await symlink(inputFile, symbolic)
    await assert.rejects(runCognitionImportCli(['--input', inputFile, '--output', hard], api))
    await assert.rejects(runCognitionImportCli(['--input', inputFile, '--output', symbolic], api))
    await assert.rejects(runCognitionImportCli([...args, '--apply'], api), /requires exact/u)
    await assert.rejects(runCognitionImportCli([...args, '--preview-hash', preview.previewHash], api), /does not accept/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
