import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentGroupLogStore } from '../dist/backend/modules/dice/infrastructure/agentGroupLogStore.js'
import { personMemoryCommandText as privacy } from '../dist/backend/modules/memory/domain/personMemoryCommands.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { connectAgentRedis } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const accounts = ['19000001', '19000002'].map(id => ({ platform: 'qq', namespace: 'global', id }))
const author = { ...accounts[0], id: '170001' }, otherAuthor = { ...author, id: '170002' }
const group = { account: accounts[0], kind: 'group', id: '310001' }
const otherGroup = { ...group, id: '310002' }
const otherRoleGroup = { ...group, id: '310003' }
const otherAccountGroup = { ...group, account: accounts[1] }
const privateRoom = { account: accounts[0], kind: 'private', id: author.id }
const targets = [group, otherGroup, otherRoleGroup, otherAccountGroup, privateRoom]
const keyOf = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const answer = content => ({ choices: [{ message: { content } }] })
const deferred = () => Promise.withResolvers()

async function waitFor(probe, description, diagnostic = () => '') {
  const until = performance.now() + 8_000
  while (performance.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}: ${diagnostic()}`)
}

function bindings(revision = 'group-log-v1', removed = new Set()) {
  return createAgentBindingDirectory({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: accounts.map((account, index) => ({ id: `qq-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.filter(target => !removed.has(conversationAddressKey(target))).map(target => ({
      connectionId: `qq-${accounts.findIndex(account => platformAccountKey(account) === platformAccountKey(target.account))}`,
      kind: target.kind, conversationId: target.id, agentId: target === otherRoleGroup ? 'other' : 'daily',
    })),
  }, revision)
}

function createHost(redis, settings = {}) {
  let directory = bindings(), enabled = settings.enabled ?? true, clock = Date.now(), sequence = 0, memberCalls = 0
  const receives = new Map(), sources = new Map(), requests = [], sends = [], attempts = [], uploads = [], diagnostics = [], observations = []
  const store = createAgentGroupLogStore(redis.storage), inbox = createAgentInbox(redis.storage)
  const queueKeys = accounts.flatMap(account => ['group-log', 'group-text', 'private', 'privacy', 'simulation']
    .map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`))
  const f = {
    ...redis, store, inbox, sources, requests, sends, attempts, uploads, diagnostics, observations,
    binding: target => directory.resolve(target),
    owner: (target = group, agentId = directory.resolve(target)?.agentId ?? 'daily') => ({ target, agentId }),
    setEnabled(value) { enabled = value },
    unbind(target) { directory = bindings('group-log-unbound', new Set([conversationAddressKey(target)])) },
    get memberCalls() { return memberCalls },
    get now() { return clock },
    message(target, id, text, extra = {}) {
      return { version: 1, conversation: target, sender: author, senderName: '原始群昵称', messageId: id,
        occurredAt: ++clock, text, parts: text ? [{ kind: 'text', text }] : [], mentions: [], directedToAccount: false, ...extra }
    },
    async emit(message) {
      sources.set(keyOf(message.conversation, message.messageId), structuredClone(message))
      await receives.get(platformAccountKey(message.conversation.account))({ kind: 'message', message })
    },
    async recall(target, messageId) { await receives.get(platformAccountKey(target.account))({ kind: 'recall', target, messageId }) },
    async drained() {
      // Source -> destination forwarding is atomic; inspect every known queue in
      // the same Redis operation so a newly created destination cannot be missed.
      await waitFor(async () => Number(await redis.reader.eval(
        "local total = 0; for _, key in ipairs(KEYS) do total = total + redis.call('LLEN', key) end; return total",
        { keys: queueKeys, arguments: [] })) === 0,
      'all Core inboxes to acknowledge', () => JSON.stringify(diagnostics.slice(-8)))
      await host.runtime.drain()
    },
    async send(target, id, text, extra = {}) {
      const message = f.message(target, id, text, extra)
      await f.emit(message); await f.drained(); return message
    },
    async rows(target = group, agentId) {
      const owner = f.owner(target, agentId), state = await store.read(owner)
      const snapshots = await Promise.all(state.logs.map(log => store.snapshot(owner, log.id)))
      return snapshots.flatMap(snapshot => snapshot.sourceRows)
    },
    async seed(target, { agentId = directory.resolve(target)?.agentId ?? 'daily', id = `seed-${++sequence}`, subject = author, text = '独立归属的正文', ended = false } = {}) {
      const owner = { target, agentId }, state = await store.read(owner)
      if (!state.active) await store.command(owner, `${id}-start`, { kind: 'start', title: id }, ++clock)
      await store.append(owner, { messageId: id, authorId: subject.id, occurredAt: ++clock, name: '成员', content: text }, await store.capture(owner, subject.id))
      if (ended) await store.command(owner, `${id}-stop`, { kind: 'stop' }, ++clock)
      return owner
    },
  }
  const adapters = accounts.map((account, index) => {
    let ready = false
    return { id: `qq-${index}`, account, botUserId: account.id, botName: '团录验收',
      isReady: () => ready,
      async start(accept) { ready = true; receives.set(platformAccountKey(account), accept) },
      stop() { ready = false },
      async readMessage(target, id, guard) {
        if (guard?.isCurrent?.() === false) return undefined
        return structuredClone(sources.get(keyOf(target, id)))
      },
      async readConversationMember(target, user, guard) {
        memberCalls++
        const result = await settings.member?.({ target, user, guard, call: memberCalls, f })
        return result ?? { target, observedAt: Date.now(), member: { user, displayName: '当前管理员', role: 'admin' } }
      },
      async readMediaShare() { observations.push('read-media'); return undefined },
      actions: {
        async send(action, guard) {
          attempts.push(structuredClone(action))
          await settings.beforeSend?.(f, action, guard)
          if (!guard?.isCurrent?.()) return { state: 'failed', code: 'stale' }
          sends.push(structuredClone(action)); return { state: 'sent', messageId: `sent-${++sequence}` }
        },
        async sendGroupLog(action, guard) {
          if (!guard?.isCurrent?.()) return { state: 'failed', code: 'stale' }
          uploads.push(structuredClone(action))
          return settings.upload ? settings.upload(f, action, guard) : { state: 'uploaded', fileId: `file-${++sequence}` }
        },
      },
    }
  })
  const host = createAgentRuntime({ storage: redis.storage, adapters, isExecutionCurrent: redis.isCurrent, now: () => clock,
    groupLog: { enabled: true, ...(settings.masters ? { masters: settings.masters } : {}) },
    logger: { info() {}, warn: (...args) => diagnostics.push(args.join(' ')), error: (...args) => diagnostics.push(args.join(' ')) },
    privateChatEnabled: true, useTextGroup: target => target.kind === 'group',
    resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '团录验收' }, systemContent: '测试角色' } },
    getSection: () => ({ enabled, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
      personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
    getExecutionConfig: () => ({}),
    ...(settings.media ? { mediaRelay: { enabled: true }, mediaRelayProvider: { async prepare() { observations.push('prepare-media'); return { state: 'failed', code: 'fixture' } } } } : {}),
    async YTapi(request, config, signal, current, ensureCurrent) {
      requests.push(structuredClone(request))
      return settings.model ? settings.model(f, { request, config, signal, isCurrent: current, ensureCurrent }) : answer('只回应当前新消息。')
    },
  })
  f.host = host
  return f
}

async function fixture(t, settings = {}) {
  let f
  t.after(async () => { settings.release?.(); await f?.host.stop() })
  const redis = await createAgentRedisFixture(t, 'group-log-runtime')
  f = createHost({ ...redis, storage: settings.wrapStorage?.(redis.storage) ?? redis.storage }, settings)
  if (settings.start !== false) await f.host.start()
  return f
}

if (process.env.BL_GROUP_LOG_CRASH_CHILD === '1') {
  const reader = await connectAgentRedis(process.env.BL_GROUP_LOG_REDIS_URL)
  const prefix = process.env.BL_GROUP_LOG_REDIS_PREFIX
  const storage = {
    get: key => reader.get(prefix + key),
    set: (key, value, options) => reader.set(prefix + key, value, options),
    del: (...keys) => reader.del(keys.map(key => prefix + key)),
    eval: (script, options) => reader.eval(script, { ...options, keys: options.keys.map(key => prefix + key) }),
    async *scanIterator(options) { for await (const keys of reader.scanIterator({ ...options, MATCH: prefix + options.MATCH })) yield keys.map(key => key.slice(prefix.length)) },
    async keys(pattern) { return (await reader.keys(prefix + pattern)).map(key => key.slice(prefix.length)) },
  }
  const f = createHost({ storage, reader, prefix, isCurrent: () => reader.isReady }, { enabled: false,
    upload(current) {
      process.stdout.write(JSON.stringify([...current.sources.values()]), () => process.exit(0))
      return new Promise(() => {})
    },
  })
  await f.host.start()
  await f.send(group, 'crash-on', '.log on 崩溃恢复')
  await f.send(group, 'crash-body', '进程退出前已经录下的正文')
  await f.emit(f.message(group, 'crash-export', '.log export'))
} else {
  test('Core admits .log before ordinary AI filters, records real sources once, and never resolves silent media', redisTest, async t => {
    const f = await fixture(t, { enabled: false, media: true })
    await f.send(group, 'on', '.log on 周末团')
    const occurredAt = f.now - 1234
    const original = await f.send(group, 'source', '.普通前缀消息', { occurredAt, parts: [
      { kind: 'text', text: '.普通前缀消息' },
      { kind: 'image', resource: { kind: 'url', value: 'https://private.invalid/image?secret' } },
      { kind: 'audio', resource: { kind: 'reference', value: '/private/audio' } },
      { kind: 'video', resource: { kind: 'url', value: 'https://private.invalid/video' } },
      { kind: 'file', name: '团本.pdf', resource: { kind: 'reference', value: 'private-file' } },
    ] })
    await f.emit(original); await f.drained()
    await f.send(group, 'share', 'https://www.bilibili.com/video/BV1xx411c7mD', { directedToAccount: true })
    await f.send(group, 'hash', '#普通AI会过滤的文字')
    const rows = await f.rows()
    assert.equal(rows.length, 3); assert.equal(rows[0].messageId, 'source'); assert.equal(rows[0].occurredAt, occurredAt)
    assert.equal(rows[0].content, '.普通前缀消息[图片][语音][视频][文件：团本.pdf]')
    assert.doesNotMatch(JSON.stringify(rows), /private\.invalid|private-file|\/private/u)
    assert.equal(f.requests.length, 0); assert.deepEqual(f.observations, [])
    assert.equal((await f.store.read(f.owner())).active, true)
    assert.equal(f.sends.length, 1, 'the command confirmation bypasses ordinary AI disable')
  })

  test('off restores only future AI turns and never replays silent recorded messages into a model', redisTest, async t => {
    const f = await fixture(t)
    await f.send(group, 'on', '.log on')
    await f.send(group, 'silent-old', '旧消息绝不能补答', { directedToAccount: true })
    assert.equal(f.requests.length, 0)
    await f.send(group, 'off', '.log off')
    await f.send(group, 'future', '恢复之后的新问题', { directedToAccount: true })
    await waitFor(() => f.requests.length === 1 && f.sends.some(action => action.replyTo === 'future'), 'new future model turn and confirmed reply')
    assert.equal(f.requests.length, 1)
    assert.ok(JSON.stringify(f.requests).includes('恢复之后的新问题'))
    assert.ok(!JSON.stringify(f.requests).includes('旧消息绝不能补答'))
    assert.equal(f.sends.filter(action => action.replyTo === 'silent-old').length, 0)
    assert.equal(f.sends.filter(action => action.replyTo === 'future').length, 1)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['silent-old'])
  })

  test('跑团AI commands inspect and switch current group activity while recording continues', redisTest, async t => {
    const f = await fixture(t)
    await f.send(group, 'on', '.log on')
    await f.send(group, 'status-off', '.骰娘 跑团AI 状态')
    assert.match(f.sends.at(-1).parts[0].text, /静默/u)
    await f.send(group, 'ai-on', '.骰娘 跑团AI 开')
    await f.send(group, 'awake', '现在可以回答', { directedToAccount: true })
    await waitFor(() => f.requests.length === 1 && f.sends.some(action => action.replyTo === 'awake'), 'AI-enabled model turn and confirmed reply')
    assert.equal(f.requests.length, 1)
    await f.send(group, 'ai-off', '.骰娘 跑团AI 关')
    await f.send(group, 'silent', '重新保持静默', { directedToAccount: true })
    await f.send(group, 'status-again', '.骰娘 跑团AI 状态')
    assert.match(f.sends.at(-1).parts[0].text, /静默/u)
    assert.equal(f.requests.length, 1)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['awake', 'silent'])
  })

  test('Core exports current, history index and exact title in TXT and HTML; end always emits TXT', redisTest, async t => {
    const f = await fixture(t)
    await f.send(group, 'old-on', '.log on 旧团 完整标题')
    await f.send(group, 'old-body', '历史团完整正文')
    await f.send(group, 'old-off', '.log off')
    await f.send(group, 'new-on', '.log on 新团')
    await f.send(group, 'new-body', '当前团完整正文')
    await f.send(group, 'list', '.log list')
    assert.match(f.sends.at(-1).parts[0].text, /1\. 旧团 完整标题/u)
    let index = 0
    for (const [selector, expected, excluded] of [['', '当前团完整正文', '历史团完整正文'], ['1', '历史团完整正文', '当前团完整正文'], ['旧团 完整标题', '历史团完整正文', '当前团完整正文']]) {
      for (const format of ['', ' html']) {
        const message = await f.send(group, `export-${++index}`, `.log export${selector ? ' ' + selector : ''}${format}`)
        const upload = f.uploads.at(-1), body = Buffer.from(upload.log.base64, 'base64').toString('utf8')
        assert.equal(f.uploads.length, index); assert.ok(body.includes(expected)); assert.ok(!body.includes(excluded))
        assert.equal(upload.log.mime, format ? 'text/html' : 'text/plain')
        assert.deepEqual(upload.target, group); assert.equal(upload.source.messageId, message.messageId)
        assert.equal(upload.source.occurredAt, message.occurredAt)
        assert.equal(upload.source.textSha256, createHash('sha256').update(message.text).digest('hex'))
        await f.emit(message); await f.drained(); assert.equal(f.uploads.length, index)
      }
    }
    await f.send(group, 'end', '.log end html')
    assert.equal(f.uploads.length, 7); assert.equal(f.uploads.at(-1).log.mime, 'text/plain')
    assert.equal((await f.store.read(f.owner())).active, false)
  })

  test('fresh member evidence rejects downgrade and stale observations before committing a command', redisTest, async t => {
    for (const mode of ['downgrade', 'stale']) await t.test(mode, async t => {
      const f = await fixture(t, { member({ target, user, call }) {
        return { target, observedAt: mode === 'stale' ? Date.now() - 60_000 : Date.now(),
          member: { user, displayName: '成员', role: mode === 'downgrade' && call > 1 ? 'member' : 'admin' } }
      } })
      await f.send(group, 'denied', '.log on')
      assert.equal((await f.store.read(f.owner())).active, false)
      assert.match(f.sends.at(-1).parts[0].text, /主人|管理员/u)
      await f.send(group, 'still-awake', '拒绝命令后仍可回答', { directedToAccount: true })
      await waitFor(() => f.requests.length === 1 && f.sends.some(action => action.replyTo === 'still-awake'), 'denied command to leave subsequent AI available')
      assert.equal(f.requests.length, 1)
    })
  })

  test('trusted host masters authorize without a platform administrator observation', redisTest, async t => {
    const f = await fixture(t, { masters: [author], member() { assert.fail('trusted master must not need platform administrator evidence') } })
    await f.send(group, 'on', '.log on')
    await f.send(group, 'status', '.log status')
    assert.equal((await f.store.read(f.owner())).active, true); assert.equal(f.memberCalls, 0)
    assert.match(f.sends.at(-1).parts[0].text, /记录中/u)
  })

  test('a quoted log command stays non-standalone even when its quote has no message ID', redisTest, async t => {
    const f = await fixture(t)
    for (const [id, quote] of [['missing-quote-id', { parts: [] }], ['known-quote-id', { messageId: 'original', parts: [] }]]) {
      await f.send(group, id, '.log on 引用命令不得启动', { quote })
      assert.equal((await f.store.read(f.owner())).active, false, 'quote normalization must preserve the command restriction')
      assert.match(f.sends.at(-1).parts[0].text, /单独发送|引用/u)
    }
    assert.equal(f.memberCalls, 0); assert.equal(f.requests.length, 0)
  })

  test('group privacy physically deletes only own active and ended rows within the original Agent, account and group', redisTest, async t => {
    const f = await fixture(t)
    await f.send(group, 'old-on', '.log on 历史')
    await f.send(group, 'old-self', '历史本人资料')
    await f.send(group, 'old-other', '历史他人资料', { sender: otherAuthor })
    await f.send(group, 'old-off', '.log off')
    await f.send(group, 'new-on', '.log on 当前')
    await f.send(group, 'new-self', '当前本人资料')
    await f.seed(otherGroup, { id: 'different-group' })
    await f.seed(group, { agentId: 'other', id: 'different-agent' })
    await f.seed(otherAccountGroup, { id: 'different-account' })
    await f.send(group, 'forget', privacy.forget)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['old-other'])
    assert.equal((await f.rows(otherGroup)).length, 1)
    assert.equal((await f.rows(group, 'other')).length, 1)
    assert.equal((await f.rows(otherAccountGroup)).length, 1)
    assert.equal(f.requests.length, 0, 'privacy remains a direct control while the log is silent')
    assert.match(f.sends.at(-1).parts[0].text, /已清空/u)
  })

  test('private global privacy erases the same person across current Agent groups and blocks later recording', redisTest, async t => {
    const f = await fixture(t)
    await f.seed(group, { id: 'self-a', ended: true })
    await f.seed(group, { id: 'other-a', subject: otherAuthor })
    await f.seed(otherGroup, { id: 'self-b' })
    await f.seed(otherRoleGroup, { id: 'other-role' })
    await f.seed(otherAccountGroup, { id: 'other-account' })
    await f.send(privateRoom, 'disable-global', privacy.disable)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['other-a'])
    assert.deepEqual(await f.rows(otherGroup), [])
    assert.equal((await f.rows(otherRoleGroup)).length, 1)
    assert.equal((await f.rows(otherAccountGroup)).length, 1)
    await f.send(group, 'after-disable', '禁用后不能再次记录本人')
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['other-a'])
    await f.send(group, 'management-still-works', '.log status')
    assert.match(f.sends.at(-1).parts[0].text, /团录状态/u)
    assert.equal(f.requests.length, 0)
  })

  test('recall purges every Agent/log copy after unbinding and prevents a late append of the revoked source', redisTest, async t => {
    const f = await fixture(t)
    await f.send(group, 'on', '.log on')
    await f.send(group, 'recalled', '跨归属撤回正文')
    const secondOwner = await f.seed(group, { agentId: 'other', id: 'recalled', ended: true })
    await f.seed(group, { agentId: 'other', id: 'recalled', text: '新团同一来源的副本' })
    const epochs = await f.store.capture(secondOwner, author.id)
    f.unbind(group)
    await f.recall(group, 'recalled'); await f.drained()
    assert.deepEqual(await f.rows(group, 'daily'), [])
    assert.deepEqual(await f.rows(group, 'other'), [])
    assert.equal(await f.store.append(secondOwner, { messageId: 'recalled', authorId: author.id, occurredAt: f.now,
      name: '成员', content: '迟到副本' }, epochs), false)
  })

  test('log on cancels the current group model and late send without cancelling another group turn', redisTest, async t => {
    for (const stage of ['model', 'send']) await t.test(stage, async t => {
      const reached = deferred(), release = deferred(), secondReached = deferred(), secondRelease = deferred()
      let pending, secondPending, phase = 'first'
      const f = await fixture(t, {
        release() { release.resolve(); secondRelease.resolve() },
        async model(_f, context) {
          if (stage === 'model' && phase === 'first') { pending = context; reached.resolve(); await release.promise }
          if (phase === 'second') { secondPending = context; secondReached.resolve(); await secondRelease.promise }
          return answer('模型迟到的回复')
        },
        async beforeSend(_f, action, guard) {
          if (stage === 'send' && action.replyTo === 'pending-a') { pending = guard; reached.resolve(); await release.promise }
        },
      })
      await f.emit(f.message(group, 'pending-a', '第一群待完成的模型', { directedToAccount: true }))
      await reached.promise
      await f.emit(f.message(group, 'on-a', '.log on'))
      await waitFor(() => !pending.isCurrent(), 'target group cancellation')
      if (stage === 'model') assert.equal(pending.signal.aborted, true)
      release.resolve(); await f.drained()
      assert.equal(f.sends.filter(action => action.replyTo === 'pending-a').length, 0)
      phase = 'second'
      await f.emit(f.message(otherGroup, 'pending-b', '另一个群应继续完成', { directedToAccount: true }))
      await secondReached.promise
      await f.emit(f.message(group, 'on-a-again', '.log on'))
      await waitFor(() => f.sends.some(action => action.replyTo === 'on-a-again'), 'second start confirmation')
      assert.equal(secondPending.isCurrent(), true); assert.equal(secondPending.signal.aborted, false)
      secondRelease.resolve(); await f.drained()
      assert.equal(f.sends.filter(action => action.replyTo === 'pending-b').length, 1)
    })
  })

  test('a duplicate old on command after off cannot leave an eager silence reservation behind', redisTest, async t => {
    const f = await fixture(t)
    const start = await f.send(group, 'on', '.log on 唯一团')
    await f.send(group, 'off', '.log off')
    await f.emit(start); await f.drained()
    await f.send(group, 'future', '重复旧命令之后的新消息', { directedToAccount: true })
    await waitFor(() => f.requests.length === 1 && f.sends.some(action => action.replyTo === 'future'), 'new reply after the duplicate old start')
    assert.equal(f.requests.length, 1)
    assert.equal(f.sends.filter(action => action.replyTo === 'future').length, 1)
    assert.equal((await f.store.read(f.owner())).active, false)
    assert.equal((await f.store.read(f.owner())).logs.length, 1)
  })

  test('an empty older consumer cannot clear silence while a newly authorized start is still being admitted', redisTest, async t => {
    const releaseEmpty = deferred(), releaseCapture = deferred()
    let armEmpty = false, emptyHeld = false, emptyHeads = 0, armCapture = false, captureHeld = false
    const groupLogKey = `agent:inbox:group-log:${platformAccountKey(group.account)}`
    const f = await fixture(t, {
      release() { releaseEmpty.resolve(); releaseCapture.resolve() },
      wrapStorage(storage) {
        return { ...storage, async eval(script, options) {
          const result = await storage.eval(script, options)
          if (armEmpty && options.keys[0] === groupLogKey && script === "return redis.call('LINDEX', KEYS[1], 0)" && result === null) {
            emptyHeads++
            if (!emptyHeld) { emptyHeld = true; await releaseEmpty.promise }
          }
          if (armCapture && script.includes("return {hashCounter(root .. ':globalEpochs', ARGV[5]), hashCounter(root .. ':sceneEpochs', ARGV[6])}")) {
            armCapture = false; captureHeld = true; await releaseCapture.promise
          }
          return result
        } }
      },
    })
    armEmpty = true
    await waitFor(async () => { await f.host.resumePendingWork(); return emptyHeld }, 'an old empty group-log consumer')
    armCapture = true
    const admission = f.emit(f.message(group, 'admitting-on', '.log on 入队过程仍需静默'))
    try {
      await waitFor(() => captureHeld, 'authorized start to reserve silence before its delayed epoch capture returns')
      releaseEmpty.resolve()
      await waitFor(async () => { await f.host.resumePendingWork(); return emptyHeads >= 2 }, 'old consumer to finish empty-queue cleanup')
      const old = f.message(group, 'queued-ai-during-admission', '静默预约未入队时也不能启动旧AI', { directedToAccount: true })
      await f.inbox.accept({ event: { kind: 'message', message: old }, bindingToken: agentBindingToken(f.binding(group)) }, { account: group.account, kind: 'group' })
      await f.host.resumePendingWork()
      await waitFor(async () => await f.reader.lLen(f.prefix + `agent:inbox:group-text:${platformAccountKey(group.account)}`) === 0,
        'older AI inbox to be acknowledged under the admission fence')
      assert.equal(f.requests.length, 0, 'empty-queue cleanup must retain a reservation whose start is still admitting')
      assert.equal(f.sends.filter(action => action.replyTo === old.messageId).length, 0)
    } finally { releaseEmpty.resolve(); releaseCapture.resolve(); await admission }
    await f.drained()
    assert.equal((await f.store.read(f.owner())).active, true)
    assert.equal(f.sends.filter(action => action.replyTo === 'admitting-on').length, 1)
  })

  test('startup finishes pending privacy deletion before exporting a recovered group-log command', redisTest, async t => {
    const f = await fixture(t, { start: false })
    await f.seed(group, { id: 'must-delete-first', text: '先前已请求删除的本人正文' })
    await f.seed(group, { id: 'must-retain', subject: otherAuthor, text: '另一位群友仍授权保留的正文' })
    const binding = f.binding(group), owner = f.owner()
    const exportMessage = f.message(group, 'pending-export', '.log export', { sender: otherAuthor })
    f.sources.set(keyOf(group, exportMessage.messageId), structuredClone(exportMessage))
    await f.inbox.accept({ event: { kind: 'message', message: exportMessage }, bindingToken: agentBindingToken(binding) }, undefined, undefined,
      { kind: 'group-log', groupLog: { agentId: binding.agentId, ...await f.store.capture(owner, otherAuthor.id) } })
    const deleteMessage = f.message(group, 'pending-privacy', privacy.forget)
    await f.inbox.accept({ event: { kind: 'message', message: deleteMessage }, bindingToken: agentBindingToken(binding),
      privacyCommand: 'forget', privacyOwner: { agentId: binding.agentId } })
    await f.host.start(); await f.drained()
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['must-retain'])
    assert.equal(f.uploads.length, 1)
    const content = Buffer.from(f.uploads[0].log.base64, 'base64').toString('utf8')
    assert.ok(content.includes('另一位群友仍授权保留的正文'))
    assert.ok(!content.includes('先前已请求删除的本人正文'), 'the recovered export must snapshot after physical deletion')
    assert.equal(f.requests.length, 0)
  })

  test('startup consumes pending group-log controls before admitting recovered ordinary AI work', redisTest, async t => {
    const f = await fixture(t, { start: false })
    const binding = f.binding(group), owner = f.owner(), start = f.message(group, 'recovered-on', '.log on 启动恢复')
    const body = f.message(group, 'recovered-body', '启动前已进入团录的正文', { directedToAccount: true })
    for (const message of [start, body]) {
      f.sources.set(keyOf(group, message.messageId), structuredClone(message))
      await f.inbox.accept({ event: { kind: 'message', message }, bindingToken: agentBindingToken(binding) }, undefined, undefined,
        { kind: 'group-log', groupLog: { agentId: binding.agentId, ...await f.store.capture(owner, message.sender.id) } })
    }
    const old = f.message(group, 'old-ai', '旧AI队列不能在团录恢复之前抢跑', { directedToAccount: true })
    await f.inbox.accept({ event: { kind: 'message', message: old }, bindingToken: agentBindingToken(binding) }, { account: group.account, kind: 'group' })
    await f.host.start(); await f.drained()
    assert.equal((await f.store.read(owner)).active, true)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['recovered-body'])
    assert.equal(f.requests.length, 0); assert.equal(f.sends.filter(action => action.replyTo === 'old-ai').length, 0)
    await f.send(group, 'off', '.log off')
    await f.send(group, 'new-ai', '恢复后只答新消息', { directedToAccount: true })
    await waitFor(() => f.requests.length === 1 && f.sends.some(action => action.replyTo === 'new-ai'), 'new reply after startup backlog restoration')
    assert.equal(f.requests.length, 1); assert.ok(!JSON.stringify(f.requests).includes('旧AI队列'))
  })

  test('a real process exit during pending upload recovers unknown without uploading again', redisTest, async t => {
    let f
    t.after(() => f?.host.stop())
    const redis = await createAgentRedisFixture(t, 'group-log-runtime-crash')
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, BL_GROUP_LOG_CRASH_CHILD: '1', BL_GROUP_LOG_REDIS_URL: redis.url, BL_GROUP_LOG_REDIS_PREFIX: redis.prefix },
      encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(child.status, 0, `child failed: ${child.error?.message ?? child.stderr}`)
    const sources = JSON.parse(child.stdout)
    const commandHashes = await redis.reader.keys(redis.prefix + 'agent:group-log:v1:owner:*:commands')
    assert.equal(commandHashes.length, 1)
    const persistedDelivery = async () => JSON.parse(await redis.reader.hGet(commandHashes[0], 'crash-export')).delivery
    assert.equal(await persistedDelivery(), 'pending', 'observe raw receipt without triggering another process\'s recovery')
    assert.equal(await redis.reader.lLen(redis.prefix + `agent:inbox:group-log:${platformAccountKey(group.account)}`), 1)
    f = createHost(redis)
    for (const message of sources) f.sources.set(keyOf(message.conversation, message.messageId), message)
    await f.host.start(); await f.drained()
    assert.equal(await persistedDelivery(), 'unknown')
    assert.equal(f.uploads.length, 0); assert.equal(f.requests.length, 0)
    await f.emit(sources.find(message => message.messageId === 'crash-export')); await f.drained()
    assert.equal(f.uploads.length, 0)
    assert.deepEqual((await f.rows()).map(row => row.messageId), ['crash-body'])
  })
}
