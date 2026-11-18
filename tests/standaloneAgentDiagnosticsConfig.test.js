import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { readStandaloneAgentConfig } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneAgentConfig.js')).href)
const defaults = { maxFileBytes: 8 * 1024 * 1024, maxFiles: 14, retentionDays: 14 }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-diagnostics-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data', 'diagnostics-config')
  const raw = { version: 1, instance: 'diagnostics-config',
    model: { baseUrl: 'https://model.example/v1', name: 'diagnostics-model', apiKeyEnv: 'DIAGNOSTICS_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '19000241' }],
    bindings: [{ connectionId: 'main', kind: 'private', conversationId: '330241', agentId: 'daily' }] }))
  return {
    dataDir,
    async read(logging, options) {
      await writeFile(file, JSON.stringify({ ...raw, ...(logging === undefined ? {} : { logging }) }))
      try { return readStandaloneAgentConfig(file, options?.requireCredentials === false ? {} : { DIAGNOSTICS_MODEL_KEY: 'config-private-key' }, options) }
      finally { await assert.rejects(stat(dataDir), { code: 'ENOENT' }, 'config inspection creates neither dataDir nor operations') }
    },
  }
}

test('operation logging defaults and each inclusive bound are parsed without creating storage', async t => {
  const run = await fixture(t)
  assert.deepEqual((await run.read()).operationLogging, defaults)
  assert.deepEqual((await run.read({})).operationLogging, defaults)
  assert.deepEqual((await run.read({ maxFileBytes: 65536, maxFiles: 1, retentionDays: 1 })).operationLogging,
    { maxFileBytes: 65536, maxFiles: 1, retentionDays: 1 })
  assert.deepEqual((await run.read({ maxFileBytes: 67108864, maxFiles: 128, retentionDays: 365 })).operationLogging,
    { maxFileBytes: 67108864, maxFiles: 128, retentionDays: 365 })
  assert.deepEqual((await run.read({ maxFiles: 3 })).operationLogging, { ...defaults, maxFiles: 3 })
  const checked = await run.read({ retentionDays: 7 }, { requireCredentials: false })
  assert.equal(checked.dataDir, run.dataDir)
  assert.deepEqual(checked.operationLogging, { ...defaults, retentionDays: 7 })
})

test('operation logging rejects non-objects and every unsupported key', async t => {
  const run = await fixture(t)
  for (const logging of [null, [], '', 'enabled', false, 3,
    { enabled: false }, { directory: '/tmp/logs' }, { path: '/tmp/logs' }, { secrets: [] }, { maxFileByte: 65536 }]) {
    await assert.rejects(run.read(logging), undefined, JSON.stringify(logging))
  }
})

test('operation logging requires bounded safe integers, including rejecting explicit null', async t => {
  const run = await fixture(t)
  for (const [key, minimum, maximum] of [['maxFileBytes', 65536, 67108864], ['maxFiles', 1, 128], ['retentionDays', 1, 365]]) {
    for (const value of [null, false, true, String(minimum), {}, [], minimum - 1, maximum + 1, minimum + 0.5, -1, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(run.read({ [key]: value }), undefined, `${key}=${JSON.stringify(value)}`)
    }
  }
})
