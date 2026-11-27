import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createAgentRuntime }, { createAgentBindingDirectory, conversationAddressKey, platformAccountKey },
  { createAgentWebTools }, { createAgentFileTextTool }, { createAgentTools }, { readStandaloneAgentConfig }] = await Promise.all([
  load('core/agentRuntime.js'), load('modules/runtime/domain/agentBindings.js'), load('modules/tools/infrastructure/agentWebTools.js'),
  load('modules/content/infrastructure/agentFileTextTool.js'), load('modules/tools/infrastructure/agentTools.js'), load('bootstrap/standaloneAgentConfig.js'),
])
const account = { platform: 'qq', namespace: 'global', id: '19006701' }, actor = { ...account, id: '17006701' }
const group = { account, kind: 'group', id: '31006701' }, friend = { account, kind: 'private', id: 'opaque-friend-session' }
const RESULT = 'TURN_ONLY_REGISTRY_RESULT', DERIVED = 'TURN_ONLY_DERIVED_REPLY'
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }
const settings = { skip: !redisAvailable, timeout: 20_000 }
const call = (name, args = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const answer = content => ({ choices: [{ message: { content } }] })
const tool = (name, execute, extra = {}) => ({ name, description: '受本轮授权的测试工具', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute, ...extra })
const fileTool = () => createAgentFileTextTool({ service: { async extract(input, context) {
  await context.ensureCurrent(); const text = Buffer.from(input.bytes).toString('utf8')
  return { text, offset: 0, totalChars: Array.from(text).length }
} } })
async function waitFor(probe, label) {
  const until = performance.now() + 7000
  while (performance.now() < until) { if (await probe()) return; await delay(10) }
  assert.fail(label)
}
async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'text-registry-tools'), sources = new Map(), deliveries = [], uploads = [], requests = [], executions = []
  const key = (target, id) => `${conversationAddressKey(target)}:${id}`
  let now = Date.now(), serial = 0, ready = false, receive, peer = actor, live = true, revision = 1, host
  const directory = () => createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [group, friend].map(target => ({ connectionId: 'qq', kind: target.kind, conversationId: target.id, agentId: 'daily' })),
  }, `registry-${revision}`)
  let bindings = directory()
  const state = { registry: options.registry ?? { builtIn: [] }, names: options.names ?? ['webParserTool'], policy: options.policy ?? { mode: 'open' }, extraTools: [] }
  const adapter = { id: 'qq', account, botUserId: account.id, resolvePrivatePeer: () => peer,
    isReady: () => ready, start(accept) { receive = accept; ready = true }, stop() { ready = false },
    async readMessage(target, id, guard) { await options.read?.(target, id, f); return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(key(target, id))) },
    async readMessageFile(target, id, index, guard) {
      const original = sources.get(key(target, id)); await guard.ensureCurrent?.()
      if (!original || !guard.isCurrent() || !await guard.allowsSource(original)) return undefined
      await options.fileRead?.(f)
      return { name: '资料.txt', mime: 'text/plain', base64: Buffer.from(RESULT).toString('base64'), origin: 'current' }
    },
    actions: {
      async send(action, guard) { await guard?.ensureCurrent?.(); if (!guard?.isCurrent?.()) return { state: 'failed', code: 'stale' }
        deliveries.push(structuredClone(action)); return options.delivery?.(action, guard, f) ?? { state: 'sent', messageId: 'sent-' + ++serial } },
      async sendFile(action, guard) { await options.beforeFileDispatch?.(action, guard, f); await guard.ensureCurrent?.(); if (!guard.isCurrent() || guard.signal.aborted) return { state: 'failed', code: 'stale' }
        uploads.push(structuredClone(action)); return options.fileDelivery ?? { state: 'uploaded', fileId: 'uploaded-1' } },
    },
  }
  const makeHost = () => createAgentRuntime({ storage: redis.storage, adapters: [adapter], now: () => now,
    logger: { info() {}, warn() {}, error() {} }, isExecutionCurrent: () => live && redis.isCurrent(),
    privateChatEnabled: true, privateTextTools: state.names, groupTextTools: () => state.names, useTextGroup: target => target.kind === 'group',
    toolRegistry: state.registry, featureSwitches: options.featureSwitches, memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: true },
    semanticMemory: { enabled: false }, groupMemory: { enabled: false }, groupLog: { enabled: false },
    getSection: () => ({ enabled: true, allGroups: true, toolPolicy: state.policy, extraTools: state.extraTools,
      reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false },
      meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
    getExecutionConfig: () => ({ useTools: true }), allowsToolInput: value => !value.includes('HOST_ONLY_SECRET'),
    resolvePersona(target) { const binding = bindings.resolve(target); return binding && { binding, persona: { name: '工具角色' }, systemContent: '测试角色' } },
    async YTapi(request, _config, signal, current, ensureCurrent) {
      await ensureCurrent?.(); assert.equal(signal?.aborted, false); assert.equal(current?.(), true)
      requests.push(structuredClone(request)); return options.model ? options.model(request, f) : request.messages.some(message => message.role === 'tool') ? answer(DERIVED) : call(state.names[0])
    },
  })
  const f = { ...redis, state, sources, deliveries, uploads, requests, executions, key,
    get host() { return host }, get now() { return now },
    binding: target => bindings.resolve(target), rebind() { revision++; bindings = directory() }, setPeer(value) { peer = value },
    message(target = group, extra = {}) { return { version: 1, conversation: target, sender: actor, messageId: 'source-' + ++serial,
      occurredAt: ++now, text: '请处理本轮明确请求', parts: [{ kind: 'text', text: '请处理本轮明确请求' }], mentions: [], directedToAccount: true, ...extra } },
    async emit(message) { sources.set(key(message.conversation, message.messageId), structuredClone(message)); await receive({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(key(message.conversation, message.messageId)); await receive({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained(target = group) { await waitFor(async () => Number(await redis.reader.lLen(redis.prefix + `agent:inbox:${target.kind === 'private' ? 'private' : 'group-text'}:${platformAccountKey(account)}`)) === 0, 'registry inbox did not settle'); await host.runtime.drain() },
    async send(target = group, extra) { const message = f.message(target, extra); await f.emit(message); await f.drained(target); return message },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async raw() { const out = []; for (const name of await redis.reader.keys(redis.prefix + '*')) if (await redis.reader.type(name) === 'string') out.push(await redis.reader.get(name)); return out.join('\n') },
    async stop() { live = false; await host.stop() },
  }
  host = makeHost(); await host.start(); t.after(async () => { await host.stop() })
  return f
}

test('ordinary group and stable friend text use the same real web tool as the simulation bridge', settings, async t => {
  const network = [], registry = createAgentWebTools({ web: { enabled: true }, publicWeb: {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }], async request(url) { network.push(String(url)); return {
      status: 200, headers: { 'content-type': 'text/html' }, body: `<html><title>公开资料</title><body><p>${RESULT}</p></body></html>`,
    } } }, now: () => 1000 })
  const f = await fixture(t, { registry, model: request => request.messages.some(row => row.role === 'tool') ? answer(DERIVED) : call('webParserTool', { url: 'https://public.example/article' }) })
  for (const target of [group, friend]) {
    await f.send(target)
    const request = f.requests.at(-1); assert.match(JSON.stringify(request.messages), new RegExp(RESULT))
    assert.deepEqual(f.deliveries.at(-1).target, target)
  }
  const scope = { binding: f.binding(group), actor: { kind: 'user', user: actor }, signal: new AbortController().signal, isCurrent: () => true }
  const simulation = createAgentTools(registry, { signal: scope.signal, context: () => scope })
  const result = await simulation.getExtraTools(['webParserTool'])[0].execute({ url: 'https://public.example/article' }, {})
  assert.equal(result.status, 'success'); assert.match(result.content, new RegExp(RESULT)); assert.equal(network.length, 3)
  const raw = await f.raw(); assert.ok(!raw.includes(RESULT)); assert.ok(!raw.includes(DERIVED))
})

test('registry tools need text authorization, obey global/group deny and custom explicit grants', settings, async t => {
  let calls = 0
  const builtIn = tool('webParserTool', async () => { calls++; return { status: 'succeeded', content: RESULT } })
  const custom = tool('mcp_custom', async () => { calls++; return { status: 'succeeded', content: RESULT } })
  const cases = [
    { registry: { builtIn: [builtIn] }, names: [] },
    { registry: { builtIn: [builtIn] }, policy: { mode: 'open', denyTools: ['webParserTool'] } },
    { registry: { builtIn: [builtIn] }, policy: { mode: 'open', groups: { [group.id]: ['webParserTool'] } } },
    { registry: { custom: [custom] }, names: ['mcp_custom'] },
  ]
  for (const options of cases) {
    const f = await fixture(t, { ...options, model: () => answer('本轮没有开放通用工具') }); await f.send()
    assert.equal(f.requests[0].tools?.some(row => row.function.name === (options.names?.[0] ?? 'webParserTool')) ?? false, false)
  }
  assert.equal(calls, 0)
  const f = await fixture(t, { registry: { custom: [custom] }, names: ['mcp_custom'], policy: { mode: 'open', allowTools: ['mcp_custom'] } })
  await f.send(friend); assert.equal(calls, 1); assert.match(JSON.stringify(f.requests.at(-1).messages), new RegExp(RESULT))
})

test('text registry tool enabled for one group rejects a forged call in private chat', settings, async t => {
  const executions = [], builtIn = tool('webParserTool', async (_input, context) => {
    executions.push(context.binding.target)
    return { status: 'succeeded', content: RESULT }
  })
  const f = await fixture(t, { registry: { builtIn: [builtIn] },
    featureSwitches: { tools: { webParserTool: { mode: 'groups', groups: [group.id] } } } })
  await f.send(group)
  assert.deepEqual(executions, [group])
  await f.send(friend)
  assert.equal(f.requests.at(-1).tools?.some(row => row.function.name === 'webParserTool') ?? false, false)
  assert.deepEqual(executions, [group])
})

test('schema and host-secret validation reject model-selected target or raw secret before execution', settings, async t => {
  let calls = 0
  for (const args of [{ target: 'other-room' }, { query: 'HOST_ONLY_SECRET' }]) {
    const definition = tool('webParserTool', async () => { calls++; return { status: 'succeeded', content: RESULT } })
    const f = await fixture(t, { registry: { builtIn: [definition] }, model: request => request.tools?.some(row => row.function.name === 'webParserTool') ? call('webParserTool', args) : answer('参数不可用') })
    await f.send(friend)
  }
  assert.equal(calls, 0)
})

test('image and file deliveries retain full target, account, Agent and peer and end without another reply', settings, async t => {
  for (const kind of ['image', 'file']) {
    const seen = [], definition = tool(kind === 'image' ? 'textImageTool' : 'excelWorkbookTool', async (_input, context) => {
      seen.push(context); const receipt = kind === 'image' ? await context.sendImage(image) : await context.sendFile({ name: '结果.txt', mime: 'text/plain', base64: Buffer.from('结果').toString('base64') })
      return { status: ['sent', 'uploaded'].includes(receipt.state) ? 'succeeded' : receipt.state === 'failed' ? 'failed' : 'unknown', content: '已发送' }
    })
    const f = await fixture(t, { names: [definition.name], registry: { builtIn: [definition] } })
    for (const target of [group, friend]) {
      const message = await f.send(target), context = seen.at(-1)
      assert.deepEqual(context.binding.target, target); assert.equal(context.binding.agentId, 'daily'); assert.deepEqual(context.actor.user, actor)
      assert.equal(context.request.occurredAt, message.occurredAt); assert.deepEqual(context.privatePeer, target.kind === 'private' ? actor : undefined)
      assert.equal(context.interact, undefined); assert.equal(context.runQqAction, undefined)
    }
    assert.equal(f.requests.length, 2); assert.equal(f.deliveries.length, kind === 'image' ? 2 : 0); assert.equal(f.uploads.length, kind === 'file' ? 2 : 0)
  }
})

test('unknown delivery and restart never repeat the tool or add a confirmation', settings, async t => {
  let calls = 0
  const definition = tool('textImageTool', async (_input, context) => { calls++; await context.sendImage(image); return { status: 'succeeded', content: '不得成为成功' } })
  const f = await fixture(t, { names: [definition.name], registry: { builtIn: [definition] }, delivery: () => ({ state: 'unknown' }) })
  const message = await f.send(); assert.equal(calls, 1); assert.equal(f.deliveries.length, 1); assert.equal(f.requests.length, 1)
  await f.restart(); await f.emit(message); await f.drained(); assert.equal(calls, 1); assert.equal(f.deliveries.length, 1); assert.equal(f.requests.length, 1)
})

test('queued file delivery rechecks the original request immediately before dispatch', settings, async t => {
  const definition = tool('excelWorkbookTool', async (_input, context) => { await context.sendFile({ name: '结果.txt', mime: 'text/plain', base64: Buffer.from('结果').toString('base64') }); return { status: 'succeeded', content: '已发送' } })
  const f = await fixture(t, { names: [definition.name], registry: { builtIn: [definition] }, beforeFileDispatch(_action, guard, f) {
    assert.equal(typeof guard.ensureCurrent, 'function')
    for (const message of f.sources.values()) message.text = '排队期间来源已经改变'
  } })
  await f.send(); assert.equal(f.uploads.length, 0); assert.equal(f.deliveries.length, 0); assert.equal(f.requests.length, 1)
})

test('source changes and dynamic definition removal suppress tool continuations and late sends', settings, async t => {
  for (const change of ['source', 'definition', 'rebind', 'peer', 'deny']) {
    let entered, release, context
    const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const definition = tool('webParserTool', async (_input, scope) => { context = scope; entered(); await gate; return { status: 'succeeded', content: RESULT } })
    const registry = { builtIn: [definition] }, f = await fixture(t, { registry })
    const target = change === 'peer' ? friend : group, message = f.message(target); await f.emit(message); await started
    if (change === 'source') f.sources.get(f.key(target, message.messageId)).text = '替换后的来源'
    if (change === 'definition') registry.builtIn = []
    if (change === 'rebind') f.rebind()
    if (change === 'peer') f.setPeer({ ...actor, id: '17006702' })
    if (change === 'deny') f.state.policy = { mode: 'open', denyTools: [definition.name] }
    release(); await f.drained(target); assert.equal(f.deliveries.length, 0); assert.equal(f.requests.length, 1)
    assert.equal(context.isCurrent(), false)
    await assert.rejects(() => context.sendImage(image))
  }
})

test('recall and stop abort in-flight tools and discard their late results', settings, async t => {
  for (const mode of ['recall', 'stop']) {
    let entered, release, context
    const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
    const definition = tool('webParserTool', async (_input, scope) => { context = scope; entered(); await gate; return { status: 'succeeded', content: RESULT } })
    const f = await fixture(t, { registry: { builtIn: [definition] } }), message = f.message(); await f.emit(message); await started
    if (mode === 'recall') await f.recall(message); else await f.stop()
    await waitFor(() => context.signal.aborted, 'in-flight registry tool did not cancel'); release()
    if (mode === 'recall') await f.drained()
    assert.equal(f.deliveries.length, 0); assert.equal(f.requests.length, 1)
  }
})

test('ephemeral file tool reads the current fixed source for groups and friends and never persists result text', settings, async t => {
  const definition = fileTool(), f = await fixture(t, { registry: { builtIn: [definition] }, names: [definition.name] })
  for (const target of [group, friend]) {
    await f.send(target, { parts: [{ kind: 'text', text: '读附件' }, { kind: 'file', name: '资料.txt', resource: { kind: 'reference', value: 'opaque-file' } }] })
    assert.match(JSON.stringify(f.requests.at(-1).messages), new RegExp(RESULT)); assert.equal(f.deliveries.at(-1).parts[0].text, DERIVED)
  }
  const raw = await f.raw(); assert.ok(!raw.includes(RESULT)); assert.ok(!raw.includes(DERIVED)); assert.ok(!raw.includes(Buffer.from(RESULT).toString('base64')))
})

test('file projections survive the tool and revoke an in-flight derived model response', settings, async t => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const definition = fileTool(), f = await fixture(t, { registry: { builtIn: [definition] }, names: [definition.name],
    async model(request) { if (!request.messages.some(row => row.role === 'tool')) return call('fileTextTool'); entered(); await gate; return answer(DERIVED) },
  })
  const message = f.message(group, { parts: [{ kind: 'file', name: '资料.txt' }] }); await f.emit(message); await started
  f.sources.get(f.key(group, message.messageId)).parts = [{ kind: 'file', name: '被换掉的文件.txt' }]
  release(); await f.drained(); assert.equal(f.deliveries.length, 0); assert.equal(f.requests.length, 2)
})

test('standalone text grants accept only supported neutral tools or MCP aliases and keep unknown names rejected', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'text-registry-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'qq', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'qq', kind: 'group', conversationId: group.id, agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml'), read = async names => {
    await writeFile(file, JSON.stringify({ version: 1, instance: 'text-registry-config', dataDir: 'data',
      model: { baseUrl: 'https://model.example/v1', name: 'fixture', apiKeyEnv: 'MODEL_KEY' }, connections: [{ id: 'qq', url: 'ws://127.0.0.1:3001' }],
      privateChat: { enabled: true, allowTools: names }, textGroups: [{ connectionId: 'qq', conversationId: group.id, tools: names }],
    })); return readStandaloneAgentConfig(file, { MODEL_KEY: 'fixture-private-key' })
  }
  const names = ['webParserTool', 'fileTextTool', 'textImageTool', 'mcp_documents'], config = await read(names)
  assert.deepEqual(config.privateTextTools, names); assert.deepEqual(config.groupTextTools(group), names)
  for (const unknown of ['madeUpTool', 'mcp_', 'mcp_unsafe.space']) await assert.rejects(() => read([unknown]))
})
