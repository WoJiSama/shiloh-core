import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentSourceSnapshot: snapshot, inspectStandaloneAgentSourceSnapshot: inspect,
  isStandaloneAgentSourceSnapshotCurrent: current, observeStandaloneAgentSourceSnapshot: observe } = await load('bootstrap/standaloneAgentConfigSources.js')

async function fixture(t, withHead = false) {
  const root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'agent-config-observation-'))), host = path.join(root, 'host.yaml')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(host, 'version: 1\n')
  await writeFile(path.join(root, 'agent-bindings.yaml'), 'version: 1\n')
  const head = path.join(root, '.agent-config.head'), token = '11111111-1111-4111-8111-111111111111'
  const terminal = path.join(head, token + '.json')
  if (withHead) {
    fs.mkdirSync(head, { mode: 0o700 })
    await writeFile(terminal, JSON.stringify({ schema: 1, txId: token, direction: 'undo', token }), { mode: 0o600 })
  }
  return { root, host, terminal, loaded: snapshot(host) }
}

test('one synchronous configuration check shares its complete entry observation and performs a fresh exit read', async t => {
  const f = await fixture(t), original = fs.openSync
  let reads = 0, entryReads = 0
  fs.openSync = function(name, ...args) {
    if (name === f.host) reads++
    return original.call(this, name, ...args)
  }
  try {
    assert.deepEqual(observe(f.loaded, () => {
      entryReads = reads
      assert.ok(entryReads > 0)
      const entry = inspect(f.loaded)
      for (let i = 0; i < 17; i++) {
        assert.equal(current(f.loaded), true)
        assert.equal(inspect(f.loaded), entry)
      }
      assert.equal(reads, entryReads)
      return true
    }), { current: true, accepted: true })
    assert.ok(reads > entryReads, 'successful checks must re-read complete source bytes on exit')
    const before = reads
    assert.equal(current(f.loaded), true)
    assert.ok(reads > before, 'no result survives the completed synchronous check')
  } finally { fs.openSync = original }
})

test('fresh exit checks detect different bytes even when file metadata and size match', async t => {
  const f = await fixture(t), original = fs.readFileSync, hostStat = fs.statSync(f.host, { bigint: true })
  let changed = false
  fs.readFileSync = function(name, ...args) {
    if (changed && typeof name === 'number' && fs.fstatSync(name, { bigint: true }).ino === hostStat.ino) {
      return Buffer.from('version: 2\n')
    }
    return original.call(this, name, ...args)
  }
  try {
    assert.deepEqual(observe(f.loaded, () => {
      assert.equal(current(f.loaded), true)
      changed = true
      return true
    }), { current: false, accepted: false })
    assert.equal(current(f.loaded), false)
    assert.equal(inspect(f.loaded).sources.host, 'version: 2\n')
    changed = false
    assert.equal(current(f.loaded), true)
  } finally { fs.readFileSync = original }
})

test('a same-byte replacement during a synchronous callback rejects true, false and throwing checks', async t => {
  for (const completion of ['true', 'false', 'throw']) await t.test(completion, async t => {
    const f = await fixture(t)
    const result = observe(f.loaded, () => {
      const replacement = path.join(f.root, 'replacement')
      fs.writeFileSync(replacement, f.loaded.sources.host)
      fs.renameSync(replacement, f.host)
      if (completion === 'throw') throw new Error('check failed')
      return completion === 'true'
    })
    assert.deepEqual(result, { current: false, accepted: false })
    assert.equal(current(f.loaded), false)
    assert.equal(observe(f.loaded, () => inspect(f.loaded).sources.host === f.loaded.sources.host).accepted, true,
      'the observer compares this call entry and exit, while its caller owns the loaded-version policy')
  })
})

test('nested checks share only the outer synchronous scope and the final source fence owns their result', async t => {
  const f = await fixture(t)
  assert.deepEqual(observe(f.loaded, () => {
    const entry = inspect(f.loaded)
    assert.deepEqual(observe(f.loaded, () => {
      assert.equal(inspect(f.loaded), entry)
      fs.writeFileSync(path.join(f.root, 'persona-library.yaml'), 'personas: []\n')
      return true
    }), { current: true, accepted: true })
    return true
  }), { current: false, accepted: false })
  assert.equal(inspect(f.loaded).sources.personas, 'personas: []\n')
})

test('an async callback is rejected and its continuation receives a new configuration observation', async t => {
  const f = await fixture(t)
  let continuation
  assert.deepEqual(observe(f.loaded, () => {
    continuation = (async () => {
      await Promise.resolve()
      fs.writeFileSync(f.host, 'version: 2\n')
      return inspect(f.loaded).sources.host
    })()
    return continuation
  }), { current: true, accepted: false })
  assert.equal(await continuation, 'version: 2\n')
  assert.equal(current(f.loaded), false)
  assert.deepEqual(observe(f.loaded, () => Promise.reject(new Error('rejected async check'))), { current: true, accepted: false })
  await new Promise(resolve => setImmediate(resolve))
  let invoked = false
  const thenable = Object.defineProperty({}, 'then', { get() { invoked = true; throw new Error('do not invoke') } })
  assert.deepEqual(observe(f.loaded, () => thenable), { current: true, accepted: false })
  assert.equal(invoked, false)
})

test('runtime observations reuse verified local bytes and reject an in-place change even with restored mtime', async t => {
  const f = await fixture(t, true)
  const time = Date.UTC(2025, 0, 1) / 1000
  fs.utimesSync(f.host, time, time)
  const nativeLocal = process.platform === 'linux' && [0xef53, 0x01021994, 0x58465342, 0x9123683e].includes(fs.statfsSync(f.root).type >>> 0)
  if (nativeLocal) await delay(2_050)
  const loaded = snapshot(f.host)
  assert.equal(current(loaded, 'execution'), true)
  const original = fs.openSync
  let reads = 0
  fs.openSync = function(name, ...args) {
    if (name === f.host || name === f.terminal) reads++
    return original.call(this, name, ...args)
  }
  try {
    assert.deepEqual(observe(loaded, () => current(loaded, 'execution'), 'execution'), { current: true, accepted: true })
    if (nativeLocal) assert.equal(reads, 0)
    assert.deepEqual(observe(loaded, () => {
      fs.writeFileSync(f.host, 'version: 2\n')
      fs.utimesSync(f.host, time, time)
      return true
    }, 'execution'), { current: false, accepted: false })
    assert.equal(current(loaded, 'execution'), false)
    assert.equal(inspect(loaded, 'execution').sources.host, 'version: 2\n')
    assert.ok(reads > 0)
  } finally { fs.openSync = original }
})

test('an execution fence detects a changed terminal record or an active transaction', async t => {
  for (const changed of ['head', 'active']) await t.test(changed, async t => {
    const f = await fixture(t, true)
    assert.equal(current(f.loaded, 'execution'), true)
    assert.deepEqual(observe(f.loaded, () => {
      if (changed === 'head') {
        const record = JSON.parse(fs.readFileSync(f.terminal, 'utf8'))
        fs.writeFileSync(f.terminal, JSON.stringify({ ...record, direction: 'redo' }))
      } else fs.writeFileSync(path.join(f.root, '.agent-config.active'), '{}')
      return true
    }, 'execution'), { current: false, accepted: false })
    assert.equal(current(f.loaded, 'execution'), false)
  })
})

test('unowned snapshots and source fences changed inside the callback fail closed', async t => {
  const f = await fixture(t)
  assert.deepEqual(observe({ ...f.loaded }, () => assert.fail('unowned callback')), { current: false, accepted: false })
  assert.deepEqual(observe(f.loaded, () => {
    const head = path.join(f.root, '.agent-config.head'), token = '11111111-1111-4111-8111-111111111111'
    fs.mkdirSync(head, { mode: 0o700 })
    fs.writeFileSync(path.join(head, token + '.json'), JSON.stringify({ schema: 1, txId: token, direction: 'undo', token }), { mode: 0o600 })
    return true
  }), { current: false, accepted: false })
  assert.equal(current(f.loaded), false)
})
