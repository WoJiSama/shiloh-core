import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { executeAgentDiceScript: runScript, executeAgentDiceScriptSync: runScriptSync,
  executeDarwinAgentDiceScriptDiagnostic: executeAgentDiceScript, executeDarwinAgentDiceScriptDiagnosticSync: executeAgentDiceScriptSync,
  toAgentDiceScriptJson, captureAgentDiceScriptRunner, validateAgentDiceScriptRunner, AGENT_DICE_SCRIPT_LIMITS } = await load('modules/dice/infrastructure/agentDiceScriptProcess.js')
const available = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') && process.allowedNodeEnvironmentFlags.has('--permission')
const options = { skip: !available, timeout: 15_000 }
const at = 1_800_000_000_000
const input = changes => ({ source: 'var output = null;', operation: 'execute', kind: 'js', at, randomValues: [], expression: 'output', ...changes })
const privateError = 'DO-NOT-EXPOSE-SCRIPT-ERROR-087496'

// These functions are diagnostic probes, not production-qualified runners: the
// Darwin implementation has no OS hard total-process memory limit.
test('Darwin diagnostic uses a real child and fixed random and clock values, with a host-owned consumed count', options, async () => {
  const old = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'SCRIPT-HOST-CREDENTIAL-MUST-NOT-ENTER-CHILD'
  try {
    const request = input({ source: 'var output = {one:Math.random(),two:__random(),now:Date.now(),date:+new Date(),text:Date(),explicit:+new Date(12),require:typeof require,process:typeof process,fetch:typeof fetch,timers:typeof setTimeout};', randomValues: [0.1, 0.8, 0.7] })
    const first = await executeAgentDiceScript(request), second = executeAgentDiceScriptSync(request)
    assert.deepEqual(second, first)
    assert.deepEqual(first.value, { one: 0.1, two: 0.8, now: at, date: at, text: 'Fri Jan 15 2027 08:00:00 GMT+0000 (Coordinated Universal Time)', explicit: 12,
      require: 'undefined', process: 'undefined', fetch: 'undefined', timers: 'undefined' })
    assert.equal(first.consumedRandom, 2)
    assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.value), true)
    assert.ok(!JSON.stringify(first).includes(process.env.OPENAI_API_KEY))
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old }
})

test('the production entry point defaults to unavailable even on Darwin, with no implicit diagnostic fallback', async () => {
  await assert.rejects(runScript(input()), /骰子脚本隔离环境不可用/u)
  assert.throws(() => runScriptSync(input()), /骰子脚本隔离环境不可用/u)
  await assert.rejects(runScript(input(), { runner: executeAgentDiceScript }), /骰子脚本隔离环境不可用/u)
  assert.throws(() => runScriptSync(input(), { runner: executeAgentDiceScriptSync }), /骰子脚本隔离环境不可用/u)
})

function contractDouble(changes = {}) {
  return { definitionId: 'unit-test-contract-double', limits: { ...AGENT_DICE_SCRIPT_LIMITS },
    isolation: { execution: 'separate-process', filesystem: 'deny', network: 'deny', subprocess: 'deny', totalMemory: 'os-hard-total-process',
      evidence: 'Contract wiring fixture only; this double never executes supplied scripts and is not isolation evidence.' },
    execute: async () => ({ value: { called: 'async' }, consumedRandom: 0 }), executeSync: () => ({ value: { called: 'sync' }, consumedRandom: 0 }), ...changes }
}

test('host runner contract shape, immutable capture and closed JSON results are enforced independently of OS attestation', async () => {
  let calls = 0, getters = 0, traps = 0
  const original = contractDouble({ execute: async request => { calls++; assert.equal(Object.isFrozen(request), true); return { value: { called: 'captured' }, consumedRandom: 1 } } })
  const captured = captureAgentDiceScriptRunner(original)
  original.definitionId = 'changed'; original.limits.totalMemoryBytes = 1; original.isolation.evidence = 'changed'; original.execute = async () => { throw Error('changed') }
  assert.equal(captured.definitionId, 'unit-test-contract-double'); assert.equal(captured.limits.totalMemoryBytes, AGENT_DICE_SCRIPT_LIMITS.totalMemoryBytes)
  assert.equal(captured.isolation.evidence.startsWith('Contract wiring fixture'), true)
  assert.equal(Object.isFrozen(captured), true); assert.equal(Object.isFrozen(captured.limits), true); assert.equal(Object.isFrozen(captured.isolation), true)
  assert.deepEqual(await runScript(input({ randomValues: [0.25] }), { runner: captured }), { value: { called: 'captured' }, consumedRandom: 1 })
  assert.deepEqual(runScriptSync(input(), { runner: captured }), { value: { called: 'sync' }, consumedRandom: 0 })
  assert.equal(calls, 1)
  for (const invalid of [
    contractDouble({ definitionId: '' }), contractDouble({ execute: undefined }), contractDouble({ executeSync: undefined }),
    contractDouble({ limits: { ...AGENT_DICE_SCRIPT_LIMITS, totalMemoryBytes: AGENT_DICE_SCRIPT_LIMITS.totalMemoryBytes + 1 } }),
    contractDouble({ isolation: { ...captured.isolation, totalMemory: 'v8-old-space-only' } }),
    contractDouble({ isolation: { ...captured.isolation, evidence: '' } }),
    { ...contractDouble(), get isolation() { getters++; return captured.isolation } },
    new Proxy(contractDouble(), { ownKeys() { traps++; return [] } }),
  ]) {
    assert.throws(() => validateAgentDiceScriptRunner(invalid), /骰子脚本隔离环境不可用/u)
    await assert.rejects(runScript(input(), { runner: invalid }), /骰子脚本隔离环境不可用/u)
  }
  for (const result of [{ value: 1, consumedRandom: 1 }, { value: 1, consumedRandom: -1 }, { value: 1, consumedRandom: 0, extra: true },
    { get value() { getters++; return 1 }, consumedRandom: 0 }, new Proxy({ value: 1, consumedRandom: 0 }, { ownKeys() { traps++; return [] } })]) {
    const runner = contractDouble({ execute: async () => result, executeSync: () => result })
    await assert.rejects(runScript(input(), { runner }), /骰子脚本执行未确认/u)
    assert.throws(() => runScriptSync(input(), { runner }), /骰子脚本执行未确认/u)
  }
  const failed = contractDouble({ execute: async () => { throw Error(privateError) }, executeSync: () => { throw Error(privateError) } })
  await assert.rejects(runScript(input(), { runner: failed }), error => error.message === '骰子脚本执行未确认')
  assert.throws(() => runScriptSync(input(), { runner: failed }), error => error.message === '骰子脚本执行未确认')
  assert.equal(getters, 0); assert.equal(traps, 0)
})

test('trusted setup, source and post-dispatch stages share only JSON and drain promised results before expression extraction', options, async () => {
  const result = await executeAgentDiceScript(input({
    setupCode: 'var input=JSON.parse(__input),module={exports:{}},effects=[];',
    source: 'module.exports = { run(){return Promise.resolve({n:Math.floor(Math.random()*6)+1,text:input.text})} };',
    afterCode: 'var output=null;module.exports.run().then(value=>{output=value;effects.push("complete")});',
    expression: '({output,effects})', input: { text: 'input-as-data' }, randomValues: [0.5],
  }))
  assert.deepEqual(result, { value: { output: { n: 4, text: 'input-as-data' }, effects: ['complete'] }, consumedRandom: 1 })
  const payload = await executeAgentDiceScript(input({ source: 'var output=JSON.parse(__input);', payload: { string: 'string-as-data', object: [1, true, null] } }))
  assert.deepEqual(payload.value, { string: 'string-as-data', object: [1, true, null] })
})

test('random exhaustion, attempts to replace random and ambient date escape fail without accepting partial results', options, async () => {
  for (const source of [
    'var output=Math.random();',
    'try{Math.random()}catch{}var output=1;',
    'Object.defineProperty(Math,"random",{value:()=>0.9});var output=1;',
    'Object.defineProperty(globalThis,"__random",{value:()=>0.9});var output=1;',
    'var output=(new Date()).constructor.constructor("return Date.now()")();',
  ]) await assert.rejects(executeAgentDiceScript(input({ source })), /骰子脚本执行未确认/u)
  const original = await executeAgentDiceScript(input({ source: 'Math.random=()=>1;Date.now=()=>1;var output=[Math.random(),Date.now(),Date.prototype.constructor.now()];', randomValues: [0.25] }))
  assert.deepEqual(original, { value: [0.25, at, at], consumedRandom: 1 })
})

test('mutable script intrinsics cannot expose native clock or backing-store constructors', options, async () => {
  const result = await executeAgentDiceScript(input({ source: `
    var targets=[],nativeConstruct=Reflect.construct,nativeApply=Reflect.apply;
    Reflect.construct=function(target,args,newTarget){targets.push(target.name);return nativeConstruct(target,args,newTarget)};
    Reflect.apply=function(target,receiver,args){targets.push(target.name);return nativeApply(target,receiver,args)};
    var date=new Date(),buffer=new ArrayBuffer(4),typed=new Uint8Array([1,2]),copy=typed.toReversed(),slice=buffer.slice(0);
    var output={targets,now:+date,buffer:slice.byteLength,typed:Array.from(copy)};
  ` }))
  assert.deepEqual(result.value, { targets: [], now: at, buffer: 4, typed: [2, 1] })
  const arraylike = await executeAgentDiceScript(input({ source: `
    var iterators=0;
    Array.prototype[Symbol.iterator]=function*(){iterators++;yield 100;yield 101};
    Array.prototype.push=function(){this.length=999999999};
    var typed=new Uint8Array({0:7,length:1});var output={length:typed.length,first:typed[0],iterators};
  ` }))
  assert.deepEqual(arraylike.value, { length: 1, first: 7, iterators: 0 })
})

test('module, process, filesystem, child process, worker, addon and dynamic-code access are refused', options, async () => {
  const sources = [
    'var output=require("node:fs").readFileSync("/etc/passwd","utf8");',
    'var output=process.env;',
    'var output=({}).constructor.constructor("return process")().env;',
    'var output=this.constructor.constructor("return process")().env;',
    'var output=__random.constructor("return process")().env;',
    'var output=JSON.parse.constructor("return process")().env;',
    'var output=Function("return process")().env;',
    'var output=eval("process.env");',
    'var output=import("node:fs");',
    'var output=require("node:child_process").execSync("true");',
    'var output=new (require("node:worker_threads").Worker)("",{eval:true});',
    'process.dlopen({},"/tmp/untrusted.node");var output=true;',
    'var output=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));',
  ]
  for (const source of sources) await assert.rejects(executeAgentDiceScript(input({ source })), /骰子脚本执行未确认/u)
})

test('script code cannot read credentials, write files or connect to a local socket', options, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dice-script-boundary-')), file = path.join(directory, 'secret.txt'), written = path.join(directory, 'must-not-exist')
  await fs.writeFile(file, privateError)
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const server = createServer(socket => { connections++; socket.destroy() })
  let connections = 0
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const escape = '(Function("return this")())'
  for (const source of [
    `var output=require("node:fs").readFileSync(${JSON.stringify(file)},"utf8");`,
    `var output=${escape}.process.mainModule?.require("node:fs").readFileSync(${JSON.stringify(file)},"utf8");`,
    `require("node:fs").writeFileSync(${JSON.stringify(written)},"unsafe");var output=true;`,
    `require("node:net").connect(${port},"127.0.0.1");var output=true;`,
  ]) await assert.rejects(executeAgentDiceScript(input({ source })), error => /骰子脚本执行未确认/u.test(error.message) && !error.message.includes(privateError))
  assert.equal(await fs.stat(written).then(() => true, () => false), false)
  assert.equal(connections, 0)
})

test('the actual OS profile independently denies filesystem, network and subprocess effects when the Node permission layer is absent', options, async t => {
  const nativeSpawn = childProcess.spawn, nativeSpawnSync = childProcess.spawnSync
  let captured
  const observer = mock.method(childProcess, 'spawn', (command, args, settings) => {
    captured = { command, args: [...args], settings }
    return nativeSpawn(command, args, settings)
  })
  syncBuiltinESMExports()
  try { await executeAgentDiceScript(input({ source: 'var output=true;' })) }
  finally { observer.mock.restore(); syncBuiltinESMExports() }
  assert.equal(captured.command, '/usr/bin/sandbox-exec')
  assert.equal(captured.settings.cwd, '/')
  assert.deepEqual(captured.settings.env, { LANG: 'C', LC_ALL: 'C', TZ: 'UTC', UV_THREADPOOL_SIZE: '1' })
  for (const flag of ['--permission', '--max-old-space-size=64', '--stack-size=512', '--jitless', '--no-addons']) assert.ok(captured.args.includes(flag))
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dice-script-os-')), secret = path.join(directory, 'secret.txt'), written = path.join(directory, 'must-not-exist')
  await fs.writeFile(secret, privateError)
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let connections = 0
  const server = createServer(socket => { connections++; socket.destroy() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  // This is fixed trusted probe code, deliberately without --permission. It runs
  // under the exact profile captured from the real bridge, so VM restrictions
  // and Node's permission model cannot be mistaken for the OS-boundary proof.
  const probe = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
    const result={read:false,write:false,child:false,network:false,errors:{}};
    try{fs.readFileSync(${JSON.stringify(secret)});result.read=true}catch(e){result.errors.read=e.code}
    try{fs.writeFileSync(${JSON.stringify(written)},'unsafe');result.write=true}catch(e){result.errors.write=e.code}
    try{const r=cp.spawnSync(process.execPath,['--eval','process.stdout.write("unsafe")'],{stdio:'ignore'});result.child=r.status===0;result.errors.child=r.error?.code}catch(e){result.errors.child=e.code}
    const socket=net.connect(${port},'127.0.0.1');
    socket.on('connect',()=>{result.network=true;socket.destroy()});
    socket.on('error',e=>{result.errors.network=e.code});socket.on('close',()=>process.stdout.write(JSON.stringify(result)));
    setTimeout(()=>{socket.destroy()},400).unref();`
  const result = nativeSpawnSync(captured.command, [...captured.args.slice(0, 3), '--input-type=commonjs', '--eval', probe], {
    cwd: captured.settings.cwd, env: captured.settings.env, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 32768,
  })
  assert.equal(result.status, 0, 'the isolated fixed probe must initialize normally')
  assert.deepEqual(JSON.parse(result.stdout.toString()), { read: false, write: false, child: false, network: false,
    errors: { read: 'EPERM', write: 'EPERM', child: 'EPERM', network: 'EPERM' } })
  assert.equal(await fs.stat(written).then(() => true, () => false), false)
  await delay(20)
  assert.equal(connections, 0)
})

test('closed JSON extraction rejects getters, Proxy, symbols, cycles, sparse arrays, functions and nonfinite values', options, async () => {
  for (const source of [
    'var output={get value(){while(true){}}};',
    'var output=new Proxy({value:1},{get(){while(true){}}});',
    'var output={[Symbol("hidden")]:true};',
    'var output={};output.self=output;',
    'var output=[];output.length=1;',
    'var output={value:undefined};',
    'var output={value:()=>1};',
    'var output=Object.create({inherited:true});',
    'var output={value:NaN};',
    'var output={value:Infinity};',
    'var output={value:1n};',
    'var output=Promise.resolve(1);',
  ]) await assert.rejects(executeAgentDiceScript(input({ source })), /骰子脚本执行未确认/u)
})

test('wall, heap, backing-store and output limits terminate the child and leave the host usable', { ...options, timeout: 20_000 }, async () => {
  for (const source of [
    'while(true){}',
    'Promise.resolve().then(()=>{while(true){}});var output=1;',
    'var items=[];while(true){items.push(new Array(100000).fill(1))}',
    'var output="x".repeat(2*1024*1024);',
    'var output=new ArrayBuffer(256*1024*1024);',
    'var output=new Uint8Array(256*1024*1024);',
    'var output=(new Uint8Array(1)).constructor(256*1024*1024);',
    'var buffer=new ArrayBuffer(5*1024*1024);Object.defineProperty(buffer,"byteLength",{value:0});buffer.slice(0);var output=true;',
    'var bytes=new Uint8Array(5*1024*1024);Object.defineProperty(bytes,"byteLength",{value:0});bytes.toReversed();var output=true;',
    'var bytes=new Uint8Array(5*1024*1024);Object.defineProperty(bytes,"byteLength",{value:0});bytes.toSorted();var output=true;',
    'var bytes=new Uint8Array(5*1024*1024);Object.defineProperty(bytes,"byteLength",{value:0});bytes.with(0,1);var output=true;',
    'Uint8Array.from({length:9*1024*1024});var output=true;',
    'Number.isSafeInteger=()=>true;try{new ArrayBuffer(NaN)}catch{}new ArrayBuffer(9*1024*1024);var output=true;',
    'var output=new WebAssembly.Memory({initial:4096});',
    'var buffer=new ArrayBuffer(1);buffer.resize(9*1024*1024);var output=true;',
    'var buffer=new ArrayBuffer(1);buffer.transfer(9*1024*1024);var output=true;',
    'var buffer=new ArrayBuffer(1);buffer.transferToFixedLength(9*1024*1024);var output=true;',
  ]) {
    const started = performance.now()
    await assert.rejects(executeAgentDiceScript(input({ source })), /骰子脚本执行未确认/u)
    assert.ok(performance.now() - started < 2500, 'bounded script must return before an unbounded host wait')
  }
  assert.deepEqual(await executeAgentDiceScript(input({ source: 'var output={alive:true};' })), { value: { alive: true }, consumedRandom: 0 })
  const started = performance.now()
  assert.throws(() => executeAgentDiceScriptSync(input({ source: 'while(true){}' })), /骰子脚本执行未确认/u)
  assert.ok(performance.now() - started < 2500)
})

test('host JSON conversion bounds shared expansion and never invokes caller getters, Proxy or toJSON hooks', () => {
  let getters = 0, traps = 0, serializations = 0
  const accessor = { get value() { getters++; return 1 } }, proxy = new Proxy({ value: 1 }, { ownKeys() { traps++; return ['value'] } })
  const hook = { toJSON() { serializations++; return {} } }
  let shared = { value: 1 }
  for (let depth = 0; depth < 28; depth++) shared = { left: shared, right: shared }
  for (const value of [accessor, proxy, hook, shared, { text: 'x'.repeat(1024 * 1024) }]) assert.throws(() => toAgentDiceScriptJson(value), /骰子脚本执行未确认/u)
  assert.equal(getters, 0); assert.equal(traps, 0); assert.equal(serializations, 0)
  const value = toAgentDiceScriptJson({ text: 'closed-json', nested: [1, true, null] })
  assert.deepEqual(value, { text: 'closed-json', nested: [1, true, null] })
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.nested), true)
})

test('abort kills an executing child, awaits close and supports subsequent scripts; sync honors pre-abort', options, async () => {
  const controller = new AbortController(), pending = executeAgentDiceScript(input({ source: 'while(true){}' }), { signal: controller.signal })
  await delay(30); const started = performance.now(); controller.abort()
  await assert.rejects(pending, /骰子脚本执行已取消/u)
  assert.ok(performance.now() - started < 1000)
  await assert.rejects(executeAgentDiceScript(input(), { signal: controller.signal }), /骰子脚本执行已取消/u)
  assert.throws(() => executeAgentDiceScriptSync(input(), { signal: controller.signal }), /骰子脚本执行已取消/u)
  assert.equal((await executeAgentDiceScript(input({ source: 'var output=42;' }))).value, 42)
})

test('validation is bounded, closed and does not run caller code or leak source errors', options, async () => {
  let getters = 0, traps = 0
  const cyclic = {}; cyclic.self = cyclic
  const sparse = []; sparse.length = 1
  for (const request of [
    input({ source: '' }), input({ source: 'x'.repeat(65537) }), input({ operation: 'other' }), input({ kind: 'yaml' }),
    input({ at: '1' }), input({ at: -1 }), input({ at: NaN }), input({ randomValues: [1] }), input({ randomValues: [-0.1] }),
    input({ randomValues: [NaN] }), input({ randomValues: sparse }), input({ randomValues: Array(32769).fill(0.5) }),
    input({ input: cyclic }), input({ input: new Date() }), input({ input: { x: 'a'.repeat(1024 * 1024) } }),
    input({ input: {}, payload: {} }), input({ unknown: true }),
    { ...input(), get source() { getters++; return 'var output=1;' } },
    new Proxy(input(), { get() { traps++; throw Error('must not run') } }),
  ]) await assert.rejects(executeAgentDiceScript(request), /骰子脚本执行未确认/u)
  assert.equal(getters, 0); assert.equal(traps, 0)
  await assert.rejects(executeAgentDiceScript(input({ source: `throw new Error(${JSON.stringify(privateError)});` })), error =>
    error.message === '骰子脚本执行未确认' && !error.message.includes(privateError))
})

test('an unverified platform fails closed rather than executing in an unprotected VM', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    for (const platform of ['linux', 'win32']) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      await assert.rejects(executeAgentDiceScript(input()), /骰子脚本隔离环境不可用/u)
      assert.throws(() => executeAgentDiceScriptSync(input()), /骰子脚本隔离环境不可用/u)
    }
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})
