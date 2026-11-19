import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createAgentSimulationWakeGate, createAgentSimulationMemeExtractor } = await importBilibiliHost('modules/simulation/infrastructure/agentSimulationModels.js')
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

test('wake and meme providers use real local JSON HTTP with fixed model budgets and scoped usage', async t => {
  const received = [], usage = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    received.push({ path: req.url, method: req.method, authorization: req.headers.authorization, data })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: data.max_tokens === 64 ? '```json\n{"engage":false,"reason":"群友闲聊"}\n```' : JSON.stringify(memeResult) } }],
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
    assert.deepEqual(req.data.messages.map(message => message.role), ['system', 'user'])
    assert.doesNotMatch(JSON.stringify(req.data), /private-(?:account|group|binding|revision|agent|persona|connection)/u)
  }
  assert.equal(received[0].data.max_tokens, 64)
  assert.equal(received[0].data.temperature, 0.1)
  assert.equal(received[1].data.max_tokens, 2000)
  assert.equal(received[1].data.temperature, 0.2)
  assert.match(received[0].data.messages[0].content, /拿不准时一律 engage=true/u)
  assert.match(received[1].data.messages[1].content, /这个群自己长出来的梗/u)
  assert.deepEqual(usage, Array.from({ length: 2 }, () => [options.name, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }]))
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
