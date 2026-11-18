import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

// Default/release runs use built files. Explicit source checks do not modify dist.
const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const share = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1xx411c7mD' } }
const command = '.高清搬运 1080P https://www.bilibili.com/video/BV1xx411c7mD'
const video = { id: 'a'.repeat(32), kind: 'video', mime: 'video/mp4', sizeBytes: 100, sha256: 'a'.repeat(64) }
const plan = { version: 1, items: [{ parts: [{ kind: 'text', text: '高清完整内容' }] }, { parts: [{ kind: 'video', artifact: video }] }] }
const deferred = () => Promise.withResolvers()
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const textOf = action => action.parts?.filter(part => part.kind === 'text').map(part => part.text).join('') ?? ''
let fixtureId = 0

test('Core rejects enabled HQ commands without both trusted auth and provider capabilities before side effects', () => {
  for (const capability of [{}, { bilibiliAuthService: {} }, { bilibiliQualityProviderFor() {} }]) {
    assert.throws(() => createAgentRuntime({ bilibiliQuality: { enabled: true, masters: [] }, ...capability }), /启用B站高清命令必须配置 Core 授权服务与高清提供器/u)
  }
})

async function waitFor(probe, label, diagnostic = () => '') {
  const deadline = performance.now() + 8_000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`timed out: ${label}: ${diagnostic()}`)
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'bilibili-quality-core-integration')
  const account = { platform: 'fixture', namespace: `quality-core-${++fixtureId}`, id: 'robot' }
  const master = { ...account, id: 'master' }, player = { ...account, id: 'player' }, admin = { ...account, id: 'admin' }
  const group = { account, kind: 'group', id: 'room' }, otherGroup = { ...group, id: 'other-room' }, privateTarget = { account, kind: 'private', id: master.id }
  const targets = [group, otherGroup, privateTarget], queueKeys = ['group-log', 'group-text', 'private', 'privacy', 'simulation'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: targets.map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'quality-core-initial'), accept, ready = false, clock = Date.now(), sequence = 0, memberReads = 0
  const sources = new Map(), requests = [], sends = [], mediaAttempts = [], media = [], authAttempts = [], notices = [], preparations = [], sessions = [], logouts = [], autoReads = [], autoPrepares = [], diagnostics = []
  const auth = {
    async status(binding, context) { await context.ensureCurrent?.(); return { authorized: true, updatedAt: clock } },
    async start(binding, context) {
      const session = { binding, context, cancelled: 0, polls: 0,
        image: PNG, expiresAt: clock + 170_000,
        async poll(scope) { session.polls++; await scope.ensureCurrent?.(); return settings.poll ? settings.poll(scope, f, session) : 'waiting' },
        cancel() { session.cancelled++ },
      }
      sessions.push(session)
      return settings.startAuth ? settings.startAuth(binding, context, f, session) : session
    },
    async logout(binding, context) { await context.ensureCurrent?.(); logouts.push(binding) },
    async credential() { return undefined }, async close() {},
  }
  const adapter = { id: 'connection', account, botUserId: account.id, botName: '高清集成验证', isReady: () => ready,
    async start(consume) { accept = consume; ready = true }, stop() { ready = false },
    async readMessage(target, id, guard) { return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(sourceKey(target, id))) },
    async readConversationMember(target, user) { memberReads++; return { target, observedAt: Date.now(), member: { user, role: 'admin' } } },
    async readMediaShare(target, id) { autoReads.push({ target, id }); return { message: structuredClone(sources.get(sourceKey(target, id))), share } },
    actions: {
      async send(action, guard) {
        if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
        sends.push(structuredClone(action)); return { state: 'sent', messageId: `text-${++sequence}` }
      },
      async sendMediaRelay(action, guard) {
        mediaAttempts.push({ action: structuredClone(action), guard }); assert.ok(guard.signal instanceof AbortSignal)
        if (settings.sendMedia) return settings.sendMedia(action, guard, f)
        if (guard.signal.aborted || !guard.isCurrent()) return { state: 'failed', code: 'stale' }
        media.push(structuredClone(action)); return { state: 'sent', messageId: `media-${++sequence}` }
      },
      async sendRequesterBilibiliAuth(action, guard) {
        authAttempts.push({ action: structuredClone(action), guard }); assert.ok(guard.signal instanceof AbortSignal)
        if (settings.sendAuth) return settings.sendAuth(action, guard, f)
        if (guard.signal.aborted || !guard.isCurrent()) return { state: 'failed', code: 'stale' }
        notices.push(structuredClone(action)); return { state: 'sent', messageId: `private-${++sequence}` }
      },
    },
  }
  function makeHost() {
    return createAgentRuntime({ storage: redis.storage, adapters: [adapter], isExecutionCurrent: redis.isCurrent, now: () => clock,
      privateChatEnabled: true, useTextGroup: () => settings.mode !== 'simulation',
      ...(settings.groupLog ? { groupLog: { enabled: true, masters: [master] } } : {}),
      bilibiliQuality: { enabled: true, masters: settings.wrongMasterNamespace ? [{ ...master, namespace: account.namespace + '-other' }] : [master],
        ...(settings.whitelist ? { whitelist: [{ target: group, users: [player] }] } : {}) },
      bilibiliAuthService: auth,
      bilibiliQualityProviderFor: () => ({ async prepare(request, context) {
        const record = { request: structuredClone(request), context, releases: 0 }; preparations.push(record)
        const prepared = { status: 'ready', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', infoText: '高清完整内容', plan,
          requestedQuality: request.quality, actualQualities: [{ quality: 80, label: '1080P' }], async release() { record.releases++ } }
        return settings.prepare ? settings.prepare(request, context, f, prepared) : prepared
      } }),
      mediaRelay: { enabled: true }, mediaRelayProvider: { async prepare(input) { autoPrepares.push(input); throw Error('auto relay must not handle HQ commands') } },
      resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '高清角色' }, systemContent: '合成集成验证' } },
      getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
        personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 } }),
      getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      logger: { info() {}, warn: (...args) => diagnostics.push(args.join(' ')), error: (...args) => diagnostics.push(args.join(' ')) },
      async YTapi(request) { requests.push(structuredClone(request)); return { choices: [{ message: { content: '只回答普通对话。' } }] } },
    })
  }
  f = { ...redis, account, master, player, admin, group, otherGroup, privateTarget, sources, requests, sends, mediaAttempts, media, authAttempts, notices, preparations, sessions, logouts, autoReads, autoPrepares, diagnostics,
    get host() { return host }, get memberReads() { return memberReads },
    binding: (target = group) => directory.resolve(target),
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(row => ({ ...row, agentId: 'replacement' })) }, 'quality-core-rebound') },
    message(text, extra = {}) {
      const target = extra.conversation ?? group
      return { version: 1, conversation: target, sender: master, messageId: `command-${++sequence}`, occurredAt: ++clock,
        text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: target.kind === 'private', ...extra }
    },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await accept({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total = 0; for _, key in ipairs(KEYS) do total = total + redis.call('LLEN', key) end; return total", { keys: queueKeys, arguments: [] })) === 0,
        'Core inbox acknowledgment', () => JSON.stringify(diagnostics.slice(-8)))
      await host.runtime.drain()
    },
    async send(text, extra = {}) { const message = f.message(text, extra); await f.emit(message); await f.drained(); return message },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async ledger() { return Promise.all((await redis.reader.keys(redis.prefix + 'agent:bilibili-quality:v1:command:*')).map(async key => JSON.parse(await redis.reader.get(key)))) },
    assertDeterministic() { assert.equal(requests.length, 0); assert.equal(autoReads.length, 0); assert.equal(autoPrepares.length, 0) },
  }
  host = makeHost(); await host.start(); return f
}

for (const mode of ['text', 'simulation']) test(`Core ${mode} HQ and auth commands run before models and automatic media relay`, redisTest, async t => {
  const f = await fixture(t, { mode })
  await f.send(command); await f.send('.B站授权 状态')
  assert.equal(f.media.length, 1); assert.equal(f.preparations.length, 1); assert.equal(f.preparations[0].releases, 1)
  assert.deepEqual(f.preparations[0].request, { quality: 80, share }); assert.equal(f.media[0].mode, 'forward')
  assert.deepEqual(f.media[0].binding, f.binding()); assert.match(textOf(f.sends.at(-1)), /已保存B站授权/u); f.assertDeterministic()
  if (mode === 'text') {
    await f.send('正常对话仍可调用模型', { directedToAccount: true })
    await waitFor(() => f.requests.length === 1 && f.sends.some(action => textOf(action) === '只回答普通对话。'), 'ordinary text model route remains enabled')
  }
})

test('Core preserves whitelist mentions, enforces full masters, and never grants platform administrators HQ or auth', redisTest, async t => {
  const f = await fixture(t)
  await f.send(command, { sender: f.admin }); assert.equal(f.media.length, 0); assert.match(textOf(f.sends.at(-1)), /主人|白名单/u)
  await f.send('.B站授权登录', { sender: f.admin }); assert.equal(f.sessions.length, 0)
  const change = async action => f.send('.高清搬运白名单 ' + action + ' @player', { parts: [{ kind: 'text', text: '.高清搬运白名单 ' + action + ' ' }, { kind: 'mention', user: f.player }], mentions: [f.player] })
  await change('添加'); assert.match(textOf(f.sends.at(-1)), /已添加/u)
  await f.send(command, { sender: f.player }); assert.equal(f.media.length, 1)
  await f.send('.B站授权登录', { sender: f.player }); assert.equal(f.sessions.length, 0)
  await change('删除'); await f.send(command, { sender: f.player }); assert.equal(f.media.length, 1)
  await f.send(command); assert.equal(f.media.length, 2); assert.equal(f.memberReads, 0); f.assertDeterministic()
})

test('Core applies static whitelist only to its group and compares the complete master namespace', redisTest, async t => {
  const f = await fixture(t, { whitelist: true, wrongMasterNamespace: true })
  await f.send(command, { sender: f.player }); assert.equal(f.media.length, 1)
  await f.send(command, { sender: f.player, conversation: f.otherGroup }); assert.equal(f.media.length, 1)
  await f.send(command); await f.send('.B站授权登录'); assert.equal(f.media.length, 1); assert.equal(f.sessions.length, 0); f.assertDeterministic()
})

test('Core keeps group and private QR auth on the proven requester port with exact source text hashes', redisTest, async t => {
  const f = await fixture(t)
  const groupCommand = await f.send('  .B站授权 登录  '), privateCommand = await f.send('  .B站授权登录  ', { conversation: f.privateTarget })
  assert.equal(f.authAttempts.length, 2); assert.equal(f.notices.length, 2)
  for (const [index, source] of [groupCommand, privateCommand].entries()) {
    const action = f.notices[index]
    assert.equal(action.kind, 'bilibili-auth.notify'); assert.equal(action.content.kind, 'qr'); assert.deepEqual(action.source.author, f.master)
    assert.deepEqual(action.source.target, source.conversation); assert.equal(action.source.messageId, source.messageId)
    assert.equal(action.source.textSha256, createHash('sha256').update(source.text).digest('hex')); assert.deepEqual(action.binding, f.binding(source.conversation))
  }
  assert.equal(f.sends.length, 1); assert.match(textOf(f.sends[0]), /二维码已确认私发/u)
  assert.equal(JSON.stringify(f.sends).includes(PNG.base64), false); assert.equal(f.mediaAttempts.length, 0); f.assertDeterministic()
})

for (const stage of ['media', 'qr']) test(`Core ${stage} unknown delivery never falls back or retries after duplicate and restart`, redisTest, async t => {
  const f = await fixture(t, stage === 'media' ? { sendMedia: async () => ({ state: 'unknown' }) } : { sendAuth: async () => ({ state: 'unknown' }) })
  const source = await f.send(stage === 'media' ? command : '.B站授权登录')
  await f.emit(source); await f.drained(); await f.restart(); await f.emit(source); await f.drained()
  assert.equal(stage === 'media' ? f.mediaAttempts.length : f.authAttempts.length, 1)
  assert.equal(f.sends.length, 0); assert.equal(f.notices.length, 0); assert.ok((await f.ledger()).some(row => row.state === 'unknown'))
  assert.equal(f.sessions.reduce((total, session) => total + session.polls, 0), 0); f.assertDeterministic()
})

for (const stage of ['prepare', 'auth']) for (const reason of ['recall', 'rebind']) test(`Core ${reason} cancels pending ${stage} and releases late resources without sending`, redisTest, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { release: release.resolve,
    ...(stage === 'prepare' ? { async prepare(_request, _context, _f, prepared) { entered.resolve(); await release.promise; return prepared } }
      : { async startAuth(_binding, _context, _f, session) { entered.resolve(); await release.promise; return session } }),
  })
  const source = f.message(stage === 'prepare' ? command : '.B站授权登录'); await f.emit(source); await entered.promise
  if (reason === 'recall') await f.recall(source); else f.rebind()
  await f.drained(); release.resolve()
  await waitFor(() => stage === 'prepare' ? f.preparations[0].releases === 1 : f.sessions[0].cancelled === 1, 'late prepared resource or auth session cleanup')
  assert.equal(f.mediaAttempts.length, 0); assert.equal(f.authAttempts.length, 0); assert.equal(f.sends.length, 0); f.assertDeterministic()
})

test('Core retains detached login source authority until cross-group logout cancels its in-flight poll', redisTest, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { release: release.resolve, async poll(scope) { assert.equal(scope.isCurrent(), true); entered.resolve(); await release.promise; return 'success' } })
  const login = await f.send('.B站授权登录'); await entered.promise
  assert.equal(f.sessions[0].context.isCurrent(), true); assert.equal(f.sessions[0].context.signal.aborted, false)
  await f.send('.B站授权退出', { conversation: f.otherGroup })
  await waitFor(() => f.sessions[0].cancelled === 1, 'cross-group logout session cancellation')
  assert.equal(f.sessions[0].context.signal.aborted, true); assert.equal(f.logouts.length, 1)
  release.resolve(); await delay(30); assert.equal(f.notices.filter(action => action.source.messageId === login.messageId).length, 1)
  assert.equal(f.notices.some(action => action.content.kind === 'text'), false); f.assertDeterministic()
})

test('Core keeps HQ, auth and group-log commands available while the group log mutes ordinary AI', redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  await f.send('.log on 高清验收'); await f.send('静默中不应交给模型', { directedToAccount: true })
  await f.send(command); await f.send('.B站授权登录'); await f.send('.log status')
  assert.equal(f.media.length, 1, JSON.stringify({ preparations: f.preparations.length, sessions: f.sessions.length, texts: f.sends.map(textOf), diagnostics: f.diagnostics })); assert.equal(f.notices.length, 1); assert.equal(f.notices[0].content.kind, 'qr')
  assert.equal(f.sessions[0].context.isCurrent(), true); assert.equal(f.sessions[0].context.signal.aborted, false)
  assert.match(textOf(f.sends.at(-1)), /高清验收|记录|静默/u); assert.equal(f.sends.length, 3); f.assertDeterministic()
})
