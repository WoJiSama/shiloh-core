import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { decodeQqRecall } from '../dist/backend/adapters/qqMessage.js'
import { resolveQqConversationAddress } from '../dist/backend/adapters/qqIdentity.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { revokePersonMemoryNotice } from '../dist/backend/modules/memory/infrastructure/personMemoryLifecycle.js'
import { createMessagePipelineClass } from '../dist/backend/modules/messaging/infrastructure/messagePipeline.js'
import { createEventEnvelope } from '../dist/backend/modules/messaging/infrastructure/eventEnvelope.js'
import { createEventEnvelope as createQqPipelineEnvelope } from '../utils/messagePipeline/eventEnvelope.js'
import { readScopedPersonProfile, filterScopedProfileMessages } from '../dist/backend/modules/memory/infrastructure/personProfileRuntime.js'
import { createPersonProfileClass } from '../dist/backend/modules/memory/application/personProfileInjector.js'
import { Reflector } from '../dist/backend/modules/memory/infrastructure/engine/reflector.js'
import { makeFact } from '../dist/backend/modules/memory/infrastructure/engine/entityModel.js'
import { MidtermSummaryManager } from '../dist/backend/modules/memory/infrastructure/MidtermSummaryManager.js'

const identity = { botId: '90001', personaId: 'lifecycle' }
const person = '10001', other = '10002'
const sceneA = { kind: 'group', id: '20001' }, sceneB = { kind: 'group', id: '20002' }
const quiet = { warn() {}, info() {}, error() {} }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const ai = { memoryAiUrl: 'https://fixture.invalid', memoryAiApikey: 'fixture', memoryAiModel: 'fixture' }

function fixture() {
  let now = Date.now() - 100_000
  const values = new Map()
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' }, async del(key) { return Number(values.delete(key)) } }
  const store = createPersonMemoryStore({ redis, now: () => now })
  const source = (messageId, excerpt, scene = sceneA, authorId = person) => ({ scene, authorId, messageId, at: now, excerpt })
  const write = (text, extra = {}) => store.remember({ identity, subjectId: person, text, source: source(text, text), category: 'fact', evidenceKind: 'self', ...extra })
  const read = (scene = sceneA, viewer = identity) => store.query({ identity: viewer, subjectId: person, viewerUserId: person, scene })
  return { store, source, write, read, redis, now: () => now, advance(ms = 1000) { now += ms } }
}

test('the QQ simulation entry recognizes the same legacy recall notices as the message pipeline', async () => {
  const source = ts.createSourceFile('Simulation.js', readFileSync(new URL('../apps/Simulation.js', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const pluginClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SimulationRecallPlugin')
  const method = pluginClass?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'handleRecall')
  assert.ok(method)
  const recalled = []
  const handler = new Function('decodeQqRecall', 'resolveQqConversationAddress', 'simulationRuntime',
    `return ({ ${method.getText(source)} }).handleRecall`)(decodeQqRecall, resolveQqConversationAddress, {
    async handleRecall(event, target) { recalled.push({ event, target }) },
  })
  const common = { post_type: 'notice', self_id: identity.botId, group_id: sceneA.id, user_id: person, message_id: '00042' }
  await handler({ ...common, notice_type: 'group', sub_type: 'recall' })
  await handler({ ...common, notice_type: 'friend', sub_type: 'recall' })
  await handler({ ...common, notice_type: 'group_recall', bot: { uin: '90002' } })
  assert.deepEqual(recalled, [{ event: { message_id: '00042' },
    target: { account: { platform: 'qq', namespace: 'global', id: identity.botId }, kind: 'group', id: sceneA.id } }])
})

test('pipeline revokes both Yunzai and OneBot evidence before deciding whether notices are archived', async () => {
  const f = fixture()
  assert.equal((await f.write('已撤回的旧格式事实', { source: f.source('00042', '已撤回的旧格式事实') })).saved, true)
  assert.equal((await f.write('已撤回的 OneBot 事实', { source: f.source('-73', '已撤回的 OneBot 事实') })).saved, true)
  let archiveCalls = 0
  let currentPersonaReads = 0
  const Pipeline = createMessagePipelineClass({ createEventEnvelope, onRecall: event => revokePersonMemoryNotice(f.store, event, () => {
    currentPersonaReads++
    throw new Error('fixture: invalid current role binding file')
  }) })
  const pipeline = new Pipeline({ store: {}, recentManager: {}, mediaOutbox: {}, emojiCollector: {}, logger: quiet, archiveManager: { shouldRecordNotice: () => false, recordNotice: async () => { archiveCalls++ } } })
  const common = { post_type: 'notice', self_id: identity.botId, group_id: sceneA.id, user_id: person }
  const legacy = createQqPipelineEnvelope({ ...common, notice_type: 'group', sub_type: 'recall', message_id: '00042' })
  const oneBot = createQqPipelineEnvelope({ ...common, notice_type: 'group_recall', message_id: -73 })
  assert.equal(legacy.messageId, '00042')
  assert.equal(oneBot.messageId, '-73')
  const job = pipeline.createJob(JSON.parse(JSON.stringify(legacy)))
  f.advance()
  await pipeline.processNotice(job)
  assert.equal(job.consumers.archive, 'skipped')
  assert.equal(archiveCalls, 0)
  assert.deepEqual((await f.read()).items.map(item => item.source.messageId), ['-73'])
  const first = await f.store.getSceneRedactions({ identity, scene: sceneA })
  f.advance()
  await pipeline.processNotice(pipeline.createJob(legacy))
  assert.deepEqual(await f.store.getSceneRedactions({ identity, scene: sceneA }), first, 'duplicate adapter recalls are idempotent')
  await pipeline.processNotice(pipeline.createJob(oneBot))
  assert.deepEqual((await f.read()).items, [])
  assert.equal(currentPersonaReads, 3)
})

test('legacy recall revokes an existing QQ source when the current binding file is invalid', async t => {
  const f = fixture()
  await f.write('需要撤回的历史事实', { source: f.source('original-id', '需要撤回的历史事实') })
  const { MessagePipeline } = await import('../utils/messagePipeline/messagePipeline.js')
  const { pluginBridge } = await import('../utils/pluginBridge.js')
  const previousRedis = globalThis.redis
  const previousHost = pluginBridge.instance
  t.after(() => { if (previousRedis === undefined) delete globalThis.redis; else globalThis.redis = previousRedis; pluginBridge.instance = previousHost })
  let lookedUp
  globalThis.redis = f.redis
  pluginBridge.instance = { getPersonaSnapshotFor(event) { lookedUp = event; throw new Error('invalid fixture binding file') } }
  const pipeline = new MessagePipeline({ store: {}, recentManager: {}, mediaOutbox: {}, logger: quiet,
    archiveManager: { shouldRecordNotice: () => false } })
  const envelope = createQqPipelineEnvelope({ notice_type: 'group', sub_type: 'recall', self_id: `00${identity.botId}`,
    group_id: `00${sceneA.id}`, user_id: person, message_id: 'original-id' }, 'notice')
  await pipeline.processNotice(pipeline.createJob(JSON.parse(JSON.stringify(envelope))))
  assert.deepEqual(lookedUp, { message_type: 'group', self_id: identity.botId, group_id: sceneA.id })
  assert.deepEqual((await f.read()).items, [])
})

test('recall remains scoped to its bot and scene while covering its historical personas', async () => {
  const f = fixture(), sibling = { ...identity, personaId: 'older-persona' }, differentBot = { ...identity, botId: '90002' }
  for (const observer of [identity, sibling, differentBot]) {
    await f.write('A群这条发言', { identity: observer, source: f.source('shared-id', 'A群这条发言') })
    await f.write('B群独立发言', { identity: observer, source: f.source('shared-id', 'B群独立发言', sceneB) })
  }
  await revokePersonMemoryNotice(f.store, { notice_type: 'group.recall', self_id: identity.botId, group_id: sceneA.id, user_id: person, message_id: 'shared-id' })
  for (const observer of [identity, sibling]) {
    assert.deepEqual((await f.read(sceneA, observer)).items, [])
    assert.equal((await f.read(sceneB, observer)).items[0].text, 'B群独立发言')
  }
  assert.equal((await f.read(sceneA, differentBot)).items[0].text, 'A群这条发言')
})

test('a recall arriving before extraction blocks later source creation across restart', async () => {
  const f = fixture(), original = f.source('not-extracted-yet', '还未提取的秘密')
  await revokePersonMemoryNotice(f.store, { notice_type: 'group_recall', self_id: identity.botId, group_id: sceneA.id, message_id: original.messageId }, () => identity)
  f.advance()
  const restarted = createPersonMemoryStore({ redis: f.redis, now: f.now })
  assert.equal((await restarted.remember({ identity, subjectId: person, source: original, text: original.excerpt, category: 'fact', evidenceKind: 'self' })).saved, false)
})

test('private recall revokes only the matched participant and malformed notices do nothing', async () => {
  const f = fixture(), privateScene = { kind: 'private', id: person }
  await f.write('私聊秘密', { source: f.source('same-id', '私聊秘密', privateScene) })
  await f.write('群内另一次消息', { source: f.source('same-id', '群内另一次消息') })
  for (const notice of [
    { notice_type: 'friend_add', self_id: identity.botId, user_id: person, message_id: 'same-id' },
    { notice_type: 'group_recall', self_id: identity.botId, user_id: person, message_id: 'same-id' },
    { notice_type: 'friend_recall', self_id: identity.botId, user_id: person, group_id: sceneA.id, message_id: 'same-id' },
    { notice_type: 'friend_recall', self_id: identity.botId, bot: { uin: '90002' }, user_id: person, message_id: 'same-id' },
    { notice_type: 'friend_recall', user_id: person, message_id: 'same-id' },
    { notice_type: 'friend_recall', self_id: identity.botId, message_id: 'same-id' },
    { notice_type: 'friend_recall', self_id: identity.botId, user_id: person }
  ]) await revokePersonMemoryNotice(f.store, notice, identity)
  assert.equal((await f.read(privateScene)).items.length, 2)
  await revokePersonMemoryNotice(f.store, { notice_type: 'friend', sub_type: 'recall', self_id: identity.botId, user_id: person, message_id: 'same-id' }, identity)
  assert.deepEqual((await f.read(privateScene)).items.map(item => item.text), ['群内另一次消息'])
})

test('QQ raw recall rejects conflicting attached accounts before job capture and safely handles legacy host fallback', async t => {
  const previous = globalThis.Bot
  t.after(() => { if (previous === undefined) delete globalThis.Bot; else globalThis.Bot = previous })
  const captures = []
  const Pipeline = createMessagePipelineClass({ createEventEnvelope: createQqPipelineEnvelope, markBotOnline() {} })
  const pipeline = new Pipeline({ store: {}, recentManager: {}, mediaOutbox: {}, emojiCollector: {}, logger: quiet, archiveManager: {} })
  pipeline.capture = async envelope => { captures.push(envelope) }
  const base = { notice_type: 'group', sub_type: 'recall', group_id: sceneA.id, user_id: person, message_id: 'source-id' }
  const other = { uin: '90002' }
  const conflicting = Object.create(base)
  Object.defineProperties(conflicting, { self_id: { value: identity.botId }, bot: { value: other } })
  assert.equal(pipeline.handleRawEvent(conflicting, 'notice'), '')
  assert.deepEqual(captures, [])

  globalThis.Bot = { uin: identity.botId, bots: { [identity.botId]: { uin: identity.botId }, [other.uin]: other } }
  assert.equal(pipeline.handleRawEvent(base, 'notice'), '')
  assert.equal(pipeline.handleRawEvent({ ...base, self_id: 'unknown', bot: other }, 'notice'), '')
  assert.ok(pipeline.handleRawEvent(Object.assign(Object.create(base), { bot: other }), 'notice'))
  assert.equal(captures.at(-1).botId, other.uin)

  globalThis.Bot = { uin: undefined, bots: { [identity.botId]: other } }
  assert.equal(pipeline.handleRawEvent(base, 'notice'), '')

  globalThis.Bot = { uin: identity.botId }
  assert.ok(pipeline.handleRawEvent(base, 'notice'))
  assert.equal(captures.at(-1).botId, identity.botId)
  assert.equal(captures.at(-1).noticeType, 'group')
  assert.equal(captures.at(-1).subType, 'recall')
})

test('person profiles expose portable group traits and private self evidence through the same policy', async () => {
  const f = fixture()
  await f.write('喜欢天文学', { category: 'interest', sensitivity: 'ordinary', portable: true })
  await f.write('下周准备考试', { category: 'event' })
  await f.write('别人说他要搬家', { evidenceKind: 'reported', source: f.source('reported', '他说要搬家', sceneA, other) })
  const groupProfile = await readScopedPersonProfile(f.store, person, { groupId: sceneB.id, viewer: identity })
  assert.deepEqual(groupProfile.interests, ['喜欢天文学'])
  assert.deepEqual(groupProfile.facts, [])
  assert.deepEqual((await readScopedPersonProfile(f.store, person, { groupId: sceneA.id, viewer: identity })).facts, [])
  const privateProfile = await readScopedPersonProfile(f.store, person, { groupId: undefined, viewer: identity })
  assert.deepEqual(privateProfile.facts, ['下周准备考试'])
  assert.equal(await readScopedPersonProfile(f.store, other, { groupId: undefined, viewer: identity }), null)
  assert.equal(await readScopedPersonProfile(f.store, person, { groupId: undefined }), null)
  assert.equal(await readScopedPersonProfile(f.store, person, { groupId: undefined, viewer: { ...identity, botId: 'different' } }), null)
  assert.equal(await readScopedPersonProfile(f.store, person, { groupId: undefined, viewer: { ...identity, personaId: 'different' } }), null)
})

test('profile injection cannot recover deleted traits through recent messages or cached calls', async () => {
  const f = fixture(), source = f.source('recent-profile', '我喜欢天文学')
  const saved = await f.write('喜欢天文学', { source, category: 'interest', sensitivity: 'ordinary', portable: true })
  const messages = [{ message_id: source.messageId, at: source.at, raw_message: source.excerpt, sender: { user_id: person } }]
  const Profile = createPersonProfileClass({ getConfig: () => ({ personProfileInjection: { enabled: true } }), getPersonaFor: () => null, getMessages: async () => messages, getCrossGroupProfile: (id, context) => readScopedPersonProfile(f.store, id, context), filterRecentMessages: (group, rows, viewer) => filterScopedProfileMessages(f.store, group, rows, viewer) })
  const injector = new Profile()
  assert.match(await injector.build(sceneA.id, person, {}, identity), /天文学/)
  f.advance()
  await f.store.forget({ identity, subjectId: person, id: saved.entry.id })
  assert.doesNotMatch(await injector.build(sceneA.id, person, {}, identity), /天文学/)
  assert.equal(await readScopedPersonProfile(f.store, person, { groupId: undefined, viewer: identity }), null)
})

test('history filtering keeps long authentic messages but drops erased source excerpts and old generated echoes', async () => {
  const f = fixture(), raw = `${'历史原文。'.repeat(1200)}我下周参加考试`
  const source = f.source('long-recent', '我下周参加考试')
  const saved = await f.write('下周参加考试', { source, category: 'event' })
  const messages = [
    { message_id: source.messageId, at: source.at, content: raw, sender: { user_id: person } },
    { message_id: 'bot-echo', at: source.at, source: 'send', content: '你下周考试', sender: { user_id: identity.botId } },
    { content: '无来源的旧摘要', sender: {} },
    { message_id: 'unrelated', at: source.at, content: '这是另一条独立消息', sender: { user_id: other } }
  ]
  assert.equal((await filterScopedProfileMessages(f.store, sceneA.id, messages, identity)).length, 4)
  f.advance()
  await f.store.forget({ identity, subjectId: person, id: saved.entry.id })
  assert.deepEqual((await filterScopedProfileMessages(f.store, sceneA.id, messages, identity)).map(row => row.message_id), ['unrelated'])
  assert.deepEqual(await filterScopedProfileMessages(f.store, sceneA.id, messages), [])
})

function reflector() {
  return new Reflector({ memoryAiConfig: ai }, { logger: quiet, call: async () => { throw Error('test must stub the model') } })
}
test('reflection cannot merge differing evidence scenes or visibility policies', async () => {
  const f = fixture(), ref = reflector()
  const first = makeFact({ text: '本人说喜欢天文', at: f.now(), authority: 'self', memorySource: f.source('one', '我喜欢天文'), memoryCategory: 'interest', memorySensitivity: 'ordinary', portable: true, personMemoryId: 'one' })
  ref._callChat = async () => JSON.stringify([{ text: '错误合并的跨群概括', sources: [1, 2] }])
  for (const change of [
    { memorySource: f.source('two', '私下说喜欢天文', { kind: 'private', id: person }) },
    { memorySource: f.source('two', '我喜欢天文', sceneB) },
    { portable: false }, { memorySensitivity: 'sensitive' }, { personMemoryId: 'other' }
  ]) {
    const second = makeFact({ ...first, text: '第二条独立事实', ...change })
    const result = await ref.consolidateEntity({ qq: person, facts: [first, second] })
    assert.equal(result.changed, false)
    assert.deepEqual(result.facts, [first, second])
    assert.deepEqual((await ref.reflectGroup({ groupId: sceneA.id, facts: [first, second] })).insights, [])
  }
})

test('reflection preserves exact evidence and visibility metadata when rewriting one fact', async () => {
  const f = fixture(), ref = reflector()
  const original = makeFact({ text: '他长期在准备天文考试', at: f.now(), authority: 'self', memorySource: f.source('one', '我下周准备天文考试'), memoryCategory: 'event', memorySensitivity: 'personal', portable: false, personMemoryId: 'one', eventAt: f.now() + 10_000, refs: [person] })
  ref._callChat = async () => JSON.stringify([{ text: '准备天文考试', sources: [1] }])
  const result = await ref.consolidateEntity({ qq: person, facts: [original] })
  assert.equal(result.changed, true)
  for (const key of ['memorySource', 'memoryCategory', 'memorySensitivity', 'portable', 'personMemoryId', 'eventAt', 'refs']) assert.deepEqual(result.facts[0][key], original[key], key)
  const insight = (await ref.reflectGroup({ groupId: sceneA.id, facts: [original] })).insights[0]
  for (const key of ['memorySource', 'memoryCategory', 'memorySensitivity', 'portable', 'personMemoryId', 'eventAt', 'refs']) assert.deepEqual(insight[key], original[key], key)
})

function summaryFixture(t, f, config = {}) {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'person-summary-'))
  const manager = new MidtermSummaryManager({ baseDir, personMemory: f.store, memoryAiConfig: ai, config, logger: quiet })
  t.after(() => { for (const state of manager.buffers.values()) if (state.timer) clearTimeout(state.timer); rmSync(baseDir, { recursive: true, force: true }) })
  const record = (messageId, text, author = person) => ({ group_id: sceneA.id, message_id: messageId, timestamp: f.now(), raw_message: text, sender: { user_id: author }, source_bot_id: identity.botId, source_persona_id: identity.personaId })
  return { manager, record }
}

test('disabled summaries and disabled people never reach the summary model', async t => {
  const f = fixture(), disabled = summaryFixture(t, f, { enabled: false })
  disabled.manager.callSummarizer = async () => { assert.fail('disabled summary called model') }
  disabled.manager.onArchivedRecord(disabled.record('disabled', '不应保存的内容'))
  assert.equal(await disabled.manager.updateGroup(sceneA.id), false)
  assert.equal(disabled.manager.loadSummary(sceneA.id), null)
  const active = summaryFixture(t, f)
  await f.store.setEnabled({ identity, subjectId: person, enabled: false })
  f.advance()
  active.manager.callSummarizer = async () => { assert.fail('opted-out source called summary model') }
  active.manager.onArchivedRecord(active.record('opted-out', '禁用人物的新消息'))
  assert.equal(await active.manager.updateGroup(sceneA.id), false)
  assert.doesNotMatch(active.manager.getSummaryPrompt(sceneA.id), /禁用人物/)
})

test('source revocation during summary inference prevents the generated text from being saved', async t => {
  const f = fixture(), s = summaryFixture(t, f), entered = deferred(), release = deferred()
  await f.write('准备考试', { source: f.source('pending-summary', '我在准备考试') })
  s.manager.onArchivedRecord(s.record('pending-summary', '我在准备考试'))
  s.manager.callSummarizer = async () => { entered.resolve(); await release.promise; return '已经撤回的考试秘密' }
  const pending = s.manager.updateGroup(sceneA.id)
  await entered.promise
  f.advance()
  await f.store.revokeSource({ identity, scene: sceneA, messageId: 'pending-summary' })
  release.resolve()
  assert.equal(await pending, false)
  assert.doesNotMatch(JSON.stringify(s.manager.loadSummary(sceneA.id)), /考试秘密/)
  assert.doesNotMatch(s.manager.getSummaryPrompt(sceneA.id), /考试秘密/)
})

test('summary rebuilding after deletion starts from fresh permitted sources and discards the old aggregate', async t => {
  const f = fixture(), s = summaryFixture(t, f)
  await f.write('旧的个人经历', { source: f.source('old-summary', '旧的个人经历') })
  s.manager.saveSummary(sceneA.id, { summary: '旧摘要记住的个人经历', updated_at: Date.now(), covered_until_ts: f.now(), updates: 1 })
  f.advance()
  await f.store.forget({ identity, subjectId: person })
  f.advance()
  const fresh = s.record('fresh-summary', '今天讨论新的公共话题', other)
  s.manager.onArchivedRecord(fresh)
  s.manager.callSummarizer = async (previous, lines) => {
    assert.equal(previous, '')
    assert.deepEqual(lines.map(line => line.text), ['今天讨论新的公共话题'])
    return '今天的新公共话题'
  }
  assert.equal(await s.manager.updateGroup(sceneA.id), true)
  assert.match(s.manager.getSummaryPrompt(sceneA.id), /新公共话题/)
  assert.doesNotMatch(s.manager.getSummaryPrompt(sceneA.id), /个人经历/)
})
