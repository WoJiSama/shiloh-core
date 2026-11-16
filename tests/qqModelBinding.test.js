import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
import { createToolAssembly } from '../dist/backend/modules/tools/infrastructure/toolAssembly.js'
import { createStrictConversation } from '../dist/backend/modules/conversation/infrastructure/strictConversation.js'
import { classifyIntentWithModel } from '../dist/backend/modules/conversation/application/modelIntentClassifier.js'
import { createPromptContext } from '../dist/backend/modules/conversation/infrastructure/promptContext.js'

const logger = { info() {}, warn() {}, error() {} }
const config = {
  providers: 'oneapi',
  chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatApiModel: 'chat', chatApiKey: 'fixture' },
  toolsAiConfig: { toolsAiUrl: 'https://tools.invalid/v1', toolsAiModel: 'tools', toolsAiApikey: 'fixture' },
  trackAiConfig: { trackAiUrl: 'https://track.invalid/v1', trackAiModel: 'track', trackAiApikey: 'fixture' },
}
const request = { messages: [{ role: 'user', content: '原角色的会话正文' }] }
const toolRequest = { ...request, tools: [{ type: 'function', function: { name: 'fixtureTool' } }], tool_choice: 'auto' }
const completion = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }))
const endpoint = url => `${url}/chat/completions`

function executor(fetch) {
  return createModelExecutor({ fetch, logger, resolveChatCompletionUrl: endpoint,
    removeToolPromptsFromMessages: messages => messages, summarizeToolResultForAgent: () => '',
    resolveAgentBackend: config => ({ apiUrl: config.chatAiConfig.chatApiUrl, model: config.chatAiConfig.chatApiModel,
      apiKey: config.chatAiConfig.chatApiKey }),
    shouldAcceptPlannerTextResponse: () => false,
  })
}

for (const { label, input, modelConfig, status, body } of [
  { label: 'same backend generation retry', input: request, modelConfig: config, status: 400, body: 'unsupported max_tokens' },
  { label: 'recursive tool to text fallback', input: toolRequest, modelConfig: { ...config, useTools: true }, status: 503, body: 'upstream busy' },
  { label: 'recursive text backend fallback', input: request, modelConfig: config, status: 503, body: 'upstream busy' },
  { label: 'empty planner to text fallback', input: toolRequest, modelConfig: { ...config, useTools: true }, status: 200,
    body: JSON.stringify({ choices: [{ message: { content: '' } }] }) },
]) {
  test(`QQ binding revocation during provider I/O blocks ${label}`, async () => {
    let current = true
    const calls = []
    const started = Promise.withResolvers(), deliverBody = Promise.withResolvers()
    const {YTapi} = executor(async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body) })
      if (calls.length > 1) return completion('旧角色回复')
      started.resolve()
      const stream = new ReadableStream({ async start(controller) {
        await deliverBody.promise
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      } })
      return new Response(stream, { status })
    })
    const pending = YTapi(input, modelConfig, undefined, undefined, {
      isCurrent: () => current, generation: { maxOutputTokens: 25 },
    })
    await started.promise
    current = false
    deliverBody.resolve()
    const result = await pending
    assert.equal(calls.length, 1)
    assert.equal(result.choices, undefined)
    assert.match(String(result.error), /角色绑定已改变/u)
    assert.ok(calls[0].payload.messages.some(message => message.content === request.messages[0].content))
  })
}

test('QQ host recovery suppresses late results and stops before calling even a custom executor again', async () => {
  for (const result of [{ error: 'HTTP 503 upstream busy' }, { choices: [{ message: { content: '旧角色成功回复' } }] }]) {
    let current = true
    const started = Promise.withResolvers(), finish = Promise.withResolvers()
    const requests = []
    const assembly = createToolAssembly({ logger, YTapi: async (input, _config, _content, _name, options) => {
      requests.push(input)
      assert.equal(options.isCurrent(), true)
      started.resolve()
      await finish.promise
      return result
    } })
    const pending = assembly.retryRequest({ config }, request, undefined, 2, undefined, { isCurrent: () => current })
    await started.promise
    current = false
    finish.resolve()
    assert.equal(await pending, null)
    assert.equal(requests.length, 1)
  }
})

test('guarded provider logging omits a discarded response body', async () => {
  let current = true
  const messages = []
  const log = (...values) => messages.push(values)
  const started = Promise.withResolvers(), complete = Promise.withResolvers()
  const { YTapi } = createModelExecutor({ logger: { info: log, warn: log, error: log }, resolveChatCompletionUrl: endpoint,
    removeToolPromptsFromMessages: items => items, summarizeToolResultForAgent: () => '', shouldAcceptPlannerTextResponse: () => false,
    async fetch() {
      started.resolve()
      await complete.promise
      return completion('只有旧回合可见的结果')
    },
  })
  const pending = YTapi(request, config, undefined, undefined, { forceChatBackend: true, isCurrent: () => current })
  await started.promise
  current = false
  complete.resolve()
  assert.match(String((await pending).error), /角色绑定已改变/u)
  assert.doesNotMatch(JSON.stringify(messages), /只有旧回合可见的结果/u)
})

test('strict QQ batch tracker drops an obsolete row and its history before provider dispatch', async () => {
  const requests = []
  const conversation = createStrictConversation({ logger, bot: () => ({ uin: 10, nickname: '验收机器人' }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return completion('{"MSG_1_11":true,"MSG_2_12":true}')
    },
  })
  const results = await conversation.batchIsUserTalkingToBot({ config, resolveChatCompletionUrl: endpoint }, [
    { e: { user_id: 11, _isAgentBindingCurrent: () => true }, userMessage: '有效消息', chatHistory: [] },
    { e: { user_id: 12, _isAgentBindingCurrent: () => false }, userMessage: '旧角色原文', chatHistory: [{ role: 'user', content: '旧角色历史' }] },
  ])
  assert.deepEqual(results, [true, false])
  assert.equal(requests.length, 1)
  assert.match(JSON.stringify(requests), /有效消息/u)
  assert.doesNotMatch(JSON.stringify(requests), /旧角色/u)
})

test('strict QQ batch fallback rechecks each binding after a failed request', async () => {
  let firstCurrent = true
  const requests = []
  const conversation = createStrictConversation({ logger, bot: () => ({ uin: 10, nickname: '验收机器人' }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      if (requests.length === 1) {
        firstCurrent = false
        return new Response('temporary failure', { status: 503 })
      }
      return completion('true')
    },
  })
  const host = { config, resolveChatCompletionUrl: endpoint,
    fallbackToSingleJudgment: (...args) => conversation.fallbackToSingleJudgment(host, ...args),
    isUserTalkingToBot: (...args) => conversation.isUserTalkingToBot(host, ...args),
  }
  const results = await conversation.batchIsUserTalkingToBot(host, [
    { e: { user_id: 11, _isAgentBindingCurrent: () => firstCurrent }, userMessage: '甲的原文', chatHistory: [] },
    { e: { user_id: 12 }, userMessage: '乙的问题', chatHistory: [] },
  ])
  assert.deepEqual(results, [false, true])
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests[0]), /甲的原文/u)
  assert.doesNotMatch(JSON.stringify(requests[1]), /甲的原文/u)
  assert.match(JSON.stringify(requests[1]), /乙的问题/u)
})

test('intent classifier rejects a stale request and ignores an already-dispatched late result', async () => {
  let current = false
  let calls = 0
  const options = { text: '这是什么？', config, isCurrent: () => current, fetchImpl: async () => {
    calls++
    current = false
    return completion('{"intent":"image_analysis","confidence":0.9,"reason":"待检验结果"}')
  } }
  assert.equal((await classifyIntentWithModel(options)).reason, 'binding_changed')
  assert.equal(calls, 0)
  current = true
  assert.equal((await classifyIntentWithModel(options)).reason, 'binding_changed')
  assert.equal(calls, 1)
})

test('an understanding brief does not dispatch when material construction invalidates its binding', async () => {
  let current = true
  let calls = 0
  const api = createPromptContext({ info() {}, fetchBrief: async () => { calls++; return completion('旧回合简报') } })
  const host = { config, gatherUnderstandingMaterials() {
    current = false
    return { cfg: { briefEnabled: true, briefTimeoutMs: 50, maxChars: 600 }, intentText: '旧角色的材料' }
  }, buildUnderstandingContextPrompt: () => '规则卡' }
  const brief = await api.resolveUnderstandingPrompt(host, { e: { _isAgentBindingCurrent: () => current } })
  assert.equal(brief, '')
  assert.equal(calls, 0)
})
