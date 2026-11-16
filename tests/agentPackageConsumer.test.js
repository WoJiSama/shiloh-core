import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const release = process.env.BL_CHAT_AGENT_RELEASE_DIR

test('npm archive supports an external TypeScript host using only public Agent exports', {
  skip: !release || !redisAvailable, timeout: 60_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-package-consumer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const execute = (command, args, options = {}) => run(command, args, {
    cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024, ...options,
  })
  const { stdout } = await execute('npm', ['pack', path.resolve(release), '--ignore-scripts', '--json'])
  const [archive] = JSON.parse(stdout)
  const entries = new Set(archive.files.map(file => file.path))
  for (const name of ['npm-shrinkwrap.json', 'release-manifest.json', 'dist/backend/core/index.d.ts']) {
    assert.ok(entries.has(name), `npm archive is missing ${name}`)
  }
  assert.equal(entries.has('package-lock.json'), false)
  assert.ok([...entries].every(name => !name.startsWith('src/') && !name.startsWith('tests/')))

  const project = JSON.parse(await readFile(path.join(release, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(release, 'npm-shrinkwrap.json'), 'utf8'))
  const consumer = {
    name: 'agent-package-consumer', version: '1.0.0', private: true, type: 'module',
    dependencies: { [project.name]: `file:${archive.filename}` },
  }
  // Reuse the release's exact dependency graph so this install needs cached tarballs,
  // not registry metadata. npm ci still installs the actual npm archive in isolation.
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(consumer))
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: consumer.name, version: consumer.version, lockfileVersion: 3, requires: true,
    packages: {
      ...lock.packages, '': consumer,
      [`node_modules/${project.name}`]: {
        ...lock.packages[''], resolved: `file:${archive.filename}`, hasShrinkwrap: true,
      },
    },
  }))
  await execute('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'])
  const installed = path.join(directory, 'node_modules', project.name)
  const help = await execute(process.execPath, [path.join(installed, 'scripts/start-agent.mjs'), '--help'])
  assert.match(help.stdout, /--migrate-qq-state/)

  await copyFile(path.join(repo, 'tests/fixtures/agentPackageConsumer.mts'), path.join(directory, 'consumer.mts'))
  await copyFile(path.join(repo, 'tests/fixtures/agentWorkbook.xlsx'), path.join(directory, 'agentWorkbook.xlsx'))
  await execute(process.execPath, [
    path.join(repo, 'node_modules/typescript/bin/tsc'), '--strict', '--exactOptionalPropertyTypes',
    '--noUncheckedIndexedAccess', '--module', 'NodeNext', '--target', 'ES2022',
    '--types', 'node', '--typeRoots', path.join(repo, 'node_modules/@types'), 'consumer.mts',
  ])
  const { url } = await createAgentRedisFixture(t)
  const result = await execute(process.execPath, ['consumer.mjs'], {
    env: { ...process.env, BL_AGENT_CONSUMER_REDIS_URL: url },
  })
  assert.match(result.stdout, /external Agent host confirmed delivery/)

  await writeFile(path.join(installed, 'dist/backend/core/index.js'), 'export const corrupted = true\n')
  await assert.rejects(
    execute(process.execPath, [path.join(installed, 'scripts/start-agent.mjs'), '--help']),
    error => error.code === 1 && /Backend output differs/.test(error.stderr),
  )
})
