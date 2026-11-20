#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const help = `Core semantic retrieval evaluation v2 (fixed, isolated offline corpus)
Usage: node scripts/semantic-memory-eval.mjs [options]
  --dataset FILE   Fixed v2 dataset (default: bundled tests/fixtures/semantic-retrieval-benchmark.v2.json)
  --output FILE    JSON report destination (default: stdout)
  --backend FILE   Explicit ES module exporting metadata and createBackend(); default: synthetic regression backend
  --cache MODE     isolated-client (default) or warm-client; server cache remains uncontrolled
  --history FILE   Explicitly append v2 NDJSON; no production directory is discovered
  --help           Print this help without loading configuration or models

Build backend first: npm run backend:build
Synthetic results verify regression mechanics, not real semantic retrieval quality.
The legacy --rebuild/--group/--samples interface is retired. Use the plugin's explicit rebuild command for indexing.`

async function main() {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return }
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--dataset', '--output', '--backend', '--cache', '--history'].includes(key) || !value || value.startsWith('--')) throw new Error(`Unsupported or incomplete argument: ${key}\n${help}`)
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate argument: ${key}`)
    options[key] = value
  }
  const cache = options['--cache'] || 'isolated-client'
  if (!['isolated-client', 'warm-client'].includes(cache)) throw new Error('Cache must be isolated-client or warm-client')
  const datasetPath = options['--dataset'] ? path.resolve(options['--dataset']) : path.join(root, 'tests/fixtures/semantic-retrieval-benchmark.v2.json')
  const datasetText = await fs.readFile(datasetPath, 'utf8')
  const dataset = JSON.parse(datasetText)
  const { ensureBackendArtifacts } = await import('../utils/backendArtifactGuard.js')
  await ensureBackendArtifacts()
  const manifestText = await fs.readFile(path.join(root, 'dist/backend/manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestText)
  const modulePath = path.join(root, 'dist/backend/modules/memory/infrastructure/agentSemanticEvaluation.js')
  const { runAgentSemanticEvaluation, parseAgentSemanticEvaluationDataset, createSyntheticSemanticEvaluationBackend } = await import(pathToFileURL(modulePath).href)
  parseAgentSemanticEvaluationDataset(dataset)
  const backend = options['--backend'] ? await import(pathToFileURL(path.resolve(options['--backend'])).href) : {
    metadata: { kind: 'synthetic', embedding: { model: 'hashed-lexical-v2', endpoint: 'local' }, rerank: { model: 'lexical-overlap-v2', endpoint: 'local' }, revision: '2' },
    createBackend: createSyntheticSemanticEvaluationBackend,
  }
  if (typeof backend.createBackend !== 'function' || !backend.metadata || typeof backend.metadata !== 'object') throw new Error('Backend module must export metadata and createBackend()')
  const report = await runAgentSemanticEvaluation(dataset, { createBackend: backend.createBackend, backendMetadata: backend.metadata, cache })
  const { createHash } = await import('node:crypto')
  report.dataset.rawFileHash = createHash('sha256').update(datasetText).digest('hex')
  report.implementation = { commit: manifest.commit, runtimeNode: process.version, buildNode: manifest.node, compiler: manifest.compiler,
    manifestHash: createHash('sha256').update(manifestText).digest('hex') }
  const output = JSON.stringify(report, null, 2) + '\n'
  for (const [flag, contents] of [['--output', output], ['--history', JSON.stringify(report) + '\n']]) {
    if (options[flag]) {
      const file = path.resolve(options[flag])
      await fs.mkdir(path.dirname(file), { recursive: true })
      if (flag === '--history') await fs.appendFile(file, contents)
      else await fs.writeFile(file, contents)
    }
  }
  if (!options['--output']) process.stdout.write(output)
  else console.log(`Core evaluation v2: ${report.dataset.queries} fixed queries; ${report.evidence}; report ${path.resolve(options['--output'])}`)
  if (!report.storageUnchanged || Object.values(report.modes).some(mode => mode.errors || mode.timeouts || mode.forbiddenSourceRate > 0)) process.exitCode = 1
}
main().catch(error => { console.error(`Evaluation failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1 })
