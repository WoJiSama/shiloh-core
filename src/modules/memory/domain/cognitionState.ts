import type { ConversationAddress, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { CognitionInvalidation, CognitionLink, CognitionNode, CognitionSource, CognitionState } from '../../../contracts/agentCognition.js'
import { conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'

/** Bounded storage fails closed; reaching a limit never discards evidence or tombstones. */
export const COGNITION_LIMITS = Object.freeze({ sources: 4_000, nodes: 4_000, links: 8_000,
  invalidations: 20_000, processed: 20_000, sourceText: 16_000, nodeText: 8_000, bytes: 16 * 1024 * 1024 })
const nodeKinds = new Set(['experience', 'observation', 'interest', 'opinion', 'habit', 'procedure', 'page', 'goal', 'receipt', 'person'])
const sourceKinds = new Set(['message', 'self-expression', 'receipt'])
const relations = new Set(['supports', 'contradicts', 'refines', 'participates', 'motivates', 'result', 'related'])
const evidenceRelations = new Set(['supports', 'refines', 'motivates', 'result'])
/** A goal labels why an action ran; its mutable plan does not prove the result.
 * The receipt's own raw source remains the evidence for that confirmed event. */
export function cognitionLinkIsDependency(link: CognitionLink, nodes: ReadonlyMap<string, CognitionNode>): boolean {
  return evidenceRelations.has(link.kind) && !(link.kind === 'result' && nodes.get(link.from)?.kind === 'goal' && nodes.get(link.to)?.kind === 'receipt')
}
const epistemics = new Set(['reported', 'observed', 'inferred', 'desired'])
const fail = (): never => { throw new Error('认知状态或证据无效，已停止读写') }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
const agent = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const sameAccount = (left: PlatformAccountRef, right: PlatformAccountRef) =>
  left.id === right.id && left.platform === right.platform && left.namespace === right.namespace
const sameScene = (left: ConversationAddress, right: ConversationAddress) =>
  left.id === right.id && left.kind === right.kind && sameAccount(left.account, right.account)
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(record, key))) return fail()
  return record
}
function strings(value: unknown, max: number, nonempty = false): value is string[] {
  return Array.isArray(value) && value.length <= max && (!nonempty || value.length > 0) && value.every(identifier) && new Set(value).size === value.length
}
function account(value: unknown): value is PlatformAccountRef {
  object(value, ['platform', 'namespace', 'id'])
  return isPlatformAccount(value as PlatformAccountRef)
}
function conversation(value: unknown): value is ConversationAddress {
  const record = object(value, ['account', 'kind', 'id'])
  return account(record.account) && isConversationAddress(value as ConversationAddress)
}
export function cognitionKey(agentId: string): string {
  if (!agent(agentId)) return fail()
  return `agent:cognition:v1:${encodeURIComponent(agentId)}`
}
/** Collision-free tuple encoding; this is an identity, not a security token. */
export function cognitionIdentity(parts: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')
}
export function cognitionSourceId(agentId: string, address: ConversationAddress, kind: CognitionSource['kind'], nativeId: string): string {
  if (!agent(agentId) || !conversation(address) || !sourceKinds.has(kind) || !identifier(nativeId) || nativeId.length > 256) return fail()
  return `source:${cognitionIdentity([agentId, conversationAddressKey(address), kind, nativeId])}`
}
export function createEmptyCognitionState(agentId: string): CognitionState {
  cognitionKey(agentId)
  return { version: 1, agentId, revision: 0, privacyRevision: 0, sources: [], nodes: [], links: [], invalidations: [], processed: [] }
}
function source(value: unknown, agentId: string): CognitionSource {
  const s = object(value, ['id', 'agentId', 'conversation', 'kind', 'nativeId', 'authorId', 'occurredAt', 'content', 'revision', 'participantIds', 'status'])
  if (s.agentId !== agentId || !conversation(s.conversation) || !sourceKinds.has(s.kind as string) || !identifier(s.nativeId) ||
      !isPlatformIdentifier(s.authorId) || !integer(s.occurredAt) || !integer(s.revision) ||
      !strings(s.participantIds, 128) || !(s.participantIds as string[]).every(isPlatformIdentifier) ||
      !['active', 'revoked'].includes(s.status as string) || !text(s.content, COGNITION_LIMITS.sourceText, s.status === 'revoked') ||
      s.id !== cognitionSourceId(agentId, s.conversation, s.kind as CognitionSource['kind'], s.nativeId)) return fail()
  return s as unknown as CognitionSource
}
function invalidation(value: unknown): CognitionInvalidation {
  const rule = object(value, ['id', 'before'], ['account', 'conversation', 'sourceIds', 'authorId'])
  if (!identifier(rule.id) || !integer(rule.before) ||
      (rule.account !== undefined && !account(rule.account)) ||
      (rule.conversation !== undefined && !conversation(rule.conversation)) ||
      (rule.sourceIds !== undefined && !strings(rule.sourceIds, COGNITION_LIMITS.sources, true)) ||
      (rule.authorId !== undefined && !isPlatformIdentifier(rule.authorId))) return fail()
  return rule as unknown as CognitionInvalidation
}
/** Selectors are intersected. With no selector, before revokes all evidence up to that event time. */
export function cognitionSourceIsInvalidated(s: CognitionSource, rules: readonly CognitionInvalidation[]): boolean {
  return rules.some(rule => s.occurredAt <= rule.before &&
    (!rule.authorId || rule.authorId === s.authorId) && (!rule.sourceIds || rule.sourceIds.includes(s.id)) &&
    (!rule.account || sameAccount(rule.account, s.conversation.account)) &&
    (!rule.conversation || sameScene(rule.conversation, s.conversation)))
}
function assertAcyclic(edges: Map<string, Set<string>>) {
  const indegree = new Map<string, number>()
  for (const [from, targets] of edges) {
    if (!indegree.has(from)) indegree.set(from, 0)
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1)
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
  let count = 0
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!; count++
    for (const target of edges.get(id) ?? []) {
      const next = indegree.get(target)! - 1; indegree.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  if (count !== indegree.size) fail()
}

/** Validate persisted state without repairing corruption or silently granting new visibility. */
export function validateCognitionState(value: unknown, agentId?: string): CognitionState {
  const raw = object(value, ['version', 'agentId', 'revision', 'privacyRevision', 'sources', 'nodes', 'links', 'invalidations', 'processed'])
  if (raw.version !== 1 || !agent(raw.agentId) || (agentId !== undefined && raw.agentId !== agentId) ||
      !integer(raw.revision) || !integer(raw.privacyRevision) || !strings(raw.processed, COGNITION_LIMITS.processed)) return fail()
  for (const field of ['sources', 'nodes', 'links', 'invalidations'] as const) {
    if (!Array.isArray(raw[field]) || raw[field].length > COGNITION_LIMITS[field]) return fail()
  }
  const state = raw as unknown as CognitionState
  const sources = new Map<string, CognitionSource>(), nodes = new Map<string, CognitionNode>()
  const rules = state.invalidations.map(invalidation)
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) return fail()
  for (const entry of state.sources) {
    const s = source(entry, state.agentId)
    if (sources.has(s.id) || s.status === 'active' && cognitionSourceIsInvalidated(s, rules)) return fail()
    sources.set(s.id, s)
  }
  for (const entry of state.nodes) {
    const n = object(entry, ['id', 'kind', 'content', 'topic', 'epistemic', 'conversation', 'audience', 'sourceIds', 'sourceVersions', 'status', 'createdAt', 'updatedAt'], ['supersedes'])
    if (!identifier(n.id) || sources.has(n.id) || nodes.has(n.id) || !nodeKinds.has(n.kind as string) ||
        !text(n.content, COGNITION_LIMITS.nodeText) || !text(n.topic, 256) || !epistemics.has(n.epistemic as string) ||
        !conversation(n.conversation) || !['scene', 'self'].includes(n.audience as string) || !strings(n.sourceIds, 128, true) ||
        !['active', 'superseded', 'invalid'].includes(n.status as string) || !integer(n.createdAt) || !integer(n.updatedAt) || n.updatedAt < n.createdAt ||
        (n.supersedes !== undefined && (!identifier(n.supersedes) || n.supersedes === n.id))) return fail()
    const versions = object(n.sourceVersions, n.sourceIds)
    for (const id of n.sourceIds) {
      const s = sources.get(id), revision = versions[id]
      if (!s || !integer(revision) || revision > s.revision || n.audience === 'scene' && !sameScene(n.conversation, s.conversation)) return fail()
      if (n.status === 'active' && (s.status !== 'active' || revision !== s.revision)) return fail()
    }
    if (n.audience === 'self') {
      if (!['interest', 'opinion', 'habit'].includes(n.kind as string)) return fail()
      const independent = new Set<string>()
      for (const id of n.sourceIds) {
        const s = sources.get(id)!
        if (s.conversation.kind !== 'group' || s.kind !== 'self-expression' || s.authorId !== s.conversation.account.id ||
            s.participantIds.length !== 1 || s.participantIds[0] !== s.authorId) return fail()
        independent.add(JSON.stringify([conversationAddressKey(s.conversation), s.kind, s.nativeId]))
      }
      if (n.kind === 'habit' && independent.size < 2) return fail()
    }
    nodes.set(n.id, entry)
  }
  const edges = new Map<string, Set<string>>()
  const edge = (from: string, to: string) => { const targets = edges.get(from) ?? new Set<string>(); targets.add(to); edges.set(from, targets) }
  for (const node of nodes.values()) for (const id of node.sourceIds) edge(id, node.id)
  for (const node of nodes.values()) if (node.supersedes) {
    const previous = nodes.get(node.supersedes)
    if (!previous || previous.status === 'active' || previous.kind !== node.kind || previous.audience !== node.audience ||
        !sameScene(previous.conversation, node.conversation)) return fail()
    edge(previous.id, node.id)
  }
  const linkIds = new Set<string>()
  for (const entry of state.links) {
    const link = object(entry, ['id', 'from', 'to', 'kind', 'sourceIds'])
    if (!identifier(link.id) || linkIds.has(link.id) || !identifier(link.from) || !identifier(link.to) || link.from === link.to ||
        !relations.has(link.kind as string) || !strings(link.sourceIds, 128, true)) return fail()
    for (const id of [link.from, link.to]) {
      if (sources.has(id) ? sources.get(id)!.status !== 'active' : !nodes.has(id) || nodes.get(id)!.status === 'invalid') return fail()
    }
    if (link.sourceIds.some(id => sources.get(id)?.status !== 'active')) return fail()
    linkIds.add(link.id)
    if (cognitionLinkIsDependency(entry, nodes)) {
      edge(link.from, link.to)
      for (const id of link.sourceIds) edge(id, link.to)
    }
  }
  assertAcyclic(edges)
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > COGNITION_LIMITS.bytes) return fail()
  return structuredClone(state)
}

function invalidateDependencies(state: CognitionState, changedSources: Set<string>, changedNodes = new Set<string>()) {
  if (!changedSources.size && !changedNodes.size) return
  const sources = new Map(state.sources.map(s => [s.id, s])), nodes = new Map(state.nodes.map(n => [n.id, n]))
  const dependencies = new Map<string, Set<string>>()
  const edge = (from: string, to: string) => { const targets = dependencies.get(from) ?? new Set<string>(); targets.add(to); dependencies.set(from, targets) }
  for (const node of state.nodes) for (const id of node.sourceIds) edge(id, node.id)
  for (const link of state.links) if (cognitionLinkIsDependency(link, nodes)) {
    edge(link.from, link.to)
    for (const id of link.sourceIds) edge(id, link.to)
  }
  // A corrected root source remains active at its new revision. Its downstream
  // expressions are still based on the old evidence, and are permanently retired.
  const affected = new Set([...changedSources, ...changedNodes]), pending = [...affected]
  for (let index = 0; index < pending.length; index++) for (const id of dependencies.get(pending[index]!) ?? []) {
    const s = sources.get(id), n = nodes.get(id)
    if (s) { s.status = 'revoked'; s.content = ''; changedSources.add(id) }
    if (n) { n.status = 'invalid'; changedNodes.add(id) }
    if (!affected.has(id)) { affected.add(id); pending.push(id) }
  }
  state.links = state.links.filter(link => !affected.has(link.from) && !affected.has(link.to) && !link.sourceIds.some(id => affected.has(id)))
}
function sameSourceIdentity(left: CognitionSource, right: CognitionSource) {
  return left.agentId === right.agentId && sameScene(left.conversation, right.conversation) && left.kind === right.kind &&
    left.nativeId === right.nativeId && left.authorId === right.authorId && left.occurredAt === right.occurredAt && same(left.participantIds, right.participantIds)
}
export function recordCognitionSources(value: CognitionState, incoming: readonly CognitionSource[]): CognitionState {
  const state = validateCognitionState(value), sources = new Map(state.sources.map(s => [s.id, s])), changed = new Set<string>()
  if (!Array.isArray(incoming) || incoming.length > COGNITION_LIMITS.sources) return fail()
  for (const candidate of incoming) {
    const next = structuredClone(source(candidate, state.agentId)), previous = sources.get(next.id)
    if (previous && !sameSourceIdentity(previous, next)) return fail()
    if (previous?.status === 'revoked' || previous && next.revision < previous.revision) continue
    if (previous && next.revision === previous.revision) {
      if (!same(previous, next)) return fail()
      continue
    }
    if (cognitionSourceIsInvalidated(next, state.invalidations)) { next.status = 'revoked'; next.content = '' }
    if (previous) changed.add(next.id)
    if (next.status === 'revoked') { next.content = ''; changed.add(next.id) }
    sources.set(next.id, next)
  }
  state.sources = [...sources.values()]
  invalidateDependencies(state, changed)
  return validateCognitionState(state)
}
export function invalidateCognitionState(value: CognitionState, change: CognitionInvalidation): CognitionState {
  const state = validateCognitionState(value), rule = structuredClone(invalidation(change))
  const previous = state.invalidations.find(entry => entry.id === rule.id)
  if (previous) { if (!same(previous, rule)) return fail(); return state }
  state.invalidations.push(rule)
  if (state.privacyRevision === Number.MAX_SAFE_INTEGER) return fail()
  state.privacyRevision++
  const revoked = new Set<string>()
  for (const s of state.sources) if (cognitionSourceIsInvalidated(s, [rule])) {
    s.status = 'revoked'; s.content = ''; revoked.add(s.id)
  }
  invalidateDependencies(state, revoked)
  return validateCognitionState(state)
}

/** Store mutations cannot remove the records that prevent replay or revive historical nodes. */
export function validateCognitionTransition(previous: CognitionState, next: CognitionState): void {
  if (previous.agentId !== next.agentId || previous.revision !== next.revision || next.privacyRevision < previous.privacyRevision) fail()
  const sources = new Map(next.sources.map(s => [s.id, s])), nodes = new Map(next.nodes.map(n => [n.id, n]))
  for (const old of previous.sources) {
    const current = sources.get(old.id)
    if (!current || !sameSourceIdentity(old, current) || current.revision < old.revision ||
        current.status === 'revoked' && current.content !== '' || old.status === 'revoked' && !same(old, current) ||
        old.status === 'active' && current.status === 'active' && old.revision === current.revision && !same(old, current)) fail()
  }
  for (const old of previous.nodes) {
    const current = nodes.get(old.id)
    if (!current || current.kind !== old.kind || current.audience !== old.audience || !sameScene(current.conversation, old.conversation) ||
        current.createdAt !== old.createdAt || current.updatedAt < old.updatedAt || current.supersedes !== old.supersedes ||
        old.status !== 'active' && current.status === 'active' || old.status === 'invalid' && current.status !== 'invalid') fail()
  }
  // Evaluate the previous graph as well: dropping an edge in the same mutation
  // cannot conceal the descendants of a corrected or revoked source/node.
  const changedSources = new Set(previous.sources.filter(old => {
    const current = sources.get(old.id)!
    return current.revision !== old.revision || current.status !== old.status
  }).map(s => s.id))
  const changedNodes = new Set(previous.nodes.filter(old => old.status !== 'invalid' && nodes.get(old.id)!.status === 'invalid').map(n => n.id))
  if (changedSources.size || changedNodes.size) {
    const affected = structuredClone(previous)
    affected.sources = affected.sources.map(s => structuredClone(sources.get(s.id)!))
    for (const n of affected.nodes) if (changedNodes.has(n.id)) n.status = 'invalid'
    invalidateDependencies(affected, changedSources, changedNodes)
    for (const s of affected.sources) if (s.status === 'revoked' && (sources.get(s.id)?.status !== 'revoked' || sources.get(s.id)?.content !== '')) fail()
    for (const id of changedNodes) if (nodes.get(id)?.status !== 'invalid') fail()
  }
  const currentRules = new Map(next.invalidations.map(rule => [rule.id, rule]))
  for (const old of previous.invalidations) if (!same(currentRules.get(old.id), old)) fail()
  if (next.invalidations.length > previous.invalidations.length && next.privacyRevision <= previous.privacyRevision) fail()
  const fingerprints = new Set(next.processed)
  if (previous.processed.some(id => !fingerprints.has(id))) fail()
}
