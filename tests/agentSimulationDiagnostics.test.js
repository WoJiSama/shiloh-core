import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCharacterSharedSelf } from '../dist/backend/modules/simulation/infrastructure/characterSharedSelf.js'
import { createCharacterWorkspace } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'
import test from 'node:test'
import { createAgentDiagnostics } from '../dist/backend/modules/runtime/infrastructure/agentDiagnostics.js'
import { createAgentFailureAlerts } from '../dist/backend/modules/runtime/infrastructure/agentFailureAlerts.js'
import { formatQqOwnerAlerts } from '../dist/backend/bootstrap/standaloneQqAlerts.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { CHARACTER_MIN_WAKE_MS, addCharacterMemory, beginCharacterGoalAttempt, characterKey, createCharacterGoal, createEmptyCharacterState, deleteCharacterMemory } from '../dist/backend/modules/simulation/domain/characterState.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { SIMULATION_KNOWN_GROUPS_KEY } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentConversationKey, createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'

const BOT = '3094088525'
const GROUP = '80186'
const OTHER_GROUP = '10087'
const BASE_AT = 1_790_000_000_000
const sessionKey = groupId => `shiloh:sim:g:${groupId}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let callSequence = 0
let incomingMessageId = 0
const toolCall = (name, args) => ({ id: `test-call-${++callSequence}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'simSendMessage' ? { continuation: 'chat', ...args } : args) } })
const tools = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })
const quiet = () => ({ role: 'assistant', content: '' })
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
  groups = [GROUP], script = () => quiet(), execute, writeFault, onSave, send, review, recordTokens,
  proactiveProbability = 0, seed = true, maxToolRounds = 8, maxSendsPerTurn, consistencyEnabled,
  runCharacterWorker, recordToolResult, judgeSocialPermission, getPersona, loadDelegatedMemories,
  getStyleDigest, readSemanticMemory, getSemanticRecall, readConversationMemory, readGroupMemory, wakeGateJudge,
  recordGroupReply, recordEpisode,
  getSelf, handlesTarget, messageActions, getTodaySpendCny, durableIngress, isAccountReady, readFault,
  describeImages, fetchImageBase64, getForwardContent, allowsToolInput, diagnostics, rawModel, failureNoticeFallback, ephemeralTools = false, withDiagnosticScope, logger,
} = {}) {
  if (seed) for (const groupId of groups) if (!kv.has(sessionKey(groupId))) seedSession(kv, groupId, botId, clock)
  const calls = []
  const events = []
  const sent = []
  const errors = []
  const writes = []
  const groupReplyRecords = [], episodeRecords = []
  const toolDefinitions = ['searchInformationTool', 'ownerAdminTool', 'simDangerTool'].map(name => ({
    name, description: `测试隔离工具 ${name}`, ...(ephemeralTools ? { agentDataPolicy: 'ephemeral' } : {}),
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args, event) {
      events.push({ name, args, event })
      return execute ? await execute(name, args, event) : { ok: true, result: '公开搜索结果' }
    },
  }))
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
    ...(diagnostics ? { diagnostics } : {}), ...(failureNoticeFallback ? { failureNoticeFallback } : {}), ...(withDiagnosticScope ? { withDiagnosticScope } : {}),
    logger: logger ?? { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSelf: getSelf ?? (() => ({ id: botId, name: identity.name })),
    getPersona: getPersona ?? (() => ({ personaId: identity.id, persona: { name: identity.name }, systemContent: identity.systemContent })),
    getSection: () => ({
      enabled: true, allGroups: false, groups,
      ...(consistencyEnabled === undefined ? {} : { consistency: { enabled: typeof consistencyEnabled === 'function' ? consistencyEnabled() : consistencyEnabled } }),
      extraTools: toolDefinitions.map(tool => tool.name), toolPolicy: { mode: 'legacy' },
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability, proactiveIdleMs: 60_000 },
      turn: { maxToolRounds, minSendGapMs: 0, maxTurnsPerDay: 100, ...(maxSendsPerTurn === undefined ? {} : { maxSendsPerTurn }) },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: Boolean(wakeGateJudge) }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }),
    async recordGroupReply(...args) { groupReplyRecords.push(args); await recordGroupReply?.(...args) },
    async recordEpisode(input) { episodeRecords.push(input); await recordEpisode?.(input) },
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
    ...(getStyleDigest ? { getStyleDigest } : {}),
    ...(readSemanticMemory ? { readSemanticMemory } : {}),
    ...(getSemanticRecall ? { getSemanticRecall } : {}),
    ...(readConversationMemory ? { readConversationMemory } : {}),
    ...(readGroupMemory ? { readGroupMemory } : {}),
    ...(wakeGateJudge ? { wakeGateJudge } : {}),
    ...(describeImages ? { describeImages } : {}),
    ...(fetchImageBase64 ? { fetchImageBase64 } : {}),
    ...(getForwardContent ? { getForwardContent } : {}),
    ...(allowsToolInput ? { allowsToolInput } : {}),
    getExtraTools: names => toolDefinitions.filter(tool => names.includes(tool.name)),
    async YTapi(request) {
      calls.push(structuredClone(request))
      if (rawModel) return await rawModel(request, calls.length - 1)
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
    runtime, kv, clock, identity, botId, calls, events, sent, errors, writes, groupReplyRecords, episodeRecords,
    scope: (groupId = GROUP) => ({ botId, personaId: identity.id, groupId }),
    async ingest(text = '看看这个游戏', userId = '40000', { at = true, groupId = GROUP, source } = {}) {
      const incoming = decodeQqIncomingMessage({ group_id: groupId, self_id: botId, user_id: userId, message_id: `test-${groupId}-${++incomingMessageId}`, message_type: 'group', msg: text,
        atBot: at, message: at ? [{ type: 'at', data: { qq: botId } }, { type: 'text', data: { text } }] : [], sender: { nickname: `群友${userId}` }, ...(source ? { source } : {}) }, {now: clock.value})
      assert.ok(incoming)
      return runtime.ingest(incoming)
    },
  }
}

const notice = '这次没能取得结果，当前请求还没有完成。'
const failedResponse = { error: { message: 'sk-private-should-never-leave' } }
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 7 } })
const spy = () => { const events = []; return { events, emit(event) { const { error, ...safe } = event; events.push({ ...safe, ...(error ? { errorKind: error instanceof Error ? 'Error' : 'Unknown' } : {}) }) }, traceId: () => 'fixture-trace' } }

test('session read failures, invalid stored state and health findings produce distinct redacted QQ alerts', async t => {
  const rows = [], terminal = [], batches = []
  const alerts = createAgentFailureAlerts({
    channel: 'qq', logger: { error() {} },
    async deliver(batch) { batches.push(batch); return { state: 'confirmed' } },
  })
  t.after(() => alerts.close())
  const diagnostics = createAgentDiagnostics({
    sink: { async append(row) { rows.push(row); return true } },
    logger: { info() {}, warn() {}, error(line) { terminal.push(line) } }, onFailure: alerts.report,
  })
  let failRead = true
  const h = fixture({ diagnostics, logger: diagnostics.logger, readFault(key) {
    if (failRead && key === sessionKey(GROUP)) throw new TypeError('private-redis-error sk-test-placeholder')
  } })
  t.after(() => h.runtime.stop())
  const valid = h.kv.get(sessionKey(GROUP))
  await h.runtime.describeGroup(GROUP)
  failRead = false
  h.kv.set(sessionKey(GROUP), '{private-corrupted-state')
  await h.runtime.describeGroup(GROUP)
  h.kv.set(sessionKey(GROUP), valid)
  h.kv.set(SIMULATION_KNOWN_GROUPS_KEY, JSON.stringify([GROUP]))
  h.kv.set('bl-chat:commitment:faillog', JSON.stringify([{ id: 'private-task-id', intent: 'private-task-text', group_id: GROUP }]))
  await h.runtime.sweepOnce()
  await waitFor(() => rows.some(row => row.code === 'commitment_terminal_failure'), 'health classification is written')
  await diagnostics.flush()
  await alerts.close()

  const read = rows.findLast(row => row.code === 'session_read_failed')
  const decode = rows.find(row => row.code === 'session_decode_failed')
  assert.equal(read.operation, 'simulation_session_load')
  assert.equal(read.errorKind, 'TypeError')
  assert.equal(decode.operation, read.operation)
  assert.equal(decode.errorKind, 'SyntaxError')
  assert.ok(terminal.some(line => line.includes(`session_read_failed trace=${read.traceId} errorKind=TypeError`)))
  const text = batches.map(formatQqOwnerAlerts).join('\n')
  assert.match(text, /读取群聊会话失败.*\n持久化的会话状态暂时无法读取/u)
  assert.match(text, /读取群聊会话失败.*\n已保存的会话状态格式损坏/u)
  assert.match(text, /后台健康检查失败.*\n托付账本中存在未完成或结果待确认的记录/u)
  assert.ok(text.includes(`追踪编号 ${read.traceId}`))
  assert.doesNotMatch(JSON.stringify({ rows, terminal, batches, text }),
    /runtime_warning|private-redis-error|sk-test-placeholder|private-corrupted-state|private-task-(text|id)/u)
  assert.doesNotMatch(text, new RegExp(`(?<![0-9A-Za-z-])${GROUP}(?![0-9A-Za-z-])`, 'u'))
})

async function settled(h, minCalls = 1) {
  await waitFor(async () => h.calls.length >= minCalls && !(await h.runtime.describeGroup(GROUP)).running,
    `simulation settles: ${h.errors.join(' | ')}`)
}

test('human model throw, returned error, empty and malformed replies each receive one tool-free explanation through persisted finish', async t => {
  for (const mode of ['throw', 'returned', 'empty', 'malformed']) {
    const diagnostics = spy(), h = fixture({ diagnostics, rawModel(request, index) {
      if (index === 0) {
        if (mode === 'throw') throw Error('https://secret.invalid/private?key=sk-private')
        return mode === 'returned' ? failedResponse : mode === 'empty' ? reply('') : { choices: [{ message: { content: '正文不能掩盖坏工具', tool_calls: [{ function: { arguments: '{}' } }] } }] }
      }
      assert.deepEqual(request.tools, []); assert.equal(request.tool_choice, 'none')
      assert.doesNotMatch(JSON.stringify(request), /sk-private|secret.invalid|request body text/)
      return reply(notice)
    } })
    t.after(() => h.runtime.stop()); await h.ingest('request body text'); await settled(h, 2)
    assert.equal(h.calls.length, 2, mode); assert.equal(h.sent.length, 1, mode)
    assert.ok(JSON.stringify(h.sent[0]).includes(notice))
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(session.agentHistory, []); assert.equal(session.lastConfirmedChat, undefined)
    assert.equal(h.groupReplyRecords.length, 0); assert.equal(h.episodeRecords.length, 0)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.ok(character.receipts.some(row => row.toolName === 'simFinishTurn' && row.status === 'succeeded'))
    assert.ok(diagnostics.events.some(row => row.stage === 'model' && row.outcome === 'failed'))
    assert.ok(diagnostics.events.some(row => row.operation === 'simulation_failure_notice'))
    assert.doesNotMatch(JSON.stringify(diagnostics.events), /sk-private|secret.invalid|request body text|正文不能/)
  }
})

test('unavailable explanation stays silent unless a trusted fallback was configured, and does not retry main tools', async t => {
  for (const fallback of [undefined, '这次服务暂不可用，请稍后再试。']) {
    const diagnostics = spy(), h = fixture({ diagnostics, failureNoticeFallback: fallback, rawModel: () => failedResponse })
    t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 2)
    assert.equal(h.calls.length, 2); assert.equal(h.sent.length, fallback ? 1 : 0)
    if (fallback) assert.ok(JSON.stringify(h.sent).includes(fallback))
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(session.agentHistory, []); assert.equal(session.lastConfirmedChat, undefined)
    assert.equal(h.groupReplyRecords.length, 0); assert.equal(h.episodeRecords.length, 0)
    assert.equal(h.events.length, 0)
  }
})

test('automatic proactive failure is logged without requesting or sending an explanation', async t => {
  const diagnostics = spy(), h = fixture({ diagnostics, proactiveProbability: 1, rawModel: () => failedResponse })
  t.after(() => h.runtime.stop()); await h.ingest('普通群聊背景', '40000', { at: false })
  h.clock.value += 2 * 60 * 60_000; await h.runtime.sweepOnce(); await settled(h)
  assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'proactiveCheck')
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0)
  assert.ok(diagnostics.events.some(row => row.stage === 'model' && row.outcome === 'failed'))
})

test('optional wake and memory read failures preserve one normal turn with fixed diagnostics and empty fallbacks', async t => {
  for (const semanticReader of ['current', 'legacy']) {
    const diagnostics = spy(), reads = []
    const unavailable = name => async () => { reads.push(name); throw Error(`private-read-body-${name}`) }
    const h = fixture({ diagnostics, proactiveProbability: 1,
      wakeGateJudge: semanticReader === 'current' ? unavailable('wake') : async () => { reads.push('wake'); return null },
      loadDelegatedMemories: unavailable('delegated'), getStyleDigest: unavailable('style'),
      ...(semanticReader === 'current' ? { readSemanticMemory: unavailable('semantic') } : { getSemanticRecall: unavailable('semantic') }),
      readConversationMemory: unavailable('narrative'), readGroupMemory: unavailable('group'),
      script: () => tools(toolCall('simFinishTurn', { choice: 'silent', reason: '本轮无需发言' })),
    })
    t.after(() => h.runtime.stop()); await h.ingest('普通群聊背景', '40000', { at: false })
    h.clock.value += 2 * 60 * 60_000; await h.runtime.sweepOnce(); await settled(h)
    assert.equal(h.calls.length, 1, semanticReader); assert.equal(h.sent.length, 0, semanticReader)
    assert.deepEqual(reads.slice().sort(), ['wake', 'delegated', 'style', 'semantic', 'narrative', 'group'].sort())
    for (const [operation, code] of [
      ['simulation_wake_gate', 'wake_gate_unavailable'],
      ['simulation_delegated_memory_read', 'delegated_memory_unavailable'],
      ['simulation_style_digest_read', 'style_digest_unavailable'],
      ['simulation_semantic_memory_read', 'semantic_recall_unavailable'],
      ['simulation_narrative_memory_read', 'narrative_memory_unavailable'],
      ['simulation_group_memory_read', 'group_memory_unavailable'],
    ]) assert.equal(diagnostics.events.filter(row => row.operation === operation && row.code === code && row.outcome === 'failed').length, 1)
    assert.equal(diagnostics.events.some(row => row.operation === 'simulation_failure_notice'), false)
    assert.doesNotMatch(JSON.stringify(diagnostics.events), /private-read-body/)
    assert.doesNotMatch(JSON.stringify(h.calls), /private-read-body/)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.decision.kind, 'silent')
    assert.equal(character.decision.reason, '本轮无需发言')
  }
})

test('stopping during wake screening records cancellation and never starts the main model', { timeout: 10000 }, async t => {
  const diagnostics = spy(), started = Promise.withResolvers(), verdict = Promise.withResolvers()
  const h = fixture({ diagnostics, proactiveProbability: 1,
    wakeGateJudge: () => { started.resolve(); return verdict.promise },
  })
  t.after(() => { h.runtime.stop(); verdict.resolve(null) })
  await h.ingest('普通群聊背景', '40000', { at: false })
  h.clock.value += 2 * 60 * 60_000
  await h.runtime.sweepOnce()
  await started.promise
  h.runtime.stop()
  await h.runtime.drain()
  assert.equal(h.calls.length, 0)
  assert.deepEqual(diagnostics.events.filter(row => row.operation === 'simulation_wake_gate')
    .map(row => [row.outcome, row.code]), [['cancelled', 'wake_gate_cancelled']])
})

test('reply and episode record failures keep confirmed delivery without another model or send', async t => {
  const diagnostics = spy(), h = fixture({ diagnostics,
    recordGroupReply: async () => { throw Error('private-group-reply-body') },
    recordEpisode: async () => { throw Error('private-episode-body') },
    script: () => tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通聊天', messages: ['已确认发送的正常回复'] })),
  })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h)
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
  assert.equal(h.groupReplyRecords.length, 1); assert.equal(h.episodeRecords.length, 1)
  assert.equal(diagnostics.events.filter(row => row.operation === 'simulation_group_reply_record' && row.code === 'group_reply_not_recorded' && row.outcome === 'failed').length, 1)
  assert.equal(diagnostics.events.filter(row => row.operation === 'simulation_episode_record' && row.code === 'episode_not_recorded' && row.outcome === 'failed').length, 1)
  assert.equal(diagnostics.events.some(row => row.operation === 'simulation_failure_notice'), false)
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /private-group-reply-body|private-episode-body/)
  const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
  assert.equal(session.lastConfirmedChat.text, '已确认发送的正常回复')
  const character = JSON.parse(h.kv.get(characterKey(h.scope())))
  assert.ok(character.receipts.some(row => row.toolName === 'simFinishTurn' && row.status === 'succeeded'))
})

test('binding loss between main failure and explanation suppresses all later model and send work', async t => {
  const base = { platform: 'qq', namespace: 'global', id: BOT }, address = { account: base, kind: 'group', id: GROUP }
  let revision = 'one'
  const binding = () => createAgentBindingDirectory({ version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: 'qq', namespace: 'global', accountId: BOT }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: GROUP, agentId: 'role' }] }, revision).resolve(address)
  const diagnostics = spy(), h = fixture({ diagnostics, getPersona: () => ({ personaId: 'agent:role', persona: { name: '希洛' }, systemContent: '', binding: binding() }),
    rawModel() { revision = 'two'; return failedResponse } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h)
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0)
})

test('unknown delivery followed by a model failure stays frozen without an explanatory model or duplicate send', async t => {
  let attempts = 0
  const diagnostics = spy(), h = fixture({ diagnostics, rawModel(_request, index) {
    return index === 0 ? { choices: [{ message: tools(toolCall('simSendMessage', { messages: ['一次发送'] })) }] } : failedResponse
  }, send() { attempts++; return { ok: false, unknown: true } } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 2)
  assert.equal(h.calls.length, 2); assert.equal(attempts, 1); assert.equal(h.sent.length, 0)
  assert.ok(diagnostics.events.some(row => row.stage === 'model' && row.outcome === 'failed'))
})

test('failed host tools remain one execution and return to the main model before its final failure notice', async t => {
  let executions = 0
  const diagnostics = spy(), h = fixture({ diagnostics, execute() { executions++; return { kind: 'tool_outcome', status: 'error', content: 'not-completed-private-tool-body' } },
    rawModel(request, index) {
      if (index === 0) return { choices: [{ message: tools(toolCall('searchInformationTool', {})) }] }
      if (index === 1) { assert.ok(request.messages.some(row => row.role === 'tool')); return failedResponse }
      assert.deepEqual(request.tools, []); return reply(notice)
    } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 3)
  assert.equal(executions, 1); assert.equal(h.calls.length, 3); assert.equal(h.sent.length, 1)
  assert.ok(diagnostics.events.some(row => row.operation === 'searchInformationTool' && row.outcome === 'failed'))
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /not-completed-private-tool-body/)
})


test('routine closing can omit its reason and confirmed read payloads succeed', async t => {
  const diagnostics = spy()
  const h = fixture({ diagnostics, script: (_request, index) => index === 0 ? tools(toolCall('simGetUnreadMessages', {}))
    : tools(toolCall('simFinishTurn', { choice: 'chat', messages: ['正常收尾'], markRead: false })) })
  t.after(() => h.runtime.stop())
  await h.ingest()
  await settled(h, 2)
  assert.equal(h.sent.length, 1)
  for (const operation of ['simGetUnreadMessages', 'simFinishTurn']) {
    assert.deepEqual(diagnostics.events.filter(row => row.operation === operation).map(row => row.outcome), ['started', 'succeeded'])
  }
  const finish = h.calls[1].tools.find(tool => tool.function.name === 'simFinishTurn').function.parameters
  assert.equal(finish.properties.markRead.type, 'boolean')
  assert.equal(Object.hasOwn(finish.properties, 'throughSeq'), false)
  assert.equal(JSON.parse(h.kv.get(sessionKey(GROUP))).lastReadThroughSeq, 0)
})

test('finish preflight reports fixed rejection reasons to QQ and allows a corrected call', async t => {
  const params = { choice: 'chat', reason: '群聊收尾', messages: ['修改后成功发送'] }
  const invalidJson = toolCall('simFinishTurn', params)
  invalidJson.function.arguments = '{"reason":'
  const cases = [
    { code: 'tool_arguments_invalid', cause: /有效 JSON 对象/u, message: tools(invalidJson) },
    { code: 'tool_schema_invalid', cause: /choice 缺少必填项/u, field: 'choice', rule: 'required',
      message: tools(toolCall('simFinishTurn', { markRead: true })) },
    { code: 'tool_schema_invalid', cause: /reason 字符数不足/u, field: 'reason', rule: 'minLength', message: tools(toolCall('simFinishTurn', { ...params, reason: '' })) },
    { code: 'tool_content_blocked', cause: /触发了宿主出站内容检查/u, message: tools(toolCall('simFinishTurn', { ...params, reason: 'fixture-private-value' })) },
    { code: 'finish_read_range_invalid', cause: /throughSeq 超出本轮已读范围/u, field: 'throughSeq', rule: 'read_through',
      message: tools(toolCall('simFinishTurn', { ...params, throughSeq: 999 })) },
    { code: 'finish_reply_reference_invalid', cause: /replyToSeq 不在本轮可引用的序号内/u, field: 'replyToSeq', rule: 'visible_sequence',
      message: tools(toolCall('simFinishTurn', { ...params, replyToSeq: 999 })) },
    { code: 'finish_messages_missing', cause: /需要把正文放进 messages/u,
      message: { ...tools(toolCall('simFinishTurn', { choice: 'chat', reason: '群聊收尾' })), content: '这一段正文在工具参数外。' } },
  ]
  for (const { code, cause, field, rule, message } of cases) {
    await t.test(code, async t => {
      const rows = [], batches = []
      const alerts = createAgentFailureAlerts({ channel: 'qq', logger: { error() {} },
        async deliver(batch) { batches.push(batch); return { state: 'confirmed' } },
      })
      const diagnostics = createAgentDiagnostics({
        sink: { async append(row) { rows.push(row); return true } },
        logger: { info() {}, warn() {}, error() {} }, onFailure: alerts.report,
      })
      const h = fixture({ diagnostics, logger: diagnostics.logger, allowsToolInput: value => !value.includes('fixture-private-value'),
        script: (_request, index) => index === 0 ? message : tools(toolCall('simFinishTurn', params)) })
      t.after(async () => { h.runtime.stop(); await diagnostics.flush(); await alerts.close() })
      if (code === 'finish_read_range_invalid') await h.ingest('更早一条未展示的背景消息', '50000', { at: false })
      await h.ingest()
      await settled(h, 2)
      await diagnostics.flush()
      await alerts.close()
      assert.equal(h.calls.length, 2)
      if (field === 'choice') {
        assert.match(h.calls[1].messages.find(row => row.role === 'tool').content, /"choice":"silent","markRead":true/u)
      }
      assert.equal(h.sent.length, 1)
      assert.ok(JSON.stringify(h.sent[0]).includes(params.messages[0]))
      const finishRows = rows.filter(row => row.operation === 'simFinishTurn')
      assert.deepEqual(finishRows.map(row => [row.outcome, row.code]), [['failed', code], ['started', undefined], ['succeeded', 'completed']])
      if (field) assert.deepEqual([finishRows[0].details.field, finishRows[0].details.rule, finishRows[0].details.result], [field, rule, 'not_dispatched'])
      const text = batches.map(formatQqOwnerAlerts).join('\n')
      assert.match(text, cause)
      if (code === 'finish_read_range_invalid') {
        assert.equal(finishRows[0].details.limit, 0)
        assert.match(text, /提交的已读序号 999.*最早未展示序号 1/u)
      }
      assert.ok(text.includes(`错误码 ${code}`))
      assert.ok(text.includes(`追踪编号 ${finishRows[0].traceId}`))
      assert.doesNotMatch(JSON.stringify({ rows, batches, text }), /fixture-private-value|这一段正文在工具参数外|修改后成功发送/u)
    })
  }
})

test('simSendMessage reports the invalid value type and accepts the corrected string array', async t => {
  const diagnostics = spy()
  const h = fixture({ diagnostics, script(_request, index) {
    if (index === 0) return tools(toolCall('simSendMessage', { messages: [{ text: 'PRIVATE-TOOL-VALUE' }] }))
    if (index === 1) return tools(toolCall('simSendMessage', { messages: ['已按数组发送'] }))
    return tools(toolCall('simFinishTurn', { choice: 'silent', reason: '发送完成' }))
  } })
  t.after(() => h.runtime.stop())
  await h.ingest()
  await settled(h, 3)
  const failed = diagnostics.events.find(row => row.operation === 'simSendMessage' && row.code === 'tool_schema_invalid')
  assert.deepEqual(failed.details, { field: 'messages.items', rule: 'type', expectedType: 'string', actualType: 'object', result: 'not_dispatched', attempt: 1 })
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE-TOOL-VALUE/u)
  assert.match(h.calls[1].messages.find(row => row.role === 'tool').content, /"messages":\["你好"\]/u)
  assert.equal(h.sent.length, 1)
  assert.match(JSON.stringify(h.sent[0]), /已按数组发送/u)
})

test('markRead can finish a directed reply with an earlier unread gap', async t => {
  for (const readInSameBatch of [false, true]) await t.test(readInSameBatch ? 'with a read in the same batch' : 'with only the directed message shown', async t => {
    const diagnostics = spy(), h = fixture({ diagnostics, script(request) {
      const wake = request.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('本轮可引用的消息证据'))
      assert.match(wake.content, /本轮可引用的消息证据：message:2866$/u)
      const finish = toolCall('simFinishTurn', { choice: 'chat', messages: ['接着点名的话题'], markRead: true })
      return readInSameBatch ? tools(toolCall('simGetUnreadMessages', {}), finish) : tools(finish)
    } })
    t.after(() => h.runtime.stop())
    const stored = JSON.parse(h.kv.get(sessionKey(GROUP)))
    h.kv.set(sessionKey(GROUP), JSON.stringify({ ...stored, seq: 2861, lastReadThroughSeq: 2861 }))
    for (let n = 0; n < 4; n++) await h.ingest('背景消息', '50000', { at: false })
    await h.ingest('被点名的话题')
    await settled(h, 1)
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
    const state = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(state.lastReadThroughSeq, 2861)
    assert.deepEqual(state.unread.map(message => message.seq), [2862, 2863, 2864, 2865, 2866])
    const result = JSON.parse(state.agentHistory.find(message => message.role === 'tool' && message.name === 'simFinishTurn').content)
    assert.equal(result.readStatus, 'succeeded'); assert.equal(result.readThroughSeq, 2861)
    if (readInSameBatch) {
      const read = JSON.parse(state.agentHistory.find(message => message.role === 'tool' && message.name === 'simGetUnreadMessages').content)
      assert.equal(read.readThroughSeq, 2866)
    }
    assert.deepEqual(diagnostics.events.filter(row => row.operation === 'simFinishTurn').map(row => row.outcome), ['started', 'succeeded'])
  })
})

test('failed closing validation or review cannot be bypassed by a later failure explanation', async t => {
  for (const mode of ['parameters', 'review']) {
    const diagnostics = spy(), h = fixture({ diagnostics, consistencyEnabled: mode === 'review',
      review: async () => { throw Error('private-review-provider-body') },
      rawModel(_request, index) {
        return index === 0 ? { choices: [{ message: tools(toolCall('simFinishTurn', {
          choice: 'chat', reason: mode === 'parameters' ? '' : '普通回复', messages: ['原始待审核回复'],
        })) }] } : failedResponse
      } })
    t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 2)
    assert.equal(h.calls.length, 2, mode); assert.equal(h.sent.length, 0, mode)
    assert.ok(diagnostics.events.some(row => row.operation === 'simulation_failure_notice' && row.code === 'notice_not_authorized'))
    assert.equal(diagnostics.events.filter(row => row.stage === 'tool' && row.operation === 'simFinishTurn' && row.outcome === 'failed').length, 1, mode)
  }
})

test('ephemeral tool reads stay inside the original model chain without an additional failure explanation', async t => {
  const diagnostics = spy(), h = fixture({ diagnostics, ephemeralTools: true,
    execute: () => ({ ok: true, result: 'private-ephemeral-body' }),
    rawModel(_request, index) {
      return index === 0 ? { choices: [{ message: tools(toolCall('searchInformationTool', {})) }] } : failedResponse
    } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 2)
  assert.equal(h.calls.length, 2); assert.equal(h.events.length, 1); assert.equal(h.sent.length, 0)
  assert.ok(diagnostics.events.some(row => row.code === 'notice_not_authorized'))
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /private-ephemeral-body/)
})

test('tool round exhaustion records a terminal diagnostic and attempts one tool-free persisted explanation', async t => {
  const diagnostics = spy(), h = fixture({ diagnostics, maxToolRounds: 4,
    rawModel(request, index) {
      if (index < 4) return { choices: [{ message: tools(toolCall('privateToolIdentifier123', {})) }] }
      assert.deepEqual(request.tools, []); assert.equal(request.tool_choice, 'none'); return reply(notice)
    } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 5)
  assert.equal(h.calls.length, 5); assert.equal(h.events.length, 0); assert.equal(h.sent.length, 1)
  assert.ok(diagnostics.events.some(row => row.operation === 'simulation_tool' && row.outcome === 'failed' && row.code === 'tool_not_available'))
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /privateToolIdentifier123/u)
  assert.ok(diagnostics.events.some(row => row.operation === 'simulation_turn' && row.code === 'tool_budget_exhausted' && row.outcome === 'failed'))
})


test('model explanations and unavailable-model fallbacks preserve earlier chat and do not reinforce long-term meme memory', async t => {
  for (const fallbackOnly of [false, true]) {
    const explanatoryText = '回声提示：这次没能取得结果。'
    const memoryKey = `${sessionKey(GROUP)}:memories`
    const clock = { value: BASE_AT }, kv = new Map(), diagnostics = spy()
    const originalMeme = [{ id: 'meme-existing', kind: 'meme', content: '回声提示', count: 4, done: false,
      createdAt: BASE_AT - 1000, updatedAt: BASE_AT - 1000, source: 'admin' }]
    kv.set(memoryKey, JSON.stringify(originalMeme))
    const h = fixture({ kv, clock, diagnostics, ...(fallbackOnly ? { failureNoticeFallback: explanatoryText } : {}),
      rawModel(_request, index) {
        if (index === 0) return { choices: [{ message: tools(toolCall('simFinishTurn', {
          choice: 'chat', reason: '普通聊天', messages: ['前一轮确认过的正常回复'],
        })) }] }
        return index === 1 || fallbackOnly ? failedResponse : reply(explanatoryText)
      } })
    t.after(() => h.runtime.stop()); await h.ingest('第一轮正常聊天'); await settled(h)
    const before = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(h.sent.length, 1); assert.equal(h.groupReplyRecords.length, 1); assert.equal(h.episodeRecords.length, 1)
    const firstWrite = h.writes.length
    h.clock.value += CHARACTER_MIN_WAKE_MS + 1000
    await h.ingest('第二轮失败请求'); await settled(h, 3)
    assert.equal(h.calls.length, 3); assert.equal(h.sent.length, 2)
    assert.ok(JSON.stringify(h.sent[1]).includes(explanatoryText))
    const after = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(after.agentHistory, before.agentHistory)
    assert.deepEqual(after.lastConfirmedChat, before.lastConfirmedChat)
    assert.equal(h.groupReplyRecords.length, 1); assert.equal(h.episodeRecords.length, 1)
    assert.deepEqual(JSON.parse(h.kv.get(memoryKey)), originalMeme)
    assert.equal(h.writes.slice(firstWrite).some(row => row.key === memoryKey), false)
    assert.doesNotMatch(JSON.stringify(after.agentHistory), /回声提示|第二轮失败请求/)
  }
})

test('a scheduled simulation turn establishes diagnostics from its resolved binding and actual trigger message', async t => {
  const account = { platform: 'qq', namespace: 'global', id: BOT }, target = { account, kind: 'group', id: GROUP }
  const binding = createAgentBindingDirectory({ version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: 'qq', namespace: 'global', accountId: BOT }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: GROUP, agentId: 'role' }] }, 'one').resolve(target)
  const rows = [], diagnostics = createAgentDiagnostics({ sink: { async append(row) { rows.push(row); return true } } })
  const scopes = [], h = fixture({ diagnostics,
    getPersona: () => ({ personaId: 'agent:role', persona: { name: '希洛' }, systemContent: '', binding }),
    withDiagnosticScope(scope, operation, run) { scopes.push(scope); return diagnostics.run(scope, operation, run) },
    rawModel(_request, index) { return index === 0 ? failedResponse : reply(notice) } })
  t.after(() => h.runtime.stop()); await h.ingest(); await settled(h, 2); await diagnostics.flush()
  assert.equal(scopes.length, 1); assert.equal(scopes[0].kind, 'conversation')
  assert.equal(scopes[0].binding.id, binding.id); assert.match(scopes[0].messageId, /^test-/)
  const operations = rows.filter(row => row.stage === 'model' || row.stage === 'tool')
  assert.ok(operations.length > 0)
  assert.ok(operations.every(row => row.scope.kind === 'conversation' && row.scope.binding.id === binding.id && row.scope.messageId === scopes[0].messageId))
  assert.equal(new Set(operations.map(row => row.traceId)).size, 1)
})
