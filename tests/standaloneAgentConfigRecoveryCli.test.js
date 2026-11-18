import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const helper = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
const entry = `const { importBilibiliHost: load } = await import(${JSON.stringify(helper)}); const { main } = await load('bootstrap/standaloneAgent.js'); try { await main(process.argv.slice(1)) } catch { console.error('fixed-recovery-rejection'); process.exitCode = 1 }`
async function run(root, file, args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry, '--', '--config', file, ...args], {
    cwd: root, env: { ...process.env, BL_AGENT_REDIS_URL: 'redis://127.0.0.1:1' },
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
    return { ...result, stdout, stderr }
  } finally { clearTimeout(timer) }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-recovery-cli-')), file = path.join(root, 'host.yaml')
  t.after(() => rm(root, { recursive: true, force: true }))
  // Both commands must branch before YAML compilation, credentials, or network startup.
  await writeFile(file, 'model: [invalid yaml\nPRIVATE_RECOVERY_SOURCE_SENTINEL\n')
  await writeFile(path.join(root, 'agent-bindings.yaml'), 'also: [invalid yaml\n')
  return { root, file }
}

test('configuration transaction inspection branches before YAML parsing and creates no files', async t => {
  const f = await fixture(t), before = await readdir(f.root), source = await readFile(f.file, 'utf8')
  const result = await run(f.root, f.file, ['--inspect-config-transaction'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  const view = JSON.parse(result.stdout)
  assert.equal(view.phase, 'clean')
  assert.equal(JSON.stringify(view).includes('PRIVATE_RECOVERY_SOURCE_SENTINEL'), false)
  assert.equal(result.stderr, '')
  assert.deepEqual(await readdir(f.root), before)
  assert.equal(await readFile(f.file, 'utf8'), source)
})

test('offline recovery of a clean source set prints only a safe receipt and starts no service', async t => {
  const f = await fixture(t), source = await readFile(f.file, 'utf8')
  const result = await run(f.root, f.file, ['--recover-config'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.phase, 'clean')
  assert.equal(receipt.requiresRestart, false)
  assert.match(receipt.configRevision, /^[a-f0-9]{64}$/u)
  assert.ok(Object.keys(receipt).every(key => ['phase', 'txId', 'direction', 'configRevision', 'requiresRestart'].includes(key)))
  assert.equal((result.stdout + result.stderr).includes('PRIVATE_RECOVERY_SOURCE_SENTINEL'), false)
  assert.equal(result.stderr, '')
  assert.equal(await readFile(f.file, 'utf8'), source)
})

test('configuration inspection and recovery reject every mixed startup or migration command before mutation', async t => {
  const f = await fixture(t), before = await readdir(f.root), source = await readFile(f.file, 'utf8')
  for (const args of [
    ['--recover-config', '--inspect-config-transaction'], ['--recover-config', '--check'],
    ['--inspect-config-transaction', '--migrate-qq-state'], ['--recover-config', '--apply'],
    ['--recover-config', '--connection', 'main'],
  ]) {
    const result = await run(f.root, f.file, args)
    assert.equal(result.code, 1, JSON.stringify({ args, result }))
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim(), 'fixed-recovery-rejection')
    assert.deepEqual(await readdir(f.root), before)
    assert.equal(await readFile(f.file, 'utf8'), source)
  }
})

test('offline recovery refuses an unknown owner and prints fixed diagnostics without source data', async t => {
  const f = await fixture(t), lock = path.join(f.root, '.agent-config.write.lock'), source = await readFile(f.file, 'utf8')
  await writeFile(lock, 'PRIVATE_UNKNOWN_OWNER_SENTINEL', { mode: 0o600 })
  const before = await readdir(f.root), result = await run(f.root, f.file, ['--recover-config'])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr)
  assert.equal(error.error, 'configuration_recovery_blocked')
  assert.equal(error.transaction.phase, 'blocked')
  assert.equal((result.stdout + result.stderr).includes('SENTINEL'), false)
  assert.deepEqual(await readdir(f.root), before)
  assert.equal(await readFile(lock, 'utf8'), 'PRIVATE_UNKNOWN_OWNER_SENTINEL')
  assert.equal(await readFile(f.file, 'utf8'), source)
})
