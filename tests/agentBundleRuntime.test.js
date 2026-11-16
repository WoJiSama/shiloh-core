import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const items = [{ parts: [{ kind: 'text', text: '英文原文与中文翻译，来源：Modrinth' }] }]
const alternate = [{ parts: [{ kind: 'text', text: '另一个项目的简介' }] }]
const png = { kind: 'image', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
async function waitFor(probe, label) {
  const end = Date.now() + 6000
  while (Date.now() < end) { if (await probe()) return; await delay(15) }
  assert.fail(label)
}

async function fixture(t, execute, { receipt = { state: 'sent', messageId: 'bundle-confirmed' }, queued = false, forbidden = false } = {}) {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'bundle-runtime')
  const account = { platform: 'fixture', namespace: 'tenant', id: 'robot' }
  const target = { account, kind: 'channel', id: 'room' }
  const sender = { ...account, id: 'member' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'initial'), accept, guard, release
  let invoked = false, completed = false, finished = false, executionError
  const sends = [], attempts = [], errors = []
  const now = Date.now(), key = simulationAddressKey(target)
  const state = createDefaultSimSession(now)
  state.bootstrapSent = true; state.botId = account.id
  state.wakeConfig.triggers.probability = 0; state.nextProactiveCheckAt = 0
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const queue = new Promise(resolve => { release = resolve })
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      actions: {
        async send(action, check) { if (check.isCurrent()) sends.push(action); return receipt },
        async sendBundle(action, check) {
          attempts.push(action); guard = check.isCurrent
          if (queued) await queue
          if (!check.isCurrent()) return { state: 'failed', code: 'cancelled' }
          sends.push(action)
          return receipt
        },
      },
    }],
    ...(forbidden ? { allowsText: text => !text.includes('Modrinth') } : {}),
    logger: { info() {}, warn() {}, error(...args) { errors.push(args.join(' ')) } },
    resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    toolRegistry: { builtIn: [{ name: 'bundleProbe', description: 'Bounded bundle fixture',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute(_input, context) {
        invoked = true
        try { await execute(context) } catch (error) { executionError = error; throw error } finally { completed = true }
        return { status: 'succeeded', content: 'bundle execution finished' }
      },
    }] },
    async YTapi(request) {
      const name = invoked ? 'simFinishTurn' : 'bundleProbe'
      if (invoked) finished = true
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'bundle-fixture-call', type: 'function', function: {
        name, arguments: JSON.stringify(invoked ? { choice: 'silent', reason: '合成验收结束', throughSeq: 1 } : {}),
      } }] } }] }
    },
  })
  t.after(async () => { release(); await host.stop(); if (!queued) assert.equal(executionError, undefined) })
  await host.start()
  const emit = () => accept({ kind: 'message', message: { version: 1, conversation: target, sender, messageId: 'trigger',
    occurredAt: now, text: '请查看这个项目', parts: [{ kind: 'text', text: '请查看这个项目' }], mentions: [account], directedToAccount: true } })
  const settled = async () => completed && !await reader.exists(prefix + simulationBusyKey(key))
  return { emit, sends, attempts, settled, target, errors,
    get guard() { return guard }, get finished() { return finished },
    async session() { return JSON.parse(await reader.get(prefix + simulationSessionKey(key))) },
    release,
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'other' }] }, 'replacement') },
    recall: () => accept({ kind: 'recall', target, messageId: 'trigger' }),
  }
}

test('Core bundle sends share send quota, deduplicate a full cleaned bundle and persist one confirmation', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  let saved
  const run = await fixture(t, async context => {
    saved = context
    assert.deepEqual(await context.sendBundle(items), { state: 'sent', messageId: 'bundle-confirmed' })
    assert.deepEqual(await context.sendBundle(items), { state: 'failed', code: 'duplicate_bundle' })
    await assert.rejects(context.sendBundle(alternate))
  })
  await run.emit()
  await waitFor(run.settled, () => run.errors.join('|'))
  assert.equal(run.sends.length, 1)
  assert.deepEqual(run.sends[0].target, run.target)
  assert.deepEqual(run.sends[0].items, items)
  assert.equal(run.sends[0].binding.agentId, 'role')
  assert.equal((await run.session()).sendTimes.length, 1)
  await assert.rejects(saved.sendBundle(items), /失效/u)
})

test('unknown bundle receipt freezes subsequent tool sends without automatic fallback', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const run = await fixture(t, async context => {
    assert.deepEqual(await context.sendBundle(items), { state: 'unknown' })
    await assert.rejects(context.sendBundle(alternate), /未知/u)
  }, { receipt: { state: 'unknown' } })
  await run.emit()
  await waitFor(run.settled, 'unknown bundle turn settles')
  assert.equal(run.attempts.length, 1)
  assert.equal(run.sends.length, 1)
  assert.equal((await run.session()).sendTimes.length, 0)
})

test('Core outgoing text policy covers bundle nodes before adapter transport', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const run = await fixture(t, async context => {
    assert.deepEqual(await context.sendBundle(items), { state: 'failed', code: 'forbidden_text' })
  }, { forbidden: true })
  await run.emit()
  await waitFor(run.settled, 'forbidden bundle turn settles')
  assert.equal(run.attempts.length, 0)
  assert.equal((await run.session()).sendTimes.length, 0)
})

test('split text segments cannot bypass outgoing phrase policy or tool-argument filtering', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const run = await fixture(t, async context => {
    const fragmentedWord = [{ parts: [{ kind: 'text', text: 'Mod' }, { kind: 'text', text: 'rinth' }] }]
    assert.deepEqual(await context.sendBundle(fragmentedWord), { state: 'failed', code: 'forbidden_text' })
    const fragmentedArguments = [{ parts: [{ kind: 'text', text: '{"query":' }, { kind: 'text', text: '"x","limit":5}' }] }]
    await assert.rejects(context.sendBundle(fragmentedArguments), /参数/u)
  }, { forbidden: true })
  await run.emit()
  await waitFor(run.settled, 'fragmented bundle filtering settles')
  assert.equal(run.attempts.length, 0)
})

test('valid 4000-character fragments keep their limits while equivalent fragmentations deduplicate', { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const text = 'abcdef'.repeat(1000)
  const bundle = [{ parts: [{ kind: 'text', text: text.slice(0, 3000) }, { kind: 'text', text: text.slice(3000) }] }]
  const refragmented = [{ parts: [{ kind: 'text', text: text.slice(0, 4000) }, { kind: 'text', text: text.slice(4000) }] }]
  const run = await fixture(t, async context => {
    assert.equal((await context.sendBundle(bundle)).state, 'sent')
    assert.deepEqual(await context.sendBundle(refragmented), { state: 'failed', code: 'duplicate_bundle' })
  })
  await run.emit()
  await waitFor(run.settled, 'long fragmented bundle completes')
  assert.equal(run.sends.length, 1)
  assert.deepEqual(run.sends[0].items, bundle)
})

for (const changed of [false, true]) test(`rendered bundle companion text ${changed ? 'cannot retain pixels of text that needs cleaning' : 'uses the same guarded image and text action'}`, { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const bundle = [{ parts: [png, { kind: 'text', text: changed ? '完整原文与译文。  ' : '完整原文与译文。' }] }]
  const run = await fixture(t, async context => {
    if (changed) await assert.rejects(context.sendBundle(bundle), /清理/u)
    else assert.equal((await context.sendBundle(bundle)).state, 'sent')
  })
  await run.emit()
  await waitFor(run.settled, 'image companion text checked')
  assert.equal(run.sends.length, changed ? 0 : 1)
  if (!changed) assert.deepEqual(run.sends[0].items, bundle)
})

for (const mode of ['rebind', 'recall']) test(`queued bundle loses its final transport guard after ${mode}`, { skip: !redisAvailable, timeout: 15_000 }, async t => {
  const run = await fixture(t, context => context.sendBundle(items), { queued: true })
  await run.emit()
  await waitFor(() => run.attempts.length === 1, 'bundle reaches adapter queue')
  if (mode === 'rebind') run.rebind()
  else await run.recall()
  assert.equal(run.guard(), false)
  run.release()
  await waitFor(run.settled, 'revoked queued bundle turn settles')
  assert.equal(run.sends.length, 0)
  assert.equal((await run.session()).sendTimes.length, 0)
})
