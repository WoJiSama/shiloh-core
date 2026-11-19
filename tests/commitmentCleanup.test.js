import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis, qzoneRedisAvailable } from './helpers/agentQzoneRedis.mjs'
const { createCommitmentStore, commitmentDetailKey, encodeCommitment, COMMITMENT_PENDING_KEY, COMMITMENT_CLEANUP_KEY } = await load('modules/commitments/infrastructure/commitmentStore.js')
const { createCommitmentRuntime } = await load('modules/commitments/infrastructure/commitmentTool.js')
const { agentBindingIdentity, agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')
const { freezeDeferredAction, deferredActionHash } = await load('modules/commitments/infrastructure/agentDeferredActionData.js')

const options = { skip: !qzoneRedisAvailable, timeout: 20_000 }, at = Date.parse('2026-11-19T12:00:00+08:00')
const account = { platform: 'qq', namespace: 'global', id: '900001' }, target = { account, kind: 'group', id: '900003' }
const binding = { source: 'configured', id: 'binding', revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: 'qq-main', target }
const logger = { warn() {}, info() {}, error() {} }
const selector = (extra = {}) => ({ account, agentId: binding.agentId, subjectId: '900002', through: at, ...extra })
const guard = () => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
function task(id, extra = {}) {
  return { id, group_id: target.id, creator_id: '900002', creator_name: 'Creator', intent: 'forgotten task ' + id,
    schedule: { kind: 'once', time: at + 60_000 }, deliver: 'static', static_message: 'forgotten message ' + id,
    expiry_at: at + 86400_000, next_run_at: at + 60_000, status: 'active', last_run_at: 0, last_result: '', retry_count: 0,
    created_at: at, bot_id: account.id, scope: binding, bindingIdentity: agentBindingIdentity(binding), ...extra }
}
function wrap(raw, hooks = {}) {
  return { get: raw.get.bind(raw), set: raw.set.bind(raw), del: raw.del.bind(raw), scanIterator: raw.scanIterator.bind(raw),
    async eval(script, input) { await hooks.beforeEval?.(script, input); return raw.eval(script, input) } }
}

test('whole-person cleanup physically removes matching commitments, pending IDs and failure bodies across old scopes only', options, async t => {
  const { storage } = await createQzoneRedis(t), store = createCommitmentStore({ redis: storage, logger })
  const a = task('selected'), old = task('disabled-scope', { scope: { agentId: binding.agentId, target: { ...target, id: 'old-group' } }, group_id: 'old-group' })
  const retained = [task('other-user', { creator_id: 'other' }), task('new-source', { sourceAt: at + 1 }),
    task('other-agent', { scope: { ...binding, agentId: 'other' } }),
    task('other-account', { bot_id: 'other', scope: { ...binding, target: { ...target, account: { ...account, id: 'other' } } } }),
    task('legacy-unowned', { scope: undefined, bindingIdentity: undefined })]
  for (const item of [a, old, ...retained]) { await store.createCommitment(item); await store.appendFailLog({ id: item.id, intent: item.intent, group_id: item.group_id, reason: item.static_message, at }) }
  const receipt = await store.purgeSubject(selector(), guard())
  assert.equal(receipt.id, 'commitments'); assert.equal(receipt.cleanup, 'completed'); assert.ok(receipt.removedRecords >= 2)
  for (const item of [a, old]) { assert.equal(await storage.get(commitmentDetailKey(item.id)), null); assert.equal(await store.getCommitment(item.id), null) }
  const pending = JSON.parse(await storage.get(COMMITMENT_PENDING_KEY))
  assert.deepEqual(pending.map(row => row.id).sort(), retained.map(row => row.id).sort())
  const failures = await storage.get('bl-chat:commitment:faillog')
  assert.equal(failures.includes('forgotten message selected'), false); assert.equal(failures.includes('forgotten message disabled-scope'), false)
  for (const item of retained) assert.equal((await store.getCommitment(item.id)).id, item.id)
  await store.appendFailLog({ id: a.id, intent: a.intent, group_id: a.group_id, reason: 'late forgotten body', at })
  assert.equal((await storage.get('bl-chat:commitment:faillog')).includes('late forgotten body'), false)
  const restarted = createCommitmentStore({ redis: storage, logger })
  assert.equal((await restarted.purgeSubject(selector(), guard())).cleanup, 'completed')
  await assert.rejects(restarted.createCommitment({ ...a, id: 'late-old-source', created_at: at + 10_000, sourceAt: at }))
  assert.equal(await storage.get(commitmentDetailKey('late-old-source')), null)
})

test('a fence published between a creator snapshot and its write prevents a delayed commitment from appearing', options, async t => {
  const { storage } = await createQzoneRedis(t), other = createCommitmentStore({ redis: storage, logger }), hooks = {}
  const store = createCommitmentStore({ redis: wrap(storage, hooks), logger })
  hooks.beforeEval = async script => {
    if (!script.includes('commitment-state-v2')) return
    delete hooks.beforeEval
    // Publish the real permanent selector while the delayed writer still owns the task lock.
    const receipt = await other.purgeSubject(selector({ target }), guard())
    assert.equal(receipt.id, 'commitments'); assert.equal(receipt.cleanup, 'unknown')
  }
  await assert.rejects(store.createCommitment(task('delayed')), /承诺未创建/u)
  assert.equal(await storage.get(commitmentDetailKey('delayed')), null)
  assert.notEqual(await storage.get(COMMITMENT_CLEANUP_KEY), null)
})

test('purge invalidates an executing claim and late outcomes or renewal cannot restore it', options, async t => {
  const { storage } = await createQzoneRedis(t), store = createCommitmentStore({ redis: storage, logger }), c = task('executing')
  await store.createCommitment(c)
  const [claim] = await store.takeDueCommitments(at + 60_001)
  assert.equal(await store.refreshClaim(claim, at + 60_001, true), true)
  let invalidated = false
  store.onInvalidated(c.id, () => { invalidated = true })
  assert.equal((await store.purgeSubject(selector({ target }), guard())).cleanup, 'completed')
  assert.equal(invalidated, true); assert.equal(await store.isClaimCurrent(claim, at + 60_002), false)
  assert.equal(await store.commitRunOutcome({ ...claim, status: 'completed', last_result: 'late forgotten result' }), false)
  assert.equal(await store.updateActive(c.id, current => ({ ...current, expiry_at: at + 10 * 86400_000 })), false)
  assert.equal(await storage.get(commitmentDetailKey(c.id)), null)
})

test('source ownership cannot be relabelled by update and tool registration retains the original request timestamp', options, async t => {
  const { storage } = await createQzoneRedis(t), store = createCommitmentStore({ redis: storage, logger }), c = task('immutable-source')
  await store.createCommitment(c)
  await assert.rejects(store.updateActive(c.id, current => ({ ...current, sourceAt: at + 1 })), /来源不可改变/u)
  assert.equal((await store.purgeSubject(selector(), guard())).cleanup, 'completed')
  const runtime = createCommitmentRuntime({ redis: storage, logger, getBot: () => null, isSimulationGroup: () => true, wakeSim: async () => ({ status: 'succeeded', sent: 0 }), loadConfig: () => ({}), now: () => at + 10_000 })
  const late = await new runtime.CommitmentTool().execute({ action: 'create', intent: 'late old request', deliver: 'static', static_message: 'old body',
    schedule_kind: 'once', schedule_time: new Date(at + 60_000).toISOString() }, { user_id: '900002', _agentBinding: binding, _agentToolRequest: { occurredAt: at } })
  assert.match(late, /error|失败|未创建/u); assert.deepEqual(await store.listActiveCommitments(), [])
  const fresh = await new runtime.CommitmentTool().execute({ action: 'create', intent: 'new request', deliver: 'static', static_message: 'new body',
    schedule_kind: 'once', schedule_time: new Date(at + 60_000).toISOString() }, { user_id: '900002', _agentBinding: binding, _agentToolRequest: { occurredAt: at + 1 } })
  assert.match(fresh, /已记下/u)
  assert.equal((await store.listActiveCommitments())[0].sourceAt, at + 1)
})

test('after a physical deletion fails the permanent fence still blocks reads and later cleanup can finish', options, async t => {
  const { storage } = await createQzoneRedis(t), hooks = {}, store = createCommitmentStore({ redis: wrap(storage, hooks), logger }), c = task('failed-physical')
  await store.createCommitment(c)
  hooks.beforeEval = async script => { if (script.includes('commitment-cleanup-purge-v1')) throw Error('write unavailable') }
  const result = await store.purgeSubject(selector(), guard())
  assert.equal(result.cleanup, 'unknown'); assert.notEqual(await storage.get(commitmentDetailKey(c.id)), null)
  assert.equal(await store.getCommitment(c.id), null)
  delete hooks.beforeEval
  assert.equal((await store.purgeSubject(selector(), guard())).cleanup, 'completed')
  assert.equal(await storage.get(commitmentDetailKey(c.id)), null)
})

test('deferred actions keep the original grant source cutoff even when registered later and imported private reminders keep exact targets', options, async t => {
  const { storage } = await createQzoneRedis(t), store = createCommitmentStore({ redis: storage, logger })
  const action = freezeDeferredAction({ tool: 'testTool', executor: 'custom', definitionId: 'test:v1', params: { value: 'private action' } })
  const grant = { version: 1, id: 'grant-1', ruleId: 'rule-1', ruleRevision: 'r1', bindingIdentity: agentBindingIdentity(binding),
    scopeKey: agentConversationKey(binding), creator: { ...account, id: '900002' }, actionHash: deferredActionHash(action),
    dueAt: at + 60_000, source: { kind: 'message', messageId: 'original-source', at }, issuedAt: at + 10_000, expiresAt: at + 86400_000 }
  const c = task('deferred-old-source', { created_at: at + 10_000, sourceAt: at + 10_000,
    deferredAction: { version: 1, action, grant, state: 'pending', attemptedAt: 0, settledAt: 0, resultCode: '' } })
  const privateTarget = { account, kind: 'private', id: '900002' }, privateBinding = { ...binding, target: privateTarget }
  const imported = task('private-original', { group_id: '', importedReminder: true, scope: privateBinding, bindingIdentity: agentBindingIdentity(privateBinding) })
  await store.createCommitment(c); await store.createCommitment(imported)
  assert.equal((await store.purgeSubject(selector({ target }), guard())).cleanup, 'completed')
  assert.equal(await storage.get(commitmentDetailKey(c.id)), null)
  assert.notEqual(await storage.get(commitmentDetailKey(imported.id)), null)
  await assert.rejects(store.createCommitment({ ...c, id: 'late-deferred-registration' }))
  assert.equal((await store.purgeSubject(selector({ target: privateTarget }), guard())).cleanup, 'completed')
  assert.equal(await storage.get(commitmentDetailKey(imported.id)), null)
})

test('cleanup revocation across a scan cannot publish completion or delete the pending original', options, async t => {
  const { storage } = await createQzoneRedis(t), c = task('revoked'), store = createCommitmentStore({ redis: storage, logger })
  await store.createCommitment(c)
  const controller = new AbortController()
  const redis = { ...wrap(storage), async *scanIterator(input) {
    for await (const batch of storage.scanIterator(input)) { controller.abort(); yield batch }
  } }
  const interrupted = createCommitmentStore({ redis, logger })
  await assert.rejects(interrupted.purgeSubject(selector(), { signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() {} }))
  assert.notEqual(await storage.get(commitmentDetailKey(c.id)), null)
  assert.equal(await store.getCommitment(c.id), null)
})
