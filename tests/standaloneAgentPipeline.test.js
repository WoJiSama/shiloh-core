import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ createStandaloneAgentPipeline }, { createStandaloneAgentConsole }, { AgentConsoleError }, { createAgentRuntime },
  { createAgentInbox, createAgentInboxReader }, { createAgentMediaOutboxLedger, agentMediaOutboxId },
  { agentBindingToken, agentConversationKey, conversationAddressKey, platformAccountKey }] = await Promise.all([
  load('bootstrap/standaloneAgentPipeline.js'), load('bootstrap/standaloneAgentConsole.js'), load('contracts/agentConsole.js'), load('core/agentRuntime.js'),
  load('modules/runtime/infrastructure/agentInbox.js'), load('modules/media/infrastructure/agentMediaOutboxLedger.js'), load('modules/runtime/domain/agentBindings.js'),
])
const at = 1800000000000, redisTest = { skip: !redisAvailable, timeout: 15000 }
function binding(account = '10001', group = '20001', agentId = 'daily') {
  const target = { account: { platform: 'qq', namespace: 'global', id: account }, kind: 'group', id: group }
  return { source: 'configured', id: conversationAddressKey(target), revision: 'revision-1', agentId, personaId: 'default', connectionId: `qq-${account}`, target }
}
const message = (selected, id = 'source-1') => ({ version: 1, conversation: selected.target, sender: { ...selected.target.account, id: 'PRIVATE-SENDER' },
  messageId: id, occurredAt: at, text: 'PRIVATE-MESSAGE-TOKEN', parts: [], mentions: [], directedToAccount: true })
const request = (query = {}) => ({ method: 'GET', pathname: '/api/pipeline/jobs', params: {}, query, body: {} })
const code = expected => error => error instanceof AgentConsoleError && error.code === expected
async function fixture(t) {
  const f = await createAgentRedisFixture(t), rows = [binding(), binding('10002'), binding('10001', '20002', 'other-agent')]
  const permissions = new Map(), controller = new AbortController(), principal = { id: 'admin', username: 'admin', via: 'token' }
  let current = true
  const context = { principal, signal: controller.signal, isCurrent: () => current && !controller.signal.aborted,
    ensureCurrent() { if (!this.isCurrent()) throw new AgentConsoleError('conflict') } }
  const permissionKey = (operation, selected) => `${operation}:${selected ? agentConversationKey(selected) : '*'}`
  const auth = { isCurrent: () => current, async authorize(_principal, operation, selected, guard) {
    guard.ensureCurrent(); return permissions.get(permissionKey(operation, selected)) ?? 'allowed'
  } }
  const options = { storage: f.storage, auth, bindings: { list: () => rows,
    resolve: target => rows.find(row => conversationAddressKey(row.target) === conversationAddressKey(target)) },
    inboxBindingToken: (selected, queue) => queue === 'private' ? JSON.stringify([agentBindingToken(selected), 'private-tools', ['fixtureTool']])
      : queue === 'group' ? JSON.stringify([agentBindingToken(selected), 'text-group-revision', 'text-trigger-v1', 'trigger-config']) : agentBindingToken(selected),
    configState: () => ({ processEpoch: 'fixture-pipeline-epoch' }),
    now: () => at + 1000 }
  const service = createStandaloneAgentPipeline(options)
  return { ...f, rows, permissions, context, controller, auth, options, service, permissionKey,
    revoke() { current = false }, call: async query => (await service.handle(request(query), context)).value,
    async inbox(selected = rows[0], id = 'source-1') {
      const entry = { event: { kind: 'message', message: message(selected, id) }, bindingToken: options.inboxBindingToken(selected, selected.target.kind) }
      await createAgentInbox(f.storage).accept(entry, { kind: selected.target.kind, account: selected.target.account })
      return entry
    },
    async media(selected = rows[0], id = 'media-source-1', state = 'queued') {
      const ledger = createAgentMediaOutboxLedger(f.storage, { now: () => at })
      await ledger.enqueue({ binding: selected, source: { messageId: id, sender: { ...selected.target.account, id: 'PRIVATE-MEDIA-SENDER' },
        occurredAt: at, share: { provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } } } })
      const jobId = agentMediaOutboxId(selected, id)
      if (state !== 'queued') {
        const session = await ledger.claim(jobId); await session.preparing(); await session.begin('forward')
        if (state === 'completed') { await session.finish('forward', { state: 'sent', messageId: 'PRIVATE-NATIVE-RECEIPT' }); await session.close('completed') }
        else if (state === 'unknown') await session.finish('forward', { state: 'unknown' })
        else session.abandon()
      }
      return jobId
    },
  }
}

test('Core task view reads real persisted queues and media receipts without mutating or disclosing source material', redisTest, async t => {
  const f = await fixture(t)
  await f.inbox(); await f.inbox(f.rows[1], 'source-other-account'); await f.inbox(f.rows[2], 'source-other-agent')
  const done = await f.media(f.rows[0], 'media-done', 'completed'), unknown = await f.media(f.rows[0], 'media-unknown', 'unknown')
  const sending = await f.media(f.rows[0], 'media-sending', 'sending')
  await f.reader.set(f.prefix + 'ytbot:message_pipeline:job:PRIVATE-LEGACY', 'PRIVATE-LEGACY')
  const before = new Map()
  for (const id of [done, unknown, sending]) before.set(id, await f.reader.get(f.prefix + 'agent:media-outbox:v1:job:' + id))
  const result = await f.call()
  assert.equal(result.mode, 'standalone'); assert.equal(result.processEpoch, 'fixture-pipeline-epoch'); assert.equal(result.observedAt, at + 1000); assert.equal(result.returned, 6)
  assert.equal(result.scanTruncated, false)
  const events = result.jobs.filter(job => job.kind === 'event')
  assert.equal(events.length, 3); assert.ok(events.every(job => job.state === 'queued' && !('attempts' in job) && !('updatedAt' in job)))
  assert.equal(new Set(events.map(job => job.scopeKey)).size, 3)
  const deliveries = result.jobs.filter(job => job.kind === 'delivery')
  assert.deepEqual(new Set(deliveries.map(job => job.state)), new Set(['completed', 'unknown', 'sending']))
  assert.deepEqual(deliveries.find(job => job.id === done).effects, [{ effect: 'forward', state: 'sent', beganAt: at, finishedAt: at }])
  for (const id of [done, unknown, sending]) assert.equal(await f.reader.get(f.prefix + 'agent:media-outbox:v1:job:' + id), before.get(id))
  const printed = JSON.stringify(result)
  for (const secret of ['PRIVATE-MESSAGE-TOKEN', 'PRIVATE-SENDER', 'source-1', 'PRIVATE-MEDIA-SENDER', 'PRIVATE-NATIVE-RECEIPT', 'PRIVATE-LEGACY', 'BV1234567890']) assert.equal(printed.includes(secret), false, secret)
  assert.equal((await f.call({ kind: 'delivery', status: 'unknown' })).jobs[0].state, 'unknown')
  assert.equal((await f.call({ kind: 'event', status: 'completed' })).returned, 0)
  assert.deepEqual(result.retention, { inbox: 'until-acknowledged', textQueueIdleSeconds: 3600, mediaRecordIdleSeconds: 604800, mediaTaskLifetimeSeconds: 86400 })
})

test('complete binding and per-operation permissions filter account and agent records before returning tasks', redisTest, async t => {
  const f = await fixture(t)
  for (let index = 0; index < f.rows.length; index++) { await f.inbox(f.rows[index], `source-${index}`); await f.media(f.rows[index], `media-${index}`) }
  f.permissions.set(f.permissionKey('pipeline.read', f.rows[1]), 'denied')
  f.permissions.set(f.permissionKey('bindings.read', f.rows[2]), 'denied')
  const result = await f.call()
  assert.equal(result.returned, 2); assert.ok(result.jobs.every(job => job.scopeKey === agentConversationKey(f.rows[0])))
  f.permissions.set(f.permissionKey('pipeline.read', f.rows[0]), 'denied')
  assert.equal((await f.call()).returned, 0)
  f.permissions.set('pipeline.read:*', 'denied')
  await assert.rejects(f.call(), code('forbidden'))
})

test('acknowledged inbox rows disappear without becoming completed and old binding receipts are never attached to a new owner', redisTest, async t => {
  const f = await fixture(t); await f.inbox(); await f.media()
  const inbox = createAgentInbox(f.storage), queue = { kind: 'group', account: f.rows[0].target.account }, next = await inbox.next(queue)
  assert.equal((await f.call()).returned, 2)
  await inbox.acknowledge(next.raw, queue)
  assert.equal((await f.call({ kind: 'event' })).returned, 0)
  await f.inbox()
  f.rows[0] = { ...f.rows[0], revision: 'revision-2', agentId: 'replacement' }
  assert.equal((await f.call()).returned, 0)
})

test('the runtime admission owner recognizes real composite private tools and group trigger tokens', redisTest, async t => {
  const f = await fixture(t), target = { ...f.rows[0].target, kind: 'private', id: 'private-peer' }
  const privateBinding = { ...f.rows[0], id: conversationAddressKey(target), target }
  f.rows.push(privateBinding)
  const host = createAgentRuntime({ storage: f.storage, adapters: [{ account: target.account, id: 'qq-10001', botUserId: target.account.id,
    botName: 'fixture', start: async () => {}, stop() {}, isReady: () => false, actions: { send: async () => assert.fail('observation cannot send') } }],
    logger: { info() {}, warn() {}, error() {} }, getSection: () => ({}), getExecutionConfig: () => ({}),
    resolvePersona: address => { const binding = f.options.bindings.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    privateTextTools: ['fixtureTool'], textTrigger: {}, textGroupRevision: 'loaded-text-policy', YTapi: async () => assert.fail('observation cannot invoke a model'),
  })
  t.after(() => host.stop())
  f.options.inboxBindingToken = host.inboxBindingToken
  assert.notEqual(host.inboxBindingToken(privateBinding, 'private'), agentBindingToken(privateBinding))
  assert.notEqual(host.inboxBindingToken(f.rows[0], 'group'), agentBindingToken(f.rows[0]))
  assert.equal(host.inboxBindingToken(f.rows[0], 'simulation'), agentBindingToken(f.rows[0]))
  await f.inbox(f.rows[0], 'real-group-token'); await f.inbox(privateBinding, 'real-private-token')
  const result = await f.call({ kind: 'event' })
  assert.equal(result.returned, 2)
  assert.deepEqual(new Set(result.jobs.map(row => row.conversation.kind)), new Set(['private', 'group']))
  f.options.inboxBindingToken = selected => agentBindingToken(selected)
  assert.equal((await f.call({ kind: 'event' })).returned, 0, 'composite policy identities cannot be guessed from the base binding token')
})

test('binding changes, session revocation, and permission changes during awaits cannot return stale tasks', redisTest, async t => {
  const f = await fixture(t); await f.inbox()
  const evaluate = f.storage.eval
  f.storage.eval = async (...args) => { const result = await evaluate(...args); f.rows[0] = { ...f.rows[0], revision: 'changed-during-read' }; return result }
  await assert.rejects(f.call(), code('conflict'))
  f.storage.eval = evaluate
  const authorize = f.auth.authorize
  let globals = 0
  f.auth.authorize = async (...args) => args[1] === 'pipeline.read' && !args[2] && ++globals === 2 ? 'denied' : authorize(...args)
  await assert.rejects(f.call(), code('conflict'))
  f.auth.authorize = authorize
  f.storage.eval = async (...args) => { const result = await evaluate(...args); f.revoke(); return result }
  await assert.rejects(f.call(), code('conflict'))
})

test('queue observation bounds samples and removes unscoped, invalid and unexpected fields', async () => {
  const selected = binding(), entry = { event: { kind: 'message', message: message(selected) }, bindingToken: agentBindingToken(selected) }
  entry.event.message.conversation.account.secret = 'PRIVATE-EXTRA-FIELD'
  const raw = JSON.stringify(entry), calls = [], guard = { ensureCurrent() {} }
  const result = await createAgentInboxReader({ async eval(_script, options) {
    calls.push(options)
    return options.keys[0].includes('group-text:') ? Array(201).fill(raw) : []
  } }).read([selected.target.account], guard)
  assert.equal(result.scanTruncated, true); assert.equal(result.records.length, 1)
  assert.equal(JSON.stringify(result).includes('PRIVATE-EXTRA-FIELD'), false)
  assert.equal(JSON.stringify(result).includes('PRIVATE-MESSAGE-TOKEN'), false)
  assert.equal(calls.length, 5); assert.ok(calls.every(call => Number(call.arguments[0]) <= 201))
  assert.ok(calls.every(call => call.keys[0] !== 'agent:inbox'))
  const invalid = await createAgentInboxReader({ async eval() { return ['invalid-json', JSON.stringify({ ...entry, bindingToken: undefined })] } }).read([selected.target.account], guard)
  assert.equal(invalid.records.length, 0); assert.equal(invalid.scanTruncated, true)
})

test('actual HTTP service requires authentication and rejects unsupported task query values', redisTest, async t => {
  const f = await fixture(t); await f.inbox()
  const frontendDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pipeline-'))
  t.after(() => fs.rm(frontendDir, { recursive: true, force: true }))
  await fs.writeFile(path.join(frontendDir, 'index.html'), '<title>Core task fixture</title>')
  const authority = new AbortController()
  const app = createStandaloneAgentConsole({ frontendDir, port: 0, services: [f.service], bindings: f.options.bindings,
    authority: { signal: authority.signal, isCurrent: () => f.context.isCurrent() }, allowsResponse: () => true,
    auth: { ...f.auth, async authenticate(credentials, guard) { guard.ensureCurrent(); return credentials.token === 'fixture-token' ? f.context.principal : undefined },
      async state() { return { hasUser: true, username: 'admin', tokenWorks: true, via: 'token' } }, async run() { return {} } },
  })
  t.after(() => app.close())
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`, headers = { 'x-console-token': 'fixture-token' }
  assert.equal((await fetch(base + '/api/pipeline/jobs')).status, 401)
  const response = await fetch(base + '/api/pipeline/jobs', { headers })
  assert.equal(response.status, 200); assert.equal((await response.json()).returned, 1)
  for (const query of ['status=processing', 'kind=legacy', 'limit=0', 'limit=101', 'limit=1.1', 'extra=ignored']) {
    assert.equal((await fetch(base + '/api/pipeline/jobs?' + query, { headers })).status, 400, query)
  }
})
