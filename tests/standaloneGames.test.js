import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createStandaloneGroupGames, createStandaloneTurtleSoupModel } = await load('bootstrap/standaloneGames.js')
const { readStandaloneGamesConfig } = await load('bootstrap/standaloneGamesConfig.js')
const { agentTurtleSoupDirectory } = await load('modules/games/infrastructure/agentTurtleSoup.js')
const { agentUmaRaceDataDir } = await load('modules/games/infrastructure/agentUmaRace.js')
const { TurtleSoupStore } = await load('modules/games/infrastructure/turtleSoup/TurtleSoupStore.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const response = (content = '是') => ({ model: 'actual-game-model', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, choices: [{ message: { content } }] })

function fixture(t, raw = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-games-')), execution = new AbortController()
  const account = { platform: 'qq', namespace: 'global', id: '300001' }, target = { account, kind: 'group', id: '900001' }
  const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'r1', agentId: 'daily', personaId: 'default', connectionId: 'qq-main', target }
  const calls = [], tokens = [], sent = [], handlers = [], controllers = [], contexts = new Map()
  let hostCurrent = true, sequence = 0, ensureCount = 0, model = async () => response(), onSend
  const options = { config: readStandaloneGamesConfig(raw, { dataDir }), dataDir,
    execution: { providers: 'oneapi', useTools: true, chatAiConfig: { chatApiUrl: 'https://fixed-model.example/v1', chatApiModel: 'main-model', chatApiKey: 'HOST_SECRET', chatReasoningEffort: 'low' },
      toolsAiConfig: { toolsApiUrl: 'https://must-not-be-selected.example', toolsApiModel: 'tools-model', toolsApiKey: 'OTHER_SECRET' } },
    executionSignal: execution.signal, isCurrent: () => hostCurrent,
    allowsText: text => !['HOST_SECRET', 'OTHER_SECRET', 'forbidden-fixture'].some(word => text.includes(word)),
    execute: async (request, config, executionOptions) => { calls.push({ request, config, executionOptions }); return model(request, config, executionOptions) },
    recordTokens: input => tokens.push(input),
    authorizeBackground: async origin => contexts.get(origin.source.messageId),
  }
  const context = (text = '他看不见吗？', changes = {}) => {
    const selected = changes.binding ?? binding, controller = new AbortController(); controllers.push(controller)
    let current = true
    const user = changes.user ?? '10001', source = { version: 1, conversation: structuredClone(selected.target), sender: { platform: selected.target.account.platform, namespace: selected.target.account.namespace, id: user },
      senderName: 'fixture', messageId: 'game-' + (++sequence), occurredAt: 1800000000000 + sequence, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false }
    const value = { source, binding: structuredClone(selected), member: { id: user, name: 'fixture', role: changes.role ?? 'member' }, signal: controller.signal,
      isCurrent: () => current,
      ensureCurrent: async () => { ensureCount++; if (!current || controller.signal.aborted) throw Error('source revoked') },
      sendText: async (text, guard) => { await onSend?.(text, guard); await guard?.ensureCurrent(); await value.ensureCurrent(); sent.push({ text, kind: 'text', source: source.messageId }) },
      sendImage: async () => assert.fail('standalone games use the existing text fallback without an injected renderer'),
      sendPrivate: async () => assert.fail('this fixture does not reveal private answers'),
      revoke: () => { current = false }, abort: () => controller.abort('SECRET provider abort detail'),
    }
    contexts.set(source.messageId, value)
    return value
  }
  const create = () => { const selected = createStandaloneGroupGames(options); handlers.push(...selected); return selected }
  t.after(async () => { for (const handler of handlers) await handler.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { options, dataDir, binding, context, calls, tokens, sent, create, execution, controllers,
    setModel: value => { model = value }, setCurrent: value => { hostCurrent = value }, setOnSend: value => { onSend = value },
    get ensureCount() { return ensureCount },
  }
}

test('standalone games default to absent and use the host games root only when explicitly enabled', async t => {
  const f = fixture(t)
  assert.deepEqual(f.create(), [])
  assert.equal(fs.existsSync(path.join(f.dataDir, 'games')), false)
  assert.equal(f.calls.length, 0)
  assert.throws(() => createStandaloneGroupGames({ ...f.options, dataDir: '../games' }), /绝对/u)
  const both = fixture(t, { turtleSoup: { enabled: true }, umaRace: { enabled: true } })
  const handlers = both.create()
  assert.deepEqual(handlers.map(item => item.id), ['turtle-soup', 'uma-race'])
  for (const [index, text] of ['.游戏 海龟汤 帮助', '.赛马娘 帮助'].entries()) {
    const context = both.context(text)
    assert.equal(handlers[index].isCandidate(context.source, context.binding), true)
    assert.equal(await handlers[index].handle(context), true)
  }
  assert.equal(both.calls.length, 0)
  assert.ok(both.sent.every(item => item.kind === 'text'))
  both.execution.abort()
  for (const handler of handlers) {
    const context = both.context('.赛马娘')
    assert.equal(handler.isCandidate(context.source, context.binding), false)
    assert.equal(await handler.handle(context), false)
    const stopping = handler.stop(); assert.equal(handler.stop(), stopping); await stopping
  }
})

test('Turtle model overrides only the fixed chat model, disables tools and records global plus complete scope usage', async t => {
  const f = fixture(t), call = createStandaloneTurtleSoupModel(f.options), messages = [{ role: 'system', content: '固定主持要求' }, { role: 'user', content: '当前问题' }]
  const context = f.context()
  assert.equal(await call(messages, { model: ' review-model ', temperature: 0.2 }, context), '是')
  assert.equal(await call(messages, {}, context), '是')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].config.chatAiConfig.chatApiModel, 'review-model')
  assert.equal(f.calls[1].config.chatAiConfig.chatApiModel, 'main-model')
  assert.equal(f.options.execution.chatAiConfig.chatApiModel, 'main-model')
  for (const value of f.calls) {
    assert.equal(value.config.useTools, false)
    assert.equal(value.executionOptions.forceChatBackend, true)
    assert.equal(value.config.chatAiConfig.chatApiUrl, 'https://fixed-model.example/v1')
    assert.equal(value.config.chatAiConfig.chatApiKey, 'HOST_SECRET')
    assert.equal(value.config.chatAiConfig.chatReasoningEffort, 'low')
    assert.equal(value.request.tools, undefined)
    assert.equal(value.request.tool_choice, undefined)
    assert.deepEqual(value.request.messages, messages)
    assert.equal(value.request.top_p, 0.9)
    assert.equal(typeof value.executionOptions.ensureCurrent, 'function')
    await value.executionOptions.ensureCurrent()
  }
  assert.equal(f.calls[0].request.temperature, 0.2)
  assert.equal(f.tokens.length, 4)
  assert.deepEqual(f.tokens.map(item => [item.scope, item.stage]), [['global', 'api'], [simulationAddressKey(f.binding.target), 'turtle-soup'], ['global', 'api'], [simulationAddressKey(f.binding.target), 'turtle-soup']])
  assert.ok(f.tokens.every(item => item.model === 'actual-game-model' && item.usage.total_tokens === 10))
  assert.ok(f.ensureCount >= 6)
})

test('each provider retry receives a fresh source fence and stops after host authority retires', async t => {
  const f = fixture(t), call = createStandaloneTurtleSoupModel(f.options)
  let providerDispatches = 0
  f.setModel(async (_request, _config, options) => {
    await options.ensureCurrent(); providerDispatches++
    f.setCurrent(false)
    await options.ensureCurrent(); providerDispatches++
    return response()
  })
  await assert.rejects(call([{ role: 'user', content: '当前问题' }], {}, f.context()), /^Error: 海龟汤模型请求未完成$/u)
  assert.equal(providerDispatches, 1)
  assert.equal(f.tokens.length, 0)
  const denied = fixture(t); denied.setCurrent(false)
  await assert.rejects(createStandaloneTurtleSoupModel(denied.options)([{ role: 'user', content: '问题' }], {}, denied.context()), /未完成/u)
  assert.equal(denied.calls.length, 0)
})

test('Turtle secret and forbidden checks reject input before dispatch and reject unsafe provider output', async t => {
  const f = fixture(t), call = createStandaloneTurtleSoupModel(f.options)
  for (const secret of ['HOST_SECRET', 'forbidden-fixture']) {
    await assert.rejects(call([{ role: 'user', content: secret }], {}, f.context()), /未完成/u)
  }
  assert.equal(f.calls.length, 0)
  f.setModel(async () => ({ ...response('HOST_SECRET forbidden-fixture'), model: 'HOST_SECRET' }))
  await assert.rejects(call([{ role: 'user', content: '安全问题' }], {}, f.context()), /^Error: 海龟汤模型请求未完成$/u)
  assert.equal(f.tokens.length, 2)
  assert.ok(f.tokens.every(item => item.model === 'main-model'))
  assert.equal(JSON.stringify(f.tokens).includes('HOST_SECRET'), false)
})

test('provider failures, tools, empty and invalid content share one safe game failure', async t => {
  const f = fixture(t), call = createStandaloneTurtleSoupModel(f.options)
  for (const value of [undefined, { error: 'HOST_SECRET provider body' }, response('  '), response({ text: 'content' }),
    { choices: [{ message: { content: '正文', tool_calls: [{ function: { name: 'sendTool', arguments: 'HOST_SECRET' } }] } }] }]) {
    f.setModel(async () => value)
    await assert.rejects(call([{ role: 'user', content: '问题' }], {}, f.context()), /^Error: 海龟汤模型请求未完成$/u)
  }
  f.setModel(async () => { throw Error('HOST_SECRET provider body') })
  await assert.rejects(call([{ role: 'user', content: '问题' }], {}, f.context()), /^Error: 海龟汤模型请求未完成$/u)
})

test('Turtle uses a 45 second deadline and combines host, original context and per-call cancellation', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 45_000); const controller = new AbortController(); deadlines.push(controller); return controller.signal })
  for (const kind of ['host', 'source', 'call', 'deadline']) {
    const f = fixture(t), entered = deferred(), late = deferred(), extra = new AbortController(), context = f.context()
    f.setModel(async () => { entered.resolve(); return late.promise })
    const pending = createStandaloneTurtleSoupModel(f.options)([{ role: 'user', content: '问题' }], { signal: extra.signal }, context)
    await entered.promise
    if (kind === 'host') f.execution.abort('HOST_SECRET')
    if (kind === 'source') context.abort()
    if (kind === 'call') extra.abort('HOST_SECRET')
    if (kind === 'deadline') deadlines.at(-1).abort('HOST_SECRET')
    await assert.rejects(pending, /^Error: 海龟汤模型请求未完成$/u)
    late.resolve(response())
    assert.equal(f.calls[0].executionOptions.signal.aborted, true)
    assert.equal(f.tokens.length, 0)
  }
  assert.equal(deadlines.length, 4)
})

test('the real Turtle adapter uses the bootstrapped safe model and host-owned scoped state', async t => {
  const f = fixture(t, { turtleSoup: { enabled: true, minPlayers: 2, guessCooldownSeconds: 0 } }), [handler] = f.create()
  const directory = agentTurtleSoupDirectory(path.join(f.dataDir, 'games'), f.binding.target.account, f.binding.agentId)
  const store = new TurtleSoupStore({ cwd: f.dataDir, baseDir: directory })
  await store.savePuzzle({ id: 'p1', title: '雨夜的伞', surface: '他撑伞仍撞上树，为什么？', solution: '他是盲人，把伞当作拐杖探路', keyPoints: ['男人是盲人', '伞用来探路'],
    hints: ['注意伞的用途', '他看不见'], difficulty: 'normal', tags: [], source: 'manual', createdAt: 1, status: 'active', ratingSum: 0, ratingCount: 0 })
  for (const [text, user] of [['.游戏 海龟汤 开局', '10001'], ['.游戏 海龟汤 加入', '10002'], ['.游戏 海龟汤 开始', '10001'], ['他看不见吗？', '10001']]) assert.equal(await handler.handle(f.context(text, { user })), true)
  assert.equal(f.sent.at(-1).text, '是')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].executionOptions.forceChatBackend, true)
  assert.equal(f.tokens.length, 2)
  assert.ok(fs.existsSync(path.join(directory, 'sessions.json')))
})

test('Uma adjustment requires an explicit real QQ/global sender, while group owner never adds authority', async t => {
  const f = fixture(t, { umaRace: { enabled: true }, operatorIds: ['10001'] }), [handler] = f.create()
  await handler.handle(f.context('.赛马娘 加积分 10001 9', { user: '10002', role: 'owner' }))
  assert.match(f.sent.at(-1).text, /获授权的主人/u)
  await handler.handle(f.context('.赛马娘 加积分 10001 9'))
  const filename = path.join(agentUmaRaceDataDir(path.join(f.dataDir, 'games'), f.binding), 'points.json')
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).players['10001'].points, 9)
  const forged = f.context('.赛马娘 加积分 10001 900', { user: '10002' }); forged.member.id = '10001'
  await assert.rejects(handler.handle(forged), /来源|改变/u)
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).players['10001'].points, 9)
  for (const [platform, namespace] of [['qq', 'other'], ['fixture', 'global']]) {
    const foreign = structuredClone(f.binding); foreign.target.account.platform = platform; foreign.target.account.namespace = namespace
    await handler.handle(f.context('.赛马娘 加积分 10001 900', { binding: foreign, role: 'owner' }))
    assert.match(f.sent.at(-1).text, /获授权的主人/u)
  }
  assert.equal(f.calls.length, 0)
})

test('Uma without a report renderer keeps its text result and host retirement fences queued game sends', async t => {
  const f = fixture(t, { umaRace: { enabled: true, lobbySeconds: 10, raceStageSeconds: 10, cooldownSeconds: 0 } }), [handler] = f.create()
  for (const text of ['.赛马娘 领养 测试马 勇敢', '.赛马娘 开始', '.赛马娘 开跑', '.赛马娘 决策 稳住', '.赛马娘 决策 稳住', '.赛马娘 决策 稳住']) await handler.handle(f.context(text))
  assert.ok(f.sent.some(item => /赛马结果出炉/u.test(item.text)))
  assert.ok(f.sent.every(item => item.kind === 'text'))
  assert.equal(f.calls.length, 0)
  const entered = deferred(), release = deferred(), before = f.sent.length
  f.setOnSend(async () => { entered.resolve(); await release.promise })
  const pending = handler.handle(f.context('.赛马娘 帮助')); await entered.promise
  f.setCurrent(false); release.resolve()
  await assert.rejects(pending, /授权|改变/u)
  assert.equal(f.sent.length, before)
})
