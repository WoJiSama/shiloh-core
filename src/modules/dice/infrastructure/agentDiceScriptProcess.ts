import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import runtimeProcess from 'node:process'
import { types } from 'node:util'

export type AgentDiceScriptJson = null | boolean | number | string | readonly AgentDiceScriptJson[] | { readonly [key: string]: AgentDiceScriptJson }
export interface AgentDiceScriptInput {
  readonly source: string
  readonly operation: 'inspect' | 'execute'
  readonly kind: 'js' | 'seal'
  readonly at: number
  readonly randomValues: readonly number[]
  /** Trusted host constants only. Never forward these fields from package configuration. */
  readonly setupCode?: string
  readonly afterCode?: string
  readonly expression?: string
  readonly input?: AgentDiceScriptJson
  readonly payload?: AgentDiceScriptJson
}
export interface AgentDiceScriptResult { readonly value: AgentDiceScriptJson; readonly consumedRandom: number }
export interface AgentDiceScriptRunOptions { readonly signal?: AbortSignal }
export interface AgentDiceScriptOptions extends AgentDiceScriptRunOptions { readonly runner?: AgentDiceScriptRunner }
export const AGENT_DICE_SCRIPT_LIMITS = Object.freeze({ cpuMs: 1000, wallMs: 1500, totalMemoryBytes: 128 * 1024 * 1024,
  inputBytes: 1024 * 1024, outputBytes: 1024 * 1024, stderrBytes: 32 * 1024, ioBytes: 2 * 1024 * 1024 })
export type AgentDiceScriptLimits = { readonly [Key in keyof typeof AGENT_DICE_SCRIPT_LIMITS]: number }
/** A trusted host adapter, never package-supplied data. Its evidence must name a
 * verified OS boundary and total-process hard memory quota, covering native and
 * backing-store allocations as well as the language heap. Both calls must kill
 * and reap their process on limits/cancellation before settling. Metadata alone
 * cannot establish these guarantees; the adapter owner supplies and verifies
 * them. The built-in Darwin diagnostic intentionally cannot implement this. */
export interface AgentDiceScriptRunner {
  readonly definitionId: string
  readonly limits: AgentDiceScriptLimits
  readonly isolation: {
    readonly execution: 'separate-process'
    readonly filesystem: 'deny'
    readonly network: 'deny'
    readonly subprocess: 'deny'
    readonly totalMemory: 'os-hard-total-process'
    readonly evidence: string
  }
  execute(input: AgentDiceScriptInput, options: AgentDiceScriptRunOptions): Promise<AgentDiceScriptResult>
  executeSync(input: AgentDiceScriptInput, options: AgentDiceScriptRunOptions): AgentDiceScriptResult
}

const MAX_SOURCE = 64 * 1024
const MAX_INPUT = 1024 * 1024
const MAX_OUTPUT = 1024 * 1024
const MAX_STDERR = 32 * 1024
const MAX_IO = 2 * 1024 * 1024
const MAX_WALL_MS = AGENT_DICE_SCRIPT_LIMITS.wallMs
const MAX_DRAWS = 32768
// Darwin's RSS rlimit is advisory and its address-space limit cannot provide a
// small Node budget. Heap, backing stores, stack and wall time are bounded
// separately below; these are not an OS hard limit on total process RSS.
const unavailable = () => new Error('骰子脚本隔离环境不可用')
const rejected = () => new Error('骰子脚本执行未确认')
const cancelled = () => new Error('骰子脚本执行已取消')

function jsonCopy(value: unknown, seen = new Set<object>(), depth = 0, budget = { bytes: MAX_INPUT, nodes: 131072 }): AgentDiceScriptJson {
  const spend = (bytes: number) => { budget.bytes -= bytes; if (budget.bytes < 0) throw rejected() }
  if (depth > 32 || --budget.nodes < 0) throw rejected()
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) {
    if (typeof value === 'string' && Buffer.byteLength(value) > budget.bytes) throw rejected()
    spend(Buffer.byteLength(JSON.stringify(value))); return value
  }
  if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw rejected()
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw rejected()
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw rejected()
  seen.add(value)
  try {
    if (array) {
      if (value.length > MAX_DRAWS || keys.length !== value.length + 1) throw rejected()
      spend(2 + Math.max(0, value.length - 1))
      const output: AgentDiceScriptJson[] = []
      for (let index = 0; index < value.length; index++) {
        const field = Object.getOwnPropertyDescriptor(value, String(index))
        if (!field || !('value' in field) || !field.enumerable) throw rejected()
        output.push(jsonCopy(field.value, seen, depth + 1, budget))
      }
      return Object.freeze(output)
    }
    if (keys.length > 4096) throw rejected()
    spend(2 + Math.max(0, keys.length - 1))
    const output: Record<string, AgentDiceScriptJson> = {}
    for (const key of keys as string[]) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !('value' in field) || !field.enumerable) throw rejected()
      if (Buffer.byteLength(key) > budget.bytes) throw rejected()
      spend(Buffer.byteLength(JSON.stringify(key)) + 1)
      output[key] = jsonCopy(field.value, seen, depth + 1, budget)
    }
    return Object.freeze(output)
  } finally { seen.delete(value) }
}
/** Copies closed JSON data without invoking getters, toJSON hooks or Proxy traps. */
export function toAgentDiceScriptJson(value: unknown): AgentDiceScriptJson { return jsonCopy(value) }
function record(value: AgentDiceScriptJson): Record<string, AgentDiceScriptJson> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw rejected()
  return value as Record<string, AgentDiceScriptJson>
}
function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) throw unavailable()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw unavailable()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) throw unavailable()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field || !('value' in field)) throw unavailable()
    result[key] = field.value
  }
  return result
}
function runnerSnapshot(value: unknown): AgentDiceScriptRunner {
  const fields = dataRecord(value, ['definitionId', 'limits', 'isolation', 'execute', 'executeSync'])
  if (typeof fields.definitionId !== 'string' || !fields.definitionId.trim() || fields.definitionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(fields.definitionId) ||
      typeof fields.execute !== 'function' || types.isProxy(fields.execute) || typeof fields.executeSync !== 'function' || types.isProxy(fields.executeSync)) throw unavailable()
  const limits = dataRecord(fields.limits, Object.keys(AGENT_DICE_SCRIPT_LIMITS))
  for (const key of Object.keys(AGENT_DICE_SCRIPT_LIMITS) as (keyof AgentDiceScriptLimits)[]) {
    const limit = limits[key]
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_DICE_SCRIPT_LIMITS[key]) throw unavailable()
  }
  const isolation = dataRecord(fields.isolation, ['execution', 'filesystem', 'network', 'subprocess', 'totalMemory', 'evidence'])
  if (isolation.execution !== 'separate-process' || isolation.filesystem !== 'deny' || isolation.network !== 'deny' || isolation.subprocess !== 'deny' ||
      isolation.totalMemory !== 'os-hard-total-process' || typeof isolation.evidence !== 'string' || !isolation.evidence.trim() || isolation.evidence.length > 8192) throw unavailable()
  return Object.freeze({ definitionId: fields.definitionId, limits: Object.freeze(limits) as AgentDiceScriptLimits,
    isolation: Object.freeze(isolation) as AgentDiceScriptRunner['isolation'], execute: fields.execute as AgentDiceScriptRunner['execute'], executeSync: fields.executeSync as AgentDiceScriptRunner['executeSync'] })
}
/** Shape checks the trusted adapter contract; this does not verify an OS quota. */
export function validateAgentDiceScriptRunner(value: unknown): asserts value is AgentDiceScriptRunner { runnerSnapshot(value) }
/** Captures metadata and call targets for binding into an immutable definition. */
export function captureAgentDiceScriptRunner(value: unknown): AgentDiceScriptRunner { return runnerSnapshot(value) }
function prepared(input: AgentDiceScriptInput) {
  const value = record(jsonCopy(input))
  if (Object.keys(value).some(key => !['source', 'operation', 'kind', 'at', 'randomValues', 'setupCode', 'afterCode', 'expression', 'input', 'payload'].includes(key)) ||
      typeof value.source !== 'string' || !value.source.trim() || Buffer.byteLength(value.source) > MAX_SOURCE ||
      value.operation !== 'inspect' && value.operation !== 'execute' || value.kind !== 'js' && value.kind !== 'seal' ||
      typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at < 0 || !Number.isFinite(new Date(value.at).getTime()) ||
      !Array.isArray(value.randomValues) || value.randomValues.length > MAX_DRAWS ||
      value.randomValues.some(draw => typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1) ||
      Object.hasOwn(value, 'input') && Object.hasOwn(value, 'payload')) throw rejected()
  for (const [key, max] of [['setupCode', 256 * 1024], ['afterCode', 64 * 1024], ['expression', 64 * 1024]] as const) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || Buffer.byteLength(value[key]) > max)) throw rejected()
  }
  const raw = Buffer.from(JSON.stringify(value))
  if (raw.byteLength > MAX_INPUT) throw rejected()
  return { raw, draws: value.randomValues.length, input: value as unknown as AgentDiceScriptInput }
}

// The function is stringified only after TypeScript transpilation. It executes in
// the child and has no closed-over host values or workspace module imports.
function scriptWorkerMain() {
  'use strict'
  const vm: typeof import('node:vm') = require('node:vm')
  const util: typeof import('node:util') = require('node:util')
  const runtimeProcess: typeof import('node:process') = require('node:process')
  const write = runtimeProcess.stdout.write.bind(runtimeProcess.stdout), exit = runtimeProcess.exit.bind(runtimeProcess)
  const stringify = JSON.stringify, parse = JSON.parse, ownKeys = Reflect.ownKeys
  const descriptor = Object.getOwnPropertyDescriptor, getPrototype = Object.getPrototypeOf, isArray = Array.isArray
  const hasOwn = Object.hasOwn, isFiniteNumber = Number.isFinite, isProxy = util.types.isProxy
  let chunks: Buffer[] = [], bytes = 0, ended = false
  const fail = () => { if (ended) return; ended = true; write('{"ok":false}', () => exit(1)) }
  runtimeProcess.on('uncaughtException', fail)
  runtimeProcess.on('unhandledRejection', fail)
  Object.defineProperty(Math, 'random', { value: () => { throw Error('ambient randomness disabled') }, writable: false, configurable: false })
  function copy(value: unknown, objectPrototype: object, arrayPrototype: object, seen = new Set<object>(), depth = 0): unknown {
    if (depth > 32) throw Error('depth')
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number' && isFiniteNumber(value)) return value
    if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value)) throw Error('json')
    const array = isArray(value), prototype = getPrototype(value)
    if (array ? prototype !== arrayPrototype : prototype !== objectPrototype && prototype !== null) throw Error('prototype')
    const keys = ownKeys(value)
    if (keys.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('key')
    seen.add(value)
    try {
      if (array) {
        if (value.length > 32768 || keys.length !== value.length + 1) throw Error('array')
        const output: unknown[] = []
        for (let index = 0; index < value.length; index++) {
          const field = descriptor(value, String(index))
          if (!field || !hasOwn(field, 'value') || !field.enumerable) throw Error('field')
          output.push(copy(field.value, objectPrototype, arrayPrototype, seen, depth + 1))
        }
        return output
      }
      if (keys.length > 4096) throw Error('fields')
      const output: Record<string, unknown> = {}
      for (const key of keys as string[]) {
        const field = descriptor(value, key)
        if (!field || !hasOwn(field, 'value') || !field.enumerable) throw Error('field')
        output[key] = copy(field.value, objectPrototype, arrayPrototype, seen, depth + 1)
      }
      return output
    } finally { seen.delete(value) }
  }
  function run(request: Record<string, unknown>) {
    if (!runtimeProcess.permission || ['fs.read', 'fs.write', 'child', 'worker', 'addons', 'wasi', 'inspector'].some(scope => runtimeProcess.permission.has(scope))) throw Error('permissions')
    const globals: Record<string, unknown> = Object.create(null)
    globals.__input = stringify(hasOwn(request, 'input') ? request.input : hasOwn(request, 'payload') ? request.payload : null)
    globals.__at = request.at
    globals.__randomValues = stringify(request.randomValues)
    const context = vm.createContext(globals, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
    const script = (text: string): unknown => new vm.Script(text, { filename: 'dice-script' }).runInContext(context, { timeout: 1000, breakOnSigint: false })
    const controls = script('(()=>{' +
      'const tape=JSON.parse(__randomValues),at=__at,construct=Reflect.construct,apply=Reflect.apply,toNumber=Number,isSafeInteger=Number.isSafeInteger;let consumed=0,exhausted=false;' +
      'function draw(){if(consumed>=tape.length){exhausted=true;throw Error("random exhausted")}return tape[consumed++]}' +
      'Object.defineProperty(globalThis,"__random",{value:draw,writable:false,configurable:false});' +
      'Object.defineProperty(Math,"random",{value:draw,writable:false,configurable:false});' +
      'const NativeDate=Date;function FixedDate(...args){if(!new.target)return new NativeDate(at).toString();return construct(NativeDate,args.length?args:[at],new.target)}' +
      'FixedDate.prototype=NativeDate.prototype;Object.defineProperty(NativeDate.prototype,"constructor",{value:FixedDate,writable:false,configurable:false});' +
      'Object.defineProperties(FixedDate,{now:{value:()=>at},parse:{value:NativeDate.parse.bind(NativeDate)},UTC:{value:NativeDate.UTC.bind(NativeDate)}});' +
      'Object.freeze(FixedDate);Object.freeze(NativeDate.prototype);Object.defineProperty(globalThis,"Date",{value:FixedDate,writable:false,configurable:false});' +
      'Object.defineProperty(globalThis,"Intl",{value:undefined,writable:false,configurable:false});' +
      'Object.defineProperty(globalThis,"console",{value:Object.freeze({log(){},warn(){},error(){}}),writable:false,configurable:false});' +
      'let allocated=0;const NativeBuffer=ArrayBuffer,bufferLength=Object.getOwnPropertyDescriptor(NativeBuffer.prototype,"byteLength").get,typed=Object.getPrototypeOf(Uint8Array.prototype),typedLength=Object.getOwnPropertyDescriptor(typed,"byteLength").get;function reserve(n){if(!isSafeInteger(n)||n<0||n>8388608-allocated)throw Error("buffer budget");allocated+=n}' +
      'function install(name,Native,Wrapped){Wrapped.prototype=Native.prototype;Object.defineProperty(Native.prototype,"constructor",{value:Wrapped,writable:false,configurable:false});Object.freeze(Wrapped);Object.defineProperty(globalThis,name,{value:Wrapped,writable:false,configurable:false})}' +
      'function BoundedBuffer(n=0){if(!new.target)throw Error("constructor");n=toNumber(n);reserve(n);return construct(NativeBuffer,[n],new.target)}' +
      'Object.defineProperty(BoundedBuffer,"isView",{value:NativeBuffer.isView});install("ArrayBuffer",NativeBuffer,BoundedBuffer);' +
      'const bufferSlice=NativeBuffer.prototype.slice;Object.defineProperty(NativeBuffer.prototype,"slice",{value:function(...args){reserve(apply(bufferLength,this,[]));return apply(bufferSlice,this,args)},writable:false,configurable:false});' +
      'const typedNames=["Int8Array","Uint8Array","Uint8ClampedArray","Int16Array","Uint16Array","Int32Array","Uint32Array","Float16Array","Float32Array","Float64Array","BigInt64Array","BigUint64Array"].filter(name=>typeof globalThis[name]==="function");for(const name of typedNames){' +
      'const Native=globalThis[name],width=Native.BYTES_PER_ELEMENT;function Bounded(...args){if(!new.target)throw Error("constructor");const first=args[0];' +
      'let buffer=false;try{apply(bufferLength,first,[]);buffer=true}catch{}if(buffer)return construct(Native,args,new.target);' +
      'if(first===undefined||typeof first==="number"){const n=first??0;reserve(n*width);return construct(Native,[n],new.target)}' +
      'const n=toNumber(first.length);reserve(n*width);const result=construct(Native,[n],new.target);for(let i=0;i<n;i++)result[i]=first[i];return result}' +
      'Object.setPrototypeOf(Bounded,Object.getPrototypeOf(Native));Object.defineProperty(Bounded,"BYTES_PER_ELEMENT",{value:width});install(name,Native,Bounded)}' +
      'for(const key of ["slice","map","filter","with","toReversed","toSorted"]){const native=typed[key];if(typeof native==="function")Object.defineProperty(typed,key,{value:function(...args){reserve(apply(typedLength,this,[]));return apply(native,this,args)},writable:false,configurable:false})}' +
      'for(const key of ["transfer","transferToFixedLength","resize"]){const native=NativeBuffer.prototype[key];if(typeof native==="function")Object.defineProperty(NativeBuffer.prototype,key,{value:function(){throw Error("buffer resize disabled")},writable:false,configurable:false})}' +
      'Object.freeze(NativeBuffer.prototype);for(const name of typedNames)Object.freeze(globalThis[name].prototype);Object.freeze(typed);' +
      'Object.defineProperty(globalThis,"SharedArrayBuffer",{value:undefined,writable:false,configurable:false});' +
      'Object.defineProperty(globalThis,"WebAssembly",{value:undefined,writable:false,configurable:false});' +
      'delete globalThis.__randomValues;delete globalThis.__at;' +
      'return Object.freeze({draws:()=>consumed,exhausted:()=>exhausted,objectPrototype:Object.prototype,arrayPrototype:Array.prototype})' +
      '})()') as { draws(): number; exhausted(): boolean; objectPrototype: object; arrayPrototype: object }
    if (request.setupCode) script(request.setupCode as string)
    script(request.source as string)
    if (request.afterCode) script(request.afterCode as string)
    const result = script('(' + (request.expression || 'null') + ')')
    if (controls.exhausted()) throw Error('random exhausted')
    const value = copy(result, controls.objectPrototype, controls.arrayPrototype)
    const output = stringify({ ok: true, value, consumedRandom: controls.draws() })
    if (Buffer.byteLength(output) > 1048576) throw Error('output')
    ended = true
    write(output, () => exit(0))
  }
  runtimeProcess.stdin.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > 1048576) { chunks = []; fail(); runtimeProcess.stdin.destroy(); return }
    chunks.push(chunk)
  })
  runtimeProcess.stdin.on('error', fail)
  runtimeProcess.stdin.on('end', () => { if (ended) return; try { const request: unknown = parse(Buffer.concat(chunks).toString('utf8')); chunks = []; run(request as Record<string, unknown>) } catch { fail() } })
}
const WORKER = '(' + scriptWorkerMain.toString() + ')()'

function isolatedCommand() {
  // No platform or profile failure falls back to Node permissions or VM alone.
  if (runtimeProcess.platform !== 'darwin' || !runtimeProcess.allowedNodeEnvironmentFlags.has('--permission')) throw unavailable()
  let node: string
  try { node = realpathSync(runtimeProcess.execPath) } catch { throw unavailable() }
  if (!node.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(node)) throw unavailable()
  const literal = JSON.stringify(node)
  const profile = '(version 1)(deny default)(allow process-exec (literal ' + literal + '))(allow sysctl-read)' +
    '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (literal "/") (literal ' + literal + '))'
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, node, '--permission', '--max-old-space-size=64', '--stack-size=512',
    '--jitless', '--no-addons', '--disable-sigusr1', '--no-warnings', '--input-type=commonjs', '--eval', WORKER] }
}
const environment = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC', UV_THREADPOOL_SIZE: '1' })
function resultOf(output: Buffer, draws: number): AgentDiceScriptResult {
  try {
    const value = record(jsonCopy(JSON.parse(output.toString('utf8'))))
    if (Object.keys(value).some(key => !['ok', 'value', 'consumedRandom'].includes(key)) || value.ok !== true || !Object.hasOwn(value, 'value') ||
        typeof value.consumedRandom !== 'number' || !Number.isSafeInteger(value.consumedRandom) || value.consumedRandom < 0 || value.consumedRandom > draws) throw rejected()
    return Object.freeze({ value: value.value!, consumedRandom: value.consumedRandom })
  } catch { throw rejected() }
}

/** Explicit diagnostics only: real OS I/O denial, but no hard total-process
 * memory quota. Never use this as the production runner or a trust bypass. */
export async function executeDarwinAgentDiceScriptDiagnostic(input: AgentDiceScriptInput, options: AgentDiceScriptRunOptions = {}): Promise<AgentDiceScriptResult> {
  if (options.signal?.aborted) throw cancelled()
  const request = prepared(input), isolated = isolatedCommand()
  return await new Promise<AgentDiceScriptResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(isolated.command, isolated.args, { cwd: '/', env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { reject(unavailable()); return }
    let outputBytes = 0, errorBytes = 0, stopped: Error | undefined, closed = false
    const chunks: Buffer[] = []
    const stop = (error: Error) => { stopped ??= error; child.stdin?.destroy(); if (!closed) child.kill('SIGKILL') }
    const abort = () => stop(cancelled())
    const timer = setTimeout(() => stop(rejected()), MAX_WALL_MS)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout?.on('data', (data: Buffer) => {
      outputBytes += data.byteLength
      if (outputBytes > MAX_OUTPUT || request.raw.byteLength + outputBytes + errorBytes > MAX_IO) stop(rejected())
      else chunks.push(data)
    })
    child.stderr?.on('data', (data: Buffer) => {
      errorBytes += data.byteLength
      if (errorBytes > MAX_STDERR || request.raw.byteLength + outputBytes + errorBytes > MAX_IO) stop(rejected())
    })
    child.stdin?.on('error', () => stop(rejected()))
    child.on('error', () => stop(unavailable()))
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      if (stopped) { reject(stopped); return }
      if (code !== 0 || signal || !outputBytes) { reject(rejected()); return }
      try { resolve(resultOf(Buffer.concat(chunks), request.draws)) } catch { reject(rejected()) }
    })
    if (!stopped) child.stdin?.end(request.raw)
  })
}

/** Synchronous form of the incomplete Darwin diagnostic boundary. */
export function executeDarwinAgentDiceScriptDiagnosticSync(input: AgentDiceScriptInput, options: AgentDiceScriptRunOptions = {}): AgentDiceScriptResult {
  if (options.signal?.aborted) throw cancelled()
  const request = prepared(input), isolated = isolatedCommand()
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(isolated.command, isolated.args, { cwd: '/', env: environment, input: request.raw, stdio: ['pipe', 'pipe', 'pipe'],
      timeout: MAX_WALL_MS, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true })
  } catch { throw unavailable() }
  const output = result.stdout, error = result.stderr
  if (result.error || result.status !== 0 || result.signal || !Buffer.isBuffer(output) || !Buffer.isBuffer(error) || !output.byteLength ||
      output.byteLength > MAX_OUTPUT || error.byteLength > MAX_STDERR || request.raw.byteLength + output.byteLength + error.byteLength > MAX_IO) throw rejected()
  return resultOf(output, request.draws)
}

function checkedRunnerResult(value: unknown, draws: number): AgentDiceScriptResult {
  const result = record(jsonCopy(value))
  if (Object.keys(result).length !== 2 || !Object.hasOwn(result, 'value') || !Object.hasOwn(result, 'consumedRandom') ||
      typeof result.consumedRandom !== 'number' || !Number.isSafeInteger(result.consumedRandom) || result.consumedRandom < 0 || result.consumedRandom > draws) throw rejected()
  return Object.freeze({ value: result.value!, consumedRandom: result.consumedRandom })
}
/** Executes only with an explicitly injected, host-verified constrained runner.
 * There is no fallback to Node permissions, a VM or the Darwin diagnostic. */
export async function executeAgentDiceScript(input: AgentDiceScriptInput, options: AgentDiceScriptOptions = {}): Promise<AgentDiceScriptResult> {
  if (options.signal?.aborted) throw cancelled()
  const runner = runnerSnapshot(options.runner), request = prepared(input)
  if (request.raw.byteLength > runner.limits.inputBytes) throw rejected()
  try {
    const result = checkedRunnerResult(await runner.execute(request.input, options.signal ? { signal: options.signal } : {}), request.draws)
    if (options.signal?.aborted) throw cancelled()
    if (Buffer.byteLength(JSON.stringify(result)) > runner.limits.outputBytes) throw rejected()
    return result
  } catch { throw options.signal?.aborted ? cancelled() : rejected() }
}
export function executeAgentDiceScriptSync(input: AgentDiceScriptInput, options: AgentDiceScriptOptions = {}): AgentDiceScriptResult {
  if (options.signal?.aborted) throw cancelled()
  const runner = runnerSnapshot(options.runner), request = prepared(input)
  if (request.raw.byteLength > runner.limits.inputBytes) throw rejected()
  try {
    const result = checkedRunnerResult(runner.executeSync(request.input, options.signal ? { signal: options.signal } : {}), request.draws)
    if (options.signal?.aborted) throw cancelled()
    if (Buffer.byteLength(JSON.stringify(result)) > runner.limits.outputBytes) throw rejected()
    return result
  } catch { throw options.signal?.aborted ? cancelled() : rejected() }
}
