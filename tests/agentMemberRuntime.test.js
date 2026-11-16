import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 30_000 }
const png = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
const bundle = [{ parts: [{ kind: 'text', text: '这份群资料展示给你看' }] }]
const notification = { text: '集合时间到了', mentionUserIds: ['member'] }

async function waitFor(probe, label) {
  const until = Date.now() + 6000
  while (Date.now() < until) { if (await probe()) return; await delay(15) }
  assert.fail(typeof label === 'function' ? label() : label)
}

function modelCall(name, args, id) {
  return { choices: [{ message: { content: '', tool_calls: [{ id: `member-call-${id}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] } }] }
}

async function fixture(t, execute, options = {}) {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'member-runtime')
  const account = { platform: 'fixture', namespace: 'tenant', id: 'robot' }
  const target = { account, kind: 'group', id: 'room' }
  const member = { user: { ...account, id: 'member' }, displayName: '小林', role: 'admin', profile: {
    nickname: '林', conversationName: '小林', title: '单人资料专用称号', level: '17', joinedAt: 1_700_000_000_000,
    lastSpokeAt: 1_700_000_100_000, mutedUntil: 1_700_000_200_000, gender: 'unknown', age: 31, region: '合成地区',
  } }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'initial'), accept, completed = false, finished = false, executionError
  const requests = [], reads = [], lists = [], sends = [], errors = []
  const now = Date.now(), key = simulationAddressKey(target)
  const state = createDefaultSimSession(now)
  state.bootstrapSent = !options.autonomous; state.botId = account.id
  state.wakeConfig.triggers.probability = 0; state.nextProactiveCheckAt = 0
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const readSnapshot = () => ({ target: structuredClone(target), observedAt: Date.now(), member: structuredClone(member) })
  const listSnapshot = () => ({ target: structuredClone(target), observedAt: Date.now(), complete: true, members: [structuredClone(member)] })
  const transport = async (action, guard) => {
    if (!guard.isCurrent()) return { state: 'failed', code: 'cancelled' }
    sends.push(structuredClone(action))
    return options.receipt ?? { state: 'sent', messageId: `confirmed-${sends.length}` }
  }
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readConversationMember(selected, user, guard) {
        reads.push({ target: structuredClone(selected), user: structuredClone(user), guard })
        return options.read ? options.read(selected, user, guard, readSnapshot) : readSnapshot()
      },
      async listConversationMembers(selected, guard) {
        lists.push({ target: structuredClone(selected), guard })
        return options.list ? options.list(selected, guard, listSnapshot) : listSnapshot()
      },
      actions: { send: transport, sendBundle: transport },
    }],
    logger: { info() {}, warn() {}, error(...args) { errors.push(args.map(String).join(' ')) } },
    resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: 1 },
      toolPolicy: { mode: 'open', ...(options.allowAdmins ? { allowTools: ['mentionAdminsTool'] } : {}) } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    toolRegistry: { builtIn: [{ name: 'memberProbe', description: 'Synthetic member capability probe',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute(_input, context) {
        try { await execute(context) } catch (error) { executionError = error; throw error } finally { completed = true }
        return { status: 'succeeded', content: '合成成员能力检查完成' }
      },
    }] },
    async YTapi(request) {
      requests.push(structuredClone(request))
      if (options.ordinaryFirst && requests.length === 1) {
        return modelCall('simSendMessage', { continuation: 'chat', messages: ['大家下午好'] }, requests.length)
      }
      if (options.autonomous && requests.length === 1) return modelCall('memberInfoTool', { userId: 'member' }, requests.length)
      if (!completed && !options.autonomous && (!options.ordinaryUnknown || requests.length === 2)) return modelCall('memberProbe', {}, requests.length)
      finished = true
      return modelCall('simFinishTurn', { choice: 'silent', reason: '合成验收结束', throughSeq: 1 }, requests.length)
    },
  })
  t.after(async () => { options.release?.(); await host.stop() })
  await host.start()
  return { target, account, member, requests, reads, lists, sends,
    get executionError() { return executionError },
    async emit() { await accept({ kind: 'message', message: { version: 1, conversation: target,
      sender: { ...account, id: 'requester' }, messageId: 'trigger', occurredAt: now,
      text: options.autonomous ? '大家下午好' : '请通知小林集合',
      parts: [{ kind: 'text', text: options.autonomous ? '大家下午好' : '请通知小林集合' }],
      mentions: options.autonomous ? [] : [account], directedToAccount: !options.autonomous } }) },
    async settled() {
      const observed = options.ordinaryUnknown || options.autonomous ? finished : completed
      return observed && !await reader.exists(prefix + simulationBusyKey(key))
    },
    async wait() { await waitFor(this.settled, () => `member turn did not settle: ${errors.join('|')}`) },
    async session() { return JSON.parse(await reader.get(prefix + simulationSessionKey(key))) },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'other' }] }, 'replacement') },
    recall: () => accept({ kind: 'recall', target, messageId: 'trigger' }),
  }
}

test('Core member capabilities bind the group/account, minimize list profiles and expire with the tool; autonomous calls are denied', redisTest, async t => {
  await t.test('user turn projects snapshots, registers safe defaults and revokes saved capabilities', async t => {
    let saved, run
    run = await fixture(t, async context => {
      saved = context
      assert.deepEqual(context.binding.target, run.target)
      assert.deepEqual(context.actor, { kind: 'user', user: { ...run.account, id: 'requester' } })
      assert.equal(context.request.messageId, 'trigger')
      const listed = await context.listMembers()
      assert.deepEqual(listed.target, run.target)
      assert.deepEqual(listed.members, [{ ...run.member, profile: { nickname: '林', conversationName: '小林' } }])
      const selected = await context.readMember('member')
      assert.deepEqual(selected.member, run.member)
      assert.deepEqual(await context.sendMessage(notification), { state: 'sent', messageId: 'confirmed-1' })
    })
    await run.emit(); await run.wait()
    assert.equal(run.executionError, undefined)
    const names = run.requests[0].tools.map(tool => tool.function.name)
    assert.ok(names.includes('memberInfoTool')); assert.ok(names.includes('mentionMembersTool'))
    assert.equal(names.includes('mentionAdminsTool'), false)
    assert.equal(run.reads.length, 2, 'the send freshly verifies its mentioned member')
    for (const read of run.reads) {
      assert.deepEqual(read.target, run.target)
      assert.deepEqual(read.user, { ...run.account, id: 'member' })
      assert.equal(read.guard.signal, saved.signal)
    }
    assert.deepEqual(run.lists[0].target, run.target)
    assert.equal(run.lists[0].guard.signal, saved.signal)
    assert.equal(run.sends.length, 1)
    assert.deepEqual(run.sends[0].target, run.target)
    assert.deepEqual(run.sends[0].parts, [{ kind: 'mention', user: { ...run.account, id: 'member' } }, { kind: 'text', text: notification.text }])
    assert.equal(run.sends[0].binding.agentId, 'role')
    assert.equal(saved.signal.aborted, true)
    await assert.rejects(saved.readMember('member'), /失效/u)
    await assert.rejects(saved.listMembers(), /失效/u)
    await assert.rejects(saved.sendMessage(notification), /失效/u)
    assert.equal(run.reads.length, 2); assert.equal(run.lists.length, 1); assert.equal(run.sends.length, 1)
  })
  await t.test('bootstrap autonomous actor cannot force a member lookup', async t => {
    const run = await fixture(t, () => assert.fail('autonomous probe must never execute'), { autonomous: true })
    await run.emit(); await run.wait()
    const names = run.requests[0].tools.map(tool => tool.function.name)
    for (const name of ['memberInfoTool', 'mentionMembersTool', 'mentionAdminsTool', 'memberProbe']) assert.equal(names.includes(name), false)
    assert.equal(run.reads.length, 0); assert.equal(run.lists.length, 0); assert.equal(run.sends.length, 0)
    assert.ok(run.requests.slice(1).some(request => request.messages.some(row => row.role === 'tool' && /error|权限|自主|不允许/u.test(String(row.content)))))
  })
  await t.test('explicit admin policy reveals the third adapter-registered member tool', async t => {
    const run = await fixture(t, async () => {}, { allowAdmins: true })
    await run.emit(); await run.wait()
    assert.equal(run.executionError, undefined)
    const names = run.requests[0].tools.map(tool => tool.function.name)
    for (const name of ['memberInfoTool', 'mentionMembersTool', 'mentionAdminsTool']) assert.ok(names.includes(name))
    assert.equal(run.reads.length, 0); assert.equal(run.lists.length, 0); assert.equal(run.sends.length, 0)
  })
})

test('Core member messages share the same turn quota with ordinary messages, images and bundles', redisTest, async t => {
  for (const first of ['member', 'image', 'bundle', 'ordinary']) await t.test(`${first} consumes the shared single-send budget`, async t => {
    const run = await fixture(t, async context => {
      if (first === 'member') {
        assert.equal((await context.sendMessage(notification)).state, 'sent')
        await assert.rejects(context.sendImage(png))
        await assert.rejects(context.sendBundle(bundle))
      } else {
        if (first === 'image') assert.equal((await context.sendImage(png)).state, 'sent')
        if (first === 'bundle') assert.equal((await context.sendBundle(bundle)).state, 'sent')
        await assert.rejects(context.sendMessage(notification))
      }
    }, { ordinaryFirst: first === 'ordinary' })
    await run.emit(); await run.wait()
    assert.equal(run.executionError, undefined)
    assert.equal(run.sends.length, 1)
    assert.equal((await run.session()).sendTimes.length, 1)
    if (first === 'ordinary') assert.deepEqual(run.sends[0].parts, [{ kind: 'text', text: '大家下午好' }])
  })
})

test('an unknown member or ordinary delivery receipt freezes every subsequent member/image/bundle send', redisTest, async t => {
  for (const ordinaryFirst of [false, true]) await t.test(ordinaryFirst ? 'ordinary unknown blocks member send' : 'member unknown blocks all tool transports', async t => {
    const run = await fixture(t, async context => {
      if (ordinaryFirst) assert.fail('ordinary unknown must prevent the next external tool from executing')
      assert.deepEqual(await context.sendMessage(notification), { state: 'unknown' })
      await assert.rejects(context.sendMessage({ text: '另一条通知', mentionUserIds: ['member'] }), /未知/u)
      await assert.rejects(context.sendImage(png), /未知/u)
      await assert.rejects(context.sendBundle(bundle), /未知/u)
    }, { receipt: { state: 'unknown' }, ordinaryFirst, ordinaryUnknown: ordinaryFirst })
    await run.emit(); await run.wait()
    assert.equal(run.executionError, undefined)
    assert.equal(run.sends.length, 1)
    assert.equal((await run.session()).sendTimes.length, 0)
    if (ordinaryFirst) {
      assert.equal(run.requests.length, 3, 'the model attempts a member tool once and then closes the turn')
      assert.ok(run.requests[2].messages.some(row => row.role === 'tool' && /前序外部动作结果未知/u.test(String(row.content))))
      assert.equal(run.reads.length, 0); assert.equal(run.lists.length, 0)
    }
  })
})

test('late member results after rebinding or source recall never reach a tool or authorize sending', redisTest, async t => {
  for (const mode of ['rebind', 'recall']) await t.test(mode, async t => {
    let release, guard, received = false, attemptedSend = false
    const held = new Promise(resolve => { release = resolve })
    const run = await fixture(t, async context => {
      const result = await context.readMember('member')
      received = Boolean(result)
      attemptedSend = true
      await context.sendMessage(notification)
    }, { release, async read(_target, _user, check, snapshot) {
      guard = check
      await held // Simulate a platform that does not cooperate with AbortSignal.
      const late = snapshot(); late.member.profile.title = '迟到成员资料不得进入模型'
      return late
    } })
    await run.emit(); await waitFor(() => guard, 'member read starts')
    if (mode === 'rebind') run.rebind()
    else await run.recall()
    await waitFor(() => guard.signal.aborted, 'member request is cancelled')
    assert.equal(guard.isCurrent(), false)
    release(); await run.wait()
    assert.match(run.executionError.message, /失效/u)
    assert.equal(received, false); assert.equal(attemptedSend, false)
    assert.equal(run.sends.length, 0)
    assert.equal((await run.session()).sendTimes.length, 0)
    assert.doesNotMatch(JSON.stringify(run.requests), /迟到成员资料不得进入模型/u)
  })
})

test('Core rejects foreign, stale, incomplete and duplicate member snapshots before a member send', redisTest, async t => {
  let listMutation = value => value, memberMutation = value => value, run
  run = await fixture(t, async context => {
    assert.ok(await context.listMembers()); assert.ok(await context.readMember('member'))
    const badLists = [
      ['other group', value => ({ ...value, target: { ...value.target, id: 'other-room' } })],
      ['other account', value => ({ ...value, target: { ...value.target, account: { ...value.target.account, id: 'other-robot' } } })],
      ['foreign namespace', value => ({ ...value, members: [{ ...value.members[0], user: { ...value.members[0].user, namespace: 'other-tenant' } }] })],
      ['stale observation', value => ({ ...value, observedAt: Date.now() - 6000 })],
      ['incomplete roster', value => ({ ...value, complete: false })],
      ['duplicate identity', value => ({ ...value, members: [value.members[0], structuredClone(value.members[0])] })],
    ]
    for (const [label, mutate] of badLists) {
      listMutation = mutate
      assert.equal(await context.listMembers(), undefined, label)
    }
    listMutation = value => value
    assert.ok(await context.listMembers())
    const badMembers = [
      ['other group', value => ({ ...value, target: { ...value.target, id: 'other-room' } })],
      ['foreign namespace', value => ({ ...value, member: { ...value.member, user: { ...value.member.user, namespace: 'other-tenant' } } })],
      ['other subject', value => ({ ...value, member: { ...value.member, user: { ...value.member.user, id: 'other-member' } } })],
      ['stale observation', value => ({ ...value, observedAt: Date.now() - 6000 })],
    ]
    for (const [label, mutate] of badMembers) {
      memberMutation = mutate
      assert.equal(await context.readMember('member'), undefined, label)
      assert.deepEqual(await context.sendMessage(notification), { state: 'failed', code: 'member_unverified' }, label)
    }
    memberMutation = value => value
    assert.ok(await context.readMember('member'))
  }, { list: (_target, _guard, snapshot) => listMutation(snapshot()), read: (_target, _user, _guard, snapshot) => memberMutation(snapshot()) })
  await run.emit(); await run.wait()
  assert.equal(run.executionError, undefined)
  assert.equal(run.sends.length, 0)
})
