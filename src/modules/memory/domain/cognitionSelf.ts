import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { CognitionNode, CognitionProposal, CognitionSource, CognitionState } from '../../../contracts/agentCognition.js'
import { conversationAddressKey, isConversationAddress } from '../../runtime/domain/agentBindings.js'
import { COGNITION_LIMITS, cognitionIdentity, cognitionSourceIsInvalidated, validateCognitionState } from './cognitionState.js'

export const COGNITION_PROPOSAL_LIMIT = 24
const kinds = new Set(['experience', 'observation', 'interest', 'opinion', 'habit', 'procedure', 'page', 'goal', 'receipt', 'person'])
const selfKinds = new Set(['interest', 'opinion', 'habit'])
const epistemics = new Set(['reported', 'observed', 'inferred', 'desired'])
const actions = new Set(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT'])
const fail = (): never => { throw new Error('认知提案无效或缺少可用证据') }
const reference = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8_192 && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v)
const identifier = (v: unknown): v is string => reference(v) && v.length <= 256
const sameScene = (a: ConversationAddress, b: ConversationAddress) => conversationAddressKey(a) === conversationAddressKey(b)
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const row = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return fail()
  return row
}

/** Core supplies only confirmed bot sends here, including all actual participants. */
export function isCognitionSelfSource(source: CognitionSource): boolean {
  return source.kind === 'self-expression' && source.status === 'active' && source.conversation.kind === 'group' &&
    source.authorId === source.conversation.account.id && source.participantIds.length === 1 && source.participantIds[0] === source.authorId
}

/** Only Core's structured, successful execution receipt proves an action completed. */
export function isCognitionSuccessfulReceipt(source: CognitionSource): boolean {
  if (source.kind !== 'receipt' || source.authorId !== source.conversation.account.id) return false
  try {
    const value: unknown = JSON.parse(source.content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    return row.status === 'succeeded' && typeof row.toolName === 'string' && row.toolName.trim().length > 0 &&
      typeof row.summary === 'string' && (row.goalId === null || typeof row.goalId === 'string') &&
      Object.keys(row).length === 4 && ['toolName', 'status', 'summary', 'goalId'].every(key => Object.hasOwn(row, key))
  } catch { return false }
}

/** Narrow, shared parser for both direct proposals and model output. No extra authority fields. */
export function validateCognitionProposals(value: unknown): CognitionProposal[] {
  if (!Array.isArray(value) || value.length > COGNITION_PROPOSAL_LIMIT) return fail()
  const ids = new Set<string>()
  return value.map(entry => {
    const p = fields(entry, ['id', 'action', 'kind', 'content', 'topic', 'sourceIds', 'epistemic', 'audience'], ['targetId', 'selfAssessment'])
    if (!identifier(p.id) || ids.has(p.id) || !actions.has(p.action as string) || !kinds.has(p.kind as string) ||
        typeof p.content !== 'string' || !p.content.trim() || p.content.length > COGNITION_LIMITS.nodeText ||
        typeof p.topic !== 'string' || !p.topic.trim() || p.topic.length > 256 || !epistemics.has(p.epistemic as string) ||
        !['self', 'scene'].includes(p.audience as string) || !Array.isArray(p.sourceIds) || !p.sourceIds.length ||
        p.sourceIds.length > 128 || !p.sourceIds.every(reference)) return fail()
    if (p.action === 'CREATE' ? p.targetId !== undefined : !identifier(p.targetId)) return fail()
    if (p.action === 'CORROBORATE' && p.id !== p.targetId) return fail()
    if ((p.action === 'REFINE' || p.action === 'CORRECT') && p.id === p.targetId) return fail()
    if (p.audience === 'self') {
      const assessment = fields(p.selfAssessment, ['subject', 'sensitivity', 'containsOtherPeople'])
      if (!selfKinds.has(p.kind as string) || assessment.subject !== 'self' || assessment.sensitivity !== 'ordinary' || assessment.containsOtherPeople !== false) return fail()
    } else if (p.selfAssessment !== undefined) return fail()
    ids.add(p.id)
    return { ...structuredClone(p), sourceIds: [...new Set(p.sourceIds as string[])] } as unknown as CognitionProposal
  })
}

export function cognitionNodeHasCurrentSources(state: CognitionState, node: CognitionNode, allowed?: ReadonlySet<string>): boolean {
  if (node.status !== 'active' || node.sourceIds.length === 0) return false
  const sources = new Map(state.sources.map(source => [source.id, source]))
  const evidence: CognitionSource[] = []
  for (const id of node.sourceIds) {
    const source = sources.get(id)
    if (!source || source.agentId !== state.agentId || source.status !== 'active' ||
        allowed && !allowed.has(id) || node.sourceVersions[id] !== source.revision || cognitionSourceIsInvalidated(source, state.invalidations)) return false
    if (node.audience === 'scene' && !sameScene(source.conversation, node.conversation)) return false
    evidence.push(source)
  }
  if (node.audience === 'self' && (!selfKinds.has(node.kind) || !evidence.every(isCognitionSelfSource) ||
      node.kind === 'habit' && independentSources(evidence) < 2)) return false
  return true
}

function independentSources(sources: readonly CognitionSource[]): number {
  return new Set(sources.map(s => JSON.stringify([s.agentId, conversationAddressKey(s.conversation), s.kind, s.nativeId]))).size
}
function linkEvidence(state: CognitionState, node: CognitionNode): void {
  for (const sourceId of node.sourceIds) {
    const id = `evidence:${cognitionIdentity([sourceId, node.id])}`
    if (!state.links.some(link => link.id === id)) state.links.push({ id, from: sourceId, to: node.id, kind: 'supports', sourceIds: [sourceId] })
  }
}

/** Atomic pure batch application: nothing can mutate the caller's state on rejection. */
export function applyCognitionProposals(value: CognitionState, conversation: ConversationAddress, proposals: readonly CognitionProposal[], now = Date.now()): CognitionState {
  if (!isConversationAddress(conversation) || !Number.isSafeInteger(now) || now < 0) return fail()
  const state = validateCognitionState(value), parsed = validateCognitionProposals(proposals)
  const sources = new Map(state.sources.map(source => [source.id, source]))
  const nodes = new Map(state.nodes.map(node => [node.id, node]))
  for (const p of parsed) {
    const target = p.targetId ? nodes.get(p.targetId) : undefined
    if (p.action !== 'CREATE' && (!target || !cognitionNodeHasCurrentSources(state, target) || target.kind !== p.kind || target.audience !== p.audience ||
        p.audience === 'scene' && !sameScene(target.conversation, conversation))) return fail()
    const sourceIds = p.action === 'CORROBORATE' || p.action === 'REFINE'
      ? [...new Set([...(target?.sourceIds ?? []), ...p.sourceIds])] : p.sourceIds
    if (sourceIds.length > 128) return fail()
    const evidence = sourceIds.map(id => {
      const source = sources.get(id)
      if (!source || source.agentId !== state.agentId || source.status !== 'active' || cognitionSourceIsInvalidated(source, state.invalidations) ||
          p.audience === 'scene' && !sameScene(source.conversation, conversation) || p.audience === 'self' && !isCognitionSelfSource(source)) return fail()
      return source
    })
    if (p.audience === 'self' && p.kind === 'habit' && independentSources(evidence) < 2) return fail()
    if (p.audience === 'scene' && p.epistemic === 'observed' && !evidence.some(isCognitionSuccessfulReceipt)) return fail()
    const sourceVersions = Object.fromEntries(evidence.map(source => [source.id, source.revision]))
    if (p.action === 'CORROBORATE') {
      if (!target || p.content !== target.content || p.topic !== target.topic || p.epistemic !== target.epistemic) return fail()
      if (sourceIds.length === target.sourceIds.length) continue
      target.sourceIds = sourceIds; target.sourceVersions = sourceVersions; target.updatedAt = Math.max(now, target.updatedAt)
      linkEvidence(state, target)
      continue
    }
    const previous = nodes.get(p.id)
    if (previous) {
      if (p.action !== 'CREATE' || previous.status !== 'active' || previous.kind !== p.kind || previous.content !== p.content ||
          previous.topic !== p.topic || previous.epistemic !== p.epistemic || previous.audience !== p.audience ||
          !sameScene(previous.conversation, conversation) || JSON.stringify(previous.sourceIds) !== JSON.stringify(sourceIds) ||
          JSON.stringify(previous.sourceVersions) !== JSON.stringify(sourceVersions)) return fail()
      continue
    }
    if (sources.has(p.id)) return fail()
    const createdAt = target ? Math.max(now, target.updatedAt) : now
    const node: CognitionNode = { id: p.id, kind: p.kind, content: p.content, topic: p.topic, epistemic: p.epistemic,
      conversation: structuredClone(target?.conversation ?? conversation), audience: p.audience,
      sourceIds: [...sourceIds], sourceVersions, status: 'active', createdAt, updatedAt: createdAt }
    if (target) {
      target.status = 'superseded'; target.updatedAt = createdAt; node.supersedes = target.id
      const id = `revision:${cognitionIdentity([target.id, node.id])}`
      state.links.push({ id, from: target.id, to: node.id, kind: p.action === 'CORRECT' ? 'contradicts' : 'refines', sourceIds: [...p.sourceIds] })
    }
    state.nodes.push(node); nodes.set(node.id, node); linkEvidence(state, node)
  }
  return validateCognitionState(state)
}
