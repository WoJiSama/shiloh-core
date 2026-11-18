import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentGroupLogStore } = await load('modules/dice/infrastructure/agentGroupLogStore.js')
const { resolveLogForExport } = await load('modules/dice/domain/logExport.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')

const redisTest = { skip: !redisAvailable, timeout: 12_000 }
const account = { platform: 'qq', namespace: 'global', id: '10001' }
const otherAccount = { ...account, id: '10002' }
const target = { account, kind: 'group', id: '20001' }
const owned = { target, agentId: 'daily' }
const now = Date.now()
const row = (messageId, content = messageId, authorId = '30001', extra = {}) => ({ messageId, authorId, occurredAt: now,
  name: `member ${authorId}`, content, ...extra })
const ownerKey = value => createHash('sha256').update(JSON.stringify([value.agentId, conversationAddressKey(value.target)])).digest('hex')
const start = (store, owner = owned, command = 'start', title = '测试团录') => store.command(owner, command, { kind: 'start', title }, now)
async function append(store, owner, value) { return store.append(owner, value, await store.capture(owner, value.authorId)) }

test('derived event fields reject fake source substitutes, ordinary-message metadata and unsafe identifiers before Redis', async () => {
  let calls = 0
  const store = createAgentGroupLogStore({ async eval() { calls++; throw new Error('unexpected Redis mutation') } })
  const epochs = { globalEpoch: '0', sceneEpoch: '0' }
  for (const extra of [{ eventId: 'event' }, { deliveryMessageId: 'outbound' }, { eventId: undefined }, { deliveryMessageId: undefined }]) {
    for (const type of [undefined, 'message']) await assert.rejects(store.append(owned, row('source', 'body', '30001', { type, ...extra }), epochs), /归属无效/u)
  }
  for (const value of ['', ' padded ', '\u0000', '\ud800', 'x'.repeat(201), null, 123, undefined]) {
    for (const type of ['dice_result', 'dice_rule']) {
      await assert.rejects(store.append(owned, row('source', 'body', '30001', { type, eventId: value }), epochs), /归属无效/u)
    }
    await assert.rejects(store.append(owned, row('source', 'body', '30001', { type: 'dice_result', deliveryMessageId: value }), epochs), /归属无效/u)
  }
  await assert.rejects(store.append(owned, row('source', 'body', '30001', { type: 'dice_rule', eventId: 'audit', deliveryMessageId: 'outbound' }), epochs), /归属无效/u)
  for (const messageId of ['', undefined, null]) {
    await assert.rejects(store.append(owned, row(messageId, 'body', '30001', { type: 'dice_result', eventId: 'event', deliveryMessageId: 'outbound' }), epochs), /归属无效/u)
  }
  assert.equal(calls, 0)
})

test('same-source events preserve real source and receipt IDs while deduping event identity and retaining legacy keys', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-derived-events')
  const store = createAgentGroupLogStore(storage)
  await start(store)
  const epochs = await store.capture(owned, '30001'), source = 'real-inbound', eventId = 'opaque-event/一'
  assert.equal(await store.append(owned, row(source, 'original command'), epochs), true)
  assert.equal(await store.append(owned, row(source, 'legacy result', '30001', { type: 'dice_result' }), epochs), true)
  const event = row(source, 'first result', '30001', { type: 'dice_result', eventId, deliveryMessageId: 'real-outbound-one' })
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.append(owned, event, epochs)))
  assert.equal(concurrent.filter(Boolean).length, 1)
  assert.equal(await store.append(owned, { ...event, content: 'changed body', deliveryMessageId: 'different-receipt' }, epochs), false)
  assert.equal(await store.append(owned, { ...event, eventId: 'event-two', content: 'second result' }, epochs), true)
  assert.equal(await store.append(owned, row(source, 'committed public audit', '30001', { type: 'dice_rule', eventId }), epochs), true)
  assert.equal(await store.append(owned, row(source, 'bounded identifiers', '30001', { type: 'dice_result', eventId: 'e'.repeat(200), deliveryMessageId: 'd'.repeat(200) }), epochs), true)
  const state = await store.read(owned), reopened = createAgentGroupLogStore(storage), snapshot = await reopened.snapshot(owned, state.currentId)
  assert.equal(state.log.count, 6)
  assert.ok(snapshot.sourceRows.every(value => value.messageId === source))
  assert.deepEqual(snapshot.sourceRows[2], event)
  assert.equal(snapshot.sourceRows[3].eventId, 'event-two')
  assert.equal(snapshot.sourceRows[4].type, 'dice_rule')
  assert.equal(Object.hasOwn(snapshot.sourceRows[0], 'eventId'), false)
  assert.equal(Object.hasOwn(snapshot.sourceRows[1], 'deliveryMessageId'), false)
  assert.deepEqual(Object.keys(snapshot.rows[2]).sort(), ['at', 'content', 'name', 'type', 'userId'])
  const seen = prefix + 'agent:group-log:v1:owner:' + ownerKey(owned) + ':seen'
  const key = values => createHash('sha256').update(JSON.stringify(values)).digest('hex')
  assert.equal(Number(await reader.sIsMember(seen, key([source, 'message']))), 1)
  assert.equal(Number(await reader.sIsMember(seen, key([source, 'dice_result']))), 1)
  assert.equal(Number(await reader.sIsMember(seen, key([source, 'dice_result', eventId]))), 1)
  await store.command(owned, 'stop-events', { kind: 'stop' }, now)
  await start(store, owned, 'new-log')
  assert.equal(await append(reopened, owned, event), false)
  assert.equal(await append(reopened, owned, row(source, 'legacy replay', '30001', { type: 'dice_result' })), false)
})

test('derived event identities remain isolated by full account, namespace, group and Agent ownership', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-event-ownership')
  const store = createAgentGroupLogStore(storage), owners = [owned, { ...owned, agentId: 'other' },
    { ...owned, target: { ...target, id: '20002' } }, { ...owned, target: { ...target, account: otherAccount } },
    { ...owned, target: { ...target, account: { ...account, namespace: 'tenant' } } }]
  for (const [index, scope] of owners.entries()) {
    await start(store, scope)
    const event = row('same-source', `owner ${index}`, '30001', { type: 'dice_result', eventId: 'same-event', deliveryMessageId: 'same-outbound' })
    assert.equal(await append(store, scope, event), true)
    assert.equal(await append(store, scope, { ...event, content: 'duplicate' }), false)
  }
  for (const [index, scope] of owners.entries()) {
    const state = await store.read(scope), snapshot = await store.snapshot(scope, state.currentId)
    assert.equal(state.log.count, 1)
    assert.equal(snapshot.sourceRows[0].content, `owner ${index}`)
    assert.equal(snapshot.sourceRows[0].eventId, 'same-event')
  }
})

test('source recall purges every derived event across logs and Agents and fences new event IDs after restart', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-event-recall')
  const store = createAgentGroupLogStore(storage), otherAgent = { ...owned, agentId: 'other' }, otherRoom = { ...owned, target: { ...target, id: '20002' } }
  for (const scope of [owned, otherAgent, otherRoom]) {
    await start(store, scope)
    await append(store, scope, row('source', 'original'))
    for (const eventId of ['one', 'two']) await append(store, scope, row('source', 'result', '30001', { type: 'dice_result', eventId, deliveryMessageId: `outbound-${eventId}` }))
    await append(store, scope, row('source', 'audit', '30001', { type: 'dice_rule', eventId: 'audit' }))
    await append(store, scope, row('unrelated', 'keep'))
  }
  const ended = (await store.read(owned)).currentId
  await store.command(owned, 'stop-old', { kind: 'stop' }, now)
  await start(store, owned, 'new')
  await append(store, owned, row('source', 'later event', '30001', { type: 'dice_result', eventId: 'later' }))
  assert.equal(await store.revokeSource(target, 'source'), 9)
  assert.deepEqual((await store.snapshot(owned, ended)).sourceRows.map(value => value.messageId), ['unrelated'])
  assert.equal((await store.read(owned)).log.count, 0)
  assert.equal((await store.read(otherAgent)).log.count, 1)
  assert.equal((await store.read(otherRoom)).log.count, 5)
  const reopened = createAgentGroupLogStore(storage)
  await reopened.recover([account])
  for (const scope of [owned, otherAgent]) {
    for (const type of ['dice_result', 'dice_rule']) assert.equal(await append(reopened, scope, row('source', 'late event', '30001', { type, eventId: 'never-seen-before' })), false)
  }
})

test('privacy purge removes every derived event and rejects stale producer epochs without affecting other authors or scopes', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-event-privacy')
  const store = createAgentGroupLogStore(storage), otherRoom = { ...owned, target: { ...target, id: '20002' } }, otherAgent = { ...owned, agentId: 'other' }
  const event = row('source', 'result', '30001', { type: 'dice_result', eventId: 'one', deliveryMessageId: 'real-outbound' })
  for (const scope of [owned, otherRoom, otherAgent]) {
    await start(store, scope)
    await append(store, scope, row('source', 'original'))
    await append(store, scope, event)
    await append(store, scope, { ...event, eventId: 'two' })
    await append(store, scope, row('another-author', 'keep', '30002', { type: 'dice_rule', eventId: 'audit' }))
  }
  const old = (await store.read(owned)).currentId
  await store.command(owned, 'stop', { kind: 'stop' }, now)
  await start(store, owned, 'new')
  await append(store, owned, { ...event, eventId: 'active' })
  const staleLocal = await store.capture(owned, '30001'), staleGlobal = await store.capture(otherRoom, '30001')
  assert.equal(await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001', groupId: target.id }), 4)
  assert.deepEqual((await store.snapshot(owned, old)).sourceRows.map(value => value.authorId), ['30002'])
  assert.equal((await store.read(owned)).log.count, 0)
  assert.equal(await store.append(owned, { ...event, eventId: 'late-local', occurredAt: now + 60_000 }, staleLocal), false)
  assert.equal(await append(store, owned, event), false)
  assert.equal((await store.read(otherRoom)).log.count, 4)
  assert.equal((await store.read(otherAgent)).log.count, 4)
  assert.equal(await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }), 3)
  assert.equal(await store.append(otherRoom, { ...event, eventId: 'late-global' }, staleGlobal), false)
  assert.deepEqual((await store.snapshot(otherRoom, (await store.read(otherRoom)).currentId)).sourceRows.map(value => value.authorId), ['30002'])
  assert.equal((await store.read(otherAgent)).log.count, 4)
})

test('durable ownership includes account, namespace, group and Agent and registry is host-account scoped', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-ownership')
  const store = createAgentGroupLogStore(storage)
  const owners = [owned, { ...owned, agentId: 'other' }, { ...owned, target: { ...target, id: '20002' } },
    { ...owned, target: { ...target, account: otherAccount } },
    { ...owned, target: { ...target, account: { ...account, namespace: 'tenant' } } }]
  for (const [index, owner] of owners.entries()) {
    await start(store, owner, 'start', `owner ${index}`)
    await append(store, owner, row('same-platform-message', `owner ${index}`))
  }
  assert.equal((await store.listOwners([account])).length, 3)
  assert.equal((await store.listOwners([otherAccount])).length, 1)
  assert.deepEqual(await store.listOwners([]), [])
  for (const [index, owner] of owners.entries()) {
    const state = await store.read(owner), snapshot = await store.snapshot(owner, state.currentId)
    assert.equal(snapshot.sourceRows.length, 1)
    assert.equal(snapshot.sourceRows[0].content, `owner ${index}`)
  }
  const reordered = { agentId: 'daily', target: { id: '20001', kind: 'group', account: { id: '10001', namespace: 'global', platform: 'qq' } } }
  assert.equal((await store.read(reordered)).log.title, 'owner 0')
})

test('commands persist exact log selection and dedupe start/end while ordered rows preserve their real occurrence time', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-commands')
  const store = createAgentGroupLogStore(storage)
  assert.equal(await append(store, owned, row('before-start')), false)
  const a = await start(store, owned, 'start-a', 'older')
  const duplicate = await store.command(owned, 'start-a', { kind: 'start', title: 'changed' }, now + 5_000)
  assert.equal(duplicate.state.currentId, a.state.currentId)
  assert.equal(duplicate.state.log.title, 'older')
  assert.equal(await append(store, owned, row('first', 'first body', '30001', { occurredAt: now - 5_000 })), true)
  assert.equal(await append(store, owned, row('second', 'second body', '30002', { occurredAt: now - 10_000 })), true)
  assert.equal(await append(store, owned, row('first', 'duplicate body')), false)
  assert.equal(await append(store, owned, row('first', 'derived dice', '30001', { type: 'dice_result' })), true)
  const snapshot = await store.snapshot(owned, a.state.currentId)
  assert.deepEqual(snapshot.sourceRows.map(item => item.messageId), ['first', 'second', 'first'])
  assert.equal(snapshot.rows[0].at, new Date(now - 5_000).toISOString())
  assert.deepEqual(Object.keys(snapshot.rows[0]).sort(), ['at', 'content', 'name', 'type', 'userId'])
  assert.equal(await store.isCurrent(owned, snapshot.revision), true)
  await store.command(owned, 'stop-a', { kind: 'stop' }, now + 1_000)
  assert.equal(await append(store, owned, row('after-stop')), false)
  const b = await start(store, owned, 'start-b', 'middle')
  assert.equal(await append(store, owned, row('first', 'replayed in a later log')), false)
  await store.command(owned, 'end-b', { kind: 'end', format: 'html' }, now + 2_000)
  const c = await start(store, owned, 'start-c', 'newest')
  const selection = await store.command(owned, 'export-b', { kind: 'export', selector: '1', format: 'html' }, now + 3_000)
  assert.equal(selection.selectedLogId, b.state.currentId)
  assert.equal(selection.selectedLogId, resolveLogForExport(selection.state, '1').id)
  assert.equal((await store.command(owned, 'export-current-case', { kind: 'export', selector: 'CuRrEnT' }, now)).selectedLogId, c.state.currentId)
  assert.equal((await store.command(owned, 'export-title', { kind: 'export', selector: 'older' }, now)).selectedLogId, a.state.currentId)
  assert.equal((await store.command(owned, 'missing', { kind: 'export', selector: 'missing' }, now)).selectedLogId, undefined)
  const replayedEnd = await store.command(owned, 'end-b', { kind: 'end' }, now + 4_000)
  assert.equal(replayedEnd.selectedLogId, b.state.currentId)
  assert.equal(replayedEnd.state.currentId, c.state.currentId)
  assert.equal(replayedEnd.state.active, true)
  assert.equal(replayedEnd.format, 'html')
  assert.equal((await store.command(owned, 'ai-on', { kind: 'ai', enabled: true }, now)).state.aiEnabled, true)
  assert.equal((await store.command(owned, 'ai-read', { kind: 'ai' }, now)).state.aiEnabled, true)
  assert.equal((await store.command(owned, 'ai-off', { kind: 'ai', enabled: false }, now)).state.aiEnabled, false)
  assert.equal(await store.isCurrent(owned, snapshot.revision), false)
  for (const key of await reader.keys(prefix + 'agent:group-log:v1*')) assert.equal(await reader.ttl(key), -1)
})

test('concurrent append and command retries commit each source once without replacing a full transcript', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-concurrency')
  const store = createAgentGroupLogStore(storage)
  const commands = await Promise.all(Array.from({ length: 8 }, (_, index) => start(store, owned, `start-${index}`, `title ${index}`)))
  assert.equal(commands.filter(effect => effect.changed).length, 1)
  assert.equal((await store.read(owned)).logs.length, 1)
  const epochs = await store.capture(owned, '30001')
  const repeated = await Promise.all(Array.from({ length: 20 }, () => store.append(owned, row('same'), epochs)))
  assert.equal(repeated.filter(Boolean).length, 1)
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.append(owned, row(`message-${index}`), epochs)))
  const state = await store.read(owned), snapshot = await store.snapshot(owned, state.currentId)
  assert.equal(state.log.count, 101)
  assert.equal(new Set(snapshot.sourceRows.map(item => item.messageId)).size, 101)
})

test('row and byte capacity reject the complete new row without truncating or evicting existing records', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-capacity')
  const rows = createAgentGroupLogStore(storage, { maxRows: 2 })
  await start(rows)
  await append(rows, owned, row('one', '完整一行😀'))
  await append(rows, owned, row('two', '第二行'))
  await assert.rejects(append(rows, owned, row('three')), /上限/u)
  assert.deepEqual((await rows.snapshot(owned, (await rows.read(owned)).currentId)).sourceRows.map(item => item.content), ['完整一行😀', '第二行'])
  const other = { ...owned, agentId: 'byte-limit' }, bytes = createAgentGroupLogStore(storage, { maxBytes: 600 })
  await start(bytes, other)
  const body = '字'.repeat(50)
  await append(bytes, other, row('one', body))
  await assert.rejects(append(bytes, other, row('two', body)), /上限/u)
  assert.equal((await bytes.read(other)).log.count, 1)
  assert.equal((await bytes.snapshot(other, (await bytes.read(other)).currentId)).sourceRows[0].content, body)
  assert.throws(() => createAgentGroupLogStore(storage, { maxRows: 200_001 }))
  assert.throws(() => createAgentGroupLogStore(storage, { maxBytes: 100 * 1024 * 1024 + 1 }))
})

test('privacy physically removes subject rows from ended and active logs, fences future-dated pending rows, and isolates scope', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-privacy')
  const store = createAgentGroupLogStore(storage), groupTwo = { ...owned, target: { ...target, id: '20002' } },
    differentAgent = { ...owned, agentId: 'other' }, differentAccount = { ...owned, target: { ...target, account: otherAccount } }
  const scopes = [owned, groupTwo, differentAgent, differentAccount]
  for (const scope of scopes) {
    await start(store, scope)
    await append(store, scope, row('first', 'erase this subject'))
    await append(store, scope, row('other', 'keep another subject', '30002'))
  }
  const oldLog = (await store.read(owned)).currentId
  await store.command(owned, 'stop', { kind: 'stop' }, now)
  await start(store, owned, 'new', 'active')
  await append(store, owned, row('active', 'erase active subject'))
  const pending = await store.capture(owned, '30001'), before = await store.snapshot(owned, oldLog)
  assert.equal(await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001', groupId: target.id }), 2)
  assert.equal(await store.isCurrent(owned, before.revision), false)
  assert.equal(await store.append(owned, row('future', 'must not resurrect', '30001', { occurredAt: now + 60_000 }), pending), false)
  assert.deepEqual((await store.snapshot(owned, oldLog)).sourceRows.map(item => item.authorId), ['30002'])
  assert.equal((await store.read(owned)).log.count, 0)
  assert.equal((await store.read(groupTwo)).log.count, 2)
  const local = await store.capture(owned, '30001')
  assert.deepEqual(local, { globalEpoch: '0', sceneEpoch: '1' })
  assert.equal(await store.append(owned, row('newly-permitted', 'fresh after deletion'), local), true)
  assert.equal(await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }), 2)
  assert.equal((await store.capture(owned, '30001')).globalEpoch, '1')
  assert.equal((await store.read(groupTwo)).log.count, 1)
  assert.equal((await store.read(differentAgent)).log.count, 2)
  assert.equal((await store.read(differentAccount)).log.count, 2)
  assert.equal(await store.append(owned, row('after-global', 'old global epoch'), local), false)
  const rawRows = []
  const scopedKey = prefix + 'agent:group-log:v1:owner:' + ownerKey(owned) + ':log:*:rows'
  for (const key of await reader.keys(scopedKey)) rawRows.push(...await reader.hVals(key))
  assert.ok(!rawRows.join('').includes('erase'))
  assert.ok(!rawRows.join('').includes('fresh after deletion'))
})

test('recall removes the same real source across logs, derived row types and Agents with a durable no-revival fence', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-recall')
  const store = createAgentGroupLogStore(storage), second = { ...owned, agentId: 'other' }, differentGroup = { ...owned, target: { ...target, id: '20002' } }
  for (const scope of [owned, second, differentGroup]) {
    await start(store, scope)
    await append(store, scope, row('source', 'private original'))
    await append(store, scope, row('source', 'derived output', '30001', { type: 'dice_result' }))
    await append(store, scope, row('keep', 'keep'))
  }
  const snapshot = await store.snapshot(owned, (await store.read(owned)).currentId)
  assert.equal(await store.revokeSource(target, 'source'), 4)
  assert.equal(await store.isCurrent(owned, snapshot.revision), false)
  for (const scope of [owned, second]) {
    assert.equal((await store.read(scope)).log.count, 1)
    assert.equal(await append(store, scope, row('source', 'late replay', '30001', { type: 'dice_rule' })), false)
  }
  assert.equal((await store.read(differentGroup)).log.count, 3)
  assert.equal(await store.revokeSource({ ...target, kind: 'private' }, 'source'), 0)
  const reopened = createAgentGroupLogStore(storage)
  await reopened.recover([account])
  assert.equal(await append(reopened, owned, row('source', 'restart replay')), false)
  assert.equal(await reopened.revokeSource(target, 'source'), 0)
})

test('delivery is claimed once and each confirmed, failed or unknown result is terminal', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-delivery')
  const store = createAgentGroupLogStore(storage)
  for (const outcome of ['confirmed', 'failed', 'unknown']) {
    const commandId = `command-${outcome}`
    await store.command(owned, commandId, { kind: 'status' }, now)
    assert.equal(await store.claimCommandDelivery(owned, commandId), true)
    assert.equal(await store.claimCommandDelivery(owned, commandId), false)
    assert.equal(await store.settleCommandDelivery(owned, commandId, outcome), true)
    assert.equal(await store.settleCommandDelivery(owned, commandId, 'confirmed'), false)
    assert.equal(await store.claimCommandDelivery(owned, commandId), false)
    assert.equal((await store.command(owned, commandId, { kind: 'status' }, now)).delivery, outcome)
  }
  assert.equal(await store.claimCommandDelivery(owned, 'missing'), false)
})

test('startup recovery converts another process pending deliveries to unknown only for the requested adapter accounts', redisTest, async t => {
  const { storage, reader, prefix, url } = await createAgentRedisFixture(t, 'group-log-process-recovery')
  const other = { ...owned, target: { ...target, account: otherAccount } }
  const script = `
    import { connectAgentRedis } from ${JSON.stringify(new URL('../dist/backend/modules/runtime/infrastructure/agentRedis.js', import.meta.url).href)};
    import { createAgentGroupLogStore } from ${JSON.stringify(new URL('../dist/backend/modules/dice/infrastructure/agentGroupLogStore.js', import.meta.url).href)};
    const client=await connectAgentRedis(process.argv[1]); const prefix=process.argv[2];
    const store=createAgentGroupLogStore({ get:key=>client.get(prefix+key), eval:(script,options)=>client.eval(script,{...options,keys:options.keys.map(key=>prefix+key)}) });
    for (const owner of JSON.parse(process.argv[3])) { await store.command(owner,'pending',{kind:'status'},Date.now()); if(!await store.claimCommandDelivery(owner,'pending')) throw new Error('claim failed'); }
    await client.close();
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, url, prefix, JSON.stringify([owned, other])], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 })
  assert.equal(child.status, 0, child.stderr)
  const rawReceipt = scope => reader.hGet(prefix + 'agent:group-log:v1:owner:' + ownerKey(scope) + ':commands', 'pending').then(JSON.parse)
  assert.equal((await rawReceipt(owned)).delivery, 'pending')
  const store = createAgentGroupLogStore(storage)
  await store.recover([account])
  assert.equal((await rawReceipt(owned)).delivery, 'unknown')
  assert.equal((await rawReceipt(other)).delivery, 'pending')
  assert.equal(await store.claimCommandDelivery(owned, 'pending'), false)
  await store.recover([otherAccount])
  assert.equal((await rawReceipt(other)).delivery, 'unknown')
})

test('lost Redis acknowledgements never repeat a committed command, row or delivery claim', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-lost-ack')
  let lose = false
  const wrapped = { get: storage.get, async eval(script, options) {
    const result = await storage.eval(script, options)
    if (lose) { lose = false; throw new Error('lost acknowledgement') }
    return result
  } }
  const store = createAgentGroupLogStore(wrapped)
  lose = true
  await assert.rejects(start(store), /lost acknowledgement/u)
  const state = await store.read(owned)
  const replay = await start(store, owned, 'start', 'different title')
  assert.equal(replay.state.currentId, state.currentId)
  assert.equal(replay.state.logs.length, 1)
  const epochs = await store.capture(owned, '30001')
  lose = true
  await assert.rejects(store.append(owned, row('once'), epochs), /lost acknowledgement/u)
  assert.equal(await store.append(owned, row('once'), epochs), false)
  assert.equal((await store.read(owned)).log.count, 1)
  lose = true
  await assert.rejects(store.claimCommandDelivery(owned, 'start'), /lost acknowledgement/u)
  assert.equal(await store.claimCommandDelivery(owned, 'start'), false)
})

test('corrupt metadata is detected before a command or physical purge can partially change a log', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-corrupt-metadata')
  const store = createAgentGroupLogStore(storage), base = prefix + 'agent:group-log:v1:owner:' + ownerKey(owned)
  const first = await start(store)
  await append(store, owned, row('first', 'first retained body'))
  await store.command(owned, 'stop', { kind: 'stop' }, now)
  const second = await start(store, owned, 'next', 'new active')
  await append(store, owned, row('second', 'second retained body'))
  const firstMetaKey = base + ':log:' + first.state.currentId + ':meta', secondMetaKey = base + ':log:' + second.state.currentId + ':meta'
  const firstMeta = await reader.get(firstMetaKey), secondMeta = await reader.get(secondMetaKey), state = await reader.get(base + ':state')
  await reader.set(firstMetaKey, JSON.stringify({ ...JSON.parse(firstMeta), bytes: -1 }))
  await assert.rejects(store.command(owned, 'end-invalid', { kind: 'end' }, now), /metadata/u)
  assert.equal(await reader.get(base + ':state'), state)
  assert.equal(await reader.get(secondMetaKey), secondMeta)
  assert.equal(await reader.hGet(base + ':commands', 'end-invalid'), null)
  await reader.set(firstMetaKey, firstMeta)
  await reader.set(secondMetaKey, JSON.stringify({ ...JSON.parse(secondMeta), count: -1 }))
  await assert.rejects(store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }), /metadata/u)
  assert.equal(await reader.get(firstMetaKey), firstMeta)
  assert.ok((await reader.hVals(base + ':log:' + first.state.currentId + ':rows')).join('').includes('first retained body'))
  await reader.set(secondMetaKey, secondMeta)
  assert.equal(await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }), 2)
})

test('epoch input and persisted counters stay within sixteen decimal digits and overflow fails before another counter changes', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-epoch-bounds')
  const store = createAgentGroupLogStore(storage)
  await start(store)
  await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' })
  const epochKey = prefix + 'agent:group-log:v1:globalEpochs', revisionsKey = prefix + 'agent:group-log:v1:privacyRevisions'
  const [field] = Object.keys(await reader.hGetAll(epochKey))
  await reader.hSet(epochKey, field, '9999999999999999')
  assert.equal((await store.capture(owned, '30001')).globalEpoch, '9999999999999999')
  const before = await reader.hGetAll(revisionsKey)
  await assert.rejects(store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' }), /epoch/u)
  assert.equal(await reader.hGet(epochKey, field), '9999999999999999')
  assert.deepEqual(await reader.hGetAll(revisionsKey), before)
  await reader.hSet(epochKey, field, '10000000000000000')
  await assert.rejects(store.capture(owned, '30001'), /epoch/u)
  await assert.rejects(store.append(owned, row('oversized-epoch'), { globalEpoch: '10000000000000000', sceneEpoch: '0' }))
  assert.equal((await store.read(owned)).log.count, 0)
})

test('atomic command source fences reject an old privacy epoch or recalled command before storing any effect', redisTest, async t => {
  const { storage } = await createAgentRedisFixture(t, 'group-log-command-source-fence')
  const store = createAgentGroupLogStore(storage), stale = await store.capture(owned, '30001')
  await store.purgeSubject({ account, agentId: 'daily', subjectId: '30001' })
  await assert.rejects(store.command(owned, 'old-admission', { kind: 'start', title: 'must not start' }, now,
    { subjectId: '30001', epochs: stale }), /epoch/u)
  assert.equal((await store.read(owned)).active, false)
  const epochs = await store.capture(owned, '30001')
  await store.revokeSource(target, 'recalled-command')
  await assert.rejects(store.command(owned, 'recalled-command', { kind: 'start' }, now,
    { subjectId: '30001', epochs }), /revoked/u)
  assert.deepEqual((await store.read(owned)).logs, [])
})
