import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = relative => import(pathToFileURL(path.join(release, 'dist/backend', relative)).href)
const { createTextConversation } = await load('modules/conversation/infrastructure/textConversation.js')
const { createGroupTextTools } = await load('modules/conversation/infrastructure/groupTextTools.js')
const { generateAgentFailureNotice } = await load('modules/conversation/infrastructure/agentFailureNotice.js')
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, input = { action: 'list' }) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(input) } },
] } }] })
const safeNotice = '这次没有拿到结果，稍后再试试。'
const unknownNotice = '刚才的操作可能已经生效，我先停下，核实后再处理。'
const privateError = 'PRIVATE_PROVIDER_BODY https://internal.invalid/?token=SECRET'

function fixture(options = {}) {
  const account = { platform: options.platform ?? 'fixture', namespace: 'text-failures', id: 'bot' }
  const target = { account, kind: options.privateChat ? 'private' : 'group', id: 'room' }, sender = { ...account, id: 'human' }
  const binding = { source: 'configured', id: 'binding', revision: 'revision', personaId: 'default', agentId: 'role', connectionId: 'connection', target }
  const now = Date.now(), controller = new AbortController(), diagnostics = [], requests = [], sends = [], history = [], historyReads = [], episodes = [], learning = [], actions = []
  let receipt = 'pending', resultText, version = 'initial', invalidatedAt = 0, current = true, toolCalls = 0
  const observe = event => diagnostics.push({ stage: event.stage, operation: event.operation, outcome: event.outcome, code: event.code })
  const f = { target, binding, requests, sends, history, historyReads, episodes, learning, diagnostics, actions, controller,
    get toolCalls() { return toolCalls }, get receipt() { return receipt },
    revoke(kind = 'binding') { if (kind === 'privacy') invalidatedAt++; else if (kind === 'recall') version = 'recalled'; else current = false },
  }
  const runtime = createTextConversation({
    inbox: {
      async isTextReplyPending() { return receipt === 'pending' }, async isTextReplyConfirmed() { return receipt === 'confirmed' },
      async textActionReceipt() { return receipt === 'action' ? '' : receipt === 'result' ? resultText : undefined },
      async textRecallVersion() { return version }, async loadTextHistory() { return undefined },
      async claimTextAction() {
        if (receipt !== 'pending') return false
        receipt = 'action'; actions.push('claimed'); await options.onActionClaim?.(); return true
      },
      async finishTextAction(_target, _id, expectedVersion, text) {
        if (expectedVersion !== version || receipt !== 'action') return false
        resultText = text; receipt = 'result'; actions.push('finished'); return true
      },
      async claimTextReply(_target, _id, expectedVersion, actionReceipt) {
        if (expectedVersion !== version || (actionReceipt === undefined ? receipt !== 'pending' : actionReceipt ? receipt !== 'result' || resultText !== actionReceipt : receipt !== 'action')) return false
        receipt = 'attempted'; return true
      },
      async confirmTextReply() { if (options.postSendThrows) throw Error(privateError); receipt = 'confirmed'; return true },
      async saveTextHistory(_target, _version, entry) { if (options.postSendThrows) throw Error(privateError); history.push(entry) },
    },
    actions: { async send(action, guard) {
      await options.beforeDispatch?.()
      await guard.ensureCurrent?.()
      sends.push(action); if (options.sendThrows) throw Error(privateError); return options.sendReceipt ?? { state: 'sent', messageId: 'reply' }
    } },
    personMemory: { async getSceneRedactions() { await options.onRedactions?.(); return { invalidatedAt } }, async query() { return { items: [] } } },
    bindingToken: () => 'text-binding', groupToolNames: () => options.tools ?? ['commitmentTool'],
    groupTools: options.groupTools ?? { definitions: () => [{ type: 'function', function: { name: 'commitmentTool', parameters: { type: 'object', properties: {}, required: [] } } }],
      async execute(_call, _allowed, context) { toolCalls++; if (options.attempted) assert.equal(await context.claimAction(), true); return options.toolResult ?? { text: '已完成原有操作。', attempted: false } } },
    isPrivatePeer: () => true, allowsText: text => !text.includes('PRIVATE') && !text.includes('SECRET'),
    ...(options.allowsToolInput ? { allowsToolInput: options.allowsToolInput } : {}),
    async reserveGroupTurn() { return true }, now: () => now,
    diagnostics: { emit: observe, traceId: () => 'fixture-trace' }, ...(options.fallbackText ? { fallbackText: options.fallbackText } : {}),
    async recordGroupReply() { if (options.postSendThrows) throw Error(privateError) },
    async recordEpisode(value) { if (options.postSendThrows) throw Error(privateError); episodes.push(value) },
    async learnConfirmed() { learning.push(true) },
    ...(options.topic ? { readTopicContext: options.topic } : {}),
    ...(options.semantic ? { readSemanticMemory: options.semantic } : {}),
    ...(options.history ? { async readHistory(_incoming, input) { historyReads.push(input); return { text: '本轮允许查看的历史证据', async isCurrent() { return current } } } } : {}),
    async model(request, _target, _signal, guard, ensure) {
      assert.equal(guard(), true); await ensure?.(); requests.push(request)
      return options.model ? options.model(request, requests.length, f) : answer(safeNotice)
    },
  })
  const incoming = { version: 1, conversation: target, sender: options.sender?.(sender) ?? sender, messageId: 'trigger', occurredAt: now, text: '请处理这次请求',
    parts: [{ kind: 'text', text: '请处理这次请求' }], mentions: [], directedToAccount: true }
  return Object.assign(f, { reply: () => runtime.reply(incoming, { binding, persona: { name: '测试角色' }, systemContent: '说话简短自然' }, () => current, controller.signal) })
}

for (const mode of ['throw', 'error', 'empty']) test(`text ${mode} failure ends with one tool-free model explanation without replay or retained memory`, async () => {
  const f = fixture({ model(_request, index) { if (index === 1) { if (mode === 'throw') throw Error(privateError); return mode === 'error' ? { error: privateError } : { choices: [] } } return answer(safeNotice) } })
  await f.reply(); await f.reply()
  assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].parts[0].text, safeNotice)
  assert.deepEqual(f.requests[1].tools, []); assert.equal(f.requests[1].tool_choice, 'none')
  assert.equal(JSON.stringify(f.requests).includes(privateError), false)
  assert.deepEqual(f.history, []); assert.deepEqual(f.episodes, []); assert.deepEqual(f.learning, [])
  assert.ok(f.diagnostics.some(event => event.operation === 'text_reply_model' && event.outcome === 'failed'))
})

test('history-followup model failure explains once without repeating the history read or persisting evidence', async () => {
  const f = fixture({ history: true, model(_request, index) { return index === 1 ? call('chatHistoryTool', { question: '历史', source: 'recent' }) : index === 2 ? { error: privateError } : answer(safeNotice) } })
  await f.reply()
  assert.equal(f.requests.length, 3); assert.equal(f.sends.length, 1)
  assert.equal(JSON.stringify(f.requests[2]).includes('本轮允许查看的历史证据'), false)
  assert.deepEqual(f.historyReads, [{ question: '历史', source: 'recent' }])
  assert.deepEqual(f.history, []); assert.deepEqual(f.episodes, [])
  assert.ok(f.diagnostics.some(event => event.operation === 'text_history_model' && event.outcome === 'failed'))
})

test('private QQ and group DingTalk share the budget and recheck recalled topic evidence at dispatch', async () => {
  const { modelContextMetadata } = await load('modules/models/domain/requestContext.js')
  for (const [platform, privateChat] of [['qq', true], ['dingtalk', false]]) {
    for (const revokeAt of ['model', 'delivery', 'none']) {
      let valid = true, checked = 0
      const f = fixture({
        platform, privateChat,
        async topic(binding, authorId, messageId) {
          assert.equal(binding.target.account.platform, platform)
          assert.equal(authorId, 'human')
          assert.equal(messageId, 'trigger')
          return { text: '阿岚昨天确认改到 21:00。', messageIds: ['correction-1'],
            async isCurrent() { checked++; return valid } }
        },
        async semantic(_incoming, _guard, _signal, exclude) { assert.deepEqual(exclude, ['correction-1']) },
        async model(request) {
          assert.equal(modelContextMetadata(request).purpose, 'text')
          assert.match(JSON.stringify(request.messages), /昨天确认改到 21:00/u)
          if (revokeAt === 'model') valid = false
          return answer('改到 21:00 集合。')
        },
        beforeDispatch() { if (revokeAt === 'delivery') valid = false },
      })
      await f.reply()
      assert.equal(f.sends.length, revokeAt === 'none' ? 1 : 0)
      assert.equal(f.requests.length, 1)
      assert.ok(checked >= 2)
      assert.deepEqual(f.episodes, [])
      assert.ok(f.history.every(history => history.turns.length === 0))
      if (platform === 'dingtalk' && revokeAt === 'none') assert.equal(f.sends[0].replyTo, 'trigger')
    }
  }
})

test('a receipt carrying revoked topic evidence cannot be replayed after a confirmed tool action', async () => {
  let valid = true
  const f = fixture({ attempted: true,
    async topic() { return { text: '需复核的本群原话', messageIds: ['past-confirmation'], isCurrent: async () => valid } },
    model() { return call('commitmentTool') },
    toolResult: { text: '已完成原有操作。', attempted: true },
    beforeDispatch() { valid = false },
  })
  await f.reply(); await f.reply()
  assert.equal(f.toolCalls, 1)
  assert.deepEqual(f.actions, ['claimed'])
  assert.deepEqual(f.sends, [])
})

test('history schema and host credential checks block both group and private reader dispatch', async () => {
  for (const privateChat of [false, true]) {
    for (const args of [JSON.stringify({ question: '历史', limit: '1' }), '{"question":"PRIVATE_TOKEN"}', '{"question":"\\u0050RIVATE_TOKEN"}']) {
      const f = fixture({ privateChat, history: true, allowsToolInput: text => !text.includes('PRIVATE_TOKEN'), model(_request, index) {
        const response = call('chatHistoryTool', { question: '历史' })
        response.choices[0].message.tool_calls[0].function.arguments = args
        return index === 1 ? response : answer(safeNotice)
      } })
      await f.reply()
      assert.deepEqual(f.historyReads, []); assert.deepEqual(f.actions, [])
      assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
    }
  }
})

test('unavailable explanation records a terminal diagnostic and only uses an explicitly configured fallback', async () => {
  for (const fallbackText of [undefined, '这次暂时处理不了，过会儿再试。']) {
    const f = fixture({ fallbackText, model() { return { error: privateError } } })
    await f.reply()
    assert.equal(f.requests.length, 2); assert.equal(f.sends.length, fallbackText ? 1 : 0)
    assert.deepEqual(f.history, []); assert.deepEqual(f.episodes, [])
    assert.ok(f.diagnostics.some(event => event.code === (fallbackText ? 'fallback_ready' : 'explanation_unavailable')))
  }
})

for (const kind of ['binding', 'privacy', 'recall']) test(`${kind} revocation cancels explanation and fallback without sending`, async () => {
  const f = fixture({ fallbackText: '暂时处理不了。', model(_request, index, owner) {
    if (index === 1) return { error: privateError }
    owner.revoke(kind); return answer(safeNotice)
  } })
  await f.reply()
  assert.equal(f.requests.length, 2); assert.deepEqual(f.sends, []); assert.deepEqual(f.history, [])
  assert.ok(f.diagnostics.some(event => event.outcome === 'cancelled'))
})

for (const failure of ['failed', 'unknown']) test(`tool ${failure} is explained by the model without executing the operation twice`, async () => {
  const attempted = failure === 'unknown', text = attempted ? unknownNotice : safeNotice
  const f = fixture({ attempted, toolResult: { text: attempted ? '操作结果未确认，可能已经生效。' : '查询失败，没有获得结果。', attempted, failure },
    model(_request, index) { return index === 1 ? call('commitmentTool') : answer(text) } })
  await f.reply(); await f.reply()
  assert.equal(f.toolCalls, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].parts[0].text, text)
  assert.equal(JSON.parse(f.requests[1].messages[1].content).outcome, failure)
  assert.deepEqual(f.requests[1].tools, []); assert.deepEqual(f.history, []); assert.deepEqual(f.learning, [])
  assert.deepEqual(f.actions, attempted ? ['claimed', 'finished'] : [])
})

test('unknown delivery and confirmed delivery follow their existing fences without another explanation', async () => {
  const unknown = fixture({ sendReceipt: { state: 'unknown' }, model: () => answer('普通回复') })
  await unknown.reply(); await unknown.reply()
  assert.equal(unknown.requests.length, 1); assert.equal(unknown.sends.length, 1)
  assert.deepEqual(unknown.history, []); assert.ok(unknown.diagnostics.some(event => event.operation === 'text_delivery' && event.outcome === 'unknown'))
  const thrown = fixture({ sendThrows: true, model: () => answer('普通回复') })
  await thrown.reply(); await thrown.reply()
  assert.equal(thrown.requests.length, 1); assert.equal(thrown.sends.length, 1)
  const confirmed = fixture({ postSendThrows: true, model: () => answer('普通回复') })
  await confirmed.reply(); await confirmed.reply()
  assert.equal(confirmed.requests.length, 1); assert.equal(confirmed.sends.length, 1)
  assert.ok(confirmed.diagnostics.filter(event => event.code === 'post_send_record_failed').length >= 3)
})

test('successful tool confirmations retain the direct reply behavior', async () => {
  const f = fixture({ model: () => call('commitmentTool') })
  await f.reply()
  assert.equal(f.requests.length, 1); assert.equal(f.toolCalls, 1); assert.equal(f.sends[0].parts[0].text, '已完成原有操作。')
})

test('failure helper rejects tool calls, forbidden output and empty content, and isolates diagnostic observers', async () => {
  for (const response of [call('forbidden'), answer('PRIVATE_OUTPUT'), answer(''), { choices: [{ message: { content: '不应发送', function_call: { name: 'legacy' } } }] }]) {
    let calls = 0
    assert.equal(await generateAgentFailureNotice({ model: async () => { calls++; return response }, isCurrent: () => true,
      allowsText: text => !text.includes('PRIVATE'), stage: 'model', outcome: 'failed' }), undefined)
    assert.equal(calls, 1)
  }
  const notice = await generateAgentFailureNotice({ model: async () => answer('😀'.repeat(700)), isCurrent: () => true, allowsText: () => true,
    diagnostics: { emit() { throw Error('observer') }, traceId() { throw Error('observer') } }, stage: 'tool', outcome: 'unknown' })
  assert.equal(Array.from(notice).length, 600)
})

function actualGroupTools({ execute, knowledge, diagnostics } = {}) {
  const parameters = { type: 'object', properties: { action: { type: 'string', enum: ['list', 'create', 'cancel', 'notify'] },
    commitment_id: { type: 'string' }, static_message: { type: 'string', maxLength: 100 } }, required: ['action'] }
  const base = { parameters, description: 'fixture', validateParameters: () => true }
  return createGroupTextTools({ commitment: { ...base, executeWithReceipt: execute, managePrivateReminder: execute },
    memory: { ...base, executeForOwner: execute }, ...(knowledge ? { knowledge: { ...base, executeForRequest: knowledge } } : {}), diagnostics })
}

test('group tool read throws and write throws produce safe classified failures with diagnostics', async () => {
  const events = [], tools = actualGroupTools({ execute: async () => { throw Error(privateError) }, diagnostics: { emit: event => events.push(event.code), traceId: () => 'fixture' } })
  const account = { platform: 'fixture', namespace: 'group-tool', id: 'bot' }
  const context = { binding: { target: { account, kind: 'group', id: 'room' } }, actor: { kind: 'user', user: { ...account, id: 'human' } },
    userText: '创建提醒', request: { messageId: 'source', text: '创建提醒', mentions: [] },
    isCurrent: () => true, allowsText: () => true, claimAction: async () => true }
  for (const action of ['list', 'create']) {
    const result = await tools.execute(call('commitmentTool', { action, ...(action === 'create' ? { static_message: '通知正文' } : {}) }).choices[0].message.tool_calls[0], ['commitmentTool'], context)
    assert.equal(result.failure, action === 'list' ? 'failed' : 'unknown')
    assert.equal(result.attempted, action === 'create'); assert.equal(result.text.includes('PRIVATE'), false)
  }
  assert.equal(events.filter(code => code === 'tool_execution_failed').length, 2)
})

test('static group and private inputs are checked before the handler can take a write claim', async () => {
  const groupTools = actualGroupTools({ execute: async () => assert.fail('invalid call reached a static action') })
  for (const settings of [
    { input: { action: 'create', static_message: '字'.repeat(101) } },
    { input: { action: 'create', static_message: '喝水', deliver: 'agent' } },
    { input: { action: 'create', static_message: '喝水' }, sender: sender => ({ ...sender, id: 'bot' }) },
    { privateChat: true, input: { action: 'cancel', commitment_id: 123 } },
    { privateChat: true, input: { action: 'cancel', commitment_id: 'reminder', static_message: '群工具字段' } },
    { privateChat: true, input: { action: 'create', static_message: '喝水' } },
    { privateChat: true, input: { action: 'cancel', commitment_id: 'HOST_TOKEN' } },
    { raw: '{"action":"create","static_message":"\\u0048OST_TOKEN"}' },
  ]) {
    const f = fixture({ ...settings, groupTools, allowsToolInput: text => !text.includes('HOST_TOKEN'), model(_request, index) {
      const response = call('commitmentTool', settings.input)
      if (settings.raw) response.choices[0].message.tool_calls[0].function.arguments = settings.raw
      return index === 1 ? response : answer(safeNotice)
    } })
    await f.reply()
    assert.deepEqual(f.actions, [], JSON.stringify(settings))
    assert.equal(f.sends.length, 1)
  }
})

test('static group tools recheck grants after async permission checks and after claiming', async () => {
  for (const revokeAt of ['permission', 'claim']) {
    let armed = false, checks = 0
    const options = { tools: ['commitmentTool'], groupTools: actualGroupTools({ execute: async () => assert.fail('revoked call reached a static write') }),
      model(_request, index) { if (index === 1) armed = true; return call('commitmentTool', { action: 'create', static_message: '喝水' }) },
      async onRedactions() { if (armed && ++checks === 3 && revokeAt === 'permission') options.tools = [] },
      async onActionClaim() { if (revokeAt === 'claim') options.tools = [] },
    }
    const f = fixture(options)
    await f.reply()
    assert.deepEqual(f.actions, revokeAt === 'claim' ? ['claimed'] : [])
    assert.deepEqual(f.sends, [])
  }
})

test('a group workflow unknown transport result suppresses all follow-up messages and models', async () => {
  for (const conclusion of ['本次通知结果未确认，可能已经发送，请先核实，不要重复执行。', '本次操作未获有效确认，请先核实，不要重复执行。']) {
    let executed = 0
    const groupTools = actualGroupTools({ knowledge: async () => { executed++; return conclusion } })
    const f = fixture({ groupTools, tools: ['groupKnowledgeTool'], model: () => call('groupKnowledgeTool', { action: 'notify' }) })
    await f.reply(); await f.reply()
    assert.equal(executed, 1); assert.equal(f.requests.length, 1); assert.deepEqual(f.sends, []); assert.deepEqual(f.history, [])
    assert.ok(f.diagnostics.some(event => event.code === 'delivery_unconfirmed'))
  }
})
