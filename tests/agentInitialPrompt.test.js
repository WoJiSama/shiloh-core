import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { stageInitialPromptTransfer } from '../dist/backend/bootstrap/standaloneAgentPromptMigration.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationInitialPromptApplicationKey, simulationInitialPromptKey } from '../dist/backend/modules/simulation/infrastructure/simInitialPrompt.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const botId = '91001'
const account = { platform: 'qq', namespace: 'global', id: botId }
const freshGroup = { account, kind: 'group', id: '92001' }
const activeGroup = { account, kind: 'group', id: '92002' }
const versionedGroup = { account, kind: 'group', id: '92003' }
const group = activeGroup
const fixedTime = Date.UTC(2026, 9, 10, 10)
const prefix = 'agent-test:'
const logger = { info() {}, warn() {}, error() {} }

function directory(revision) {
  return createAgentBindingDirectory({
    version: 1,
    agents: [{ id: 'agent-role', personaId: 'default' }],
    connections: [{ id: 'qq-main', platform: 'qq', namespace: 'global', accountId: botId }],
    bindings: [freshGroup, activeGroup, versionedGroup].map(target => ({
      connectionId: 'qq-main', kind: target.kind, conversationId: target.id, agentId: 'agent-role',
    })),
  }, revision)
}

function sourceSession(binding, fields = {}) {
  return JSON.stringify({
    ...createDefaultSimSession(fixedTime), botId, personaId: agentPersonaScopeId(binding.agentId),
    bindingToken: agentBindingToken(binding), ...fields,
  })
}

test('prompt transfer stages exact source account and binding proof and refuses target overwrites', async () => {
  const before = directory('source-revision').resolve(group)
  const after = directory('target-revision').resolve(group)
  const address = simulationAddressKey(group)
  const legacySessionKey = simulationSessionKey(group.id)
  const scopedSessionKey = simulationSessionKey(address)
  const legacyPromptKey = simulationInitialPromptKey(group.id)
  const scopedPromptKey = simulationInitialPromptKey(address)
  const source = '管理员配置仅限所选 QQ 群'
  const values = new Map([[legacyPromptKey, source]])
  const redis = { async mGet(keys) { return keys.map(key => values.get(key) ?? null) } }
  const stage = () => stageInitialPromptTransfer(redis, prefix, after, before, fixedTime)

  assert.deepEqual((await stage()).report, { status: 'retained', reason: 'unprovenBinding' })
  values.set(legacySessionKey, sourceSession(before, { botId: '91002' }))
  assert.deepEqual((await stage()).report, { status: 'retained', reason: 'unprovenBinding' })
  values.set(legacySessionKey, sourceSession(before, { bindingToken: 'superseded' }))
  assert.deepEqual((await stage()).report, { status: 'retained', reason: 'unprovenBinding' })
  values.set(legacySessionKey, sourceSession(before))
  values.set(scopedPromptKey, '另一个可能的群配置')
  assert.deepEqual((await stage()).report, { status: 'retained', reason: 'ambiguousSource' })
  values.set(scopedPromptKey, source)

  const staged = await stage()
  assert.deepEqual(staged.report, { status: 'copied', firstModelCall: true })
  assert.ok(!JSON.stringify(staged.report).includes(source))
  const byKey = new Map(staged.checks.map(entry => [entry.key, entry]))
  assert.deepEqual(byKey.get(legacyPromptKey), { key: legacyPromptKey, value: source })
  assert.deepEqual(byKey.get(legacySessionKey), { key: legacySessionKey, value: values.get(legacySessionKey) })
  assert.deepEqual(byKey.get(scopedSessionKey), { key: scopedSessionKey, value: null })
  assert.deepEqual(byKey.get(simulationBusyKey(group.id)), { key: simulationBusyKey(group.id), value: null })
  assert.deepEqual(byKey.get(prefix + simulationInitialPromptKey(address)), { key: prefix + scopedPromptKey, value: null, write: source })
  assert.equal(JSON.parse(byKey.get(prefix + simulationInitialPromptApplicationKey(address)).write).bindingToken, agentBindingToken(after))
  assert.equal(JSON.parse(byKey.get(prefix + simulationInitialPromptApplicationKey(address)).write).pending, true)

  values.set(prefix + scopedPromptKey, '目标已有管理员配置')
  await assert.rejects(stage(), /目标已有仿真初始提示词/u)
  values.delete(prefix + scopedPromptKey)
  values.set(legacySessionKey, sourceSession(before, { bootstrapSent: true }))
  assert.deepEqual((await stage()).report, { status: 'copied', firstModelCall: false })

  values.set(legacySessionKey, sourceSession(before, { botId: '91002' }))
  values.set(scopedSessionKey, sourceSession(before))
  assert.deepEqual((await stage()).report, { status: 'copied', firstModelCall: true })
  const marker = staged.checks.find(entry => entry.key.includes('agent:migration:qq-init:'))
  values.set(marker.key, marker.write)
  assert.deepEqual(await stage(), { checks: [], report: { status: 'alreadyCopied' } })
  await assert.rejects(stageInitialPromptTransfer(redis, prefix, { ...after, personaId: 'changed' }, before, fixedTime), /同一 QQ 群角色绑定/u)
})

async function waitFor(probe, label) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await probe()) return
    await delay(15)
  }
  assert.fail(`等待超时：${label}`)
}

test('standalone model consumes a verified pending prompt once and reset rearms a dormant migration', {
  skip: !redisAvailable, timeout: 18_000,
}, async t => {
  const { reader, storage, prefix: targetPrefix, isCurrent } = await createAgentRedisFixture(t, 'qq-init-prompt')
  const sourceBindings = directory('source-revision')
  let destinationBindings = directory('target-revision')
  const requests = []
  let accept
  let ready = false
  const adapter = {
    id: 'qq-main', account, botUserId: botId, botName: 'fixture',
    actions: { async send() { return { state: 'failed', code: 'not_needed' } } },
    async start(receive) { accept = receive; ready = true },
    isReady: () => ready,
    stop() { ready = false },
  }
  const texts = new Map([[freshGroup.id, '迁入待用的本群初始说明'], [activeGroup.id, '迁入已运行本群的初始说明'], [versionedGroup.id, '绑定变化需要复核的初始说明']])
  for (const target of [freshGroup, activeGroup, versionedGroup]) {
    const source = sourceBindings.resolve(target)
    const destination = destinationBindings.resolve(target)
    const address = simulationAddressKey(target)
    const active = target === activeGroup
    await reader.set(simulationSessionKey(address), sourceSession(source, active ? { bootstrapSent: true, seq: 12, lastWakeAt: fixedTime } : {}))
    await reader.set(simulationInitialPromptKey(address), texts.get(target.id))
    const staged = await stageInitialPromptTransfer(reader, targetPrefix, destination, source, fixedTime)
    assert.deepEqual(staged.report, { status: 'copied', firstModelCall: !active })
    for (const check of staged.checks) {
      assert.equal(await reader.get(check.key), check.value)
      if (check.write !== undefined) await reader.set(check.key, check.write)
    }
    // The real controls transfer preserves the prior session's established shape.
    await reader.set(targetPrefix + simulationSessionKey(address), sourceSession(destination, { bootstrapSent: true }))
  }
  const runtime = createAgentRuntime({
    storage, adapters: [adapter], logger, isExecutionCurrent: isCurrent,
    resolvePersona(target) {
      const binding = destinationBindings.resolve(target)
      return binding && { binding, persona: { name: 'fixture' }, systemContent: '' }
    },
    getSection: () => ({ wake: { batchWindowMs: 1_000 }, rhythm: { enabled: false }, reflection: { enabled: false } }),
    getExecutionConfig: () => ({ useTools: true }),
    async YTapi(request) {
      const content = request.messages.map(message => String(message.content ?? '')).join('\n')
      requests.push(content)
      if (content.includes('模拟模型失败后的首次领取') && content.includes(texts.get(activeGroup.id))) return { error: 'fixture failure' }
      if (content.includes('触发一次布局')) {
        if (request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'layout')) return { choices: [{ message: { content: '沉默' } }] }
        return { choices: [{ message: { content: '', tool_calls: [{ id: 'layout', function: { name: 'simGetState', arguments: '{}' } }] } }] }
      }
      return { choices: [{ message: { content: '沉默' } }] }
    },
  })
  const stateKey = target => targetPrefix + simulationSessionKey(simulationAddressKey(target))
  const send = (conversation, messageId, text) => accept({
    kind: 'message', message: { version: 1, conversation, sender: { ...account, id: '93001' }, messageId,
      occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true },
  })
  const called = (text, minimum = 1) => waitFor(() => requests.filter(content => content.includes(text)).length >= minimum, text)
  const idle = target => waitFor(async () => await reader.exists(targetPrefix + simulationBusyKey(simulationAddressKey(target))) === 0, '回合结束')
  try {
    await runtime.start()
    await send(freshGroup, '1001', '触发一次布局后读完本群说明')
    await called('触发一次布局后读完本群说明', 2)
    await idle(freshGroup)
    const freshText = texts.get(freshGroup.id)
    assert.equal(requests.filter(content => content.includes(freshText)).length, 1)
    assert.ok(!JSON.stringify(JSON.parse(await reader.get(stateKey(freshGroup))).agentHistory).includes(freshText))
    await send(freshGroup, '1002', '查看第二条正常消息')
    await called('查看第二条正常消息')
    await idle(freshGroup)
    assert.ok(!requests.at(-1).includes(freshText))

    await send(activeGroup, '2001', '已运行源群的第一条')
    await called('已运行源群的第一条')
    await idle(activeGroup)
    const activeText = texts.get(activeGroup.id)
    assert.ok(!requests.at(-1).includes(activeText))
    assert.equal(await runtime.runtime.getInitialPrompt(simulationAddressKey(activeGroup)), activeText)
    await runtime.runtime.resetGroup(simulationAddressKey(activeGroup))
    await send(activeGroup, '2002', '模拟模型失败后的首次领取')
    await called('模拟模型失败后的首次领取')
    await idle(activeGroup)
    assert.ok(requests.at(-1).includes(activeText))
    await send(activeGroup, '2003', '失败后后续消息也不能重放')
    await called('失败后后续消息也不能重放')
    await idle(activeGroup)
    assert.ok(!requests.at(-1).includes(activeText))

    destinationBindings = directory('updated-revision')
    await send(versionedGroup, '3001', '绑定版本变化之后')
    await called('绑定版本变化之后')
    await idle(versionedGroup)
    const versionedText = texts.get(versionedGroup.id)
    assert.ok(!requests.at(-1).includes(versionedText))
    await runtime.runtime.resetGroup(simulationAddressKey(versionedGroup))
    await send(versionedGroup, '3002', '新绑定版本下管理员明确重置')
    await called('新绑定版本下管理员明确重置')
    await idle(versionedGroup)
    assert.ok(requests.at(-1).includes(versionedText))
    assert.equal(JSON.parse(await reader.get(targetPrefix + simulationInitialPromptApplicationKey(simulationAddressKey(versionedGroup)))).pending, false)
  } finally { await runtime.stop() }
})
