import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentCognition } = await load('modules/memory/infrastructure/agentCognition.js')
const { createCognitionStore } = await load('modules/memory/infrastructure/cognitionStore.js')
const { cognitionSourceId } = await load('modules/memory/domain/cognitionState.js')
const { createEmptyCharacterState } = await load('modules/simulation/domain/characterState.js')
const at = 1_800_000_000_000, agentId = 'daily'
const scene = (id = 'room-a', kind = 'group') => ({ account: { platform: 'qq', namespace: 'global', id: 'bot-a' }, kind, id })
const a = scene(), b = scene('room-b'), privateScene = scene('user-a', 'private')
const guard = () => ({ isCurrent: () => true, async ensureCurrent() {} })
function source(nativeId, conversation = a, overrides = {}) {
  const result = { agentId, conversation, nativeId, kind: 'message', authorId: 'user-a', participantIds: ['user-a'],
    occurredAt: at, revision: 1, status: 'active', content: '今天一起讨论了合作游戏', ...overrides }
  return { ...result, id: cognitionSourceId(result.agentId, conversation, result.kind, nativeId) }
}
const expression = (nativeId, conversation = a, overrides = {}) => source(nativeId, conversation,
  { kind: 'self-expression', authorId: conversation.account.id, participantIds: [conversation.account.id], content: '我喜欢合作游戏的策略机制', ...overrides })
function proposal(id, sources, overrides = {}) {
  return { id, action: 'CREATE', kind: 'experience', content: '讨论过合作游戏', topic: '合作游戏', sourceIds: sources.map(s => s.id),
    epistemic: 'reported', audience: 'scene', ...overrides }
}
const selfProposal = (id, sources, overrides = {}) => proposal(id, sources, { kind: 'interest', audience: 'self',
  content: '喜欢合作游戏的策略机制', epistemic: 'inferred', selfAssessment: { subject: 'self', sensitivity: 'ordinary', containsOtherPeople: false }, ...overrides })
function fixture() {
  const kv = new Map(), checked = [], control = { sourceHook: undefined, denied: new Set(), deniedNodes: new Set(), blockedText: '' }
  const redis = { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value); return 'OK' } }
  const cognition = createAgentCognition({ redis, now: () => at,
    allowsText: text => !control.blockedText || !text.includes(control.blockedText),
    canUseNode: node => !control.deniedNodes.has(node.id),
    async canUseSource(row) {
      checked.push({ id: row.id, nativeId: row.nativeId, revision: row.revision })
      await control.sourceHook?.(row)
      return !control.denied.has(row.id)
    },
  })
  return { cognition, store: createCognitionStore(redis), kv, checked, control }
}
function character(conversation = a) {
  return createEmptyCharacterState({ botId: conversation.account.id, personaId: `agent:${agentId}`, groupId: conversation.id })
}
function turn(selected, overrides = {}) {
  return { agentId, conversation: a, character: selected, messageRefs: [{ seq: 1, messageId: 'raw-1' }], expressions: [], ...overrides }
}
const query = (conversation = a, overrides = {}) => ({ agentId, conversation, text: '合作游戏', ...overrides })

test('one agent keeps its own interests across groups and private chat while scene facts and other agents stay isolated', async () => {
  const f = fixture(), own = expression('own'), groupSecret = source('group-secret', a, { content: 'A群成员准备辞职' }),
    privateSecret = source('private-secret', privateScene, { content: '私聊提到一件秘密' })
  await f.cognition.record([own, groupSecret, privateSecret], guard())
  await f.cognition.propose(agentId, a, [selfProposal('self-game', [own]),
    proposal('group-secret', [groupSecret], { topic: '辞职', content: 'A群成员准备辞职' })], guard())
  await f.cognition.propose(agentId, privateScene, [proposal('private-secret', [privateSecret], { topic: '秘密', content: '私聊提到一件秘密' })], guard())
  for (const address of [a, b, privateScene]) {
    const recalled = await f.cognition.recall(query(address), guard())
    assert.ok(recalled.nodes.some(n => n.id === 'self-game'))
    assert.equal(await recalled.isCurrent(), true)
  }
  const foreign = await f.cognition.recall(query(b, { text: '合作游戏 辞职 秘密' }), guard())
  assert.deepEqual(foreign.nodes.map(n => n.id), ['self-game'])
  assert.doesNotMatch(foreign.text, /辞职|秘密|room-a|user-a/)
  const ownPrivate = await f.cognition.recall(query(privateScene, { text: '秘密' }), guard())
  assert.deepEqual(ownPrivate.nodes.map(n => n.id), ['private-secret'])
  const anotherAgent = await f.cognition.recall(query(b, { agentId: 'other' }), guard())
  assert.equal(anotherAgent.text, '')
  assert.deepEqual((await f.store.read('other')).sources, [])
})

test('a live recall handle rechecks every upstream source of an otherwise portable self expression', async () => {
  const f = fixture(), raw = source('raw-1'), state = character()
  await f.cognition.record([raw], guard())
  await f.cognition.projectTurn(turn(state, { expressions: [{ messageId: 'sent-1', content: '我喜欢合作游戏', at, participantIds: ['bot-a'] }] }), guard())
  const own = (await f.store.read(agentId)).sources.find(s => s.nativeId === 'sent-1')
  await f.cognition.propose(agentId, a, [selfProposal('self-game', [own])], guard())
  const recalled = await f.cognition.recall(query(b), guard())
  assert.equal(await recalled.isCurrent(), true)
  f.checked.length = 0
  f.control.denied.add(raw.id)
  assert.equal(await recalled.isCurrent(), false)
  assert.ok(f.checked.some(item => item.id === raw.id), 'raw context must be reauthorized despite a portable own expression')
  assert.equal((await f.cognition.recall(query(b), guard())).text, '')
})

test('source deletion during recall makes the pending result unusable and future recall empty', async () => {
  const f = fixture(), raw = source('raw-1')
  await f.cognition.record([raw], guard())
  await f.cognition.propose(agentId, a, [proposal('experience', [raw])], guard())
  let invalidated = false
  f.control.sourceHook = async row => {
    if (row.id !== raw.id || invalidated) return
    invalidated = true
    await f.cognition.invalidate(agentId, { id: 'recall-during-read', sourceIds: [raw.id], before: Number.MAX_SAFE_INTEGER }, guard())
  }
  const pending = await f.cognition.recall(query(), guard())
  assert.equal(await pending.isCurrent(), false)
  assert.equal((await f.cognition.recall(query(), guard())).text, '')
  assert.equal((await f.store.read(agentId)).sources[0].status, 'revoked')
})

test('node authorization is retained when allowed and blocked nodes happen to share the same raw evidence', async () => {
  const f = fixture(), raw = source('raw-1')
  await f.cognition.record([raw], guard())
  await f.cognition.propose(agentId, a, [proposal('safe', [raw]), proposal('blocked', [raw], { content: '合作游戏 BLOCKED_SECRET' })], guard())
  f.control.blockedText = 'BLOCKED_SECRET'
  const recalled = await f.cognition.recall(query(), guard())
  assert.deepEqual(recalled.nodes.map(n => n.id), ['safe'])
  assert.doesNotMatch(recalled.text, /BLOCKED_SECRET/)
})

test('a blocked upstream evidence edge cannot be bypassed by another authorized node sharing its direct source', async () => {
  const f = fixture(), raw = source('raw-1'), hidden = source('private-evidence', privateScene)
  await f.cognition.record([raw, hidden], guard())
  await f.cognition.propose(agentId, a, [proposal('safe', [raw]), proposal('hidden-dependency', [raw])], guard())
  await f.store.update(agentId, state => { state.links.push({ id: 'restricted-proof', from: hidden.id, to: 'hidden-dependency', kind: 'supports', sourceIds: [hidden.id] }) }, guard())
  f.control.denied.add(hidden.id)
  const recalled = await f.cognition.recall(query(), guard())
  assert.deepEqual(recalled.nodes.map(n => n.id), ['safe'])
  assert.equal(await recalled.isCurrent(), true)
})

test('propose cannot inherit a target whose existing evidence is no longer authorized', async () => {
  const f = fixture(), old = expression('old'), fresh = expression('fresh')
  await f.cognition.record([old, fresh], guard())
  await f.cognition.propose(agentId, a, [selfProposal('interest', [old])], guard())
  f.control.denied.add(old.id)
  await assert.rejects(f.cognition.propose(agentId, a, [selfProposal('interest', [fresh], { action: 'CORROBORATE', targetId: 'interest' })], guard()))
  assert.deepEqual((await f.store.read(agentId)).nodes.find(n => n.id === 'interest').sourceIds, [old.id])
})

test('a proposal based on a source revision cannot silently attach to a newer revision admitted during authorization', async () => {
  const f = fixture(), raw = source('raw-1')
  await f.cognition.record([raw], guard())
  let revised = false
  f.control.sourceHook = async row => {
    if (row.id !== raw.id || revised) return
    revised = true
    await f.cognition.record([{ ...raw, revision: 2, content: '刚才理解错了，没有讨论过这个游戏' }], guard())
  }
  await assert.rejects(f.cognition.propose(agentId, a, [proposal('stale-proposal', [raw])], guard()))
  const saved = await f.store.read(agentId)
  assert.equal(saved.sources[0].revision, 2)
  assert.equal(saved.nodes.length, 0)
})

test('an authorized corroboration succeeds without mistaking its own atomic target update for a stale proposal', async () => {
  const f = fixture(), old = expression('old'), fresh = expression('fresh')
  await f.cognition.record([old, fresh], guard())
  await f.cognition.propose(agentId, a, [selfProposal('interest', [old])], guard())
  await f.cognition.propose(agentId, a, [selfProposal('interest', [fresh], { action: 'CORROBORATE', targetId: 'interest' })], guard())
  const saved = await f.store.read(agentId)
  assert.deepEqual(saved.nodes.find(n => n.id === 'interest').sourceIds, [old.id, fresh.id])
  const recalled = await f.cognition.recall(query(b), guard())
  assert.deepEqual(recalled.nodes.map(n => n.id), ['interest'])
  assert.equal(await recalled.isCurrent(), true)
})

test('a refinement can use superseded history as evidence while only the current interest is recalled', async () => {
  const f = fixture(), old = expression('old'), fresh = expression('fresh')
  await f.cognition.record([old, fresh], guard())
  await f.cognition.propose(agentId, a, [selfProposal('old-interest', [old])], guard())
  await f.cognition.propose(agentId, a, [selfProposal('refined-interest', [fresh], { action: 'REFINE', targetId: 'old-interest', content: '更喜欢合作游戏的解谜机制' })], guard())
  const saved = await f.store.read(agentId)
  assert.equal(saved.nodes.find(n => n.id === 'old-interest').status, 'superseded')
  assert.deepEqual(saved.nodes.find(n => n.id === 'refined-interest').sourceIds, [old.id, fresh.id])
  const recalled = await f.cognition.recall(query(b), guard())
  assert.deepEqual(recalled.nodes.map(n => n.id), ['refined-interest'])
  assert.equal(await recalled.isCurrent(), true)
})

test('a correction uses its replacement evidence without requiring the withdrawn older opinion', async () => {
  const f = fixture(), old = expression('old'), fresh = expression('fresh')
  await f.cognition.record([old, fresh], guard())
  await f.cognition.propose(agentId, a, [selfProposal('old-interest', [old])], guard())
  await f.cognition.propose(agentId, a, [selfProposal('corrected-interest', [fresh], { action: 'CORRECT', targetId: 'old-interest', content: '现在更喜欢合作游戏的创作玩法' })], guard())
  await f.cognition.invalidate(agentId, { id: 'forget-old-opinion', sourceIds: [old.id], before: Number.MAX_SAFE_INTEGER }, guard())
  const recalled = await f.cognition.recall(query(b), guard())
  assert.deepEqual(recalled.nodes.map(n => n.id), ['corrected-interest'])
  assert.equal(await recalled.isCurrent(), true)
})

test('committed failed and unknown receipts remain distinct, pending receipts are absent and repeated projection is inert', async () => {
  const f = fixture(), state = character()
  state.receipts = [
    { id: 'failed', toolName: 'create_artifact', status: 'failed', summary: '失败，没有创建成功', at },
    { id: 'unknown', toolName: 'send_message', status: 'unknown', summary: '宿主结果未知', at },
    { id: 'pending', toolName: 'search', status: 'pending', summary: '尚未执行', at },
    { id: 'succeeded', toolName: 'search', status: 'succeeded', summary: '检索已完成', at },
  ]
  const projected = turn(state, { messageRefs: [] })
  await f.cognition.projectTurn(projected, guard())
  const first = await f.store.read(agentId)
  assert.equal(first.sources.length, 3)
  assert.equal(first.nodes.length, 3)
  assert.ok(first.nodes.every(n => n.kind === 'receipt' && n.epistemic === 'reported'))
  assert.deepEqual(first.nodes.map(n => JSON.parse(n.content).status).sort(), ['failed', 'succeeded', 'unknown'])
  assert.ok(first.sources.every(s => !s.nativeId.includes('pending')))
  await f.cognition.projectTurn(projected, guard())
  assert.deepEqual(await f.store.read(agentId), first)
  state.receipts.find(r => r.id === 'unknown').status = 'failed'
  await f.cognition.projectTurn(projected, guard())
  const corrected = await f.store.read(agentId)
  assert.equal(corrected.sources.find(s => s.nativeId === 'receipt:unknown').revision, 2)
  assert.deepEqual(corrected.nodes.filter(n => n.status === 'active').map(n => JSON.parse(n.content).status).sort(), ['failed', 'failed', 'succeeded'])
  assert.ok(corrected.nodes.some(n => n.status === 'invalid' && JSON.parse(n.content).status === 'unknown'))
})

test('committed character memories project once and deleting them revokes downstream own expressions and self interests', async () => {
  const f = fixture(), raw = source('raw-1'), state = character()
  state.memories.push({ id: 'game', kind: 'interest', content: '合作游戏里的策略机制很有趣', epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at })
  await f.cognition.record([raw], guard())
  const projected = turn(state, { expressions: [{ messageId: 'confirmed-send', content: '我喜欢合作游戏的策略机制', at, participantIds: ['bot-a'] }] })
  await f.cognition.projectTurn(projected, guard())
  const initial = await f.store.read(agentId)
  const memory = initial.nodes.find(n => n.id.includes(':memory:game:'))
  const own = initial.sources.find(s => s.nativeId === 'confirmed-send')
  assert.ok(memory)
  assert.ok(initial.links.some(link => link.from === memory.id && link.to === own.id))
  await f.cognition.projectTurn(projected, guard())
  assert.deepEqual(await f.store.read(agentId), initial)
  await f.cognition.propose(agentId, a, [selfProposal('portable-interest', [own])], guard())
  assert.ok((await f.cognition.recall(query(b), guard())).nodes.some(n => n.id === 'portable-interest'))
  state.memories = []
  await f.cognition.projectTurn(turn(state), guard())
  const removed = await f.store.read(agentId)
  assert.equal(removed.nodes.find(n => n.id === memory.id).status, 'invalid')
  assert.equal(removed.sources.find(s => s.id === own.id).status, 'revoked')
  assert.equal(removed.sources.find(s => s.id === own.id).content, '')
  assert.equal(removed.nodes.find(n => n.id === 'portable-interest').status, 'invalid')
  assert.equal(removed.sources.find(s => s.id === raw.id).status, 'active')
  assert.equal((await f.cognition.recall(query(b), guard())).text, '')
})

test('missing character evidence is never replaced with fabricated sources or trusted projections', async () => {
  const f = fixture(), state = character()
  state.memories.push({ id: 'unsupported', kind: 'experience', content: '我亲自完成过游戏', epistemic: 'observed', evidenceRefs: ['message:900'], createdAt: at, updatedAt: at })
  await f.cognition.projectTurn(turn(state, { messageRefs: [], expressions: [{ messageId: 'sent', content: '我完成了游戏', at, participantIds: ['bot-a'] }] }), guard())
  const saved = await f.store.read(agentId)
  assert.deepEqual(saved.nodes, [])
  assert.deepEqual(saved.sources, [])
})

test('experience, interest, goal and actual outcome consolidate into a revocable procedure without mutating execution state', async t => {
  for (const status of ['succeeded', 'failed', 'unknown']) await t.test(status, async () => {
    const f = fixture(), raw = source('raw-1'), state = character()
    state.memories.push({ id: 'strategy', kind: 'interest', content: '合作游戏里的策略机制很有趣', epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at })
    state.goals.push({ id: 'strategy-guide', title: '整理合作游戏策略', nextStep: '先核对规则再写攻略', status: 'active', evidenceRefs: ['memory:strategy'], createdAt: at, updatedAt: at })
    await f.cognition.record([raw], guard())
    await f.cognition.projectTurn(turn(state), guard())
    state.goals[0].status = status === 'succeeded' ? 'completed' : 'waiting'
    state.goals[0].lastOutcome = status
    state.goals[0].updatedAt++
    state.receipts.push({ id: 'guide-result', goalId: 'strategy-guide', toolName: 'write_guide', status, summary: `攻略工具的真实状态为 ${status}`, at: at + 1 })
    await f.cognition.projectTurn(turn(state), guard())
    const projected = await f.store.read(agentId)
    const interest = projected.nodes.find(node => node.kind === 'interest' && node.status === 'active')
    const goal = projected.nodes.find(node => node.kind === 'goal' && node.status === 'active')
    const receipt = projected.nodes.find(node => node.kind === 'receipt' && node.status === 'active')
    assert.ok(projected.links.some(link => link.from === interest.id && link.to === goal.id && link.kind === 'motivates'))
    assert.ok(projected.links.some(link => link.from === goal.id && link.to === receipt.id && link.kind === 'result'))
    const afterProjection = structuredClone(projected)
    await f.cognition.projectTurn(turn(state), guard())
    assert.deepEqual(await f.store.read(agentId), afterProjection, 'unchanged turn must not duplicate evidence or relationships')
    const authoritative = structuredClone(state)
    let modelCalls = 0
    await f.cognition.consolidate(agentId, a, guard(), async (input, modelGuard) => {
      modelCalls++
      await modelGuard.ensureCurrent()
      assert.ok(input.current.some(node => node.id === goal.id))
      assert.ok(input.current.some(node => node.id === receipt.id))
      assert.equal(JSON.parse(input.sources.find(row => row.kind === 'receipt').content).status, status)
      return [proposal('guide-procedure', input.sources, { kind: 'procedure', epistemic: 'inferred',
        content: status === 'succeeded' ? '合作游戏攻略应先核对规则再编写' : `合作游戏攻略的上次行动为 ${status}，再次行动前需要核对结果` })]
    })
    assert.equal(modelCalls, 1)
    const recalled = await f.cognition.recall(query(), guard())
    assert.ok(recalled.nodes.some(node => node.id === 'guide-procedure' && node.epistemic === 'inferred'))
    assert.equal(await recalled.isCurrent(), true)
    await f.cognition.invalidate(agentId, { id: 'forget-strategy-evidence', sourceIds: [raw.id], before: Number.MAX_SAFE_INTEGER }, guard())
    assert.equal(await recalled.isCurrent(), false)
    assert.equal((await f.store.read(agentId)).nodes.find(node => node.id === 'guide-procedure').status, 'invalid')
    assert.deepEqual(state, authoritative, 'cognition must never edit the owning task or receipt ledger')
  })
})

test('a normal goal version change preserves the independently confirmed outcome and its current result relationship', async () => {
  const f = fixture(), raw = source('raw-1'), state = character()
  state.goals.push({ id: 'guide', title: '整理合作游戏策略', nextStep: '核对规则', status: 'active', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at })
  state.receipts.push({ id: 'search', goalId: 'guide', toolName: 'search', status: 'succeeded', summary: '查到了游戏规则', at: at + 1 })
  await f.cognition.record([raw], guard())
  await f.cognition.projectTurn(turn(state), guard())
  const first = await f.store.read(agentId), receiptId = first.nodes.find(node => node.kind === 'receipt').id
  const oldGoal = first.nodes.find(node => node.kind === 'goal')
  const runningRecall = await f.cognition.recall(query(a, { text: '游戏规则', excludeKinds: ['goal'] }), guard())
  assert.ok(runningRecall.nodes.some(node => node.id === receiptId))
  state.goals[0].nextStep = '编写攻略'
  state.goals[0].updatedAt++
  f.control.deniedNodes.add(oldGoal.id)
  assert.equal(await runningRecall.isCurrent(), true, 'changing an authoritative plan during the turn cannot unconfirm an actual result')
  await f.cognition.projectTurn(turn(state), guard())
  const updated = await f.store.read(agentId)
  assert.equal(updated.nodes.find(node => node.id === receiptId).status, 'active', 'a plan transition must not erase a confirmed result')
  const goal = updated.nodes.find(node => node.kind === 'goal' && node.status === 'active')
  assert.ok(updated.links.some(link => link.from === goal.id && link.to === receiptId && link.kind === 'result'))
  const recalled = await f.cognition.recall(query(a, { text: '游戏规则' }), guard())
  assert.ok(recalled.nodes.some(node => node.id === receiptId))
  assert.equal(await recalled.isCurrent(), true)
  assert.equal(await runningRecall.isCurrent(), true)
  state.goals[0].nextStep = '核对规则'
  state.goals[0].updatedAt++
  await f.cognition.projectTurn(turn(state), guard())
  const revisited = await f.store.read(agentId)
  assert.equal(revisited.nodes.filter(node => node.kind === 'goal' && node.status === 'active').length, 1)
  assert.equal(revisited.nodes.find(node => node.id === receiptId).status, 'active')
  assert.equal(revisited.nodes.find(node => node.kind === 'goal' && node.status === 'active').updatedAt, state.goals[0].updatedAt)
  f.control.deniedNodes.add(receiptId)
  assert.equal(await runningRecall.isCurrent(), false, 'changing the actual receipt authority must still revoke its pending use')
})

test('a current memory revision reconnects an existing goal and receipt without retiring their actual outcome', async () => {
  const f = fixture(), raw = source('raw-1'), state = character()
  state.memories.push({ id: 'strategy', kind: 'interest', content: '我想试试合作游戏', epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at })
  state.goals.push({ id: 'guide', title: '整理合作游戏策略', nextStep: '核对规则', status: 'active', evidenceRefs: ['memory:strategy'], createdAt: at, updatedAt: at })
  state.receipts.push({ id: 'search', goalId: 'guide', toolName: 'search', status: 'succeeded', summary: '查到了游戏规则', at: at + 1 })
  await f.cognition.record([raw], guard())
  await f.cognition.projectTurn(turn(state), guard())
  const first = await f.store.read(agentId), oldInterest = first.nodes.find(node => node.kind === 'interest')
  state.memories[0].content = '我更喜欢合作游戏里的解谜机制'
  state.memories[0].updatedAt++
  await f.cognition.projectTurn(turn(state, { expressions: [{ messageId: 'new-expression', content: '我喜欢合作解谜', at: at + 2, participantIds: ['bot-a'] }] }), guard())
  const updated = await f.store.read(agentId), goal = updated.nodes.find(node => node.kind === 'goal' && node.status === 'active')
  const interest = updated.nodes.find(node => node.kind === 'interest' && node.status === 'active')
  assert.equal(updated.nodes.find(node => node.id === oldInterest.id).status, 'superseded')
  assert.ok(updated.nodes.some(node => node.kind === 'receipt' && node.status === 'active'))
  assert.ok(updated.links.some(link => link.from === interest.id && link.to === goal.id && link.kind === 'motivates'))
  assert.ok(!updated.links.some(link => link.from === oldInterest.id && link.to === goal.id))
  assert.equal(updated.sources.find(row => row.nativeId === 'new-expression').status, 'active')
})
