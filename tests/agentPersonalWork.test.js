import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createStandaloneAgentToolAuthor } from '../dist/backend/bootstrap/standaloneAgentToolAuthor.js'
import { resolveStandaloneAgentCodingSnapshot } from '../dist/backend/bootstrap/standaloneAgentCodingWorker.js'
import { createAgentPersonalRuntime } from '../dist/backend/modules/simulation/infrastructure/agentPersonalRuntime.js'
import { createAgentCoreCapabilities } from '../dist/backend/modules/tools/infrastructure/agentCoreCapabilities.js'
import { createCommitmentStore } from '../dist/backend/modules/commitments/infrastructure/commitmentStore.js'
import { createCommitmentRuntime } from '../dist/backend/modules/commitments/infrastructure/commitmentTool.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { commitmentRedis } from './helpers/commitmentRedis.js'

const logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'qq', namespace: 'global', id: '985300001' }
const group = { account, kind: 'group', id: '984220001' }
const sibling = { account, kind: 'group', id: '984220002' }
const author = { ...account, id: '984220099' }
const seed = { id: 'shiloh', name: '希洛', identity: '我会主动跟进自己的小队活动安排。' }
const personalKey = 'bl-chat:agent-personal:v1:shiloh'
const minute = 60_000
const response = value => ({ model: 'fixture', choices: [{ message: { content: JSON.stringify(value) } }] })
const digest = value => createHash('sha256').update(value).digest('hex')

async function waitFor(probe, description, timeout = 8000) {
  const until = Date.now() + timeout
  do {
    const result = await probe()
    if (result) return result
    await delay(25)
  } while (Date.now() < until)
  assert.fail('Timed out waiting for ' + description)
}

function askOnline(request, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [process.env.BL_AGENT_PERSONAL_MODEL_BRIDGE], {
      cwd: process.env.BL_CHAT_AGENT_RELEASE_DIR || process.cwd(), signal, timeout: 40_000,
    }, (error, stdout, stderr) => {
      if (error) {
        const diagnostic = stderr.match(/provider_http_[0-9]{3}|no_model_text|provider_timeout|model_transport_or_configuration_error/u)?.[0]
        console.log(JSON.stringify({ diagnostic: diagnostic ?? error.code ?? error.name }))
        reject(new Error('isolated_model_call_failed'))
        return
      }
      try {
        const result = JSON.parse(stdout)
        const parsed = JSON.parse(result.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/giu, ''))
        console.log(JSON.stringify({ model: result.returnedModel || result.configuredModel, action: parsed.action,
          state: parsed.state, tokens: result.usage?.total_tokens }))
        resolve({ model: result.returnedModel || result.configuredModel, choices: [{ message: { content: result.content } }], usage: result.usage })
      } catch {
        console.log(JSON.stringify({ diagnostic: 'invalid_model_content' }))
        reject(new Error('isolated_model_response_invalid'))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

for (const online of [false, true]) test(online ? 'online model continues an XL roster booking across days' : 'XL roster booking uses group evidence and survives a Core restart', {
  skip: !redisAvailable || online && !process.env.BL_AGENT_PERSONAL_MODEL_BRIDGE, timeout: online ? 115_000 : 28_000,
}, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'agent-personal-xl')
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: seed.id, personaId: 'default' }],
    connections: [{ id: 'fixture-qq', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, sibling].map(target => ({ connectionId: 'fixture-qq', kind: 'group', conversationId: target.id, agentId: seed.id })),
  }, 'stable-config')
  const flows = [], sent = [], transcript = new Map()
  const store = createCommitmentStore({ redis: storage, logger })
  const start = Date.UTC(2026, 10, 22, 12)
  const eventTime = '2026-11-23T20:00:00+08:00'
  const reminderTime = '2026-11-23T19:55:00+08:00'
  let clock = start, ready = false, accept
  const adapter = {
    id: 'fixture-qq', account, botUserId: account.id, botName: seed.name,
    async start(handler) { accept = handler; ready = true },
    stop() { ready = false }, isReady: () => ready,
    async readMessage(target, id, guard) {
      const original = transcript.get(id)
      return guard.isCurrent() && original?.conversation.id === target.id ? structuredClone(original) : undefined
    },
    actions: { async send(action) { sent.push(action); return { state: 'sent', messageId: '870000025' } } },
  }
  const options = {
    storage, adapters: [adapter], logger, now: () => clock, isExecutionCurrent: isCurrent, unifiedGroupChat: true,
    personalSeeds: [seed], managementBindings: { list: () => directory.listBindings(), resolve: directory.resolve },
    resolvePersona(target) {
      const binding = directory.resolve(target)
      return binding && { binding, persona: { name: seed.name }, systemContent: '' }
    },
    getSection: () => ({ wake: { probability: 0, proactiveProbability: 0 }, reflection: { enabled: false },
      lifeThreads: { enabled: false }, personProfile: { enabled: false }, mood: { enabled: false } }),
    getExecutionConfig: () => ({}),
    async YTapi(request, _config, signal) {
      const instruction = request.messages?.[0]?.content
      if (instruction?.includes('自主档案修订')) return response({ action: 'keep' })
      if (!instruction?.includes('你自己的工作回合') && !instruction?.includes('你在查看自己选中的群')) return response({ action: 'rest' })
      const input = JSON.parse(request.messages[1].content)
      if (instruction?.includes('你在查看自己选中的群')) {
        assert.deepEqual(input.messages.map(row => row.messageId), ['870000001'])
        return online ? askOnline(request, signal) : response({ action: 'goal', afterMinutes: 5 })
      }
      if (!input.goal) return response({ action: 'look-group', key: input.targets.find(target => target.label.includes(group.id)).key })
      assert.ok(input.messages.every(row => row.messageId === '870000001'))
      if (!input.reservation) assert.ok(input.messages[0]?.text.includes(eventTime))
      flows.push(input.reservation?.status ?? 'planning')
      if (online) return askOnline(request, signal)
      if (input.reservation?.status === 'completed') return response({ action: 'goal', state: 'completed' })
      return response({ action: 'reserve', sourceMessageId: '870000001', at: reminderTime, text: '五分钟后是已确认的 XL 小队活动。' })
    },
  }
  let host = createAgentRuntime(options)
  t.after(() => host.stop())
  const readState = async () => JSON.parse((await storage.get(personalKey)) ?? 'null')
  async function message(target, id, text) {
    const value = { version: 1, conversation: target, sender: author, senderName: '示例队友', occurredAt: clock,
      messageId: id, text, parts: [{ kind: 'text', text }], directedToAccount: false, mentions: [] }
    transcript.set(id, value)
    await accept({ kind: 'message', message: value })
  }
  await host.start()
  await message(group, '870000001', 'XL 阵容已确认：四个报名位已满。活动 ' + eventTime + ' 开始，群里 ' + reminderTime + ' 发一条文字提醒就好。')
  await message(sibling, '870000002', '另一个群的阵容和本群的安排无关。')
  clock = start + 10 * minute
  const goal = await waitFor(async () => {
    const goal = (await readState()).goals[0]
    return goal?.targetKey && goal
  }, 'a bound personal goal', online ? 45_000 : 8000)
  clock = goal.nextAt + 1
  const appointment = await waitFor(async () => (await store.listActiveCommitments()).find(item => item.ownedReservation),
    'the real commitments ledger to contain the booking', online ? 45_000 : 8000)
  assert.equal(appointment.schedule.time, Date.parse(reminderTime))
  assert.equal(appointment.group_id, group.id)
  assert.equal(appointment.creator_id, account.id)
  assert.equal(appointment.ownedReservation.source.messageId, '870000001')
  await waitFor(async () => (await readState()).receipts.some(item => item.operation === 'reserve' && item.state === 'confirmed'), 'registration receipt')
  assert.equal(sent.length, 0)
  await host.stop()
  clock = Date.parse(reminderTime) + 1
  host = createAgentRuntime(options)
  await host.start()
  await waitFor(async () => (await store.getCommitment(appointment.id))?.status === 'completed', 'delivery after restart')
  assert.deepEqual(sent.map(action => [action.target.id, action.parts.map(part => part.kind)]), [[group.id, ['text']]])
  clock = Math.max(clock + 10 * minute, (await readState()).goals[0].nextAt + 1)
  await host.resumePendingWork()
  await waitFor(() => flows.includes('completed'), 'reflection sees the authoritative delivery state', online ? 45_000 : 8000)
  await waitFor(async () => (await readState()).goals.some(goal => goal.state === 'completed'), 'goal closure', online ? 45_000 : 8000)
  assert.equal(sent.length, 1)
})

test('an uncertain contact stays linked to its goal after restart and is reconciled without a retry', async t => {
  const values = new Map(), failures = [], sent = [], checks = []
  let clock = Date.UTC(2026, 10, 22, 12), deliverProof = false
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' } }
  const create = () => createAgentPersonalRuntime({
    redis, seeds: [seed], now: () => clock, isCurrent: () => true, allowsText: () => true,
    targets: async () => [{ key: 'peer', kind: 'private', label: '测试好友' }],
    async contact(_id, key, body) { sent.push([key, body]); return { state: 'unknown' } },
    async verifyContact(_id, key, proof) {
      checks.push([key, proof.sha256])
      return deliverProof ? '870000042' : undefined
    },
    failed(stage) { failures.push(stage) },
    async model(request) {
      const input = JSON.parse(request.messages[1].content)
      if (!input.goals) return response({ action: 'keep' })
      if (!input.goals.length) return response({ action: 'goal', title: '安排一次联系', afterMinutes: 5 })
      return response({ action: 'contact', goalId: input.goals[0].id, key: 'peer', text: '请问周末有空吗？', afterMinutes: 5 })
    },
  })
  let runtime = create()
  t.after(() => runtime.stop())
  await runtime.load()
  clock += 10 * minute
  await runtime.tick()
  clock += 5 * minute
  await runtime.tick()
  assert.equal(sent.length, 1)
  assert.equal(runtime.workSummary(seed.id, () => true).actions[0].state, 'unknown')
  await runtime.stop()
  runtime = create()
  await runtime.load()
  clock += 5 * minute
  await runtime.tick()
  assert.deepEqual(checks, [['peer', digest('请问周末有空吗？')]])
  assert.equal(sent.length, 1)
  assert.equal(failures.length, 1)
  deliverProof = true
  clock += 15 * minute
  await runtime.tick()
  assert.equal(sent.length, 1)
  const saved = JSON.parse(values.get(personalKey))
  assert.equal(saved.receipts[0].state, 'confirmed')
  assert.equal(saved.receipts[0].goalId, saved.goals[0].id)
  assert.equal(saved.receipts[0].messageId, '870000042')
})

test('a quiet agent chooses its next wake and can contact a peer without an incoming message or goal', async t => {
  const values = new Map(), sent = [], choices = [], failures = []
  const start = Date.UTC(2026, 10, 26, 6), privateKey = 'bound-friend'
  let clock = start, decision = { action: 'rest', afterMinutes: 40 }
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' } }
  const create = () => {
    const capabilities = createAgentCoreCapabilities(() => true)
    const runtime = createAgentPersonalRuntime({ redis, seeds: [seed], now: () => clock, isCurrent: () => true, capabilities,
      allowsText: () => true, failed: (...args) => failures.push(args),
      targets: async () => [{ kind: 'private', key: privateKey, label: '测试好友' }],
      async model(request) {
        const input = JSON.parse(request.messages[1].content)
        if (!input.goals) return response({ action: 'keep' })
        choices.push(input.canStartContact)
        return response(decision)
      },
      async contact(_id, key, body) { sent.push({ key, body }); return { state: 'sent', messageId: '870000043' } },
    })
    return { runtime, capabilities }
  }
  let { runtime, capabilities } = create()
  t.after(() => runtime.stop())
  await runtime.load()
  const legacy = JSON.parse(values.get(personalKey))
  delete legacy.lastWorkAt
  legacy.nextWorkAt = start + 6 * 60 * minute
  legacy.goals.push({ id: 'later', title: '下午的计划', draft: '', nextAt: start + 120 * minute, state: 'active' })
  values.set(personalKey, JSON.stringify(legacy))
  await runtime.stop()
  ;({ runtime, capabilities } = create())
  await runtime.load()
  const first = runtime.workSummary(seed.id, () => true)
  assert.equal(first.nextWorkAt, start + minute)
  assert.equal(first.goals[0].nextAt, start + 120 * minute)
  clock = first.nextWorkAt
  await runtime.tick()
  const resting = runtime.workSummary(seed.id, () => true)
  assert.equal(resting.lastChoice, '休息')
  assert.equal(resting.nextWorkAt, clock + 40 * minute)
  await runtime.stop()
  ;({ runtime, capabilities } = create())
  await runtime.load()
  decision = { action: 'contact', key: privateKey, text: '我试了一种新的拼图排法，突然想到你也喜欢这个。' }
  clock = resting.nextWorkAt - 1
  await runtime.tick()
  assert.equal(sent.length, 0)
  clock++
  await Promise.all([runtime.tick(), runtime.tick()])
  assert.deepEqual(sent, [{ key: privateKey, body: decision.text }])
  const activity = async key => JSON.parse((await capabilities.call('personal.activity', {}, { agentId: seed.id,
    origin: { key, revision: 'v1' }, isCurrent: () => true, signal: new AbortController().signal })).content)
  assert.deepEqual((await activity(privateKey)).confirmedContactsHere, [clock])
  assert.equal((await activity(privateKey)).lastChoice, '主动联系')
  assert.deepEqual((await activity('another-scene')).confirmedContactsHere, [])
  assert.equal((await activity('another-scene')).lastChoice, undefined)
  assert.equal(runtime.workSummary(seed.id, () => true).actions[0].goalId, undefined)
  await runtime.stop()
  ;({ runtime, capabilities } = create())
  await runtime.load()
  clock += 90 * minute
  await runtime.tick()
  assert.deepEqual(choices, [true, true, false])
  assert.equal(sent.length, 1)
  assert.deepEqual(failures, [])
})

test('a due personal goal sees its original deadline and keeps the independent wake on the calendar', async t => {
  const values = new Map(), inputs = []
  let clock = Date.UTC(2026, 10, 26, 6)
  const runtime = createAgentPersonalRuntime({ seeds: [seed], now: () => clock, isCurrent: () => true, allowsText: () => true,
    redis: { async get(k) { return values.get(k) ?? null }, async set(k, v) { values.set(k, v); return 'OK' } },
    targets: async () => [{ key: 'group', kind: 'group', label: '测试群' }], async contact() { assert.fail('no delivery') },
    failed: (_stage, error) => assert.fail(error),
    async model(request) {
      const input = JSON.parse(request.messages[1].content)
      if (!input.goals) return response({ action: 'keep' })
      inputs.push(input)
      return response(inputs.length === 1 ? { action: 'goal', title: '试一试新的排法', afterMinutes: 5 } :
        { action: 'rest', afterMinutes: 180 })
    },
  })
  t.after(() => runtime.stop())
  await runtime.load()
  clock += 10 * minute
  await runtime.tick()
  const generalDue = clock + 90 * minute
  clock += 5 * minute
  await runtime.tick()
  assert.equal(inputs[1].dueGoalId, inputs[1].goals[0].id)
  assert.equal(inputs[1].goals[0].nextAt, clock)
  assert.equal(runtime.workSummary(seed.id, () => true).nextWorkAt, generalDue)
  clock = generalDue
  await runtime.tick()
  assert.equal(inputs[2].dueGoalId, undefined)
})

test('a chosen group can receive a fresh same-scene follow-up after everyone has gone quiet', async t => {
  const values = new Map(), sent = [], failures = []
  let clock = Date.UTC(2026, 10, 26, 8), selectedId = 'invented', currentSource = true
  const selected = 'chosen-group', originalAt = clock
  const runtime = createAgentPersonalRuntime({
    redis: { async get(k) { return values.get(k) ?? null }, async set(k, v) { values.set(k, v); return 'OK' } },
    seeds: [seed], now: () => clock, isCurrent: () => true, allowsText: () => true, failed: (...args) => failures.push(args),
    targets: async () => [selected, 'other-group'].map(key => ({ key, kind: 'group', label: key })),
    groupContext: async (_id, key) => {
      assert.equal(key, selected)
      return { messages: [{ messageId: 'source', authorId: 'author', name: '群友', text: '我想试试用旧车票做书签', at: originalAt }],
        isCurrent: async () => currentSource }
    },
    async model(request) {
      const input = JSON.parse(request.messages[1].content)
      if (input.messages) return response({ action: 'contact', sourceMessageId: selectedId, key: 'other-group', text: '那张带日期的票，做书签刚好能记住是哪一趟。' })
      return response(input.goals ? { action: 'look-group', key: selected } : { action: 'keep' })
    },
    async contact(_id, key, body, _signal, _current, sourceCurrent) {
      assert.ok(await sourceCurrent())
      sent.push({ key, body })
      return { state: 'sent', messageId: '870000047' }
    },
  })
  t.after(() => runtime.stop())
  await runtime.load()
  clock += 10 * minute
  await runtime.tick()
  assert.equal(sent.length, 0)
  selectedId = 'source'
  clock += 90 * minute
  await runtime.tick()
  assert.deepEqual(sent.map(row => row.key), [selected])
  assert.equal(JSON.parse(values.get(personalKey)).lastChoice.groupRead, 'read')
  clock += 5 * 60 * minute
  await runtime.tick()
  assert.equal(sent.length, 1)
  assert.deepEqual(failures, [])
  currentSource = false
  clock += 90 * minute
  await runtime.tick()
  assert.equal(sent.length, 1)
})

test('owned reservations use native delivery proofs and cancel when their group source disappears', async () => {
  const start = Date.UTC(2026, 10, 22), messages = []
  let clock = start, allowed = true, proved = false
  const binding = { source: 'configured', id: group.id, revision: 'r1', agentId: seed.id, personaId: 'default', connectionId: 'qq', target: group }
  const source = { messageId: '870000001', authorId: author.id, at: start }
  const runtime = createCommitmentRuntime({
    redis: commitmentRedis(new Map(), () => clock), now: () => clock, logger,
    resolveBinding: () => binding, getBot: () => null, loadConfig: () => ({}),
    isSimulationGroup: () => true, wakeSim: async () => assert.fail('static promise'),
    async authorizeOwnedSource() { return allowed },
    async verifyOwnedDelivery(_binding, proof) {
      assert.equal(proof.sha256, digest('阵容预约提醒'))
      assert.equal(proof.from, start + minute)
      return proved ? '870000040' : undefined
    },
    messageActions: { async send(action) { messages.push(action); return { state: 'unknown' } } },
  })
  const reserve = goal => runtime.reserveOwned(binding, goal, source, new Date(clock + minute).toISOString(), '阵容预约提醒', () => true)
  const first = await reserve('first')
  clock += minute
  await runtime.commitmentTick(account)
  assert.equal((await runtime.ownedReservation(binding, 'first')).status, 'unknown')
  proved = true
  assert.equal((await runtime.ownedReservation(binding, 'first')).status, 'completed')
  assert.equal((await runtime.store.getCommitment(first.id)).ownedReservation.verifiedMessageId, '870000040')
  const second = await reserve('second')
  allowed = false
  clock += minute
  await runtime.commitmentTick(account)
  assert.equal((await runtime.store.getCommitment(second.id)).status, 'cancelled')
  assert.equal(messages.length, 1)
})

test('the isolated author and publisher activate validated tool versions and roll back a revision', async t => {
  const values = new Map(), errors = []
  let clock = Date.UTC(2026, 10, 22), phase = 0
  const publishTool = createStandaloneAgentToolAuthor({
    allowsText: () => true,
    async model(_id, request) {
      const { name, task } = JSON.parse(request.messages[1].content)
      return response({ definition: { name, description: task, steps: [{ kind: 'added' }, { kind: 'unique' },
        ...(task === '统计新增行' ? [{ kind: 'count' }] : [])] },
      examples: [{ before: '甲', after: '甲\n乙\n乙', expected: task === '统计新增行' ? '1' : task === '错误版本' ? '错' : '乙' }] })
    },
  })
  const runtime = createAgentPersonalRuntime({
    redis: { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' } },
    seeds: [seed], now: () => clock, isCurrent: () => true, allowsText: () => true, publishTool,
    targets: async () => [], contact: async () => assert.fail('not a contact'),
    failed(stage) { errors.push(stage) },
    async model(request) {
      if (request.messages[0].content.includes('自主档案修订')) return response({ action: 'keep' })
      return response(phase === 3 ? { action: 'rollback-tool', name: '新成员', revision: 1 } :
        { action: 'make-tool', name: '新成员', task: ['显示新增行', '错误版本', '统计新增行'][phase] })
    },
  })
  t.after(() => runtime.stop())
  await runtime.load()
  clock += 10 * minute
  for (const expected of [1, 1, 2, 1]) {
    await runtime.tick()
    assert.equal(runtime.workSummary(seed.id, () => true).tools[0]?.activeRevision, expected)
    phase++
    clock += 6 * 60 * minute
  }
  assert.deepEqual(errors, ['personal_work'])
})

test('coding snapshot resolves the running release and rejects an unrelated source marker', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'shiloh-source-reference-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const commit = 'a'.repeat(40), manifest = path.join(folder, 'manifest.json'), source = path.join(folder, commit)
  await mkdir(source)
  await writeFile(manifest, JSON.stringify({ commit }))
  await writeFile(path.join(source, 'source-commit'), 'b'.repeat(40) + '\n')
  await assert.rejects(resolveStandaloneAgentCodingSnapshot(folder, pathToFileURL(manifest)), /不一致/u)
  await writeFile(path.join(source, 'source-commit'), commit + '\n')
  assert.equal((await resolveStandaloneAgentCodingSnapshot(folder, pathToFileURL(manifest))).baseCommit, commit)
})
