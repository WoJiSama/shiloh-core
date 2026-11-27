import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createStandaloneAgentCodingWorker } from '../dist/backend/bootstrap/standaloneAgentCodingWorker.js'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'
import { createAgentGroupModeration } from '../dist/backend/modules/groupAdmin/infrastructure/agentGroupModeration.js'
import { createAgentPersonalRuntime } from '../dist/backend/modules/simulation/infrastructure/agentPersonalRuntime.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createCommitmentRuntime } from '../dist/backend/modules/commitments/infrastructure/commitmentTool.js'
import { agentBindingIdentity, agentBindingToken } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { commitmentRedis } from './helpers/commitmentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '985300001' }
const group = { account, kind: 'group', id: '984220001' }
const peer = { account, kind: 'private', id: '984220002' }
const logger = { info() {}, warn() {}, error() {} }
const bindingFor = (target, agentId = 'shiloh') => ({ source: 'configured',
  id: target.id, revision: 'r1', agentId, personaId: 'initial', connectionId: 'qq', target })
const response = content => ({ model: 'synthetic', choices: [{ message: { role: 'assistant', content } }] })

function messages(target, now) {
  let id = 870020000
  return (body, { who = peer.id, mention, quote } = {}) => {
    const segments = [{ type: 'text', data: { text: body } }]
    if (mention) segments.unshift({ type: 'at', data: { qq: mention } })
    if (quote) segments.unshift({ type: 'reply', data: { id: '870019990' } })
    const incoming = decodeQqIncomingMessage({ group_id: target.id, self_id: account.id,
      user_id: who, message_id: String(++id), message_type: 'group', message: segments,
      ...(quote && { source: { message_id: '870019990', user_id: account.id } }) }, { now: now() })
    assert.ok(incoming)
    return incoming
  }
}

async function groupRuntime(t, { prior, legacy, muted } = {}) {
  const now = () => Date.UTC(2026, 9, 6, 18)
  const map = new Map(), sharedRedis = commitmentRedis(map, now)
  const binding = bindingFor(group), modelInputs = []
  const runtime = createSimulationRuntime({
    redis: { get: sharedRedis.get, set: sharedRedis.set, del: sharedRedis.del },
    now, random: () => 0, logger, durableIngress: true, unifiedGroupChat: true,
    ...(legacy ? { migratedGroupToolNames: () => [] } : {}),
    getSelf: () => ({ id: account.id, name: 'QQ 账号' }),
    getPersona: () => ({ persona: { name: '希洛' }, aliases: ['XL'], systemContent: '测试人设', binding }),
    getSection: () => ({ enabled: !muted, allGroups: true, wake: { batchWindowMs: 1000 },
      wakeGate: { enabled: false }, mood: { enabled: false }, userStyle: { enabled: false } }),
    getExecutionConfig: () => ({ useTools: true }),
    async YTapi(request) {
      modelInputs.push(request.messages)
      return response('无需发送，结束回合。')
    },
    async sendGroupMessage() { return { ok: true, messageId: 'synthetic-send' } },
  })
  t.after(async () => { runtime.stop(); await runtime.drain() })
  const scope = await runtime.conversationKey(group), key = simulationSessionKey(scope)
  if (prior) {
    const state = createDefaultSimSession(now())
    state.botId = account.id
    state.bindingToken = agentBindingToken(binding)
    state.bootstrapSent = true
    Object.assign(state.wakeConfig.triggers, { atMention: false, nameMention: false, anyMessage: true })
    map.set(key, JSON.stringify(state))
  }
  return { runtime, scope, next: messages(group, now), read: () => JSON.parse(map.get(key)), modelInputs }
}

test('迁移后的群不开场，保持上下文，旧触发器和睡眠时段不挡本人的 @ 与别名', async t => {
  const fresh = await groupRuntime(t, { legacy: true })
  assert.equal(await fresh.runtime.canInitiateGroupChat(group), false)
  const quiet = fresh.next('活动在周日十点')
  await fresh.runtime.ingest(quiet)
  assert.equal(fresh.read().queuedIngressWake, undefined)
  await fresh.runtime.ingest(fresh.next('引用不会打开新回合', { quote: true }))
  assert.equal(fresh.read().queuedIngressWake, undefined)
  await fresh.runtime.ingest(fresh.next('XL，把刚才的时间告诉我'))
  assert.equal(fresh.read().queuedIngressWake?.kind, 'nameMention')
  assert.ok(fresh.read().recent.some(message => message.messageId === quiet.messageId))

  const prior = await groupRuntime(t, { prior: true, muted: true })
  assert.equal(await prior.runtime.canInitiateGroupChat(group), false)
  await prior.runtime.ingest(prior.next('只在普通单词 xlarge 中出现'))
  assert.equal(prior.read().queuedIngressWake, undefined)
  await prior.runtime.ingest(prior.next('这个时间呢', { mention: account.id }))
  assert.equal(prior.read().queuedIngressWake?.kind, 'atMention')
  await delay(2400)
  assert.equal(fresh.modelInputs.length, 1)
  assert.match(JSON.stringify(fresh.modelInputs[0]), /活动在周日十点/u)
  assert.equal(prior.modelInputs.length, 1)
  await prior.runtime.setGroupReplyMode(prior.scope, 'auto')
  assert.equal(await prior.runtime.canInitiateGroupChat(group), true)
  assert.equal(await prior.runtime.canInitiateGroupChat(group, true), false)
})

test('自我修订和计划跟随个人，重启后仍使用新名字且保留版本', async t => {
  const map = new Map(), redis = commitmentRedis(map)
  const requests = []
  let time = Date.UTC(2026, 10, 20)
  const seed = { id: 'shiloh', name: '希洛', identity: '原始身份' }
  const create = () => createAgentPersonalRuntime({
    redis: { get: redis.get, set: redis.set, del: redis.del }, seeds: [seed, { ...seed, id: 'other' }],
    now: () => time, isCurrent: () => true, allowsText: () => true, targets: async () => [],
    contact: async () => assert.fail('no contact was requested'), failed: (_stage, error) => { throw error },
    async model(request) {
      requests.push(request)
      const data = JSON.parse(request.messages[1].content)
      if (requests.length === 1) return response(JSON.stringify({
        name: '星苔', aliases: ['希洛'], introduction: '我喜欢解谜', identity: '在聊天里更从容', reason: '我自己选的名字',
      }))
      if (data.name === '星苔') return response(JSON.stringify({ action: 'goal', title: '整理资料', draft: '写完了一半', afterMinutes: 60 }))
      if (Array.isArray(data.goals)) return response(JSON.stringify({ action: 'rest' }))
      return response(JSON.stringify({ action: 'keep' }))
    },
  })
  const primary = create()
  await primary.load()
  assert.equal(primary.profile('shiloh').name, '希洛')
  time += 10 * 60_000
  await primary.tick()
  assert.equal(primary.profile('shiloh').name, '星苔')
  assert.equal(primary.profile('other').name, '希洛')
  assert.deepEqual(primary.profiles('shiloh').map(row => row.revision), [0, 1])
  await primary.stop()
  const restarted = create()
  t.after(() => restarted.stop())
  await restarted.load()
  assert.equal(restarted.profile('shiloh').introduction, '我喜欢解谜')
  const saved = JSON.parse(map.get('bl-chat:agent-personal:v1:shiloh'))
  assert.equal(saved.goals[0].draft, '写完了一半')
})

test('私聊跨群固定托付只发送获准文字并保留原委托身份', async () => {
  const start = Date.UTC(2026, 10, 20, 4), map = new Map()
  let now = start
  const origin = bindingFor(peer), destination = bindingFor(group), delivered = []
  const service = createCommitmentRuntime({
    redis: commitmentRedis(map, () => now), logger, now: () => now, getBot: () => null,
    resolveBinding: target => target.kind === 'group' ? destination : origin,
    resolvePrivatePeer: target => target.id,
    async authorizePrivateSchedule(binding, request) {
      assert.deepEqual(binding, origin)
      assert.equal(request.messageId, '870000001')
      return request.groupId === group.id && request.text === '活动改到十点' ? { destinationBindingIdentity: agentBindingIdentity(destination) } : undefined
    },
    messageActions: { async send(action) {
      delivered.push(action)
      return { state: 'sent', messageId: '870000010' }
    } },
    isSimulationGroup: () => false, wakeSim: async () => assert.fail('固定文字不使用模型'),
    loadConfig: () => ({}),
  })
  const tool = new service.CommitmentTool()
  const args = { action: 'create', schedule_kind: 'once', schedule_time: new Date(start + 60_000).toISOString(),
    target_group_id: group.id, static_message: '活动改到十点' }
  const result = await tool.managePrivateReminder(args, { _agentBinding: origin, user_id: peer.id,
    _agentToolRequest: { occurredAt: now } }, '870000001')
  assert.match(result.confirmation, /已登记/u)
  assert.equal(delivered.length, 0)
  now += 60_001
  await service.commitmentTick(account)
  assert.deepEqual(delivered.map(action => [action.target, action.parts]), [[group, [{ kind: 'text', text: '活动改到十点' }]]])
})

test('群管理拒绝踢人提议，已判断的群消息才可执行短时处置', async () => {
  const at = Date.UTC(2026, 10, 20), redis = commitmentRedis()
  let selected = messages(group, () => at)('兼职返利，免费领取')
  let next = 'kick'
  const dispatched = []
  const receipts = []
  const service = createAgentGroupModeration({
    redis, now: () => at, isCurrent: () => true, source: async () => selected,
    canModerate: async () => true, allowsText: () => true,
    model: async () => response(JSON.stringify({ action: next })),
    dispatch: async (_binding, _source, action) => { dispatched.push(action); return { state: 'confirmed' } },
    observe: (_binding, id, state, action) => receipts.push([id, state, action]),
  })
  service.observe(selected, bindingFor(group))
  await delay(30)
  assert.deepEqual(dispatched, [])
  next = 'mute'
  selected = { ...selected, messageId: '870000123' }
  service.observe(selected, bindingFor(group))
  await delay(30)
  assert.deepEqual(dispatched, ['mute'])
  assert.deepEqual(receipts, [['870000123', 'confirmed', 'mute']])
  await service.stop()
})

test('编程工作器只能修改源码副本，验证后保留候选文件', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shiloh-author-test-'))
  const root = await realpath(directory)
  t.after(async () => {
    assert.equal(await realpath(directory), root)
    await rm(directory, { recursive: true, force: true })
  })
  const source = path.join(root, 'snapshot'), jobs = path.join(root, 'jobs')
  await mkdir(path.join(source, 'src'), { recursive: true })
  const before = 'export const interval = 1000\r\n'
  await writeFile(path.join(source, 'src', 'interval.ts'), before)
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(source, 'tsconfig.backend.json'), '{"compilerOptions":{"target":"es2022","types":[]},"include":["src/**/*.ts"]}')
  await symlink(await realpath('node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const actions = [
    { op: 'read', path: '../package.json', start: 1, count: 1 },
    { op: 'edit', path: 'src/interval.ts', start: 1, end: 1, before: 'export const interval = 1000', after: 'export const interval = 2000' },
    { op: 'check' },
    { op: 'done', summary: '调整间隔' },
  ]
  const seen = []
  const code = createStandaloneAgentCodingWorker({ source, jobs, allowsText: () => true,
    model: async request => { seen.push(request.messages.map(message => message.content)); return response(JSON.stringify(actions.shift())) },
  })
  assert.match(await code('shiloh', '把间隔改成 2000', new AbortController().signal), /已通过类型检查/u)
  assert.equal(await readFile(path.join(source, 'src', 'interval.ts'), 'utf8'), before)
  assert.match(seen[1].at(-1), /路径超出范围/u)
  const [candidate] = await readdir(jobs)
  const result = JSON.parse(await readFile(path.join(jobs, candidate), 'utf8'))
  assert.equal(result.explicitCompletion, true)
  assert.equal(result.typecheckPassed, true)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].after, 'export const interval = 2000\r\n')

  const lookup = 'export const cardRenderer = "summary"\nexport const useSummary = cardRenderer === "summary"\n'
  await writeFile(path.join(source, 'src', 'card.ts'), lookup)
  actions.push(
    { op: 'find', text: 'cardRenderer', prefix: 'src/card.ts' },
    { op: 'edit', path: 'src/card.ts', start: 1, end: 1, before: lookup.split('\n')[0], after: 'export const cardRenderer = "preview"' },
    { op: 'done', summary: 'src/card.ts 的 cardRenderer 启用 summary' },
  )
  assert.match(await code('shiloh', '只读调查卡面', new AbortController().signal, { mode: 'investigate', async ensureCurrent() {} }), /cardRenderer/u)
  assert.match(seen.at(-2).at(-1), /src\/card\.ts:1.*\nsrc\/card\.ts:2/u)
  assert.match(seen.at(-1).at(-1), /只允许读取源码/u)
  assert.equal(await readFile(path.join(source, 'src', 'card.ts'), 'utf8'), lookup)
  assert.deepEqual(await readdir(jobs), [candidate])
})
