import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentInbox } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/infrastructure/agentInbox.js')).href)
const account = { platform: 'fixture', namespace: 'group-log-inbox', id: 'bot' }
const target = { account, kind: 'group', id: 'room' }
const sourceQueue = { account, kind: 'group-log' }, textQueue = { account, kind: 'group' }, simulationQueue = { account, kind: 'simulation' }
const epoch = { agentId: 'daily.agent-1', globalEpoch: '0', sceneEpoch: '1234567890123456' }
const ingress = groupLog => ({ kind: 'group-log', groupLog: groupLog ?? epoch })
const queueKey = kind => `agent:inbox:${kind === 'group' ? 'group-text' : kind}:${JSON.stringify([account.platform, account.namespace, account.id])}`
const redisTest = { skip: !redisAvailable, timeout: 10000 }
function entry(id, overrides = {}) {
  return { bindingToken: 'captured-binding', event: { kind: 'message', message: { version: 1, conversation: target,
    sender: { ...account, id: 'member' }, messageId: id, occurredAt: Date.now(), text: id,
    parts: [{ kind: 'text', text: id }], mentions: [], directedToAccount: true } }, ...overrides }
}
const accepts = (inbox, value, text, capture = ingress()) => inbox.accept(value, text, undefined, capture)

test('durable group-log ingress owns FIFO order, captures epochs and uses the single existing event receipt across restart and forwarding', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-inbox-order')
  const inbox = createAgentInbox(storage), captured = { ...epoch }
  const first = entry('first'), second = entry('second'), existing = entry('already-in-text')
  await inbox.accept(existing, textQueue)
  assert.deepEqual(await accepts(inbox, first, textQueue, ingress(captured)), sourceQueue)
  captured.globalEpoch = '1'; captured.agentId = 'mutated-owner'
  await accepts(inbox, second)
  await accepts(inbox, first, textQueue)
  assert.equal(await reader.lLen(prefix + queueKey('group-log')), 2, 'duplicate ingress cannot append a second front-queue item')
  assert.equal(await reader.ttl(prefix + queueKey('group-log')), -1, 'the recording front queue never expires')
  assert.equal(await reader.lLen(prefix + queueKey('group')), 1, 'pre-routing never dispatches text before recording')
  const receiptKeys = await reader.keys(prefix + 'agent:inbox:receipt:*')
  assert.equal(receiptKeys.length, 3, 'one receipt is shared by front queue and downstream queue')

  const resumed = createAgentInbox(storage), firstHead = await resumed.next(sourceQueue)
  assert.deepEqual(firstHead.entry.groupLog, epoch, 'the captured owner and epochs survive caller mutation and a new inbox instance')
  assert.equal(firstHead.entry.event.message.messageId, 'first')
  const sourceRows = await reader.lRange(prefix + queueKey('group-log'), 0, -1)
  await assert.rejects(resumed.forward(sourceRows[1], sourceQueue, textQueue), /无法转发/u)
  assert.deepEqual(await reader.lRange(prefix + queueKey('group-log'), 0, -1), sourceRows, 'a non-head forward leaves both source entries untouched')
  await resumed.forward(firstHead.raw, sourceQueue, textQueue, { event: firstHead.entry.event, bindingToken: 'downstream-text-binding' })
  const destination = await reader.lRange(prefix + queueKey('group'), 0, -1)
  assert.deepEqual(destination.map(raw => JSON.parse(raw).event.message.messageId), ['already-in-text', 'first'])
  assert.equal(JSON.parse(destination[1]).bindingToken, 'downstream-text-binding')
  assert.deepEqual(JSON.parse(destination[1]).groupLog, epoch, 'forward cannot lose capture metadata when replacement changes only routing data')
  assert.ok(await reader.ttl(prefix + queueKey('group')) > 0, 'text destinations retain their existing bounded conversation lifetime')
  await assert.rejects(resumed.forward(firstHead.raw, sourceQueue, textQueue), /无法转发/u)
  assert.equal(await reader.lLen(prefix + queueKey('group')), 2, 'repeating a completed forward cannot duplicate downstream work')
  await resumed.accept(first, textQueue)
  await accepts(resumed, first, textQueue)
  assert.equal(await reader.lLen(prefix + queueKey('group')), 2, 'ordinary accept cannot bypass the existing front-queue event receipt')
  assert.equal(await reader.lLen(prefix + queueKey('group-log')), 1)
  const secondHead = await resumed.next(sourceQueue)
  await resumed.forward(secondHead.raw, sourceQueue, simulationQueue)
  assert.equal(await resumed.next(sourceQueue), null)
  assert.equal((await resumed.next(simulationQueue)).entry.event.message.messageId, 'second')
  assert.equal(await reader.ttl(prefix + queueKey('simulation')), -1)
  assert.deepEqual((await reader.keys(prefix + 'agent:inbox:receipt:*')).sort(), receiptKeys.sort(), 'forward never creates a new receipt')
})

test('atomic front-queue forwarding preserves its source on a full or wrong-type destination and succeeds once capacity is available', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-inbox-capacity')
  const inbox = createAgentInbox(storage)
  await accepts(inbox, entry('held'))
  const original = await inbox.next(sourceQueue), destination = prefix + queueKey('simulation')
  await reader.rPush(destination, Array.from({ length: 10000 }, (_, i) => `existing-${i}`))
  await assert.rejects(inbox.forward(original.raw, sourceQueue, simulationQueue), /无法转发/u)
  assert.equal((await inbox.next(sourceQueue)).raw, original.raw)
  assert.equal(await reader.lLen(destination), 10000)
  await reader.del(destination); await reader.set(destination, 'unrelated-string')
  await assert.rejects(inbox.forward(original.raw, sourceQueue, simulationQueue), /无法转发/u)
  assert.equal((await inbox.next(sourceQueue)).raw, original.raw)
  assert.equal(await reader.get(destination), 'unrelated-string')
  await reader.del(destination)
  await inbox.forward(original.raw, sourceQueue, simulationQueue)
  assert.equal(await inbox.next(sourceQueue), null)
  assert.equal((await inbox.next(simulationQueue)).raw, original.raw)
})

test('privacy ingress takes priority and persists its original owner and group-log epochs for applied-command recovery', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-inbox-privacy')
  const inbox = createAgentInbox(storage), privacyOwner = { agentId: 'original-agent' }, flags = []
  const input = entry('privacy', { privacyCommand: 'forget', privacyOwner })
  const privacyQueue = await inbox.accept(input, textQueue, pending => flags.push(pending), ingress())
  assert.deepEqual(privacyQueue, { account, kind: 'privacy' }); assert.deepEqual(flags, [true])
  privacyOwner.agentId = 'changed-after-accept'
  assert.equal(await inbox.next(sourceQueue), null); assert.equal(await inbox.next(textQueue), null)
  const pending = await createAgentInbox(storage).next(privacyQueue)
  assert.deepEqual(pending.entry.privacyOwner, { agentId: 'original-agent' })
  assert.deepEqual(pending.entry.groupLog, epoch)
  assert.equal(await inbox.privacyCommandState(target, 'privacy', pending.raw), 'pending')
  const receipt = inbox.privacyCommandReceipt(target, 'privacy', pending.raw)
  await reader.set(prefix + receipt.key, receipt.applied, { KEEPTTL: true })
  const resumed = createAgentInbox(storage), applied = await resumed.next(privacyQueue)
  assert.equal(await resumed.privacyCommandState(target, 'privacy', applied.raw), 'applied')
  assert.equal(applied.entry.privacyOwner.agentId, 'original-agent', 'purge recovery uses the captured owner after a binding change')
  await assert.rejects(resumed.forward(applied.raw, privacyQueue, simulationQueue), /目标无效/u)
  await accepts(resumed, entry('privacy'), textQueue)
  assert.equal(await resumed.next(sourceQueue), null, 'the privacy receipt also fences duplicate normal ingress')
  assert.equal((await resumed.next(privacyQueue)).raw, pending.raw)
  await resumed.acknowledge(applied.raw, privacyQueue, pending => flags.push(pending))
  assert.deepEqual(flags, [true, false])
})

test('front-queue validation refuses malformed epochs, owners and non-group events before creating any receipt', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-inbox-validation')
  const inbox = createAgentInbox(storage)
  const malformed = [null, {}, [], { ...epoch, agentId: '' }, { ...epoch, agentId: 'bad owner' }, { ...epoch, agentId: 'x'.repeat(65) },
    { ...epoch, globalEpoch: '' }, { ...epoch, globalEpoch: 0 }, { ...epoch, globalEpoch: '01' }, { ...epoch, globalEpoch: '-1' },
    { ...epoch, globalEpoch: '1.0' }, { ...epoch, sceneEpoch: '10000000000000000' }, { ...epoch, sceneEpoch: '1\n' }, { ...epoch, extra: true }]
  for (const value of malformed) await assert.rejects(accepts(inbox, entry('invalid'), undefined, { kind: 'group-log', groupLog: value }))
  for (const bindingToken of [undefined, '', 1, 'binding\n', 'x'.repeat(8193)]) await assert.rejects(accepts(inbox, entry('unbound', { bindingToken })))
  const privateTarget = { ...target, kind: 'private' }, privateEntry = entry('private')
  privateEntry.event.message.conversation = privateTarget
  await assert.rejects(accepts(inbox, privateEntry))
  await assert.rejects(accepts(inbox, { event: { kind: 'recall', target, messageId: 'recalled' }, bindingToken: 'binding' }))
  await assert.rejects(accepts(inbox, { event: { kind: 'nudge', target, sender: { ...account, id: 'member' }, occurredAt: Date.now() }, bindingToken: 'binding' }))
  for (const privacyOwner of [null, {}, [], { agentId: '' }, { agentId: 'bad owner' }, { agentId: 'owner', extra: true }]) {
    await assert.rejects(inbox.accept(entry('privacy-invalid', { privacyCommand: 'forget', privacyOwner })))
  }
  assert.deepEqual(await reader.keys(prefix + 'agent:inbox:*'), [], 'validation failures do not claim or enqueue any source event')
  assert.deepEqual(await accepts(inbox, entry('valid')), sourceQueue, 'ordinary group-log commands are never classified as privacy commands')
})

test('forwarding rejects cross-account, privacy, changed source identity and capture ownership before touching the head', redisTest, async t => {
  const { storage, reader, prefix } = await createAgentRedisFixture(t, 'group-log-inbox-forward-scope')
  const inbox = createAgentInbox(storage)
  await accepts(inbox, entry('source', { privacyOwner: { agentId: 'daily.agent-1' } }))
  const item = await inbox.next(sourceQueue), foreign = { ...account, namespace: 'another-namespace' }
  for (const destination of [{ account, kind: 'privacy' }, { account, kind: 'private' }, sourceQueue, { account: foreign, kind: 'group' }]) {
    await assert.rejects(inbox.forward(item.raw, sourceQueue, destination), /目标无效/u)
  }
  await assert.rejects(inbox.forward(item.raw, simulationQueue, textQueue), /目标无效/u)
  const next = structuredClone(item.entry)
  for (const replacement of [
    { ...next, privacyCommand: 'forget' },
    { ...next, groupLog: { ...epoch, agentId: 'rebound-agent' } },
    { ...next, groupLog: { ...epoch, sceneEpoch: '1' } },
    { ...next, privacyOwner: { agentId: 'rebound-agent' } },
    { ...next, event: { ...next.event, message: { ...next.event.message, messageId: 'other-source' } } },
    { ...next, event: { ...next.event, message: { ...next.event.message, conversation: { ...target, id: 'other-room' } } } },
  ]) await assert.rejects(inbox.forward(item.raw, sourceQueue, simulationQueue, replacement))
  assert.equal((await inbox.next(sourceQueue)).raw, item.raw)
  assert.equal(await inbox.next(simulationQueue), null)
  assert.equal(await reader.lLen(prefix + queueKey('group-log')), 1)
  await inbox.forward(item.raw, sourceQueue, simulationQueue, { event: next.event, bindingToken: 'downstream-binding' })
  assert.deepEqual((await inbox.next(simulationQueue)).entry.privacyOwner, next.privacyOwner)
})
