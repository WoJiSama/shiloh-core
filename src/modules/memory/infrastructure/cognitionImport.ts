import { createHash } from 'node:crypto'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { CharacterEpistemic, CharacterMemoryKind, CharacterScope } from '../../../contracts/character.js'
import type { CognitionGuard, CognitionInvalidation, CognitionNode, CognitionSource, CognitionState } from '../../../contracts/agentCognition.js'
import { conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { COGNITION_LIMITS, cognitionSourceId, createEmptyCognitionState, invalidateCognitionState, recordCognitionSources, validateCognitionState } from '../domain/cognitionState.js'
import { isCognitionSuccessfulReceipt } from '../domain/cognitionSelf.js'

/** Offline, normalized evidence snapshot; this is deliberately not a Redis dump.
 * Every old scope needs exactly one explicitly verified mapping. A source ref is
 * the old `message:<seq>` or `receipt:<id>`; nativeId is the real platform event
 * ID, not a guessed sequence. Memory refs may also use `memory:<legacy id>`.
 * All restrictions must be represented, even when invalidations is empty.
 * Goals, pending receipts and old global notes are not promoted into memories.
 */
export interface CognitionImportSnapshot {
  schemaVersion: 1
  agentId: string
  mappings: { legacy: CharacterScope; agentId: string; conversation: ConversationAddress; verified: true }[]
  sources: {
    scope: CharacterScope; ref: string; kind: CognitionSource['kind']; nativeId: string
    authorId: string; occurredAt: number; content: string; revision: number
    participantIds: string[]; status: CognitionSource['status']; receiptStatus?: 'succeeded' | 'failed' | 'pending' | 'unknown'
  }[]
  memories: {
    scope: CharacterScope; id: string; kind: CharacterMemoryKind; content: string
    epistemic: CharacterEpistemic; evidenceRefs: string[]; createdAt: number; updatedAt: number; supersedes?: string
  }[]
  invalidations: { id: string; scope: CharacterScope; before: number; sourceRefs?: string[]; authorId?: string }[]
}

export interface CognitionImportSkip {
  collection: 'mappings' | 'sources' | 'memories' | 'invalidations'
  index: number
  id: string
  reason: string
}
export interface CognitionImportPreview {
  schemaVersion: 1
  agentId: string
  previewHash: string
  destinationRevision: number
  alreadyApplied: boolean
  /** An unresolved historical deletion blocks the entire import. */
  applicable: boolean
  counts: { inputSources: number; inputMemories: number; inputInvalidations: number; plannedSources: number; plannedNodes: number; plannedInvalidations: number; skipped: number }
  skipped: CognitionImportSkip[]
  sources: CognitionSource[]
  nodes: CognitionNode[]
  invalidations: CognitionInvalidation[]
}
export interface CognitionImportStore {
  update(agentId: string, mutate: (state: CognitionState) => CognitionState | void, guard: CognitionGuard): Promise<CognitionState>
}

type Row = Record<string, unknown>
type Header = { schemaVersion: 1; agentId: string; mappings: unknown[]; sources: unknown[]; memories: unknown[]; invalidations: unknown[] }
type Mapping = { agentId: string; conversation: ConversationAddress }
type SourceEntry = { index: number; key: string; ref: string; source: CognitionSource }
type MemoryEntry = { index: number; key: string; scope: CharacterScope; id: string; kind: CharacterMemoryKind; content: string; epistemic: CharacterEpistemic; evidenceRefs: string[]; createdAt: number; updatedAt: number; supersedes?: string; conversation: ConversationAddress }
const fail = (message: string): never => { throw new Error(`认知导入已停止：${message}`) }
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
const strings = (value: unknown, max: number, nonempty = true): value is string[] => Array.isArray(value) && value.length <= max && (!nonempty || value.length > 0) && value.every(identifier) && new Set(value).size === value.length
function row(value: unknown, required: readonly string[], optional: readonly string[] = []): Row | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const object = value as Row
  return required.every(key => Object.hasOwn(object, key)) && Object.keys(object).every(key => required.includes(key) || optional.includes(key)) ? object : undefined
}
function normalizedReceipt(content: string, status: unknown): string | undefined {
  try {
    const value = row(JSON.parse(content), ['toolName', 'status', 'summary', 'goalId'])
    if (!value || !identifier(value.toolName) || !['succeeded', 'failed', 'unknown'].includes(value.status as string) ||
        value.status !== status || typeof value.summary !== 'string' || value.goalId !== null && !identifier(value.goalId)) return undefined
    return JSON.stringify({ toolName: value.toolName, status: value.status, summary: value.summary, goalId: value.goalId })
  } catch { return undefined }
}
function scope(value: unknown): CharacterScope | undefined {
  const object = row(value, ['botId', 'personaId', 'groupId'])
  return object && ['botId', 'personaId', 'groupId'].every(key => identifier(object[key])) ? object as unknown as CharacterScope : undefined
}
const scopeKey = (value: CharacterScope) => JSON.stringify([value.botId, value.personaId, value.groupId])
const refKey = (value: CharacterScope, ref: string) => JSON.stringify([scopeKey(value), ref])
const nodeId = (agentId: string, value: CharacterScope, id: string) => `import:memory:${sha256(JSON.stringify([agentId, scopeKey(value), id]))}`
function address(value: unknown): value is ConversationAddress {
  const object = row(value, ['account', 'kind', 'id'])
  return !!object && !!row(object.account, ['platform', 'namespace', 'id']) && isConversationAddress(value as ConversationAddress)
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)

/** Canonical JSON hashes every input field; no caller-provided fingerprint is trusted. */
function canonical(value: unknown, depth = 0, visited = new Set<object>()): string {
  if (depth > 32) return fail('JSON 层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (!value || typeof value !== 'object' || visited.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('只接受无循环的 JSON 数据')
  visited.add(value)
  const encoded = Array.isArray(value) ? `[${value.map(entry => canonical(entry, depth + 1, visited)).join(',')}]` :
    `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key], depth + 1, visited)}`).join(',')}}`
  visited.delete(value)
  return encoded
}
function snapshot(input: unknown): { input: Header; hash: string } {
  const encoded = canonical(input)
  if (Buffer.byteLength(encoded, 'utf8') > COGNITION_LIMITS.bytes) return fail('快照超过大小限制')
  const copy: unknown = JSON.parse(encoded), header = row(copy, ['schemaVersion', 'agentId', 'mappings', 'sources', 'memories', 'invalidations'])
  if (!header || header.schemaVersion !== 1 || typeof header.agentId !== 'string') return fail('快照格式或 schemaVersion 无效')
  createEmptyCognitionState(header.agentId)
  for (const [field, limit] of [['mappings', COGNITION_LIMITS.sources], ['sources', COGNITION_LIMITS.sources], ['memories', COGNITION_LIMITS.nodes], ['invalidations', COGNITION_LIMITS.invalidations]] as const) {
    if (!Array.isArray(header[field]) || header[field].length > limit) return fail(`${field} 必须是受限数组`)
  }
  return { input: header as unknown as Header, hash: sha256(encoded) }
}

function plan(input: Header, hash: string, destination: CognitionState): { preview: CognitionImportPreview; state: CognitionState } {
  const original = validateCognitionState(destination, input.agentId)
  const marker = `import:${hash}`
  const preview: CognitionImportPreview = {
    schemaVersion: 1, agentId: input.agentId, previewHash: hash, destinationRevision: original.revision,
    alreadyApplied: original.processed.includes(marker), applicable: true,
    counts: { inputSources: input.sources.length, inputMemories: input.memories.length, inputInvalidations: input.invalidations.length,
      plannedSources: 0, plannedNodes: 0, plannedInvalidations: 0, skipped: 0 },
    skipped: [], sources: [], nodes: [], invalidations: [],
  }
  if (preview.alreadyApplied) return { preview, state: original }
  const skips = new Set<string>()
  const skip = (collection: CognitionImportSkip['collection'], index: number, id: string, reason: string) => {
    const key = `${collection}:${index}`
    if (!skips.has(key)) { skips.add(key); preview.skipped.push({ collection, index, id, reason }) }
  }
  const mappings = new Map<string, { index: number; value?: Mapping }[]>(), mappingErrors = new Map<string, string>()
  input.mappings.forEach((value, index) => {
    const object = row(value, ['legacy', 'agentId', 'conversation', 'verified']), legacy = scope(object?.legacy)
    if (!object || !legacy) { skip('mappings', index, String(index), 'invalid-mapping'); return }
    const key = scopeKey(legacy), entries = mappings.get(key) ?? []
    if (object.verified === true && object.agentId === input.agentId && address(object.conversation)) entries.push({ index, value: { agentId: input.agentId, conversation: object.conversation } })
    else entries.push({ index })
    mappings.set(key, entries)
  })
  for (const [key, entries] of mappings) {
    const reason = entries.length !== 1 ? 'ambiguous-legacy-mapping' : !entries[0]?.value ? 'unverified-or-wrong-agent-mapping' : undefined
    if (reason) { mappingErrors.set(key, reason); for (const entry of entries) skip('mappings', entry.index, key, reason) }
  }
  const mapping = (legacy: CharacterScope): Mapping | undefined => mappingErrors.has(scopeKey(legacy)) ? undefined : mappings.get(scopeKey(legacy))?.[0]?.value
  const mappingReason = (legacy: CharacterScope) => mappingErrors.get(scopeKey(legacy)) ?? 'missing-legacy-mapping'

  const sourceEntries = new Map<string, SourceEntry[]>(), identityEntries = new Map<string, SourceEntry[]>(), successfulReceipts = new Set<string>()
  input.sources.forEach((value, index) => {
    const object = row(value, ['scope', 'ref', 'kind', 'nativeId', 'authorId', 'occurredAt', 'content', 'revision', 'participantIds', 'status'], ['receiptStatus'])
    const legacy = scope(object?.scope), id = identifier(object?.ref) ? object.ref : String(index)
    if (!object || !legacy || !identifier(object.ref)) { skip('sources', index, id, 'invalid-source'); return }
    const target = mapping(legacy)
    if (!target) { skip('sources', index, id, mappingReason(legacy)); return }
    if (!['message', 'self-expression', 'receipt'].includes(object.kind as string) || !identifier(object.nativeId) || !isPlatformIdentifier(object.authorId) ||
        !integer(object.occurredAt, 1) || !integer(object.revision, 1) || !strings(object.participantIds, 128, false) || !object.participantIds.every(isPlatformIdentifier) ||
        !['active', 'revoked'].includes(object.status as string) || !text(object.content, COGNITION_LIMITS.sourceText, object.status === 'revoked') ||
        (object.kind === 'receipt' ? !/^receipt:.+/u.test(object.ref) || object.ref !== object.nativeId ||
          object.authorId !== target.conversation.account.id || object.participantIds.length !== 0 : !/^message:[1-9]\d*$/u.test(object.ref) || object.receiptStatus !== undefined) ||
        object.kind === 'self-expression' && (object.authorId !== target.conversation.account.id || object.participantIds.length !== 1 || object.participantIds[0] !== object.authorId)) {
      skip('sources', index, id, 'missing-or-invalid-source-evidence'); return
    }
    const content = object.status === 'revoked' ? '' : object.kind === 'receipt' ? normalizedReceipt(object.content, object.receiptStatus) : object.content
    if (content === undefined) { skip('sources', index, id, 'missing-or-invalid-source-evidence'); return }
    const source: CognitionSource = {
      id: cognitionSourceId(input.agentId, target.conversation, object.kind as CognitionSource['kind'], object.nativeId),
      agentId: input.agentId, conversation: target.conversation, kind: object.kind as CognitionSource['kind'], nativeId: object.nativeId,
      authorId: object.authorId, occurredAt: object.occurredAt, content,
      revision: object.revision, participantIds: object.participantIds, status: object.status as CognitionSource['status'],
    }
    const entry = { index, key: refKey(legacy, object.ref), ref: object.ref, source }
    if (source.status === 'active' && isCognitionSuccessfulReceipt(source)) successfulReceipts.add(source.id)
    sourceEntries.set(entry.key, [...(sourceEntries.get(entry.key) ?? []), entry])
    identityEntries.set(source.id, [...(identityEntries.get(source.id) ?? []), entry])
  })
  const sources = new Map<string, CognitionSource>(), sourceRefs = new Map<string, CognitionSource>()
  for (const entries of sourceEntries.values()) for (const entry of entries) {
    const aliases = identityEntries.get(entry.source.id)!
    if (entries.length !== 1 || aliases.some(alias => !same(alias.source, entry.source))) {
      skip('sources', entry.index, entry.ref, 'ambiguous-source-reference'); continue
    }
    sources.set(entry.source.id, entry.source); sourceRefs.set(entry.key, entry.source)
  }

  let state = original
  input.invalidations.forEach((value, index) => {
    const object = row(value, ['id', 'scope', 'before'], ['sourceRefs', 'authorId']), legacy = scope(object?.scope)
    const id = identifier(object?.id) ? object.id : String(index)
    const target = legacy && mapping(legacy)
    const refs = object?.sourceRefs
    if (!object || !legacy || !target || !identifier(object.id) || !integer(object.before) ||
        refs !== undefined && (!strings(refs, COGNITION_LIMITS.sources) || refs.some(ref => !sourceRefs.has(refKey(legacy, ref)))) ||
        object.authorId !== undefined && !isPlatformIdentifier(object.authorId)) {
      skip('invalidations', index, id, 'unresolved-historical-invalidation'); preview.applicable = false; return
    }
    const rule: CognitionInvalidation = {
      id: `import:invalidation:${sha256(JSON.stringify([input.agentId, scopeKey(legacy), object.id]))}`,
      conversation: target.conversation, before: object.before,
      ...(refs ? { sourceIds: [...new Set((refs as string[]).map(ref => sourceRefs.get(refKey(legacy, ref))!.id))] } : {}),
      ...(object.authorId ? { authorId: object.authorId as string } : {}),
    }
    const prior = state.invalidations.find(entry => entry.id === rule.id)
    if (prior && !same(prior, rule)) { skip('invalidations', index, id, 'invalidation-conflict'); preview.applicable = false; return }
    state = invalidateCognitionState(state, rule)
  })

  // A revoked historical source is a tombstone, even if the destination has a
  // newer active revision. Apply the restriction before considering evidence.
  for (const source of sources.values()) if (source.status === 'revoked') {
    state = invalidateCognitionState(state, {
      id: `import:revoked:${sha256(source.id)}`, conversation: source.conversation, sourceIds: [source.id], before: source.occurredAt,
    })
  }
  input.sources.forEach((value, index) => {
    if (value && typeof value === 'object' && (value as Row).status === 'revoked' && preview.skipped.some(entry => entry.collection === 'sources' && entry.index === index)) preview.applicable = false
  })

  const previousSources = new Map(state.sources.map(source => [source.id, source]))
  for (const [id, candidate] of sources) {
    const previous = previousSources.get(id)
    let reason: string | undefined
    if (previous?.status === 'revoked') reason = 'source-revoked'
    else if (previous && (candidate.revision < previous.revision)) reason = 'stale-source-revision'
    else if (previous && (candidate.authorId !== previous.authorId || candidate.occurredAt !== previous.occurredAt || !same(candidate.participantIds, previous.participantIds) ||
      candidate.revision === previous.revision && !same(candidate, previous))) reason = 'source-conflict'
    if (reason) {
      sources.delete(id)
      for (const entry of identityEntries.get(id) ?? []) { sourceRefs.delete(entry.key); skip('sources', entry.index, entry.ref, reason) }
    }
  }
  state = recordCognitionSources(state, [...sources.values()])
  const storedSources = new Map(state.sources.map(source => [source.id, source]))
  for (const [key, source] of sourceRefs) {
    if (storedSources.get(source.id)?.status !== 'active') {
      sourceRefs.delete(key)
      for (const entry of sourceEntries.get(key) ?? []) skip('sources', entry.index, entry.ref, 'source-revoked')
    }
  }

  const memoryEntries = new Map<string, MemoryEntry[]>(), memories = new Map<string, MemoryEntry>()
  input.memories.forEach((value, index) => {
    const object = row(value, ['scope', 'id', 'kind', 'content', 'epistemic', 'evidenceRefs', 'createdAt', 'updatedAt'], ['supersedes'])
    const legacy = scope(object?.scope), id = identifier(object?.id) ? object.id : String(index)
    if (!object || !legacy || !identifier(object.id)) { skip('memories', index, id, 'invalid-memory'); return }
    const target = mapping(legacy)
    if (!target) { skip('memories', index, id, mappingReason(legacy)); return }
    if (!['experience', 'opinion', 'interest'].includes(object.kind as string) || !text(object.content, COGNITION_LIMITS.nodeText) ||
        !['reported', 'observed', 'inferred', 'desired'].includes(object.epistemic as string) || !strings(object.evidenceRefs, 128) ||
        !integer(object.createdAt, 1) || !integer(object.updatedAt, 1) || object.updatedAt < object.createdAt ||
        object.supersedes !== undefined && (!identifier(object.supersedes) || object.supersedes === object.id)) {
      skip('memories', index, id, 'missing-or-invalid-memory-evidence'); return
    }
    const entry: MemoryEntry = { index, key: refKey(legacy, object.id), scope: legacy, id: object.id, kind: object.kind as CharacterMemoryKind,
      content: object.content, epistemic: object.epistemic as CharacterEpistemic, evidenceRefs: object.evidenceRefs,
      createdAt: object.createdAt, updatedAt: object.updatedAt, conversation: target.conversation,
      ...(object.supersedes ? { supersedes: object.supersedes as string } : {}),
    }
    memoryEntries.set(entry.key, [...(memoryEntries.get(entry.key) ?? []), entry])
  })
  for (const [key, entries] of memoryEntries) {
    if (entries.length === 1) memories.set(key, entries[0]!)
    else for (const entry of entries) skip('memories', entry.index, entry.id, 'duplicate-memory-id')
  }
  const candidates = new Map<string, CognitionNode>(), resolving = new Set<string>(), resolved = new Set<string>()
  const dependencies = new Map<string, string[]>()
  function resolve(entry: MemoryEntry, depth = 0): CognitionNode | undefined {
    if (resolved.has(entry.key)) return candidates.get(entry.key)
    if (resolving.has(entry.key) || depth > 128) { skip('memories', entry.index, entry.id, 'cyclic-or-deep-memory-reference'); return undefined }
    resolving.add(entry.key)
    const evidence = new Set<string>(), refs: string[] = []
    let valid = true
    for (const ref of entry.evidenceRefs) {
      if (ref.startsWith('memory:')) {
        const key = refKey(entry.scope, ref.slice(7)), dependency = memories.get(key), node = dependency && resolve(dependency, depth + 1)
        refs.push(key)
        if (!node) valid = false
        else for (const id of node.sourceIds) evidence.add(id)
      } else {
        const source = sourceRefs.get(refKey(entry.scope, ref))
        if (!source) valid = false
        else evidence.add(source.id)
      }
    }
    dependencies.set(entry.key, refs)
    if (!valid || evidence.size === 0 || evidence.size > 128) skip('memories', entry.index, entry.id, 'unresolved-or-revoked-evidence')
    else if (entry.epistemic === 'observed' && ![...evidence].some(id => successfulReceipts.has(id) && storedSources.get(id)?.kind === 'receipt')) skip('memories', entry.index, entry.id, 'observed-memory-requires-succeeded-receipt')
    else if ([...evidence].some(id => storedSources.get(id)!.occurredAt > entry.updatedAt)) skip('memories', entry.index, entry.id, 'evidence-after-memory-time')
    else {
      const sourceIds = [...evidence].sort()
      candidates.set(entry.key, {
        id: nodeId(input.agentId, entry.scope, entry.id), kind: entry.kind, content: entry.content, topic: '历史记忆', epistemic: entry.epistemic,
        conversation: entry.conversation, audience: 'scene', sourceIds,
        sourceVersions: Object.fromEntries(sourceIds.map(id => [id, storedSources.get(id)!.revision])), status: 'active',
        createdAt: entry.createdAt, updatedAt: entry.updatedAt,
        ...(entry.supersedes ? { supersedes: nodeId(input.agentId, entry.scope, entry.supersedes) } : {}),
      })
    }
    resolving.delete(entry.key); resolved.add(entry.key)
    return candidates.get(entry.key)
  }
  for (const entry of memories.values()) resolve(entry)
  const existingNodes = new Map(state.nodes.map(node => [node.id, node]))
  const remove = (key: string, reason: string) => { const entry = memories.get(key)!; candidates.delete(key); skip('memories', entry.index, entry.id, reason) }
  for (const [key, node] of candidates) {
    const previous = existingNodes.get(node.id)
    if (previous && (previous.status === 'invalid' || !same({ ...previous, status: 'active' }, node))) remove(key, previous.status === 'invalid' ? 'node-retired' : 'memory-conflict')
    else if (previous) node.status = previous.status
  }
  // Fail closed for missing/forked/cyclic correction history, then propagate any
  // rejected dependency. No surviving subset of a memory's evidence is used.
  const successorKeys = new Map<string, string[]>()
  for (const [key, node] of candidates) if (node.supersedes) successorKeys.set(node.supersedes, [...(successorKeys.get(node.supersedes) ?? []), key])
  for (const keys of successorKeys.values()) if (keys.length > 1) for (const key of keys) remove(key, 'ambiguous-correction-history')
  for (const [key, node] of candidates) if (node.supersedes && state.nodes.some(existing => existing.supersedes === node.supersedes && existing.id !== node.id)) remove(key, 'conflicting-existing-correction')
  let changed = true
  while (changed) {
    changed = false
    const byId = new Map([...candidates.values()].map(node => [node.id, node]))
    for (const [key, node] of candidates) {
      let reason: string | undefined
      if ((dependencies.get(key) ?? []).some(dependency => !candidates.has(dependency))) reason = 'unresolved-memory-dependency'
      if (node.supersedes) {
        const previous = byId.get(node.supersedes) ?? existingNodes.get(node.supersedes)
        if (!previous || previous.status === 'invalid' || previous.kind !== node.kind || previous.audience !== 'scene' || conversationAddressKey(previous.conversation) !== conversationAddressKey(node.conversation) || previous.updatedAt > node.updatedAt) reason = 'missing-or-invalid-correction-history'
        const visited = new Set([node.id]); let next = previous
        while (next) {
          if (visited.has(next.id)) { reason = 'cyclic-correction-history'; break }
          visited.add(next.id); next = next.supersedes ? byId.get(next.supersedes) ?? existingNodes.get(next.supersedes) : undefined
        }
      }
      if (reason) { remove(key, reason); changed = true }
    }
  }
  const nextNodes = new Map(state.nodes.map(node => [node.id, node]))
  for (const node of candidates.values()) if (!nextNodes.has(node.id)) nextNodes.set(node.id, node)
  for (const node of candidates.values()) if (node.supersedes) {
    const previous = nextNodes.get(node.supersedes)!
    if (previous.status === 'active') previous.status = 'superseded'
  }
  state.nodes = [...nextNodes.values()]
  state.processed.push(marker)
  state = validateCognitionState(state, input.agentId)
  preview.sources = state.sources.filter(source => !same(original.sources.find(old => old.id === source.id) ?? null, source))
  preview.nodes = state.nodes.filter(node => !same(original.nodes.find(old => old.id === node.id) ?? null, node))
  preview.invalidations = state.invalidations.filter(rule => !original.invalidations.some(old => old.id === rule.id))
  preview.skipped.sort((a, b) => a.collection.localeCompare(b.collection) || a.index - b.index)
  preview.counts.plannedSources = preview.sources.length; preview.counts.plannedNodes = preview.nodes.length
  preview.counts.plannedInvalidations = preview.invalidations.length; preview.counts.skipped = preview.skipped.length
  return { preview, state }
}

export function previewCognitionImport(input: unknown, destination?: CognitionState): CognitionImportPreview {
  const parsed = snapshot(input)
  return plan(parsed.input, parsed.hash, destination ?? createEmptyCognitionState(parsed.input.agentId)).preview
}

/** One store transaction checkpoints the fingerprint with all resulting changes.
 * The store owns the revision increment and CAS; a retry observes the same
 * expected revision or aborts, and cannot silently apply a newly changed plan.
 */
export async function applyCognitionImport(store: CognitionImportStore, input: unknown, options: {
  previewHash: string; expectedRevision: number; guard: CognitionGuard
}): Promise<CognitionState> {
  const parsed = snapshot(input), hash = options.previewHash, revision = options.expectedRevision
  if (!/^[a-f0-9]{64}$/u.test(hash) || hash !== parsed.hash) return fail('预览哈希不匹配，请重新预览完整快照')
  if (!integer(revision)) return fail('目标 revision 无效')
  return store.update(parsed.input.agentId, current => {
    if (current.revision !== revision) return fail('目标 revision 已变化，请重新预览')
    const result = plan(parsed.input, parsed.hash, current)
    if (!result.preview.applicable) return fail('存在无法验证的历史删除限制，请先修正快照')
    return result.state
  }, options.guard)
}
