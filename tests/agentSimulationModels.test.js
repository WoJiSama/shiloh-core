import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createAgentSimulationWakeGate, createAgentSimulationMemeExtractor } = await importBilibiliHost('modules/simulation/infrastructure/agentSimulationModels.js')
const { agentErrorDetails } = await importBilibiliHost('modules/runtime/infrastructure/agentDiagnostics.js')
const apiKey = 'simulation-provider-private-key-123456'
const options = { baseUrl: 'https://simulation.example/v1', name: 'simulation-fixture', apiKey }
const target = { account: { platform: 'qq', namespace: 'global', id: 'private-account' }, kind: 'group', id: 'private-group' }
const input = { reason: '概率唤醒', messages: [{ name: '小甲', text: '这句话只是普通闲聊', atSelf: false }] }
const memes = [{ name: '小甲', text: '今天也是蓝色星期八' }, { name: '小乙', text: '又是蓝色星期八' }]
const memeResult = [{ content: '蓝色星期八', source_id: '1', note: '两人接梗' }]
const FAILURE = '仿真侧路模型请求失败：请求已取消、授权失效或模型服务不可用。'
function context(overrides = {}) {
  return { target, binding: { source: 'configured', id: 'private-binding', revision: 'private-revision', agentId: 'private-agent',
    personaId: 'private-persona', connectionId: 'private-connection', target }, signal: new AbortController().signal,
    isCurrent: () => true, ensureCurrent: async () => {}, ...overrides }
}
function answer(content, extra = {}) { return new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra })) }
async function rejected(operation) {
  await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined)
}

test('wake uses the provider output budget and meme extraction sends its own budget over HTTP', async t => {
  const received = [], usage = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    received.push({ path: req.url, method: req.method, authorization: req.headers.authorization, data })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: received.length === 1 ? '```json\n{"engage":false,"reason":"群友闲聊"}\n```' : JSON.stringify(memeResult) } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, hidden: 99 },
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const config = { ...options, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
  const ctx = context({ recordUsage: (...args) => usage.push(args) })
  assert.deepEqual(await createAgentSimulationWakeGate(config)(input, () => true, ctx), { engage: false, reason: '群友闲聊' })
  assert.deepEqual(JSON.parse(await createAgentSimulationMemeExtractor(config)(memes, () => true, ctx)), memeResult)
  assert.equal(received.length, 2)
  for (const req of received) {
    assert.equal(req.path, '/v1/chat/completions')
    assert.equal(req.method, 'POST')
    assert.equal(req.authorization, `Bearer ${apiKey}`)
    assert.equal(req.data.model, options.name)
    assert.equal(req.data.stream, false)
    assert.equal(req.data.thinking, undefined)
    assert.equal(req.data.response_format, undefined)
    assert.deepEqual(req.data.messages.map(message => message.role), ['system', 'user'])
    assert.doesNotMatch(JSON.stringify(req.data), /private-(?:account|group|binding|revision|agent|persona|connection)/u)
  }
  assert.equal(Object.hasOwn(received[0].data, 'max_tokens'), false)
  assert.equal(received[0].data.temperature, 0.1)
  assert.equal(received[1].data.max_tokens, 2000)
  assert.equal(received[1].data.temperature, 0.2)
  assert.match(received[0].data.messages[0].content, /拿不准时一律 engage=true/u)
  assert.match(received[1].data.messages[1].content, /这个群自己长出来的梗/u)
  assert.deepEqual(usage, Array.from({ length: 2 }, () => [options.name, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }]))
})

test('official GLM flash side tasks request content without spending the JSON budget on reasoning', async () => {
  const bodies = []
  const config = { ...options, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', name: 'glm-5.3-flash',
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body)
      bodies.push(body)
      return answer(bodies.length === 1 ? '{"engage":false,"reason":"普通闲聊"}' : JSON.stringify({ candidates: memeResult }))
    } }
  assert.deepEqual(await createAgentSimulationWakeGate(config)(input, undefined, context()), { engage: false, reason: '普通闲聊' })
  assert.deepEqual(JSON.parse(await createAgentSimulationMemeExtractor(config)(memes, undefined, context())), memeResult)
  assert.deepEqual(bodies.map(body => body.thinking), [{ type: 'disabled' }, { type: 'disabled' }])
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false)
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' })
  assert.deepEqual(bodies[1].response_format, { type: 'json_object' })
  assert.match(bodies[1].messages[1].content, /\{"candidates":\[\]\}/u)
  const empty = createAgentSimulationMemeExtractor({ ...config, fetchImpl: async () => answer('{"candidates":[]}') })
  assert.equal(await empty(memes, undefined, context()), '[]')
})

test('the standalone wake judge can report a verified upstream error while callers default to fail-open', async () => {
  const config = { ...options, fetchImpl: async () => new Response('private upstream detail', { status: 429 }) }
  assert.equal(await createAgentSimulationWakeGate(config)(input, undefined, context()), null)
  await assert.rejects(createAgentSimulationWakeGate({ ...config, throwOnFailure: true })(input, undefined, context()), error => {
    assert.equal(error.code, 'http_error')
    assert.equal(error.httpStatus, 429)
    assert.doesNotMatch(JSON.stringify(error), /private upstream detail/u)
    return true
  })
  const truncated = { ...options, fetchImpl: async () => answer(undefined, {
    choices: [{ finish_reason: 'length', message: { content: '{"engage":' } }],
  }) }
  assert.equal(await createAgentSimulationWakeGate(truncated)(input, undefined, context()), null)
  await assert.rejects(createAgentSimulationWakeGate({ ...truncated, throwOnFailure: true })(input, undefined, context()),
    { code: 'model_response_truncated' })
})

test('wake verdicts classify format and candidate failures without recording model text', async () => {
  const routing = { selfName: '机器人', triggerSeq: 19, reply: 'continuation', allowJoin: false,
    messages: [{ seq: 19, joinable: false }], previous: [{ sourceSeq: 7 }] }
  const selected = { ...input, routing }
  const judge = content => createAgentSimulationWakeGate({ ...options, throwOnFailure: true, fetchImpl: async () => answer(content) })
  for (const [raw, code, details] of [
    ['PRIVATE_INVALID_WAKE', 'wake_output_json_invalid', undefined],
    ['[]', 'wake_output_schema_invalid', { field: 'wake_output', cause: 'wake_output_object_required', expectedType: 'object', actualType: 'array' }],
    ['{"engage":"true"}', 'wake_output_schema_invalid', { field: 'engage', cause: 'wake_output_engage_invalid', expectedType: 'boolean', actualType: 'string' }],
    ['{"engage":false,"PRIVATE_EXTRA_FIELD":true}', 'wake_output_schema_invalid', { field: 'wake_output', cause: 'wake_output_fields_invalid' }],
    ['{"engage":true,"selection":{"mode":"reply","seq":19}}', 'wake_output_schema_invalid', { field: 'selection.previousSeq', cause: 'wake_selection_previous_required' }],
    ['{"engage":true,"selection":{"mode":"reply","seq":19,"previousSeq":8}}', 'wake_output_schema_invalid', { field: 'selection.previousSeq', cause: 'wake_selection_previous_invalid' }],
    ['{"engage":true,"selection":{"mode":"reply","seq":19},"previousSeq":8}', 'wake_output_schema_invalid', { field: 'selection.previousSeq', cause: 'wake_selection_previous_invalid' }],
    ['{"engage":true,"selection":{"mode":"reply","seq":19,"previousSeq":7},"previousSeq":8}', 'wake_output_schema_invalid', { field: 'selection.previousSeq', cause: 'wake_selection_previous_conflict' }],
    ['{"engage":false,"previousSeq":7}', 'wake_output_schema_invalid', { field: 'selection', cause: 'wake_output_silent_has_selection' }],
    ['{"engage":true,"selection":{"mode":"reply","seq":19,"previousSeq":7,"contextSeqs":[200]}}', 'wake_output_schema_invalid', { field: 'selection.contextSeqs', cause: 'wake_selection_context_invalid' }],
  ]) await assert.rejects(judge(raw)(selected, undefined, context()), error => {
    assert.equal(error.code, code)
    assert.deepEqual(agentErrorDetails(error), details)
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/u)
    return true
  })
  assert.deepEqual(await judge('{"engage":false,"selection":null}')(selected, undefined, context()), { engage: false })
  const reply = await judge('{"engage":true,"selection":{"mode":"reply","seq":19,"previousSeq":7,"contextSeqs":null}}')(selected, undefined, context())
  assert.deepEqual(reply, { engage: true, selection: { mode: 'reply', seq: 19, previousSeq: 7 } })
  const flattened = judge('{"engage":true,"selection":{"mode":"reply","seq":19},"previousSeq":7}')
  assert.deepEqual(await flattened(selected, undefined, context()), reply)
  await assert.rejects(flattened({ ...selected, routing: { ...routing, reply: 'addressed' } }, undefined, context()),
    error => agentErrorDetails(error)?.cause === 'wake_selection_previous_invalid')
})

test('meme provider failures carry only a fixed label and optional HTTP status', async () => {
  for (const [fetchImpl, code, status] of [
    [async () => new Response(`PRIVATE ${apiKey}`, { status: 503 }), 'http_error', 503],
    [async () => { throw Error(`PRIVATE ${apiKey}`) }, 'provider_transport_error', undefined],
    [async () => new Response('invalid HTTP body'), 'model_response_body_invalid', undefined],
    [async () => answer(null), 'model_response_envelope_invalid', undefined],
    [async () => answer('bad result'), 'meme_output_json_invalid', undefined],
    [async () => answer(JSON.stringify([{ ...memeResult[0], source_id: '99' }])), 'meme_output_schema_invalid', undefined],
    [async () => answer('[]', { metadata: { credential: apiKey } }), 'model_response_blocked', undefined],
  ]) {
    const extract = createAgentSimulationMemeExtractor({ ...options, fetchImpl })
    await assert.rejects(extract(memes, undefined, context()), error => {
      assert.equal(error.message, FAILURE)
      assert.equal(error.code, code)
      assert.equal(error.httpStatus, status)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(apiKey))
      return true
    })
  }
})

test('failed source checks after the model responds remain separate from malformed output', async () => {
  let responded = false
  const extract = createAgentSimulationMemeExtractor({ ...options, fetchImpl: async () => {
    responded = true
    return answer('[]')
  } })
  await assert.rejects(extract(memes, undefined, context({ async ensureCurrent() {
    if (responded) throw new Error('private read error')
  } })), error => error.code === 'model_source_check_failed' && error.cause === undefined)
})

test('missing binding or mismatched target prevents every provider request', async () => {
  let calls = 0
  const config = { ...options, fetchImpl: async () => { calls++; return answer('[]') } }
  const wake = createAgentSimulationWakeGate(config), meme = createAgentSimulationMemeExtractor(config)
  for (const ctx of [undefined, context({ binding: undefined }), context({ target: { ...target, id: 'different-group' } })]) {
    assert.equal(await wake(input, undefined, ctx), null)
    await rejected(meme(memes, undefined, ctx))
  }
  assert.equal(calls, 0)
})

test('cancellation ends ignored fetch waits and observes late rejected provider promises', async () => {
  for (const kind of ['wake', 'meme']) {
    const controller = new AbortController()
    let started, rejectFetch, observedSignal
    const ready = new Promise(resolve => { started = resolve })
    const config = { ...options, fetchImpl: async (_url, init) => {
      observedSignal = init.signal; started()
      return await new Promise((_resolve, reject) => { rejectFetch = reject })
    } }
    const run = kind === 'wake' ? createAgentSimulationWakeGate(config) : createAgentSimulationMemeExtractor(config)
    const pending = run(kind === 'wake' ? input : memes, undefined, context({ signal: controller.signal }))
    await ready
    controller.abort()
    if (kind === 'wake') assert.equal(await pending, null)
    else await rejected(pending)
    assert.equal(observedSignal.aborted, true)
    rejectFetch(new Error(`late private provider detail ${apiKey}`))
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('complete input and response secrets and malformed model output cannot grant verdicts or candidates', async () => {
  let calls = 0
  const config = { ...options, fetchImpl: async () => { calls++; return answer('[]') } }
  assert.equal(await createAgentSimulationWakeGate(config)({ ...input, hidden: apiKey }, undefined, context()), null)
  await rejected(createAgentSimulationMemeExtractor(config)([...memes, { name: '普通名字', text: '普通内容', hidden: apiKey }], undefined, context()))
  assert.equal(calls, 0)
  const wake = content => createAgentSimulationWakeGate({ ...options, fetchImpl: async () => answer(content) })(input, undefined, context())
  const meme = content => createAgentSimulationMemeExtractor({ ...options, fetchImpl: async () => answer(content) })(memes, undefined, context())
  assert.equal(await wake('{"engage":"false"}'), null)
  assert.equal(await wake(JSON.stringify({ engage: false, reason: apiKey })), null)
  await rejected(meme('not a JSON array'))
  await rejected(meme(JSON.stringify([{ ...memeResult[0], source_id: '99' }])))
  await rejected(meme(JSON.stringify([{ ...memeResult[0], note: apiKey }])))
  assert.equal(await createAgentSimulationWakeGate({ ...options, fetchImpl: async () => answer('{"engage":false}', { extra: { credential: apiKey } }) })(input, undefined, context()), null)
  await rejected(createAgentSimulationMemeExtractor({ ...options, fetchImpl: async () => { throw new Error(`provider failure ${apiKey}`) } })(memes, undefined, context()))
})
