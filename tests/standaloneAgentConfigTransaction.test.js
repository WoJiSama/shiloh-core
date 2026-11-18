import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentSourceSnapshot: read, inspectStandaloneAgentSourceSnapshot: inspectSnapshot,
  isStandaloneAgentSourceSnapshotCurrent: current, acquireStandaloneAgentConfigLock: acquire,
  inspectStandaloneAgentConfigTransaction: inspect, recoverStandaloneAgentConfigTransaction: recover } = await load('bootstrap/standaloneAgentConfigSources.js')
const guard = () => ({ signal: new AbortController().signal, ensureCurrent() {} })
const old = { host: '# host\nversion: old\n', personas: '# library\npersonas: []\n', bindings: '# bindings\nversion: old\n' }
const next = { host: '# host\nversion: new\n', personas: '# library\npersonas: [new]\n', bindings: '# bindings\nversion: new\n' }
async function fixture(t, library = true) {
  const root = fs.realpathSync(await mkdtemp(path.join(tmpdir(), 'agent-config-tx-'))), hostFile = path.join(root, 'host.yaml')
  await writeFile(hostFile, old.host)
  await writeFile(path.join(root, 'agent-bindings.yaml'), old.bindings)
  if (library) await writeFile(path.join(root, 'persona-library.yaml'), old.personas)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, hostFile, loaded: read(hostFile) }
}
const hooks = (overrides = {}) => ({ ensureActorCurrent() {}, onFenced() {}, onCommitPublished() {}, ...overrides })
const fileSources = f => ({ host: fs.readFileSync(f.hostFile, 'utf8'), bindings: fs.readFileSync(path.join(f.root, 'agent-bindings.yaml'), 'utf8'),
  personas: fs.existsSync(path.join(f.root, 'persona-library.yaml')) ? fs.readFileSync(path.join(f.root, 'persona-library.yaml'), 'utf8') : undefined })
const helper = new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href
const childCode = `
  import fs from 'node:fs'; import path from 'node:path';
  import { importBilibiliHost as load } from ${JSON.stringify(helper)};
  const m=await load('bootstrap/standaloneAgentConfigSources.js');
  const host=process.argv[1], mode=process.argv[2], cut=process.argv[3], root=path.dirname(host);
  const kill=point=>{fs.writeSync(1,'cut:'+point+'\\n');process.kill(process.pid,'SIGKILL');};
  if(cut) for(const name of ['linkSync','renameSync','unlinkSync','fsyncSync']) {
    const original=fs[name];
    fs[name]=function(...args){
      const value=original.apply(this,args), source=String(args[0]), target=String(args[1]);
      if(name==='linkSync' && target===path.join(root,'.agent-config.active') && cut==='active')kill(cut);
      if(name==='renameSync' && source===host && target.includes('displaced-') && (cut==='displaced'||cut==='recover-displaced'))kill(cut);
      if(name==='linkSync' && target===host && (cut==='linked'||cut==='recover-linked'))kill(cut);
      if(name==='linkSync' && target.endsWith('/commit.json') && cut==='commit')kill(cut);
      if(name==='linkSync' && target.includes('/.agent-config.head/') && cut==='recover-head')kill(cut);
      if(name==='unlinkSync' && source===path.join(root,'.agent-config.active') && cut==='cleared')kill(cut);
      if(name==='unlinkSync' && source===path.join(root,'.agent-config.maintenance') && cut==='recover-maintenance-cleared')kill(cut);
      return value;
    };
  }
  if(mode==='recover'){
    try {const result=m.recoverStandaloneAgentConfigTransaction(host,{ensureOfflineCurrent(){}});console.log(JSON.stringify({phase:result.phase,direction:result.direction,sources:result.snapshot.sources,revision:result.snapshot.revision}));}
    catch(error){console.log(JSON.stringify({error:error.code||'failed',inspection:m.inspectStandaloneAgentConfigTransaction(host)}));process.exitCode=2;}
  }else{
    const loaded=m.readStandaloneAgentSourceSnapshot(host), lock=await m.acquireStandaloneAgentConfigLock(loaded,{signal:new AbortController().signal,ensureCurrent(){}});
    if(cut==='locked')kill(cut);
    try{const result=lock.commitSources(${JSON.stringify(next)},loaded,{ensureActorCurrent(){},onFenced(){},onCommitPublished(){}});console.log(JSON.stringify({revision:result.snapshot.revision}));}finally{lock.release();}
  }
`
function child(f, mode, cut = '') {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', childCode, f.hostFile, mode, cut], { env: { ...globalThis.process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', value => { stdout += value }); process.stderr.on('data', value => { stderr += value })
    const timeout = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('transaction child timed out: ' + stderr)) }, 15000)
    process.once('error', error => { clearTimeout(timeout); reject(error) })
    process.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }) })
  })
}

test('three-file commit fences every public reader before materialization and returns one complete snapshot', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), stages = []
  const result = lock.commitSources(next, f.loaded, hooks({ onFenced(id) {
    stages.push(['fenced', id]); assert.deepEqual(fileSources(f), old)
    assert.equal(current(f.loaded), false)
    assert.throws(() => inspectSnapshot(f.loaded), { code: 'conflict' })
    assert.throws(() => read(f.hostFile), { code: 'conflict' })
    assert.equal(inspect(f.hostFile).direction, 'undo')
  }, onCommitPublished(id) { stages.push(['committed', id]); assert.deepEqual(fileSources(f), next); assert.equal(inspect(f.hostFile).direction, 'redo') } }))
  lock.release()
  assert.deepEqual(result.snapshot.sources, next)
  assert.deepEqual(stages.map(stage => stage[0]), ['fenced', 'committed'])
  assert.equal(stages[0][1], result.txId); assert.equal(stages[1][1], result.txId)
  assert.equal(current(f.loaded), false); assert.equal(current(result.snapshot), true)
  assert.deepEqual(inspect(f.hostFile), { phase: 'clean' })
})

test('same-byte metadata edits by retirement listeners fail the original full read-set CAS before installation', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), target = path.join(f.root, 'agent-bindings.yaml')
  let committed = false
  assert.throws(() => lock.commitSources(next, f.loaded, hooks({ onFenced() { fs.chmodSync(target, 0o600); fs.chmodSync(target, 0o644) },
    onCommitPublished() { committed = true } })), { code: 'conflict' })
  lock.release()
  assert.equal(committed, false); assert.deepEqual(fileSources(f), old)
  assert.equal(inspect(f.hostFile).phase, 'recovery-required')
  assert.throws(() => read(f.hostFile), { code: 'conflict' })
})

test('actor revocation at fencing stops every later installation and keeps offline recovery materials', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()); let allowed = true
  assert.throws(() => lock.commitSources(next, f.loaded, hooks({ ensureActorCurrent() { if (!allowed) throw Error('fixture revoked') }, onFenced() { allowed = false } })), /fixture revoked/u)
  lock.release(); assert.deepEqual(fileSources(f), old)
  assert.equal(inspect(f.hostFile).direction, 'undo')
  assert.throws(() => recover(f.hostFile, { ensureOfflineCurrent() {} }), { code: 'conflict' }) // The original owner is still alive.
})

test('an unchanged candidate creates no journal or retirement event', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard())
  const result = lock.commitSources(f.loaded.sources, f.loaded, hooks({ onFenced() { assert.fail('no retirement for unchanged bytes') }, onCommitPublished() { assert.fail('no commit for unchanged bytes') } }))
  lock.release(); assert.equal(result.txId, ''); assert.equal(result.snapshot, f.loaded)
  assert.equal(fs.existsSync(path.join(f.root, '.agent-config.transactions')), false)
})

for (const cut of ['locked', 'active', 'displaced', 'linked', 'commit', 'cleared']) {
  test(`a real process killed at ${cut} recovers the complete decided group and never revives the old revision`, async t => {
    const f = await fixture(t), stopped = await child(f, 'write', cut)
    assert.equal(stopped.signal, 'SIGKILL', stopped.stderr); assert.match(stopped.stdout, new RegExp('cut:' + cut))
    assert.equal(inspect(f.hostFile).phase, 'recovery-required')
    assert.throws(() => read(f.hostFile), { code: 'conflict' })
    const recovered = await child(f, 'recover')
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr)
    const result = JSON.parse(recovered.stdout)
    assert.deepEqual(result.sources, ['commit', 'cleared'].includes(cut) ? next : old)
    assert.deepEqual(read(f.hostFile).sources, result.sources)
    if (cut !== 'locked') assert.notEqual(result.revision, f.loaded.revision)
    assert.deepEqual(inspect(f.hostFile), { phase: 'clean' })
    assert.equal((await child(f, 'recover')).code, 0)
  })
}

for (const [originalCut, recoveryCut] of [['linked', 'recover-displaced'], ['linked', 'recover-linked'], ['commit', 'recover-head'], ['commit', 'recover-maintenance-cleared']]) {
  test(`recovery killed at ${recoveryCut} after ${originalCut} can be inherited once and completed`, async t => {
    const f = await fixture(t)
    assert.equal((await child(f, 'write', originalCut)).signal, 'SIGKILL')
    const interrupted = await child(f, 'recover', recoveryCut)
    assert.equal(interrupted.signal, 'SIGKILL', interrupted.stdout + interrupted.stderr)
    const result = await child(f, 'recover')
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.deepEqual(read(f.hostFile).sources, originalCut === 'commit' ? next : old)
    assert.notEqual(read(f.hostFile).revision, f.loaded.revision)
  })
}

test('a deleted untouched dependency is an external conflict, not permission to recreate it', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), original = fs.renameSync
  fs.renameSync = function(from, to) {
    const result = original.call(this, from, to)
    if (from === f.hostFile) fs.unlinkSync(path.join(f.root, 'agent-bindings.yaml'))
    return result
  }
  try { assert.throws(() => lock.commitSources(next, f.loaded, hooks()), { code: 'conflict' }) }
  finally { fs.renameSync = original; lock.release() }
  assert.equal(fs.existsSync(path.join(f.root, 'agent-bindings.yaml')), false)
  assert.equal(inspect(f.hostFile).phase, 'blocked')
})

test('a contending writer never unlinks an equal-byte replacement of its prepared owner', async t => {
  const f = await fixture(t), first = await acquire(f.loaded, guard()), controller = new AbortController(), original = fs.linkSync
  let replacement, bytes
  fs.linkSync = function(from, to) {
    if (to === path.join(f.root, '.agent-config.write.lock') && from !== replacement) {
      replacement = from; bytes = fs.readFileSync(from, 'utf8')
      fs.renameSync(from, from + '.original')
      fs.writeFileSync(from, bytes, { flag: 'wx', mode: 0o600 })
      controller.abort()
    }
    return original.call(this, from, to)
  }
  try { await assert.rejects(acquire(f.loaded, { signal: controller.signal, ensureCurrent() {} }), { code: 'conflict' }) }
  finally { fs.linkSync = original; first.release() }
  assert.ok(replacement)
  assert.equal(fs.readFileSync(replacement, 'utf8'), bytes)
  assert.notEqual(fs.statSync(replacement).ino, fs.statSync(replacement + '.original').ino)
})

test('an external replacement observed by the action read cannot become a registered original', async t => {
  const f = await fixture(t), lock = await acquire(f.loaded, guard()), original = fs.openSync
  let injected = false
  fs.openSync = function(name, flags, ...args) {
    if (!injected && name === f.hostFile && typeof flags === 'number' && (flags & 3) === 0 && new Error().stack.includes('addAction')) {
      injected = true
      fs.renameSync(f.hostFile, f.hostFile + '.external-original')
      fs.writeFileSync(f.hostFile, old.host, { flag: 'wx', mode: 0o600 })
    }
    return original.call(this, name, flags, ...args)
  }
  try { assert.throws(() => lock.commitSources(next, f.loaded, hooks()), { code: 'conflict' }) }
  finally { fs.openSync = original; lock.release() }
  assert.equal(injected, true)
  assert.deepEqual(fileSources(f), old)
  assert.notEqual(fs.statSync(f.hostFile).ino, fs.statSync(f.hostFile + '.external-original').ino)
  assert.equal(inspect(f.hostFile).phase, 'blocked')
})

test('offline recovery rejects an equal-byte replacement of the anchored write lock', async t => {
  const f = await fixture(t)
  assert.equal((await child(f, 'write', 'active')).signal, 'SIGKILL')
  const name = path.join(f.root, '.agent-config.write.lock'), bytes = fs.readFileSync(name, 'utf8')
  fs.renameSync(name, name + '.external-original'); fs.writeFileSync(name, bytes, { flag: 'wx', mode: 0o600 })
  assert.equal(inspect(f.hostFile).phase, 'blocked')
  assert.throws(() => recover(f.hostFile, { ensureOfflineCurrent() {} }), { code: 'conflict' })
  assert.equal(fs.readFileSync(name, 'utf8'), bytes)
  assert.notEqual(fs.statSync(name).ino, fs.statSync(name + '.external-original').ino)
  assert.deepEqual(fileSources(f), old)
})
