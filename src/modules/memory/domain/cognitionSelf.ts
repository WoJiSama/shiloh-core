import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { CognitionNode, CognitionProposal, CognitionSource, CognitionState } from '../../../contracts/agentCognition.js'
import { conversationAddressKey, isConversationAddress } from '../../runtime/domain/agentBindings.js'
import { COGNITION_LIMITS, cognitionIdentity, cognitionSourceIsInvalidated, validateCognitionState } from './cognitionState.js'

export const COGNITION_PROPOSAL_LIMIT = 24
const kinds = new Set(['experience', 'observation', 'interest', 'opinion', 'habit', 'procedure', 'page', 'goal', 'receipt', 'person'])
const selfKinds = new Set(['interest', 'opinion', 'habit'])
const epistemics = new Set(['reported', 'observed', 'inferred', 'desired'])
const actions = new Set(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT'])
export class CognitionProposalError extends Error {
  constructor(readonly code: 'cognition_proposal_schema_invalid' | 'cognition_proposal_evidence_invalid' | 'cognition_proposal_json_invalid',
    readonly field: string, readonly rule: string, readonly limit?: number) {
    super('认知提案无效或缺少可用证据')
  }
}
const rejectShape = (field: string, rule: string, limit?: number): never => {
  throw new CognitionProposalError('cognition_proposal_schema_invalid', field, rule, limit)
}
const rejectEvidence = (field: string, rule: string): never => {
  throw new CognitionProposalError('cognition_proposal_evidence_invalid', field, rule)
}
const reference = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8_192 && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v)
const identifier = (v: unknown): v is string => reference(v) && v.length <= 256
const sameScene = (a: ConversationAddress, b: ConversationAddress) => conversationAddressKey(a) === conversationAddressKey(b)
function fields(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rejectShape(path, 'type')
  const row = value as Record<string, unknown>
  const missing = required.find(key => !Object.hasOwn(row, key))
  if (missing) rejectShape(path + '.' + missing, 'required')
  if (Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) rejectShape(path, 'additionalProperties')
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
  if (!Array.isArray(value)) return rejectShape('proposals', 'type')
  if (value.length > COGNITION_PROPOSAL_LIMIT) return rejectShape('proposals', 'maxItems', COGNITION_PROPOSAL_LIMIT)
  const ids = new Set<string>()
  return value.map(entry => {
    const p = fields(entry, 'proposals', ['id', 'action', 'kind', 'content', 'topic', 'sourceIds', 'epistemic', 'audience'], ['targetId', 'selfAssessment'])
    if (!identifier(p.id)) return rejectShape('proposals.id', 'cognition_identifier', 256)
    if (ids.has(p.id)) return rejectShape('proposals.id', 'uniqueItems')
    if (!actions.has(p.action as string)) return rejectShape('proposals.action', 'enum')
    if (!kinds.has(p.kind as string)) return rejectShape('proposals.kind', 'enum')
    if (!epistemics.has(p.epistemic as string)) return rejectShape('proposals.epistemic', 'enum')
    if (p.audience !== 'self' && p.audience !== 'scene') return rejectShape('proposals.audience', 'enum')
    if (typeof p.content !== 'string' || !p.content.trim()) return rejectShape('proposals.content', 'cognition_text')
    if (p.content.length > COGNITION_LIMITS.nodeText) return rejectShape('proposals.content', 'maxLength', COGNITION_LIMITS.nodeText)
    if (typeof p.topic !== 'string' || !p.topic.trim()) return rejectShape('proposals.topic', 'cognition_text')
    if (p.topic.length > 256) return rejectShape('proposals.topic', 'maxLength', 256)
    if (!Array.isArray(p.sourceIds)) return rejectShape('proposals.sourceIds', 'type')
    if (!p.sourceIds.length) return rejectShape('proposals.sourceIds', 'minItems', 1)
    if (p.sourceIds.length > 128) return rejectShape('proposals.sourceIds', 'maxItems', 128)
    if (!p.sourceIds.every(reference)) return rejectShape('proposals.sourceIds', 'cognition_identifier')
    if (p.action === 'CREATE' ? p.targetId !== undefined : !identifier(p.targetId)) return rejectShape('proposals.targetId', 'cognition_target_by_action')
    if (p.action === 'CORROBORATE' && p.id !== p.targetId) return rejectShape('proposals.id', 'cognition_match_target')
    if ((p.action === 'REFINE' || p.action === 'CORRECT') && p.id === p.targetId) return rejectShape('proposals.id', 'cognition_new_identifier')
    if (p.audience === 'self') {
      const assessment = fields(p.selfAssessment, 'proposals.selfAssessment', ['subject', 'sensitivity', 'containsOtherPeople'])
      if (!selfKinds.has(p.kind as string)) return rejectShape('proposals.kind', 'cognition_self_kind')
      if (assessment.subject !== 'self') return rejectShape('proposals.selfAssessment.subject', 'enum')
      if (assessment.sensitivity !== 'ordinary') return rejectShape('proposals.selfAssessment.sensitivity', 'enum')
      if (assessment.containsOtherPeople !== false) return rejectShape('proposals.selfAssessment.containsOtherPeople', 'cognition_self_only')
    } else if (p.selfAssessment !== undefined) return rejectShape('proposals.selfAssessment', 'incompatible')
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
  if (!isConversationAddress(conversation) || !Number.isSafeInteger(now) || now < 0) throw new Error('认知提案执行范围无效')
  const state = validateCognitionState(value), parsed = validateCognitionProposals(proposals)
  const sources = new Map(state.sources.map(source => [source.id, source]))
  const nodes = new Map(state.nodes.map(node => [node.id, node]))
  for (const p of parsed) {
    const target = p.targetId ? nodes.get(p.targetId) : undefined
    if (p.action !== 'CREATE' && (!target || !cognitionNodeHasCurrentSources(state, target) || target.kind !== p.kind || target.audience !== p.audience ||
        p.audience === 'scene' && !sameScene(target.conversation, conversation))) return rejectEvidence('proposals.targetId', 'cognition_target_current')
    const sourceIds = p.action === 'CORROBORATE' || p.action === 'REFINE'
      ? [...new Set([...(target?.sourceIds ?? []), ...p.sourceIds])] : p.sourceIds
    if (sourceIds.length > 128) return rejectEvidence('proposals.sourceIds', 'maxItems')
    const evidence = sourceIds.map(id => {
      const source = sources.get(id)
      if (!source || source.agentId !== state.agentId || source.status !== 'active' || cognitionSourceIsInvalidated(source, state.invalidations))
        return rejectEvidence('proposals.sourceIds', 'cognition_source_unavailable')
      if (p.audience === 'scene' && !sameScene(source.conversation, conversation) || p.audience === 'self' && !isCognitionSelfSource(source))
        return rejectEvidence('proposals.sourceIds', 'cognition_source_audience')
      return source
    })
    if (p.audience === 'self' && p.kind === 'habit' && independentSources(evidence) < 2) return rejectEvidence('proposals.sourceIds', 'cognition_distinct_sources')
    if (p.audience === 'scene' && p.epistemic === 'observed' && !evidence.some(isCognitionSuccessfulReceipt))
      return rejectEvidence('proposals.epistemic', 'cognition_successful_receipt')
    const sourceVersions = Object.fromEntries(evidence.map(source => [source.id, source.revision]))
    if (p.action === 'CORROBORATE') {
      if (!target || p.content !== target.content) return rejectEvidence('proposals.content', 'cognition_match_target')
      if (p.topic !== target.topic) return rejectEvidence('proposals.topic', 'cognition_match_target')
      if (p.epistemic !== target.epistemic) return rejectEvidence('proposals.epistemic', 'cognition_match_target')
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
          JSON.stringify(previous.sourceVersions) !== JSON.stringify(sourceVersions)) return rejectEvidence('proposals.id', 'cognition_new_identifier')
      continue
    }
    if (sources.has(p.id)) return rejectEvidence('proposals.id', 'cognition_new_identifier')
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
