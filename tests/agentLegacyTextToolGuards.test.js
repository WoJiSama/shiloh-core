import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { commitmentRedis } from './helpers/commitmentRedis.js'

const { createCommitmentRuntime } = await load('modules/commitments/infrastructure/commitmentTool.js')
const { createCommitmentStore, COMMITMENT_PENDING_KEY, COMMITMENT_LOCK_KEY, commitmentDetailKey } = await load('modules/commitments/infrastructure/commitmentStore.js')
const { createDelegateMemoryRuntime } = await load('modules/memory/infrastructure/delegateMemoryTool.js')
const { createDelegatedMemoryStore, delegatedMemoryStorageKey } = await load('modules/memory/infrastructure/delegatedMemoryStore.js')
const { createGroupTextTools } = await load('modules/conversation/infrastructure/groupTextTools.js')
const { agentBindingIdentity, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const at = Date.parse('2026-11-17T12:00:00+08:00'), logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'fixture', namespace: 'legacy-guard', id: 'bot' }, target = { account, kind: 'group', id: 'room' }
const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: 'main', target }
const params = { action: 'create', intent: '提醒喝水', schedule_kind: 'once', schedule_time: '2026-11-17T12:10:00+08:00', deliver: 'static', static_message: '喝水' }
const call = (name, input) => ({ id: 'legacy-guard', type: 'function', function: { name, arguments: JSON.stringify(input) } })
const textContext = (userText, ensureCurrent) => ({ binding, userText, actor: { kind: 'user', user: { ...account, id: 'human' } },
  request: { messageId: 'source', text: userText, mentions: [] }, signal: new AbortController().signal,
  isCurrent: () => true, ensureCurrent, allowsText: () => true, claimAction: async () => true })
const entry = id => ({ id, owner: 'human', ownerName: '真人', content: '托付原文', status: 'active', createdAt: at, updatedAt: at, dueAt: 0 })
const commitment = id => ({ id, group_id: 'room', creator_id: 'human', creator_name: '真人', intent: '提醒喝水', schedule: { kind: 'once', time: at + 600_000 },
  deliver: 'static', static_message: '喝水', expiry_at: at + 86400_000, next_run_at: at + 600_000, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: at, bot_id: 'bot', scope: { agentId: binding.agentId, target }, bindingIdentity: agentBindingIdentity(binding) })

function sourceGuard() {
  let live = true, calls = 0
  const ensure = async () => { calls++; if (!live) throw Error('source revoked') }
  return { ensure, revoke() { live = false }, get calls() { return calls }, event: { _agentBinding: binding, _isAgentBindingCurrent: () => true, _ensureAgentToolCurrent: ensure, group_id: 'room', user_id: 'human', self_id: 'bot' } }
}
function delegated(settings = {}) {
  const data = new Map(), operations = [], guard = sourceGuard(), key = delegatedMemoryStorageKey(binding)
  const redis = { async get(value) { operations.push(['get', value]); const result = data.get(value) ?? null; await settings.get?.(guard); return result },
    async set(value, content) { data.set(value, content); return 'OK' },
    async eval(script, { keys, arguments: args }) {
      if (keys.length === 2 && args.length === 0 && script.startsWith("return {redis.call('GET',KEYS[1])")) {
        // A scoped read is one atomic document + cleanup-fence snapshot. The
        // hook still revokes immediately after that read, before the store's fence.
        operations.push(['get', keys[0]])
        const snapshot = keys.map(key => data.get(key) ?? null)
        await settings.get?.(guard)
        return snapshot
      }
      operations.push(['cas', keys[0]])
      if (settings.conflict?.(guard)) return 0
      if (keys.length === 2 && args.length === 6 && script.includes("local fence=redis.call('GET',KEYS[2])")) {
        const expected = (flag, value) => flag === '1' ? value : null
        if ((data.get(keys[0]) ?? null) !== expected(args[0], args[1]) || (data.get(keys[1]) ?? null) !== expected(args[2], args[3])) return 0
        if (args[4] === '1') data.set(keys[0], args[5]); else data.delete(keys[0])
        return 1
      }
      assert.equal(keys.length, 1); assert.equal(args.length, 2)
      if ((data.get(keys[0]) ?? '') !== args[0]) return 0
      data.set(keys[0], args[1]); return 1
    } }
  const ports = { redis, logger, now: () => at, loadConfig: () => ({}) }, runtime = createDelegateMemoryRuntime(ports)
  return { data, operations, guard, key, ports, runtime, tool: new runtime.DelegateMemoryTool(), store: createDelegatedMemoryStore(ports) }
}
function commitments(settings = {}) {
  const data = new Map(), operations = [], guard = sourceGuard(), base = commitmentRedis(data), redis = { ...base,
    async get(key) { operations.push(['get', key]); const result = await base.get(key); await settings.get?.(key, guard); return result },
    async set(key, value, options) { operations.push(['set', key]); const result = await base.set(key, value, options); await settings.set?.(key, guard); return result },
    async eval(script, options) {
      const reading = script.includes('commitment-cleanup-read-v1')
      operations.push([reading ? 'get' : script.includes('commitment-state-v2') ? 'write' : 'unlock', options.keys[0]])
      const result = await base.eval(script, options)
      if (reading) await settings.get?.(options.keys[0], guard)
      return result
    } }
  const ports = { redis, logger, now: () => at, getBot: () => null, isSimulationGroup: async () => { operations.push(['simulation']); return true }, wakeSim: async () => ({ status: 'failed', sent: 0 }), loadConfig: () => ({}) }
  const runtime = createCommitmentRuntime(ports)
  return { data, operations, guard, ports, runtime, store: createCommitmentStore({ redis, logger }), tool: new runtime.CommitmentTool() }
}

test('delegated remember rechecks async source after reading before its CAS', async () => {
  const f = delegated({ get(guard) { guard.revoke() } })
  await assert.rejects(f.tool.executeForOwner({ action: 'remember', content: '托付原文' }, f.guard.event))
  assert.equal(f.operations.some(row => row[0] === 'cas'), false); assert.equal(f.data.has(f.key), false)
})

test('delegated recall refuses data read while its async source is revoked', async () => {
  const f = delegated({ get(guard) { guard.revoke() } }); f.data.set(f.key, JSON.stringify([entry('one')]))
  await assert.rejects(f.tool.executeForOwner({ action: 'recall', query: '托付' }, f.guard.event))
})

test('delegated CAS conflict rechecks the async source before another read or mutation', async () => {
  let first = true
  const f = delegated({ conflict(guard) { if (!first) return false; first = false; guard.revoke(); return true } })
  await assert.rejects(f.store.update(binding, entries => ({ entries: [...entries, entry('one')], result: true }), () => true, f.guard.ensure))
  assert.equal(f.operations.filter(row => row[0] === 'get').length, 1); assert.equal(f.operations.filter(row => row[0] === 'cas').length, 1)
})

test('delegated async mutation callback cannot commit after revoking its source', async () => {
  const f = delegated()
  await assert.rejects(f.store.update(binding, async entries => { await Promise.resolve(); f.guard.revoke(); return { entries: [...entries, entry('one')], result: true } }, () => true, f.guard.ensure))
  assert.equal(f.operations.some(row => row[0] === 'cas'), false)
})

test('commitment create stops before a later capability query after source revocation in the index read', async () => {
  const f = commitments({ get(key, guard) { if (key === COMMITMENT_PENDING_KEY) guard.revoke() } })
  await assert.rejects(f.tool.executeWithReceipt({ ...params, deliver: 'agent' }, f.guard.event))
  assert.equal(f.operations.some(row => row[0] === 'simulation'), false); assert.equal(f.operations.some(row => row[0] === 'write'), false)
})

test('commitment list stops after a revoked index read without fetching private task details', async () => {
  const f = commitments({ get(key, guard) { if (key === COMMITMENT_PENDING_KEY) guard.revoke() } })
  f.data.set(COMMITMENT_PENDING_KEY, JSON.stringify([{ id: 'secret', next_run_at: at + 600_000 }]))
  await assert.rejects(f.tool.executeWithReceipt({ action: 'list' }, f.guard.event))
  assert.equal(f.operations.some(row => row[1] === commitmentDetailKey('secret')), false)
})

test('commitment lock acquisition rechecks async source before detail reads or CAS and releases its lock', async () => {
  const f = commitments({ set(key, guard) { if (key === COMMITMENT_LOCK_KEY) guard.revoke() } })
  await assert.rejects(f.store.createCommitment(commitment('one'), undefined, () => true, f.guard.ensure))
  assert.equal(f.operations.some(row => row[0] === 'get'), false); assert.equal(f.operations.some(row => row[0] === 'write'), false)
  assert.equal(f.data.has(COMMITMENT_LOCK_KEY), false)
})

test('commitment final index read cannot authorize the following atomic write after revocation', async () => {
  let reads = 0
  const f = commitments({ get(key, guard) { if (key === COMMITMENT_PENDING_KEY && ++reads === 2) guard.revoke() } })
  await assert.rejects(f.store.createCommitment(commitment('one'), () => {}, () => true, f.guard.ensure))
  assert.equal(f.operations.some(row => row[0] === 'write'), false); assert.equal(f.data.has(COMMITMENT_LOCK_KEY), false)
})

test('commitment async mutation callback rechecks before its index read or atomic write', async () => {
  const f = commitments(); await f.store.createCommitment(commitment('one')); f.operations.length = 0
  await assert.rejects(f.store.updateActive('one', async current => { await Promise.resolve(); f.guard.revoke(); return { ...current, intent: 'changed' } }, () => true, f.guard.ensure))
  assert.equal(f.operations.some(row => row[0] === 'write'), false)
  assert.equal(f.operations.some(row => row[1] === COMMITMENT_PENDING_KEY), false)
})

for (const action of ['cancel', 'renew']) test(`commitment ${action} rechecks the async source after its fresh locked detail read`, async () => {
  let detailReads = 0
  const f = commitments({ get(key, guard) { if (key === commitmentDetailKey('one') && ++detailReads === 2) guard.revoke() } })
  await f.store.createCommitment(commitment('one')); f.operations.length = 0; detailReads = 0
  await assert.rejects(f.tool.executeWithReceipt({ action, commitment_id: 'one' }, f.guard.event))
  assert.equal(f.operations.some(row => row[0] === 'write'), false)
  assert.equal(f.data.has(COMMITMENT_LOCK_KEY), false)
})

test('group knowledge passes the original async source fence into nested operations', async () => {
  const guard = sourceGuard(), effects = []
  const base = { parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'] }, validateParameters: () => true, description: 'fixture' }
  const registry = createGroupTextTools({ commitment: base, memory: base, knowledge: { ...base, async executeForRequest(_input, context) {
    guard.revoke(); await context.ensureCurrent(); effects.push('private-read'); return '资料'
  } } })
  const result = await registry.execute(call('groupKnowledgeTool', { action: 'list' }), ['groupKnowledgeTool'], textContext('查看资料', guard.ensure))
  assert.equal(result, undefined); assert.deepEqual(effects, [])
})

test('group legacy memory forwards the async source fence all the way to its CAS', async () => {
  const f = delegated({ get(guard) { guard.revoke() } }), c = commitments()
  const registry = createGroupTextTools({ commitment: c.tool, memory: f.tool })
  const outcome = await registry.execute(call('delegateMemoryTool', { action: 'remember', content: '托付原文' }), ['delegateMemoryTool'], textContext('请记住托付原文', f.guard.ensure))
  assert.equal(outcome, undefined); assert.equal(f.operations.some(row => row[0] === 'cas'), false)
})

test('group legacy commitment forwards the async source fence through its locked write path', async () => {
  const f = commitments({ set(key, guard) { if (key === COMMITMENT_LOCK_KEY) guard.revoke() } }), d = delegated()
  const registry = createGroupTextTools({ commitment: f.tool, memory: d.tool })
  const outcome = await registry.execute(call('commitmentTool', { action: 'create', schedule_kind: 'once', schedule_time: params.schedule_time, static_message: '喝水' }), ['commitmentTool'],
    textContext('十分钟后提醒我喝水', f.guard.ensure))
  assert.equal(outcome, undefined); assert.equal(f.operations.some(row => row[0] === 'write'), false); assert.equal(f.data.has(COMMITMENT_LOCK_KEY), false)
})

test('sync-only legacy callers retain normal delegated and commitment behavior', async () => {
  const d = delegated(), c = commitments(), event = { ...d.guard.event }; delete event._ensureAgentToolCurrent
  assert.match(await d.tool.executeForOwner({ action: 'remember', content: '托付原文' }, event), /记下了/u)
  assert.match(await d.tool.executeForOwner({ action: 'recall', query: '托付' }, event), /托付原文/u)
  assert.equal(typeof await c.tool.executeWithReceipt(params, event), 'object')
  assert.match(await c.tool.executeWithReceipt({ action: 'list' }, event), /提醒喝水/u)
})
