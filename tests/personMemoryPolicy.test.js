import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { isPersonMemoryRedacted, filterRedacted } from '../dist/backend/modules/memory/domain/personMemory.js'

const identity = { botId: '90001', personaId: 'shiloh' }
const person = '10001'
const sceneA = { kind: 'group', id: '20001' }
const sceneB = { kind: 'group', id: '20002' }
const privateScene = { kind: 'private', id: person }
const epoch = 1_790_000_000_000
function fixture() {
  let clock = epoch
  const values = new Map()
  const reads = []
  const redis = {
    async get(key) { reads.push(key); return values.get(key) ?? null },
    async set(key, value) { values.set(key, value); return 'OK' },
    async del(key) { return Number(values.delete(key)) }
  }
  const store = createPersonMemoryStore({ redis, now: () => clock })
  const source = (messageId, excerpt, scene = sceneA, authorId = person, at = clock) => ({ scene, authorId, messageId, at, excerpt })
  const write = (text, extra = {}) => store.remember({ identity, subjectId: person, text, category: 'fact', source: source(text, text), evidenceKind: 'self', ...extra })
  const view = (scene, extra = {}) => store.query({ identity, subjectId: person, scene, viewerUserId: person, ...extra })
  return { redis, values, reads, store, source, write, view, advance(ms = 1000) { clock += ms }, now: () => clock }
}
const texts = result => result.items.map(item => item.text).sort()

test('archive evidence may exceed stored excerpt bounds without bypassing late erasures', async () => {
  const f = fixture(), excerpt = `${'普通聊天内容。'.repeat(800)}后来提到要保密的经历`
  const source = f.source('long-archive', excerpt)
  assert.equal(isPersonMemoryRedacted(source, excerpt, await f.store.getRedactions({ identity, subjectId: person })), false)
  assert.equal((await f.write('超长证据不能直接存档', { source })).saved, false)
  const saved = await f.write('要保密的经历', { source: { ...source, excerpt: '后来提到要保密的经历' } })
  assert.equal(saved.saved, true)
  f.advance()
  await f.store.forget({ identity, subjectId: person, id: saved.entry.id })
  assert.equal(isPersonMemoryRedacted(source, excerpt, await f.store.getRedactions({ identity, subjectId: person })), true, 'an erased excerpt beyond character 4000 still suppresses the raw row')
})

test('one person has continuous private recall and separate group audiences', async () => {
  const f = fixture()
  await f.write('喜欢星际', { category: 'interest', sensitivity: 'ordinary', portable: true })
  await f.write('周五考试', { category: 'event' })
  await f.write('本群叫林队', { category: 'name' })
  await f.write('别人说他很忙', { source: f.source('report', '他很忙', sceneA, '10002'), evidenceKind: 'reported' })
  await f.write('推测容易紧张', { evidenceKind: 'inferred', category: 'impression' })
  await f.write('私聊家里的事情', { source: f.source('private', '家里的事情', privateScene), sensitivity: 'sensitive', portable: true })
  await f.write('B群一起打了副本', { source: f.source('b', '一起打了副本', sceneB) })
  assert.deepEqual(texts(await f.view(sceneA)), ['喜欢星际', '周五考试', '本群叫林队', '别人说他很忙', '推测容易紧张'].sort())
  assert.deepEqual(texts(await f.view(sceneB)), ['喜欢星际', 'B群一起打了副本'].sort())
  assert.deepEqual(texts(await f.view(privateScene)), ['喜欢星际', '周五考试', '本群叫林队', '私聊家里的事情', 'B群一起打了副本'].sort())
  assert.deepEqual(texts(await f.view(sceneA, { portableOnly: true })), ['喜欢星际'])
  assert.deepEqual(texts(await f.view(sceneA, { localOnly: true })), ['周五考试', '本群叫林队', '别人说他很忙', '推测容易紧张'].sort())
})

test('identity and author claims cannot confer cross-person or cross-persona visibility', async () => {
  const f = fixture()
  assert.equal((await f.write('冒称本人', { source: f.source('fake', '他说', sceneA, '10002') })).reason, 'self_author_mismatch')
  assert.equal((await f.write('没有真实消息', { source: { ...f.source('x', 'x'), messageId: '' } })).saved, false)
  assert.equal((await f.write('冒称私聊', { source: f.source('x', 'x', { kind: 'private', id: '10002' }) })).saved, false)
  await f.write('仅此身份所知')
  assert.deepEqual(texts(await f.view(privateScene, { viewerUserId: '10002' })), [])
  assert.deepEqual(texts(await f.view({ kind: 'private', id: '10002' })), [])
  assert.deepEqual(texts(await f.view(privateScene, { identity: { ...identity, botId: 'other' } })), [])
  assert.deepEqual(texts(await f.view(privateScene, { identity: { ...identity, personaId: 'other' } })), [])
})

test('high confidence, event stability, and duplicated text never broaden an audience', async () => {
  const f = fixture()
  await f.write('工资很高', { confidence: 1, sensitivity: 'sensitive', portable: true })
  await f.write('考试已经结束', { category: 'event', sensitivity: 'ordinary', portable: true })
  await f.write('关系很好', { category: 'preference', sensitivity: 'ordinary', portable: true, relatedUserIds: ['10002'] })
  const privateFact = await f.write('喜欢星际', { category: 'interest', sensitivity: 'ordinary', portable: true, source: f.source('private-interest', '喜欢星际', privateScene) })
  assert.equal(privateFact.entry.portable, false)
  assert.deepEqual(texts(await f.view(sceneB)), [])
  await f.write('喜欢星际', { category: 'interest', sensitivity: 'ordinary', portable: true })
  assert.deepEqual(texts(await f.view(sceneB)), ['喜欢星际'])
  assert.deepEqual((await f.store.read({ identity, subjectId: person, scene: sceneB, viewerUserId: person, ids: [privateFact.entry.id] })).items, [])
})

test('retries do not promote a previously local fact', async () => {
  const f = fixture(), source = f.source('stable', '喜欢星际')
  const first = await f.write('喜欢星际', { source, category: 'interest' })
  const retry = await f.write('喜欢星际', { source, category: 'interest', sensitivity: 'ordinary', portable: true, confidence: 1 })
  assert.equal(retry.entry.id, first.entry.id)
  assert.equal(retry.entry.portable, false)
  assert.deepEqual(texts(await f.view(sceneB)), [])
})

test('bounded projections retain paginated history and never expose forbidden index hooks', async () => {
  const f = fixture()
  for (let index = 0; index < 61; index++) await f.write(`本群事实${index}`)
  await f.write('不能进目录的私聊秘密', { source: f.source('private', '不能进目录的私聊秘密', privateScene) })
  const first = await f.view(sceneA, { limit: 50 })
  assert.equal(first.items.length, 50)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextOffset, 50)
  assert.doesNotMatch(JSON.stringify(first.index), /私聊秘密/)
  assert.equal((await f.view(sceneA, { limit: 50, offset: first.nextOffset })).items.length, 11)
  f.reads.length = 0
  await f.view(sceneA, { limit: 2 })
  assert.equal(f.reads.filter(key => key.includes(':entry:')).length, 2)
})

test('forgetting survives restart and rejects delayed extraction while accepting new conversations', async () => {
  const f = fixture(), oldSource = f.source('old', '旧经历')
  await f.write('旧经历', { source: oldSource })
  f.advance()
  await f.store.forget({ identity, subjectId: person })
  const restarted = createPersonMemoryStore({ redis: f.redis, now: f.now })
  assert.equal((await restarted.remember({ identity, subjectId: person, text: '重试改写旧经历', category: 'fact', source: oldSource, evidenceKind: 'self' })).saved, false)
  assert.equal(isPersonMemoryRedacted(oldSource, oldSource.excerpt, await restarted.getRedactions({ identity, subjectId: person })), true)
  f.advance()
  assert.equal((await f.write('新经历')).saved, true)
  assert.deepEqual(texts(await f.view(privateScene)), ['新经历'])
})

test('selective forgetting preserves independently sourced facts in the same message and suppresses raw replay', async () => {
  const f = fixture()
  const forgotten = await f.write('养一只猫', { source: f.source('mixed', '我养一只猫') })
  await f.write('喜欢跑步', { source: f.source('mixed', '我喜欢跑步'), category: 'interest', portable: true, sensitivity: 'ordinary' })
  f.advance()
  assert.equal(await f.store.forget({ identity, subjectId: person, id: forgotten.entry.id }), 1)
  assert.deepEqual(texts(await f.view(sceneA)), ['喜欢跑步'])
  const snapshot = await f.store.getRedactions({ identity, subjectId: person })
  const row = { source: f.source('mixed', '我养一只猫，我喜欢跑步', sceneA, person, epoch), text: '我养一只猫，我喜欢跑步' }
  assert.deepEqual(filterRedacted([row], snapshot), [])
  assert.equal((await f.write('家里有猫', { source: f.source('mixed', '我养一只猫', sceneA, person, epoch) })).saved, false)
})

test('revocations and scene deletion apply before a source has ever been extracted', async () => {
  const f = fixture(), pending = f.source('pending', '还未处理')
  await f.store.revokeSource({ identity, scene: sceneA, messageId: pending.messageId })
  assert.equal((await f.write('还未处理', { source: pending })).saved, false)
  const oldB = f.source('old-b', '旧B群', sceneB)
  f.advance()
  await f.store.forgetScene({ identity, scene: sceneB })
  assert.equal((await f.write('旧B群', { source: oldB })).saved, false)
  assert.equal((await f.write('仍可记录A群')).saved, true)
})

test('duplicate recall notices do not keep invalidating newly rebuilt summaries', async () => {
  const f = fixture()
  await f.store.revokeSource({ identity, scene: sceneA, messageId: 'withdrawn' })
  const first = await f.store.getSceneRedactions({ identity, scene: sceneA })
  f.advance()
  await f.store.revokeSource({ identity, scene: sceneA, messageId: 'withdrawn' })
  assert.deepEqual(await f.store.getSceneRedactions({ identity, scene: sceneA }), first)
})

test('deleting a mentioned-person fact also suppresses replay through the original author', async () => {
  const f = fixture()
  const source = f.source('someone-else', '小林的某件私事', sceneA, '10002')
  const entry = await f.write('小林的某件私事', { source, evidenceKind: 'reported' })
  f.advance()
  await f.store.forget({ identity, subjectId: person, id: entry.entry.id })
  const authorSnapshot = await f.store.getRedactions({ identity, subjectId: '10002' })
  assert.equal(isPersonMemoryRedacted(source, source.excerpt, authorSnapshot), true)
  assert.equal(isPersonMemoryRedacted(f.source('someone-else', '该作者的另一个独立话题', sceneA, '10002', epoch), '另一个独立话题', authorSnapshot), false)
})

test('related people remain protected when a relationship is stored under another speaker', async () => {
  const f = fixture()
  const source = f.source('relationship', '我和小王是同事')
  await f.write('和小王是同事', { source, category: 'relationship', relatedUserIds: ['10002'] })
  f.advance()
  await f.store.setEnabled({ identity, subjectId: '10002', scene: sceneA, enabled: false })
  assert.deepEqual(texts(await f.view(sceneA)), [])
  assert.deepEqual(texts(await f.view(privateScene)), [])
  assert.equal(isPersonMemoryRedacted(source, source.excerpt, await f.store.getRedactions({ identity, subjectId: person })), true)
  f.advance()
  const result = await f.write('和小王合作新项目', { category: 'relationship', relatedUserIds: ['10002'] })
  assert.equal(result.saved, false)
  assert.equal(result.reason, 'related_person_redacted')
})

test('an original author can suppress a reported fact during detail retrieval even without related IDs', async () => {
  const f = fixture(), authorId = '10002'
  const source = f.source('reported', '小林正在准备展会', sceneA, authorId)
  await f.write('小林正在准备展会', { source, evidenceKind: 'reported' })
  assert.deepEqual(texts(await f.view(sceneA)), ['小林正在准备展会'])
  const get = f.redis.get
  let revoked = false
  f.redis.get = async key => {
    const raw = await get(key)
    if (!revoked && key.includes(':entry:')) {
      revoked = true
      f.advance()
      await f.store.setEnabled({ identity, subjectId: authorId, scene: sceneA, enabled: false })
    }
    return raw
  }
  assert.deepEqual(texts(await f.view(sceneA)), [])
  assert.ok(revoked)
  const laterSource = f.source('later-report', '小林下周换班', sceneA, authorId)
  assert.equal((await f.write('小林下周换班', { source: laterSource, evidenceKind: 'reported' })).reason, 'related_person_redacted')
})

test('correction history does not revive after deletion and cannot reference another scene', async () => {
  const f = fixture()
  const original = await f.write('在准备考试', { category: 'event' })
  f.advance()
  const wrongScene = await f.write('考试结束', { category: 'event', source: f.source('b', '考试结束', sceneB), supersedes: original.entry.id })
  assert.equal(wrongScene.saved, false)
  const correction = await f.write('考试结束', { category: 'event', supersedes: original.entry.id })
  assert.deepEqual(texts(await f.view(privateScene)), ['考试结束'])
  await f.store.forget({ identity, subjectId: person, id: correction.entry.id })
  assert.deepEqual(texts(await f.view(privateScene)), [])
  assert.equal((await f.write('在准备考试', { category: 'event', source: f.source('在准备考试', '在准备考试', sceneA, person, epoch) })).saved, false)
})

test('scene opt-out blocks mentions and late writes; re-enable starts from fresh evidence', async () => {
  const f = fixture(), old = f.source('a', '旧偏好')
  await f.write('旧偏好', { source: old, category: 'preference', portable: true, sensitivity: 'ordinary' })
  await f.write('B本群内容', { source: f.source('b', 'B本群内容', sceneB) })
  f.advance()
  await f.store.setEnabled({ identity, subjectId: person, scene: sceneA, enabled: false })
  assert.deepEqual(texts(await f.view(sceneA)), [])
  assert.deepEqual(texts(await f.view(sceneB)), ['B本群内容'])
  assert.equal((await f.write('从被提及入口加入', { evidenceKind: 'reported', source: f.source('mention', '提及', sceneA, '10002') })).saved, false)
  const disabledSource = f.source('while-off', '停用期间')
  f.advance()
  await f.store.setEnabled({ identity, subjectId: person, scene: sceneA, enabled: true })
  assert.equal((await f.write('停用期间', { source: disabledSource })).saved, false)
  f.advance()
  assert.equal((await f.write('重新开始')).saved, true)
  assert.deepEqual(texts(await f.view(sceneA)), ['重新开始'])
})

test('fresh facts expire independently of their truth confidence', async () => {
  const f = fixture()
  await f.write('近期状态', { confidence: 1, validUntil: f.now() + 1000 })
  await f.write('稳定偏好', { category: 'preference', sensitivity: 'ordinary', portable: true })
  f.advance(1001)
  assert.deepEqual(texts(await f.view(privateScene)), ['稳定偏好'])
})

test('source catalog registers actual participant scenes without creating facts', async () => {
  const f = fixture()
  assert.equal(await f.store.registerSource({ identity, subjectId: person, source: f.source('a', '普通闲聊') }), true)
  assert.equal(await f.store.registerSource({ identity, subjectId: person, source: f.source('b', '普通闲聊', sceneB) }), true)
  assert.equal(await f.store.registerSource({ identity, subjectId: person, source: f.source('third', '别人说他', sceneB, '10002') }), false)
  assert.deepEqual(await f.store.identities(), [identity])
  assert.deepEqual(await f.store.listSubjects(identity), [{ identity, subjectId: person }])
  assert.deepEqual(await f.store.scenes({ identity, subjectId: person, scene: privateScene, viewerUserId: person }), [sceneA, sceneB])
  assert.deepEqual(await f.store.scenes({ identity, subjectId: person, scene: privateScene, viewerUserId: '10002' }), [])
  assert.deepEqual(texts(await f.view(privateScene)), [])
})

test('deletion invalidates aggregate projections in every scene and ordinary writes cannot clear it', async () => {
  const f = fixture()
  const entry = await f.write('通用兴趣', { category: 'interest', sensitivity: 'ordinary', portable: true })
  assert.equal((await f.store.getSceneRedactions({ identity, scene: sceneB })).invalidatedAt, 0)
  f.advance()
  await f.store.forget({ identity, subjectId: person, id: entry.entry.id })
  const invalidated = await f.store.getSceneRedactions({ identity, scene: sceneB })
  assert.equal(invalidated.invalidatedAt, f.now())
  f.advance()
  await f.write('新事实')
  assert.equal((await f.store.getSceneRedactions({ identity, scene: sceneB })).invalidatedAt, invalidated.invalidatedAt)
})

test('multiple repository instances serialize mutations sharing a Redis client', async () => {
  const f = fixture(), other = createPersonMemoryStore({ redis: f.redis, now: f.now })
  await Promise.all(Array.from({ length: 25 }, (_, index) => (index % 2 ? other : f.store).remember({ identity, subjectId: person, text: `事实${index}`, category: 'fact', source: f.source(`m${index}`, `事实${index}`), evidenceKind: 'self' })))
  assert.equal((await f.view(sceneA, { limit: 50 })).items.length, 25)
})

test('corrupted durable policy state fails closed rather than silently overwriting forgotten data', async () => {
  const f = fixture()
  await f.write('事实')
  const policyKey = [...f.values.keys()].find(key => key.endsWith(':scope'))
  f.values.set(policyKey, '{bad json')
  await assert.rejects(f.view(sceneA))
  await assert.rejects(f.write('不应覆盖'))
  assert.equal(f.values.get(policyKey), '{bad json')
})
