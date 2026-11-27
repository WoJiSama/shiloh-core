import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const { conversationAddressKey } = await importBilibiliHost('modules/runtime/domain/agentBindings.js')
const target = { account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001' }
const sideModel = { baseUrl: 'https://trigger.example/v1', name: 'compact-gate', apiKeyEnv: 'TRIGGER_KEY' }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-text-trigger-config-'))
  const file = path.join(directory, 'agent-host.yaml')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: target.account.id }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'daily' }],
  }))
  const raw = {
    version: 1, instance: 'text-trigger-config', dataDir: 'untouched-data',
    model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
  }
  return { directory, async read(changes = {}, env = { MAIN_KEY: 'private-model-key' }, options) {
    await writeFile(file, JSON.stringify({ ...raw, ...changes }))
    return readStandaloneAgentConfig(file, env, options)
  } }
}

function watchedEnvironment(values, allowed) {
  const reads = []
  return { reads, env: new Proxy(values, { get(object, key) {
    reads.push(key)
    assert.ok(allowed.includes(key), `unexpected environment lookup: ${String(key)}`)
    return Reflect.get(object, key)
  } }) }
}

test('omitted and empty text-trigger configuration preserve immutable strict defaults', async t => {
  const f = await fixture(t)
  for (const changes of [{}, { textTrigger: {} }]) {
    const { env, reads } = watchedEnvironment({ MAIN_KEY: 'private-model-key' }, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
    const config = await f.read(changes, env), trigger = config.textTrigger
    assert.equal(trigger.mode, 'strict')
    assert.deepEqual(trigger.triggerPrefixes, [])
    assert.deepEqual(trigger.tracking, { enabled: false, timeoutMs: 120_000, throttleMs: 3000, batchDelayMs: 10_000 })
    assert.equal(trigger.smart.talkValue, 0.07)
    assert.equal(trigger.smart.directTriggerMergeMs, 1000)
    assert.equal(trigger.smart.toolRequestMergeMs, 600)
    assert.equal(trigger.smart.directTriggerMergeMaxMessages, 8)
    assert.equal(trigger.smart.replyDebounceMs, 1500)
    assert.equal(trigger.smart.minDeferredMs, 120_000)
    assert.equal(trigger.smart.maxDeferredMs, 900_000)
    assert.equal(trigger.smart.deferredGateEnabled, true)
    assert.equal(trigger.smart.waitToolEnabled, true)
    assert.equal(trigger.smart.maxConsecutiveInterrupts, 3)
    assert.equal(trigger.smart.smartLockTimeoutMs, 180_000)
    assert.deepEqual(trigger.smart.attentionDrift, { enabled: true, level: 'normal', windowMinutes: 5 })
    assert.deepEqual(trigger.smart.groupTalkValues, [])
    assert.deepEqual(trigger.smart.talkValueRules, [
      { range: '08:00-22:59', value: 0.07 }, { range: '23:00-23:59', value: 0.05 }, { range: '00:00-07:59', value: 0.034 },
    ])
    for (const value of [trigger, trigger.triggerPrefixes, trigger.tracking, trigger.smart, trigger.smart.attentionDrift,
      trigger.smart.groupTalkValues, trigger.smart.talkValueRules, ...trigger.smart.talkValueRules]) assert.ok(Object.isFrozen(value))
    assert.equal(config.textTriggerModel, undefined)
    assert.deepEqual(reads, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
  }
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('explicit smart, tracking and millisecond settings survive host parsing without unit conversion', async t => {
  const f = await fixture(t)
  const config = await f.read({ textTrigger: {
    mode: 'smart', triggerPrefixes: ['小白', '!ask', '小白'],
    tracking: { enabled: true, timeoutMs: 45_678, throttleMs: 321, batchDelayMs: 1234 },
    smart: { talkValue: 0.3, directTriggerMergeMs: 432, toolRequestMergeMs: 123, replyDebounceMs: 567,
      directTriggerMergeMaxMessages: 6, maxConsecutiveInterrupts: 0, smartLockTimeoutMs: 89_012,
      deferredGateEnabled: false, waitToolEnabled: false, minDeferredMs: 1111, maxDeferredMs: 2222,
      attentionDrift: { enabled: false, level: 'subtle', windowMinutes: 7 },
      enableTalkValueRules: true, talkValueRules: [{ range: '23:30-01:05', value: 0.2 }] },
  } })
  assert.equal(config.textTrigger.mode, 'smart')
  assert.deepEqual(config.textTrigger.triggerPrefixes, ['小白', '!ask'])
  assert.deepEqual(config.textTrigger.tracking, { enabled: true, timeoutMs: 45_678, throttleMs: 321, batchDelayMs: 1234 })
  for (const [key, value] of Object.entries({ talkValue: 0.3, directTriggerMergeMs: 432, toolRequestMergeMs: 123,
    replyDebounceMs: 567, directTriggerMergeMaxMessages: 6, maxConsecutiveInterrupts: 0, smartLockTimeoutMs: 89_012,
    deferredGateEnabled: false, waitToolEnabled: false, minDeferredMs: 1111, maxDeferredMs: 2222, enableTalkValueRules: true })) {
    assert.equal(config.textTrigger.smart[key], value)
  }
  assert.deepEqual(config.textTrigger.smart.attentionDrift, { enabled: false, level: 'subtle', windowMinutes: 7 })
  assert.deepEqual(config.textTrigger.smart.talkValueRules, [{ range: '23:30-01:05', value: 0.2 }])
})

test('the host rejects unknown trigger fields, malformed sections and invalid nested values', async t => {
  const f = await fixture(t)
  for (const textTrigger of [null, [], true, 1, 'smart', { mode: 'auto' }, { mode: null },
    { enabled: true }, { model: sideModel }, { triggerPrefixes: [''] }, { triggerPrefixes: '小白' },
    { tracking: null }, { tracking: { enabled: 'true' } }, { tracking: { batchDelaySeconds: 10 } },
    { tracking: { timeoutMs: 999 } }, { tracking: { throttleMs: -1 } }, { tracking: { batchDelayMs: 60_001 } },
    { smart: null }, { smart: { unknown: true } }, { smart: { talkValue: '0.2' } }, { smart: { talkValue: 0 } },
    { smart: { waitToolEnabled: 1 } }, { smart: { directTriggerMergeMs: 1.5 } },
    { smart: { directTriggerMergeMaxMessages: 21 } }, { smart: { minDeferredMs: 2000, maxDeferredMs: 1000 } },
    { smart: { attentionDrift: { enabled: 'false' } } }, { smart: { attentionDrift: { extra: 1 } } },
    { smart: { attentionDrift: { level: 'high' } } }, { smart: { attentionDrift: { windowMinutes: 0 } } },
    { smart: { talkValueRules: [{ range: '8:00-22:59', value: 0.2 }] } },
    { smart: { talkValueRules: [{ range: '00:00-24:00', value: 0.2 }] } },
    { smart: { talkValueRules: [{ range: '00:00-01:00', value: 0.2, timezone: 'UTC' }] } },
  ]) await assert.rejects(f.read({ textTrigger }), /textTrigger\./u)
})

test('group talk-value overrides retain complete account and namespace identities in both accepted forms', async t => {
  const f = await fixture(t)
  const targets = [target,
    { ...target, account: { ...target.account, id: '123456002' } },
    { ...target, account: { ...target.account, namespace: 'tenant-b' } },
  ]
  const entries = targets.map((target, index) => ({ target, value: (index + 1) / 10 }))
  const fromArray = await f.read({ textTrigger: { smart: { groupTalkValues: [...entries, { bindingId: 'named-binding', value: 0.4 }] } } })
  assert.deepEqual(fromArray.textTrigger.smart.groupTalkValues, [...entries, { bindingId: 'named-binding', value: 0.4 }])
  const fromMap = await f.read({ textTrigger: { smart: { groupTalkValues: Object.fromEntries(entries.map(entry => [conversationAddressKey(entry.target), entry.value])) } } })
  assert.deepEqual(fromMap.textTrigger.smart.groupTalkValues, entries)
  assert.equal(new Set(fromMap.textTrigger.smart.groupTalkValues.map(entry => conversationAddressKey(entry.target))).size, 3)
  for (const entry of fromMap.textTrigger.smart.groupTalkValues) {
    assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.target)); assert.ok(Object.isFrozen(entry.target.account))
  }
})

test('group talk-value overrides reject legacy naked groups, incomplete addresses and duplicate targets', async t => {
  const f = await fixture(t)
  for (const groupTalkValues of [
    { '90001': 0.2 }, [{ group: '90001', value: 0.2 }], [{ target: { kind: 'group', id: '90001' }, value: 0.2 }],
    [{ target: { ...target, account: { platform: 'qq', id: target.account.id } }, value: 0.2 }],
    [{ target, value: 0.2 }, { target, value: 0.3 }], [{ bindingId: 'same', value: 0.2 }, { bindingId: 'same', value: 0.3 }],
    [{ target, bindingId: 'ambiguous', value: 0.2 }], [{ target, value: 0.001 }],
    { [JSON.stringify(['qq', 'global', target.account.id, 'group', target.id], null, 1)]: 0.2 },
  ]) await assert.rejects(f.read({ textTrigger: { smart: { groupTalkValues } } }), /textTrigger\.smart\.groupTalkValues/u)
})

test('an explicit side model resolves its declared key independently from main execution settings', async t => {
  const f = await fixture(t)
  const { env, reads } = watchedEnvironment({ MAIN_KEY: ' private-model-key ', TRIGGER_KEY: ' private-trigger-key ' },
    ['MAIN_KEY', 'TRIGGER_KEY', 'BL_AGENT_REDIS_URL'])
  const config = await f.read({ textTrigger: { mode: 'smart' }, textTriggerModel: { ...sideModel, name: ' compact-gate ' } }, env)
  assert.deepEqual(config.textTriggerModel, { apiUrl: sideModel.baseUrl, model: 'compact-gate', apiKey: 'private-trigger-key', apiKeyEnv: 'TRIGGER_KEY' })
  assert.deepEqual(config.execution.chatAiConfig, { chatApiUrl: 'https://main.example/v1', chatApiModel: 'main-model', chatApiKey: 'private-model-key' })
  assert.deepEqual(config.execution.toolsAiConfig, { toolsAiUrl: 'https://main.example/v1', toolsAiModel: 'main-model', toolsAiApikey: 'private-model-key' })
  assert.deepEqual(reads, ['MAIN_KEY', 'TRIGGER_KEY', 'BL_AGENT_REDIS_URL'])
})

test('declared side-model credentials are required for startup while credential-free inspection performs no storage writes', async t => {
  const f = await fixture(t)
  await assert.rejects(f.read({ textTriggerModel: sideModel }), /TRIGGER_KEY/u)
  await assert.rejects(f.read({ textTriggerModel: sideModel }, { MAIN_KEY: 'main', TRIGGER_KEY: '  ' }), /TRIGGER_KEY/u)
  const { env, reads } = watchedEnvironment({}, ['MAIN_KEY', 'TRIGGER_KEY', 'BL_AGENT_REDIS_URL'])
  const config = await f.read({ textTrigger: { mode: 'smart' }, textTriggerModel: sideModel }, env, { requireCredentials: false })
  assert.equal(config.textTriggerModel.apiKey, '')
  assert.equal(config.execution.chatAiConfig.chatApiKey, '')
  assert.deepEqual(reads, ['MAIN_KEY', 'TRIGGER_KEY', 'BL_AGENT_REDIS_URL'])
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('strict and smart direct text-group configuration remain available without a side model or empty-key lookup', async t => {
  const f = await fixture(t)
  for (const mode of ['strict', 'smart']) {
    const { env, reads } = watchedEnvironment({ MAIN_KEY: 'private-model-key' }, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
    const config = await f.read({ textTrigger: { mode, triggerPrefixes: ['小白'] },
      textGroups: [{ connectionId: 'main', conversationId: target.id }] }, env)
    assert.equal(config.textTrigger.mode, mode)
    assert.deepEqual(config.textTrigger.triggerPrefixes, ['小白'])
    assert.equal(config.textTriggerModel, undefined)
    assert.deepEqual(config.migratedGroupToolNames(target), [])
    assert.ok(config.resolvePersona(target)?.binding)
    assert.equal(config.checkBindings().get('main').simulationGroups, 1)
    assert.deepEqual(reads, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
    assert.equal(reads.includes(''), false)
  }
})

test('side-model declarations reject raw credentials, unknown fields and invalid endpoints or key names before secret lookup', async t => {
  const f = await fixture(t)
  for (const textTriggerModel of [null, false, [], {},
    { ...sideModel, apiKey: 'raw-key' }, { ...sideModel, model: 'alias' }, { ...sideModel, enabled: false },
    ...['', ' ', 1, 'lowercase', 'BAD-NAME'].map(apiKeyEnv => ({ ...sideModel, apiKeyEnv })),
    ...['not-a-url', 'file:///tmp/model', 'https://user:pass@trigger.example/v1',
      'https://trigger.example/v1?api_key=secret', 'https://trigger.example/v1#fragment'].map(baseUrl => ({ ...sideModel, baseUrl })),
    { ...sideModel, name: '' }, { ...sideModel, name: ' ' },
  ]) {
    const { env, reads } = watchedEnvironment({ MAIN_KEY: 'private-model-key' }, ['MAIN_KEY'])
    await assert.rejects(f.read({ textTriggerModel }, env))
    assert.deepEqual(reads, ['MAIN_KEY'])
    assert.equal(reads.includes(''), false)
  }
})

test('changing trigger behavior or the declared side model revokes the previous loaded configuration snapshot', async t => {
  const f = await fixture(t), env = { MAIN_KEY: 'private-model-key', TRIGGER_KEY: 'private-trigger-key' }
  const first = await f.read({ textTrigger: { mode: 'strict' } }, env)
  assert.equal(first.isConfigCurrent(), true)
  const second = await f.read({ textTrigger: { mode: 'smart' } }, env)
  assert.equal(first.isConfigCurrent(), false); assert.equal(second.isConfigCurrent(), true)
  const third = await f.read({ textTrigger: { mode: 'smart' }, textTriggerModel: sideModel }, env)
  assert.equal(second.isConfigCurrent(), false); assert.equal(third.isConfigCurrent(), true)
  await f.read({ textTrigger: { mode: 'smart' }, textTriggerModel: { ...sideModel, name: 'another-gate' } }, env)
  assert.equal(third.isConfigCurrent(), false)
})
