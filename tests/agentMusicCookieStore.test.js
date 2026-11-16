import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openAgentMusicCookieStore } from '../dist/backend/bootstrap/agentMusicCookieStore.js'

const seed = 'uin=1;qm_keyst=initial-private==', refreshed = 'uin=1;qm_keyst=renewed-private=='
const context = () => ({ signal: new AbortController().signal, isCurrent: () => true })
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-music-cookie-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, stateDirectory: path.join(directory, 'music-credentials'), file: path.join(directory, 'music-credentials/qq-music.json') }
}
test('music credentials persist privately across restart without rewriting the host seed or crossing a changed seed', async t => {
  const f = await fixture(t), store = await openAgentMusicCookieStore(f.directory, seed)
  assert.equal(store.cookie, seed)
  await store.save(refreshed, context())
  assert.equal((await fs.stat(f.stateDirectory)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600)
  assert.equal((await openAgentMusicCookieStore(f.directory, seed)).cookie, refreshed)
  assert.equal((await openAgentMusicCookieStore(f.directory, 'uin=2;qm_keyst=other-account-key')).cookie, 'uin=2;qm_keyst=other-account-key')
  assert.equal((await openAgentMusicCookieStore(f.directory, seed)).cookie, refreshed)
  assert.equal((await fs.readdir(f.stateDirectory)).some(name => name.startsWith('.qq-music-')), false)
})
test('anonymous music does not create credential state and revoked persistence leaves the prior secret intact', async t => {
  const f = await fixture(t), anonymous = await openAgentMusicCookieStore(f.directory, '')
  assert.equal(anonymous.cookie, '')
  await assert.rejects(fs.stat(f.stateDirectory), { code: 'ENOENT' })
  const store = await openAgentMusicCookieStore(f.directory, seed)
  await store.save(refreshed, context())
  const previous = await fs.readFile(f.file)
  let checks = 0
  await assert.rejects(store.save('uin=1;qm_keyst=revoked-key', { ...context(), async ensureCurrent() { if (++checks === 2) throw new Error('revoked') } }), /存储/)
  assert.deepEqual(await fs.readFile(f.file), previous)
  assert.deepEqual(await fs.readdir(f.stateDirectory), ['qq-music.json'])
})
test('credential storage rejects unsafe modes, symlinks, malformed records and header injection', async t => {
  const f = await fixture(t)
  await assert.rejects(openAgentMusicCookieStore(f.directory, 'key=secret\nheader=bad'), /存储/)
  const store = await openAgentMusicCookieStore(f.directory, seed)
  await store.save(refreshed, context())
  await fs.chmod(f.file, 0o644)
  await assert.rejects(openAgentMusicCookieStore(f.directory, seed), /存储/)
  await fs.chmod(f.file, 0o600); await fs.writeFile(f.file, JSON.stringify({ version: 1, seedHash: 'bad', cookie: refreshed }))
  await assert.rejects(openAgentMusicCookieStore(f.directory, seed), /存储/)
  await fs.rm(f.file); await fs.symlink(path.join(f.directory, 'other'), f.file)
  await assert.rejects(openAgentMusicCookieStore(f.directory, seed), /存储/)
  await fs.rm(f.file); await fs.chmod(f.stateDirectory, 0o755)
  await assert.rejects(openAgentMusicCookieStore(f.directory, seed), /存储/)
})
