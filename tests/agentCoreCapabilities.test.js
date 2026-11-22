import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentPersonalRuntime } from '../dist/backend/modules/simulation/infrastructure/agentPersonalRuntime.js'
import { createAgentCoreCapabilities } from '../dist/backend/modules/tools/infrastructure/agentCoreCapabilities.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const logger = { info() {}, warn() {}, error() {} }
const seed = { id: 'shiloh', name: '希洛', identity: '对自己的工程感兴趣。' }
const personalKey = 'bl-chat:agent-personal:v1:shiloh'
const start = Date.UTC(2026, 10, 22, 8)
const card = { title: '调查 B 站搬运卡面', task: '核对简介是在哪个步骤被渲染成图片的，给出代码依据。', mode: 'investigate' }
const proof = { messageId: '870010001', authorId: '984220099', at: start }
const source = { key: 'fixture-source', revision: 'v1', message: proof }
const chatReply = text => ({ choices: [{ message: { content: text } }] })
const turn = (origin, isCurrent = () => true) => ({
  agentId: seed.id, ...(origin ? { origin } : {}), signal: new AbortController().signal, isCurrent,
})

test('a capability added once is discovered and guarded on every Core scope', async () => {
  const capabilities = createAgentCoreCapabilities(() => true)
  const input = { type: 'object', properties: {}, required: [], additionalProperties: false }
  let live = true
  capabilities.register([{
    name: 'sample.action', description: '样例工作', parameters: input, mutates: true,
    available: () => live, async execute() { return { status: 'succeeded', content: 'done' } },
  }])
  for (const scope of [turn(), turn(source), turn({ ...source, key: 'fixture-friend' })]) {
    assert.deepEqual(capabilities.list(scope).map(item => item.name), ['sample.action'])
    assert.equal((await capabilities.call('sample.action', {}, scope)).status, 'succeeded')
  }
  const tool = capabilities.tool(turn(source))
  live = false
  assert.equal((await tool.execute({ action: 'call', name: 'sample.action' }, turn(source))).status, 'failed')
})

test('the engineering job survives a restart and keeps its originating scope', async () => {
  const values = new Map(), calls = []
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' } }
  let recalled = false
  const create = async () => {
    const capabilities = createAgentCoreCapabilities(() => true)
    const personal = createAgentPersonalRuntime({ redis, seeds: [seed], now: () => start, isCurrent: () => true,
      capabilities, allowsText: () => true, workSourceCurrent: async () => !recalled,
      targets: async () => [], contact: async () => { assert.fail('engineering work never sends QQ messages') },
      model: async () => chatReply('{"action":"rest"}'), failed() {},
      async coding(agentId, task, _signal, options) {
        await options.ensureCurrent()
        calls.push({ agentId, task, mode: options.mode })
        return '简介在 summary 渲染步骤生成图片'
      },
    })
    await personal.load()
    return { capabilities, personal }
  }
  let { capabilities, personal } = await create()
  const submit = () => capabilities.call('engineering.submit', card, turn(source)).then(outcome => JSON.parse(outcome.content))
  const [first, repeated] = await Promise.all([submit(), submit()])
  assert.deepEqual(first, { id: repeated.id, status: 'queued' })
  await personal.stop()
  const restarted = await create()
  capabilities = restarted.capabilities
  personal = restarted.personal
  assert.equal(calls.length, 0)
  const [work] = personal.dueEngineeringWork()
  await Promise.all([work.run(), work.run()])
  assert.deepEqual(calls, [{ agentId: seed.id, task: card.task, mode: card.mode }])
  const status = scope => capabilities.call('engineering.status', { id: first.id }, scope).then(outcome => JSON.parse(outcome.content))
  assert.deepEqual(await status(turn()), [])
  assert.deepEqual(await status(turn({ ...source, key: 'other-group' })), [])
  assert.deepEqual(await status(turn({ ...source, revision: 'v2' })), [])
  assert.deepEqual(await status(turn(source)), [{ id: first.id, status: 'confirmed', result: '简介在 summary 渲染步骤生成图片' }])
  recalled = true
  assert.deepEqual(await status(turn(source)), [])
  await personal.stop()
})

test('QQ @ and private chat use the same Core directory and a later @ sees the developer result', {
  skip: !redisAvailable, timeout: 45_000,
}, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-core-capabilities')
  const account = { platform: 'qq', namespace: 'global', id: '985300001' }
  const sender = { ...account, id: proof.authorId }
  const group = { account, kind: 'group', id: '984220001' }
  const peer = { account, kind: 'private', id: proof.authorId }
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: seed.id, personaId: 'default' }],
    connections: [{ id: 'qq', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, peer].map(target => ({ connectionId: 'qq', kind: target.kind, conversationId: target.id, agentId: seed.id })),
  }, 'stable')
  const sent = [], observed = [], history = new Map(), jobs = []
  let ready = false, accept
  const adapter = {
    id: 'qq', account, botUserId: account.id, botName: seed.name,
    isReady: () => ready, stop() { ready = false }, async start(handler) { accept = handler; ready = true },
    resolvePrivatePeer: () => sender, async verifyPrivateFriend() { return true },
    async readMessage(target, id, guard) {
      const row = history.get(id)
      return guard.isCurrent() && row?.conversation.id === target.id ? structuredClone(row) : undefined
    },
    actions: { async send(action) { sent.push(action); return { state: 'sent', messageId: String(870011000 + sent.length) } } },
  }
  const call = (name, input) => ({ choices: [{ message: { content: null, tool_calls: [
    { id: name + '-' + observed.length, type: 'function', function: { name, arguments: JSON.stringify(input) } },
  ] } }] })
  const host = createAgentRuntime({
    adapters: [adapter], storage, logger, now: () => start, isExecutionCurrent: isCurrent, unifiedGroupChat: true,
    privateChatEnabled: true, personalSeeds: [seed], managementBindings: { list: directory.listBindings, resolve: directory.resolve },
    resolvePersona(target) {
      const binding = directory.resolve(target)
      return binding && { binding, persona: { name: seed.name, toolEnabled: true }, systemContent: '' }
    },
    getSection: () => ({ wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false },
      lifeThreads: { enabled: false }, personProfile: { enabled: false }, mood: { enabled: false } }),
    getExecutionConfig: () => ({ useTools: true }),
    async codingWorker(agentId, task, _signal, work) {
      await work.ensureCurrent()
      jobs.push({ agentId, task, mode: work.mode })
      return '已读源码。简介图片由 summary 提前生成。'
    },
    async YTapi(request) {
      if (request.response_format) return chatReply('{"action":"rest"}')
      const isGroup = request.tools?.some(tool => tool.function.name === 'simFinishTurn')
      const bodies = JSON.stringify(request.messages)
      if (!bodies.includes('卡面')) return chatReply('收到')
      const result = request.messages.filter(message => message.role === 'tool' && message.name === 'coreCapabilities').at(-1)
      observed.push({ tools: request.tools.map(tool => tool.function.name), result })
      if (!result) return call('coreCapabilities', { action: 'list' })
      const envelope = isGroup ? JSON.parse(result.content).content : result.content
      const parsed = JSON.parse(envelope)
      const checking = bodies.includes('任务进展')
      if (Array.isArray(parsed) && parsed.some(item => item.name === 'engineering.submit')) {
        return call('coreCapabilities', { action: 'call', name: checking ? 'engineering.status' : 'engineering.submit', input: checking ? {} : card })
      }
      if (!isGroup) return chatReply(Array.isArray(parsed) && !parsed.length ? '这边没有工程任务' : '任务可查')
      const text = checking ? parsed[0]?.result : '已登记工程任务 ' + parsed.id
      return call('simFinishTurn', { choice: 'chat', messages: [text] })
    },
  })
  t.after(() => host.stop())
  const waitFor = async predicate => {
    for (let i = 0; i < 240; i++) {
      const value = await predicate()
      if (value) return value
      await delay(40)
    }
    assert.fail('timed out waiting for the isolated turn and durable task')
  }
  const state = async () => JSON.parse(await storage.get(personalKey))
  async function send(target, id, text) {
    const message = { version: 1, conversation: target, sender, senderName: '排查样例',
      occurredAt: start, messageId: id, text, directedToAccount: true, mentions: target.kind === 'group' ? [account] : [],
      parts: [{ kind: 'text', text }] }
    history.set(id, message)
    await accept({ kind: 'message', message })
  }
  await host.start()
  await send(group, proof.messageId, '你看一下 B 站卡面为什么把文字转成图，先调查原因。')
  const done = await waitFor(async () => (await state()).goals.find(goal => goal.engineering?.status === 'confirmed'))
  assert.equal(done.engineering.origin.message.messageId, proof.messageId)
  assert.deepEqual(jobs, [{ agentId: seed.id, task: card.task, mode: card.mode }])
  await waitFor(() => sent.some(action => action.parts.some(part => part.text?.includes(done.id))))
  await send(peer, '870010002', '卡面任务进展怎么样？')
  await waitFor(() => sent.some(action => action.target.kind === 'private' && action.parts.some(part => part.text?.includes('没有工程任务'))))
  await send(group, '870010003', '卡面任务进展怎么样？')
  await waitFor(() => sent.some(action => action.target.kind === 'group' && action.parts.some(part => part.text?.includes('提前生成'))))
  assert.equal((await state()).goals.length, 1)
  assert.ok(observed.every(round => round.tools.includes('coreCapabilities')))
})
