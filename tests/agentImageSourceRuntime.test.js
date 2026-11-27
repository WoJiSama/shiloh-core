import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 15_000 }
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=' }
const call = (name, input) => ({ choices: [{ message: { content: '', tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(check, label) {
  const until = Date.now() + 7000
  while (Date.now() < until) { if (await check()) return; await delay(10) }
  assert.fail(label)
}

async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'image-source-observation'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: 'images', id: 'robot' }, target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'human' }, now = Date.now()
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }, 'image-observation')
  const binding = directory.resolve(target), key = simulationAddressKey(target), initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }; initial.nextProactiveCheckAt = now + 86_400_000
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const source = { version: 1, conversation: target, sender, senderName: 'human', messageId: 'image-trigger', occurredAt: now,
    text: '请描述这张图片', parts: [{ kind: 'image', resource: { kind: 'reference', value: 'base64://' + image.base64 } }], mentions: [account], directedToAccount: true }
  const effects = [], checks = [], requests = [], reads = [], visions = [], sends = [], diagnostics = [], entered = gate(), released = gate()
  let accept, depth = 0, version = 0, entry = 0, probing = false, armed = false, revokedInside = false, terminal = false
  const effect = port => effects.push({ port, depth })
  // This port models complete entry/exit source reads. Nested checks share the
  // entry version; successful proof results are never retained across calls.
  const isCurrent = () => {
    if (probing) checks.push(depth)
    const current = (depth ? entry : version) === 0
    if (armed && depth) { armed = false; version++; revokedInside = current }
    return redis.isCurrent() && current
  }
  const observe = check => {
    const outer = depth === 0
    if (outer) entry = version
    depth++
    let result
    try { result = check() === true } finally { depth-- }
    return result && (!outer || entry === version)
  }
  const host = createAgentRuntime({ storage, now: () => now, isExecutionCurrent: isCurrent,
    ...(settings.observer === false ? {} : { observeExecutionCurrent: observe }),
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessageImages(selected, id, guard) {
        effect('adapter.readMessageImages'); assert.deepEqual(selected, target); assert.equal(id, source.messageId)
        armed = settings.revokeDuringCheck === true
        probing = true
        let current
        try { current = guard.isCurrent() } finally { probing = false }
        if (!current) return undefined
        effect('native.get_msg'); reads.push(id)
        if (!await guard.allowsSource(structuredClone(source))) return undefined
        if (settings.readFailure) { guard.reportFailure?.(settings.readFailure); return undefined }
        entered.resolve()
        if (settings.holdRead) await released.promise
        // Deliberately return late bytes even after revocation. Core must perform
        // its own fresh post-await proof before any vision model sees them.
        return [{ ...image }]
      },
      actions: { async send(action, guard) { effect('send'); if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }; sends.push(action); return { state: 'sent', messageId: 'image-answer' } } },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.join(' ')) }, error(...args) { diagnostics.push(args.join(' ')) } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxSendsPerTurn: 1, maxToolRounds: 4 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(address) { const selected = directory.resolve(address); return selected && { binding: selected, persona: { name: 'fixture' }, systemContent: '' } },
    async describeImages(images) { effect('vision'); visions.push(images); return '合成图片里是一把蓝伞' },
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      effect('model'); await ensureCurrent?.(); requests.push(request)
      if (requests.length === 1) return call('simGetMessageImages', { seq: 1 })
      terminal = true
      if (settings.readFailure) return call('simFinishTurn', { choice: 'silent' })
      return call('simFinishTurn', { choice: 'chat', reason: '已读取图片', messages: ['图中是一把蓝伞。'] })
    },
  })
  t.after(async () => { released.resolve(); await host.stop() })
  await host.start()
  return { effects, checks, requests, reads, visions, sends, entered, released, diagnostics,
    get revokedInside() { return revokedInside }, revoke() { version++ },
    async run() {
      await accept({ kind: 'message', message: structuredClone(source) })
      await waitFor(async () => (terminal || version > 0) && !await reader.exists(prefix + simulationBusyKey(key)) &&
        !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`), `image turn did not drain: ${diagnostics.join('|')}`)
      await host.runtime.drain()
    },
  }
}

test('Core image source checks share one synchronous observation before real reading and delivery', redisTest, async t => {
  const f = await fixture(t)
  await f.run()
  assert.equal(f.reads.length, 1); assert.deepEqual(f.visions, [[image]]); assert.equal(f.sends.length, 1)
  assert.ok(f.checks.length > 0)
  assert.equal(f.checks.filter(depth => depth === 0).length, 0, 'the native image current predicate must not start an unscoped complete source read before its nested turn observation')
  assert.ok(f.effects.every(effect => effect.depth === 0), 'native reading, models and delivery happen after the observation exits')
})

test('Core image source observation rejects an in-check version change before native reading', redisTest, async t => {
  const f = await fixture(t, { revokeDuringCheck: true })
  await f.run()
  assert.equal(f.revokedInside, true)
  assert.equal(f.reads.length, 0); assert.equal(f.visions.length, 0); assert.equal(f.sends.length, 0)
  assert.ok(f.effects.every(effect => effect.depth === 0))
})

test('Core image source revocation drops late bytes before vision or delivery', redisTest, async t => {
  const f = await fixture(t, { holdRead: true }), pending = f.run()
  await f.entered.promise; f.revoke(); f.released.resolve(); await pending
  assert.equal(f.reads.length, 1); assert.equal(f.visions.length, 0); assert.equal(f.sends.length, 0)
  assert.ok(f.effects.every(effect => effect.depth === 0))
})

test('Core image source reading preserves compatibility without an observation port', redisTest, async t => {
  const f = await fixture(t, { observer: false })
  await f.run()
  assert.equal(f.reads.length, 1); assert.deepEqual(f.visions, [[image]]); assert.equal(f.sends.length, 1)
})

test('a QQ image download failure reaches the same tool trace with its HTTP status and phase', redisTest, async t => {
  const f = await fixture(t, { readFailure: { code: 'image_download_http_error', httpStatus: 403 } })
  await f.run()
  assert.equal(f.reads.length, 1)
  assert.equal(f.visions.length, 0)
  assert.equal(f.sends.length, 0)
  assert.match(f.diagnostics.join('\n'), /tool\/simGetMessageImages failed image_download_http_error .*http=403.*step=image_download.*result=discarded/u)
})
