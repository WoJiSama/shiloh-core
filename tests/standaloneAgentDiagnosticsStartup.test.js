import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const run = promisify(execFile)
const root = process.env.BL_CHAT_AGENT_RELEASE_DIR || fileURLToPath(new URL('../', import.meta.url))
test('invalid startup config never echoes parser exception contents, file names or credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-startup-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const secret = 'PRIVATE_STARTUP_TOKEN_42', file = path.join(directory, secret + '.yaml')
  await writeFile(file, `version: 1\ninstance: ${secret}\nmodel: [${secret}\n`)
  await assert.rejects(run(process.execPath, [path.join(root, 'scripts/start-agent.mjs'), '--config', file]), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '')
    assert.match(error.stderr, /独立宿主启动或检查失败/u)
    assert.ok(!error.stderr.includes(secret)); assert.ok(!error.stderr.includes(directory))
    return true
  })
})
