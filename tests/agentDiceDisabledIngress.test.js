import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingToken, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentDiceState } = await load('modules/dice/infrastructure/agentDiceState.js')
const { createAgentDiceLedger } = await load('modules/dice/infrastructure/agentDiceLedger.js')
const { createAgentDiceHostBridge } = await load('modules/dice/infrastructure/agentDiceHostBridge.js')
const { compileAgentDiceRulePackage } = await load('modules/dice/infrastructure/agentDiceRulePackages.js')
const { createAgentGroupLogStore } = await load('modules/dice/infrastructure/agentGroupLogStore.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const options = { skip: !redisAvailable, timeout: 20000 }
let sequence = 0
async function waitFor(check, detail) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await check()) return; await delay(10) }
  assert.fail(detail())
}
async function fixture(t, rulePackages = [], settings = {}) {
  let host, receive, ready = false, enabled = false, omittedEngine = settings.omitEngine === true, serial = 0, receipt = 0
  t.after(async () => { await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'dice-disabled-core'), state = createAgentDiceState(redis.storage), ledger = createAgentDiceLedger(redis.storage)
  const account = { platform: 'fixture', namespace: 'disabled-core-' + ++sequence, id: 'bot' }
  const target = { account, kind: 'group', id: 'room' }, actor = { ...account, id: 'alice' }, permissions = ['player', 'hidden', 'card', 'delegate', 'admin', 'gm']
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'daily' }] }, 'disabled-initial')
  const binding = directory.resolve(target), sources = new Map(), sends = [], privateSends = [], modelCalls = [], logs = []
  const groupLogs = createAgentGroupLogStore(redis.storage), inbox = createAgentInbox(redis.storage)
  const config = { enabled: true, builtin: { allowHiddenRoll: true }, rulePackages }
  const grant = source => ({ binding: structuredClone(binding), revision: 'grant-one', actorId: source.sender.id, permissions: [...permissions] })
  const members = () => ({ target: structuredClone(target), observedAt: Date.now(), complete: true,
    members: [{ user: structuredClone(actor), displayName: 'Fresh Alice', role: 'member' }] })
  const key = messageId => redis.prefix + 'agent:dice:engine:v1:operation:' + hash([conversationAddressKey(target), messageId])
  const queueKeys = ['group-log', 'group-text', 'simulation', 'private', 'privacy'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  function makeHost() {
    const adapter = { id: 'connection', account, botUserId: account.id, botName: 'Disabled dice fixture', isReady: () => ready,
      async start(consume) { receive = consume; ready = true }, stop() { ready = false },
      async readMessage(_target, id, guard) { return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(id)) },
      async listConversationMembers(_target, guard) { return guard.isCurrent() ? members() : undefined },
      actions: {
        async send(action, guard) {
          await guard?.ensureCurrent?.(); if (guard?.isCurrent?.() === false) return { state: 'failed' }
          sends.push(structuredClone(action)); return { state: 'sent', messageId: 'native-public-' + ++receipt }
        },
        async sendDicePrivate(request, guard) {
          await guard.ensureCurrent(); if (!guard.isCurrent()) return { state: 'failed' }
          privateSends.push(structuredClone(request)); return { state: 'sent', messageId: 'native-private-' + ++receipt }
        },
      },
    }
    return createAgentRuntime({ storage: redis.storage, adapters: [adapter], isExecutionCurrent: redis.isCurrent,
      dice: { enabled: false }, ...(omittedEngine ? {} : { diceEngine: { ...config, enabled } }),
      readDiceGrant: async ({ source }) => grant(source), groupLog: { enabled: false },
      useTextGroup: () => true, textGroupRevision: 'disabled-core',
      resolvePersona(address) { const selected = directory.resolve(address); return selected && { binding: selected, persona: { name: 'Dice test' }, systemContent: 'Isolated disabled dice regression' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, wakeGate: { enabled: false },
        rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 1000, maxToolRounds: 2, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } }),
      getExecutionConfig: () => ({}), logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
      async YTapi(request) { modelCalls.push(request); return { choices: [{ message: { content: 'ordinary chat' } }] } },
    })
  }
  const f = { state, ledger, binding, target, sends, privateSends, modelCalls,
    message(text) { const row = { version: 1, conversation: target, sender: actor, senderName: 'Fresh Alice', messageId: 'disabled-source-' + ++serial,
      occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false }; sources.set(row.messageId, structuredClone(row)); return row },
    async operation(message) { const raw = await redis.reader.get(key(message.messageId)); return raw ? JSON.parse(raw) : null },
    async emit(message) { await receive({ kind: 'message', message: structuredClone(message) }); await f.drained() },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total=0; for _, key in ipairs(KEYS) do total=total+redis.call('LLEN',key) end; return total", { keys: queueKeys, arguments: [] })) === 0,
        () => 'Core inbox not drained: ' + logs.slice(-5).join('\n'))
      await host.runtime.drain()
    },
    async start() { await host.start(); await f.drained() },
    async enable() { await host.stop(); enabled = true; omittedEngine = false; host = makeHost(); await host.start() },
    async queueWithoutDicePolicy(message) {
      const queue = await inbox.accept({ event: { kind: 'message', message: structuredClone(message) }, bindingToken: agentBindingToken(binding) }, undefined, undefined,
        { kind: 'group-log', groupLog: { agentId: binding.agentId, ...await groupLogs.capture({ target, agentId: binding.agentId }, message.sender.id) } })
      const entries = (await redis.reader.lRange(queueKeys[0], 0, -1)).map(raw => JSON.parse(raw))
      const stored = entries.find(entry => entry.event.message.messageId === message.messageId)
      assert.ok(stored); assert.equal(Object.hasOwn(stored.groupLog, 'dicePolicy'), false)
      return queue
    },
    async freeze(message) {
      const bridge = createAgentDiceHostBridge(config, { state: { ...state, async claimEffect() { return undefined } }, legacyLedger: ledger,
        readGrant: async ({ source }) => grant(source), readMessage: async ({ messageId }) => structuredClone(sources.get(messageId)),
        readMembers: async () => members(), sourceAllowed: async () => true, allowsText: () => true,
        async sendPublic() { assert.fail('ready operation cannot dispatch before its effect claim') },
        async relayPrivate() { assert.fail('ready operation cannot dispatch privately before its effect claim') },
      })
      assert.equal(await bridge.handle(message, binding, { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }), true)
      const operation = await f.operation(message)
      assert.equal(operation.state, 'ready'); assert.ok(operation.requested > 0); assert.ok(operation.effects.length > 0)
      return operation
    },
  }
  host = makeHost(); if (settings.start !== false) await host.start(); return f
}
async function yamlPackage() {
  const source = JSON.stringify({ version: 1, id: 'disabled-rules', name: 'Disabled rules', aliases: ['customprefix'],
    character: { fields: { hp: { type: 'integer', default: 12, min: 0, max: 12 } } },
    commands: [{ id: 'hello', aliases: ['hello'], output: 'Custom rule reached Core.' }] })
  return compileAgentDiceRulePackage({ kind: 'yaml', source, revision: 'disabled-rule-one', sourceHash: createHash('sha256').update(source).digest('hex') })
}
for (const text of ['.st SAN=60', '.rh 1d6', '.r 1d6', '.customprefix hello', '.st SAN=60.rh 1d6']) {
  test(`disabled actual Core ingress revokes frozen ${text} with group logging off; fresh sources survive enable`, options, async t => {
    const packages = text.includes('customprefix') ? [await yamlPackage()] : [], f = await fixture(t, packages), old = f.message(text)
    const before = await f.freeze(old)
    await f.emit(old)
    const revoked = await f.operation(old)
    assert.equal(revoked.state, 'unknown', 'disabled ingress must seal every recognized Engine source')
    assert.equal(Object.hasOwn(revoked, 'effects'), false, 'disabled ingress must erase frozen native output')
    assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0); assert.equal(f.modelCalls.length, 0)
    await f.enable(); await f.emit(old)
    assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0, 'old source cannot revive after enable')
    assert.equal((await f.operation(old)).id, before.id)
    const fresh = f.message(text); await f.emit(fresh)
    assert.equal((await f.operation(fresh)).state, 'confirmed', 'new source remains usable after enable')
    assert.ok(f.sends.length + f.privateSends.length > 0); assert.equal(f.modelCalls.length, 0)
    assert.equal(f.privateSends.some(row => row.source.messageId === old.messageId || row.origin.source.messageId === old.messageId), false)
  })
}

test('disabled Core with its entire Engine and rule packages removed seals a known custom-prefix ready source', options, async t => {
  const f = await fixture(t, [await yamlPackage()], { omitEngine: true }), old = f.message('.customprefix hello')
  await f.freeze(old)
  assert.equal(await f.state.hasSourceByTarget(f.target, old.messageId), true)
  await f.emit(old)
  const revoked = await f.operation(old)
  assert.equal(revoked.state, 'unknown'); assert.equal(Object.hasOwn(revoked, 'effects'), false)
  assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0); assert.equal(f.modelCalls.length, 0)
  await f.enable(); await f.emit(old)
  assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0)
  const fresh = f.message('.customprefix hello'); await f.emit(fresh)
  assert.equal((await f.operation(fresh)).state, 'confirmed')
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].replyTo, fresh.messageId); assert.equal(f.modelCalls.length, 0)
})

test('disabled recovery seals builtin and removed custom-prefix ready sources in actual old group-log queues without dicePolicy', options, async t => {
  const f = await fixture(t, [await yamlPackage()], { omitEngine: true, start: false })
  const oldSources = [f.message('.st SAN=60'), f.message('.customprefix hello')]
  for (const old of oldSources) { await f.freeze(old); await f.queueWithoutDicePolicy(old) }
  await f.start()
  for (const old of oldSources) {
    const revoked = await f.operation(old)
    assert.equal(revoked.state, 'unknown'); assert.equal(Object.hasOwn(revoked, 'effects'), false)
  }
  assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0); assert.equal(f.modelCalls.length, 0)
  await f.enable()
  for (const old of oldSources) await f.emit(old)
  assert.equal(f.sends.length, 0); assert.equal(f.privateSends.length, 0, 'removed queued authority must not revive when Engine returns')
  for (const text of ['.st SAN=60', '.customprefix hello']) {
    const fresh = f.message(text); await f.emit(fresh)
    assert.equal((await f.operation(fresh)).state, 'confirmed')
    assert.ok(f.sends.some(action => action.replyTo === fresh.messageId))
  }
  assert.equal(f.modelCalls.length, 0)
})
