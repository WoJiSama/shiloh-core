import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
import { hostSimulationModel } from './helpers/simulationHostSender.mjs'

const config = {
  providers: 'oneapi',
  chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatApiModel: 'chat', chatApiKey: 'fixture-chat' },
  toolsAiConfig: { toolsAiUrl: 'https://tools.invalid/v1', toolsAiModel: 'tools', toolsAiApikey: 'fixture-tools' },
  trackAiConfig: { trackAiUrl: 'https://track.invalid/v1', trackAiModel: 'track', trackAiApikey: 'fixture-track' },
  searchAiConfig: { searchApiUrl: 'https://search.invalid/v1', searchApiModel: 'search', searchApiKey: 'fixture-search' },
}
const request = { messages: [{ role: 'user', content: 'authorized private conversation context' }] }
const toolRequest = { ...request, tools: [{ type: 'function', function: { name: 'fixtureTool', parameters: { type: 'object' } } }], tool_choice: 'auto' }
const completion = (content = 'authorized answer') => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
const rejected = result => {
  assert.equal(result.choices, undefined)
  assert.ok(typeof result.error === 'string' && result.error.length > 0)
}

function executor(fetch, overrides = {}) {
  return createModelExecutor({
    fetch, logger: { info() {}, warn() {}, error() {} },
    resolveChatCompletionUrl: url => `${url}/chat/completions`,
    removeToolPromptsFromMessages: messages => messages,
    summarizeToolResultForAgent: () => '', shouldAcceptPlannerTextResponse: () => false,
    resolveAgentBackend: current => ({ apiUrl: current.chatAiConfig.chatApiUrl, model: current.chatAiConfig.chatApiModel, apiKey: current.chatAiConfig.chatApiKey }),
    ...overrides,
  })
}

async function bounded(work, description) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), 1000) })])
  } finally { clearTimeout(timer) }
}

test('every actual HTTP request including a 400 compatibility retry waits for a fresh asynchronous authority check', async () => {
  let granted = 0
  const calls = []
  const { YTapi } = executor(async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body), granted })
    return calls.length === 1 ? new Response('unsupported max_tokens', { status: 400 }) : completion()
  })
  const result = await YTapi(request, config, undefined, undefined, {
    isCurrent: () => true,
    async ensureCurrent() { await delay(0); granted++ },
    generation: { maxOutputTokens: 30 },
  })
  assert.equal(result.choices[0].message.content, 'authorized answer')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].granted > 0)
  assert.ok(calls[1].granted > calls[0].granted)
  assert.equal(calls[0].url, calls[1].url)
  assert.deepEqual(calls[0].payload.messages, calls[1].payload.messages)
  assert.equal(calls[0].payload.max_tokens, 30)
  assert.equal(calls[1].payload.max_tokens, undefined)
})

test('revocation after the first 400 response prevents compatibility retry and every backend fallback', async () => {
  let allowed = true, checks = 0
  const calls = []
  const { YTapi } = executor(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    allowed = false
    return new Response('unsupported reasoning_effort', { status: 400 })
  })
  const result = await YTapi(request, config, undefined, undefined, {
    isCurrent: () => true,
    async ensureCurrent() { checks++; await delay(0); if (!allowed) throw new Error('group membership revoked') },
    generation: { reasoningEffort: 'low' },
  })
  rejected(result)
  assert.equal(calls.length, 1)
  assert.ok(checks >= 2)
})

test('an initial asynchronous authorization denial dispatches no HTTP request for either text or tools', async () => {
  for (const tools of [false, true]) {
    let calls = 0
    const { YTapi } = executor(async () => { calls++; return completion() })
    const result = await YTapi(tools ? toolRequest : request, { ...config, useTools: tools }, undefined, undefined, {
      isCurrent: () => true,
      async ensureCurrent() { await delay(0); throw new Error('initial source authorization denied') },
    })
    rejected(result)
    assert.equal(calls, 0)
  }
})

test('caller cancellation interrupts a pending initial authority check without HTTP dispatch or fallback', { timeout: 3000 }, async () => {
  const controller = new AbortController(), entered = Promise.withResolvers()
  const reason = new Error('cancel pending source authorization')
  let calls = 0
  const { YTapi } = executor(async () => { calls++; return completion() })
  const result = YTapi(toolRequest, { ...config, useTools: true }, undefined, undefined, {
    signal: controller.signal, isCurrent: () => true,
    async ensureCurrent() { entered.resolve(); await new Promise(() => {}) },
  }).then(value => ({ value }), error => ({ error }))
  await bounded(entered.promise, 'initial authority check')
  controller.abort(reason)
  const outcome = await bounded(result, 'canceled initial authority check')
  assert.equal(outcome.error, reason)
  assert.equal(outcome.value, undefined)
  assert.equal(calls, 0)
})

test('caller cancellation interrupts a pending compatibility authority check without a second HTTP request', { timeout: 3000 }, async () => {
  const controller = new AbortController(), entered = Promise.withResolvers()
  const reason = new Error('cancel pending compatibility authorization')
  let calls = 0
  const { YTapi } = executor(async () => { calls++; return new Response('unsupported max_tokens', { status: 400 }) })
  const result = YTapi(request, config, undefined, undefined, {
    signal: controller.signal, isCurrent: () => true, generation: { maxOutputTokens: 30 },
    async ensureCurrent() { if (calls > 0) { entered.resolve(); await new Promise(() => {}) } },
  }).then(value => ({ value }), error => ({ error }))
  await bounded(entered.promise, 'compatibility authority check')
  controller.abort(reason)
  const outcome = await bounded(result, 'canceled compatibility authority check')
  assert.equal(outcome.error, reason)
  assert.equal(outcome.value, undefined)
  assert.equal(calls, 1)
})

for (const route of ['tools', 'text', 'empty-planner']) {
  test(`${route} fallback retains the asynchronous authority check on the next actual HTTP dispatch`, async () => {
    let granted = 0
    const calls = []
    const { YTapi } = executor(async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body), granted })
      if (calls.length > 1) return completion()
      return route === 'empty-planner' ? completion('') : new Response('upstream busy', { status: 503 })
    })
    const result = await YTapi(route === 'text' ? request : toolRequest, { ...config, useTools: route !== 'text' }, undefined, undefined, {
      isCurrent: () => true, async ensureCurrent() { await delay(0); granted++ },
    })
    assert.equal(result.choices[0].message.content, 'authorized answer')
    assert.equal(calls.length, 2)
    assert.ok(calls[0].granted > 0)
    assert.ok(calls[1].granted > calls[0].granted)
    assert.notEqual(calls[1].url, calls[0].url)
    assert.ok(calls[1].payload.messages.some(message => message.content === request.messages[0].content))
  })
}

for (const route of ['tools', 'text']) {
  test(`${route} fallback latches a single authority denial instead of trying another candidate after the guard recovers`, async () => {
    const calls = []
    let denied = false
    const { YTapi } = executor(async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body) })
      return new Response('upstream busy', { status: 503 })
    })
    const result = await YTapi(route === 'tools' ? toolRequest : request, { ...config, useTools: route === 'tools' }, undefined, undefined, {
      isCurrent: () => true,
      async ensureCurrent() {
        await delay(0)
        if (calls.length > 0 && !denied) { denied = true; throw new Error('transient authority denial') }
      },
    })
    rejected(result)
    assert.equal(denied, true)
    assert.equal(calls.length, 1)
  })
}

test('a late successful authority result cannot dispatch after caller cancellation', { timeout: 3000 }, async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), grant = Promise.withResolvers()
  const reason = new Error('stop before a late grant')
  let calls = 0
  const { YTapi } = executor(async () => { calls++; return completion() })
  const result = YTapi(request, config, undefined, undefined, {
    signal: controller.signal, isCurrent: () => true,
    async ensureCurrent() { entered.resolve(); await grant.promise },
  }).then(value => ({ value }), error => ({ error }))
  await bounded(entered.promise, 'late-grant authority check')
  controller.abort(reason)
  const outcome = await bounded(result, 'late-grant cancellation')
  assert.equal(outcome.error, reason)
  grant.resolve()
  await delay(0)
  assert.equal(calls, 0)
})

test('actual legacy Simulation model wrappers preserve the fifth authority callback through compatibility dispatch and denial', async () => {
  for (const property of ['YTapi', 'reviewCharacter', 'reflectCharacter', 'judgeSocialPermission']) for (const denyRetry of [false, true]) {
    let allowed = true, granted = 0, checks = 0
    const calls = []
    const controller = new AbortController()
    const { YTapi } = executor(async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body), granted })
      assert.equal(init.signal, controller.signal)
      if (calls.length === 1) {
        allowed = !denyRetry
        return new Response('unsupported max_tokens', { status: 400 })
      }
      return completion()
    })
    let routeCalls = 0
    const model = hostSimulationModel(YTapi, { property, resolveCharacterConsistencyRoute: current => {
      routeCalls++
      return { config: current, taskBackend: 'memory' }
    } })
    const modelConfig = { ...config, taskAiConfig: { memory: {
      apiUrl: 'https://memory.invalid/v1', model: 'memory', apiKey: 'fixture-memory',
    } } }
    const result = await model({ ...request, max_tokens: 30 }, modelConfig, controller.signal, () => true, async () => {
      checks++
      await delay(0)
      if (!allowed) throw new Error('host source authorization revoked')
      granted++
    })
    assert.equal(routeCalls, property === 'reviewCharacter' ? 1 : 0)
    assert.ok(checks >= 2, `${property} must revalidate each actual request`)
    assert.ok(calls[0].granted > 0, `${property} dispatched before async authorization`)
    if (denyRetry) {
      rejected(result)
      assert.equal(calls.length, 1)
    } else {
      assert.equal(result.choices[0].message.content, 'authorized answer')
      assert.equal(calls.length, 2)
      assert.ok(calls[1].granted > calls[0].granted)
    }
  }
})
