import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createGroupMemory } from '../dist/backend/modules/memory/infrastructure/groupMemory.js'
import { createGroupMemoryStore, groupMemoryId } from '../dist/backend/modules/memory/infrastructure/groupMemoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { personMemoryCommandText as commands } from '../dist/backend/modules/memory/domain/personMemoryCommands.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const accounts = [
  { platform: 'fixture', namespace: 'tenant-a', id: 'bot-a' },
  { platform: 'fixture', namespace: 'tenant-a', id: 'bot-b' },
  { platform: 'fixture', namespace: 'tenant-b', id: 'bot-a' },
  { platform: 'matrix', namespace: 'tenant-a', id: 'bot-a' },
]
const group = { account: accounts[0], kind: 'group', id: 'same-room' }
const otherAccount = { ...group, account: accounts[1] }
const otherNamespace = { ...group, account: accounts[2] }
const otherPlatform = { ...group, account: accounts[3] }
const otherRoom = { ...group, id: 'another-room' }
const privateRoom = { ...group, kind: 'private', id: 'speaker-a' }
const targets = [group, otherAccount, otherNamespace, otherPlatform, otherRoom, privateRoom]
const actor = (target, id = 'speaker-a') => ({ platform: target.account.platform, namespace: target.account.namespace, id })
const targetActor = target => actor(target, 'target-a')
const textOf = request => JSON.stringify(request.messages)

async function waitFor(probe, description, timeoutMs = 6500) {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}
function directory(revision = 'group-memory-v1', replacements = new Map()) {
  return createAgentBindingDirectory({ version: 1,
    agents: [{ id: 'daily', personaId: 'shared' }, { id: 'work', personaId: 'shared' }],
    connections: accounts.map((account, index) => ({ id: `fixture-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map(target => ({ connectionId: `fixture-${accounts.findIndex(account => platformAccountKey(account) === platformAccountKey(target.account))}`,
      kind: target.kind, conversationId: target.id, agentId: replacements.get(conversationAddressKey(target)) ?? 'daily' })),
  }, revision)
}
function propose(input, text, extra = {}) {
  const index = input.messages.findIndex(row => row.text.includes(text))
  return index < 0 ? [] : [{ kind: input.mode === 'consensus' ? 'fact' : 'member_definition', sourceIndex: index + 1,
    excerpt: input.messages[index].text,
    ...(input.mode === 'consensus' ? { text } : { subject: text, targetUserIds: ['target-a'] }), ...extra }]
}

async function withFixture(t, options, run) {
  const redis = await createAgentRedisFixture(t, options.name ?? 'agent-group-memory')
  const clock = { at: Date.now() }, requests = [], calls = [], attempts = [], deliveries = [], warnings = [], tokens = [], hosts = []
  const store = createGroupMemoryStore(redis.storage), roles = new Map()
  let bindings = directory(), current
  const fixture = {
    ...redis, clock, requests, calls, attempts, deliveries, warnings, tokens, roles,
    binding: target => bindings.resolve(target),
    state: target => store.load(groupMemoryId(target)),
    rawStates: () => store.list(),
    owner: async (target, agentId = 'daily') => (await fixture.state(target))?.agents.find(value => value.agentId === agentId),
    rebind(revision, replacements) { bindings = directory(revision, replacements) },
    async drained(target) {
      const queue = target.kind === 'private' ? 'private' : 'group-text'
      await waitFor(() => redis.reader.lLen(redis.prefix + `agent:inbox:${options.simulation ? 'simulation' : queue}:${platformAccountKey(target.account)}`).then(length => length === 0), `${options.simulation ? 'simulation' : queue} inbox drained`)
    },
    event(target, id, text, overrides = {}) {
      return { kind: 'message', message: { version: 1, conversation: target, sender: actor(target), senderName: '来源作者', messageId: id,
        occurredAt: clock.at, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true, ...overrides } }
    },
    async emit(event) {
      const target = event.kind === 'message' ? event.message.conversation : event.target
      return current.receive.get(platformAccountKey(target.account))(event)
    },
    async send(target, id, text, overrides) {
      clock.at++
      const event = fixture.event(target, id, text, overrides)
      await fixture.emit(event)
      await fixture.drained(target)
      return event
    },
    async tick(ms = 0) { clock.at += ms; await current.host.resumePendingWork() },
    async simulatedTurnSettled(target) {
      const runtime = current.host.runtime
      return waitFor(async () => {
        const state = await runtime.describeGroup(simulationAddressKey(target))
        return state.lastWakeAtAgo !== null && !state.running
      }, 'simulation turn settled')
    },
    async acknowledged(target, id, mode = 'teaching', agentId = fixture.binding(target).agentId) {
      return waitFor(async () => {
        const owner = await fixture.owner(target, agentId)
        return owner?.[mode === 'teaching' ? 'teachingDone' : 'consensusDone'].includes(id) && owner
      }, `${mode} acknowledged ${id}`)
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
        const members = target => [
          { user: actor(target), displayName: '来源作者', role: roles.get('speaker-a') ?? 'member' },
          { user: actor(target, 'speaker-b'), displayName: '第二作者', role: roles.get('speaker-b') ?? 'member' },
          { user: actor(target, 'target-a'), displayName: '甲成员', role: roles.get('target-a') ?? 'member' },
          { user: actor(target, 'target-b'), displayName: '乙成员', role: roles.get('target-b') ?? 'member' },
          { user: actor(target, `bot-user-${index}`), displayName: 'Test bot', role: 'member' },
        ]
        return { id: `fixture-${index}`, account, botUserId: `bot-user-${index}`, botName: 'Test bot',
          actions: { async send(action, guard) {
            attempts.push(action)
            if (!guard?.isCurrent?.()) return { state: 'failed', code: 'scope_changed' }
            const result = options.send ? await options.send(action, guard) : { state: 'sent', messageId: `sent-${attempts.length}` }
            if (result.state === 'sent') deliveries.push(action)
            return result
          } },
          async listConversationMembers(target, guard) {
            if (guard.signal.aborted || !guard.isCurrent()) return undefined
            return options.members ? options.members(target, members(target), Date.now())
              : { target, observedAt: Date.now(), complete: true, members: members(target) }
          },
          async readConversationMember(target, user, guard) {
            if (guard.signal.aborted || !guard.isCurrent()) return undefined
            const member = members(target).find(value => value.user.id === user.id)
            return member && { target, observedAt: Date.now(), member }
          },
          async start(accept) { receive.set(platformAccountKey(account), accept); ready = true },
          isReady: () => ready, stop() { ready = false },
        }
      })
      const host = createAgentRuntime({ storage: redis.storage, adapters, now: () => clock.at, isExecutionCurrent: redis.isCurrent,
        logger: { info() {}, warn: message => warnings.push(message), error() {} },
        privateChatEnabled: true, useTextGroup: target => options.simulation ? false : target.kind === 'group',
        groupMemory: Object.hasOwn(options, 'groupMemory') ? options.groupMemory
          : { enabled: true, groupExtractMinIntervalMinutes: 0, groupExtractMaxBatchMessages: 12 },
        resolvePersona(target) {
          const binding = bindings.resolve(target)
          return binding && { binding, persona: { name: binding.agentId === 'work' ? '工作角色' : '日常角色' }, systemContent: '固定人格' }
        },
        getSection: () => ({ enabled: true, allGroups: options.simulation === true, reflection: { enabled: false }, rhythm: { enabled: false },
          personProfile: { enabled: false }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
          turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
        getExecutionConfig: () => options.executionConfig ?? (options.simulation ? { useTools: true } : {}), groupTextTools: () => options.tools ?? [], recordTokens: input => tokens.push(input),
        async YTapi(request, ...args) {
          requests.push(request)
          return options.model ? options.model(request, ...args) : { choices: [{ message: { content: '收到这次消息。' } }] }
        },
        ...((Object.hasOwn(options, 'learn') && options.learn === undefined) ? {} : {
          async groupMemoryModel(input, context) {
            calls.push({ input, context })
            return options.learn ? options.learn(input, context) : []
          },
        }),
      })
      current = { host, receive }; hosts.push(host)
      await host.start()
    },
    async stop() { await current?.host.stop() },
  }
  try { await fixture.start(); await run(fixture) }
  finally { options.release?.(); await Promise.all(hosts.map(host => host.stop())) }
}

test('group learning requires its switch and model, ignores private and forwarded messages, and never invents consensus before delivery', redisTest, async t => {
  for (const [name, config] of [
    ['group-learning-off', { groupMemory: { enabled: false } }],
    ['group-learning-no-port', { learn: undefined }],
  ]) await withFixture(t, { name, ...config }, async f => {
    await f.send(group, 'ordinary', '真实发言')
    await f.tick(60_000)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(await f.rawStates(), [])
  })
  await withFixture(t, { name: 'group-learning-delivery-gate', send: async () => ({ state: 'failed', code: 'transport_rejected' }) }, async f => {
    await f.send(privateRoom, 'private', '我的私聊内容')
    await f.send(group, 'undirected', '没有点名的群发言', { directedToAccount: false })
    assert.equal(f.calls.length, 0)
    await f.send(group, 'failed-delivery', '群发言尚未确认送达')
    await f.acknowledged(group, 'failed-delivery')
    await f.send(group, 'forwarded', '转发中的第三方说法', { parts: [{ kind: 'forward', id: 'forward-id' }] })
    await f.tick()
    assert.ok(f.calls.every(call => call.input.mode === 'teaching'))
    assert.equal(f.deliveries.length, 0)
    assert.equal(await f.state(privateRoom), undefined)
    const owner = await f.owner(group)
    assert.deepEqual(owner.entries, [])
    assert.ok(!owner.records.some(row => row.messageId === 'forwarded'))
  })
})

test('a confirmed ordinary Core reply triggers grounded consensus with original authors and source times', redisTest, async t => {
  const fact = '周末群里统一收集素材'
  await withFixture(t, { name: 'group-learning-confirmed', learn: async input => input.mode === 'consensus' ? propose(input, fact) : [] }, async f => {
    const source = await f.send(group, 'consensus-source', fact)
    const owner = await f.acknowledged(group, 'consensus-source', 'consensus')
    assert.equal(f.deliveries.length, 1)
    assert.equal(owner.entries.length, 1)
    const [entry] = owner.entries
    assert.equal(entry.kind, 'fact'); assert.equal(entry.text, fact)
    assert.equal(entry.source.at, source.message.occurredAt)
    assert.equal(entry.source.authorId, source.message.sender.id)
    assert.equal(entry.createdBy, source.message.sender.id)
    assert.equal(entry.persona.personaId, 'agent:daily')
    assert.equal(entry.excerpt, source.message.text)
    assert.deepEqual((await f.state(group)).entries, [])
    const prompt = await f.prompt(group, 'recall-fact', '之前群里怎么安排')
    assert.match(textOf(prompt), /周末群里统一收集素材/)
    assert.match(textOf(prompt), /未经独立证实/)
  })
})

test('explicit teaching commits before a failed main reply and duplicate ingress never repeats the teaching job', redisTest, async t => {
  await withFixture(t, { name: 'group-teaching-independent', send: async () => ({ state: 'failed', code: 'transport_rejected' }),
    learn: async input => input.mode === 'teaching' ? propose(input, '美术组') : [] }, async f => {
    const event = await f.send(group, 'teach-once', '记住美术组指甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'teach-once')
    const [entry] = (await f.state(group)).entries
    assert.equal(entry.subject, '美术组'); assert.deepEqual(entry.targetUserIds, ['target-a'])
    assert.equal(entry.source.messageId, 'teach-once'); assert.equal(entry.source.at, event.message.occurredAt)
    assert.equal(f.deliveries.length, 0)
    assert.ok(f.calls.every(call => call.input.mode === 'teaching'))
    await f.emit(event); await f.drained(group); await f.tick()
    assert.equal(f.calls.filter(call => call.input.mode === 'teaching').length, 1)
    assert.equal((await f.state(group)).entries.length, 1)
  })
})

test('human teaching follows a conversation across Agents while learned facts stay with their original Agent', redisTest, async t => {
  await withFixture(t, { name: 'group-memory-shared-versus-agent', learn: async input => input.mode === 'teaching'
    ? propose(input, '共享美术组') : propose(input, '日常角色独有说法') }, async f => {
    await f.send(group, 'daily-fact', '日常角色独有说法')
    await f.acknowledged(group, 'daily-fact', 'consensus')
    await f.send(group, 'shared-teaching', '记住共享美术组是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'shared-teaching')
    f.rebind('work-version', new Map([[conversationAddressKey(group), 'work']]))
    const workPrompt = await f.prompt(group, 'work-read', '列出现在的群资料')
    assert.match(textOf(workPrompt), /共享美术组/)
    assert.doesNotMatch(textOf(workPrompt), /日常角色独有说法/)
    const saved = await f.state(group)
    assert.equal(saved.agents.find(value => value.agentId === 'daily').entries.length, 1)
    assert.equal(saved.agents.find(value => value.agentId === 'work').entries.length, 0)
    assert.equal(saved.entries[0].persona.personaId, 'agent:daily')
    f.rebind('daily-return')
    const dailyPrompt = await f.prompt(group, 'daily-read', '回到日常角色查看资料')
    assert.match(textOf(dailyPrompt), /共享美术组/)
    assert.match(textOf(dailyPrompt), /日常角色独有说法/)
  })
})

test('identical room and user IDs on other accounts, namespaces, platforms and rooms cannot read shared teaching', redisTest, async t => {
  await withFixture(t, { name: 'group-memory-addresses', learn: async input => input.mode === 'teaching' ? propose(input, '本账号专属定义') : [] }, async f => {
    await f.send(group, 'address-source', '记住本账号专属定义是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'address-source')
    for (const [index, target] of [otherAccount, otherNamespace, otherPlatform, otherRoom].entries()) {
      const prompt = await f.prompt(target, `isolated-${index}`, '查询当前群资料')
      assert.doesNotMatch(textOf(prompt), /本账号专属定义/)
      assert.equal((await f.state(target)).entries.length, 0)
    }
    assert.match(textOf(await f.prompt(group, 'original-address', '原会话继续查询')), /本账号专属定义/)
  })
})

test('ordinary members cannot overwrite another creator or create workflows, while a verified administrator can', redisTest, async t => {
  await withFixture(t, { name: 'group-teaching-permissions', learn: async input => {
    if (input.mode !== 'teaching') return []
    const row = input.messages[0]
    if (row.text.includes('通知规则')) return propose(input, '通知规则', { kind: 'workflow', condition: '需要开会', targetUserIds: ['target-a'] })
    return propose(input, '共享角色', { targetUserIds: [row.text.includes('乙成员') ? 'target-b' : 'target-a'] })
  } }, async f => {
    await f.send(group, 'owner-teach', '记住共享角色是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'owner-teach')
    await f.send(group, 'foreign-replace', '把共享角色改成乙成员', { sender: actor(group, 'speaker-b'), mentions: [actor(group, 'target-b')] })
    await f.acknowledged(group, 'foreign-replace')
    assert.deepEqual((await f.state(group)).entries[0].targetUserIds, ['target-a'])
    await f.send(group, 'ordinary-workflow', '记住通知规则：需要开会找甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'ordinary-workflow')
    assert.equal((await f.state(group)).entries.filter(value => value.kind === 'workflow').length, 0)
    f.roles.set('speaker-b', 'admin')
    await f.send(group, 'admin-replace', '把共享角色改成乙成员', { sender: actor(group, 'speaker-b'), mentions: [actor(group, 'target-b')] })
    await f.acknowledged(group, 'admin-replace')
    const replaced = (await f.state(group)).entries.find(value => value.kind === 'member_definition')
    assert.deepEqual(replaced.targetUserIds, ['target-b']); assert.equal(replaced.createdBy, 'speaker-b')
    await f.send(group, 'admin-workflow', '记住通知规则：需要开会找甲成员', { sender: actor(group, 'speaker-b'), mentions: [targetActor(group)] })
    await f.acknowledged(group, 'admin-workflow')
    assert.equal((await f.state(group)).entries.filter(value => value.kind === 'workflow').length, 1)
    assert.ok(f.deliveries.every(action => action.parts.every(part => part.kind === 'text')))
  })
})

test('model hallucinated identities, ungrounded excerpts and unverifiable member snapshots never create teaching', redisTest, async t => {
  await withFixture(t, { name: 'group-teaching-grounding', learn: async input => input.mode === 'teaching' ? [
    ...propose(input, '需验证定义', { targetUserIds: ['invented-user'] }),
    ...propose(input, '需验证定义', { excerpt: '模型编造的原文' }),
    ...propose(input, '需验证定义', { targetUserIds: [input.botUserId] }),
  ] : [] }, async f => {
    await f.send(group, 'ungrounded', '记住需验证定义是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'ungrounded')
    assert.equal((await f.state(group)).entries.length, 0)
  })
  await withFixture(t, { name: 'group-teaching-wrong-scope', members: (target, members, observedAt) => ({
    target: { ...target, account: accounts[1] }, members, observedAt, complete: true,
  }), learn: async input => propose(input, '目录错误定义') }, async f => {
    await f.send(group, 'wrong-members', '记住目录错误定义是甲成员', { mentions: [targetActor(group)] })
    await f.tick()
    assert.equal(f.calls.filter(call => call.input.mode === 'teaching').length, 0)
    assert.equal((await f.state(group)).entries.length, 0)
  })
})

test('recall and privacy commands immediately hide shared sources and enabling memory does not resurrect deleted teaching', redisTest, async t => {
  await withFixture(t, { name: 'group-teaching-privacy', learn: async input => input.mode === 'teaching'
    ? [...propose(input, '撤回专属定义'), ...propose(input, '停用专属定义')] : [] }, async f => {
    await f.send(group, 'recall-source', '记住撤回专属定义是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'recall-source')
    await f.emit({ kind: 'recall', target: group, messageId: 'recall-source' }); await f.drained(group)
    assert.doesNotMatch(textOf(await f.prompt(group, 'after-recall', '撤回之后查询')), /撤回专属定义/)
    await f.send(group, 'privacy-source', '记住停用专属定义是甲成员', { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'privacy-source')
    assert.match(textOf(await f.prompt(group, 'before-disable', '停用之前查询', { sender: actor(group, 'speaker-b') })), /停用专属定义/)
    await f.send(group, 'disable-author', commands.disable)
    assert.doesNotMatch(textOf(await f.prompt(group, 'after-disable', '停用之后查询', { sender: actor(group, 'speaker-b') })), /停用专属定义/)
    await f.send(group, 'enable-author', commands.enable)
    assert.doesNotMatch(textOf(await f.prompt(group, 'after-enable', '重新启用之后查询', { sender: actor(group, 'speaker-b') })), /停用专属定义/)
    await f.stop(); await f.start()
    assert.doesNotMatch(textOf(await f.prompt(group, 'after-restart-privacy', '重启后继续查询', { sender: actor(group, 'speaker-b') })), /撤回专属定义|停用专属定义/)
  })
})

test('a late teaching result after source recall cannot commit, even if the model ignores cancellation', redisTest, async t => {
  const gate = Promise.withResolvers()
  await withFixture(t, { name: 'group-teaching-late-recall', release: () => gate.resolve(), learn: async (input, context) => {
    if (input.mode !== 'teaching' || !input.messages[0].text.includes('迟到教学')) return []
    await gate.promise
    context.recordUsage('late-model', { total_tokens: 3 })
    return propose(input, '迟到教学')
  } }, async f => {
    await f.send(group, 'late-teaching', '记住迟到教学是甲成员', { mentions: [targetActor(group)] })
    const pending = f.calls.find(call => call.input.mode === 'teaching')
    assert.ok(pending)
    await f.emit({ kind: 'recall', target: group, messageId: 'late-teaching' }); await f.drained(group)
    await waitFor(() => pending.context.signal.aborted, 'teaching cancellation after recall')
    gate.resolve(); await f.tick(16_000)
    assert.equal((await f.state(group)).entries.length, 0)
    assert.equal(pending.context.isCurrent(), false)
    assert.equal(f.tokens.filter(value => value.model === 'late-model').length, 0)
  })
})

test('a model result from the old binding cannot become shared teaching after an Agent rebind', redisTest, async t => {
  const gate = Promise.withResolvers()
  await withFixture(t, { name: 'group-teaching-late-binding', release: () => gate.resolve(), learn: async input => {
    if (input.mode !== 'teaching' || !input.messages[0].text.includes('旧绑定教学')) return []
    await gate.promise
    return propose(input, '旧绑定教学')
  } }, async f => {
    const original = agentBindingToken(f.binding(group))
    await f.send(group, 'old-binding', '记住旧绑定教学是甲成员', { mentions: [targetActor(group)] })
    const pending = f.calls.find(call => call.input.mode === 'teaching')
    f.rebind('new-binding', new Map([[conversationAddressKey(group), 'work']]))
    await waitFor(() => pending.context.signal.aborted, 'old binding cancellation')
    assert.notEqual(agentBindingToken(f.binding(group)), original)
    gate.resolve(); await f.tick(16_000)
    assert.equal((await f.state(group)).entries.length, 0)
    const prompt = await f.prompt(group, 'new-binding-query', '新角色查询资料')
    assert.doesNotMatch(textOf(prompt), /旧绑定教学/)
  })
})

test('privacy revocation fences a late consensus result and its persisted retry input', redisTest, async t => {
  const gate = Promise.withResolvers()
  await withFixture(t, { name: 'group-consensus-late-privacy', release: () => gate.resolve(), learn: async (input, context) => {
    if (input.mode !== 'consensus' || !input.messages.some(row => row.text.includes('隐私撤权前的说法'))) return []
    await gate.promise
    context.recordUsage('late-consensus-model', { total_tokens: 2 })
    return propose(input, '隐私撤权前的说法')
  } }, async f => {
    await f.send(group, 'privacy-pending-source', '隐私撤权前的说法')
    const pending = await waitFor(() => f.calls.find(call => call.input.mode === 'consensus'), 'consensus awaiting model')
    await f.send(group, 'disable-pending-author', commands.disable)
    await waitFor(() => pending.context.signal.aborted, 'consensus cancellation after privacy command')
    gate.resolve(); await f.tick(16_000)
    const owner = await waitFor(async () => {
      await f.tick()
      const saved = await f.owner(group)
      return !saved.jobs.some(job => job.messages.some(row => row.messageId === 'privacy-pending-source')) && saved
    }, 'revoked consensus retry sources discarded after active task exits')
    assert.deepEqual(owner.entries, [])
    assert.ok(!owner.jobs.some(job => job.messages.some(row => row.messageId === 'privacy-pending-source')))
    assert.equal(pending.context.isCurrent(), false)
    assert.equal(f.tokens.filter(value => value.model === 'late-consensus-model').length, 0)
  })
})

test('private privacy revocation for the origin Agent cancels another Agent replying from its shared teaching', redisTest, async t => {
  const gate = Promise.withResolvers(), marker = '源角色的共享隐私定义', query = 'B读取共享资料并等待'
  await withFixture(t, { name: 'group-teaching-cross-agent-privacy', release: () => gate.resolve(),
    learn: async input => input.mode === 'teaching' ? propose(input, marker) : [],
    model: async request => {
      if (request.messages.at(-1)?.content === query) {
        await gate.promise
        return { choices: [{ message: { content: `迟到回答包含${marker}` } }] }
      }
      return { choices: [{ message: { content: '收到这次消息。' } }] }
    },
  }, async f => {
    await f.send(group, 'origin-agent-teaching', `记住${marker}是甲成员`, { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'origin-agent-teaching')
    assert.equal((await f.state(group)).entries[0].persona.personaId, 'agent:daily')
    f.rebind('cross-agent-reader', new Map([[conversationAddressKey(group), 'work']]))
    assert.equal(f.binding(group).agentId, 'work')
    assert.equal(f.binding(privateRoom).agentId, 'daily')
    const pendingReply = f.send(group, 'cross-agent-pending-read', query)
    const request = await waitFor(() => f.requests.find(value => value.messages.at(-1)?.content === query), 'Agent B main model loaded shared teaching')
    assert.match(textOf(request), new RegExp(marker))
    await f.send(privateRoom, 'origin-private-disable', commands.disable)
    await waitFor(async () => (await f.state(group))?.entries.length === 0, 'privacy queue removes the teaching before the old reply finishes')
    gate.resolve()
    await pendingReply
    await f.tick()
    assert.ok(!f.deliveries.some(action => action.replyTo === 'cross-agent-pending-read'))
    assert.ok(!f.attempts.some(action => action.replyTo === 'cross-agent-pending-read'))
    const after = await f.prompt(group, 'cross-agent-after-disable', 'B再次查询当前资料')
    assert.doesNotMatch(textOf(after), new RegExp(marker))
  })
})

test('group learning frees four stalled slots, resumes a stalled scan and keeps a committed write with a missing acknowledgement', redisTest, async t => {
  const redis = await createAgentRedisFixture(t, 'group-learning-stalled-slots')
  const realTimer = globalThis.setTimeout, realDeadline = AbortSignal.timeout
  const expireJobs = []
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 35_000) expireJobs.push(() => callback(...args))
    return realTimer(callback, ms, ...args)
  })
  let stallScan = false, expireScan
  t.mock.method(AbortSignal, 'timeout', ms => {
    if (!stallScan || ms !== 35_000) return realDeadline(ms)
    const deadline = new AbortController()
    expireScan = () => deadline.abort(new DOMException('Queue scan timed out', 'TimeoutError'))
    return deadline.signal
  })

  const [modelId, sourceId, writeId, ackId, nextId] = ['stall-model', 'stall-source', 'stall-write', 'stall-ack', 'next-job']
  const modelGate = Promise.withResolvers(), sourceGate = Promise.withResolvers()
  const writeGate = Promise.withResolvers(), ackGate = Promise.withResolvers(), scanGate = Promise.withResolvers()
  const events = [], calls = []
  let sourceReads, sawSourceWait = false, sawWriteWait = false, sawAckWait = false, lateWriteResult
  const storage = {
    ...redis.storage,
    get(key) {
      if (stallScan && key === 'agent:group-memory:v1:catalog') {
        stallScan = false
        return scanGate.promise.then(() => redis.storage.get(key))
      }
      return redis.storage.get(key)
    },
    async eval(script, input) {
      if (input.keys[1]?.startsWith('agent:group-memory:v1:state:') && input.arguments.length === 9 &&
          input.arguments[2] === '1' && input.arguments[7] === '1') {
        const previous = JSON.parse(input.arguments[3]).agents[0].teachingDone
        const next = JSON.parse(input.arguments[8]).agents[0].teachingDone
        if (!sawWriteWait && next.includes(writeId) && !previous.includes(writeId)) {
          sawWriteWait = true
          await writeGate.promise
          lateWriteResult = await redis.storage.eval(script, input)
          return lateWriteResult
        }
        if (!sawAckWait && next.includes(ackId) && !previous.includes(ackId)) {
          const result = await redis.storage.eval(script, input)
          if (result !== 1) return result
          sawAckWait = true
          await ackGate.promise
          return result
        }
      }
      return redis.storage.eval(script, input)
    },
  }
  const binding = directory().resolve(group), store = createGroupMemoryStore(redis.storage)
  const readState = () => store.load(groupMemoryId(group))
  const members = ['speaker-a', 'target-a'].map(id => ({ user: actor(group, id), displayName: id, role: 'member' }))
  let clock = Date.now()
  const runtime = createGroupMemory({
    redis: storage, now: () => clock, memory: createPersonMemoryStore({ redis: storage, now: () => clock }),
    config: () => ({ enabled: true }), isRunning: () => true, allowsText: () => true, available: () => true,
    resolve: () => ({ binding, viewer: { botId: personMemoryAddress(group).botId, personaId: 'agent:daily', personaVersion: 'fixture', personaName: '群记忆测试' } }),
    botUserId: () => 'bot-a',
    async members(target) { return { target, members, complete: true, observedAt: Date.now() } },
    async member(target, id) { return { target, member: members.find(row => row.user.id === id), observedAt: Date.now() } },
    async isRecalled(_target, id) {
      if (id === sourceId && sourceReads !== undefined && ++sourceReads === 2) {
        sawSourceWait = true
        await sourceGate.promise
      }
      return false
    },
    async begin() { return { signal: new AbortController().signal, isCurrent: () => true, release() {} } },
    async model(input) {
      const { messageId, text } = input.messages[0]
      const first = !calls.includes(messageId)
      calls.push(messageId)
      if (first && messageId === sourceId) sourceReads = 0
      if (first && messageId === modelId) await modelGate.promise
      return propose(input, text)
    },
    diagnostics: { emit: event => events.push(event) }, logger: { warn() {} },
  })
  const guard = () => true
  try {
    for (const messageId of [modelId, sourceId, writeId, ackId, nextId]) {
      const text = '测试教学 ' + messageId
      await runtime.capture({ version: 1, conversation: group, sender: actor(group), messageId, occurredAt: ++clock,
        text, parts: [{ kind: 'text', text }], mentions: [targetActor(group)] }, binding, guard)
    }
    for (const id of [modelId, sourceId, writeId, ackId]) await runtime.prepare(binding, id, guard)
    await waitFor(() => sawSourceWait && sawWriteWait && sawAckWait, 'all four jobs stalled')

    stallScan = true
    const sweep = runtime.tick()
    await runtime.prepare(binding, nextId, guard)
    assert.deepEqual(calls, [modelId, sourceId, writeId, ackId])
    assert.ok((await readState()).agents[0].jobs.some(job => job.messages[0].messageId === nextId && job.attempts === 0))
    expireScan()
    await sweep
    assert.ok(events.some(event => event.code === 'group_memory_queue_timeout'))
    scanGate.resolve()

    assert.equal(expireJobs.length, 4)
    clock += 35_000
    for (const expire of expireJobs.slice()) expire()
    await waitFor(() => events.filter(event => ['group_learning_timeout', 'group_learning_save_unconfirmed'].includes(event.code)).length === 4,
      'each stalled job reports a deadline')
    assert.equal(events.filter(event => event.outcome === 'unknown' && event.code === 'group_learning_save_unconfirmed').length, 2)
    await runtime.tick()
    await waitFor(async () => (await readState()).entries.some(entry => entry.source.messageId === nextId), 'next job saves after the stalled jobs release their slots')
    assert.equal(calls.filter(id => id === ackId).length, 1)

    writeGate.resolve()
    await waitFor(() => lateWriteResult === 0, 'stale save cannot overwrite newer queue state')
    assert.equal((await readState()).entries.filter(entry => entry.source.messageId === ackId).length, 1)
  } finally {
    for (const gate of [modelGate, sourceGate, writeGate, ackGate, scanGate]) gate.resolve()
    await runtime.stop()
  }
})

test('a failed consensus persists its original sources and retries after restart without resending the confirmed reply', redisTest, async t => {
  let failed = false
  await withFixture(t, { name: 'group-consensus-restart', learn: async input => {
    if (input.mode !== 'consensus') return []
    if (!failed) { failed = true; throw new Error('fixture model temporarily unavailable') }
    return propose(input, '重启后恢复的群说法')
  } }, async f => {
    const original = await f.send(group, 'restart-source', '重启后恢复的群说法')
    await waitFor(async () => (await f.owner(group))?.jobs.some(job => job.mode === 'consensus' && job.attempts === 1), 'failed persisted consensus')
    await waitFor(() => failed, 'first consensus model failure')
    await f.stop()
    const beforeRequests = f.requests.length, beforeDeliveries = f.deliveries.length
    f.clock.at += 16_000
    await f.start(); await f.tick()
    const owner = await f.acknowledged(group, 'restart-source', 'consensus')
    assert.equal(owner.entries.length, 1)
    assert.equal(owner.entries[0].source.at, original.message.occurredAt)
    assert.equal(owner.entries[0].source.text, original.message.text)
    assert.equal(owner.jobs.length, 0)
    assert.equal(f.requests.length, beforeRequests)
    assert.equal(f.deliveries.length, beforeDeliveries)
    const attempts = f.calls.filter(call => call.input.mode === 'consensus')
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[0].input.messages, attempts[1].input.messages)
  })
})

test('a genuine Core request executes a taught workflow once with verified mentions, original text and a durable receipt', redisTest, async t => {
  for (const receiptState of ['sent', 'unknown']) {
    let workflowId, notifyModels = 0
    const teaching = '记住会议联络规则：开会时联系甲成员和乙成员', requestText = '请现在通知会议联络：明天九点开会'
    await withFixture(t, { name: `group-workflow-core-${receiptState}`, tools: ['groupKnowledgeTool'],
      learn: async input => input.mode === 'teaching' ? propose(input, '会议联络', {
        kind: 'workflow', condition: '开会时联系甲成员和乙成员', targetUserIds: ['target-a', 'target-b'],
      }) : [],
      send: async action => action.parts.some(part => part.kind === 'mention')
        ? receiptState === 'sent' ? { state: 'sent', messageId: 'workflow-notification' } : { state: 'unknown' }
        : { state: 'sent', messageId: `reply-${action.replyTo}` },
      model: async request => {
        if (request.messages.at(-1)?.content !== requestText) return { choices: [{ message: { content: '已记下规则。' } }] }
        notifyModels++
        assert.ok(request.tools.some(tool => tool.function.name === 'groupKnowledgeTool'))
        assert.match(textOf(request), /开会时联系甲成员和乙成员/)
        return { choices: [{ message: { tool_calls: [{ id: 'notify-members', type: 'function', function: {
          name: 'groupKnowledgeTool', arguments: JSON.stringify({ action: 'notify', id: workflowId,
            requestExcerpt: '请现在通知会议联络', content: '明天九点开会' }),
        } }] } }] }
      },
    }, async f => {
      f.roles.set('speaker-a', 'admin')
      await f.send(group, 'teach-workflow', teaching, { mentions: [targetActor(group), actor(group, 'target-b')] })
      await f.acknowledged(group, 'teach-workflow')
      const workflow = (await f.state(group)).entries.find(entry => entry.kind === 'workflow')
      assert.ok(workflow)
      workflowId = workflow.id
      assert.ok(f.attempts.every(action => action.parts.every(part => part.kind === 'text')))
      const event = await f.send(group, 'execute-workflow', requestText)
      const notifications = f.attempts.filter(action => action.parts.some(part => part.kind === 'mention'))
      assert.equal(notifications.length, 1)
      const [notification] = notifications
      assert.equal(notification.replyTo, 'execute-workflow')
      assert.deepEqual(notification.target, group)
      assert.deepEqual(notification.binding, f.binding(group))
      assert.deepEqual(notification.parts, [
        { kind: 'mention', user: actor(group, 'target-a') },
        { kind: 'mention', user: actor(group, 'target-b') },
        { kind: 'text', text: '明天九点开会' },
      ])
      const receipt = f.deliveries.find(action => action.replyTo === 'execute-workflow' && action.parts.every(part => part.kind === 'text'))
      if (receiptState === 'sent') {
        assert.ok(receipt)
        assert.match(receipt.parts[0].text, /已按本条请求通知/)
      } else {
        assert.equal(receipt, undefined, 'unknown native delivery prevents an additional explanatory send')
      }
      assert.equal(notifyModels, 1)
      const attemptsBeforeReplay = f.attempts.length
      await f.emit(event); await f.drained(group); await f.tick()
      await f.stop(); await f.start()
      await f.emit(event); await f.drained(group); await f.tick()
      assert.equal(f.attempts.length, attemptsBeforeReplay)
      assert.equal(notifyModels, 1)
      assert.equal(f.deliveries.filter(action => action.parts.some(part => part.kind === 'mention')).length, receiptState === 'sent' ? 1 : 0)
    })
  }
})

test('Core knowledge management enforces creator permissions and administrator confirmation in another genuine message', redisTest, async t => {
  const marker = '需清空的共享定义', intents = new Map()
  let entryId
  await withFixture(t, { name: 'group-knowledge-core-clear', tools: ['groupKnowledgeTool'],
    learn: async input => input.mode === 'teaching' ? propose(input, marker) : [],
    model: async request => {
      const input = intents.get(request.messages.at(-1)?.content)
      return { choices: [{ message: input ? { tool_calls: [{ id: 'manage-knowledge', type: 'function', function: {
        name: 'groupKnowledgeTool', arguments: JSON.stringify(input),
      } }] } : { content: '收到这次消息。' } }] }
    },
  }, async f => {
    const reply = id => f.deliveries.find(action => action.replyTo === id)?.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
    await f.send(group, 'clear-teaching', `记住${marker}是甲成员`, { mentions: [targetActor(group)] })
    await f.acknowledged(group, 'clear-teaching')
    entryId = (await f.state(group)).entries[0].id
    intents.set('请删除这条共享资料', { action: 'delete', id: entryId })
    await f.send(group, 'foreign-delete', '请删除这条共享资料', { sender: actor(group, 'speaker-b') })
    assert.match(reply('foreign-delete'), /只有创建者或当前群管理员/)
    assert.equal((await f.state(group)).entries.length, 1)
    intents.set('请清空本群资料', { action: 'clear' })
    await f.send(group, 'member-clear', '请清空本群资料', { sender: actor(group, 'speaker-b') })
    assert.match(reply('member-clear'), /清空须群管理员/)
    assert.equal((await f.state(group)).entries.length, 1)

    // This ingress existed before the clear, but its capture is deliberately delayed.
    const delayed = f.event(group, 'delayed-before-clear', `记住${marker}是甲成员`, { mentions: [targetActor(group)] })
    f.roles.set('speaker-a', 'admin')
    await f.send(group, 'admin-clear-request', '请清空本群资料')
    const confirmation = reply('admin-clear-request').match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/u)?.[0]
    assert.ok(confirmation)
    assert.equal((await f.state(group)).entries.length, 1)
    intents.set('这一条没有确认码', { action: 'clear', confirmationId: confirmation })
    await f.send(group, 'invented-clear-confirmation', '这一条没有确认码')
    assert.match(reply('invented-clear-confirmation'), /另一条新消息中明确提供确认码/)
    assert.equal((await f.state(group)).entries.length, 1)

    const confirmedText = `确认清空本群资料，确认码：${confirmation}`
    intents.set(confirmedText, { action: 'clear', confirmationId: confirmation })
    await f.send(group, 'other-actor-clear-confirmation', confirmedText, { sender: actor(group, 'speaker-b') })
    assert.match(reply('other-actor-clear-confirmation'), /清空须群管理员/)
    assert.equal((await f.state(group)).entries.length, 1)
    const confirmed = await f.send(group, 'admin-clear-confirmation', confirmedText)
    assert.equal(reply('admin-clear-confirmation'), undefined, 'clearing retires the group projection loaded by this turn')
    assert.ok(!f.attempts.some(action => action.replyTo === 'admin-clear-confirmation'))
    const state = await f.state(group), owner = await f.owner(group)
    assert.deepEqual(state.entries, [])
    assert.ok(state.teachingClearedAt >= delayed.message.occurredAt)
    assert.ok(owner.clearedAt >= delayed.message.occurredAt)
    await f.emit(delayed); await f.drained(group); await f.tick()
    assert.deepEqual((await f.state(group)).entries, [])
    assert.ok(!(await f.owner(group)).records.some(row => row.messageId === delayed.message.messageId))
    assert.ok(!f.calls.some(call => call.input.messages.some(row => row.messageId === delayed.message.messageId)))
    const attemptsBeforeReplay = f.attempts.length
    await f.emit(confirmed); await f.drained(group); await f.tick()
    assert.equal(f.attempts.length, attemptsBeforeReplay)
  })
})

test('simulation exposes the same guarded workflow tool only to a genuine user wake', redisTest, async t => {
  let workflowId, workflowPrompts = 0, toolSelections = 0
  const teaching = '记住仿真会议联络规则：开会时联系甲成员和乙成员'
  const requestText = '请现在通知仿真会议联络：明天九点开会'
  await withFixture(t, { name: 'group-workflow-simulation', simulation: true,
    learn: async input => input.mode === 'teaching' ? propose(input, '仿真会议联络', {
      kind: 'workflow', condition: '开会时联系甲成员和乙成员', targetUserIds: ['target-a', 'target-b'],
    }) : [],
    model: async request => {
      if (!textOf(request).includes(requestText)) return { choices: [{ message: { content: '已处理。' } }] }
      workflowPrompts++
      if (workflowPrompts > 1) return { choices: [{ message: { content: '已处理。' } }] }
      assert.ok(request.tools.some(tool => tool.function.name === 'groupKnowledgeTool'))
      const prompt = textOf(request)
      assert.match(prompt, /开会时联系甲成员和乙成员/)
      toolSelections++
      return { choices: [{ message: { tool_calls: [{ id: 'sim-notify-members', type: 'function', function: {
        name: 'groupKnowledgeTool', arguments: JSON.stringify({ action: 'notify', id: workflowId,
          requestExcerpt: '请现在通知仿真会议联络', content: '明天九点开会' }),
      } }] } }] }
    },
    send: async action => action.parts.some(part => part.kind === 'mention')
      ? { state: 'sent', messageId: 'sim-workflow-notification' }
      : { state: 'sent', messageId: `sim-reply-${action.replyTo}` },
  }, async f => {
    f.roles.set('speaker-a', 'admin')
    await f.send(group, 'sim-teach-workflow', teaching, { mentions: [targetActor(group), actor(group, 'target-b')] })
    await f.acknowledged(group, 'sim-teach-workflow')
    await f.tick(1_000)
    await f.simulatedTurnSettled(group)
    workflowId = (await f.state(group)).entries.find(entry => entry.kind === 'workflow')?.id
    assert.ok(workflowId)
    await f.send(group, 'sim-execute-workflow', requestText)
    await f.tick(1_000)
    await waitFor(() => f.requests.some(request => textOf(request).includes(requestText)), 'simulation workflow prompt')
    await waitFor(() => f.attempts.some(action => action.parts.some(part => part.kind === 'mention')), 'simulation workflow notification')
    const notifications = f.attempts.filter(action => action.parts.some(part => part.kind === 'mention'))
    assert.equal(notifications.length, 1, JSON.stringify({ attempts: f.attempts, requests: f.requests.map(textOf), workflowPrompts, toolSelections }))
    assert.equal(notifications[0].replyTo, 'sim-execute-workflow')
    assert.deepEqual(notifications[0].parts, [
      { kind: 'mention', user: actor(group, 'target-a') },
      { kind: 'mention', user: actor(group, 'target-b') },
      { kind: 'text', text: '明天九点开会' },
    ])
    assert.equal(toolSelections, 1)
  })
})
