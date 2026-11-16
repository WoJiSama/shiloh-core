import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
const account = { platform: 'fixture', namespace: 'relay-tools', id: 'robot' }
const target = { account, kind: 'group', id: 'room' }, author = { ...account, id: 'human' }
const artifact = { id: '1'.repeat(32), kind: 'image', mime: 'image/png', sizeBytes: 64, sha256: '2'.repeat(64) }
const relayPlan = (text = '合成 Pixiv 作品介绍') => ({ version: 1, items: [{ parts: [{ kind: 'text', text }] }, { parts: [{ kind: 'image', artifact: { ...artifact } }] }] })
const splitPlan = (left, right) => ({ version: 1, items: [{ parts: [{ kind: 'text', text: left }, { kind: 'text', text: right }] }] })
const definition = execute => ({ name: 'mediaRelayPortProbe', description: 'Scoped media relay fixture', parameters, execute })
const done = { status: 'succeeded', content: '受控媒体验证结束' }
function wrapper(execute, settings = {}) {
  const scope = { binding: { id: 'binding', agentId: 'role', revision: 'one', target }, actor: { kind: 'user', user: author },
    isCurrent: () => true, ...settings.scope }
  const tool = { ...definition(execute), ...(settings.ephemeral ? { dataPolicy: 'ephemeral' } : {}) }
  const tools = createAgentTools({ builtIn: [tool] }, { signal: new AbortController().signal, context: () => scope,
    ...(settings.allowsInput ? { allowsInput: settings.allowsInput } : {}) })
  return tools.getExtraTools([tool.name])[0].execute({}, {})
}

test('media relay wrapper owns the ordered plan before waits and rejects split credentials, tool arguments and injected delivery controls', async () => {
  const sent = [], secret = 'host-relay-private-key'
  const result = await wrapper(async (_input, context) => {
    const mutable = relayPlan(), pending = context.sendMediaRelay(mutable)
    mutable.items[0].parts[0].text = '调用后篡改'; mutable.items[1].parts[0].artifact.sha256 = '3'.repeat(64)
    assert.deepEqual(await pending, { state: 'sent', messageId: 'relay-confirmed' })
    for (const value of [splitPlan('host-relay-', 'private-key'), splitPlan('{"query":', '"x","limit":5}'),
      { ...relayPlan(), target: { ...target, id: 'elsewhere' } }, { ...relayPlan(), mode: 'direct-video' },
      { version: 1, items: [{ parts: [{ kind: 'image', artifact: { ...artifact, url: 'https://other.example/image.png' } }] }] }]) {
      await assert.rejects(context.sendMediaRelay(value))
    }
    return done
  }, { allowsInput: text => !text.includes(secret), scope: { async sendMediaRelay(plan, current, signal) {
    assert.equal(current(), true); assert.equal(signal.aborted, false)
    assert.ok(Object.isFrozen(plan.items[0].parts)); assert.ok(Object.isFrozen(plan.items[1].parts[0].artifact))
    sent.push(plan); return { state: 'sent', messageId: 'relay-confirmed' }
  } } })
  assert.equal(result.status, 'success'); assert.deepEqual(sent, [relayPlan()])
})

test('ephemeral, nonhuman and nongroup contexts cannot obtain media relay; reading history revokes a retained sending closure', async () => {
  let sends = 0
  const sendMediaRelay = async () => { sends++; return { state: 'sent', messageId: 'should-not-send' } }
  for (const settings of [{ ephemeral: true }, { scope: { actor: { kind: 'autonomous' } } },
    { scope: { binding: { target: { ...target, kind: 'private' } } } }, { scope: { binding: { target: { ...target, kind: 'channel' } } } }]) {
    assert.equal((await wrapper(async (_input, context) => {
      assert.equal(context.sendMediaRelay, undefined); assert.equal(Object.hasOwn(context, 'sendMediaRelay'), false)
      return done
    }, { ...settings, scope: { sendMediaRelay, ...settings.scope } })).status, 'success')
  }
  assert.equal((await wrapper(async (_input, context) => {
    const retained = context.sendMediaRelay
    await context.readHistory({})
    await assert.rejects(retained(relayPlan()), /临时资料/u)
    return done
  }, { scope: { sendMediaRelay, async readHistory() { return '短时历史正文' } } })).status, 'success')
  assert.equal(sends, 0)
})

test('unknown media relay receipts cannot be relabeled success or followed by relay and text sends', async () => {
  for (const receipt of [{ state: 'unknown' }, { state: 'sent' }]) {
    let sends = 0, texts = 0
    const result = await wrapper(async (_input, context) => {
      assert.deepEqual(await context.sendMediaRelay(relayPlan()), { state: 'unknown' })
      await assert.rejects(context.sendMediaRelay(relayPlan('第二份作品')), /未知/u)
      await assert.rejects(context.sendMessage({ text: '额外发送' }), /未知/u)
      return done
    }, { scope: { async sendMediaRelay() { sends++; return receipt }, async sendMessage() { texts++; return { state: 'sent', messageId: 'text' } } } })
    assert.equal(result.status, 'unknown'); assert.equal(sends, 1); assert.equal(texts, 0)
  }
})

test('source availability snapshots identity, rejects getters and foreign namespace, and never exposes host return objects', async () => {
  let reads = 0, getters = 0, saved
  const result = await wrapper(async (_input, context) => {
    const source = { messageId: 'original-search', author: { ...author } }, pending = context.isSourceAvailable(source)
    source.messageId = 'changed'; source.author.id = 'changed'
    assert.equal(await pending, true)
    for (const source of [{ messageId: '0', author }, { messageId: 'source', author: { ...author, namespace: 'foreign' } },
      { messageId: 'source', author, target }, Object.defineProperty({ author }, 'messageId', { get() { getters++; return 'source' } }),
      { messageId: 'source', author: Object.defineProperty({ ...author }, 'id', { get() { getters++; return 'human' } }) }]) assert.equal(await context.isSourceAvailable(source), false)
    assert.equal(await context.isSourceAvailable({ messageId: 'object-return', author }), false)
    return done
  }, { scope: { async isSourceAvailable(source, current, signal) {
    reads++; assert.equal(current(), true); assert.equal(signal.aborted, false); assert.ok(Object.isFrozen(source.author)); saved = source
    return source.messageId === 'original-search' ? true : { text: 'must never escape' }
  } } })
  assert.equal(result.status, 'success'); assert.equal(reads, 2); assert.equal(getters, 0)
  assert.deepEqual(saved, { messageId: 'object-return', author })
})

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
async function waitFor(probe, label, timeout = 7000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await probe()) return; await delay(15) }
  assert.fail(typeof label === 'function' ? label() : label)
}
async function runtimeFixture(t, execute, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'media-relay-tools'), { storage, reader, prefix } = redis
  const selectedTarget = { ...target, kind: settings.kind ?? 'group' }, sender = { ...author, id: 'requester' }, archivedAuthor = { ...author, id: 'original-author' }
  const now = Date.now(), key = simulationAddressKey(selectedTarget)
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: selectedTarget.kind, conversationId: selectedTarget.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'relay-initial'), accept, completed = false, incomingDenied = false, currentSource, executionError
  const binding = directory.resolve(selectedTarget), initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }; initial.nextProactiveCheckAt = now + 86_400_000
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const archived = { version: 1, conversation: selectedTarget, sender: archivedAuthor, messageId: 'original-search', occurredAt: now - 60_000,
    text: '最初真人的 Pixiv 搜索请求', parts: [{ kind: 'text', text: '最初真人的 Pixiv 搜索请求' }], mentions: [] }
  const original = { version: 1, conversation: selectedTarget, sender, messageId: 'current-trigger', occurredAt: now,
    text: '请查看上次的结果', parts: [{ kind: 'text', text: '请查看上次的结果' }], mentions: [account], directedToAccount: true }
  currentSource = structuredClone(archived)
  const attempts = [], sends = [], reads = [], errors = [], review = [], output = []
  let f
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessage(address, id, guard) {
        reads.push({ address: structuredClone(address), id }); await settings.read?.(id, f)
        if (guard?.isCurrent?.() === false) return undefined
        return structuredClone(id === original.messageId ? original : id === archived.messageId ? currentSource : undefined)
      },
      actions: {
        async send(action, guard) { if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }; sends.push(action); return { state: 'sent', messageId: 'text-confirmed' } },
        async sendMediaRelay(action, guard) {
          attempts.push({ action: structuredClone(action), guard })
          if (settings.deliver) return settings.deliver(action, guard, f)
          if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
          sends.push(structuredClone(action)); return settings.receipt ?? { state: 'sent', messageId: 'relay-confirmed' }
        },
      },
    }],
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } },
    allowsText(text, direction) { return !(direction === 'incoming' && incomingDenied && text === archived.text) && !text.includes('禁止内容') },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, consistency: { enabled: settings.review === true }, rhythm: { enabled: false }, mood: { enabled: false },
      personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxSendsPerTurn: settings.maxSends ?? 1, maxToolRounds: 6 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(address) { const selected = directory.resolve(address); return selected && { binding: selected, persona: { name: 'fixture' }, systemContent: '' } },
    toolRegistry: { builtIn: [definition(async (_input, context) => { try { return await execute(context, f) ?? done } catch (error) { executionError = error; throw error } finally { completed = true } })] },
    async YTapi() { if (!completed) return call('mediaRelayPortProbe'); return call('simFinishTurn', { choice: 'silent', reason: '本轮受控验证结束' }) },
    async reviewCharacter(request) { review.push(request); return { choices: [{ message: { content: JSON.stringify({ verdict: 'accept', issues: [] }) } }] } },
  })
  t.after(async () => { settings.release?.(); await host.stop() })
  const session = async () => JSON.parse(await storage.get(simulationSessionKey(key)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(key)) && !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`)
  f = { ...redis, host, target: selectedTarget, binding, sender, archived, now, attempts, sends, reads, errors, review, output, session,
    setSource(value) { currentSource = value }, denyIncoming(value) { incomingDenied = value },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'relay-rebound') },
    recall(id) { return accept({ kind: 'recall', target: selectedTarget, messageId: id }) },
    async run() { await accept({ kind: 'message', message: structuredClone(original) }); await waitFor(async () => completed && await settled(), () => `relay tool turn did not settle: ${JSON.stringify(errors)}`); await host.runtime.drain(); if (executionError) throw executionError },
  }
  await host.start(); await accept({ kind: 'message', message: structuredClone(archived) })
  await waitFor(async () => (await session())?.recent?.some(message => message.messageId === archived.messageId) && await settled(), 'original source recorded without a model wake')
  return f
}

test('Core relay fixes group, account, binding and forward mode, deduplicates equivalent content, and shares one send budget', redisTest, async t => {
  let saved
  const f = await runtimeFixture(t, async context => {
    saved = context
    assert.deepEqual(await context.sendMediaRelay(relayPlan()), { state: 'sent', messageId: 'relay-confirmed' })
    const equivalent = relayPlan(); equivalent.items[0].parts = [{ kind: 'text', text: '合成 Pixiv 作' }, { kind: 'text', text: '品介绍' }]; equivalent.items[1].parts[0].artifact.id = '3'.repeat(32)
    assert.deepEqual(await context.sendMediaRelay(equivalent), { state: 'failed', code: 'duplicate_media_relay' })
    await assert.rejects(context.sendMediaRelay(relayPlan('不同作品')), /上限/u)
    return done
  }, { review: true })
  await f.run(); assert.equal(f.attempts.length, 1)
  assert.deepEqual(f.sends[0], { version: 1, kind: 'media-relay.send', target: f.target, mode: 'forward', plan: relayPlan(), binding: f.binding })
  assert.equal((await f.session()).sendTimes.length, 1)
  assert.ok(f.review.some(request => JSON.parse(request.messages[1].content).candidate.messages?.includes('合成 Pixiv 作品介绍')))
  await assert.rejects(saved.sendMediaRelay(relayPlan()), /失效/u)
})

test('Core relay rejects coalesced outgoing phrases and freezes all following sends on unknown or malformed success', redisTest, async t => {
  for (const receipt of [{ state: 'unknown' }, { state: 'sent' }]) await t.test(receipt.state + String(Boolean(receipt.messageId)), async t => {
    const f = await runtimeFixture(t, async context => {
      assert.deepEqual(await context.sendMediaRelay(splitPlan('禁止', '内容')), { state: 'failed', code: 'forbidden_text' })
      assert.deepEqual(await context.sendMediaRelay(relayPlan()), { state: 'unknown' })
      await assert.rejects(context.sendMediaRelay(relayPlan('另一个作品')), /未知/u)
      await assert.rejects(context.sendMessage({ text: '额外文字' }), /未知/u)
      return done
    }, { receipt, maxSends: 4 })
    await f.run(); assert.equal(f.attempts.length, 1); assert.equal(f.sends.length, 1); assert.equal((await f.session()).sendTimes.length, 0)
  })
})

test('Core source availability keeps original identity and denies replacement, foreign target, unobserved, forbidden and disabled sources', redisTest, async t => {
  const f = await runtimeFixture(t, async (context, run) => {
    const source = { messageId: run.archived.messageId, author: run.archived.sender }
    assert.equal(await context.isSourceAvailable(source), true)
    for (const changed of [{ ...run.archived, messageId: 'substituted' }, { ...run.archived, sender: run.sender },
      { ...run.archived, conversation: { ...run.target, id: 'another-room' } },
      { ...run.archived, conversation: { ...run.target, account: { ...run.target.account, id: 'another-bot' } } }]) {
      run.setSource(changed); assert.equal(await context.isSourceAvailable(source), false)
    }
    run.setSource(structuredClone(run.archived))
    assert.equal(await context.isSourceAvailable({ ...source, messageId: 'not-ingested' }), false)
    assert.equal(await context.isSourceAvailable({ ...source, author: { ...source.author, namespace: 'other-tenant' } }), false)
    run.denyIncoming(true); assert.equal(await context.isSourceAvailable(source), false); run.denyIncoming(false)
    const { botId, scene } = personMemoryAddress(run.target), memory = createPersonMemoryStore({ redis: run.storage, now: () => run.now })
    await memory.setEnabled({ identity: { botId, personaId: agentPersonaScopeId(run.binding.agentId) }, subjectId: source.author.id, enabled: false, scene })
    assert.equal(await context.isSourceAvailable(source), false)
    run.output.push('source checks complete')
    return done
  })
  await f.run(); assert.deepEqual(f.output, ['source checks complete']); assert.equal(f.sends.length, 0)
  assert.ok(f.reads.length >= 6); assert.ok(f.reads.every(read => read.address.id === f.target.id && read.address.account.id === account.id))
})

test('Core source reauthorization detects recall while adapter read is pending', redisTest, async t => {
  let recalled = false
  const f = await runtimeFixture(t, async (context, run) => {
    assert.equal(await context.isSourceAvailable({ messageId: run.archived.messageId, author: run.archived.sender }), false)
    run.output.push('pending recall blocked')
    return done
  }, { async read(id, run) { if (id === run.archived.messageId && !recalled) { recalled = true; await run.recall(id) } } })
  await f.run(); assert.deepEqual(f.output, ['pending recall blocked']); assert.equal(f.sends.length, 0)
})

test('Core relay transport guards reject a binding replaced during an in-flight forward', redisTest, async t => {
  let replaced = false
  const f = await runtimeFixture(t, async (context, run) => {
    await context.sendMediaRelay(relayPlan()).catch(() => {})
    run.output.push('finished stale relay')
    return done
  }, { async deliver(_action, guard, run) { run.rebind(); replaced = true; assert.equal(guard.isCurrent(), false); return { state: 'failed', code: 'cancelled' } } })
  await f.run(); assert.equal(replaced, true); assert.equal(f.attempts.length, 1); assert.equal(f.sends.length, 0); assert.equal((await f.session()).sendTimes.length, 0)
})

test('Core nongroup simulation tools receive neither relay delivery nor source availability', redisTest, async t => {
  const f = await runtimeFixture(t, async (context, run) => {
    assert.equal(context.sendMediaRelay, undefined); assert.equal(context.isSourceAvailable, undefined); run.output.push('nongroup ports absent')
    return done
  }, { kind: 'channel' })
  await f.run(); assert.deepEqual(f.output, ['nongroup ports absent']); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
})
