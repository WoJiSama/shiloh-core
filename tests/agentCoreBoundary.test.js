import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

async function waitFor(read, description) {
  const until = Date.now() + 4_000
  while (Date.now() < until) {
    const value = await read()
    if (value) return value
    await delay(20)
  }
  assert.fail(`timed out waiting for ${description}`)
}

test('independent Core uses platform-neutral scopes for binding, quotes and guarded delivery', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t)
  const account = { platform: 'fixture', namespace: 'tenant-a', id: 'account#1' }
  const sender = { ...account, id: 'member:opaque/17' }
  const target = (kind, id) => ({ account, kind, id })
  const group = target('channel', 'space:thread/17')
  const sibling = target('group', group.id)
  const other = target('thread', 'other/reply/17')
  const config = {
    version: 1,
    agents: [{ id: 'shared-role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'fixture-one', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, sibling, other].map(({kind, id}) => ({
      connectionId: 'fixture-one', kind, conversationId: id, agentId: 'shared-role',
    })),
  }
  let directory = createAgentBindingDirectory(config, 'before-change')
  let accept
  let releaseQueuedSend
  const queuedSend = new Promise(resolve => { releaseQueuedSend = resolve })
  const attempted = []
  const sent = []
  const lookedUp = []
  const modelInputs = []
  const imageSources = []
  let invalidReceipt = false
  const quoteText = '同一频道的已查证引文'
  const counterfeit = '入站附带的越界引文'
  const visual = '视觉结果里的黄绿色图案'
  const commands = {
    invalidReceipt: '首次回复验收', recall: '撤回中的回复验收', binding: '换绑中的回复验收',
  }
  const at = Date.now()
  const message = (room, id, text, fields = {}) => ({
    version: 1, conversation: room, messageId: id, occurredAt: at,
    sender, senderName: '回归群友', text, parts: [{kind: 'text', text}], mentions: [], directedToAccount: true,
    ...fields,
  })
  const tool = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const response = (...tools) => ({ choices: [{ message: { content: '', tool_calls: tools } }] })
  const adapter = {
    account, id: 'fixture-one', botName: '验收账号', botUserId: 'bot:actor',
    start: async handler => { accept = handler },
    stop: () => {},
    isReady: () => Boolean(accept),
    async readMessage(room, id, guard) {
      assert.notEqual(guard.isCurrent(), false)
      lookedUp.push({room, id})
      if (id === 'archived-message') return message(room, id, quoteText, { occurredAt: at - 5000 })
    },
    async readMessageImages(room, id, guard) {
      const text = id === 'turn-first' ? commands.invalidReceipt : '未知消息'
      const original = message(room, id, text)
      if (!guard.isCurrent() || !await guard.allowsSource(original)) return undefined
      imageSources.push(room)
      return [{ mime: 'image/png', base64: 'fixture-bytes' }]
    },
    actions: {
      async send(action, guard) {
        attempted.push(action)
        const text = action.parts.find(part => part.kind === 'text')?.text
        if (text?.includes('等待发送')) await queuedSend
        if (guard.isCurrent() === false) return { state: 'failed', code: 'guard-rejected' }
        if (text === '第一次投递状态待核实') {
          invalidReceipt = true
          return { state: 'sent', messageId: '' }
        }
        sent.push(action)
        return { state: 'sent', messageId: `result/${sent.length}` }
      },
    },
  }
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, adapters: [adapter],
    logger: { info() {}, warn() {}, error() {} },
    getSection: () => ({
      wake: { batchWindowMs: 1_000, proactiveProbability: 0, probability: 0 }, rhythm: { enabled: false },
      reflection: { enabled: false }, turn: { minSendGapMs: 0 },
    }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona: room => {
      const binding = directory.resolve(room)
      return binding && { binding, persona: {name: '合成角色'}, systemContent: '' }
    },
    describeImages: async () => visual,
    async YTapi(request) {
      const lastWake = request.messages.findLastIndex(row => typeof row.content === 'string' && row.content.includes('【执行主体】'))
      const wake = String(request.messages[lastWake]?.content || '')
      const results = request.messages.slice(lastWake).filter(row => row.role === 'tool')
      modelInputs.push({ wake, request })
      const command = [...wake.matchAll(/^#(\d+)[^\n]*(首次回复验收|撤回中的回复验收|换绑中的回复验收|新角色回复验收)[^\n]*$/gmu)].at(-1)
      const seq = Number(command?.[1])
      const choice = command?.[2]
      if (!command) return response(tool('simFinishTurn', { choice: 'silent', reason: '验收结束' }, 'other'))
      if (choice === commands.invalidReceipt && !results.length) return response(tool('simGetMessageImages', {seq}, 'read-one'))
      if (choice === commands.invalidReceipt) return response(
        tool('simSendMessage', { continuation: 'chat', messages: ['第一次投递状态待核实'], atUserIds: [sender.id], replyToSeq: seq }, 'try-send'),
        tool('simSendMessage', { continuation: 'chat', messages: ['结果未知时继续发送'], replyToSeq: seq }, 'unsafe-second'),
        tool('simFinishTurn', { choice: 'silent', reason: '验收结束' }, 'close'),
      )
      return response(tool('simFinishTurn', {
        choice: 'chat', reason: '使用本会话身份收尾', replyToSeq: seq, atUserIds: [sender.id],
        messages: [choice === '新角色回复验收' ? '新角色附带点名回复' : `${choice}等待发送`],
      }, 'finish'))
    },
  })
  const inbox = createAgentInbox(storage)
  const session = async room => JSON.parse(await reader.get(prefix + simulationSessionKey(simulationAddressKey(room))) ?? 'null')
  const emit = incoming => accept({ kind: 'message', message: incoming })
  try {
    await host.start()
    const stale = { ...directory.resolve(group), revision: 'expired' }
    const wrongAddress = { ...directory.resolve(group), target: sibling }
    await emit(message(group, 'stale-binding', '旧回合不可进入', { binding: stale }))
    await emit(message(group, 'wrong-binding', '错误会话不可进入', { binding: wrongAddress }))
    await emit(message(group, 'foreign-user', '错误租户不可进入', { sender: { ...sender, namespace: 'tenant-b' } }))
    await emit(message(group, 'self-event', '机器人回音不可进入', { sender: { ...sender, id: adapter.botUserId } }))
    await emit(message(group, '0', '非法消息 ID 不可进入'))
    assert.equal(await session(group), null)
    for (const id of ['stale-binding', 'wrong-binding', 'foreign-user', 'self-event', '0']) assert.equal(await inbox.canReply(group, id), false)

    await emit(message(group, 'turn-first', commands.invalidReceipt, {
      binding: directory.resolve(group),
      parts: [{kind: 'image'}],
      quote: { messageId: 'archived-message', author: { ...sender, id: adapter.botUserId }, text: counterfeit, parts: [] },
    }))
    await waitFor(() => invalidReceipt, 'adapter returns an invalid delivery ID')
    const firstState = await waitFor(async () => {
      const state = await session(group)
      return state?.agentHistory?.length && !state.queuedIngressWake ? state : undefined
    }, 'group context saved')
    assert.equal(firstState.recent[0].quoteText, quoteText)
    assert.equal(firstState.recent[0].quoteToSelf, false)
    assert.deepEqual(lookedUp, [{ room: group, id: 'archived-message' }])
    assert.deepEqual(imageSources, [group])
    assert.ok(modelInputs.some(({request}) => JSON.stringify(request.messages).includes(visual)))
    assert.ok(modelInputs.every(({request}) => !JSON.stringify(request.messages).includes(counterfeit)))
    assert.equal(await inbox.canReply(sibling, 'turn-first'), false)
    assert.equal(attempted.length, 1)
    assert.equal(firstState.confirmedMessageIds?.length ?? 0, 0)

    await emit(message(sibling, 'await-recall', commands.recall))
    await emit(message(other, 'await-binding', commands.binding))
    await waitFor(() => attempted.length === 3, 'two rooms wait at the adapter transport guard')
    await accept({ kind: 'recall', target: sibling, messageId: 'await-recall' })
    assert.equal(await inbox.canReply(sibling, 'await-recall'), false)
    assert.equal(await inbox.canReply(other, 'await-binding'), true)
    config.bindings.find(row => row.kind === other.kind).agentId = 'replacement'
    directory = createAgentBindingDirectory(config, 'after-change')
    releaseQueuedSend()
    await waitFor(async () => {
      const state = await session(sibling)
      return state && !state.recent.some(row => row.messageId === 'await-recall')
    }, 'recalled room state is cleaned')
    assert.equal(sent.length, 0)

    await emit(message(other, 'new-turn', '新角色回复验收'))
    await waitFor(() => sent.length === 1, 'new role confirms a reply with an opaque member ID')
    assert.deepEqual(sent[0].target, other)
    assert.equal(sent[0].binding.agentId, 'replacement')
    assert.equal(sent[0].replyTo, 'new-turn')
    assert.deepEqual(sent[0].parts[0], {kind: 'mention', user: sender})
    assert.equal(attempted.length, 4)
  } finally {
    releaseQueuedSend()
    await host.stop()
  }
})
