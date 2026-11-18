import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 15_000 }
const textOf = action => action.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
let fixtureId = 0
async function waitFor(probe, label) {
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`Timed out: ${label}`)
}
async function fixture(t, settings = {}) {
  let host
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'magnet-core-test')
  const account = { platform: 'fixture', namespace: `magnet-${++fixtureId}`, id: 'robot' }, user = { ...account, id: 'human' }
  const group = { account, kind: 'group', id: 'room' }, other = { ...group, id: 'another-room' }, privateTarget = { account, kind: 'private', id: user.id }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, other, privateTarget].map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'initial'), ready = false, accept, sequence = 0
  const sends = [], models = [], searches = [], sources = new Map(), key = (target, id) => JSON.stringify([conversationAddressKey(target), id])
  const adapter = { id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => ready,
    async start(consume) { accept = consume; ready = true }, stop() { ready = false },
    async readMessage(target, id, guard) { return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(key(target, id))) },
    actions: { async send(action, guard) {
      if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
      sends.push(structuredClone(action)); return { state: 'sent', messageId: `reply-${++sequence}` }
    } },
  }
  host = createAgentRuntime({ storage: redis.storage, adapters: [adapter], isExecutionCurrent: redis.isCurrent,
    privateChatEnabled: true, useTextGroup: () => settings.mode !== 'simulation',
    ...(settings.groupLog ? { groupLog: { enabled: true, masters: [user] } } : {}),
    magnetSearch: { enabled: settings.enabled !== false },
    magnetSearchProvider: { async search(input, context) { searches.push({ input, context }); return settings.search ? settings.search(input, context) : 'Ubuntu magnet:?xt=urn:btih:' + 'a'.repeat(40) } },
    resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: 'fixture' }, systemContent: 'test' } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
      personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    logger: { info() {}, warn() {}, error() {} }, async YTapi(request) { models.push(request); return { choices: [{ message: { content: 'model' } }] } },
  })
  await host.start()
  const queueKeys = ['group-log', 'group-text', 'private', 'privacy', 'simulation'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  const f = { host, group, other, privateTarget, searches, sends, models,
    async emit(text, target = group) {
      const message = { version: 1, conversation: target, sender: user, messageId: `command-${++sequence}`, occurredAt: Date.now(),
        text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: target.kind === 'private' }
      sources.set(key(target, message.messageId), structuredClone(message)); await accept({ kind: 'message', message }); return message
    },
    async recall(source) { sources.delete(key(source.conversation, source.messageId)); await accept({ kind: 'recall', target: source.conversation, messageId: source.messageId }) },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(row => ({ ...row, agentId: 'replacement' })) }, 'replacement') },
    async drained() { await waitFor(async () => (await Promise.all(queueKeys.map(key => redis.reader.lLen(key)))).every(size => size === 0), 'inbox drain'); await host.runtime.drain() },
  }
  return f
}

for (const mode of ['text', 'simulation']) test(`explicit Core ${mode} magnet commands use the current target and never a model or downloader`, redisTest, async t => {
  const f = await fixture(t, { mode })
  await f.emit('  。磁力搜索 ubuntu 99  '); await f.drained()
  assert.deepEqual(f.searches[0].input, { keyword: 'ubuntu', limit: 20 })
  assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0].target, f.group); assert.match(textOf(f.sends[0]), /magnet:\?xt=urn:btih:/u)
  await f.emit('.磁力'); await f.drained(); assert.match(textOf(f.sends.at(-1)), /默认 10 条/u)
  assert.equal(f.searches.length, 1); assert.equal(f.models.length, 0)
})

test('group recording forwarding retains whitespace and original command source', redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  await f.emit('.log new magnet-test'); await f.drained()
  await f.emit('  .磁力 ubuntu 5  '); await f.drained()
  assert.equal(f.searches.length, 1); assert.deepEqual(f.searches[0].input, { keyword: 'ubuntu', limit: 5 })
  assert.match(textOf(f.sends.at(-1)), /magnet:\?xt=urn:btih:/u); assert.equal(f.models.length, 0)
})

for (const reason of ['recall', 'rebind']) test(`Core ${reason} cancels pending magnet search and never sends a late result`, redisTest, async t => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  const f = await fixture(t, { release: released.resolve, async search(_input, context) { entered.resolve(context); await released.promise; return 'late result' } })
  const source = await f.emit('.磁力 ubuntu'), context = await entered.promise
  if (reason === 'recall') await f.recall(source); else f.rebind()
  await f.drained()
  assert.equal(context.signal.aborted, true); released.resolve(); await delay(10)
  assert.equal(f.sends.length, 0); assert.equal(f.models.length, 0)
})

test('disabled Core magnet capability performs no search and private commands remain in their verified peer', redisTest, async t => {
  const disabled = await fixture(t, { enabled: false }); await disabled.emit('.磁力 ubuntu'); await disabled.drained()
  assert.equal(disabled.searches.length, 0)
  const f = await fixture(t); await f.emit('.磁链搜索 ubuntu 2', f.privateTarget); await f.drained()
  assert.equal(f.searches.length, 1); assert.deepEqual(f.sends[0].target, f.privateTarget)
  assert.equal(f.models.length, 0)
})
