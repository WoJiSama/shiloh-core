import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createConversationMemoryStore, conversationMemoryId } from '../dist/backend/modules/memory/infrastructure/conversationMemoryStore.js'
import { personMemoryCommandText as commands } from '../dist/backend/modules/memory/domain/personMemoryCommands.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const accounts = ['bot-a', 'bot-b'].map(id => ({ platform: 'fixture', namespace: 'conversation-memory', id }))
const actor = { platform: 'fixture', namespace: 'conversation-memory', id: 'speaker-a' }
const otherActor = { ...actor, id: 'speaker-b' }
const group = { account: accounts[0], kind: 'group', id: 'text-room-a' }
const otherGroup = { ...group, id: 'text-room-b' }
const otherRoleGroup = { ...group, id: 'text-room-other-role' }
const otherAccountGroup = { ...group, account: accounts[1] }
const simulationGroup = { ...group, id: 'simulation-room' }
const privateRoom = { account: accounts[0], kind: 'private', id: 'private-room-id' }
const otherPrivateRoom = { ...privateRoom, id: 'another-private-room' }
const targets = [group, otherGroup, otherRoleGroup, otherAccountGroup, simulationGroup, privateRoom, otherPrivateRoom]

async function waitFor(probe, description, timeoutMs = 6500) {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const value = await probe()
    if (value) return value
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}

function makeDirectory(revision = 'conversation-memory-v1', replacements = new Map()) {
  return createAgentBindingDirectory({
    version: 1,
    agents: [{ id: 'role', personaId: 'shared' }, { id: 'other', personaId: 'shared' }],
    connections: accounts.map((account, index) => ({ id: `fixture-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map(target => ({
      connectionId: `fixture-${accounts.findIndex(account => platformAccountKey(account) === platformAccountKey(target.account))}`,
      kind: target.kind, conversationId: target.id,
      agentId: replacements.get(conversationAddressKey(target)) ?? (target === otherRoleGroup ? 'other' : 'role'),
    })),
  }, revision)
}

const textOf = request => JSON.stringify(request.messages)
const dataText = request => request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')

async function withFixture(t, options, run) {
  const redis = await createAgentRedisFixture(t, options.name ?? 'agent-conversation-memory')
  const storage = options.wrapStorage?.(redis.storage) ?? redis.storage
  const clock = { at: Date.now() }
  const requests = [], summaries = [], deliveries = [], attempts = [], tokens = [], warnings = [], hosts = []
  const peers = new Map([privateRoom, otherPrivateRoom].map(target => [conversationAddressKey(target), actor]))
  const personas = new Map([['role', { name: 'Test bot', style: 'version-one' }], ['other', { name: 'Test bot', style: 'other-role' }]])
  const memory = createConversationMemoryStore(storage)
  let directory = makeDirectory()
  let current
  const fixture = {
    ...redis, storage, clock, requests, summaries, deliveries, attempts, tokens, warnings, personas,
    binding: target => directory.resolve(target),
    state: target => memory.load(conversationMemoryId(directory.resolve(target))),
    session: target => redis.reader.get(redis.prefix + simulationSessionKey(simulationAddressKey(target))).then(value => value ? JSON.parse(value) : undefined),
    rawStates: () => memory.list(),
    rebind(revision, replacements) { directory = makeDirectory(revision, replacements) },
    setPeer(target, peer) { peers.set(conversationAddressKey(target), peer) },
    async drained(target, kind) {
      const mode = kind ?? (target.kind === 'private' ? 'private' : target === simulationGroup ? 'simulation' : 'group-text')
      await waitFor(() => redis.reader.lLen(redis.prefix + `agent:inbox:${mode}:${platformAccountKey(target.account)}`).then(length => length === 0), `${mode} inbox drained`)
    },
    event(target, id, text, overrides = {}) {
      return { kind: 'message', message: {
        version: 1, conversation: target, sender: actor, senderName: '来源作者', messageId: id,
        occurredAt: clock.at, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: target !== simulationGroup,
        ...overrides,
      } }
    },
    async emit(event) {
      const target = event.kind === 'message' ? event.message.conversation : event.target
      return current.receive.get(platformAccountKey(target.account))(event)
    },
    async send(target, id, text, overrides) {
      clock.at++
      await fixture.emit(fixture.event(target, id, text, overrides))
      await fixture.drained(target)
    },
    async batch(target, prefix, count = 4, overrides) {
      for (let index = 1; index <= count; index++) await fixture.send(target, `${prefix}-${index}`, `${prefix}真实来源第${index}条`, overrides)
    },
    async tick(ms = 0) { clock.at += ms; await current.host.resumePendingWork() },
    async summary(target, count = 1) {
      return waitFor(async () => {
        const state = await fixture.state(target)
        const call = summaries.filter(row => conversationAddressKey(row.context.target) === conversationAddressKey(target))[count - 1]
        const last = call?.input.messages.at(-1)
        const covered = last && state?.records.findLast(row => row.at === last.at && row.authorId === last.authorId && row.text === last.text)?.seq
        return state?.summary && covered !== undefined && state.summary.coveredSeq >= covered && state.summary
      }, `summary committed for ${target.id}`)
    },
    async prompt(target, id, text, overrides) {
      const before = requests.length
      await fixture.send(target, id, text, overrides)
      return waitFor(() => requests.slice(before).find(request => textOf(request).includes(text)), `prompt for ${id}`)
    },
    async start() {
      const receive = new Map()
      const adapters = accounts.map((account, index) => {
        let ready = false
        return {
          id: `fixture-${index}`, account, botUserId: `bot-user-${index}`, botName: 'Test bot',
          resolvePrivatePeer: target => peers.get(conversationAddressKey(target)),
          actions: { async send(action, guard) {
            attempts.push(action)
            if (!guard?.isCurrent?.()) return { state: 'failed', code: 'scope_changed' }
            const receipt = options.send ? await options.send(action, guard) : { state: 'sent', messageId: `sent-${attempts.length}` }
            if (receipt.state === 'sent') deliveries.push({ action, receipt })
            return receipt
          } },
          async start(accept) { receive.set(platformAccountKey(account), accept); ready = true },
          isReady: () => ready,
          stop() { ready = false },
        }
      })
      const host = createAgentRuntime({
        storage, adapters, now: () => clock.at, isExecutionCurrent: redis.isCurrent,
        logger: { info() {}, warn: message => warnings.push(message), error() {} },
        privateChatEnabled: true, useTextGroup: target => target.kind === 'group' && target !== simulationGroup && target.id !== simulationGroup.id,
        midtermMemory: Object.hasOwn(options, 'midtermMemory') ? options.midtermMemory : { enabled: true, minMessages: 4, debounceMs: 5000 },
        episodicMemory: Object.hasOwn(options, 'episodicMemory') ? options.episodicMemory : { enabled: true },
        resolvePersona(target) {
          const binding = directory.resolve(target)
          return binding && { binding, persona: personas.get(binding.agentId), systemContent: '固定身份文字' }
        },
        getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false },
          mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
          wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000, triggers: { question: false, nameMention: false, anyMessage: false } },
          turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
        getExecutionConfig: () => ({}),
        recordTokens: input => tokens.push(input),
        async YTapi(request, ...args) {
          requests.push(request)
          if (options.model) return await options.model(request, ...args)
          if (request.tools?.some(tool => tool.function?.name === 'simFinishTurn')) return { choices: [{ message: { content: '', tool_calls: [
            { id: `finish-${requests.length}`, type: 'function', function: { name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '摘要测试仅收集真实入站' }) } },
          ] } }] }
          return { choices: [{ message: { content: '已经收到这次消息。' } }] }
        },
        ...((Object.hasOwn(options, 'summarize') && options.summarize === undefined) ? {} : {
          async summarizeConversation(input, context) {
            summaries.push({ input, context })
            return options.summarize ? await options.summarize(input, context)
              : `主线结果${summaries.length}：${input.previous}${input.messages.map(row => row.text).join('；')}`.slice(0, input.maxChars)
          },
        }),
      })
      current = { host, receive }
      hosts.push(host)
      await host.start()
    },
    async stop() { await current?.host.stop() },
    async drainSimulation() { await current.host.runtime.drain() },
  }
  try {
    await fixture.start()
    await run(fixture)
  } finally {
    options.release?.()
    await Promise.all(hosts.map(host => host.stop()))
  }
}

test('summary scheduling needs its model port and an enabled group feature, and private messages never become group summaries', redisTest, async t => {
  for (const [name, config] of [
    ['summary-no-port', { summarize: undefined }],
    ['summary-disabled', { midtermMemory: { enabled: false }, episodicMemory: { enabled: false } }],
  ]) {
    await withFixture(t, { name, ...config }, async f => {
      await f.batch(group, name)
      await f.batch(privateRoom, `${name}-private`)
      await f.tick(90_000)
      assert.equal(f.summaries.length, 0)
      assert.equal((await f.state(group))?.summary, undefined)
      if (name === 'summary-disabled') assert.deepEqual((await f.state(group))?.episodes ?? [], [])
    })
  }
})

test('unaddressed simulation ingress reaches a fixed debounce summary and rolling updates preserve original source times', redisTest, async t => {
  await withFixture(t, { name: 'summary-unaddressed-simulation', episodicMemory: { enabled: false } }, async f => {
    await f.batch(simulationGroup, '首次来源')
    const original = (await f.state(simulationGroup)).records.map(row => ({ id: row.messageId, at: row.at }))
    await f.tick(4000)
    assert.equal(f.summaries.length, 0)
    await f.send(simulationGroup, '第五来源', '固定防抖窗口内的第五条')
    await f.tick(1001)
    await f.summary(simulationGroup)
    assert.equal(f.summaries.length, 1)
    assert.equal(f.summaries[0].input.previous, '')
    assert.equal(f.summaries[0].input.messages.length, 5)
    assert.deepEqual(f.summaries[0].input.messages.slice(0, 4).map(row => row.at), original.map(row => row.at))
    assert.ok(f.summaries[0].input.messages.every(row => row.authorId === actor.id))
    const first = (await f.state(simulationGroup)).summary.text
    await f.batch(simulationGroup, '第二轮来源')
    await f.tick(5001)
    await waitFor(() => f.summaries.length === 2, 'second rolling summary call')
    assert.equal(f.summaries[1].input.previous, first)
    assert.equal(f.summaries[1].input.messages.length, 4)
    assert.ok(f.summaries[1].input.messages.every(row => row.text.includes('第二轮来源')))
  })
})

test('summary state survives restart but remains bound to its complete account, Agent and conversation', redisTest, async t => {
  await withFixture(t, { name: 'summary-scope-restart', episodicMemory: { enabled: false } }, async f => {
    await f.batch(group, '本群独有摘要材料')
    await f.tick(5001)
    const summary = await f.summary(group)
    for (const target of [otherGroup, otherAccountGroup, otherRoleGroup, privateRoom]) assert.equal((await f.state(target))?.summary, undefined)
    await f.stop()
    await f.start()
    assert.equal((await f.state(group)).summary.text, summary.text)
    for (const [index, target] of [group, otherGroup, otherAccountGroup, otherRoleGroup, privateRoom].entries()) {
      const request = await f.prompt(target, `scope-query-${index}`, `重启后查询当前场景${index}`, { sender: target.kind === 'private' ? actor : otherActor })
      assert.equal(dataText(request).includes(summary.text), target === group)
      assert.equal(request.messages.filter(row => row.role === 'system').some(row => String(row.content).includes(summary.text)), false)
    }
  })
})

test('unaddressed text-group ingress contributes to summaries without generating a reply', redisTest, async t => {
  await withFixture(t, { name: 'summary-unaddressed-text', episodicMemory: { enabled: false } }, async f => {
    await f.batch(group, '未点名的普通群聊', 4, { directedToAccount: false })
    assert.equal((await f.state(group)).records.length, 4)
    assert.equal(f.requests.length, 0)
    assert.equal(f.attempts.length, 0)
    await f.tick(5001)
    const summary = await f.summary(group)
    assert.ok(summary.text.includes('未点名的普通群聊'))
    assert.equal(f.summaries[0].input.messages.length, 4)
    assert.equal(f.attempts.length, 0)
  })
})

test('large buffers summarize the earliest 200 messages without skipping coverage and accept Unicode code-point limits', redisTest, async t => {
  const emojiSummary = '🧭'.repeat(120)
  await withFixture(t, { name: 'summary-large-buffer-unicode', episodicMemory: { enabled: false },
    midtermMemory: { enabled: true, minMessages: 4, debounceMs: 5000, bufferMaxLines: 300, maxSummaryChars: 120 },
    summarize: async () => emojiSummary,
  }, async f => {
    await f.batch(group, '积压来源', 205, { directedToAccount: false })
    assert.equal((await f.state(group)).records.length, 205)
    await f.tick(5001)
    await waitFor(async () => (await f.state(group)).summary?.coveredSeq === 200, 'earliest batch committed')
    assert.equal(f.summaries[0].input.messages.length, 200)
    assert.equal(f.summaries[0].input.messages[0].text, '积压来源真实来源第1条')
    assert.equal(f.summaries[0].input.messages.at(-1).text, '积压来源真实来源第200条')
    assert.equal((await f.state(group)).summary.text, emojiSummary)
    await f.tick(5001)
    await waitFor(async () => (await f.state(group)).summary?.coveredSeq === 205, 'remaining oldest sources committed')
    assert.equal(f.summaries[1].input.previous, emojiSummary)
    assert.deepEqual(f.summaries[1].input.messages.map(row => row.text), Array.from({ length: 5 }, (_, index) => `积压来源真实来源第${index + 201}条`))
    assert.equal(f.attempts.length, 0)
  })
})

test('source recall resets an unstarted summary deadline so a new privacy epoch receives the full debounce', redisTest, async t => {
  await withFixture(t, { name: 'summary-privacy-epoch-debounce', episodicMemory: { enabled: false } }, async f => {
    await f.batch(group, '撤回前来源', 4, { directedToAccount: false })
    assert.ok((await f.state(group)).dueAt > f.clock.at)
    await f.emit({ kind: 'recall', target: group, messageId: '撤回前来源-1' })
    await f.tick(6000)
    assert.equal(f.summaries.length, 0)
    await f.batch(group, '新隐私周期来源', 4, { directedToAccount: false })
    await f.tick(4999)
    assert.equal(f.summaries.length, 0)
    await f.tick(2)
    await f.summary(group)
    assert.equal(f.summaries[0].input.previous, '')
    assert.equal(f.summaries[0].input.messages.length, 4)
    assert.ok(f.summaries[0].input.messages.every(row => row.text.includes('新隐私周期来源')))
  })
})

test('new ingress remains durable while a summary request is pending and only the captured batch becomes covered', redisTest, async t => {
  const held = Promise.withResolvers()
  let calls = 0
  await withFixture(t, { name: 'summary-concurrent-ingress', episodicMemory: { enabled: false }, release: held.resolve,
    summarize: async input => { if (++calls === 1) await held.promise; return `摘要${calls}：${input.messages.map(row => row.text).join('；')}` },
  }, async f => {
    await f.batch(group, '第一批')
    await f.tick(5001)
    await waitFor(() => f.summaries.length === 1, 'first pending summary call')
    await f.batch(group, '并发第二批')
    assert.equal((await f.state(group)).records.length, 8)
    held.resolve()
    await f.summary(group)
    assert.equal((await f.state(group)).summary.coveredSeq, 4)
    await f.tick(5001)
    await waitFor(() => f.summaries.length === 2, 'remaining batch summarized')
    assert.equal(f.summaries[1].input.messages.length, 4)
    assert.ok(f.summaries[1].input.messages.every(row => row.text.includes('并发第二批')))
    await waitFor(async () => (await f.state(group)).summary.coveredSeq === 8, 'second captured batch committed')
  })
})

test('recalling a source from an older rolling batch invalidates the entire aggregate and rebuilds only from new allowed material', redisTest, async t => {
  await withFixture(t, { name: 'summary-old-source-recall', episodicMemory: { enabled: false } }, async f => {
    await f.batch(group, '旧批隐私材料')
    await f.tick(5001)
    await f.summary(group)
    await f.batch(group, '次批摘要材料')
    await f.tick(5001)
    await f.summary(group, 2)
    assert.ok((await f.state(group)).summary.text.includes('旧批隐私材料'))
    await f.emit({ kind: 'recall', target: group, messageId: '旧批隐私材料-1' })
    await f.tick()
    const request = await f.prompt(group, 'after-source-recall', '撤回后查询此群', { sender: otherActor })
    assert.equal(dataText(request).includes('旧批隐私材料'), false)
    assert.equal(dataText(request).includes('次批摘要材料'), false)
    await f.batch(group, '撤回后新材料')
    await f.tick(5001)
    await waitFor(() => f.summaries.length === 3, 'aggregate rebuilt after invalidation')
    assert.equal(f.summaries[2].input.previous, '')
    assert.ok(f.summaries[2].input.messages.every(row => !row.text.includes('旧批隐私材料') && !row.text.includes('次批摘要材料')))
  })
})

test('privacy commands revoke in-flight group summary authority while an independent account may continue', redisTest, async t => {
  const held = Promise.withResolvers()
  await withFixture(t, { name: 'summary-privacy-cancel', episodicMemory: { enabled: false }, release: held.resolve,
    summarize: async (input, context) => { if (platformAccountKey(context.target.account) === platformAccountKey(accounts[0])) await held.promise; return input.messages.map(row => row.text).join('；') },
  }, async f => {
    await f.batch(group, '即将停用的材料')
    await f.tick(5001)
    await waitFor(() => f.summaries.length === 1, 'revocable summary begins')
    const supplied = f.summaries[0].context
    await f.batch(otherAccountGroup, '独立账号的材料')
    await f.tick(5001)
    await f.summary(otherAccountGroup)
    await f.emit(f.event(privateRoom, 'privacy-disable', commands.disable))
    await f.drained(privateRoom, 'privacy')
    assert.equal(supplied.signal.aborted, true)
    assert.equal(supplied.isCurrent(), false)
    await assert.rejects(supplied.ensureCurrent())
    held.resolve()
    await f.tick()
    assert.equal((await f.state(group))?.summary, undefined)
    assert.ok((await f.state(otherAccountGroup)).summary.text.includes('独立账号的材料'))
  })
})

test('recall, rebind and stopping the host discard a late summary without advancing its coverage', redisTest, async t => {
  for (const change of ['recall', 'rebind', 'stop']) {
    const held = Promise.withResolvers()
    await withFixture(t, { name: `summary-cancel-${change}`, episodicMemory: { enabled: false }, release: held.resolve,
      summarize: async () => { await held.promise; return '绝不能提交的迟到摘要' },
    }, async f => {
      await f.batch(group, '待取消来源')
      await f.tick(5001)
      await waitFor(() => f.summaries.length === 1, 'summary begins before cancellation')
      const oldBinding = f.binding(group)
      const context = f.summaries[0].context
      if (change === 'recall') await f.emit({ kind: 'recall', target: group, messageId: '待取消来源-1' })
      if (change === 'rebind') f.rebind('new-revision', new Map([[conversationAddressKey(group), 'other']]))
      if (change === 'stop') await f.stop()
      await waitFor(() => context.signal.aborted, 'summary cancellation signal')
      await assert.rejects(context.ensureCurrent())
      held.resolve()
      if (change !== 'stop') await f.tick()
      const state = (await f.rawStates()).find(row => row.id === conversationMemoryId(oldBinding))
      assert.notEqual(state?.summary?.text, '绝不能提交的迟到摘要')
      assert.equal(context.isCurrent(), false)
    })
  }
})

test('only confirmed ordinary text replies create source-bound episodes and private conversation IDs retain the verified peer', redisTest, async t => {
  let mode = 'unknown'
  await withFixture(t, { name: 'episode-confirmed-only', midtermMemory: { enabled: false },
    send: async () => mode === 'sent' ? { state: 'sent', messageId: 'episode-confirmed-reply' }
      : mode === 'failed' ? { state: 'failed', code: 'transport_failure' } : { state: 'unknown' },
  }, async f => {
    for (const next of ['unknown', 'failed']) {
      mode = next
      await f.send(privateRoom, `episode-${next}`, `未确认的${next}来源`)
      assert.deepEqual((await f.state(privateRoom))?.episodes ?? [], [])
    }
    mode = 'sent'
    const at = f.clock.at + 1
    await f.send(privateRoom, 'episode-user-source', '我讲述本次陶艺课程')
    const episode = (await f.state(privateRoom)).episodes[0]
    assert.ok(episode)
    assert.deepEqual(episode.messageIds, ['episode-user-source'])
    assert.deepEqual(episode.replyIds, ['episode-confirmed-reply'])
    assert.equal(episode.userId, actor.id)
    assert.equal(episode.peerId, actor.id)
    assert.ok(episode.at >= at)
    assert.ok(episode.summary.includes('陶艺课程'))
    assert.ok(episode.reply.includes('已经收到'))
    assert.equal((await f.state(privateRoom)).scope.target.id, privateRoom.id)
    assert.equal((await f.state(otherPrivateRoom))?.episodes.length ?? 0, 0)
  })
})

for (const [scene, target, isolated] of [
  ['group text', group, otherGroup],
  ['verified private peer', privateRoom, otherPrivateRoom],
]) {
  test(`episode timestamps use explicit Beijing time across midnight for ${scene}`, redisTest, async t => {
    const sourceAt = Date.parse('2026-11-14T16:05:00.000Z')
    const marker = `跨午夜来源-${target.kind}-青瓷课程`
    await withFixture(t, { name: `episode-beijing-midnight-${target.kind}`, midtermMemory: { enabled: false } }, async f => {
      f.clock.at = sourceAt - 1
      await f.send(target, 'beijing-midnight-source', marker)
      const episode = (await f.state(target)).episodes[0]
      assert.equal(episode.at, sourceAt)
      assert.deepEqual(episode.messageIds, ['beijing-midnight-source'])
      assert.deepEqual(episode.replyIds, ['sent-1'])
      assert.equal(episode.userId, actor.id)
      assert.equal(episode.source.personaId, 'agent:role')
      if (target.kind === 'private') assert.equal(episode.peerId, actor.id)

      await f.tick(31 * 60_000)
      const request = await f.prompt(target, 'beijing-midnight-recall', '上次那次课程后来怎样')
      const context = dataText(request)
      const line = context.split('\n').find(value => value.includes(marker) && /你回了|你当时回/u.test(value))
      assert.ok(line, 'the actual model request contains the source-bound episode in user data')
      assert.match(line, /2026[-/]11[-/]15[ T]00:05/u)
      assert.match(line, /Asia\/Shanghai|北京时间/u)
      assert.doesNotMatch(line, /2026-11-14T16:05/u)
      assert.equal(request.messages.filter(row => row.role === 'system').some(row => String(row.content).includes(marker)), false)

      const unrelated = await f.prompt(isolated, 'beijing-midnight-other-room', '上次那次课程后来怎样')
      assert.equal(dataText(unrelated).includes(marker), false)
      f.personas.set('role', { name: 'Test bot', style: 'version-two' })
      const changed = await f.prompt(target, 'beijing-midnight-old-persona', '昨天那次课程后来怎样')
      const origin = dataText(changed).split('\n').find(value => value.includes(marker) && /来源角色|当时回复/u.test(value))
      assert.ok(origin)
      assert.match(origin, /来源角色|当时回复/u)
      assert.doesNotMatch(origin, /你回了|你当时回/u)
      assert.match(origin, /2026[-/]11[-/]15[ T]00:05/u)
      assert.match(origin, /Asia\/Shanghai|北京时间/u)
      if (target.kind === 'private') {
        f.setPeer(target, otherActor)
        const replacement = await f.prompt(target, 'beijing-midnight-other-peer', '上次那次课程后来怎样', { sender: otherActor })
        assert.equal(dataText(replacement).includes(marker), false)
      }
    })
  })
}

test('episode recall is scoped user data and distinguishes current persona replies from a prior version', redisTest, async t => {
  await withFixture(t, { name: 'episode-persona-version', midtermMemory: { enabled: false } }, async f => {
    await f.send(privateRoom, 'episode-first', '前一次聊过那门陶艺课程')
    await f.tick(31 * 60_000)
    const first = await f.prompt(privateRoom, 'episode-same-persona', '上次聊过的课程后来怎样')
    assert.ok(dataText(first).includes('【近期情节】'))
    assert.ok(dataText(first).includes('陶艺课程'))
    assert.match(dataText(first), /你回了|你当时回/u)
    assert.equal(first.messages.filter(row => row.role === 'system').some(row => String(row.content).includes('陶艺课程')), false)
    f.personas.set('role', { name: 'Test bot', style: 'version-two' })
    await f.tick(31 * 60_000)
    const changed = await f.prompt(privateRoom, 'episode-other-persona-version', '昨天聊过的课程')
    assert.ok(dataText(changed).includes('陶艺课程'))
    assert.match(dataText(changed), /来源角色|当时回复/u)
    assert.doesNotMatch(dataText(changed), /你回了|你当时回/u)
    const other = await f.prompt(otherPrivateRoom, 'episode-other-room', '上次聊过的课程')
    assert.equal(dataText(other).includes('陶艺课程'), false)
    f.setPeer(privateRoom, otherActor)
    const replacement = await f.prompt(privateRoom, 'episode-new-peer', '上次聊过的课程', { sender: otherActor })
    assert.equal(dataText(replacement).includes('陶艺课程'), false)
  })
})

test('simulation records episodes only after confirmed delivery with inbound and reply provenance', redisTest, async t => {
  for (const receipt of ['unknown', 'sent']) {
    await withFixture(t, { name: `simulation-episode-${receipt}`, midtermMemory: { enabled: false },
      send: async () => receipt === 'sent' ? { state: 'sent', messageId: 'simulation-confirmed-reply' } : { state: 'unknown' },
      model: async request => {
        const finished = request.messages.some(row => row.role === 'tool')
        return { choices: [{ message: { content: '', tool_calls: [{ id: `simulation-${receipt}-${finished}`, type: 'function',
          function: { name: 'simFinishTurn', arguments: JSON.stringify(finished
            ? { choice: 'silent', reason: '结束本次发送验收' }
            : { choice: 'chat', reason: '回复这次陶艺分享', messages: ['这次陶艺课程听起来很有意思。'] }) },
        }] } }] }
      },
    }, async f => {
      await f.send(simulationGroup, 'simulation-episode-source', '我来分享这次陶艺课程', { directedToAccount: true })
      await waitFor(() => f.attempts.length > 0, 'simulation delivery attempted')
      await f.drainSimulation()
      await waitFor(async () => {
        const state = await f.session(simulationGroup)
        return state?.agentHistory?.length && !state.queuedIngressWake
      }, 'simulation turn finished')
      const episodes = (await f.state(simulationGroup))?.episodes ?? []
      if (receipt === 'unknown') {
        assert.deepEqual(episodes, [])
        assert.equal(f.deliveries.length, 0)
      } else {
        assert.equal(episodes.length, 1)
        assert.deepEqual(episodes[0].messageIds, ['simulation-episode-source'])
        assert.deepEqual(episodes[0].replyIds, ['simulation-confirmed-reply'])
        assert.equal(episodes[0].userId, actor.id)
        assert.ok(episodes[0].summary.includes('陶艺课程'))
        assert.ok(episodes[0].reply.includes('陶艺课程听起来很有意思'))
        assert.equal(episodes[0].source.personaId, 'agent:role')
        assert.equal(f.deliveries.length, 1)
      }
    })
  }
})

test('recalled episode input and recalled confirmed reply never reappear in later prompts or after restart', redisTest, async t => {
  await withFixture(t, { name: 'episode-source-recall', midtermMemory: { enabled: false } }, async f => {
    await f.send(privateRoom, 'episode-to-recall', '记下这次秘密绘画课程')
    const episode = (await f.state(privateRoom)).episodes[0]
    assert.ok(episode.messageIds.includes('episode-to-recall'))
    await f.emit({ kind: 'recall', target: privateRoom, messageId: episode.replyIds[0] })
    await f.tick(31 * 60_000)
    const afterReplyRecall = await f.prompt(privateRoom, 'after-reply-recall', '上次课程怎样')
    assert.equal(dataText(afterReplyRecall).includes('秘密绘画课程'), false)
    await f.send(privateRoom, 'episode-input-recall', '这是另一次秘密音乐课程')
    await f.emit({ kind: 'recall', target: privateRoom, messageId: 'episode-input-recall' })
    await f.stop()
    await f.start()
    await f.tick(31 * 60_000)
    const afterRestart = await f.prompt(privateRoom, 'after-input-recall-restart', '上次那门课怎样')
    assert.equal(dataText(afterRestart).includes('秘密音乐课程'), false)
    assert.equal(dataText(afterRestart).includes('秘密绘画课程'), false)
  })
})

test('summary context is frozen, revocable and records independent scoped usage once', redisTest, async t => {
  let supplied
  await withFixture(t, { name: 'summary-context-usage', episodicMemory: { enabled: false },
    summarize: async (input, context) => {
      supplied = context
      assert.equal(Object.isFrozen(context.target), true)
      assert.equal(Object.isFrozen(context.target.account), true)
      assert.equal(Object.isFrozen(input.messages), true)
      assert.equal(context.isCurrent(), true)
      await context.ensureCurrent()
      context.recordUsage('summary-fixture', { total_tokens: 17 })
      context.recordUsage('duplicate', { total_tokens: 99 })
      return '有来源的摘要结果'
    },
  }, async f => {
    await f.batch(group, 'usage来源')
    await f.tick(5001)
    await f.summary(group)
    const ledger = f.tokens.filter(row => row.stage === 'midterm-summary')
    assert.deepEqual(ledger.map(({ scope, model, usage }) => ({ scope, model, usage })), [
      { scope: simulationAddressKey(group), model: 'summary-fixture', usage: { total_tokens: 17 } },
    ])
    assert.equal(agentBindingToken(supplied.binding), agentBindingToken(f.binding(group)))
    await waitFor(() => !supplied.isCurrent(), 'summary releases its host authority')
    await assert.rejects(supplied.ensureCurrent())
    supplied.recordUsage('after-release', { total_tokens: 999 })
    assert.equal(f.tokens.filter(row => row.stage === 'midterm-summary').length, 1)
  })
})
