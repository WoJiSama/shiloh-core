import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createAgentBilibiliQualityWorkflow, validateAgentBilibiliQualityConfig, isAgentBilibiliQualityCommand } = await load('modules/media/infrastructure/agentBilibiliQualityWorkflow.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 20000 }, SECRET = 'HQ_HOST_PRIVATE_123456/+=', NOW = 1_800_000_000_000
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const who = (id = 'master') => ({ platform: 'qq', namespace: 'global', id })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const sent = () => ({ state: 'sent', messageId: 'confirmed' })
const video = { id: 'a'.repeat(32), kind: 'video', mime: 'video/mp4', sizeBytes: 100, sha256: 'a'.repeat(64) }
const thumbnail = { id: 'b'.repeat(32), kind: 'image', mime: 'image/png', sizeBytes: 100, sha256: 'b'.repeat(64) }
const plan = { version: 1, items: [{ parts: [{ kind: 'text', text: '完整高清内容' }] }, { parts: [{ kind: 'video', artifact: video, thumbnail }] }] }
async function until(predicate, ms = 6000) { const deadline = Date.now() + ms; while (!predicate()) { if (Date.now() > deadline) throw Error('condition timed out'); await delay(10) } }
async function fixture(t, settings = {}) {
  let workflow
  t.after(async () => { await workflow?.stop() })
  const redis = await createAgentRedisFixture(t, 'bilibili-quality-workflow'), target = { account: who('robot'), kind: settings.private ? 'private' : 'group', id: settings.private ? 'master' : 'room' }
  const binding = { source: 'configured', id: conversationAddressKey(target), target, agentId: 'alice', personaId: 'daily', revision: 'r1', connectionId: 'main' }
  let now = NOW, sequence = 0, releases = 0, cancelled = 0, authStarts = 0, closes = 0, logouts = 0, polls = 0, current = true
  const messages = new Map(), notices = [], privateMessages = [], media = [], preparations = [], diagnostics = [], explanations = []
  let pollHook = settings.poll, sendHook = settings.send, privateHook = settings.privateSend, prepareHook = settings.prepare
  const auth = { async status() { return { authorized: true, updatedAt: NOW } }, async start(_binding, context) {
    authStarts++; await assertPending('operation')
    return { image: PNG, expiresAt: now + (settings.expiresIn ?? 170000), async poll(scope) { polls++; return pollHook ? pollHook(scope) : 'success' }, cancel() { cancelled++ } }
  }, async logout(_binding, context) { await assertPending('operation'); logouts++; await context.ensureCurrent?.() }, async credential() { return SECRET }, async close() { closes++ } }
  const provider = { async prepare(request, context) {
    preparations.push(request)
    const value = { status: 'ready', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', infoText: '高清内容', plan,
      requestedQuality: request.quality, actualQualities: [{ quality: 80, label: '1080P' }], async release() { releases++ } }
    return prepareHook ? prepareHook(request, context, value) : value
  } }
  const config = { enabled: true, masters: [who()], ...(settings.whitelist ? { whitelist: [{ target, users: settings.whitelist }] } : {}), ...settings.config }
  const storage = settings.wrapStorage ? settings.wrapStorage(redis.storage) : redis.storage
  const options = { storage, auth, provider: () => provider, now: () => now, secrets: [SECRET], allowsText: text => !text.includes('FORBIDDEN'),
    ...(settings.diagnostics === null ? {} : { diagnostics: settings.diagnostics ?? { emit(event) { diagnostics.push(event) }, traceId: () => 'safe_trace' } }),
    actions: {
      async send(action, guard) { await assertPending(); notices.push(action); if (!guard.isCurrent()) throw Error('stale'); return sendHook ? sendHook(action, guard) : sent() },
      async sendRequesterBilibiliAuth(action, guard) { await assertPending(); privateMessages.push(action); if (!guard.isCurrent() || guard.signal.aborted) throw Error('stale'); return privateHook ? privateHook(action, guard) : sent() },
      async sendMediaRelay(action, guard) { await assertPending('media'); media.push(action); if (!guard.isCurrent() || guard.signal.aborted) throw Error('stale'); return settings.mediaSend ? settings.mediaSend(action, guard) : sent() },
    },
    ...(settings.explain ? { explainFailure: async input => { explanations.push(input); return settings.explain(input) } } : {}),
  }
  workflow = createAgentBilibiliQualityWorkflow(config, options); await workflow.start()
  function message(text, overrides = {}) {
    const value = { version: 1, conversation: target, sender: who(), occurredAt: NOW + ++sequence, messageId: 'command-' + sequence,
      text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...overrides }
    messages.set(value.messageId, value); return value
  }
  function context(message) { const controller = new AbortController(); return { controller, signal: controller.signal, isCurrent: () => current,
    async ensureCurrent() { if (!current || controller.signal.aborted || !messages.has(message.messageId)) throw Error(SECRET) }, async readCurrent() { return messages.get(message.messageId) } } }
  async function assertPending(stage) {
    const keys = await redis.reader.keys(redis.prefix + 'agent:bilibili-quality:v1:command:*'), records = await Promise.all(keys.map(key => redis.reader.get(key)))
    assert.ok(records.some(raw => { const value = JSON.parse(raw); return value.state === 'pending' && (stage ? value.effects[stage] === 'pending' : Object.values(value.effects).includes('pending')) }), 'pending must be durable before native side effect')
  }
  return { ...redis, binding, target, messages, message, context, config, options, notices, privateMessages, media, preparations, diagnostics, explanations,
    get workflow() { return workflow }, get releases() { return releases }, get cancelled() { return cancelled }, get starts() { return authStarts }, get closes() { return closes }, get logouts() { return logouts }, get polls() { return polls },
    setCurrent(value) { current = value }, advance(ms) { now += ms }, setPoll(value) { pollHook = value }, setSend(value) { sendHook = value }, setPrivate(value) { privateHook = value }, setPrepare(value) { prepareHook = value },
    async restart() { await workflow.stop(); workflow = createAgentBilibiliQualityWorkflow(config, options); await workflow.start() },
    handle(value, scope = context(value)) { return workflow.handle(value, binding, scope) },
    async raw() { const out = []; for (const key of await redis.reader.keys(redis.prefix + 'agent:bilibili-quality:v1:command:*')) out.push(await redis.reader.get(key)); return out.join('\n') },
  }
}
test('configuration is closed full-identity data and rejects code-bearing fields without execution', () => {
  assert.equal(validateAgentBilibiliQualityConfig(undefined).enabled, false)
  for (const value of [{ enabled: true, masters: ['123'] }, { enabled: true, masters: [who()], cookie: SECRET }, { enabled: true, masters: [who(), who()] }, { enabled: true, masters: [who()], whitelist: [{ target: { id: 'bare-group' }, users: [who()] }] }]) assert.throws(() => validateAgentBilibiliQualityConfig(value))
  let touched = 0
  for (const value of [{ enabled: true, get masters() { touched++; return [who()] } }, new Proxy({}, { get() { touched++; return true } })]) assert.throws(() => validateAgentBilibiliQualityConfig(value))
  assert.equal(touched, 0)
  const array = [who()]; array.extra = 'smuggled'
  assert.throws(() => validateAgentBilibiliQualityConfig({ enabled: true, masters: array }))
  assert.equal(isAgentBilibiliQualityCommand({ get text() { touched++; return '.高清搬运' } }), false)
  assert.equal(isAgentBilibiliQualityCommand(new Proxy({}, { get() { touched++; return '.高清搬运' } })), false); assert.equal(touched, 0)
  for (const text of ['.高清搬运 broken', '.高清搬运白名单 whatever', '.B站授权 错误', '。B站授权登录']) assert.equal(isAgentBilibiliQualityCommand(text), true)
  assert.equal(isAgentBilibiliQualityCommand('普通聊天'), false)
})
test('HQ exact commands prepare Core resources and send once with durable media pending and no persisted URL', redisTest, async t => {
  const f = await fixture(t), input = f.message('.高清搬运 1080P BV1xx411c7mD')
  assert.deepEqual(await f.handle(input), { consumed: true }); assert.equal(f.media.length, 1); assert.equal(f.releases, 1)
  assert.deepEqual(f.preparations[0], { quality: 80, share: { provider: 'bilibili', reference: { kind: 'video', id: 'BV1xx411c7mD' } } })
  await f.restart(); await f.handle(input); assert.equal(f.media.length, 1); assert.equal(f.preparations.length, 1)
  for (const value of ['BV1xx411c7mD', 'https:', 'cookie', SECRET, PNG.base64]) assert.equal((await f.raw()).includes(value), false)
})
test('source fingerprints ignore object property order while preserving exact text and all native parts', redisTest, async t => {
  const f = await fixture(t), value = f.message('.B站授权状态'), ctx = f.context(value)
  ctx.readCurrent = async () => ({ ...value, conversation: { id: value.conversation.id, kind: value.conversation.kind, account: { id: 'robot', namespace: 'global', platform: 'qq' } }, sender: { id: 'master', platform: 'qq', namespace: 'global' } })
  await f.handle(value, ctx); assert.match(f.notices[0].parts[0].text, /已保存B站授权/u)
  assert.equal(f.privateMessages.length, 0); assert.equal(f.starts, 0)
})
test('malformed, quoted and mixed commands are consumed without provider, and regular chat is left alone', redisTest, async t => {
  const f = await fixture(t)
  for (const value of [f.message('.高清搬运 1080P https://evil.invalid/video'), f.message('.高清搬运 1080P BV1xx411c7mD', { quote: { parts: [] } }),
    f.message('.高清搬运 1080P BV1xx411c7mD', { parts: [{ kind: 'image' }] }), f.message('.B站授权 unknown')]) assert.equal((await f.handle(value)).consumed, true)
  assert.equal(f.preparations.length, 0); assert.equal(f.starts, 0); assert.equal(f.notices.length, 4)
  assert.equal((await f.handle(f.message('普通聊天'))).consumed, false)
})
test('only full trusted masters administer the whitelist; admins do not automatically gain HQ', redisTest, async t => {
  const f = await fixture(t), user = who('player'), change = (action, sender = who()) => f.message('.高清搬运白名单 ' + action + ' @player', {
    sender, parts: [{ kind: 'text', text: '.高清搬运白名单 ' + action + ' ' }, { kind: 'mention', user }], mentions: [user],
  })
  await f.handle(f.message('.高清搬运 1080P BV1xx411c7mD', { sender: user })); assert.equal(f.media.length, 0)
  await f.handle(change('添加', user)); assert.match(f.notices.at(-1).parts[0].text, /只允许可信主人/u)
  await f.handle(change('添加')); await f.handle(f.message('.高清搬运 1080P BV1xx411c7mD', { sender: user })); assert.equal(f.media.length, 1)
  await f.handle(change('删除')); await f.handle(f.message('.高清搬运 1080P BV1xx411c7mD', { sender: user })); assert.equal(f.media.length, 1)
  await f.restart(); await f.handle(f.message('.高清搬运白名单 查看')); assert.match(f.notices.at(-1).parts[0].text, /为空/u)
})
test('a stored whitelist deletion overrides static initial authorization after restart', redisTest, async t => {
  const player = who('player'), f = await fixture(t, { whitelist: [player] })
  await f.handle(f.message('.高清搬运白名单 删除 @player', { parts: [{ kind: 'text', text: '.高清搬运白名单 删除 ' }, { kind: 'mention', user: player }], mentions: [player] }))
  await f.restart(); await f.handle(f.message('.高清搬运 1080P BV1xx411c7mD', { sender: player })); assert.equal(f.media.length, 0)
})
test('provider and explicit native failures use one safe explanation with trace fallback and no raw exception', redisTest, async t => {
  for (const mode of ['provider', 'native']) await t.test(mode, async t => {
    const f = await fixture(t, { ...(mode === 'provider' ? { prepare: async () => { throw Error(SECRET) } } : { mediaSend: async () => ({ state: 'failed' }) }), explain: async input => { assert.equal(input.detail.includes(SECRET), false); return undefined } })
    const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value); await f.handle(value)
    assert.equal(f.explanations.length, 1); assert.equal(f.notices.length, 1); assert.match(f.notices[0].parts[0].text, /safe_trace/u)
    assert.equal(JSON.stringify(f.diagnostics).includes(SECRET), false); assert.equal((await f.raw()).includes(SECRET), false)
  })
})
test('unknown media receipts freeze the source with no group fallback or registry retry', redisTest, async t => {
  for (const mode of ['unknown', 'no-id', 'throw']) await t.test(mode, async t => {
    const f = await fixture(t, { mediaSend: async () => { if (mode === 'throw') throw Error(SECRET); return mode === 'no-id' ? { state: 'sent' } : { state: 'unknown' } } })
    const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value); await f.restart(); await f.handle(value)
    assert.equal(f.media.length, 1); assert.equal(f.notices.length, 0); assert.match(await f.raw(), /unknown/u)
  })
})
test('a queued HQ send receives the precise signal and source guard and cannot dispatch after recall', redisTest, async t => {
  const held = gate(), reached = gate(), settled = gate(); let delivered = 0
  const f = await fixture(t, { mediaSend: async (_action, guard) => {
    try { reached.release(); await held.promise; if (guard.signal.aborted || !guard.isCurrent()) throw Error('cancelled'); delivered++; return sent() }
    finally { settled.release() }
  } })
  t.after(() => held.release()); const value = f.message('.高清搬运 1080P BV1xx411c7mD'), pending = f.handle(value)
  await reached.promise; f.workflow.invalidateSource(f.target, value.messageId); await pending; held.release(); await settled.promise
  assert.equal(delivered, 0); assert.equal(f.notices.length, 0); assert.equal(f.releases, 1); assert.match(await f.raw(), /unknown/u)
})
test('removing current whitelist authority cancels a pending provider without altering the command source', redisTest, async t => {
  const held = gate(), reached = gate(), player = who('player'), f = await fixture(t, { whitelist: [player], prepare: async (_request, _context, prepared) => { reached.release(); await held.promise; return prepared } })
  t.after(() => held.release()); const value = f.message('.高清搬运 1080P BV1xx411c7mD', { sender: player }), pending = f.handle(value); await reached.promise
  await f.handle(f.message('.高清搬运白名单 删除 @player', { parts: [{ kind: 'text', text: '.高清搬运白名单 删除 ' }, { kind: 'mention', user: player }], mentions: [player] }))
  await pending; held.release(); await until(() => f.releases === 1); assert.equal(f.media.length, 0)
  assert.equal(f.notices.length, 1, 'only the independent whitelist deletion confirms')
})
test('recall, privacy and binding invalidation cancel pending preparation and release late resources', redisTest, async t => {
  for (const mode of ['recall', 'subject', 'binding', 'source-text']) await t.test(mode, async t => {
    const held = gate(), reached = gate(), f = await fixture(t, { prepare: async (_request, _context, value) => { reached.release(); await held.promise; return value } })
    t.after(() => held.release()); const value = f.message('.高清搬运 1080P BV1xx411c7mD'), pending = f.handle(value); await reached.promise
    if (mode === 'recall') { f.messages.delete(value.messageId); f.workflow.invalidateSource(f.target, value.messageId) }
    if (mode === 'subject') f.workflow.invalidateSubject(f.target.account, value.sender)
    if (mode === 'binding') f.workflow.invalidate(f.target)
    if (mode === 'source-text') f.messages.set(value.messageId, { ...value, text: 'changed' })
    await pending; held.release(); await until(() => f.releases === 1)
    assert.equal(f.media.length, 0); assert.equal(f.notices.length, 0)
  })
})
test('login sends QR only to the proven requester, starts one poll after confirmation and privately reports success', redisTest, async t => {
  const f = await fixture(t), value = f.message('.B站授权 登录'), context = f.context(value); let released = 0
  context.release = () => { released++ }; await f.handle(value, context)
  assert.equal(f.privateMessages.length, 1); assert.equal(f.privateMessages[0].content.kind, 'qr'); assert.equal(f.privateMessages[0].source.author.id, 'master')
  assert.equal(f.privateMessages[0].source.textSha256, createHash('sha256').update(value.text).digest('hex')); assert.equal(released, 0)
  assert.equal(f.privateMessages[0].source.target.kind, 'group'); assert.equal(f.notices.length, 1); assert.equal(f.polls, 0)
  await until(() => released === 1); assert.equal(f.privateMessages.length, 2); assert.equal(f.polls, 1); assert.equal(f.privateMessages[1].content.kind, 'text'); assert.match(f.privateMessages[1].content.text, /成功/u)
  await f.handle(value); assert.equal(f.starts, 1); assert.equal(f.privateMessages.length, 2)
  assert.equal((await f.raw()).includes(PNG.base64), false); assert.equal((await f.raw()).includes(SECRET), false)
})
test('QR unknown or missing message ID never confirms in group, polls or reissues after restart', redisTest, async t => {
  for (const state of ['unknown', 'no-id']) await t.test(state, async t => {
    const f = await fixture(t, { privateSend: async () => state === 'unknown' ? { state: 'unknown' } : { state: 'sent' } }), value = f.message('.B站授权登录')
    await f.handle(value); await f.restart(); await f.handle(value)
    assert.equal(f.privateMessages.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.polls, 0); assert.equal(f.starts, 1)
  })
})
test('recall during a pending private QR send prevents late delivery and group confirmation', redisTest, async t => {
  const held = gate(), reached = gate(), settled = gate(); let delivered = 0
  const f = await fixture(t, { privateSend: async (_action, guard) => {
    try { reached.release(); await held.promise; if (guard.signal.aborted || !guard.isCurrent()) throw Error('stale'); delivered++; return sent() }
    finally { settled.release() }
  } })
  t.after(() => held.release()); const value = f.message('.B站授权登录'), pending = f.handle(value); await reached.promise
  f.messages.delete(value.messageId); f.workflow.invalidateSource(f.target, value.messageId); await pending; held.release(); await settled.promise
  assert.equal(delivered, 0); assert.equal(f.notices.length, 0); assert.equal(f.polls, 0); assert.ok(f.cancelled > 0)
})
test('a missing or broken observer still yields the fixed safe failure notice exactly once', redisTest, async t => {
  for (const broken of [false, true]) await t.test(broken ? 'throwing observer' : 'absent observer', async t => {
    const terminal = [], original = console.error; console.error = (...args) => terminal.push(args.join(' '))
    try {
      const f = await fixture(t, { prepare: async () => { throw Error(SECRET) }, explain: async () => { throw Error(SECRET) },
        diagnostics: broken ? { traceId() { throw Error(SECRET) }, emit() { throw Error(SECRET) } } : null })
      const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value); await f.handle(value)
      assert.equal(f.notices.length, 1); assert.equal(f.explanations.length, 1)
      const text = f.notices[0].parts[0].text, reference = /查询编号：([A-Za-z0-9_-]{1,128})/u.exec(text)?.[1]
      assert.ok(reference); assert.match(text, /操作未完成|服务暂时异常/u)
      assert.ok(terminal.some(line => line.includes('explanation_model_unavailable')))
      assert.ok(terminal.some(line => line.includes('notice_sent')))
      assert.ok(terminal.length >= 3); assert.ok(terminal.every(line => line.includes(`trace=${reference}`)))
      for (const secret of [SECRET, PNG.base64, 'BV1xx411c7mD', 'https:', 'Error:', 'stack']) assert.equal(terminal.join('\n').includes(secret), false)
      assert.equal(text.includes(SECRET), false); assert.equal((await f.raw()).includes(SECRET), false)
    } finally { console.error = original }
  })
})
test('private master auth is supported while private HQ and whitelist commands stay unavailable', redisTest, async t => {
  const f = await fixture(t, { private: true, expiresIn: 40 }), login = f.message('.B站授权登录')
  await f.handle(login); assert.equal(f.notices.length, 0); assert.equal(f.privateMessages[0].content.kind, 'qr')
  f.advance(100); await until(() => f.privateMessages.length === 2); assert.match(f.privateMessages[1].content.text, /过期/u); assert.equal(f.polls, 0)
  await f.handle(f.message('.高清搬运 1080P BV1xx411c7mD')); await f.handle(f.message('.高清搬运白名单 查看')); assert.equal(f.media.length, 0)
})
test('logout cancels in-flight polling immediately and a late success cannot notify or restore authority', redisTest, async t => {
  const held = gate(), reached = gate(), f = await fixture(t, { poll: async () => { reached.release(); await held.promise; return 'success' } })
  t.after(() => held.release()); await f.handle(f.message('.B站授权登录')); await reached.promise
  await f.handle(f.message('.B站授权退出')); assert.equal(f.logouts, 1); await until(() => f.cancelled > 0)
  held.release(); await delay(30); assert.equal(f.privateMessages.length, 1); assert.equal(f.notices.length, 2)
})
test('cross-group login and logout share account plus Agent scope and release the cancelled source once', redisTest, async t => {
  for (const operation of ['登录', '退出']) await t.test(operation, async t => {
    const held = gate(), reached = gate(), f = await fixture(t, { poll: async () => { reached.release(); await held.promise; return 'success' } })
    t.after(() => held.release())
    const original = f.message('.B站授权登录'), originalContext = f.context(original); let released = 0
    originalContext.release = () => { released++ }; await f.handle(original, originalContext); assert.equal(released, 0); await reached.promise
    const target = { ...f.target, id: 'other-room' }, binding = { ...f.binding, id: conversationAddressKey(target), target, revision: 'r2', personaId: 'other-persona', connectionId: 'other-connection' }
    const next = f.message('.B站授权' + operation, { conversation: target }), nextContext = f.context(next); let nextReleased = 0
    nextContext.release = () => { nextReleased++ }; await f.workflow.handle(next, binding, nextContext)
    await until(() => released === 1); assert.ok(f.cancelled > 0); assert.equal(f.starts, operation === '登录' ? 2 : 1); assert.equal(f.logouts, operation === '退出' ? 1 : 0)
    assert.equal(nextReleased, operation === '登录' ? 0 : 1)
    held.release(); await delay(30); assert.equal(released, 1); assert.equal(f.privateMessages.filter(value => value.source.messageId === original.messageId).length, 1)
    if (operation === '登录') { await f.workflow.stop(); assert.equal(nextReleased, 1) }
  })
})
test('non-detached task cleanup releases context once even when its callback throws', redisTest, async t => {
  const f = await fixture(t), value = f.message('.B站授权状态'), context = f.context(value); let released = 0
  context.release = () => { released++; throw Error('release unavailable') }
  assert.deepEqual(await f.handle(value, context), { consumed: true }); assert.equal(released, 1)
  await f.workflow.stop(); assert.equal(released, 1); assert.equal(f.closes, 1)
})
test('stop closes the auth service and pending restart markers are unknown without restoring QR or poll', redisTest, async t => {
  const f = await fixture(t); const value = f.message('.B站授权登录'); await f.handle(value); await f.restart(); await f.handle(value)
  assert.equal(f.closes, 1); assert.equal(f.starts, 1); assert.equal(f.polls, 0); assert.equal(f.privateMessages.length, 1)
  assert.match(await f.raw(), /unknown|failed/u)
})

function assertWorkflowEventsPrivate(f) {
  for (const event of f.diagnostics) {
    assert.deepEqual(Object.keys(event).sort(), ['code', 'operation', 'outcome', 'stage'])
    assert.equal(event.stage, 'runtime'); assert.match(event.operation, /^bilibili_[a-z_]+$/u); assert.match(event.code, /^[a-z_]+$/u)
  }
  for (const secret of [SECRET, PNG.base64, 'BV1xx411c7mD', 'https:', 'Error:', 'stack']) assert.equal(JSON.stringify(f.diagnostics).includes(secret), false)
}

test('prepared resource release failure stays observable without changing or repeating confirmed delivery', redisTest, async t => {
  let attempts = 0
  const f = await fixture(t, { prepare: async (_request, _context, prepared) => ({ ...prepared, async release() { attempts++; await prepared.release(); throw Error(SECRET) } }) })
  const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value); await f.handle(value)
  assert.equal(attempts, 1); assert.equal(f.releases, 1); assert.equal(f.media.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.explanations.length, 0)
  assert.ok(f.diagnostics.some(event => event.operation === 'bilibili_quality_cleanup' && event.outcome === 'failed' && event.code === 'prepared_release_unavailable'))
  assert.match(await f.raw(), /"state":"sent"/u); assertWorkflowEventsPrivate(f)
})

test('late prepared cleanup failure after source cancellation is logged without a late native send', redisTest, async t => {
  const entered = gate(), held = gate(); t.after(() => held.release())
  const f = await fixture(t, { prepare: async (_request, _context, prepared) => { entered.release(); await held.promise; return { ...prepared, async release() { await prepared.release(); throw Error(SECRET) } } } })
  const value = f.message('.高清搬运 1080P BV1xx411c7mD'), pending = f.handle(value); await entered.promise
  f.workflow.invalidateSource(f.target, value.messageId); await pending; held.release()
  await until(() => f.diagnostics.some(event => event.code === 'prepared_release_unavailable'))
  assert.equal(f.releases, 1); assert.equal(f.media.length, 0); assert.equal(f.notices.length, 0)
  assert.ok(f.diagnostics.some(event => event.operation === 'bilibili_quality_command' && event.outcome === 'cancelled')); assertWorkflowEventsPrivate(f)
})

test('failed durable receipt or terminal settlement freezes confirmed native delivery without fallback or replay', redisTest, async t => {
  for (const phase of ['receipt', 'terminal']) await t.test(phase, async t => {
    let rejected = 0, inject = true
    const f = await fixture(t, { wrapStorage: storage => ({ ...storage, async eval(script, options) {
      const next = options.arguments?.[1]
      let row
      if (typeof next === 'string') { try { row = JSON.parse(next) } catch {} }
      if (inject && options.keys.some(key => key.startsWith('agent:bilibili-quality:v1:command:')) && row?.effects?.media === 'sent' &&
          (phase === 'receipt' ? row.state === 'pending' : row.state !== 'pending')) { rejected++; throw Error(SECRET) }
      return storage.eval(script, options)
    } }) })
    const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value)
    assert.ok(rejected >= 1); assert.equal(f.media.length, 1); assert.equal(f.releases, 1); assert.equal(f.notices.length, 0); assert.equal(f.explanations.length, 0)
    assert.ok(f.diagnostics.some(event => event.operation === 'bilibili_quality_ledger' && event.outcome === 'failed' && event.code === (phase === 'receipt' ? 'delivery_receipt_unavailable' : 'terminal_state_unavailable')))
    assert.ok(f.diagnostics.some(event => event.operation === 'bilibili_quality_command' && event.outcome === 'unknown'))
    inject = false
    await f.handle(value); await f.restart(); await f.handle(value)
    assert.equal(f.media.length, 1); assert.equal(f.preparations.length, 1); assert.equal(f.notices.length, 0); assert.equal(f.explanations.length, 0); assertWorkflowEventsPrivate(f)
  })
})

test('poll service failure logs failed and privately explains once while recall cancellation only logs cancelled', redisTest, async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? 'cancelled source' : 'real poll failure', async t => {
    const entered = gate(), held = gate(); t.after(() => held.release())
    const f = await fixture(t, { poll: async () => { entered.release(); await held.promise; throw Error(SECRET) }, explain: async () => { throw Error(SECRET) } })
    const value = f.message('.B站授权登录'), scope = f.context(value); let released = 0
    scope.release = () => { released++ }; await f.handle(value, scope); await entered.promise
    if (cancelled) f.workflow.invalidateSource(f.target, value.messageId)
    held.release(); await until(() => released === 1)
    const events = f.diagnostics.filter(event => event.operation === 'bilibili_auth_poll')
    assert.equal(events.length, 1); assert.equal(events[0].outcome, cancelled ? 'cancelled' : 'failed'); assert.equal(events[0].code, cancelled ? 'poll_cancelled' : 'poll_unavailable')
    assert.equal(f.notices.length, 1); assert.equal(f.privateMessages.length, cancelled ? 1 : 2); assert.equal(f.explanations.length, cancelled ? 0 : 1)
    if (!cancelled) { assert.equal(f.privateMessages[1].content.kind, 'text'); assert.match(f.privateMessages[1].content.text, /查询编号：safe_trace/u); assert.ok(f.diagnostics.some(event => event.code === 'explanation_model_unavailable')) }
    await f.handle(value); assert.equal(f.polls, 1); assert.equal(f.starts, 1); assertWorkflowEventsPrivate(f)
  })
})

test('explanation throw is observable and safe successful model text always gains the canonical query reference', redisTest, async t => {
  for (const throws of [false, true]) await t.test(throws ? 'throwing model' : 'safe model text', async t => {
    const f = await fixture(t, { prepare: async () => { throw Error(SECRET) }, explain: async () => { if (throws) throw Error(SECRET); return '当前请求未完成，请稍后核对服务状态。' } })
    const value = f.message('.高清搬运 1080P BV1xx411c7mD'); await f.handle(value); await f.handle(value)
    assert.equal(f.notices.length, 1); assert.equal(f.explanations.length, 1); assert.equal(f.media.length, 0)
    const text = f.notices[0].parts[0].text; assert.match(text, /查询编号：safe_trace/u)
    if (throws) { assert.match(text, /操作未完成|服务暂时异常/u); assert.ok(f.diagnostics.some(event => event.code === 'explanation_model_unavailable' && event.outcome === 'failed')) }
    else assert.match(text, /^当前请求未完成/u)
    assert.ok(f.diagnostics.some(event => event.code === 'notice_sent' && event.outcome === 'succeeded')); assert.equal(JSON.stringify(f.explanations).includes(SECRET), false); assertWorkflowEventsPrivate(f)
  })
})
