import assert from 'node:assert/strict'
import test from 'node:test'
import { addCharacterMemory, classifyCharacterResult, createCharacterGoal, createEmptyCharacterState, deleteCharacterMemory, dueCharacterGoal, formatCharacterSection } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createSimTools } from '../dist/backend/modules/simulation/infrastructure/simTools.js'

const at = 1_790_000_000_000
const scope = { botId: '99', personaId: 'shiloh', groupId: '10086' }
const memory = (id, refs, extra = {}) => ({ id, kind: 'opinion', epistemic: 'inferred', content: id, evidenceRefs: refs, ...extra })

test('structured unknown outcomes take precedence over error fields and remain unsafe to retry', () => {
  for (const value of [{ ok: false, unknown: true, error: 'timeout' }, { kind: 'tool_outcome', status: 'unknown', error: { message: 'timeout' } }]) assert.equal(classifyCharacterResult(JSON.stringify(value)), 'unknown')
  assert.equal(classifyCharacterResult(JSON.stringify({ kind: 'tool_outcome', status: 'success' })), 'succeeded')
  assert.equal(classifyCharacterResult(JSON.stringify({ kind: 'tool_outcome', status: 'error' })), 'failed')
})

test('a correction invalidates dependent opinions and goals while retaining its provenance', () => {
  let state = addCharacterMemory(createEmptyCharacterState(scope), memory('old', ['message:1']), ['message:1'], at)
  state = addCharacterMemory(state, memory('derived', ['memory:old']), ['memory:old'], at)
  state = createCharacterGoal(state, { id: 'goal', title: '核对', motivation: '依旧观点安排', nextStep: '读取资料', completionCriteria: '取得资料', stopConditions: ['依据失效'], evidenceRefs: ['memory:derived'] }, ['memory:derived'], at)
  state = addCharacterMemory(state, memory('corrected', ['memory:old', 'message:2'], { supersedes: 'old' }), ['memory:old', 'message:2'], at + 1)
  const displayed = JSON.parse(formatCharacterSection(state).split('\n').at(-1))
  assert.deepEqual(displayed.memories.map(item => item.id), ['corrected'])
  assert.equal(state.goals[0].status, 'abandoned')
  assert.equal(dueCharacterGoal(state, at + 3600_000), undefined)
  assert.ok(state.memories.some(item => item.id === 'old'), 'historical provenance stays available for validation')
  assert.throws(() => addCharacterMemory(state, memory('recycled', ['memory:derived']), ['memory:derived'], at + 2), /失效|修正/)
})

test('deleting a correction cannot revive its replaced source or dependent conclusions', () => {
  let state = addCharacterMemory(createEmptyCharacterState(scope), memory('old', ['message:1']), ['message:1'], at)
  state = addCharacterMemory(state, memory('derived', ['memory:old']), ['memory:old'], at)
  state = addCharacterMemory(state, memory('corrected', ['memory:old', 'message:2'], { supersedes: 'old' }), ['memory:old', 'message:2'], at + 1)
  state = deleteCharacterMemory(state, 'corrected', at + 2)
  assert.deepEqual(state.memories, [])
})

test('social memory and affinity tools wait for persistence and expose failed writes', async () => {
  for (const [name, args] of [
    ['simRemember', { action: 'add', content: '应当持久化的事实' }],
    ['simRemember', { action: 'remove', id: 'existing' }],
    ['simRemember', { action: 'done', id: 'existing' }],
    ['simUpdateAffinity', { userId: '10001', delta: 1, reason: '主动帮忙' }],
  ]) {
    let release, settled = false
    const held = new Promise(resolve => { release = resolve })
    const memories = [{ id: 'existing', kind: 'note', content: '旧记录', createdAt: at, updatedAt: at }]
    const original = structuredClone(memories)
    const fail = async () => { await held; throw new Error('persistent write unavailable') }
    const tool = createSimTools({ now: () => at, getMemories: () => memories, getAffinity: () => ({}), saveMemories: fail, saveAffinity: fail }).find(item => item.name === name)
    const execution = tool.execute(args, {}).then(result => { settled = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    const premature = settled
    release()
    const result = await execution
    assert.equal(premature, false, name)
    assert.match(result, /^error:/, name)
    assert.deepEqual(memories, original, 'failed persistence cannot mutate the live memory snapshot')
  }
})
