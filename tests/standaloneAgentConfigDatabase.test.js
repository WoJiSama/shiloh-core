import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { agentHostModuleUrl, importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ initializeStandaloneConfigDatabase, nextStandaloneConfigDatabaseContent, openStandaloneConfigDatabase,
  readStandaloneConfigDatabase, writeStandaloneConfigDatabase }, { prepareStandaloneAgentTopologyChange },
  { createStandaloneAgentCandidateValidator }] = await Promise.all([
  load('bootstrap/standaloneAgentConfigDatabase.js'), load('bootstrap/standaloneAgentConsoleTopology.js'),
  load('bootstrap/standaloneAgentConfig.js'),
])
let sqliteAvailable = false
try { sqliteAvailable = !!process.getBuiltinModule('node:sqlite')?.DatabaseSync } catch { /* Older Node can still run the YAML compatibility tests. */ }

const host = { version: 1, instance: 'config-database', model: { baseUrl: 'https://fixture.example/v1', name: 'fixture', apiKeyEnv: 'MODEL_KEY' },
  connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], extension: { nested: ['keep', 1] } }
const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
  connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '12345' }],
  bindings: [{ connectionId: 'main', kind: 'group', conversationId: '98765', agentId: 'daily' }] }

test('SQLite stores one complete JSON configuration and rolls back an interrupted multi-section edit', { skip: !sqliteAvailable }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiloh-config-database-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'agent-config.sqlite')
  const before = nextStandaloneConfigDatabaseContent({ format: 'json', personas: undefined, host: JSON.stringify(host), bindings: JSON.stringify(bindings) })
  initializeStandaloneConfigDatabase(file, before)
  function read() {
    const reader = openStandaloneConfigDatabase(file, true)
    try { return readStandaloneConfigDatabase(reader) } finally { reader.close() }
  }
  assert.deepEqual(read(), before)
  const { sources } = prepareStandaloneAgentTopologyChange(before.sources, { kind: 'agent.create', agentId: 'research', personaId: 'researcher',
    newPersona: { id: 'researcher', name: '研发助手', tone: '简洁' } })
  assert.equal(sources.host, before.sources.host)
  assert.equal(sources.format, 'json')
  assert.equal(JSON.parse(sources.personas).personas[0].name, '研发助手')
  assert.deepEqual(JSON.parse(sources.host).extension, { nested: ['keep', 1] })
  const next = nextStandaloneConfigDatabaseContent(sources, before)
  createStandaloneAgentCandidateValidator(file, {}, { requireCredentials: false,
    sourceSnapshot: { hostFile: file, sources, versions: next.versions } })(sources)
  assert.equal(next.versions.host, before.versions.host)
  assert.notEqual(next.versions.bindings, before.versions.bindings)
  assert.notEqual(next.versions.personas, 'absent')
  assert.throws(() => nextStandaloneConfigDatabaseContent({ ...sources, host: 'version: 1' }))
  const writer = openStandaloneConfigDatabase(file, false), competitor = openStandaloneConfigDatabase(file, false)
  try {
    writer.exec('BEGIN IMMEDIATE')
    writeStandaloneConfigDatabase(writer, next)
    assert.deepEqual(read(), before)
    assert.throws(() => competitor.exec('BEGIN IMMEDIATE'), /locked/u)
    writer.exec('ROLLBACK')
    assert.deepEqual(read(), before)
    writer.exec('BEGIN IMMEDIATE')
    writeStandaloneConfigDatabase(writer, next)
    writer.exec('COMMIT')
    assert.deepEqual(read(), next)
  } finally { competitor.close(); writer.close() }
})

test('standalone CLI initializes its default database from JSON and exports a versioned draft', {
  skip: !sqliteAvailable || process.platform === 'win32', timeout: 20_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiloh-config-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'config'))
  const seed = path.join(root, 'seed.json'), draft = path.join(root, 'draft.json')
  await writeFile(seed, JSON.stringify({ host, bindings }))
  const loader = new URL('helpers/bilibiliQualitySource.mjs', import.meta.url).href
  const cli = `const { importBilibiliHost: load } = await import(${JSON.stringify(loader)});
    const { main } = await load('bootstrap/standaloneAgent.js'); await main(process.argv.slice(1));`
  const invoke = (...args) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', cli, '--', ...args],
      { cwd: root, encoding: 'utf8', timeout: 15_000 })
    assert.equal(child.status, 0, child.stderr || String(child.error))
    return JSON.parse(child.stdout)
  }
  const database = path.join(root, 'config', 'agent-config.sqlite')
  assert.equal(invoke('--import-config', seed).phase, 'validated')
  await assert.rejects(readFile(database), { code: 'ENOENT' })
  assert.equal(invoke('--import-config', seed, '--apply').phase, 'imported')
  assert.equal(invoke('--inspect-config-transaction').phase, 'clean')
  const exported = invoke('--export-config', draft)
  assert.equal(exported.phase, 'exported')
  assert.deepEqual(JSON.parse(await readFile(draft, 'utf8')), { host, bindings, revision: exported.revision })
})
