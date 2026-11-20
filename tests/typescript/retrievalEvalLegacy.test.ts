import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Script } from 'node:vm'
import type { SemanticRuntime } from '../../src/modules/memory/infrastructure/semanticRuntime.js'
import { RETRIEVAL_EVAL_COMMAND, runRetrievalEval } from '../../src/modules/memory/infrastructure/retrievalEval.js'
import { createSemanticMemoryCommands } from '../../src/modules/memory/infrastructure/semanticMemoryCommands.js'
import { createSemanticMemoryWebApp } from '../../src/modules/memory/infrastructure/semanticMemoryWebApp.js'

test('retired evaluator cannot read live corpus, call a provider or write history', async () => {
  const runtime = new Proxy({} as SemanticRuntime, { get() { assert.fail('retired evaluator touched the live runtime') } })
  const result = await runRetrievalEval(runtime, { sampleCount: 30 })
  assert.equal(result.status, 'retired')
  assert.equal(result.method, 'legacy-v1')
  assert.equal(result.runtime, 'plugin')
  assert.equal(result.command, RETRIEVAL_EVAL_COMMAND)
  assert.match(result.message, /已停用/u)
  assert.equal('samples' in result, false)
  assert.equal('recallAt5Vector' in result, false)
})

test('authorized old evaluation command gives migration instructions even with no plugin runtime', async () => {
  let reads = 0
  const replies: string[] = []
  const { SemanticMemoryPlugin } = createSemanticMemoryCommands({
    PluginBase: class {},
    getSemanticMemoryRuntime() { reads++; assert.fail('migration command read the runtime') },
    buildVisibleFailureDetail: String,
    logger: { info() {}, error() {} },
  })
  const command = new SemanticMemoryPlugin()
  await command.handleCommand({ msg: '.语义记忆 评估 N=30', reply: text => replies.push(text) })
  assert.match(replies.pop()!, /仅主人或群主/u)
  await command.handleCommand({ msg: '.语义记忆 评估 N=30', isMaster: true, reply: text => replies.push(text) })
  assert.equal(reads, 0)
  assert.equal(replies.length, 1)
  assert.match(replies[0]!, /已停用/u)
  assert.ok(replies[0]!.includes(RETRIEVAL_EVAL_COMMAND))
  assert.doesNotMatch(replies[0]!, /评估样本:|开始在线评估|recall@5/u)
})

test('history preserves source bytes and separates versioned Core reports from labeled legacy fields', async t => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-eval-history-'))
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }))
  const legacy = { generatedAt: '2026-01-01T00:00:00Z', samples: 34, recallAt5Vector: 0.8, latencyP50Ms: 123 }
  const modern = { schemaVersion: 2, runtime: 'core', generatedAt: '2026-01-02T00:00:00Z', dataset: { id: 'fixed' }, modes: { hybrid: { hitAt5: 1 } } }
  const future = { schemaVersion: 3, runtime: 'core', generatedAt: '2026-01-03T00:00:00Z', summary: { arbitrary: true } }
  const bytes = [JSON.stringify(legacy), 'invalid-json', 'null', '[]', JSON.stringify(modern), JSON.stringify(future)].join('\n') + '\n'
  const file = path.join(baseDir, 'eval-history.ndjson')
  await fs.writeFile(file, bytes)
  const web = createSemanticMemoryWebApp(() => ({ baseDir } as SemanticRuntime))
  type Handler = Parameters<Parameters<typeof web.registerSemanticMemoryWebApp>[0]['use']>[1]
  let handler: Handler | undefined
  web.registerSemanticMemoryWebApp({ use(_mount, callback) { handler = callback } }, '/fixture', { token: 'secret' })
  let payload: unknown
  const response = { set() { return this }, status() { return this }, type() { return this }, send() {}, json(value: unknown) { payload = value } }
  await handler!({ path: '/api/eval-history', method: 'GET', query: { token: 'secret' }, headers: {} }, response, () => {})
  const result = payload as { history: Record<string, unknown>[]; versionedHistory: Record<string, unknown>[] }
  assert.equal(result.history.length, 1)
  assert.deepEqual(result.history[0], { ...legacy, method: 'legacy-v1', runtime: 'plugin', comparable: false,
    comparisonWarning: '插件旧评估 legacy-v1：向量对照和延迟口径无效，历史值不可与 Core v2 比较。' })
  assert.deepEqual(result.versionedHistory, [future, modern])
  assert.equal('recallAt5Vector' in result.versionedHistory[1]!, false)
  assert.equal('latencyP50Ms' in result.versionedHistory[1]!, false)
  assert.equal(await fs.readFile(file, 'utf8'), bytes)
})

test('legacy HTML displays migration and keeps versioned reports outside old metric fields', async () => {
  const web = createSemanticMemoryWebApp(() => null)
  type Handler = Parameters<Parameters<typeof web.registerSemanticMemoryWebApp>[0]['use']>[1]
  let handler: Handler | undefined
  web.registerSemanticMemoryWebApp({ use(_mount, callback) { handler = callback } }, '/fixture')
  let html = ''
  const response = { set() { return this }, status() { return this }, type() { return this }, send(value: string) { html = value }, json() {} }
  await handler!({ path: '/', method: 'GET', query: {}, headers: {} }, response, () => {})
  assert.ok(html.includes(RETRIEVAL_EVAL_COMMAND))
  assert.match(html, /旧在线自出题评估已停用/u)
  assert.match(html, /versionedHistory/u)
  assert.match(html, /旧向量字段\(无效对照\)/u)
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gu)) new Script(match[1]!)
})
