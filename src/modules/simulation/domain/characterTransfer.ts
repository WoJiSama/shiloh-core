import type { CharacterState } from '../../../contracts/character.js'
import { activeCharacterMemories, expireCharacterGoals, settleCharacter, transitionCharacterGoal, validateCharacterState } from './characterState.js'
import { AUTONOMOUS_EXTRA_TOOLS } from './executionActor.js'

export function recoverInterruptedCharacter(state: CharacterState, now: number): CharacterState {
  const uncertainGoals = new Set(state.receipts.filter(receipt => receipt.goalId && receipt.status === 'pending'
    && receipt.toolName !== 'simGoalCheck' && !AUTONOMOUS_EXTRA_TOOLS.includes(receipt.toolName)).map(receipt => receipt.goalId))
  let recovered = settleCharacter(state, now)
  for (const goal of recovered.goals) {
    if (uncertainGoals.has(goal.id) && ['active', 'waiting'].includes(goal.status)) {
      recovered = transitionCharacterGoal(recovered, goal.id, 'paused', { now, lastOutcome: '重启前的外部动作结果未知，暂停等待核对后再恢复，避免重复副作用' })
    }
  }
  return recovered
}

// These receipts record an outcome without carrying the source chat or a
// result from a host tool. Other tools can persist arbitrary returned text.
const portableReceiptTools = new Set(['simGoalCheck', 'simSendMessage', 'simFinishTurn'])
const receiptSummaries = { succeeded: '工具执行返回成功', failed: '动作失败', unknown: '动作结果无法确认', pending: '动作待确认' }

export function projectCharacterTransfer(source: CharacterState, now: number): CharacterState {
  const state = recoverInterruptedCharacter(source, now)
  const eligibleMemories = new Map<string, CharacterState['memories'][number]>()
  const goalIds = new Set<string>()
  const receiptIds = new Set<string>()
  const activeMemoryIds = new Set(activeCharacterMemories(state).map(memory => memory.id))
  const previousMemoryIds = new Set(state.memories.flatMap(memory => memory.supersedes ? [memory.supersedes] : []))
  const portableReceipts = state.receipts.filter(receipt => portableReceiptTools.has(receipt.toolName))
  const available = (ref: string) => ref.startsWith('receipt:') ? receiptIds.has(ref.slice(8))
    : ref.startsWith('memory:') && activeMemoryIds.has(ref.slice(7)) && eligibleMemories.has(ref.slice(7))

  // A dependency is eligible only once its source is present. This also
  // excludes detached cycles, old message sequence numbers and shared sources.
  let size = -1
  while (size !== eligibleMemories.size + goalIds.size + receiptIds.size) {
    size = eligibleMemories.size + goalIds.size + receiptIds.size
    for (const receipt of portableReceipts) {
      if (receipt.goalId && !goalIds.has(receipt.goalId)) continue
      receiptIds.add(receipt.id)
    }
    for (const memory of state.memories) {
      if (eligibleMemories.has(memory.id) || memory.sharedSources?.length ||
          (!activeMemoryIds.has(memory.id) && !previousMemoryIds.has(memory.id))) continue
      const previous = memory.supersedes
      if (previous && !eligibleMemories.has(previous)) continue
      if (!memory.evidenceRefs.every(ref => available(ref) || (previous && ref === `memory:${previous}`))) continue
      eligibleMemories.set(memory.id, memory)
    }
    for (const goal of state.goals) {
      if (goalIds.has(goal.id) || goal.sharedSources?.length || !goal.evidenceRefs.length) continue
      const settled = ['completed', 'abandoned', 'failed'].includes(goal.status)
      // A closed goal can cite its own completion receipt. Admit only that
      // bounded pair, without allowing arbitrary dependency cycles.
      const own = settled ? portableReceipts.filter(receipt => receipt.goalId === goal.id) : []
      if (!goal.evidenceRefs.every(ref => available(ref) || own.some(receipt => ref === `receipt:${receipt.id}`))) continue
      goalIds.add(goal.id)
    }
  }
  const memoryIds = new Set<string>()
  // Revisions were resolved before their replacements. Keep an ancestor only
  // when the approved projection will contain its replacement as well.
  for (const memory of [...eligibleMemories.values()].reverse()) {
    if (!activeMemoryIds.has(memory.id) && !memoryIds.has(memory.id)) continue
    memoryIds.add(memory.id)
    if (memory.supersedes) memoryIds.add(memory.supersedes)
  }
  const memories = state.memories.filter(memory => memoryIds.has(memory.id))
    .map(memory => activeMemoryIds.has(memory.id) ? memory : { ...memory, content: '已被后续版本修正' })
  const goals = state.goals.filter(goal => goalIds.has(goal.id))
  const receipts = portableReceipts.filter(receipt => receiptIds.has(receipt.id))
    .map(receipt => ({ ...receipt, summary: receiptSummaries[receipt.status] }))
  return expireCharacterGoals(validateCharacterState({ ...state, goals, receipts, memories, decision: undefined }), now)
}
