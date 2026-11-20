import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCharacterSharedSelf } from '../dist/backend/modules/simulation/infrastructure/characterSharedSelf.js'
import { createCharacterWorkspace } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { CHARACTER_MIN_WAKE_MS, addCharacterMemory, beginCharacterGoalAttempt, characterKey, createCharacterGoal, createEmptyCharacterState, deleteCharacterMemory } from '../dist/backend/modules/simulation/domain/characterState.js'
import { resolveCharacterConsistencyRoute } from '../dist/backend/modules/simulation/infrastructure/characterConsistencyRouting.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { SIMULATION_KNOWN_GROUPS_KEY } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentConversationKey, createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'
import { createCommitmentRuntime } from '../dist/backend/modules/commitments/infrastructure/commitmentTool.js'
import { createDelegateMemoryRuntime } from '../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'
import { createGroupKnowledgeTool } from '../dist/backend/modules/memory/infrastructure/groupKnowledgeTool.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

const BOT = '3094088525'
const GROUP = '10086'
const OTHER_GROUP = '10087'
const BASE_AT = 1_790_000_000_000
const sessionKey = groupId => `shiloh:sim:g:${groupId}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let callSequence = 0
let incomingMessageId = 0
const toolCall = (name, args) => ({ id: `test-call-${++callSequence}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'simSendMessage' ? { continuation: 'chat', ...args } : args) } })
const tools = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })
const rawEmpty = () => ({ role: 'assistant', content: '' })
const finishSilently = () => tools(toolCall('simFinishTurn', { choice: 'silent', reason: '本次测试回合明确安静结束' }))
const finalText = content => ({ role: 'assistant', content })

async function waitFor(check, description, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(25)
  }
  assert.fail(`等待超时：${description}`)
}

function seedSession(kv, groupId, botId, clock) {
  const state = createDefaultSimSession(clock.value)
  state.bootstrapSent = true
  state.botId = botId
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  kv.set(sessionKey(groupId), JSON.stringify(state))
}

/** No model, network or QQ adapters: only the compiled production runtime is exercised. */
function fixture({
  kv = new Map(), clock = { value: BASE_AT }, botId = BOT,
  identity = { id: 'shiloh', name: '希洛', systemContent: '喜欢独立游戏' },
  groups = [GROUP], script = () => finishSilently(), execute, writeFault, onSave, send, review, recordTokens,
  proactiveProbability = 0, seed = true, maxToolRounds = 8, maxSendsPerTurn, consistencyEnabled,
  runCharacterWorker, recordToolResult, judgeSocialPermission, getPersona, loadDelegatedMemories,
  getSelf, handlesTarget, messageActions, getTodaySpendCny, durableIngress, isAccountReady, readFault,
  describeImages, fetchImageBase64, getForwardContent, registeredTools = [], boundTools = [],
  readCognition, projectCognition, recordEpisode,
} = {}) {
  if (seed) for (const groupId of groups) if (!kv.has(sessionKey(groupId))) seedSession(kv, groupId, botId, clock)
  const calls = []
  const events = []
  const sent = []
  const errors = []
  const writes = []
  const legacyTools = ['searchInformationTool', 'ownerAdminTool', 'simDangerTool'].map(name => ({
    name, description: `测试隔离工具 ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args, event) {
      events.push({ name, args, event })
      return execute ? await execute(name, args, event) : { ok: true, result: '公开搜索结果' }
    },
  }))
  const toolDefinitions = [...legacyTools, ...registeredTools]
  const redis = {
    async get(key) { if (readFault) await readFault(key); return kv.has(key) ? kv.get(key) : null },
    async set(key, value) {
      if (writeFault) await writeFault(key, value)
      writes.push({ key, value })
      kv.set(key, value)
      if (onSave) await onSave(key, value)
      return 'OK'
    },
    async del(...keys) { let count = 0; for (const key of keys) if (kv.delete(key)) count += 1; return count },
  }
  const runtime = createSimulationRuntime({
    redis, now: () => clock.value, random: () => 0.99,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSelf: getSelf ?? (() => ({ id: botId, name: identity.name })),
    getPersona: getPersona ?? (() => ({ personaId: identity.id, persona: { name: identity.name }, systemContent: identity.systemContent })),
    getSection: () => ({
      enabled: true, allGroups: false, groups,
      ...(consistencyEnabled === undefined ? {} : { consistency: { enabled: typeof consistencyEnabled === 'function' ? consistencyEnabled() : consistencyEnabled } }),
      extraTools: toolDefinitions.map(tool => tool.name), toolPolicy: { mode: 'legacy' },
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability, proactiveIdleMs: 60_000 },
      turn: { maxToolRounds, minSendGapMs: 0, maxTurnsPerDay: 100, ...(maxSendsPerTurn === undefined ? {} : { maxSendsPerTurn }) },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }),
    ...(durableIngress ? { durableIngress } : {}),
    ...(isAccountReady ? { isAccountReady } : {}),
    ...(review ? { reviewCharacter: review } : {}),
    ...(recordTokens ? { recordTokens } : {}),
    ...(getTodaySpendCny ? { getTodaySpendCny } : {}),
    ...(handlesTarget ? { handlesTarget } : {}),
    ...(messageActions ? { messageActions } : {}),
    ...(runCharacterWorker ? { runCharacterWorker } : {}),
    ...(recordToolResult ? { recordToolResult } : {}),
    ...(judgeSocialPermission ? { judgeSocialPermission } : {}),
    ...(loadDelegatedMemories ? { loadDelegatedMemories } : {}),
    ...(describeImages ? { describeImages } : {}),
    ...(fetchImageBase64 ? { fetchImageBase64 } : {}),
    ...(getForwardContent ? { getForwardContent } : {}),
    ...(readCognition ? { readCognition } : {}),
    ...(projectCognition ? { projectCognition } : {}),
    ...(recordEpisode ? { recordEpisode } : {}),
    getExtraTools: names => toolDefinitions.filter(tool => names.includes(tool.name)),
    getBoundTools: () => boundTools,
    async YTapi(request) {
      calls.push(structuredClone(request))
      const message = await script(request, calls.length - 1)
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'offline-test' }
    },
    async sendGroupMessage(groupId, segments) {
      const receipt = send ? await send(groupId, segments) : { ok: true, messageId: `sent-${sent.length + 1}` }
      if (receipt.ok) sent.push({ groupId, segments })
      return receipt
    },
  })
  return {
    runtime, kv, clock, identity, botId, calls, events, sent, errors, writes,
    scope: (groupId = GROUP) => ({ botId, personaId: identity.id, groupId }),
    async ingest(text = '看看这个游戏', userId = '40000', { at = true, groupId = GROUP, source } = {}) {
      const incoming = decodeQqIncomingMessage({ group_id: groupId, self_id: botId, user_id: userId, message_id: `test-${groupId}-${++incomingMessageId}`, message_type: 'group', msg: text,
        atBot: at, message: at ? [{ type: 'at', data: { qq: botId } }, { type: 'text', data: { text } }] : [], sender: { nickname: `群友${userId}` }, ...(source ? { source } : {}) }, {now: clock.value})
      assert.ok(incoming)
      return runtime.ingest(incoming)
    },
  }
}

async function idle(harness, minCalls, groupId = GROUP) {
  await waitFor(async () => harness.calls.length >= minCalls && !(await harness.runtime.describeGroup(groupId)).running, `回合结束（模型调用至少 ${minCalls} 次）：${harness.errors.join(' | ')}`)
}

function qqBinding(revision,agentId='daily') {
  const account = {platform:'qq', namespace:'global', id:BOT}
  const address = {account, kind:'group', id:GROUP}
  return createAgentBindingDirectory({
    version:1,
    agents:[{id:'daily', personaId:'default'}, {id:'work', personaId:'default'}],
    connections:[{id:'qq-main', platform:'qq', namespace:'global', accountId:BOT}],
    bindings:[{connectionId:'qq-main', kind:'group', conversationId:GROUP, agentId}],
  }, revision).resolve(address)
}

test('cognition context reaches simulation and revoked evidence stops the closing send', async t => {
  let valid = true
  const binding = qqBinding('cognition-recall')
  const h = fixture({
    getPersona: () => ({ personaId: 'agent:daily', persona: { name: '希洛' }, systemContent: '', binding }),
    readCognition: async () => ({ text: '我喜欢探索独立解谜游戏', nodes: [], revision: 1, isCurrent: async () => valid }),
    script: request => {
      assert.ok(JSON.stringify(request).includes('我喜欢探索独立解谜游戏'))
      valid = false
      return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '讨论游戏', messages: ['这条不能发送'] }))
    },
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 1)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [])
})

test('cognition projection carries actual committed memory, receipt and confirmed send IDs', async t => {
  const projections = [], binding = qqBinding('cognition-projection')
  const h = fixture({
    durableIngress: true,
    getPersona: () => ({ personaId: 'agent:daily', persona: { name: '希洛' }, systemContent: '', binding }),
    projectCognition: async (input, guard) => { assert.equal(guard.isCurrent(), true); projections.push(structuredClone(input)) },
    script: () => tools(toolCall('simFinishTurn', { choice: 'chat', reason: '从讨论中形成兴趣',
      memories: [{ kind: 'interest', content: '我想再了解独立解谜游戏', epistemic: 'inferred', evidenceRefs: ['message:1'] }],
      messages: ['我喜欢独立解谜游戏'],
    })),
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 1)
  assert.equal(h.sent.length, 1)
  const projected = projections.at(-1)
  assert.equal(projected.agentId, 'daily')
  assert.equal(projected.conversation.kind, 'group')
  assert.ok(projected.messageRefs.some(ref => ref.seq === 1 && ref.messageId.startsWith('test-')))
  assert.equal(projected.character.memories[0].content, '我想再了解独立解谜游戏')
  assert.ok(projected.character.receipts.some(receipt => receipt.status === 'succeeded'))
  assert.deepEqual(projected.expressions.map(item => ({ messageId: item.messageId, content: item.content, participantIds: item.participantIds })),
    [{ messageId: 'sent-1', content: '我喜欢独立解谜游戏', participantIds: [BOT] }])
})

test('cognition never treats an unknown delivery as a confirmed self-expression', async t => {
  const projections = [], binding = qqBinding('cognition-unknown')
  const h = fixture({
    durableIngress: true,
    getPersona: () => ({ personaId: 'agent:daily', persona: { name: '希洛' }, systemContent: '', binding }),
    projectCognition: async input => projections.push(structuredClone(input)),
    send: async () => ({ ok: false, unknown: true }),
    script: () => tools(toolCall('simFinishTurn', { choice: 'chat', reason: '讨论游戏', messages: ['我喜欢独立游戏'] })),
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 1)
  assert.ok(projections.length > 0)
  assert.ok(projections.every(input => input.expressions.length === 0))
  assert.deepEqual(h.sent, [])
})

test('cognition-dependent simulation replies do not survive in untracked episodes, chat snapshots or model history', async t => {
  const episodes = [], binding = qqBinding('cognition-cache')
  const h = fixture({
    durableIngress: true,
    getPersona: () => ({ personaId: 'agent:daily', persona: { name: '希洛' }, systemContent: '', binding }),
    readCognition: async () => ({ text: '我喜欢探索独立解谜游戏', nodes: [], revision: 1, isCurrent: async () => true }),
    recordEpisode: async input => episodes.push(input),
    script: () => tools(toolCall('simFinishTurn', { choice: 'chat', reason: '使用带来源的兴趣', messages: ['我也想试试这款解谜游戏'] })),
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 1)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(episodes, [])
  const persisted = JSON.parse(h.kv.get(sessionKey(GROUP)))
  assert.deepEqual(persisted.agentHistory, [])
  assert.equal(persisted.lastConfirmedChat, undefined)
})

test('a QQ binding revision change stops a pending simulation send even when the persona ID is unchanged', async t => {
  let current = qqBinding('first')
  const h = fixture({
    getPersona: () => ({
      personaId:'agent:daily',
      persona:{name:'希洛'},
      systemContent:'',
      binding:current,
    }),
    script: () => {
      current = qqBinding('next')
      return tools(toolCall('simSendMessage', {messages:['迟到的仿真回复']}))
    },
  })
  t.after(() => h.runtime.stop())
  await h.ingest()
  await idle(h, 1)
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.sent, [])
  const state = JSON.parse(h.kv.get(sessionKey(GROUP)))
  assert.deepEqual(state.agentHistory, [])
  assert.equal(state.lastConfirmedChat, undefined)
})

for (const type of ['image', 'forward']) {
  test(`binding changes stop further legacy QQ ${type} downloads and vision requests in a simulation`, async t => {
    let binding = qqBinding('before-images')
    const downloads = []
    let visionCalls = 0
    const urls = ['https://images.example.test/first.png', 'https://images.example.test/second.png']
    const h = fixture({
      getPersona: () => ({ persona: { name: '希洛' }, systemContent: '', binding }),
      async fetchImageBase64(url) {
        downloads.push(url)
        if (downloads.length === 1) binding = qqBinding('after-first-download')
        return { mime: 'image/png', base64: 'fixture-image' }
      },
      getForwardContent: async () => ({ lines: ['转发夹具'], imageUrls: urls }),
      async describeImages() { visionCalls++; return '旧回合图片描述' },
      script: (_request, index) => index === 0
        ? tools(toolCall(type === 'image' ? 'simGetMessageImages' : 'simGetForward', { seq: 1 })) : finishSilently(),
    })
    t.after(() => h.runtime.stop())
    await h.runtime.ingest({ version: 1, conversation: binding.target, sender: { ...binding.target.account, id: '30000' },
      messageId: `local-visual-${type}`, occurredAt: h.clock.value, text: '点名看附件', directedToAccount: true, mentions: [],
      parts: type === 'image' ? urls.map(value => ({ kind: 'image', resource: { kind: 'url', value } })) : [{ kind: 'forward', id: 'attached-forward' }],
    })
    await idle(h, 1)
    assert.deepEqual(downloads, [urls[0]])
    assert.equal(visionCalls, 0)
    assert.equal(h.calls.length, 1)
  })
}

test('legacy QQ vision keeps its live binding check and drops a late result', async t => {
  let binding = qqBinding('before-vision')
  let visionCheck
  const beganVision = Promise.withResolvers()
  const finishVision = Promise.withResolvers()
  const h = fixture({
    getPersona: () => ({ persona: { name: '希洛' }, systemContent: '', binding }),
    fetchImageBase64: async () => ({ mime: 'image/png', base64: 'fixture-image' }),
    async describeImages(_images, { isCurrent }) {
      visionCheck = isCurrent
      beganVision.resolve()
      await finishVision.promise
      return '失效图片的描述'
    },
    script: (_request, index) => index === 0 ? tools(toolCall('simGetMessageImages', { seq: 1 })) : finishSilently(),
  })
  t.after(() => { finishVision.resolve(); h.runtime.stop() })
  await h.runtime.ingest({ version: 1, conversation: binding.target, sender: { ...binding.target.account, id: '30000' },
    messageId: 'local-vision-guard', occurredAt: h.clock.value, text: '描述这张图', directedToAccount: true, mentions: [],
    parts: [{ kind: 'image', resource: { kind: 'url', value: 'https://images.example.test/one.png' } }],
  })
  await Promise.race([beganVision.promise, idle(h, 1).then(() => assert.fail('vision did not start'))])
  const initiallyCurrent = visionCheck?.()
  binding = qqBinding('after-vision')
  finishVision.resolve()
  await idle(h, 1)
  assert.equal(h.calls.length, 1)
  assert.equal(initiallyCurrent, true)
  assert.equal(visionCheck(), false)
})

test('simulation isolates identical QQ and channel IDs through ingress, budget, recall and restart', async t => {
  const main = { kind: 'group', id: GROUP, account: { platform: 'qq', namespace: 'global', id: BOT } }
  const secondary = { ...main, account: { ...main.account, id: '3094088999' } }
  const channel = { kind: 'channel', id: GROUP, account: { platform: 'fixture', namespace: 'tenant-a', id: secondary.account.id } }
  const otherTenant = { ...channel, account: { ...channel.account, namespace: 'tenant-b' } }
  const routes = [main, secondary, channel, otherTenant]
  const directory = createAgentBindingDirectory({
    version: 1,
    agents: [{ id: 'daily', personaId: 'default' }],
    connections: routes.map(({ account }, index) => ({ id: `connection-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: routes.map(({ kind, id }, index) => ({ connectionId: `connection-${index}`, kind, conversationId: id, agentId: 'daily' })),
  }, 'shared-revision')
  const deliveries = []
  const spent = new Map()
  const kv = new Map()
  const clock = { value: BASE_AT }
  seedSession(kv, GROUP, BOT, clock)
  const old = JSON.parse(kv.get(sessionKey(GROUP)))
  old.recent = [{ seq: 1, text: '老 QQ 会话历史', at: BASE_AT - 1000, userId: '40000', name: '群友', kind: 'text', messageId: 'legacy-1' }]
  old.seq = 1
  old.budget.turns = 3
  kv.set(sessionKey(GROUP), JSON.stringify(old))
  const options = {
    kv, clock, seed: false,
    getSelf: id => ({ id: id || BOT, name: '希洛' }),
    getPersona: (_group, _account, target) => ({ personaId: 'default', persona: { name: '希洛' }, systemContent: '', binding: directory.resolve(target) }),
    handlesTarget: target => !!directory.resolve(target),
    messageActions: { async send(action, guard) {
      assert.notEqual(guard?.isCurrent?.(), false)
      deliveries.push(action)
      return { state: 'sent', messageId: `sent-${deliveries.length}` }
    } },
    getTodaySpendCny: key => spent.get(key) || 0,
  }
  const input = (target, text, messageId, direct = false) => ({
    version: 1, conversation: target, sender: { ...target.account, id: target.kind === 'group' ? '40000' : 'member:40000' },
    text, messageId, occurredAt: clock.value, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: direct,
    binding: directory.resolve(target),
  })
  const h = fixture(options)
  t.after(() => h.runtime.stop())
  const keys = await Promise.all(routes.map(target => h.runtime.conversationKey(target)))
  assert.ok(keys.every(key => typeof key === 'string'))
  assert.equal(keys[0], GROUP)
  assert.equal(new Set(keys).size, routes.length)
  for (const key of keys.slice(2)) await h.runtime.enableGroup(key)
  await h.runtime.setGroupBudget(keys[1], 2)
  await h.runtime.setGroupReplyMode(keys[2], 'atOnly')
  spent.set(keys[1], 2)
  const texts = ['原账号新消息', '新 QQ 账号的消息', '甲租户频道消息', '乙租户频道消息']
  assert.deepEqual(await Promise.all(routes.map((target, i) => h.runtime.ingest(input(target, texts[i], 'same-message-id', true)))), [true, true, true, true])
  const groupState = key => JSON.parse(kv.get(sessionKey(key)))
  assert.deepEqual(keys.map(key => groupState(key).unread.map(message => message.text)), texts.map(text => [text]))
  // A configured role cannot inherit unversioned legacy conversation sources.
  // Account-route identity and budget continuity are checked independently below.
  assert.deepEqual(groupState(keys[0]).recent.map(message => message.text), [texts[0]])
  assert.deepEqual(new Set(JSON.parse(kv.get('shiloh:sim:known'))), new Set(keys))
  assert.equal(await h.runtime.handleRecall({ message_id: 'same-message-id' }, channel), true)
  assert.deepEqual(groupState(keys[2]).recent, [])
  assert.equal(groupState(keys[3]).recent[0].text, texts[3])
  h.runtime.stop()

  for (const key of [keys[0], keys[1], keys[3]]) {
    const state = groupState(key)
    state.pendingWakeReasons = [{ kind: 'atMention', seq: state.seq }]
    kv.set(sessionKey(key), JSON.stringify(state))
  }
  const restarted = fixture({ ...options, script: request => {
    if (request.messages.some(message => message.role === 'tool')) return finishSilently()
    const context = request.messages.map(message => String(message.content)).join('\n')
    if (context.includes(texts[3])) return tools(toolCall('simSendMessage', { messages: ['乙租户恢复成功'], atUserIds: ['member:40000'], replyToSeq: 1 }))
    return finishSilently()
  } })
  t.after(() => restarted.runtime.stop())
  await restarted.runtime.sweepOnce()
  await idle(restarted, 3, keys[3])
  assert.equal(groupState(keys[0]).budget.turns, 4)
  assert.equal(groupState(keys[1]).budget.turns, 0)
  assert.equal(groupState(keys[2]).budget.turns, 0)
  assert.equal(groupState(keys[3]).budget.turns, 1)
  assert.equal((await restarted.runtime.describeGroup(keys[1])).budget.dailyCostCny, 2)
  assert.equal((await restarted.runtime.describeGroup(keys[2])).replyMode, 'atOnly')
  const channelDelivery = deliveries.find(action => action.target.kind === 'channel')
  assert.deepEqual(channelDelivery.target, otherTenant)
  assert.equal(channelDelivery.replyTo, 'same-message-id')
  assert.deepEqual(channelDelivery.parts[0], { kind: 'mention', user: { platform: 'fixture', namespace: 'tenant-b', id: 'member:40000' } })
  assert.ok(restarted.calls.every(request => request.messages.every(message => !String(message.content).includes(texts[1]) && !String(message.content).includes(texts[2]))))
  assert.ok(restarted.calls.every(request => request.messages.every(message => !String(message.content).includes('老 QQ 会话历史'))))
  assert.ok(restarted.calls.every(request => request.tools?.every(tool => !['simQzoneInteract', 'simSendPoke'].includes(tool.function.name)) || !request.messages.some(message => String(message.content).includes(texts[3]))))
  assert.deepEqual(new Set((await restarted.runtime.overview()).groups.map(group => group.groupId)), new Set(keys))

  const runOptions = { taskId: 'account-scoped-commitment', botId: secondary.account.id, isCurrent: async () => true, beforeExecution: async () => true }
  assert.equal((await restarted.runtime.wakeForCommitment(GROUP, '按原账号履约', runOptions, main)).status, 'cancelled')
  let claimed = 0
  await restarted.runtime.wakeForCommitment(GROUP, '按原账号履约', { ...runOptions, beforeExecution: async () => { claimed++; return true } }, secondary)
  assert.equal(claimed, 1)
  assert.equal(groupState(keys[1]).budget.turns, 1)
  assert.equal(groupState(keys[0]).budget.turns, 4)
})

test('stale queued and persisted simulation wakes never run as the new role', async t => {
  const old = qqBinding('first')
  const current = qqBinding('second','work')
  let binding = old
  const getPersona = () => ({personaId:`agent:${binding.agentId}`,persona:{name:'希洛'},systemContent:'',binding})
  const first = fixture({getPersona})
  t.after(() => first.runtime.stop())
  await first.ingest('排队等待旧角色的消息')
  binding = current
  await waitFor(() => first.writes.some(item => item.key.startsWith('shiloh:sim:busy:')), '旧唤醒已出队')
  await waitFor(async () => !(await first.runtime.describeGroup(GROUP)).running, '旧唤醒已处理')
  assert.deepEqual(first.calls,[])
  first.runtime.stop()

  const oldState = JSON.parse(first.kv.get(sessionKey(GROUP)))
  oldState.pendingWakeReasons=[{kind:'atMention',seq:oldState.seq}]
  oldState.agentHistory=[{role:'assistant',content:'旧角色上下文'}]
  oldState.wakeConfig.mode='active'
  oldState.wakeConfig.sleepUntil=first.clock.value-1
  first.kv.set(sessionKey(GROUP),JSON.stringify(oldState))
  const afterRestart = fixture({getPersona,kv:first.kv,clock:first.clock})
  t.after(() => afterRestart.runtime.stop())
  await afterRestart.runtime.sweepOnce()
  const cleared = JSON.parse(first.kv.get(sessionKey(GROUP)))
  assert.equal(cleared.bindingToken,agentBindingToken(current))
  assert.deepEqual(cleared.pendingWakeReasons,[])
  assert.deepEqual(cleared.agentHistory,[])
  assert.equal(cleared.wakeConfig.sleepUntil,undefined)
  assert.deepEqual(cleared.unread,[])
  assert.deepEqual(cleared.recent,[], 'binding replacement removes the old role sources as well as its queued work')
  await afterRestart.ingest('现在给新角色的消息')
  await idle(afterRestart,1)
  assert.ok(afterRestart.calls[0].messages.some(message=>String(message.content).includes('现在给新角色的消息')))
  assert.ok(afterRestart.calls.every(request=>request.messages.every(message=>!String(message.content).includes('旧角色上下文') && !String(message.content).includes('排队等待旧角色的消息'))))
})

async function verifyInterruptedWake(t, interruptedDuring) {
  const binding = qqBinding('disconnect-before-model')
  const getPersona = () => ({ persona:{name:'希洛'}, systemContent:'', binding })
  let connected = true
  let interrupted = false
  let release
  const held = new Promise(resolve => { release = resolve })
  async function interrupt() {
    if (interrupted) return
    interrupted = true
    await held
  }
  let scopedKey
  const h = fixture({
    durableIngress: true, getPersona, seed: false, isAccountReady: () => connected,
    readFault: async key => {
      if (interruptedDuring === 'context read' && key.startsWith('shiloh:person-memory:v1:') && key.endsWith(':scope')
        && [...h.kv.keys()].some(key => key.startsWith('shiloh:sim:busy:'))) await interrupt()
    },
    onSave: async (key, value) => {
      if (interruptedDuring === 'claim write' && key === scopedKey && !JSON.parse(value).queuedIngressWake) await interrupt()
    },
  })
  t.after(async () => { release(); h.runtime.stop(); await h.runtime.drain() })
  scopedKey = sessionKey(await h.runtime.conversationKey(binding.target))
  await h.ingest('断线期间应保留这条点名')
  await waitFor(() => interrupted, `唤醒抵达 ${interruptedDuring}`)
  connected = false
  release()
  await h.runtime.drain()
  const saved = () => JSON.parse(h.kv.get(scopedKey))
  assert.equal(h.calls.length, 0)
  assert.equal(saved().queuedIngressWake?.seq, 1)
  assert.equal(saved().budget.turns, 0)
  assert.deepEqual(saved().agentHistory, [])

  connected = true
  await h.runtime.sweepOnce()
  await waitFor(() => h.calls.length === 1 && saved().queuedIngressWake === undefined, '已恢复入站唤醒')
  await h.runtime.drain()
  assert.equal(saved().budget.turns, 1)
  await h.runtime.sweepOnce()
  assert.equal(h.calls.length, 1)
  assert.equal(saved().queuedIngressWake, undefined)
}

test('a QQ wake interrupted before model submission stays durable and recovers once', async t => {
  await t.test('while reading context', step => verifyInterruptedWake(step, 'context read'))
  await t.test('while claiming the wake in Redis', step => verifyInterruptedWake(step, 'claim write'))
})

test('a durable simulation deadline survives a competing wake and fires after restart', async t => {
  const binding = qqBinding('scheduled-timeout')
  const address = simulationAddressKey(binding.target)
  const key = sessionKey(address)
  const deadline = BASE_AT + 60_000
  const state = createDefaultSimSession(BASE_AT)
  state.botId = BOT
  state.personaId = 'agent:daily'
  state.bindingToken = agentBindingToken(binding)
  state.bootstrapSent = true
  state.wakeConfig.mode = 'active'
  state.wakeConfig.sleepUntil = deadline
  const kv = new Map([[key, JSON.stringify(state)], [SIMULATION_KNOWN_GROUPS_KEY, JSON.stringify([address])]])
  const clock = { value: deadline - 1 }
  const options = { kv, clock, groups: [GROUP], seed: false, durableIngress: true,
    getPersona: () => ({ persona: { name: '希洛' }, systemContent: '', binding }) }
  const first = fixture(options)
  t.after(() => first.runtime.stop())
  const saved = () => JSON.parse(kv.get(key))
  await first.runtime.sweepOnce()
  assert.equal(saved().queuedIngressWake, undefined)
  assert.equal(saved().wakeConfig.sleepUntil, deadline)

  clock.value = deadline
  state.pendingWakeReasons.push({ kind: 'admin' })
  kv.set(key, JSON.stringify(state))
  await first.runtime.sweepOnce()
  assert.deepEqual(saved().queuedIngressWake, { kind: 'admin' })
  assert.equal(saved().wakeConfig.sleepUntil, deadline)
  await idle(first, 1, address)
  await first.runtime.drain()
  first.runtime.stop()

  const restarted = fixture(options)
  t.after(() => restarted.runtime.stop())
  await restarted.runtime.sweepOnce()
  assert.deepEqual(saved().queuedIngressWake, { kind: 'timeout' })
  assert.equal(saved().wakeConfig.sleepUntil, undefined)
  await idle(restarted, 1, address)
  await restarted.runtime.drain()
  assert.equal(saved().lastWakeReason.kind, 'timeout')
  await restarted.runtime.sweepOnce()
  assert.equal(saved().queuedIngressWake, undefined)
  assert.equal(saved().budget.turns, 2)
  assert.equal(restarted.calls.length, 1)
})

test('messages for a new binding wait for the previous live turn and preserve both inbound messages', async t => {
  let binding=qqBinding('first')
  let release,enter
  const entered=new Promise(resolve=>enter=resolve)
  const waiting=new Promise(resolve=>release=resolve)
  const h=fixture({
    getPersona:()=>({personaId:`agent:${binding.agentId}`,persona:{name:'希洛'},systemContent:'',binding}),
    script:async(_request,index)=>{
      if(index===0){enter();await waiting}
      return finishSilently()
    },
  })
  t.after(()=>{release();h.runtime.stop()})
  await h.ingest('旧角色等待中的消息')
  await entered
  binding=qqBinding('second','work')
  const one=h.ingest('新角色第一条')
  const two=h.ingest('新角色第二条')
  release()
  await Promise.all([one,two])
  const state=JSON.parse(h.kv.get(sessionKey(GROUP)))
  assert.equal(state.bindingToken,agentBindingToken(binding))
  assert.deepEqual(state.unread.map(message=>message.text),['新角色第一条','新角色第二条'])
  assert.deepEqual(state.recent.map(message=>message.text),['新角色第一条','新角色第二条'])
  assert.equal(new Set(state.recent.map(message=>message.seq)).size,2)
  assert.equal(state.seq,3, 'source sequence numbers keep increasing across ownership changes')
  await idle(h,2)
  assert.ok(h.calls.slice(1).every(request=>request.messages.every(message=>!String(message.content).includes('旧角色等待中的消息'))))
  assert.deepEqual(h.sent,[])
})

test('the running simulation reads the scoped memory and delegated inputs of the captured role', async t => {
  let current=qqBinding('first')
  const other=qqBinding('second','work')
  const memoryKey=binding=>`shiloh:sim:memories:v2:${encodeURIComponent(agentConversationKey(binding))}`
  const note=content=>JSON.stringify([{id:content,kind:'note',aboutUser:'40000',content,createdAt:BASE_AT,updatedAt:BASE_AT}])
  const kv=new Map([
    [`${sessionKey(GROUP)}:memories`,note('旧群独立笔记')],
    [memoryKey(current),note('角色 A 独立笔记')],
    [memoryKey(other),note('角色 B 独立笔记')],
  ])
  const readScopes=[]
  const h=fixture({kv,getPersona:()=>({personaId:`agent:${current.agentId}`,persona:{name:'希洛'},systemContent:'',binding:current}),
    loadDelegatedMemories:scope=>{readScopes.push(agentConversationKey(scope));return [{id:'dlg-synthetic',owner:'40000',content:`托付-${scope.agentId}`,createdAt:BASE_AT}]},
  })
  t.after(()=>h.runtime.stop())
  await h.ingest('读取当前角色的东西')
  await idle(h,1)
  const first=JSON.stringify(h.calls[0].messages)
  assert.match(first,/角色 A 独立笔记/)
  assert.match(first,/托付-daily/)
  assert.doesNotMatch(first,/角色 B 独立笔记|旧群独立笔记/)
  current=other
  await h.ingest('读取更换后角色的东西')
  await idle(h,2)
  const second=JSON.stringify(h.calls.at(-1).messages)
  assert.match(second,/角色 B 独立笔记/)
  assert.match(second,/托付-work/)
  assert.doesNotMatch(second,/角色 A 独立笔记|托付-daily|旧群独立笔记/)
  assert.deepEqual(readScopes,[agentConversationKey(qqBinding('first')),agentConversationKey(other)])
  assert.match(kv.get(`${sessionKey(GROUP)}:memories`),/旧群独立笔记/)
})

function toolResult(request, name) {
  return [...request.messages].reverse().find(message => message.role === 'tool' && message.name === name)?.content
}

function storedToolReply(harness, call) {
  return JSON.parse(harness.kv.get(sessionKey(GROUP))).agentHistory.find(message => message.role === 'tool' && message.tool_call_id === call.id)
}

function turnContext(request) {
  const content = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('【本轮执行检查】')).at(-1)?.content
  assert.ok(content, '每次模型请求应包含本轮动态状态')
  return JSON.parse(content.slice(content.lastIndexOf('【本轮执行检查】')).split('\n')[1])
}

function seededGoal(harness, id = 'goal-seeded') {
  const scope = harness.scope()
  const state = createCharacterGoal(createEmptyCharacterState(scope), {
    id, title: '了解刚才提到的独立游戏', motivation: '这符合我持续关注的游戏兴趣', nextStep: '搜索开发者公开介绍',
    completionCriteria: '取得搜索工具成功回执', stopConditions: ['管理员取消', '来源不可用'], evidenceRefs: ['message:1'],
  }, ['message:1'], harness.clock.value)
  harness.kv.set(characterKey(scope), JSON.stringify(state))
  return state.goals[0]
}

test('当前请求给出动态阶段、剩余轮数和可见来源，普通聊天不会自动创建角色状态', async () => {
  // This assertion intentionally exercises ordinary final text without an explicit decision.
  const h = fixture({ script: () => finalText('[SILENT]') })
  try {
    await h.ingest('只是聊聊，不用记住或安排什么'); await idle(h, 1)
    assert.deepEqual(turnContext(h.calls[0]), { phase: 'acting', remainingToolRounds: 8, focusedGoalId: null, visibleEvidenceRefs: ['message:1'] })
    const character = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(character.memories.length, 0)
    assert.equal(character.goals.length, 0)
    assert.equal(character.decision, undefined)
  } finally { h.runtime.stop() }
})

const finishMemory = { kind: 'interest', content: '我对连贯线索设计保持兴趣', epistemic: 'inferred', evidenceRefs: ['message:1'] }
const finishGoal = { title: '收尾中保存的研究计划', motivation: '这符合我的线索设计兴趣', nextStep: '核对公开介绍', completionCriteria: '取得公开介绍并核对', stopConditions: ['管理员取消', '来源不可用'], evidenceRefs: ['message:1'], nextCheckInMinutes: 30 }

test('invalid tool arguments are rejected before internal simulation reads, intent judgments, receipts or mutations', async t => {
  const invalidReads = ['', '{', '[]', 'null', 'true', '3', '"text"', undefined, { unencoded: true }].map(argumentsValue => {
    const call = toolCall('simGetState', {})
    call.function.arguments = argumentsValue
    return call
  })
  const invalidCalls = [
    ...invalidReads,
    toolCall('simGetState', { arbitrary: true }),
    toolCall('simSendMessage', { messages: '["有效的聊天文字",123]' }),
    toolCall('simRemember', { action: 'add', kind: 'pendingEvent', content: '下次主动问候', dueInMinutes: '45', welcomeProactiveFollowUp: true }),
    toolCall('simGoal', { action: 'create', ...finishGoal, nextCheckInMinutes: '30' }),
    toolCall('simCharacterMemory', { action: 'remember', ...finishMemory, evidenceRefs: [1] }),
    toolCall('simWorkspace', { action: 'write', title: '公开资料', kind: 'research', content: '不可保存', evidenceRefs: [1] }),
    toolCall('simSubscription', { action: 'list', unexpected: true }),
    toolCall('simSharedSelf', { action: 'list', unexpected: true }),
    toolCall('simWorkerTask', { kind: 'research', instruction: 'a'.repeat(2001), evidenceRefs: ['message:1'] }),
    toolCall('commitmentTool', { action: 'list', unexpected: true }),
    toolCall('delegateMemoryTool', { action: 'remember', content: 123 }),
    toolCall('groupKnowledgeTool', { action: 'list', unexpected: true }),
  ]
  const boundTools = [new (createCommitmentRuntime({ redis: {} }).CommitmentTool)(),
    new (createDelegateMemoryRuntime({ redis: {} }).DelegateMemoryTool)(), createGroupKnowledgeTool({})]
  const attemptedActions = []
  for (const tool of boundTools) tool.func = async () => { attemptedActions.push(tool.name) }
  const validRead = toolCall('simGetState', {})
  const h = fixture({ boundTools,
    runCharacterWorker: async () => { attemptedActions.push('worker'); throw Error('unexpected worker dispatch') },
    judgeSocialPermission: async () => { attemptedActions.push('intent model'); throw Error('unexpected intent judgment') },
    script: (_request, index) => index === 0 ? tools(...invalidCalls, validRead) : finishSilently(),
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 2)
  const result = id => h.calls[1].messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content
  for (const call of invalidCalls) assert.match(result(call.id), /^error: 工具参数/u, call.function.name)
  assert.doesNotMatch(result(validRead.id), /^error:/u)
  const detail = await h.runtime.describeGroup(GROUP)
  assert.deepEqual(attemptedActions, [])
  assert.deepEqual(h.sent, [])
  assert.deepEqual(detail.character.goals, [])
  assert.deepEqual(detail.character.memories, [])
  assert.deepEqual(detail.character.receipts, [])
  assert.deepEqual(detail.activities.works, [])
})

test('runtime keeps legacy message and keyword encodings and accepts a full escaped workspace draft', async t => {
  const content = '"\\'.repeat(6000)
  const write = toolCall('simWorkspace', { action: 'write', title: '全文转义测试', kind: 'research', content, evidenceRefs: ['message:1'] })
  assert.ok(write.function.arguments.length > 16_000)
  const h = fixture({ script: (_request, index) => index === 0 ? tools(write,
    toolCall('simSetWakeConfig', { keywords: '["独立游戏","解谜"]' }),
    toolCall('simSendMessage', { messages: '["游戏的第一条说明。","游戏的第二条补充。"]' }),
  ) : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '补充一个细节', messages: '最后一句仍能正常发送。' })) })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 2)
  const detail = await h.runtime.describeGroup(GROUP)
  assert.equal(detail.activities.works[0]?.versions[0].content, content)
  assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).wakeConfig.triggers.keywords, ['独立游戏', '解谜'])
  assert.equal(h.sent.length, 3)
  for (const [index, text] of ['游戏的第一条说明。', '游戏的第二条补充。', '最后一句仍能正常发送。'].entries()) {
    assert.ok(JSON.stringify(h.sent[index].segments).includes(text))
  }
})

test('malformed and nested-schema-invalid finish calls lock closing before judging intent or accepting a same-batch send', async t => {
  for (const invalid of ['{', 'null', JSON.stringify({ choice: 'schedule', reason: '安排后续', goal: { ...finishGoal, nextCheckInMinutes: '30' } })]) {
    const finish = toolCall('simFinishTurn', {})
    finish.function.arguments = invalid
    const send = toolCall('simSendMessage', { messages: ['不应在保存失败后声称已安排'] })
    let judgments = 0
    const h = fixture({
      judgeSocialPermission: async () => { judgments++; throw Error('unexpected intent judgment') },
      script: (_request, index) => index === 0 ? tools(finish, send) : finishSilently(),
    })
    t.after(() => h.runtime.stop())
    await h.ingest(); await idle(h, 2)
    assert.equal(turnContext(h.calls[1]).phase, 'closing')
    assert.match(storedToolReply(h, finish).content, /^error: 工具参数/u)
    assert.match(storedToolReply(h, send).content, /仅允许 simFinishTurn/u)
    assert.equal(judgments, 0)
    assert.deepEqual(h.sent, [])
    const { character } = await h.runtime.describeGroup(GROUP)
    assert.deepEqual(character.goals, [])
    assert.deepEqual(character.receipts, [])
  }
})

test('registered tools use canonical schema and bound actor/port preflight before receipts or ephemeral state', async t => {
  const displaySchema = { type: 'object', properties: {}, required: [], additionalProperties: false }
  const proofSchema = { type: 'object', properties: { proof: { type: 'string', const: 'verified' } }, required: ['proof'], additionalProperties: false }
  const executed = [], observed = []
  const binding = qqBinding('registered-preflight')
  const definition = (name, settings) => ({ name, description: name, parameters: displaySchema, ...settings,
    async execute(input) { executed.push({ name, input }); return { status: 'succeeded', content: '已检查资料' } },
  })
  const definitions = [
    definition('registeredProjection', { effect: 'read', inputSchema: proofSchema }),
    definition('registeredEphemeral', { effect: 'read', inputSchema: proofSchema, dataPolicy: 'ephemeral' }),
    definition('registeredAction', { effect: { actor: 'user', conversation: 'group', required: ['sendFile'] } }),
  ]
  const registry = createAgentTools({ builtIn: definitions }, {
    signal: new AbortController().signal,
    context(event) {
      assert.equal(event._agentBinding.id, binding.id)
      assert.equal(event.simulationActor.kind, 'user')
      assert.equal(event.user_id, 40000)
      return { binding: event._agentBinding, actor: { kind: 'user', user: { ...binding.target.account, id: event.simulationActor.userId } },
        request: event._agentToolRequest, isCurrent: event._isAgentBindingCurrent, ensureCurrent: event._ensureAgentToolCurrent,
      }
    },
  })
  const eligible = toolCall('registeredProjection', { proof: 'verified' })
  const invalid = toolCall('registeredEphemeral', { proof: 'invalid' })
  const denied = toolCall('registeredAction', {})
  const h = fixture({ getPersona: () => ({ personaId: 'agent:daily', persona: { name: '希洛' }, binding }),
    registeredTools: registry.getExtraTools(definitions.map(tool => tool.name)), recordToolResult: value => observed.push(value),
    script: (_request, index) => index === 0 ? tools(invalid, denied, eligible, toolCall('simCharacterMemory', { action: 'remember', ...finishMemory })) : finishSilently(),
  })
  t.after(() => h.runtime.stop())
  await h.ingest(); await idle(h, 2)
  assert.deepEqual(executed, [{ name: 'registeredProjection', input: { proof: 'verified' } }])
  assert.match(observed.find(result => result.toolCallId === invalid.id)?.content, /^error:.*Schema/u)
  assert.match(observed.find(result => result.toolCallId === denied.id)?.content, /^error:.*权限/u)
  const { character } = await h.runtime.describeGroup(GROUP)
  assert.equal(character.memories[0]?.content, finishMemory.content)
  assert.deepEqual(character.receipts.map(receipt => receipt.toolName), ['registeredProjection'])
})

test('correcting a shared source retains the correction through overview cleanup and prevents stale history', async () => {
  const observed = []
  const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '修正原观点', memories: [{ kind: 'opinion', content: '更正后的观点', epistemic: 'inferred', supersedes: 'old', evidenceRefs: ['memory:old', 'message:1'] }] })
  const h = fixture({ script: (_r, i) => i === 0 ? tools(finish) : finishSilently(), recordToolResult: result => observed.push(result) })
  const scope = h.scope(), key = characterKey(scope)
  h.kv.set(key, JSON.stringify(addCharacterMemory(createEmptyCharacterState(scope), { id: 'old', kind: 'opinion', content: '旧观点', epistemic: 'inferred', evidenceRefs: ['message:1'] }, ['message:1'], BASE_AT)))
  const redis = { get: async key => h.kv.get(key) ?? null, set: async (key, value) => { h.kv.set(key, value); return 'OK' } }
  const shared = createCharacterSharedSelf({ redis, scope, now: () => BASE_AT })
  const workspace = createCharacterWorkspace({ redis, scope, now: () => BASE_AT })
  const oldWork = await workspace.write({ title: '依赖旧观点的草稿', kind: 'research', content: '旧结论', evidenceRefs: ['memory:old'] })
  const id = await shared.propose('old'); await shared.approve(id)
  try {
    await h.ingest(); await idle(h, 1)
    await h.runtime.describeGroup(GROUP)
    await h.runtime.describeGroup(GROUP)
    const state = JSON.parse(h.kv.get(key))
    assert.ok(state.memories.some(memory => memory.supersedes === 'old'))
    assert.deepEqual(await shared.projection(), [])
    assert.deepEqual(await workspace.list(), [])
    await assert.rejects(workspace.restore(oldWork.id, 1, 1), /不存在/)
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [])
    assert.equal(observed.length, 1)
    assert.equal(observed[0].toolCallId, finish.id)
    assert.equal(observed[0].name, 'simFinishTurn')
    const closure = JSON.parse(observed[0].content)
    assert.equal(closure.saved, true)
    assert.equal(closure.memories[0].id, state.memories.find(memory => memory.supersedes === 'old').id)
  } finally { h.runtime.stop() }
})

test('tool result observers cannot mutate protocol replies or interrupt execution when they throw or reject', async () => {
  for (const asynchronous of [false, true]) {
    const observed = []
    const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '观察失败不影响执行', messages: ['这条消息只发送一次'] })
    const h = fixture({ script: () => tools(finish), recordToolResult: result => {
      assert.equal(Object.isFrozen(result), true)
      observed.push(result)
      assert.throws(() => { result.content = 'forged success' }, TypeError)
      if (asynchronous) return Promise.reject(new Error('observer rejection'))
      throw new Error('observer failure')
    } })
    try {
      const result = await h.runtime.wakeForCommitment(GROUP, '观察者故障', { taskId: `observer-failure-${asynchronous}`, botId: BOT, isCurrent: async () => true, beforeExecution: async () => true })
      assert.equal(result.status, 'succeeded')
      assert.equal(h.sent.length, 1)
      assert.equal(observed.length, 1)
      const stored = storedToolReply(h, finish)
      assert.equal(stored.content, observed[0].content)
      assert.equal(JSON.parse(stored.content).sendStatus, 'succeeded')
    } finally { h.runtime.stop() }
  }
})

test('independent commitment claims execute separately and return confirmed outcomes', async () => {
  let claims = 0
  const h = fixture({ script: request => {
    const prompt = JSON.stringify(request.messages)
    const label = prompt.includes('COMMIT_B') ? '承诺乙已执行' : '承诺甲已执行'
    return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '履行当前托付', messages: [label] }))
  } })
  const options = taskId => ({ taskId, botId: BOT, isCurrent: async () => true, beforeExecution: async () => { claims++; return true } })
  try {
    const a = h.runtime.wakeForCommitment(GROUP, 'COMMIT_A', options('a'))
    const b = h.runtime.wakeForCommitment(GROUP, 'COMMIT_B', options('b'))
    const results = await Promise.all([a, b])
    assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded'])
    assert.deepEqual(results.map(result => result.sent), [1, 1])
    assert.equal(claims, 2)
    assert.equal(h.sent.length, 2)
    assert.ok(JSON.stringify(h.calls[0]).includes('COMMIT_A'))
    assert.ok(JSON.stringify(h.calls[1]).includes('COMMIT_B'))
  } finally { h.runtime.stop() }
})

test('a bound commitment waits through disconnect and can start an empty session on the original account', async () => {
  const binding = qqBinding('original')
  const target = binding.target
  const groupKey = simulationAddressKey(target)
  let connected = true
  let claims = 0
  let checked = 0
  const deliveries = []
  const h = fixture({ seed: false, groups: [GROUP], durableIngress: true,
    isAccountReady: () => connected,
    getPersona: () => ({ persona: { name: '希洛' }, systemContent: '', binding }),
    messageActions: { async send(action) { deliveries.push(action); return { state: 'sent', messageId: 'commitment-confirmed' } } },
    script: (request, index) => {
      assert.ok(JSON.stringify(request).includes('迁入的待执行托付'))
      return index === 0 ? tools(toolCall('simSendMessage', { continuation: 'chat', messages: ['到时间了，记得喝水'] })) : finishSilently()
    },
  })
  try {
    const opts = { taskId: 'cold-claim', botId: BOT,
      isCurrent: async () => { if (++checked === 2) connected = false; return true },
      beforeExecution: async () => { claims++; return true },
    }
    assert.equal((await h.runtime.wakeForCommitment(GROUP, '迁入的待执行托付', opts, target)).status, 'deferred')
    assert.equal(claims, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(h.kv.has(sessionKey(groupKey)), false)
    connected = true
    const result = await h.runtime.wakeForCommitment(GROUP, '迁入的待执行托付', { ...opts, isCurrent: async () => true }, target)
    assert.equal(result.status, 'succeeded')
    assert.equal(claims, 1)
    assert.deepEqual(deliveries.map(action => action.target), [target])
    const state = JSON.parse(h.kv.get(sessionKey(groupKey)))
    assert.equal(state.botId, BOT)
    assert.equal(state.personaId, 'agent:daily')
    assert.equal(state.budget.turns, 1)
    assert.equal(state.bootstrapSent, true)
    assert.deepEqual(state.recent, [])
  } finally { h.runtime.stop() }
})

test('a first group message is retained when it arrives during commitment session initialization', async () => {
  const binding = qqBinding('first-message')
  const groupKey = simulationAddressKey(binding.target)
  const heldRead = Promise.withResolvers()
  let preparing = false
  let reads = 0
  const seen = []
  const h = fixture({
    seed: false, durableIngress: true,
    getPersona: () => ({ persona: { name: '希洛' }, systemContent: '', binding }),
    messageActions: { async send(action) { seen.push(action); return { state: 'sent', messageId: 'first-message-confirmed' } } },
    readFault: async key => {
      if (!preparing || key !== sessionKey(groupKey)) return
      reads++
      if (reads === 1) await heldRead.promise
    },
    script: (_request, index) => index === 0
      ? tools(toolCall('simFinishTurn', { choice: 'chat', reason: '执行到期承诺', messages: ['现在提醒你喝水'] }))
      : finishSilently(),
  })
  try {
    const task = h.runtime.wakeForCommitment(GROUP, '保留同时到达的群消息', {
      taskId: 'concurrent-first-message', botId: BOT, isCurrent: async () => { preparing = true; return true },
    }, binding.target)
    await waitFor(() => reads > 0, '承诺已开始读取会话')
    const first = h.ingest('在承诺初始化时到达的第一条群消息', '40000', { at: false })
    await waitFor(() => reads > 1, '第一条消息已进入会话路由')
    heldRead.resolve()
    assert.equal(await first, true)
    assert.equal((await task).status, 'succeeded')
    assert.deepEqual(seen.map(action => action.target), [binding.target])
    const state = JSON.parse(h.kv.get(sessionKey(groupKey)))
    assert.equal(state.seq, 1)
    assert.equal(state.recent[0].text, '在承诺初始化时到达的第一条群消息')
    assert.equal(state.budget.turns, 1)
  } finally { heldRead.resolve(); h.runtime.stop() }
})

test('commitment ownership, cancellation, empty turns and unknown delivery are distinguished', async () => {
  for (const kind of ['cancelled', 'wrong-bot', 'empty', 'unknown', 'failed']) {
    let calls = 0
    const h = fixture({ script: () => kind === 'empty' ? rawEmpty() : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '执行', messages: ['本次托付结果'] })), send: async () => { if (kind === 'unknown') return { ok: false, unknown: true }; return { ok: false, error: 'explicit rejection' } } })
    try {
      const result = await h.runtime.wakeForCommitment(GROUP, '独立托付', { taskId: kind, botId: kind === 'wrong-bot' ? 'another' : BOT, isCurrent: async () => kind !== 'cancelled', beforeExecution: async () => { calls++; return true } })
      assert.equal(result.status, ['cancelled', 'wrong-bot'].includes(kind) ? 'cancelled' : kind === 'unknown' ? 'unknown' : 'failed', kind)
      assert.equal(result.sent, 0)
      assert.equal(calls, ['cancelled', 'wrong-bot'].includes(kind) ? 0 : 1)
    } finally { h.runtime.stop() }
  }
})

test('commitments wait for an ordinary turn and concurrent duplicate claims execute once', async () => {
  let release, entered
  const held = new Promise(resolve => { release = resolve }), modelEntered = new Promise(resolve => { entered = resolve })
  const h = fixture({ script: async (_request, index) => {
    if (index === 0) { entered(); await held; return finishSilently() }
    return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '兑现独立托付', messages: [`结果 ${index}`] }))
  } })
  let claims = 0
  const options = taskId => ({ taskId, botId: BOT, isCurrent: async () => true, beforeExecution: async () => { claims++; return true } })
  try {
    await h.ingest(); await modelEntered
    const first = h.runtime.wakeForCommitment(GROUP, 'queued-a', options('queued-a'))
    const duplicate = h.runtime.wakeForCommitment(GROUP, 'queued-a', options('queued-a'))
    const second = h.runtime.wakeForCommitment(GROUP, 'queued-b', options('queued-b'))
    await sleep(80)
    assert.equal(claims, 0)
    release()
    const results = await Promise.all([first, duplicate, second])
    assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded', 'succeeded'])
    assert.equal(claims, 2); assert.equal(h.sent.length, 2); assert.equal(h.calls.length, 3)
  } finally { release(); h.runtime.stop() }
})

test('commitment external tool unknown and partial success with a later failure cannot be retried', async () => {
  for (const partial of [false, true]) {
    const h = fixture({
      script: (_request, index) => index === 0
        ? tools(...(partial ? [toolCall('simSendMessage', { messages: ['已发送的一部分'] })] : []), toolCall('searchInformationTool', {})) : finishSilently(),
      execute: async () => partial ? { kind: 'tool_outcome', status: 'error', error: { message: 'explicit rejection' } } : { kind: 'tool_outcome', status: 'unknown', error: { message: 'accepted then disconnected' } },
    })
    try {
      const result = await h.runtime.wakeForCommitment(GROUP, '可能部分执行的托付', { taskId: `partial-${partial}`, botId: BOT, isCurrent: async () => true, beforeExecution: async () => true })
      assert.equal(result.status, 'unknown')
      assert.equal(result.sent, partial ? 1 : 0)
    } finally { h.runtime.stop() }
  }
})

test('an unknown worker result blocks repeated external actions and finish announcements while preserving reads and saved closure', async () => {
  const workers = []
  const task = { kind: 'research', instruction: '研究来源里的游戏', evidenceRefs: ['memory:worker-source'] }
  const h = fixture({
    script: (_request, index) => index === 0
      ? tools(toolCall('simWorkerTask', task), toolCall('simWorkerTask', task), toolCall('simWorkspace', { action: 'list' }))
      : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '结果未知，停止外部动作', messages: ['这条公告不应发送'], throughSeq: 0 })),
    runCharacterWorker: async task => { workers.push(task); return { status: 'unknown', summary: '已提交但回执丢失' } },
  })
  h.kv.set(characterKey(h.scope()), JSON.stringify(addCharacterMemory(createEmptyCharacterState(h.scope()), {
    id: 'worker-source', kind: 'interest', content: '想研究的游戏', epistemic: 'inferred', evidenceRefs: ['message:1'],
  }, ['message:1'], BASE_AT)))
  try {
    const result = await h.runtime.wakeForCommitment(GROUP, '独立研究托付', { taskId: 'unknown-worker-repeat', botId: BOT, isCurrent: async () => true, beforeExecution: async () => true })
    assert.equal(workers.length, 1, 'unknown result cannot cause another worker submission with a fresh id')
    assert.equal(result.status, 'unknown'); assert.equal(h.sent.length, 0)
    const history = JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory
    assert.match(history.find(message => message.role === 'tool' && message.name === 'simWorkspace').content, /"ok":true/)
    const closure = JSON.parse(history.find(message => message.role === 'tool' && message.name === 'simFinishTurn').content)
    assert.equal(closure.saved, true); assert.equal(closure.sendStatus, 'failed'); assert.equal(closure.readStatus, 'failed'); assert.match(closure.error, /未知/)
  } finally { h.runtime.stop() }
})

test('worker artifact persistence failure preserves unknown and blocks a second external execution', async () => {
  const workers = []
  let failWorkspace = false
  const task = { kind: 'research', instruction: '研究来源里的游戏', evidenceRefs: ['memory:worker-save-source'] }
  const h = fixture({
    script: (_request, index) => index === 0 ? tools(toolCall('simWorkerTask', task), toolCall('simWorkerTask', task)) : finishSilently(),
    runCharacterWorker: async task => { workers.push(task); failWorkspace = true; return { status: 'succeeded', summary: '外部已执行', artifact: { title: '研究结果', content: '已得到正文' } } },
    writeFault: async key => { if (failWorkspace && key.endsWith(':workspace')) throw new Error('workspace storage failure') },
  })
  h.kv.set(characterKey(h.scope()), JSON.stringify(addCharacterMemory(createEmptyCharacterState(h.scope()), {
    id: 'worker-save-source', kind: 'interest', content: '想研究的游戏', epistemic: 'inferred', evidenceRefs: ['message:1'],
  }, ['message:1'], BASE_AT)))
  try {
    const result = await h.runtime.wakeForCommitment(GROUP, '研究托付但作品保存失败', { taskId: 'worker-save-failure-repeat', botId: BOT, isCurrent: async () => true, beforeExecution: async () => true })
    assert.equal(workers.length, 1, 'successful external execution cannot be repeated when its artifact save failed')
    assert.equal(result.status, 'unknown'); assert.equal(result.actions, 1)
    const history = JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory
    assert.match(history.find(message => message.role === 'tool' && message.name === 'simWorkerTask').content, /"status":"unknown"/)
    assert.equal(JSON.parse(h.kv.get(characterKey(h.scope()))).receipts.find(receipt => receipt.toolName === 'simWorkerTask').status, 'unknown')
  } finally { h.runtime.stop() }
})

test('finish 的目标和记忆在发送 adapter 前已落盘，发送标读后按真实 call id 保存收尾结果并停止', async () => {
  let observed = false, h
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '我决定稍后研究', goal: finishGoal, memories: [finishMemory], messages: ['我稍后继续核对介绍'], throughSeq: 1 })
  h = fixture({ script: () => tools(finish), send: async (groupId, segments) => {
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals.length, 1)
    assert.equal(character.goals[0].title, finishGoal.title)
    assert.equal(character.memories[0].content, finishMemory.content)
    assert.equal(character.goals[0].status, 'active')
    assert.equal(groupId, GROUP)
    assert.ok(JSON.stringify(segments).includes('稍后继续核对'))
    observed = true
    return { ok: true, messageId: 'finish-schedule-message' }
  } })
  try {
    await h.ingest('请按你的兴趣决定是否继续')
    await idle(h, 1)
    assert.equal(observed, true)
    assert.equal(h.calls.length, 1, '成功封口后不能再调用模型')
    assert.equal(h.sent.length, 1)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    const reply = storedToolReply(h, finish)
    assert.equal(reply.name, 'simFinishTurn'); assert.equal(reply.tool_call_id, finish.id)
    const result = JSON.parse(reply.content)
    assert.equal(result.ok, true); assert.equal(result.choice, 'schedule'); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
    assert.equal(session.agentHistory.at(-1).tool_call_id, finish.id)
  } finally { h.runtime.stop() }
})

test('finish complete 先保存终态再公告一次，同一 batch 后续工具全部不执行且保留协议响应', async () => {
  let goal, finish, after = [], h, sawCompletedBeforeSend = false
  h = fixture({ script: (request, index) => {
    if (index === 0) {
      assert.equal(turnContext(request).focusedGoalId, goal.id)
      return tools(toolCall('searchInformationTool', {}))
    }
    const receipt = JSON.parse(toolResult(request, 'searchInformationTool').match(/【运行时行动回执】(.*)$/u)[1])
    assert.equal(receipt.status, 'succeeded')
    assert.ok(turnContext(request).visibleEvidenceRefs.includes(receipt.evidenceRef))
    finish = toolCall('simFinishTurn', { choice: 'complete', reason: '已取得本目标所需资料', goal: { id: goal.id, evidenceRefs: [receipt.evidenceRef], outcome: '已取得公开搜索结果' }, messages: ['公开资料已经找到了'], throughSeq: 1 })
    after = [
      toolCall('searchInformationTool', {}), toolCall('simSendMessage', { messages: ['这一条不能重复发出'] }),
      toolCall('simCharacterMemory', { action: 'remember', kind: 'opinion', content: '封口后不能新增的观点', epistemic: 'inferred', evidenceRefs: [receipt.evidenceRef] }),
      toolCall('simMarkRead', { throughSeq: 999 }),
      toolCall('simFinishTurn', { choice: 'chat', reason: '不能重复提交', messages: ['重复的收尾消息'] }),
    ]
    return tools(finish, ...after)
  }, send: async () => {
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals[0].status, 'completed', '不能先公告成功再尝试提交目标完成')
    sawCompletedBeforeSend = true
    return { ok: true, messageId: 'finish-complete-message' }
  } })
  try {
    await h.ingest('用于目标的真实来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce(); await idle(h, 2)
    assert.equal(sawCompletedBeforeSend, true)
    assert.equal(h.calls.length, 2); assert.equal(h.sent.length, 1)
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals[0].status, 'completed'); assert.equal(character.memories.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.choice, 'complete'); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1)
    for (const call of after) {
      const response = storedToolReply(h, call)
      assert.ok(response, `被封口的 ${call.function.name} 也需要匹配 tool_call_id 的协议响应`)
      assert.match(response.content, /^error:/)
    }
  } finally { h.runtime.stop() }
})

test('非法 complete、越界 throughSeq 和存储失败都不发送或标读，也不写入部分记忆目标', async () => {
  for (const failure of ['complete', 'throughSeq', 'storage']) {
    let attempted, failedWrites = 0
    const h = fixture({ script: (_request, index) => {
      if (index > 0) return tools(toolCall('simFinishTurn', { choice: 'silent', reason: '本轮不再行动' }))
      const input = failure === 'complete'
        ? { choice: 'complete', reason: '没有成功回执的完成申请', goal: { id: 'missing-goal', evidenceRefs: ['message:1'] }, memories: [finishMemory] }
        : { choice: 'schedule', reason: '先验证再执行', goal: finishGoal, memories: [finishMemory] }
      attempted = toolCall('simFinishTurn', { ...input, messages: ['这条消息不得发出'], throughSeq: failure === 'throughSeq' ? 999 : 1 })
      return tools(attempted)
    }, writeFault: async (key, value) => {
      if (failure === 'storage' && key === characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }) && JSON.parse(value).memories.some(memory => memory.content === finishMemory.content)) {
        failedWrites++; throw new Error('injected closure persistence failure')
      }
    } })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(h.sent.length, 0, failure)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0, failure)
      assert.equal(session.unread.length, 1, failure)
      const character = JSON.parse(h.kv.get(characterKey(h.scope())))
      assert.equal(character.memories.length, 0, failure); assert.equal(character.goals.length, 0, failure)
      assert.match(storedToolReply(h, attempted).content, /^error:/, failure)
      if (failure === 'storage') assert.equal(failedWrites, 1)
    } finally { h.runtime.stop() }
  }
})

test('finish 参数或存储失败后锁定收尾，连续普通最终文本和同批或后续显式发送都不能绕过', async () => {
  for (const failure of ['parameters', 'storage']) for (const fallback of ['text', 'send']) {
    let attempted, sameBatchSend, laterSend, failedWrites = 0
    const announcement = '后续研究已经安排并保存好了，我会继续核对公开资料'
    const h = fixture({ script: (_request, index) => {
      if (index === 0) {
        attempted = toolCall('simFinishTurn', { choice: 'schedule', reason: failure === 'parameters' ? '' : '尝试保存后续计划', goal: finishGoal, memories: [finishMemory], messages: [announcement], throughSeq: 1 })
        sameBatchSend = toolCall('simSendMessage', { messages: [announcement] })
        return tools(attempted, sameBatchSend)
      }
      if (index === 1 && fallback === 'send') {
        laterSend = toolCall('simSendMessage', { messages: [announcement] })
        return tools(laterSend)
      }
      return finalText(announcement)
    }, writeFault: async (key, value) => {
      if (failure === 'storage' && key === characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }) && JSON.parse(value).memories.some(memory => memory.content === finishMemory.content)) {
        failedWrites++; throw new Error('injected closure persistence failure')
      }
    } })
    try {
      const expectedCalls = fallback === 'send' ? 3 : 2
      await h.ingest(); await idle(h, expectedCalls)
      assert.equal(h.calls.length, expectedCalls, `${failure}/${fallback}：纯文本应直接结束，不能继续催发或兜底`)
      assert.equal(h.sent.length, 0, `${failure}/${fallback}`)
      for (const request of h.calls.slice(1)) {
        assert.deepEqual(request.tools.map(tool => tool.function.name), ['simFinishTurn'])
        assert.equal(request.tool_choice, 'required')
        assert.equal(turnContext(request).phase, 'closing')
      }
      assert.match(storedToolReply(h, attempted).content, /^error:/)
      assert.match(storedToolReply(h, sameBatchSend).content, /^error:/)
      if (laterSend) assert.match(storedToolReply(h, laterSend).content, /^error:/)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
      assert.equal(session.agentHistory.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')), false)
      const character = JSON.parse(h.kv.get(characterKey(h.scope())))
      assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0); assert.equal(character.decision, undefined)
      assert.equal(character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false)
      if (failure === 'storage') assert.equal(failedWrites, 1)
    } finally { h.runtime.stop() }
  }
})

test('finish 发送失败保留已保存计划和记忆，不回滚、不重试、不再调用模型', async () => {
  let sends = 0
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '明确的后续计划', goal: finishGoal, memories: [finishMemory], messages: ['我稍后继续研究'] })
  const h = fixture({ script: () => tools(finish), send: async () => { sends++; return { ok: false, error: '网关发送结果未确认' } } })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(sends, 1); assert.equal(h.sent.length, 0); assert.equal(h.calls.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories[0].content, finishMemory.content)
    assert.equal(character.goals.length, 1); assert.equal(character.goals[0].status, 'active')
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(result.choice, 'schedule')
    assert.equal(result.sendStatus, 'failed'); assert.equal(result.sent, 0); assert.equal(result.readStatus, 'not_requested')
  } finally { h.runtime.stop() }
})

test('finish 提交后目标被取消、人设切换或源记忆删除时不能公告或标读，旧状态不能复活', async () => {
  for (const change of ['cancel', 'persona', 'source']) {
    let injected = false, h
    const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '本轮决定继续研究', goal: { ...finishGoal, evidenceRefs: ['memory:source-before-close'] }, messages: ['这个安排已经保存'], throughSeq: 2 })
    h = fixture({ script: () => tools(finish), onSave: async (key, value) => {
      if (injected || key !== characterKey(h.scope())) return
      const current = JSON.parse(value)
      if (!current.goals.some(goal => goal.title === finishGoal.title)) return
      injected = true
      if (change === 'persona') { h.identity.id = 'switched-after-commit'; return }
      if (change === 'source') {
        const revoked = deleteCharacterMemory(current, 'source-before-close', h.clock.value)
        revoked.revision = current.revision + 1
        h.kv.set(key, JSON.stringify(revoked))
        h.kv.set(`${sessionKey(GROUP)}:activity-version`, 'source-revoked-after-commit')
      } else {
        current.goals[0].status = 'abandoned'; current.goals[0].revision++; current.goals[0].lastOutcome = '管理员提交后取消'
        current.revision++
        h.kv.set(key, JSON.stringify(current))
      }
    } })
    try {
      await h.ingest('本轮此前已有的兴趣来源', '40000', { at: false })
      const source = addCharacterMemory(createEmptyCharacterState(h.scope()), { id: 'source-before-close', kind: 'interest', content: '我持续关注的线索设计', epistemic: 'inferred', evidenceRefs: ['message:1'] }, ['message:1'], h.clock.value)
      const originalKey = characterKey(h.scope())
      h.kv.set(originalKey, JSON.stringify(source))
      await h.ingest('现在决定是否继续')
      await idle(h, 1)
      assert.equal(injected, true, change)
      assert.equal(h.sent.length, 0, change)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0, change)
      assert.equal(session.unread.length, 2, change)
      const current = JSON.parse(h.kv.get(originalKey))
      assert.equal(current.goals.length, 1, change)
      if (change !== 'persona') assert.equal(current.goals[0].status, 'abandoned', change)
      if (change === 'source') assert.equal(current.memories.some(memory => memory.id === 'source-before-close'), false)
      if (change === 'persona') assert.equal(h.identity.id, 'switched-after-commit')
    } finally { h.runtime.stop() }
  }
})

test('聚焦目标在收尾公告登记后到期，旧 permit 不能发送最终消息或标读', async () => {
  let goal, expired = false, h
  const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '只汇报当前想法，不改目标', messages: ['我还在核对这款游戏'], throughSeq: 1 })
  h = fixture({ script: () => tools(finish), onSave: async (key, value) => {
    if (expired || key !== characterKey(h.scope())) return
    const current = JSON.parse(value)
    if (!current.receipts.some(receipt => receipt.toolName === 'simFinishTurn' && receipt.status === 'pending')) return
    expired = true
    h.clock.value = goal.expiresAt
  } })
  try {
    await h.ingest('用于目标的真实来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce(); await idle(h, 1)
    assert.equal(expired, true)
    assert.equal(turnContext(h.calls[0]).focusedGoalId, goal.id)
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'failed'); assert.equal(result.sent, 0); assert.equal(result.readStatus, 'failed')
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.receipts.find(receipt => receipt.toolName === 'simFinishTurn').status, 'failed')
  } finally { h.runtime.stop() }
})

test('超长合法记忆和目标的 finish 回执压缩为可核对哈希，仍保留完整 JSON 和发送标读状态', async () => {
  const memories = [{ ...finishMemory, content: '源'.repeat(1200) }, { ...finishMemory, kind: 'opinion', content: '观'.repeat(1200) }]
  const goal = { ...finishGoal, title: '题'.repeat(160), motivation: '动'.repeat(600), nextStep: '步'.repeat(600), completionCriteria: '验'.repeat(600), stopConditions: ['停'.repeat(300)] }
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '完整保存合法的详细记录', memories, goal, messages: ['详细记录和后续安排已经保存'], throughSeq: 1 })
  const h = fixture({ script: () => tools(finish) })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories.length, 2); assert.equal(character.goals.length, 1)
    assert.deepEqual(character.memories.map(memory => memory.content), memories.map(memory => memory.content))
    assert.equal(character.goals[0].completionCriteria, goal.completionCriteria)
    assert.ok(JSON.stringify({ memories: character.memories, goal: character.goals[0] }).length > 3500, '本用例必须触发真实的长回执压缩')
    const reply = storedToolReply(h, finish)
    const result = JSON.parse(reply.content)
    assert.ok(reply.content.length <= 3500, '不能靠截断 JSON 适配历史上限')
    assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(result.choice, 'schedule')
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const savedGoal = character.goals[0]
    assert.deepEqual(result.goal, { id: savedGoal.id, revision: savedGoal.revision, status: savedGoal.status, recordHash: hash(savedGoal) })
    assert.deepEqual(result.memories, character.memories.map(memory => ({ id: memory.id, recordHash: hash(memory) })))
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    assert.equal(session.agentHistory.at(-1).tool_call_id, finish.id)
  } finally { h.runtime.stop() }
})

test('finish 提交合法 throughSeq 时只标读已展示消息，模型请求期间的新入站继续保持未读', async () => {
  let arrived = false, h
  const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '回应本轮实际展示的消息', messages: ['刚才的消息我看到了'], throughSeq: 1 })
  h = fixture({ script: async request => {
    assert.deepEqual(turnContext(request).visibleEvidenceRefs, ['message:1'])
    await h.ingest('这是一条后到的背景消息', '50000', { at: false })
    arrived = true
    return tools(finish)
  } })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(arrived, true); assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1)
    assert.deepEqual(session.unread.map(message => ({ seq: message.seq, text: message.text })), [{ seq: 2, text: '这是一条后到的背景消息' }])
    assert.deepEqual(session.modelSeenSeqs, [])
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
  } finally { h.runtime.stop() }
})

test('最后两轮只暴露 finish 并强制 required，provider 忽视工具限制也不能执行其他动作或兜底发送', async () => {
  let rejected = []
  const h = fixture({ maxToolRounds: 4, script: (_request, index) => {
    if (index < 2) return tools(toolCall('searchInformationTool', {}))
    if (index === 2) {
      rejected = [toolCall('searchInformationTool', {}), toolCall('simSendMessage', { messages: ['收尾阶段不能发送的普通消息'] }), toolCall('simMarkRead', { throughSeq: 1 }), toolCall('simCharacterMemory', { action: 'remember', ...finishMemory })]
      return tools(...rejected)
    }
    return finalText('我已经安排了后续研究，这段纯文本也不能被兜底发送')
  } })
  try {
    await h.ingest(); await idle(h, 4)
    assert.equal(h.calls.length, 4, 'provider 忽视 required 不能导致无限续轮')
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool', 'searchInformationTool'])
    for (const [index, remaining] of [[2, 2], [3, 1]]) {
      assert.deepEqual(h.calls[index].tools.map(tool => tool.function.name), ['simFinishTurn'])
      assert.equal(h.calls[index].tool_choice, 'required')
      assert.equal(turnContext(h.calls[index]).phase, 'closing')
      assert.equal(turnContext(h.calls[index]).remainingToolRounds, remaining)
    }
    for (const call of rejected) assert.match(storedToolReply(h, call).content, /^error:/)
    assert.equal(h.sent.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0); assert.equal(character.decision, undefined)
    assert.equal(character.receipts.filter(receipt => receipt.toolName === 'searchInformationTool').length, 2)
    assert.equal(character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false)
  } finally { h.runtime.stop() }
})

test('被 @ 回合工具主体来自 reason.seq，不借用第一条未读群友身份', async () => {
  const h = fixture({ script: (_request, index) => index === 0 ? tools(toolCall('ownerAdminTool', {})) : finishSilently() })
  try {
    await h.ingest('刚才大家在聊的背景', '30000', { at: false })
    await h.ingest('请查一下这件事', '40000')
    await idle(h, 2)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].event.user_id, 40000)
    assert.equal(h.events[0].event.simulationActor.userId, '40000')
    assert.equal(h.events[0].event.simulationActor.kind, 'user')
    const recent = JSON.parse(h.kv.get(sessionKey(GROUP))).recent
    assert.equal(recent[0].userId, '30000', '确实存在更早的另一位未读群友')
    assert.ok(h.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'))
  } finally { h.runtime.stop() }
})

test('新会话第一条 @ 同样绑定真实群友，不被 bootstrap 丢失身份', async () => {
  const h = fixture({ seed: false, script: (_request, index) => index === 0 ? tools(toolCall('ownerAdminTool', {})) : finishSilently() })
  try {
    await h.ingest('请执行我的请求', '40000')
    await idle(h, 2)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].event.user_id, 40000)
    assert.equal(h.events[0].event.simulationActor.kind, 'user')
  } finally { h.runtime.stop() }
})

test('主动空闲唤醒无 user_id，管理员工具和伪 sim 前缀工具既不暴露也不能绕过清单执行', async () => {
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('ownerAdminTool', {}), toolCall('simDangerTool', {}), toolCall('searchInformationTool', {})) : finishSilently() })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 2)
    assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'proactiveCheck')
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in h.events[0].event, false)
    assert.equal('sender' in h.events[0].event, false)
    assert.equal(h.events[0].event.simulationActor.kind, 'autonomous')
    assert.equal(h.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'), false)
    assert.equal(h.calls[0].tools.some(tool => tool.function.name === 'simDangerTool'), false)
    assert.match(toolResult(h.calls[1], 'ownerAdminTool'), /自主执行主体没有此工具权限/)
    assert.match(toolResult(h.calls[1], 'simDangerTool'), /自主执行主体没有此工具权限/)
  } finally { h.runtime.stop() }
})

test('已明确欢迎的到期待办只唤醒一次，重启后空回音和相同入站不会再次唤醒', async () => {
  const memoryKey = `shiloh:sim:g:${GROUP}:memories`
  const h = fixture({ proactiveProbability: 1, script: () => tools(toolCall('simFinishTurn', {
    choice: 'chat', reason: '只问这一回', messages: ['纸灯展布置得怎么样？'],
  })) })
  try {
    await h.ingest('明天展览布置完，欢迎到群里问我一句', '40000', { at: false })
    h.kv.set(memoryKey, JSON.stringify([
      { id: 'old', kind: 'pendingEvent', content: '旧待办没有主动许可', aboutUser: '40000', dueAt: BASE_AT + 3600_000 },
      { id: 'welcome', kind: 'pendingEvent', content: '问纸灯展布展情况', aboutUser: '40000', dueAt: BASE_AT + 86400_000, proactiveSourceSeq: 1 },
    ]))
    h.clock.value += 86460_000
    await h.runtime.sweepOnce()
    await idle(h, 1)
    const saved = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(saved.offeredFollowUpIds, ['welcome'])
    assert.equal(h.sent.length, 1)
    assert.match(h.calls[0].messages.map(message => message.content).join('\n'), /问纸灯展布展情况.*这次主动检查的事/)
    assert.ok(!JSON.parse(h.kv.get(memoryKey)).find(memory => memory.id === 'welcome').done)
  } finally { h.runtime.stop() }
  const restarted = fixture({ kv: h.kv, clock: h.clock, proactiveProbability: 1 })
  try {
    h.clock.value += 7200_000
    await restarted.runtime.sweepOnce()
    await sleep(1150)
    assert.equal(restarted.calls.length, 0)
    assert.equal(JSON.parse(h.kv.get(sessionKey(GROUP))).nextReplyCheckAt, 0)
    await restarted.ingest('新话题，聊聊纸灯怎么折', '40001')
    await idle(restarted, 1)
  } finally { restarted.runtime.stop() }
})

test('本群相处习惯和已发送回复用于原对话对象，不冒充其他人的互动', async () => {
  const h = fixture({ script: (_request, index) => {
    if (index === 0) return tools(
      toolCall('simRemember', { kind: 'interaction', aboutUser: '40000', content: '对方说不喜欢被叫宝', sourceSeq: 1, sourceQuote: '叫我阿晓就行，别叫我宝' }),
      toolCall('simUpdateAffinity', { userId: '40000', delta: 1, reason: '对方直接说清了喜欢的称呼' }),
    )
    if (index === 1) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回应对方', messages: ['行，那就叫你阿晓'] }))
    return finishSilently()
  } })
  try {
    await h.ingest('叫我阿晓就行，别叫我宝')
    await idle(h, 2)
    assert.equal(h.sent.length, 1, JSON.stringify({ errors: h.errors, history: JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.filter(message => message.role === 'tool') }))
    assert.ok(!h.writes.some(write => write.key === 'shiloh:sim:person:40000'), '相处习惯不写跨群档案')
    await h.ingest('对，就是这样叫', '40000')
    await idle(h, 3)
    const same = h.calls[2].messages.filter(message => message.role === 'user').at(-2)?.content || ''
    assert.match(same, /对方说不喜欢被叫宝/)
    assert.match(same, /你上一轮给此人的已发送消息.*\n.*那就叫你阿晓/)
    await h.ingest('你怎么称呼我？', '40001')
    await idle(h, 4)
    const other = h.calls[3].messages.filter(message => message.role === 'user').at(-2)?.content || ''
    assert.doesNotMatch(other, /你上一轮给此人的已发送消息/)
  } finally { h.runtime.stop() }
})

test('点名接话隔离另一人的快照和历史，引用及显式查阅仍能看见原话', async () => {
  const h = fixture({ script: (_request, index) => {
    if (index === 0) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '接梗', messages: ['两块饼干成交'], throughSeq: 1 }))
    if (index === 2) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '继续接梗', messages: ['第三块一人一半'] }))
    if (index === 3) return tools(toolCall('simGetMessageDetail', { seq: 2 }))
    return finishSilently()
  } })
  try {
    await h.ingest('我给你两块饼干当工资')
    await idle(h, 1)
    await h.ingest('烤箱旁边是蓝色计时器', '40001')
    await idle(h, 2)
    await h.ingest('第三块你分我一半', '40000')
    await idle(h, 3)
    const direct = h.calls[2].messages.map(m => m.content).join('\n')
    assert.match(direct, /第三块你分我一半/)
    assert.match(direct, /两块饼干成交/)
    assert.doesNotMatch(direct, /烤箱|蓝色计时器/)
    assert.deepEqual(turnContext(h.calls[2]).visibleEvidenceRefs.filter(ref => ref.startsWith('message:')), ['message:1', 'message:3'])
    await h.ingest('请再查第二条，烤箱旁边是什么？', '40000', { source: { user_id: '40001', text: '烤箱旁边是蓝色计时器' } })
    await idle(h, 5)
    assert.match(h.calls[3].messages.map(m => m.content).join('\n'), /引用.*蓝色计时器/)
    assert.match(toolResult(h.calls[4], 'simGetMessageDetail'), /蓝色计时器/)
    assert.ok(turnContext(h.calls[4]).visibleEvidenceRefs.includes('message:2'))
  } finally { h.runtime.stop() }
})

test('合并窗内两个群友分别点名会获得独立回合', async () => {
  const h = fixture({ script: (_request, index) => tools(toolCall('simFinishTurn', {
    choice: 'chat', reason: '回答当前群友', messages: [index === 0 ? '饼干成交' : '看看烤箱说明'], throughSeq: index + 1,
  })) })
  try {
    await h.ingest('给你两块饼干，成交吗？', '40000')
    await h.ingest('新烤箱怎么设置？', '40001')
    await idle(h, 2)
    const first = h.calls[0].messages.map(message => message.content).join('\n')
    const second = h.calls[1].messages.map(message => message.content).join('\n')
    assert.match(first, /饼干/)
    assert.doesNotMatch(first, /新烤箱/)
    assert.match(second, /新烤箱/)
    assert.doesNotMatch(second, /饼干成交|两块饼干/)
    assert.equal(h.sent.length, 2)
  } finally { h.runtime.stop() }
})

test('误填主动许可和社交目标均不能用模型改写替代当事人原话', async () => {
  const original = '明天面试完，碰巧聊到你再问一句，别特意催'
  const judgments = []
  const h = fixture({ proactiveProbability: 1, judgeSocialPermission: async request => {
    judgments.push(JSON.parse(request.messages[1].content))
    const verdict = judgments.at(-1).action === 'follow_up' ? 'explicit_invitation' : 'conversation_only'
    return { choices: [{ message: { content: JSON.stringify({ verdict, quote: original }) } }] }
  }, script: (_request, index) => {
    if (index === 0) return tools(toolCall('simRemember', { kind: 'pendingEvent', content: '对方允许明天主动问', dueInMinutes: 1440, welcomeProactiveFollowUp: true, sourceSeq: 1, sourceQuote: original }))
    if (index === 1) return tools(toolCall('simFinishTurn', { choice: 'schedule', reason: '等对方露面', goal: finishGoal }))
    return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通接续', messages: ['聊到了再问'] }))
  } })
  try {
    await h.ingest(original)
    await idle(h, 3)
    assert.deepEqual(judgments.map(item => [item.action, item.original]), [['follow_up', original], ['goal', original]])
    const saved = JSON.parse(h.kv.get(`shiloh:sim:g:${GROUP}:memories`))[0]
    assert.equal(saved.proactiveSourceSeq, undefined)
    assert.match(toolResult(h.calls[1], 'simRemember'), /"proactiveApproved":false/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals.length, 0)
    h.clock.value += 86460_000
    await h.runtime.sweepOnce()
    await sleep(1150)
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 1)
  } finally { h.runtime.stop() }
})

test('直接点名回合把回答正文漏写到收尾参数外时可以纠正一次', async () => {
  const h = fixture({ script: (_request, index) => index === 0
    ? { ...tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回答了对方' })), content: '看说明书的上下管独立控温一栏。' }
    : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回答烤箱设置', messages: ['看看说明书的上下管独立控温一栏。'] })) })
  try {
    await h.ingest('新烤箱怎么设置？')
    await idle(h, 2)
    assert.match(toolResult(h.calls[1], 'simFinishTurn'), /群友看不到/)
    assert.equal(h.sent.length, 1)
  } finally { h.runtime.stop() }
})

test('触发原话被截断时不能授予主动跟进', async () => {
  let reviewed = false
  const h = fixture({
    judgeSocialPermission: async () => { reviewed = true; throw new Error('不应审核被截断的发言') },
    script: (_request, index) => index === 0
      ? tools(toolCall('simRemember', { kind: 'pendingEvent', content: '对方允许明天主动问', dueInMinutes: 1440, welcomeProactiveFollowUp: true }))
      : finishSilently(),
  })
  try {
    await h.ingest(`明天你可以主动问我。${'补充内容'.repeat(80)}不过碰巧聊到再问`)
    await idle(h, 2)
    assert.equal(reviewed, false)
    assert.match(toolResult(h.calls[1], 'simRemember'), /需要本轮可见且完整的真实用户消息/)
    assert.equal(h.kv.has(`shiloh:sim:g:${GROUP}:memories`), false)
  } finally { h.runtime.stop() }
})

test('simDecide silent 后普通最终文本不会触发提醒、兜底发送或任何群消息', async () => {
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simDecide', { kind: 'silent', reason: '我更想先听大家聊' }))
    : finalText('今天这个话题我也有一点自己的想法') })
  try {
    await h.ingest()
    await idle(h, 2)
    assert.equal(h.calls.length, 2)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
  } finally { h.runtime.stop() }
})

for (const wake of ['proactiveCheck', 'characterGoal']) {
  test(`${wake} 自主回合的普通最终文本只留在历史，不催发、不兜底、不伪造决定`, async () => {
    const text = wake === 'proactiveCheck'
      ? '刚看到订阅有更新，但群里一个多小时没人说话，我就不主动甩链接打扰了，安静记着，等有人聊到纸灯塔再说。继续潜水。'
      : '我已经整理出这款游戏值得继续研究的三个方向'
    const h = fixture({ proactiveProbability: wake === 'proactiveCheck' ? 1 : 0, script: () => finalText(text) })
    try {
      await h.ingest('用于自主兴趣来源的普通消息', '30000', { at: false })
      h.clock.value = wake === 'characterGoal' ? seededGoal(h).nextCheckAt : h.clock.value + 2 * 60 * 60_000
      await h.runtime.sweepOnce()
      await idle(h, 1)
      const detail = await h.runtime.describeGroup(GROUP)
      assert.equal(detail.lastWakeReason, wake)
      assert.equal(h.calls.length, 1, '普通最终文本直接结束自主回合，不能追加发送提醒')
      assert.equal(h.sent.length, 0)
      assert.equal(detail.character.decision, undefined, '最终文本不能被运行时改写成 simDecide')
      const history = JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory
      assert.ok(history.some(message => message.role === 'assistant' && message.content === text))
      assert.equal(history.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')), false)
    } finally { h.runtime.stop() }
  })
}

test('用户回合聚焦自主目标后，按当前主体保留最终文本且不催发', async () => {
  let goal
  const text = '我想先把这款游戏的研究方向整理在自己的记录里'
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simGoal', { action: 'focus', id: goal.id })) : finalText(text) })
  try {
    await h.ingest('用于目标来源的普通消息', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.ingest('看看你自己的研究目标')
    await idle(h, 2)
    assert.doesNotMatch(toolResult(h.calls[1], 'simGoal'), /^error:/)
    assert.equal(h.calls.length, 2)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision, undefined)
    assert.ok(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.some(message => message.content === text))
  } finally { h.runtime.stop() }
})

test('到期自主目标自动聚焦后 wait 成功即收尾，后续发送仍被版本保护拒绝', async () => {
  let goal
  const nextStep = '等官方补充后继续核对玩法资料'
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simGoal', { action: 'wait', id: goal.id, nextStep, nextCheckInMinutes: 30, outcome: '现有资料不足，先等待新来源' }))
    : index === 1 ? tools(toolCall('simSendMessage', { messages: ['等待更新已保存后也不该继续发送这条消息'] })) : finalText('[SILENT]') })
  try {
    await h.ingest('用于自主目标的可见来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce()
    await idle(h, 3)
    const waited = JSON.parse(toolResult(h.calls[1], 'simGoal'))
    assert.equal(waited.ok, true)
    assert.equal(waited.goal.id, goal.id)
    assert.equal(waited.goal.attempts, 1, '到期回合须已由运行时自动聚焦目标')
    assert.equal(waited.goal.status, 'waiting')
    assert.equal(waited.goal.nextStep, nextStep)
    assert.equal(waited.goal.nextCheckAt, h.clock.value + 30 * 60_000)
    assert.equal(waited.goal.revision, goal.revision + 2, '自动聚焦和 wait 更新各推进一次版本')
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /^error:/, 'wait 改变版本后不能沿用本轮旧授权发送')
    const detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.lastWakeReason, 'characterGoal')
    assert.equal(detail.character.goals.length, 1, '继续已有目标不能额外创建目标')
    assert.equal(detail.character.goals[0].revision, waited.goal.revision)
    assert.equal(detail.character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false, '发送须在登记外部动作前被拦截')
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }
})

for (const wake of ['atMention', 'commitment']) {
  test(`${wake} 普通最终文本仍提醒一次，再经原有兜底发送`, async () => {
    const text = '这款游戏里的谜题设计确实很有意思'
    const h = fixture({ script: () => finalText(text) })
    try {
      if (wake === 'atMention') await h.ingest()
      else {
        await h.ingest('承诺的消息来源', '30000', { at: false })
        await h.runtime.wakeForCommitment(GROUP, '分享刚才整理的游戏看法', { taskId: 'fallback-text', botId: BOT, isCurrent: async () => true, beforeExecution: async () => true })
      }
      await idle(h, 2)
      assert.equal(h.calls.length, 2)
      assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, wake)
      assert.ok(h.calls[1].messages.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')))
      assert.equal(h.sent.length, 1)
      assert.ok(JSON.stringify(h.sent[0].segments).includes(text))
    } finally { h.runtime.stop() }
  })
}

test('自主回合仍可显式调用 simSendMessage 发送', async () => {
  const text = '刚查到这款游戏的新资料，我想分享一下'
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('simSendMessage', { messages: [text] })) : finishSilently() })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 2)
    assert.doesNotMatch(toolResult(h.calls[1], 'simSendMessage'), /^error:/)
    assert.equal(h.sent.length, 1)
    assert.ok(JSON.stringify(h.sent[0].segments).includes(text))
  } finally { h.runtime.stop() }
})

test('自主回合显式 simDecide silent 仍阻止后续工具发送和最终文本发送', async () => {
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('simDecide', { kind: 'silent', reason: '我想先听大家聊' }))
    : index === 1 ? tools(toolCall('simSendMessage', { messages: ['这条消息不应发送'] }))
      : finalText('今天这个话题我也有一点自己的想法') })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 3)
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 0)
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /本轮已选择沉默或暂缓/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
  } finally { h.runtime.stop() }
})

test('目标至少 15 分钟后经 sweep 唤醒，跨 runtime 重启后完成工具回执、观察记忆、目标闭环', async () => {
  const kv = new Map()
  const clock = { value: BASE_AT }
  const first = fixture({ kv, clock, script: (_request, index) => index === 0 ? tools(toolCall('simGoal', {
    action: 'create', title: '关注独立游戏的新资料', motivation: '这是我持续感兴趣的话题', nextStep: '搜索公开介绍',
    completionCriteria: '取得公开资料的成功工具回执', stopConditions: ['群友明确不想继续', '管理员取消'], evidenceRefs: ['message:1'],
  })) : finishSilently() })
  let goal
  try {
    await first.ingest('我最近在玩一款新的独立游戏')
    await idle(first, 2)
    goal = (await first.runtime.describeGroup(GROUP)).character.goals[0]
    assert.ok(goal)
    assert.ok(goal.nextCheckAt >= BASE_AT + CHARACTER_MIN_WAKE_MS)
  } finally { first.runtime.stop() }

  const next = fixture({ kv, clock, seed: false, script: (request, index) => {
    if (index === 0) return tools(toolCall('ownerAdminTool', {}), toolCall('searchInformationTool', {}))
    if (index === 1) {
      const result = toolResult(request, 'searchInformationTool')
      const receipt = JSON.parse(result.match(/【运行时行动回执】(.*)$/u)[1])
      assert.equal(receipt.status, 'succeeded')
      return tools(
        toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', content: '搜索工具返回了这款游戏的公开资料', epistemic: 'observed', evidenceRefs: [receipt.evidenceRef] }),
        toolCall('simGoal', { action: 'complete', id: goal.id, evidenceRefs: [receipt.evidenceRef], outcome: '已取得公开搜索结果' }),
      )
    }
    return finishSilently()
  } })
  try {
    clock.value = goal.nextCheckAt - 1
    await next.runtime.sweepOnce()
    assert.equal(next.calls.length, 0, '未到目标时间不能调用模型')
    assert.equal((await next.runtime.describeGroup(GROUP)).character.goals[0].attempts, 0)
    clock.value = goal.nextCheckAt
    await next.runtime.sweepOnce()
    await idle(next, 3)
    const state = (await next.runtime.describeGroup(GROUP)).character
    assert.equal(state.goals[0].status, 'completed')
    assert.equal(state.goals[0].attempts, 1)
    assert.equal(state.memories[0].epistemic, 'observed')
    assert.ok(state.receipts.some(receipt => receipt.toolName === 'simGoalCheck' && receipt.status === 'unknown'))
    const succeeded = state.receipts.find(receipt => receipt.toolName === 'searchInformationTool')
    assert.equal(succeeded.status, 'succeeded')
    assert.ok(state.goals[0].evidenceRefs.includes(`receipt:${succeeded.id}`))
    assert.deepEqual(next.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in next.events[0].event, false)
    assert.equal(next.events[0].event.simulationActor.kind, 'autonomous')
    assert.equal(next.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'), false)
    assert.equal((await next.runtime.describeGroup(GROUP)).lastWakeReason, 'characterGoal')
  } finally { next.runtime.stop() }
})

test('目标执行中取消后，迟到回执不复活目标且工具 reply、后续发送与文本兜底均被阻止', async () => {
  let release
  let entered = false
  let lateReplyBlocked = false
  const held = new Promise(resolve => { release = resolve })
  const h = fixture({
    async execute(_name, _args, event) {
      entered = true
      await held
      try { await event.reply('这个迟到的工具回复必须被取消挡住') } catch { lateReplyBlocked = true }
      return { ok: true, result: '已经在外部取得结果' }
    },
    script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {}))
      : index === 1 ? tools(toolCall('simSendMessage', { messages: ['取消后不该再发送的内容'] }))
        : finalText('这是取消之后也不该兜底发送的普通文本'),
  })
  try {
    await h.ingest('触发自主兴趣的消息', '30000', { at: false })
    const goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce()
    await waitFor(() => entered, '外部工具进入等待')
    await h.runtime.controlCharacter(GROUP, 'cancel-goal', goal.id)
    release()
    await idle(h, 3)
    const state = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(state.goals[0].status, 'abandoned')
    assert.ok(state.receipts.some(receipt => receipt.toolName === 'searchInformationTool' && receipt.status === 'succeeded'))
    assert.equal(lateReplyBlocked, true)
    assert.equal(h.sent.length, 0)
    assert.equal(h.events.length, 1)
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /^error:/)
  } finally { release(); h.runtime.stop() }
})

async function pendingBeforeRestart(toolName) {
  const kv = new Map()
  const clock = { value: BASE_AT }
  const first = fixture({ kv, clock })
  try {
    await first.ingest('用于目标来源的普通群消息', '30000', { at: false })
    const goal = seededGoal(first)
    clock.value = goal.nextCheckAt
    const pending = beginCharacterGoalAttempt(JSON.parse(kv.get(characterKey(first.scope()))), goal.id,
      { id: 'interrupted-action', toolName }, clock.value)
    kv.set(characterKey(first.scope()), JSON.stringify(pending))
    clock.value += 1
    return { kv, clock, goalId: goal.id, nextCheckAt: pending.goals[0].nextCheckAt }
  } finally { first.runtime.stop() }
}

test('发送动作 pending 时重启会转 unknown 并暂停目标，后续 sweep 不得自动重复发送', async () => {
  const crash = await pendingBeforeRestart('simSendMessage')
  const h = fixture({ ...crash, seed: false })
  try {
    await h.runtime.sweepOnce()
    const recovered = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(recovered.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown')
    assert.equal(recovered.goals[0].status, 'paused')
    assert.match(recovered.goals[0].lastOutcome, /未知|核对|副作用/)
    assert.equal(recovered.goals[0].attempts, 1)
    h.clock.value = crash.nextCheckAt + CHARACTER_MIN_WAKE_MS
    await h.runtime.sweepOnce()
    assert.equal(h.calls.length, 0, '暂停的副作用目标不应再次进入模型回合')
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals[0].status, 'paused')
  } finally { h.runtime.stop() }
})

test('只读搜索 pending 时重启转 unknown，最早下次检查时间可继续目标而不伪造旧成功', async () => {
  const crash = await pendingBeforeRestart('searchInformationTool')
  const h = fixture({ ...crash, seed: false, script: (_request, index) => index === 0
    ? tools(toolCall('searchInformationTool', {})) : finishSilently() })
  try {
    await h.runtime.sweepOnce()
    const recovered = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(recovered.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown')
    assert.equal(recovered.goals[0].status, 'waiting')
    assert.equal(h.calls.length, 0, '恢复时尚未到下一次检查')
    h.clock.value = crash.nextCheckAt
    await h.runtime.sweepOnce()
    await idle(h, 2)
    const progressed = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(progressed.goals[0].attempts, 2)
    assert.equal(progressed.goals[0].status, 'waiting')
    assert.equal(progressed.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown', '恢复不能把原未知回执改成成功')
    assert.ok(progressed.receipts.some(receipt => receipt.id !== 'interrupted-action' && receipt.toolName === 'searchInformationTool' && receipt.status === 'succeeded'))
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in h.events[0].event, false)
  } finally { h.runtime.stop() }
})

test('角色记忆按 bot/persona/group 隔离，普通人设文字修改和 runtime 重启保留同角色记忆', async () => {
  const kv = new Map()
  const identity = { id: 'shiloh', name: '希洛', systemContent: '最初的人设文字' }
  const h = fixture({ kv, identity, groups: [GROUP, OTHER_GROUP], script: (_request, index) => index === 0
    ? tools(toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', content: '我想继续了解独立游戏', epistemic: 'desired', evidenceRefs: ['message:1'] })) : finishSilently() })
  try {
    await h.ingest()
    await idle(h, 2)
    const original = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(original.memories.length, 1)
    identity.systemContent = '编辑后的同一人设文字'
    identity.name = '希洛的新称呼'
    h.clock.value += 60_000
    await h.ingest('人设文字编辑后再开始一个回合')
    await idle(h, 3)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 1)
    assert.equal((await h.runtime.describeGroup(OTHER_GROUP)).character.memories.length, 0)
    identity.id = 'another-character'
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    identity.id = 'shiloh'
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories[0].id, original.memories[0].id)
  } finally { h.runtime.stop() }

  const restarted = fixture({ kv, identity, seed: false })
  try {
    assert.equal((await restarted.runtime.describeGroup(GROUP)).character.memories.length, 1)
  } finally { restarted.runtime.stop() }

  // Simulate an explicit new account/session binding, leaving the old account's character key intact.
  const otherBot = '3094088999'
  seedSession(kv, GROUP, otherBot, { value: BASE_AT })
  const other = fixture({ kv, botId: otherBot, identity, seed: false })
  try {
    const state = (await other.runtime.describeGroup(GROUP)).character
    assert.equal(state.scope.botId, otherBot)
    assert.equal(state.memories.length, 0)
    assert.equal(JSON.parse(kv.get(characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }))).memories.length, 1)
  } finally { other.runtime.stop() }
})

test('行动前 pending 回执写入失败时绝不调用外部工具，也不写入成功事实', async () => {
  let failedWrites = 0
  const h = fixture({
    script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : finishSilently(),
    async writeFault(key, value) {
      if (!key.startsWith('shiloh:character:v1:')) return
      const state = JSON.parse(value)
      if (state.receipts?.some(receipt => receipt.toolName === 'searchInformationTool' && receipt.status === 'pending')) {
        failedWrites += 1
        throw new Error('injected Redis persistence failure')
      }
    },
  })
  try {
    await h.ingest()
    await idle(h, 2)
    assert.equal(failedWrites, 1)
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.match(toolResult(h.calls[1], 'searchInformationTool'), /error:/)
    const state = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(state.receipts.some(receipt => receipt.toolName === 'searchInformationTool'), false)
  } finally { h.runtime.stop() }
})

test('重置会话保留 bot/persona 与旧角色记忆目标，消息 seq 单调增加不复用旧证据', async () => {
  const h = fixture({ script: (_request, index) => index === 0 ? tools(
    toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', content: '我想了解大家提到的游戏', epistemic: 'desired', evidenceRefs: ['message:1'] }),
    toolCall('simGoal', { action: 'create', title: '继续了解游戏资料', motivation: '这符合我的游戏兴趣', nextStep: '找公开介绍',
      completionCriteria: '取得公开资料的成功回执', stopConditions: ['管理员取消'], evidenceRefs: ['message:1'] }),
  ) : finishSilently() })
  try {
    await h.ingest('我最近发现一款新的独立游戏')
    await idle(h, 2)
    await h.ingest('这是重置前最后一条普通群消息', '30000', { at: false })
    const previous = JSON.parse(h.kv.get(sessionKey(GROUP)))
    const characterBefore = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(previous.botId, BOT)
    assert.equal(previous.personaId, 'shiloh')
    assert.equal(characterBefore.memories.length, 1)
    assert.equal(characterBefore.goals.length, 1)
    assert.ok(previous.agentHistory.length > 0)
    assert.match(await h.runtime.resetGroup(GROUP), /已重置/)
    const reset = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(reset.seq, previous.seq)
    assert.equal(reset.lastReadThroughSeq, previous.seq)
    assert.equal(reset.botId, previous.botId)
    assert.equal(reset.personaId, previous.personaId)
    assert.deepEqual(reset.agentHistory, [])
    assert.deepEqual(reset.recent, [])
    const characterAfter = (await h.runtime.describeGroup(GROUP)).character
    assert.deepEqual(characterAfter.memories, characterBefore.memories)
    assert.deepEqual(characterAfter.goals, characterBefore.goals)
    h.clock.value += 60_000
    await h.ingest('重置后第一条新消息', '50000', { at: false })
    const after = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(after.seq, previous.seq + 1)
    assert.equal(after.recent[0].seq, previous.seq + 1)
    assert.ok(after.recent.every(message => message.seq > previous.seq), '新消息不得冒用旧 message:seq')
    assert.deepEqual((await h.runtime.describeGroup(GROUP)).character.memories[0].evidenceRefs, ['message:1'])
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }
})

test('模型请求中删除来源记忆会清空历史，迟到 send/remember 不能再用旧来源且不会复写历史', async () => {
  let release
  let modelWaiting = false
  let memoryId
  const held = new Promise(resolve => { release = resolve })
  const h = fixture({ script: async (request, index) => {
    if (index === 0) return tools(toolCall('simCharacterMemory', {
      action: 'remember', kind: 'interest', content: '我想关注这个独立游戏', epistemic: 'desired', evidenceRefs: ['message:1'],
    }))
    if (index === 2) {
      assert.ok(JSON.stringify(request.messages).includes(memoryId), '模型请求确实带着将被删除的来源记录')
      modelWaiting = true
      await held
      return tools(
        toolCall('simSendMessage', { messages: ['这段依据已被删除的内容不得外发'] }),
        toolCall('simCharacterMemory', { action: 'remember', kind: 'opinion', content: '从已删除来源推导的新观点', epistemic: 'inferred', evidenceRefs: [`memory:${memoryId}`] }),
      )
    }
    return finishSilently()
  } })
  try {
    await h.ingest('这条游戏兴趣是后续的来源')
    await idle(h, 2)
    memoryId = (await h.runtime.describeGroup(GROUP)).character.memories[0].id
    assert.ok(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.length > 0)
    h.clock.value += 60_000
    await h.ingest('继续刚才的话题')
    await waitFor(() => modelWaiting, '模型已收到含旧来源的请求并等待返回')
    await h.runtime.controlCharacter(GROUP, 'delete-memory', memoryId)
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [], '删除操作立即清空持久化的旧上下文')
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    release()
    await idle(h, 4)
    assert.equal(h.sent.length, 0)
    assert.equal(h.events.length, 0)
    assert.match(toolResult(h.calls[3], 'simSendMessage'), /^error:/)
    assert.match(toolResult(h.calls[3], 'simCharacterMemory'), /^error:/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0, '不得从已删除来源再造派生记忆')
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [], '迟到的回合不能把本地旧 history 写回')
  } finally { release(); h.runtime.stop() }
})

test('另一个机器人收到拍一拍不能接管主机器人会话、改写消息或安排唤醒', async () => {
  const kv = new Map()
  const clock = { value: BASE_AT }
  seedSession(kv, GROUP, BOT, clock)
  const original = kv.get(sessionKey(GROUP))
  const secondaryBot = '3094088999'
  const h = fixture({ kv, clock, botId: secondaryBot, seed: false })
  try {
    assert.equal(await h.runtime.ingestPoke({ group_id: GROUP, self_id: secondaryBot, target_id: secondaryBot, user_id: '40000' }), true)
    assert.equal(kv.get(sessionKey(GROUP)), original, '别的机器人拍一拍事件不能改主会话任何字段')
    assert.equal(h.writes.some(write => write.key === sessionKey(GROUP)), false)
    await sleep(1150)
    assert.equal(h.calls.length, 0, '越过 1 秒唤醒窗仍不能调用模型')
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.equal(JSON.parse(kv.get(sessionKey(GROUP))).botId, BOT)
    assert.equal(JSON.parse(kv.get(sessionKey(GROUP))).seq, 0)
  } finally { h.runtime.stop() }
})

test('工具 reply 文本数组拒绝参数 JSON 和内部路径，普通数组转换成文本段后正常发送', async () => {
  const payloads = [
    { label: '参数 JSON', payload: [JSON.stringify({ tags: ['猫'], useCases: ['聊天'], leadText: '来一张表情' })], blocked: true },
    { label: '内部路径', payload: ['/opt/trss-yunzai'], blocked: true },
    { label: '普通文字', payload: ['找到一份公开游戏介绍', '我们可以接着聊它的玩法'], blocked: false },
  ]
  for (const { label, payload, blocked } of payloads) {
    let replyError
    const h = fixture({
      script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : finishSilently(),
      async execute(_name, _args, event) {
        try { await event.reply(payload) } catch (error) { replyError = error }
        return replyError ? { ok: false, error: 'reply was rejected' } : { ok: true, result: 'reply delivered' }
      },
    })
    try {
      await h.ingest(`测试工具回复${label}`)
      await idle(h, 2)
      assert.equal(h.events.length, 1, label)
      if (blocked) {
        assert.ok(replyError, `${label}应由发送闸门拒绝`)
        assert.equal(h.sent.length, 0, `${label}不应发送到群`)
        assert.equal((await h.runtime.describeGroup(GROUP)).character.receipts.find(receipt => receipt.toolName === 'searchInformationTool').status, 'failed')
      } else {
        assert.equal(replyError, undefined)
        assert.equal(h.sent.length, 1)
        assert.deepEqual(h.sent[0].segments, payload.map(text => ({ type: 'text', data: { text } })))
        assert.equal(h.sent[0].groupId, GROUP)
        assert.equal((await h.runtime.describeGroup(GROUP)).character.receipts.find(receipt => receipt.toolName === 'searchInformationTool').status, 'succeeded')
      }
    } finally { h.runtime.stop() }
  }
})

const agentToolImage = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }

test('Agent 图片使用平台无关交付口并与工具文字共用发送配额和持久记账', async () => {
  const actions = [], receipts = [], refusals = []
  const h = fixture({
    maxSendsPerTurn: 1,
    messageActions: { async send(action, guard) {
      assert.equal(guard.isCurrent(), true)
      actions.push(action)
      return { state: 'sent', messageId: 'image-confirmed' }
    } },
    script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : finishSilently(),
    async execute(_name, _args, event) {
      const results = await Promise.allSettled([event._sendAgentToolImage(agentToolImage), event._sendAgentToolImage(agentToolImage)])
      for (const result of results) {
        if (result.status === 'fulfilled') receipts.push(result.value)
        else refusals.push(result.reason.message)
      }
      try { await event.reply('图片后不应绕过配额补发文字') } catch (error) { refusals.push(error.message) }
      return { ok: true, result: 'Image confirmed' }
    },
  })
  try {
    await h.ingest('请给我一张图片')
    await idle(h, 2)
    assert.deepEqual(receipts, [{ state: 'sent', messageId: 'image-confirmed' }])
    assert.equal(actions.length, 1)
    assert.deepEqual(actions[0].parts, [{ kind: 'image', resource: { kind: 'reference', value: `base64://${agentToolImage.base64}` } }])
    assert.deepEqual(actions[0].target, { account: { platform: 'qq', namespace: 'global', id: BOT }, kind: 'group', id: GROUP })
    assert.equal(h.sent.length, 0, '图片交付不走legacy native transport')
    assert.equal(refusals.length, 2)
    assert.ok(refusals.every(reason => reason.includes('上限')))
    const saved = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(saved.sendTimes, [h.clock.value])
    assert.equal(saved.lastAiSendAt, h.clock.value)
  } finally { h.runtime.stop() }
})

test('图片发送结果未知会冻结后续图片和文字，明确失败不消耗发送配额', async () => {
  for (const status of ['unknown', 'interrupted', 'failed']) {
    let attempts = 0
    const receipts = [], refusals = []
    const h = fixture({
      messageActions: { async send() {
        attempts++
        if (status === 'interrupted') throw new Error('private-adapter-detail')
        return status === 'failed' ? { state: 'failed', code: 'explicit-rejection' } : { state: 'unknown' }
      } },
      script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : finishSilently(),
      async execute(_name, _args, event) {
        receipts.push(await event._sendAgentToolImage(agentToolImage))
        try { receipts.push(await event._sendAgentToolImage(agentToolImage)) } catch (error) { refusals.push(error.message) }
        if (status !== 'failed') try { await event.reply('未知送达后不得重发') } catch (error) { refusals.push(error.message) }
        return { ok: false, error: 'Image unconfirmed' }
      },
    })
    try {
      await h.ingest(`图片回执 ${status}`)
      await idle(h, 2)
      assert.equal(attempts, status === 'failed' ? 2 : 1)
      assert.equal(refusals.length, status === 'failed' ? 0 : 2)
      assert.ok(refusals.every(reason => reason.includes('未知')))
      assert.ok(receipts.every(receipt => receipt.state === (status === 'failed' ? 'failed' : 'unknown')))
      assert.equal(h.sent.length, 0)
      assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).sendTimes, [])
    } finally { h.runtime.stop() }
  }
})

test('沉默或暂缓决定会阻止 Agent 图片交付', async () => {
  for (const kind of ['silent', 'deferred']) {
    let attempts = 0, refusal
    const h = fixture({
      messageActions: { async send() { attempts++; return { state: 'sent', messageId: 'must-not-send' } } },
      script: (_request, index) => index === 0 ? tools(toolCall('simDecide', { kind, reason: '先保留想法，不发送' }))
        : index === 1 ? tools(toolCall('searchInformationTool', {})) : finishSilently(),
      async execute(_name, _args, event) {
        try { await event._sendAgentToolImage(agentToolImage) } catch (error) { refusal = error.message }
        return { ok: false, error: 'Image refused' }
      },
    })
    try {
      await h.ingest(`暂不发送图片 ${kind}`)
      await idle(h, 3)
      assert.equal(attempts, 0)
      assert.equal(h.sent.length, 0)
      assert.match(refusal, /沉默或暂缓/u)
    } finally { h.runtime.stop() }
  }
})

const reviewed = (verdict, issues = []) => ({ choices: [{ message: { content: JSON.stringify({ verdict, issues }) } }], usage: { total_tokens: 7 }, model: 'isolated-reviewer' })

test('一致性退回后只允许修正收尾，成功保存目标才发送且审核费用计入', async () => {
  const ledger = [], reviews = []
  const invalid = toolCall('simFinishTurn', { choice: 'chat', reason: '聊天', messages: ['我晚点继续核对资料'], throughSeq: 1 })
  const valid = toolCall('simFinishTurn', { choice: 'schedule', reason: '决定继续', goal: finishGoal, messages: ['我晚点继续核对资料'], throughSeq: 1 })
  const h = fixture({ consistencyEnabled: true, script: (_r, i) => i === 0 ? tools(invalid) : tools(valid), recordTokens: row => ledger.push(row), review: async request => {
    const data = JSON.parse(request.messages[1].content); reviews.push(data)
    return reviews.length === 1 ? reviewed('revise', [{ code: 'missing_goal', reason: '后续安排没有目标' }]) : reviewed('accept')
  } })
  try {
    await h.ingest(); await idle(h, 2)
    assert.equal(h.sent.length, 1); assert.equal(reviews.length, 2)
    assert.match(storedToolReply(h, invalid).content, /本次未保存或发送/)
    assert.equal(turnContext(h.calls[1]).phase, 'closing')
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals.length, 1)
    assert.equal(reviews[0].state.goals.length, 0); assert.equal(reviews[1].state.goals.length, 1)
    assert.equal(ledger.filter(row => row.stage === 'character-consistency').length, 2)
    assert.equal(JSON.parse(h.kv.get(sessionKey(GROUP))).budget.tokens, 34)
  } finally { h.runtime.stop() }
})

test('中途聊天和直接记忆写入也受检查，退回不会发送或偷偷补状态', async () => {
  for (const candidate of [
    toolCall('simSendMessage', { continuation: 'chat', messages: ['我晚点独自继续研究'] }),
    toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', epistemic: 'reported', content: '我已确认资料全都是真的', evidenceRefs: ['message:1'] }),
  ]) {
    let checks = 0
    const h = fixture({ consistencyEnabled: true, script: (_r, i) => i === 0 ? tools(candidate) : tools(toolCall('simFinishTurn', { choice: 'silent', reason: '放弃不一致表达' })), review: async () => { checks++; return reviewed('revise', [{ code: 'unsupported_fact', reason: '依据不支持此断言' }]) } })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, 1); assert.equal(h.sent.length, 0)
      assert.match(storedToolReply(h, candidate).content, /一致性检查/)
      const character = (await h.runtime.describeGroup(GROUP)).character
      assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0)
    } finally { h.runtime.stop() }
  }
})

test('不可用审核每回合最多三次，失败后不能用普通消息绕过', async () => {
  let checks = 0
  const h = fixture({ consistencyEnabled: true, maxToolRounds: 6, script: () => tools(
    toolCall('simFinishTurn', { choice: 'chat', reason: '普通交流', messages: ['这是一句待审核消息'] }),
    toolCall('simSendMessage', { continuation: 'chat', messages: ['试图绕过检查'] }),
  ), review: async () => { checks++; throw new Error('injected private provider failure') } })
  try {
    await h.ingest(); await idle(h, 6)
    assert.equal(checks, 3); assert.equal(h.sent.length, 0)
    assert.ok(h.calls.slice(1).every(request => request.tools.length === 1 && request.tools[0].function.name === 'simFinishTurn'))
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    assert.doesNotMatch(JSON.stringify(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory), /private provider failure/)
  } finally { h.runtime.stop() }
})

test('审核默认关闭或显式关闭时普通消息与状态提交均不调用审核', async () => {
  for (const consistencyEnabled of [undefined, false]) {
    let checks = 0
    const h = fixture({ consistencyEnabled, review: async () => { checks++; throw new Error('disabled reviewer must not run') },
      script: (_request, index) => index === 0 ? tools(toolCall('simSendMessage', { messages: ['先聊一句'] })) : tools(toolCall('simFinishTurn', {
        choice: 'chat', reason: '结束普通交流', memories: [{ kind: 'experience', epistemic: 'reported', content: '群友介绍了一款游戏', evidenceRefs: ['message:1'] }], messages: ['谢谢介绍'], throughSeq: 1,
      })),
    })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, 0)
      assert.equal(h.sent.length, 2)
      assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 1)
    } finally { h.runtime.stop() }
  }
})

test('明确启用但未配置审核端口或独立后端时拒绝公告，仍能静默收尾', async () => {
  for (const missing of ['port', 'backend']) {
    let checks = 0
    const h = fixture({ consistencyEnabled: true,
      ...(missing === 'port' ? {} : { review: async () => { checks++; resolveCharacterConsistencyRoute({ useTools: true }); return reviewed('accept') } }),
      script: (_request, index) => index === 0 ? tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通交流', messages: ['未审核消息'] })) : tools(toolCall('simFinishTurn', { choice: 'silent', reason: '审核不可用，安静结束', throughSeq: 1 })),
    })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, missing === 'port' ? 0 : 1)
      assert.equal(h.sent.length, 0)
      assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
      assert.match(toolResult(h.calls[1], 'simFinishTurn'), /一致性检查未通过/)
    } finally { h.runtime.stop() }
  }
})

test('前两次普通提交通过后阻止非收尾第三次检查，保留最终收尾配额', async () => {
  let checks = 0
  const blocked = toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', epistemic: 'inferred', content: '不能提前耗尽最后检查', evidenceRefs: ['message:1'] })
  const h = fixture({ consistencyEnabled: true, review: async () => { checks++; return reviewed('accept') },
    script: (_request, index) => [
      tools(toolCall('simSendMessage', { messages: ['先聊一句'] })),
      tools(toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', epistemic: 'reported', content: '群友介绍了一款游戏', evidenceRefs: ['message:1'] })),
      tools(blocked),
      tools(toolCall('simFinishTurn', { choice: 'chat', reason: '合并到最终提交', memories: [{ kind: 'interest', epistemic: 'inferred', content: '有一点兴趣', evidenceRefs: ['message:1'] }], messages: ['最后说声谢谢'], throughSeq: 1 })),
    ][index] || finishSilently(),
  })
  try {
    await h.ingest(); await idle(h, 4)
    assert.equal(checks, 3)
    assert.match(storedToolReply(h, blocked).content, /保留.*收尾/)
    assert.equal(turnContext(h.calls[3]).phase, 'closing')
    assert.equal(h.sent.length, 2)
    const memories = (await h.runtime.describeGroup(GROUP)).character.memories
    assert.equal(memories.length, 2)
    assert.equal(memories.some(memory => memory.content === '不能提前耗尽最后检查'), false)
    assert.equal(memories.some(memory => memory.content === '有一点兴趣'), true)
  } finally { h.runtime.stop() }
})

test('管理员在回合中关闭审核后不再开始新审核请求', async () => {
  let enabled = true, checks = 0
  const h = fixture({ consistencyEnabled: () => enabled,
    review: async () => { checks++; enabled = false; return reviewed('accept') },
    script: (_request, index) => index === 0 ? tools(toolCall('simSendMessage', { messages: ['先聊一句'] })) : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通收尾', messages: ['关闭审核后照常结束'], throughSeq: 1 })),
  })
  try {
    await h.ingest(); await idle(h, 2)
    assert.equal(checks, 1)
    assert.equal(h.sent.length, 2)
  } finally { h.runtime.stop() }
})
