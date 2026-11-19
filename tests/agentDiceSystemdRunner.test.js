import assert from 'node:assert/strict'
import {readdirSync} from 'node:fs'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createLinuxSystemdAgentDiceScriptRunner: create, AGENT_DICE_SCRIPT_LIMITS } = await load('modules/dice/infrastructure/agentDiceScriptProcess.js')
const request = source => ({ source, kind: 'js', operation: 'execute', at: 1_800_000_000_000, randomValues: [0.25], expression: 'output' })
const linux = process.platform === 'linux' && process.env.BL_CHAT_DICE_LINUX_CONFORMANCE === '1'

test('Linux systemd runner refuses Darwin and never promotes its diagnostic into verified metadata', { skip: process.platform === 'linux' }, () => {
  assert.throws(() => create(), /骰子脚本隔离环境不可用/u)
})

test('actual Linux transient units verify kernel quotas, deny ambient access and reap success, limits and cancellation', { skip: !linux, timeout: 60_000 }, async () => {
  const cgroups = () => readdirSync('/sys/fs/cgroup/system.slice').filter(name => name.startsWith('bl-agent-dice-')).sort()
  const before = cgroups()
  const runner = create(), evidence = JSON.parse(runner.isolation.evidence)
  assert.equal(evidence.boundary, 'linux-systemd-cgroup-v2'); assert.equal(evidence.memoryMax, '134217728'); assert.equal(evidence.swapMax, '0')
  const restarted = create()
  assert.equal(restarted.definitionId, runner.definitionId)
  assert.equal(restarted.isolation.evidence, runner.isolation.evidence, 'probe identity must not invalidate persisted rule definitions on restart')
  assert.deepEqual(runner.limits, AGENT_DICE_SCRIPT_LIMITS)
  const input = request('var output={roll:Math.random(),at:Date.now(),require:typeof require,process:typeof process,fetch:typeof fetch};')
  const expected = { value: { roll: 0.25, at: input.at, require: 'undefined', process: 'undefined', fetch: 'undefined' }, consumedRandom: 1 }
  assert.deepEqual(await runner.execute(input, {}), expected); assert.deepEqual(runner.executeSync(input, {}), expected)
  for (const source of [
    'var output=require("node:fs").readFileSync("/etc/passwd","utf8");',
    'var output=require("node:net").connect(80,"127.0.0.1");',
    'var output=require("node:child_process").execSync("true");',
    'var output=new(require("node:worker_threads").Worker)("while(true){}",{eval:true});',
    'var output=({}).constructor.constructor("return process")().env;',
    'while(true){}', 'var data=[];while(true)data.push("memory".repeat(1_000_000));',
    'var data=[];while(true)data.push(new Uint8Array(4*1024*1024));',
    'var output="x".repeat(1024*1024+1);',
  ]) await assert.rejects(runner.execute(request(source), {}))
  const controller = new AbortController(), pending = runner.execute(request('while(true){}'), { signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(pending, /取消/u)
  assert.deepEqual(cgroups(), before)
})
