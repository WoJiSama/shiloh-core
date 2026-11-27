import test from 'node:test'
import assert from 'node:assert/strict'
import { modelExecutor } from './helpers/modelExecutor.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { modelContextRequest, optionalContext, excerptContext, decodeModelContextLimits } = await load('modules/models/domain/requestContext.js')
const config = { providers: 'oneapi', chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatApiModel: 'chat', chatApiKey: 'fixture' }, toolsAiConfig: { toolsAiUrl: 'https://tools.invalid/v1', toolsAiModel: 'tools', toolsAiApikey: 'fixture' } }
const request = { messages: [{ role: 'user', content: 'hello' }] }
const success = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))

test('a narrower fallback uses its own wire budget and keeps current sources and tool IDs', async () => {
  const calls = []
  const carry = optionalContext({ role: 'user', content: 'OLD_STYLE'.repeat(1700) }, 'style')
  const authority = { role: 'user', content: 'FINAL: 21:00，原群只登记一次' }
  const result = await modelExecutor(async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, bytes: Buffer.byteLength(options.body), body })
    return url.includes('tools.invalid') ? new Response('busy', { status: 503 }) : success()
  }).YTapi(modelContextRequest({ messages: [{ role: 'system', content: 'fixed' }, carry, authority],
    tools: [{ type: 'function', function: { name: 'reminderTool', description: 'file' } }], tool_choice: 'auto' }, 'text'),
    { ...config, useTools: true, modelContext: decodeModelContextLimits({ chat: { windowTokens: 2048, maxRequestBytes: 4096 }, tools: { windowTokens: 32768 } }) })
  assert.equal(result.choices[0].message.content, 'ok')
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /tools\.invalid/u)
  assert.match(calls[1].url, /chat\.invalid/u)
  assert.ok(calls[1].bytes < 4096)
  assert.ok(calls[0].body.messages.some(row => row.content.startsWith('OLD_STYLE')))
  assert.deepEqual(calls[1].body.messages.at(-1), authority)
  assert.equal(calls[1].body.messages.some(row => row.content.startsWith('OLD_STYLE')), false)
  assert.equal(calls[1].body.tools, undefined)
})

test('context overflow retries only a reduced inference and rechecks source authorization', async () => {
  for (const revoked of [false, true]) {
    let checks = 0, sends = 0
    const bodies = []
    const result = await modelExecutor(async (_url, options) => {
      sends++
      bodies.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 })
    }).YTapi(modelContextRequest({ messages: [
      { role: 'system', content: 'system authority' }, optionalContext({ role: 'user', content: 'older matter; '.repeat(90) }, 'history'),
      { role: 'user', content: 'Current verified group request' },
      { role: 'assistant', tool_calls: [{ id: 'called', function: { name: 'commitmentTool', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'called', content: 'Reminder committed; receipt T1' },
      excerptContext({ role: 'user', content: 'references '.repeat(700) + '21:00' }, 'original source: 21:00'),
    ], tools: [{ type: 'function', function: { name: 'simFinishTurn' } }], tool_choice: 'required' }, 'simulation', 3),
    { ...config, useTools: true }, undefined, undefined, { async ensureCurrent() { if (++checks === 2 && revoked) throw new Error('original message revoked') } })
    assert.equal(checks, 2)
    assert.equal(sends, revoked ? 1 : 2)
    assert.equal(result.failure_kind, revoked ? undefined : 'context_length_exceeded')
    if (revoked) continue
    assert.equal(bodies[1].tool_choice, 'required')
    assert.deepEqual(bodies[1].tools, bodies[0].tools)
    assert.deepEqual(bodies[1].messages.filter(row => row.tool_calls || row.tool_call_id), bodies[0].messages.filter(row => row.tool_calls || row.tool_call_id))
    assert.ok(bodies[1].messages.some(row => row.content === 'original source: 21:00'))
    assert.ok(bodies[1].messages.every(row => !row.content?.includes('older matter')))
  }
})

test('request-body rejection is distinct, and mandatory context that exceeds a configured budget never goes out', async () => {
  let calls = 0
  const { YTapi } = modelExecutor(async () => { calls++; return new Response('gateway payload rejected', { status: 413 }) })
  assert.equal((await YTapi(modelContextRequest(request, 'text'), config, undefined, undefined, { forceChatBackend: true })).failure_kind, 'request_body_too_large')
  const limits = decodeModelContextLimits({ chat: { windowTokens: 2048 } })
  const blocked = await YTapi(modelContextRequest({ ...request, messages: [{ role: 'user', content: '凭原文授权'.repeat(1000) }] }, 'text'),
    { ...config, modelContext: limits }, undefined, undefined, { forceChatBackend: true })
  assert.equal(blocked.failure_kind, 'context_length_exceeded')
  const capped = await YTapi(modelContextRequest({ messages: [{ role: 'user', content: 'source '.repeat(800) }] }, 'text'),
    { ...config, modelContext: decodeModelContextLimits({ chat: { windowTokens: 32768, maxRequestBytes: 4096 } }) },
    undefined, undefined, { forceChatBackend: true })
  assert.equal(capped.failure_kind, 'request_body_too_large')
  assert.equal(calls, 1)
})
test('provider error envelopes share one recovery path across the tools and chat backends', async () => {
  for (const [status, payload, expected] of [
    [200, [{ error: { code: 'bad_request', type: 'prompt_too_long' } }], 'context_length_exceeded'],
    [422, { detail: { message: 'This model maximum context length was exceeded.' } }, 'context_length_exceeded'],
    [413, { error: { code: 'payload_too_large' } }, 'request_body_too_large'],
  ]) {
    const failed = () => new Response(JSON.stringify(payload), { status })
    for (const [useTools, recovers] of [[true, false], [true, true], [false, false], [false, true]]) {
      const calls = []
      const { YTapi } = modelExecutor(async (url, options) => {
        calls.push({ url, body: options.body })
        return recovers && calls.length > 1 ? success() : failed()
      })
      const input = modelContextRequest({
        messages: [{ role: 'system', content: 'Rules' },
          optionalContext({ role: 'user', content: 'Old background. '.repeat(1100) }, 'history'), { role: 'user', content: 'Current question' }],
        ...(useTools ? { tools: [{ type: 'function', function: { name: 'read' } }], tool_choice: 'auto' } : {}),
      }, 'text', 2)
      const result = await YTapi(input, { ...config, useTools })
      assert.equal(calls.length, 2)
      assert.equal(calls[0].url, calls[1].url)
      assert.ok(Buffer.byteLength(calls[1].body) < Buffer.byteLength(calls[0].body))
      assert.equal(JSON.parse(calls[1].body).messages.at(-1).content, 'Current question')
      if (recovers) assert.equal(result.choices[0].message.content, 'ok')
      else assert.equal(result.failure_kind, expected)
    }
  }
  const { YTapi } = modelExecutor(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'The prompt is too long.' } }] })))
  assert.equal((await YTapi(modelContextRequest({ ...request }, 'text'), config)).choices[0].message.content, 'The prompt is too long.')
})

test('configured output caps survive compatibility retries on a short-window backend', async () => {
  const calls = []
  const result = await modelExecutor(async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
  }).YTapi(modelContextRequest({ messages: [
    optionalContext({ role: 'user', content: 'Optional. '.repeat(650) }, 'history'), ...request.messages,
  ] }, 'text'), {
    ...config, chatAiConfig: { ...config.chatAiConfig, chatApiModel: 'gpt-5-fixture' },
    modelContext: decodeModelContextLimits({ 'gpt-5-fixture': { windowTokens: 2048, reserveOutputTokens: 512 } }),
  }, undefined, undefined, { generation: { reasoningEffort: 'low' } })
  assert.equal(result.choices[0].message.content, 'ok')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoning_effort, 'low')
  assert.equal(calls[1].reasoning_effort, undefined)
  assert.deepEqual(calls.map(body => body.max_completion_tokens), [512, 512])
  assert.deepEqual(calls.map(body => body.messages), [request.messages, request.messages])
})
test('unsupported generation options retry once on same backend, retaining messages/model', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 const result = await YTapi(request, config, undefined, undefined, { forceChatBackend: true, generation: { reasoningEffort: 'low', maxOutputTokens: 30 } })
 assert.equal(result.choices[0].message.content, 'ok')
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 assert.deepEqual(calls[0].body.messages, calls[1].body.messages)
})
test('forced tool request cannot fall back to text after provider failure', async () => {
 let calls = 0
 const { YTapi } = modelExecutor(async () => { calls++; return new Response('denied', { status: 401 }) })
 const result = await YTapi({ ...request, tools: [{ type: 'function', function: { name: 'run' } }], tool_choice: 'required' }, { ...config, useTools: true })
 assert.match(result.error, /401/)
 assert.equal(calls, 1)
})
test('array response and malformed JSON have stable result contracts', async () => {
 const array = modelExecutor(async () => new Response(JSON.stringify([{ choices: [{ message: { content: 'array' } }] }])) )
 assert.equal((await array.YTapi(request, config)).choices[0].message.content, 'array')
 const malformed = modelExecutor(async () => new Response('not-json'))
 assert.match((await malformed.YTapi(request, config)).error, /JSON/)
})
test('caller cancellation is forwarded and cannot trigger backend fallback', async () => {
 const controller = new AbortController(), reason = new Error('caller stop')
 let calls = 0
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls++; assert.equal(options.signal, controller.signal); controller.abort(reason); throw reason
 })
 await assert.rejects(YTapi(request, config, undefined, undefined, { signal: controller.signal }), error => error === reason)
 assert.equal(calls, 1)
})

test('forced tools failure identifies actual channel and model without URL credentials', async () => {
 const { YTapi } = modelExecutor(async () => new Response('quota exhausted', { status: 429 }))
 const result = await YTapi({ ...request, tools: [{ type: 'function', function: { name: 'run' } }], tool_choice: 'required' }, { ...config, useTools: true, toolsAiConfig: { ...config.toolsAiConfig, toolsAiUrl: 'https://user:password@tools.invalid/v1?token=secret' } })
 assert.match(result.error, /渠道=tools.invalid；模型=tools/)
 assert.match(result.error, /429/)
 assert.doesNotMatch(result.error, /password|token=secret/)
})

const lowConfig = { ...config, useTools: true, chatAiConfig: { ...config.chatAiConfig, chatReasoningEffort: 'low' }, toolsAiConfig: { ...config.toolsAiConfig, toolsAiApikey: 'fixture-tools-key' } }
const forcedToolRequest = { ...request, tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'run' } } }
const complexRequest = { messages: [{ role: 'user', content: '分析刚才转发里几个人的方案，比较一下为什么失败。' }] }

test('successful text and tool responses do not log failures or request and response bodies', async () => {
 const content = 'private-response-fixture'
 const privateRequest = { messages: [{ role: 'user', content: 'private-request-fixture' }] }
 for (const tools of [false, true]) {
  const logs = [], failures = []
  const logger = { info: (...values) => logs.push(values), warn: (...values) => failures.push(values), error: (...values) => failures.push(values) }
  const { YTapi } = modelExecutor(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content,
   ...(tools ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: '{"value":"private-tool-fixture"}' } }] } : {}) } }] })), logger)
  const result = await YTapi(tools ? { ...forcedToolRequest, ...privateRequest } : privateRequest, tools ? lowConfig : config)
  assert.equal(result.choices[0].message.content, content)
  assert.deepEqual(failures, [])
  assert.ok(logs.length > 0)
  assert.doesNotMatch(JSON.stringify(logs), /private-request-fixture|private-response-fixture|private-tool-fixture|fixture-tools-key/)
 }
})

test('tool requests inherit global low effort while retaining their backend, credentials and forced action', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return success()
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.equal(result.choices[0].message.content, 'ok')
 assert.equal(calls.length, 1)
 assert.equal(calls[0].url, 'https://tools.invalid/v1/chat/completions')
 assert.equal(calls[0].headers.Authorization, 'Bearer fixture-tools-key')
 assert.equal(calls[0].body.model, 'tools')
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.deepEqual(calls[0].body.tools, forcedToolRequest.tools)
 assert.deepEqual(calls[0].body.tool_choice, forcedToolRequest.tool_choice)
})

test('adaptive complex backend inherits global low and respects its independent effort', async () => {
 for (const toolsReasoningEffort of ['', 'medium']) {
  const calls = []
  const { YTapi } = modelExecutor(async (url, options) => {
   calls.push({ url, body: JSON.parse(options.body) }); return success()
  })
  await YTapi(complexRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tools.invalid/v1/chat/completions')
  assert.equal(calls[0].body.model, 'tools')
  assert.equal(calls[0].body.reasoning_effort, toolsReasoningEffort || 'low')
  assert.equal(calls[0].body.tools, undefined)
 }
})

test('empty planner response retains resolved effort when continuing on the chat backend', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })) : success()
 })
 await YTapi({ ...forcedToolRequest, tool_choice: 'auto' }, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort: 'medium' } })
 assert.deepEqual(calls.map(call => call.body.model), ['tools', 'chat'])
 assert.deepEqual(calls.map(call => call.body.reasoning_effort), ['medium', 'medium'])
 assert.equal(calls[1].body.tools, undefined)
 assert.equal(calls[1].body.tool_choice, undefined)
})

test('adaptive text fallback preserves the outgoing effort rather than reverting to the model default', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unavailable', { status: 503 }) : success()
 })
 await YTapi(complexRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort: 'medium' } })
 assert.deepEqual(calls.map(call => call.body.model), ['tools', 'chat'])
 assert.deepEqual(calls.map(call => call.body.reasoning_effort), ['medium', 'medium'])
})

test('unsupported tool generation options retry once on the same backend without weakening a forced action', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, headers: options.headers, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 await YTapi(forcedToolRequest, lowConfig, undefined, undefined, { generation: { reasoningEffort: 'low', maxOutputTokens: 50 } })
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.deepEqual(calls[0].headers, calls[1].headers)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 assert.equal(calls[1].body.max_tokens, undefined)
 for (const field of ['model', 'messages', 'tools', 'tool_choice']) assert.deepEqual(calls[0].body[field], calls[1].body[field])
})

test('provider-specific flat named choice remains intact through generation compatibility recovery', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 await YTapi(forcedToolRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsAiUrl: 'https://api.souimagery.fun/v1/chat/completions' } })
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 for (const call of calls) {
  assert.deepEqual(call.body.tool_choice, { type: 'function', name: 'run' })
  assert.deepEqual(call.body.tools, forcedToolRequest.tools)
 }
})

test('rejected optional parameters cannot cause an unlimited tool retry or forced text fallback', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return new Response('unsupported reasoning_effort', { status: 400 })
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.match(result.error, /400/)
 assert.equal(calls.length, 2)
 assert.ok(calls.every(call => call.url === 'https://tools.invalid/v1/chat/completions'))
 assert.ok(calls.every(call => JSON.stringify(call.body.tool_choice) === JSON.stringify(forcedToolRequest.tool_choice)))
})

test('tool-choice compatibility stays with its existing recovery and does not strip effort', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls.push(JSON.parse(options.body)); return new Response('Thinking mode does not support this tool_choice', { status: 400 })
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.match(result.error, /Thinking mode does not support this tool_choice/)
 assert.equal(calls.length, 1)
 assert.equal(calls[0].reasoning_effort, 'low')
 assert.deepEqual(calls[0].tool_choice, forcedToolRequest.tool_choice)
})

test('tool authentication, rate limit and upstream failures do not retry without generation parameters', async () => {
 for (const status of [401, 429, 503]) {
  let calls = 0
  const { YTapi } = modelExecutor(async () => { calls++; return new Response('unsupported reasoning_effort', { status }) })
  assert.match((await YTapi(forcedToolRequest, lowConfig)).error, new RegExp(String(status)))
  assert.equal(calls, 1)
 }
})

test('cancellation between tool compatibility attempts aborts without another request or fallback', async () => {
 const controller = new AbortController(), reason = new Error('stop tool compatibility')
 let calls = 0
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls++; assert.equal(options.signal, controller.signal)
  controller.abort(reason)
  return new Response('unsupported reasoning_effort', { status: 400 })
 })
 await assert.rejects(YTapi(forcedToolRequest, lowConfig, undefined, undefined, { signal: controller.signal }), error => error === reason)
 assert.equal(calls, 1)
})
