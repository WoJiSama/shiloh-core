import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const { importBilibiliHost: load } = await import('./helpers/bilibiliQualitySource.mjs')
const { readStandaloneAgentSourceSnapshot: snapshot, isStandaloneAgentSourceSnapshotCurrent: current,
  acquireStandaloneAgentConfigLock: acquire, inspectStandaloneAgentConfigTransaction: inspect } = await load('bootstrap/standaloneAgentConfigSources.js')

const guard = (controller = new AbortController()) => ({ signal: controller.signal, ensureCurrent() { assert.equal(controller.signal.aborted, false) } })
async function fixture(t, library = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-config-sources-')), hostFile = path.join(root, 'host.yaml')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(hostFile, '# host\nversion: 1\n')
  await writeFile(path.join(root, 'agent-bindings.yaml'), '# bindings\nversion: 1\n')
  if (library) await writeFile(path.join(root, 'persona-library.yaml'), 'personas: []\n')
  return { root: fs.realpathSync(root), hostFile, loaded: snapshot(hostFile) }
}
async function leftovers(root) { return (await readdir(root)).filter(name => name.includes('.config.tmp') || name === '.agent-config.write.lock') }

test('source snapshots cover all three files, distinguish absent library and detect same-byte replacement', async t => {
  const f = await fixture(t, false)
  assert.equal(f.loaded.sources.personas, undefined)
  assert.equal(current(f.loaded), true)
  const unchanged = snapshot(f.hostFile)
  assert.equal(unchanged.revision, f.loaded.revision)
  const temporary = path.join(f.root, 'replacement')
  await writeFile(temporary, f.loaded.sources.host)
  fs.renameSync(temporary, f.hostFile)
  assert.equal(current(f.loaded), false)
  assert.notEqual(snapshot(f.hostFile).revision, f.loaded.revision)
  await writeFile(path.join(f.root, 'persona-library.yaml'), 'personas: []\n')
  assert.notEqual(snapshot(f.hostFile).versions.personas, 'absent')
  assert.deepEqual(await leftovers(f.root), [])
})

test('read-only and unchanged leases remove only their newly created empty claims directory', async t => {
  const f = await fixture(t), expected = ['agent-bindings.yaml', 'host.yaml', 'persona-library.yaml']
  assert.deepEqual((await readdir(f.root)).sort(), expected)
  const lock = await acquire(f.loaded, guard())
  const result = lock.commitSources(f.loaded.sources, f.loaded, { ensureActorCurrent() {}, onFenced() { assert.fail('unchanged') }, onCommitPublished() { assert.fail('unchanged') } })
  lock.release()
  assert.equal(result.snapshot, f.loaded)
  assert.deepEqual((await readdir(f.root)).sort(), expected)
  const claims = path.join(f.root, '.agent-config.claims')
  fs.mkdirSync(claims, { mode: 0o700 })
  const original = fs.lstatSync(claims)
  assert.equal(snapshot(f.hostFile).revision, f.loaded.revision)
  assert.equal(fs.lstatSync(claims).ino, original.ino, 'an already present empty directory is not owned by this reader')
  assert.deepEqual(await readdir(claims), [])
})

test('claims cleanup preserves unknown files and an empty directory replaced during the empty observation', async t => {
  for (const kind of ['nonempty', 'replaced', 'became-nonempty']) {
    const f = await fixture(t), lock = await acquire(f.loaded, guard()), claims = path.join(f.root, '.agent-config.claims')
    const originalRead = fs.readdirSync, originalRemove = fs.rmdirSync, saved = claims + '.saved'
    let injected = false
    if (kind === 'nonempty') fs.writeFileSync(path.join(claims, 'outside-anchor'), 'retain unknown recovery data', { mode: 0o600 })
    else if (kind === 'replaced') fs.readdirSync = function(name, ...args) {
      const result = originalRead.call(this, name, ...args)
      if (name === claims && !injected) {
        injected = true
        fs.renameSync(claims, saved); fs.mkdirSync(claims, { mode: 0o700 })
      }
      return result
    }
    else fs.rmdirSync = function(name, ...args) {
      if (name === claims && !injected) { injected = true; fs.writeFileSync(path.join(claims, 'outside-anchor'), 'retain concurrent data', { mode: 0o600 }) }
      return originalRemove.call(this, name, ...args)
    }
    try { lock.release() }
    finally { fs.readdirSync = originalRead; fs.rmdirSync = originalRemove }
    assert.equal(fs.existsSync(path.join(f.root, '.agent-config.write.lock')), false)
    assert.equal(fs.lstatSync(claims).isDirectory(), true)
    if (kind === 'replaced') {
      assert.equal(injected, true)
      assert.notEqual(fs.lstatSync(claims).ino, fs.lstatSync(saved).ino)
      assert.deepEqual(await readdir(claims), [])
    } else assert.match(fs.readFileSync(path.join(claims, 'outside-anchor'), 'utf8'), /retain/u)
  }
})

test('a complete source read rejects a replaced pinned root and an unseen terminal fence change', async t => {
  for (const kind of ['root', 'terminal']) {
    const f = await fixture(t), original = fs.lstatSync, saved = f.root + '.saved'
    t.after(() => rm(saved, { recursive: true, force: true }))
    let observations = 0, injected = false
    fs.lstatSync = function(name, ...args) {
      if (name === path.join(f.root, '.agent-config.head') && ++observations === 2) {
        injected = true
        if (kind === 'root') {
          fs.renameSync(f.root, saved); fs.mkdirSync(f.root, { mode: 0o700 })
          for (const name of ['host.yaml', 'persona-library.yaml', 'agent-bindings.yaml']) fs.copyFileSync(path.join(saved, name), path.join(f.root, name))
        } else {
          const directory = path.join(f.root, '.agent-config.head'), token = '11111111-1111-4111-8111-111111111111'
          fs.mkdirSync(directory, { mode: 0o700 })
          fs.writeFileSync(path.join(directory, token + '.json'), JSON.stringify({ schema: 1, txId: token, direction: 'undo', token }), { mode: 0o600 })
        }
      }
      return original.call(this, name, ...args)
    }
    try { assert.equal(current(f.loaded), false) }
    finally { fs.lstatSync = original }
    assert.equal(injected, true)
    assert.equal(fs.readFileSync(f.hostFile, 'utf8'), f.loaded.sources.host)
  }
})

test('a single-file commit compares every dependency and never touches a changed dependency', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard())
  const dependency = path.join(f.root, 'agent-bindings.yaml')
  await writeFile(dependency, '# external revision\nversion: 2\n')
  let committed = false
  assert.throws(() => lock.commit('host', 'version: 2\n', f.loaded, () => {}, () => { committed = true }), { code: 'conflict' })
  lock.release()
  assert.equal(committed, false)
  assert.equal(await readFile(f.hostFile, 'utf8'), f.loaded.sources.host)
  assert.equal(await readFile(dependency, 'utf8'), '# external revision\nversion: 2\n')
  assert.deepEqual(await leftovers(f.root), [])
})

test('first library creation is a single target commit and publishes retirement synchronously', async t => {
  const f = await fixture(t, false), lock = await acquire(f.loaded, guard()), events = []
  const after = lock.commit('personas', '# templates\npersonas: []\n', f.loaded, () => { events.push('guard') }, () => {
    events.push('committed')
    assert.equal(fs.readFileSync(path.join(f.root, 'persona-library.yaml'), 'utf8'), '# templates\npersonas: []\n')
  })
  events.push('returned'); lock.release()
  assert.ok(events.indexOf('committed') < events.indexOf('returned'))
  assert.equal(after.versions.host, f.loaded.versions.host)
  assert.equal(after.versions.bindings, f.loaded.versions.bindings)
  assert.equal(current(after), true)
  assert.equal(current(f.loaded), false)
  assert.deepEqual(await leftovers(f.root), [])
})

test('first library creation never overwrites a file appearing after the final read-set check', async t => {
  const f = await fixture(t, false), lock = await acquire(f.loaded, guard()), file = path.join(f.root, 'persona-library.yaml')
  let checks = 0, committed = false
  assert.throws(() => lock.commit('personas', 'personas: []\n', f.loaded, () => {
    if (++checks === 2) fs.writeFileSync(file, '# another writer created it\npersonas: []\n', { flag: 'wx', mode: 0o600 })
  }, () => { committed = true }))
  lock.release()
  assert.equal(committed, false)
  assert.equal(await readFile(file, 'utf8'), '# another writer created it\npersonas: []\n')
  assert.equal(await readFile(f.hostFile, 'utf8'), f.loaded.sources.host)
  assert.deepEqual(await leftovers(f.root), [])
})

test('abort while waiting for another lock does not steal or remove its owner', async t => {
  const f = await fixture(t), first = await acquire(f.loaded, guard()), controller = new AbortController()
  const lockFile = path.join(f.root, '.agent-config.write.lock'), owner = await readFile(lockFile, 'utf8')
  const waiting = acquire(f.loaded, { signal: controller.signal, ensureCurrent() { if (controller.signal.aborted) { const error = new Error('conflict'); error.code = 'conflict'; throw error } } })
  controller.abort()
  await assert.rejects(waiting, { code: 'conflict' })
  assert.equal(await readFile(lockFile, 'utf8'), owner)
  first.release()
  assert.deepEqual(await leftovers(f.root), [])
})

test('cleanup retains a replacement lock and refuses mutations after lock ownership changes', async t => {
  const f = await fixture(t), first = await acquire(f.loaded, guard()), lockFile = path.join(f.root, '.agent-config.write.lock')
  fs.unlinkSync(lockFile)
  await writeFile(lockFile, 'another-owner', { mode: 0o600 })
  assert.throws(() => first.commit('host', 'version: 2\n', f.loaded, () => {}, () => {}), { code: 'conflict' })
  first.release()
  assert.equal(await readFile(lockFile, 'utf8'), 'another-owner')
  assert.equal(await readFile(f.hostFile, 'utf8'), f.loaded.sources.host)
})

test('symlink and hardlink configuration targets are rejected without modifying their referents', async t => {
  for (const link of ['symlink', 'hardlink']) await t.test(link, async t => {
    const f = await fixture(t), file = path.join(f.root, 'persona-library.yaml'), other = path.join(f.root, 'referent')
    const bytes = await readFile(file, 'utf8')
    fs.renameSync(file, other)
    if (link === 'symlink') fs.symlinkSync(other, file)
    else fs.linkSync(other, file)
    assert.throws(() => snapshot(f.hostFile), { code: 'unavailable' })
    assert.equal(await readFile(other, 'utf8'), bytes)
    assert.deepEqual(await leftovers(f.root), [])
  })
})

test('two processes sharing the root lock cannot both commit the same read set', async t => {
  const f = await fixture(t), helper = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
  const code = `
    import { importBilibiliHost as load } from ${JSON.stringify(helper)};
    const {readStandaloneAgentSourceSnapshot:read, acquireStandaloneAgentConfigLock:acquire} = await load('bootstrap/standaloneAgentConfigSources.js');
    const loaded = read(process.argv[1]);
    console.log('ready');
    await new Promise(resolve => process.stdin.once('data', resolve));
    let lock;
    try {
      lock = await acquire(loaded, {signal:new AbortController().signal,ensureCurrent(){}});
      lock.commit('host','version: child\\n',loaded,()=>{},()=>{});
      console.log('committed');
    } catch (error) {console.log(error.code || 'failed');}
    finally {lock?.release();}
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.hostFile], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`child did not prepare: ${stderr}`)), 10000)
    child.stdout.on('data', () => { if (stdout.includes('ready\n')) { clearTimeout(deadline); resolve() } })
    child.once('error', reject)
  })
  const lock = await acquire(f.loaded, guard())
  child.stdin.end('go')
  // The child is another real process, and remains excluded until the first writer releases.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(stdout, 'ready\n')
  lock.commit('host', 'version: parent\n', f.loaded, () => {}, () => {})
  lock.release()
  const exit = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(exit, 0, stderr)
  assert.equal(stdout, 'ready\nconflict\n')
  assert.equal(await readFile(f.hostFile, 'utf8'), 'version: parent\n')
  assert.deepEqual(await leftovers(f.root), [])
})

test('pre-fence backup fsync failure leaves every original file intact and releases the owner', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), original = fs.fsyncSync
  let committed = false
  fs.fsyncSync = descriptor => {
    const journal = path.join(f.root, '.agent-config.transactions')
    const tx = fs.existsSync(journal) ? fs.readdirSync(journal)[0] : undefined
    const pending = tx && path.join(journal, tx, 'old-host')
    if (pending && fs.existsSync(pending) && fs.statSync(pending).ino === fs.fstatSync(descriptor).ino) throw new Error('fixture temporary fsync failure')
    return original(descriptor)
  }
  try { assert.throws(() => lock.commit('host', 'version: 2\n', f.loaded, () => {}, () => { committed = true }), /fixture temporary fsync failure/u) }
  finally { fs.fsyncSync = original; lock.release() }
  assert.equal(committed, false)
  assert.equal(await readFile(f.hostFile, 'utf8'), f.loaded.sources.host)
  assert.deepEqual(await leftovers(f.root), [])
})

test('pre-fence failure preserves a replaced private preparation and leaves original configuration intact', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), original = fs.fsyncSync
  let replaced
  fs.fsyncSync = descriptor => {
    const journal = path.join(f.root, '.agent-config.transactions')
    const tx = fs.existsSync(journal) ? fs.readdirSync(journal)[0] : undefined
    const name = tx && path.join(journal, tx, 'old-host')
    if (name && fs.existsSync(name) && fs.statSync(name).ino === fs.fstatSync(descriptor).ino) {
      replaced = name
      fs.unlinkSync(replaced)
      fs.writeFileSync(replaced, 'replacement belongs to another owner', { flag: 'wx', mode: 0o600 })
      throw new Error('fixture replaced temporary')
    }
    return original(descriptor)
  }
  try { assert.throws(() => lock.commit('host', 'version: 2\n', f.loaded, () => {}, () => {}), /fixture replaced temporary/u) }
  finally { fs.fsyncSync = original; lock.release() }
  assert.equal(await readFile(replaced, 'utf8'), 'replacement belongs to another owner')
  assert.equal(await readFile(f.hostFile, 'utf8'), f.loaded.sources.host)
})

test('commit-record directory fsync failure retains the new target and explicit redo recovery gate', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), original = fs.fsyncSync
  let committed = false
  fs.fsyncSync = descriptor => { if (committed && fs.fstatSync(descriptor).isDirectory()) throw new Error('fixture directory fsync failure'); return original(descriptor) }
  try { assert.throws(() => lock.commit('host', 'version: 2\n', f.loaded, () => {}, () => { committed = true }), /fixture directory fsync failure/u) }
  finally { fs.fsyncSync = original; lock.release() }
  assert.equal(committed, true)
  assert.equal(await readFile(f.hostFile, 'utf8'), 'version: 2\n')
  assert.equal(current(f.loaded), false)
  assert.deepEqual(await leftovers(f.root), ['.agent-config.write.lock'])
  assert.equal(inspect(f.hostFile).phase, 'recovery-required')
  assert.equal(inspect(f.hostFile).direction, 'redo')
  assert.throws(() => snapshot(f.hostFile), { code: 'conflict' })
})
