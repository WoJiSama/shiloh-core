import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { AgentBindingSnapshot, ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentSemanticMemoryBackend, AgentSemanticMemoryConfig, AgentSemanticMemoryQuerySource } from '../../../contracts/semanticMemory.js'
import type { PersonMemoryIdentity, PersonMemoryScene, PersonMemoryStore, PersonMemorySubject } from '../../../contracts/personMemory.js'
import type { PersonProfileExtractionContext } from '../../../contracts/personProfileExtraction.js'
import { agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformIdentifier } from '../../runtime/domain/agentBindings.js'
import { personMemorySourceKey } from '../domain/personMemory.js'
import { personMemoryAddress } from './personMemoryContext.js'
import { createAgentSemanticMemory } from './agentSemanticMemory.js'
import { agentSemanticMemoryId, type AgentSemanticMemoryRow } from './agentSemanticMemoryStore.js'
import type { AgentSemanticRetrievalMode, AgentSemanticRetrievalSource, AgentSemanticRetrievalTrace } from './agentSemanticRetrieval.js'

export interface SemanticEvaluationSource { scope: string; messageId: string }
export interface SemanticEvaluationScope {
  id: string
  agentId: string
  target: ConversationAddress
  privatePeer?: string
  rows: (Omit<AgentSemanticMemoryRow, 'vector' | 'providerId' | 'peerId'> & {
    recalled?: boolean; revoked?: boolean; disabled?: boolean; forgotten?: boolean
  })[]
}
export interface SemanticEvaluationQuery {
  id: string
  scope: string
  query: string
  relevant: SemanticEvaluationSource[]
  forbidden: SemanticEvaluationSource[]
  allowPrivateScopes?: string[]
  excludeMessageIds?: string[]
  querySource?: AgentSemanticMemoryQuerySource
  tags?: string[]
}
export interface SemanticEvaluationDataset {
  schemaVersion: 2
  id: string
  revision: string
  clockAt: number
  profiles: { production: AgentSemanticMemoryConfig; comparison: AgentSemanticMemoryConfig }
  scopes: SemanticEvaluationScope[]
  queries: SemanticEvaluationQuery[]
}
export interface SemanticEvaluationBackend extends AgentSemanticMemoryBackend { dispose?(): void | Promise<void> }
export interface SemanticEvaluationOptions {
  createBackend(): SemanticEvaluationBackend | Promise<SemanticEvaluationBackend>
  backendMetadata: Readonly<Record<string, unknown>>
  modes?: readonly AgentSemanticRetrievalMode[]
  cache?: 'isolated-client' | 'warm-client'
}
const MODES = ['vector', 'bm25', 'hybrid', 'hybrid-rerank', 'production'] as const
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceKey = (source: AgentSemanticRetrievalSource) => JSON.stringify([source.scopeId, source.messageId])
const forbiddenWrite = async (): Promise<never> => { throw new Error('Evaluation storage is read-only') }
const validId = (value: unknown): value is string => isPlatformIdentifier(value) && value !== '0'
function fail(message: string): never { throw new Error(`Invalid evaluation dataset: ${message}`) }

/** Validate before constructing providers, reading any external data or sending model requests. */
export function parseAgentSemanticEvaluationDataset(input: unknown): SemanticEvaluationDataset {
  if (!input || typeof input !== 'object') fail('object required')
  const data = input as SemanticEvaluationDataset
  if (data.schemaVersion !== 2 || !validId(data.id) || !validId(data.revision) ||
      !Number.isSafeInteger(data.clockAt) || data.clockAt <= 0) fail('version, identity or clock')
  if (!Array.isArray(data.scopes) || !data.scopes.length || data.scopes.length > 200 || !Array.isArray(data.queries) ||
      !data.queries.length || data.queries.length > 2000 || !data.profiles) fail('bounded scopes, queries and profiles required')
  for (const profile of [data.profiles.production, data.profiles.comparison]) {
    if (!profile || typeof profile !== 'object' || profile.enabled !== undefined && profile.enabled !== true) fail('enabled profiles required')
    for (const [key, minimum, maximum] of [['topK', 1, 10], ['minScore', 0, 1], ['timeoutMs', 200, 5000],
      ['retentionDays', 1, 90], ['maxMessagesPerConversation', 50, 2000]] as const) {
      const value = profile[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
          key !== 'minScore' && !Number.isInteger(value))) fail(`profile.${key}`)
    }
    if (Object.keys(profile).some(key => !['enabled', 'topK', 'minScore', 'timeoutMs', 'retentionDays', 'maxMessagesPerConversation'].includes(key))) fail('unknown profile option')
  }
  const ids = new Set<string>(), addresses = new Set<string>()
  for (const scope of data.scopes) {
    if (!scope || !validId(scope.id) || ids.has(scope.id) || !validId(scope.agentId) || !isConversationAddress(scope.target) ||
        !Array.isArray(scope.rows) || scope.rows.length > 2000 || scope.target.kind === 'private' && !validId(scope.privatePeer)) fail('scope')
    ids.add(scope.id)
    const address = conversationAddressKey(scope.target)
    if (addresses.has(address)) fail('one current binding per conversation required')
    addresses.add(address)
    const messages = new Set<string>()
    for (const row of scope.rows) {
      if (!row || !validId(row.messageId) || messages.has(row.messageId) || !validId(row.authorId) || typeof row.name !== 'string' ||
          row.name.length > 24 || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 1600 ||
          !Number.isSafeInteger(row.at) || row.at <= 0) fail('source row')
      if (Object.keys(row).some(key => !['messageId', 'authorId', 'name', 'text', 'at', 'recalled', 'revoked', 'disabled', 'forgotten'].includes(key)) ||
          ['recalled', 'revoked', 'disabled', 'forgotten'].some(key => (row as unknown as Record<string, unknown>)[key] !== undefined &&
            typeof (row as unknown as Record<string, unknown>)[key] !== 'boolean')) fail('source flags')
      messages.add(row.messageId)
    }
  }
  const queryIds = new Set<string>()
  const reference = (ref: SemanticEvaluationSource) => Boolean(ref && data.scopes.find(scope => scope.id === ref.scope)?.rows.some(row => row.messageId === ref.messageId))
  for (const query of data.queries) {
    if (!query || !validId(query.id) || queryIds.has(query.id) || !ids.has(query.scope) || typeof query.query !== 'string' ||
        !query.query.trim() || query.query.length > 2000 || !Array.isArray(query.relevant) || !Array.isArray(query.forbidden) ||
        !query.relevant.every(reference) || !query.forbidden.every(reference)) fail('query or evidence reference')
    for (const refs of [query.relevant, query.forbidden]) if (new Set(refs.map(ref => JSON.stringify([ref.scope, ref.messageId]))).size !== refs.length) fail('duplicate evidence')
    if (query.relevant.some(ref => query.forbidden.some(other => ref.scope === other.scope && ref.messageId === other.messageId))) fail('relevant and forbidden overlap')
    if (query.allowPrivateScopes !== undefined && (!Array.isArray(query.allowPrivateScopes) || query.allowPrivateScopes.some(id => !ids.has(id)))) fail('private authorization')
    if (query.excludeMessageIds !== undefined && (!Array.isArray(query.excludeMessageIds) || !query.excludeMessageIds.every(validId))) fail('excluded messages')
    if (query.querySource !== undefined && (!validId(query.querySource.messageId) || !validId(query.querySource.authorId) ||
        !Number.isSafeInteger(query.querySource.at) || query.querySource.at <= 0)) fail('query attribution')
    if (query.tags !== undefined && (!Array.isArray(query.tags) || !query.tags.every(tag => typeof tag === 'string'))) fail('tags')
    queryIds.add(query.id)
  }
  return structuredClone(data)
}

function binding(scope: SemanticEvaluationScope): AgentBindingSnapshot {
  return { agentId: scope.agentId, target: scope.target, id: scope.id, source: 'configured', revision: 'evaluation-v2',
    personaId: 'evaluation', connectionId: `eval-${scope.id}` }
}
function identity(scope: SemanticEvaluationScope): PersonMemoryIdentity {
  return { botId: personMemoryAddress(scope.target).botId, personaId: agentPersonaScopeId(scope.agentId) }
}
function sameIdentity(left: PersonMemoryIdentity, right: PersonMemoryIdentity) { return left.botId === right.botId && left.personaId === right.personaId }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) }
  return value
}

/** Only source privacy reads needed by Core are implemented; every mutation fails closed. */
function privacy(data: SemanticEvaluationDataset): PersonMemoryStore {
  return {
    remember: forbiddenWrite, registerSource: forbiddenWrite, forget: forbiddenWrite, revokeSource: forbiddenWrite,
    forgetScene: forbiddenWrite, setEnabled: forbiddenWrite, query: forbiddenWrite, list: forbiddenWrite, read: forbiddenWrite, scenes: forbiddenWrite,
    async getRedactions(subject) {
      const scopes = data.scopes.filter(scope => sameIdentity(identity(scope), subject.identity))
      return { ...subject, revision: 'frozen-evaluation-v2', disabled: false, forgottenBefore: 0,
        scenes: scopes.filter(scope => scope.rows.some(row => row.authorId === subject.subjectId && row.disabled)).map(scope => ({
          scene: personMemoryAddress(scope.target, scope.privatePeer).scene, disabled: true, forgottenBefore: 0,
        })),
        revokedSources: scopes.flatMap(scope => scope.rows.filter(row => row.authorId === subject.subjectId && row.revoked).map(row =>
          personMemorySourceKey({ scene: personMemoryAddress(scope.target, scope.privatePeer).scene, messageId: row.messageId }))),
        tombstones: scopes.flatMap(scope => scope.rows.filter(row => row.authorId === subject.subjectId && row.forgotten).map(row => ({
          sourceKey: personMemorySourceKey({ scene: personMemoryAddress(scope.target, scope.privatePeer).scene, messageId: row.messageId }), before: data.clockAt,
        }))),
      }
    },
    async getSceneRedactions() { return { revision: 'frozen-evaluation-v2', invalidatedAt: 0, forgottenBefore: 0 } },
    async identities() { return data.scopes.map(identity) },
    async listSubjects(filter) {
      const result = new Map<string, PersonMemorySubject>()
      for (const scope of data.scopes) for (const row of scope.rows) {
        const owner = identity(scope)
        if (!filter || sameIdentity(filter, owner)) result.set(JSON.stringify([owner, row.authorId]), { identity: owner, subjectId: row.authorId })
      }
      return [...result.values()]
    },
  }
}

function frozenStorage(data: SemanticEvaluationDataset, vectors: ReadonlyMap<string, number[]>, providerId: string) {
  const records = new Map<string, string>()
  const prefix = 'agent:semantic-memory:v1'
  const entries = data.scopes.map(scope => ({ id: agentSemanticMemoryId(scope), scope: { agentId: scope.agentId, target: scope.target } }))
  records.set(`${prefix}:catalog`, JSON.stringify({ version: 1, entries }))
  for (const [index, scope] of data.scopes.entries()) {
    const rows: AgentSemanticMemoryRow[] = scope.rows.filter(row => scope.target.kind !== 'private' || row.authorId === scope.privatePeer)
      .slice(-(data.profiles.production.maxMessagesPerConversation ?? 1000)).map(row => {
      const value = vectors.get(sourceKey({ scopeId: entries[index]!.id, messageId: row.messageId }))
      return { messageId: row.messageId, authorId: row.authorId, name: row.name, text: row.text, at: row.at,
        ...(scope.target.kind === 'private' ? { peerId: scope.privatePeer! } : {}), ...(value ? { vector: [...value], providerId } : {}) }
    })
    records.set(`${prefix}:state:${entries[index]!.id}`, JSON.stringify({ version: 1, ...entries[index], rows }))
  }
  return {
    fingerprint: () => digest([...records]),
    async get(key: string) { return records.get(key) ?? null },
    async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
      if (/redis\.call\('(SET|DEL|INCR|EXPIRE|LPUSH|RPUSH)'/u.test(script)) return forbiddenWrite()
      if (script === "return {redis.call('GET', KEYS[1]) or false, redis.call('GET', KEYS[2]) or false}" && options.keys.length === 2 && !options.arguments.length) {
        return options.keys.map(key => records.get(key) ?? null)
      }
      throw new Error('Unsupported evaluation storage operation')
    },
  }
}
function contextFor(scope: SemanticEvaluationScope, signal: AbortSignal): PersonProfileExtractionContext {
  const current = () => !signal.aborted
  return { target: scope.target, binding: binding(scope), signal, isCurrent: current,
    async ensureCurrent() { signal.throwIfAborted() } }
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = Object.assign(new Error('Evaluation operation timed out'), { code: 'semantic_memory_timeout' }); controller.abort(error); reject(error) }, timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer); controller.abort() }
}
function normalize(value: readonly number[] | null | undefined): number[] {
  if (!value || value.length < 2 || value.length > 4096 || !value.every(item => Number.isFinite(item))) throw new Error('Invalid prepared embedding')
  const norm = Math.hypot(...value)
  if (!norm || !Number.isFinite(norm)) throw new Error('Invalid prepared embedding')
  return value.map(item => item / norm)
}
function createReader(data: SemanticEvaluationDataset, backend: SemanticEvaluationBackend, vectors: ReadonlyMap<string, number[]>,
  config: AgentSemanticMemoryConfig, mode: AgentSemanticRetrievalMode, query: SemanticEvaluationQuery, observe: (trace: AgentSemanticRetrievalTrace) => void) {
  const redis = frozenStorage(data, vectors, backend.id)
  const scopeByAddress = new Map(data.scopes.map(scope => [conversationAddressKey(scope.target), scope]))
  const composer = createAgentSemanticMemory({ redis, memory: privacy(data), config: () => ({ ...config, enabled: true }), backend,
    resolve: target => { const scope = scopeByAddress.get(conversationAddressKey(target)); return scope && { binding: binding(scope) } },
    available: () => true, privatePeer: target => scopeByAddress.get(conversationAddressKey(target))?.privatePeer,
    async authorizePrivateSource(_viewer, source) { return Boolean(query.allowPrivateScopes?.includes(scopeByAddress.get(conversationAddressKey(source.target))!.id)) },
    async isRecalled(target, messageId) { return scopeByAddress.get(conversationAddressKey(target))?.rows.some(row => row.messageId === messageId && row.recalled) ?? false },
    async begin() { const controller = new AbortController(); return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, release: () => controller.abort() } },
    isRunning: () => true, allowsText: () => true, now: () => data.clockAt, logger: { warn() {} }, retrieval: { mode, observe },
  })
  return { composer, redis }
}
const defaultProduction = { enabled: true, topK: 5, minScore: 0.35, timeoutMs: 1000, retentionDays: 30, maxMessagesPerConversation: 1000 }
const defaultComparison = { ...defaultProduction, topK: 10, minScore: 0, timeoutMs: 5000 }

export interface SemanticEvaluationTrial {
  queryId: string
  mode: AgentSemanticRetrievalMode
  tags: string[]
  status: 'ok' | 'error' | 'timeout'
  reason: string
  elapsedMs: number | null
  setupMs: number
  warmupMs: number
  relevant: AgentSemanticRetrievalSource[]
  forbidden: AgentSemanticRetrievalSource[]
  trace: AgentSemanticRetrievalTrace | null
  contextEmpty: boolean
  stateHashBefore: string
  stateHashAfter: string
  storageUnchanged: boolean
}
function metric(trials: SemanticEvaluationTrial[]) {
  const n = trials.length, positives = trials.filter(trial => trial.relevant.length), negatives = trials.filter(trial => !trial.relevant.length)
  const complete = (trial: SemanticEvaluationTrial) => trial.trace?.projected.filter(item => item.complete).map(item => item.source) ?? []
  const recall = (trial: SemanticEvaluationTrial, sources: readonly AgentSemanticRetrievalSource[]) => {
    if (trial.status !== 'ok') return 0
    const ids = new Set(sources.map(sourceKey))
    return trial.relevant.filter(source => ids.has(sourceKey(source))).length / trial.relevant.length
  }
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const hitAt = (k: number) => mean(positives.map(trial => Number(recall(trial, trial.trace?.selected.slice(0, k) ?? []) > 0)))
  const times = trials.flatMap(trial => trial.elapsedMs === null ? [] : [trial.elapsedMs]).sort((a, b) => a - b)
  const quantile = (q: number) => times.length ? times[Math.max(0, Math.ceil(times.length * q) - 1)]! : null
  return { samples: n, answerableSamples: positives.length, noAnswerSamples: negatives.length, latencySamples: times.length,
    hitAt1: hitAt(1), hitAt5: hitAt(5), hitAt10: hitAt(10),
    evidenceRecallAt5: mean(positives.map(trial => recall(trial, trial.trace?.selected.slice(0, 5) ?? []))),
    evidenceRecallAt10: mean(positives.map(trial => recall(trial, trial.trace?.selected.slice(0, 10) ?? []))),
    contextEvidenceRecall: mean(positives.map(trial => recall(trial, complete(trial)))),
    completeContextRate: mean(positives.map(trial => Number(recall(trial, complete(trial)) === 1))),
    noAnswerCorrectRate: mean(negatives.map(trial => Number(trial.status === 'ok' && trial.contextEmpty))),
    forbiddenSourceRate: mean(trials.map(trial => {
      const ids = new Set(trial.forbidden.map(sourceKey))
      return Number((trial.trace?.selected ?? []).some(source => ids.has(sourceKey(source))) || complete(trial).some(source => ids.has(sourceKey(source))))
    })),
    errors: trials.filter(trial => trial.status === 'error').length, timeouts: trials.filter(trial => trial.status === 'timeout').length,
    rerankApplied: trials.filter(trial => trial.trace?.rerank === 'applied').length,
    rerankFallback: trials.filter(trial => trial.trace?.rerank === 'fallback').length,
    rerankUnavailable: trials.filter(trial => trial.trace?.rerank === 'unavailable').length,
    invalidEmbeddings: trials.filter(trial => trial.trace?.embedding === 'invalid').length,
    latencyP50Ms: quantile(0.5), latencyP95Ms: quantile(0.95),
  }
}

/** Runs Core reads against immutable fixture data. Provider construction/preparation is outside query latency. */
export async function runAgentSemanticEvaluation(input: unknown, options: SemanticEvaluationOptions) {
  const data = deepFreeze(parseAgentSemanticEvaluationDataset(input))
  const modes = [...(options.modes ?? MODES)]
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !(MODES as readonly string[]).includes(mode))) throw new Error('Invalid evaluation modes')
  const cache = options.cache ?? 'isolated-client'
  if (cache !== 'isolated-client' && cache !== 'warm-client') throw new Error('Invalid evaluation cache mode')
  const profiles = { production: { ...defaultProduction, ...data.profiles.production, enabled: true }, comparison: { ...defaultComparison, ...data.profiles.comparison, enabled: true } }
  if (profiles.production.retentionDays !== profiles.comparison.retentionDays || profiles.production.maxMessagesPerConversation !== profiles.comparison.maxMessagesPerConversation) throw new Error('Production and comparison must share corpus retention and message bounds')
  const backend = await bounded(() => Promise.resolve(options.createBackend()), 15_000)
  const providerId = backend.id
  if (!/^[a-f0-9]{64}$/u.test(providerId)) { await backend.dispose?.(); throw new Error('Invalid evaluation backend identity') }
  const vectors = new Map<string, number[]>(), preparationErrors: { source: AgentSemanticRetrievalSource; reason: string }[] = []
  const prepStarted = performance.now()
  try {
    for (const scope of data.scopes) {
      const prepQuery: SemanticEvaluationQuery = { id: 'prepare', scope: scope.id, query: 'evaluation corpus authorization', relevant: [], forbidden: [] }
      let authorized: readonly AgentSemanticRetrievalSource[] | undefined
      const { composer } = createReader(data, backend, vectors, profiles.production, 'bm25', prepQuery, trace => { authorized = trace.authorized })
      try { await bounded(signal => composer.read(binding(scope), prepQuery.query, () => true, signal), profiles.production.timeoutMs + 100) }
      finally { await composer.stop() }
      if (!authorized) throw new Error('Corpus preparation authorization was not observed')
      for (const source of authorized) {
        const row = scope.rows.find(row => row.messageId === source.messageId)!
        try {
          const result = await bounded(async signal => backend.embed([row.text], contextFor(scope, signal)), 15_000)
          if (result.length !== 1) throw new Error('Prepared embedding count mismatch')
          vectors.set(sourceKey(source), normalize(result[0]))
        } catch (error) { preparationErrors.push({ source, reason: error instanceof Error ? error.message : 'embedding preparation failed' }) }
      }
    }
  } finally { await bounded(() => Promise.resolve(backend.dispose?.()), 5000) }
  const preparationMs = performance.now() - prepStarted
  const trials: SemanticEvaluationTrial[] = []
  const scopes = new Map(data.scopes.map(scope => [scope.id, scope]))
  const ref = (source: SemanticEvaluationSource): AgentSemanticRetrievalSource => ({ scopeId: agentSemanticMemoryId(scopes.get(source.scope)!), messageId: source.messageId })
  const preparedCorpusHash = frozenStorage(data, vectors, providerId).fingerprint()
  for (const mode of modes) for (const query of data.queries) {
    const scope = scopes.get(query.scope)!, config = mode === 'production' ? profiles.production : profiles.comparison
    const trial: SemanticEvaluationTrial = { queryId: query.id, mode, tags: [...(query.tags ?? [])], status: 'ok', reason: '', elapsedMs: null, setupMs: 0, warmupMs: 0,
      relevant: query.relevant.map(ref), forbidden: query.forbidden.map(ref), trace: null, contextEmpty: true,
      stateHashBefore: preparedCorpusHash, stateHashAfter: preparedCorpusHash, storageUnchanged: true }
    let currentBackend: SemanticEvaluationBackend | undefined
    let reader: ReturnType<typeof createReader> | undefined
    let started: number | undefined
    const setupStarted = performance.now()
    try {
      currentBackend = await bounded(() => Promise.resolve(options.createBackend()), 15_000)
      if (currentBackend.id !== providerId) throw new Error('Evaluation backend identity changed between trials')
      reader = createReader(data, currentBackend, vectors, config, mode, query, trace => { trial.trace = structuredClone(trace) })
      trial.stateHashBefore = reader.redis.fingerprint()
      const read = () => bounded(async signal => {
        const recall = await reader!.composer.read(binding(scope), query.query, () => true, signal, query.excludeMessageIds, query.querySource)
        if (!await recall.isCurrent()) throw new Error('Recall sources became invalid')
        return recall
      }, config.timeoutMs + 100)
      trial.setupMs = performance.now() - setupStarted
      if (cache === 'warm-client') { const warmStart = performance.now(); try { await read() } finally { trial.warmupMs = performance.now() - warmStart; trial.trace = null } }
      started = performance.now()
      const recall = await read()
      trial.elapsedMs = performance.now() - started
      trial.contextEmpty = recall.text.length === 0
      const trace = trial.trace as AgentSemanticRetrievalTrace | null
      if (!trace) throw new Error('Core read completed without an observed retrieval result')
      trial.reason = trace.reason ?? (trial.contextEmpty ? 'empty-context' : 'retrieved')
      if (mode !== 'bm25' && trace.embedding === 'invalid') throw new Error('Query embedding invalid')
      if (mode !== 'bm25' && preparationErrors.some(error => trace.authorized.some(source => sourceKey(source) === sourceKey(error.source)))) throw new Error('Authorized corpus has failed prepared embeddings')
    } catch (error) {
      if (!reader) trial.setupMs = performance.now() - setupStarted
      if (started !== undefined) trial.elapsedMs = performance.now() - started
      trial.status = (error as { code?: unknown })?.code === 'semantic_memory_timeout' ? 'timeout' : 'error'
      trial.reason = error instanceof Error ? error.message : 'evaluation trial failed'
    } finally {
      if (reader) { trial.stateHashAfter = reader.redis.fingerprint(); await reader.composer.stop() }
      trial.storageUnchanged = trial.stateHashBefore === trial.stateHashAfter
      if (!trial.storageUnchanged) { trial.status = 'error'; trial.reason = 'Evaluation storage changed' }
      try { if (currentBackend) await bounded(() => Promise.resolve(currentBackend!.dispose?.()), 5000) }
      catch { trial.status = 'error'; trial.reason = 'Backend disposal failed' }
    }
    trials.push(trial)
  }
  return { schemaVersion: 2 as const, runtime: 'core' as const, method: 'core-read-v2', generatedAt: new Date().toISOString(),
    dataset: { id: data.id, revision: data.revision, hash: digest(data), corpusHash: digest(data.scopes), queries: data.queries.length },
    backend: { id: providerId, metadata: structuredClone(options.backendMetadata) }, clockAt: data.clockAt, profiles,
    cache: { mode: cache, serverCache: 'uncontrolled', clientIsolation: 'new backend per query and mode; source preparation uses a separate backend' },
    timingScope: 'read-and-revalidate', contextScope: 'semantic-memory-read-projection', preparation: { elapsedMs: preparationMs, preparedSources: vectors.size, errors: preparationErrors, corpusHash: preparedCorpusHash },
    storageUnchanged: trials.every(trial => trial.storageUnchanged),
    metricScope: 'selected-topK-and-complete-projection',
    modes: Object.fromEntries(modes.map(mode => [mode, { effectiveTopK: mode === 'production' ? profiles.production.topK : profiles.comparison.topK,
      ...metric(trials.filter(trial => trial.mode === mode)) }])), trials,
    evidence: options.backendMetadata.kind === 'synthetic' ? 'deterministic-regression-only' : options.backendMetadata.kind === 'real-model' ? 'offline-model-retrieval; does not measure generated answer correctness' : 'unverified-backend',
  }
}

/** Hashed lexical features, deliberately not advertised as semantic-model quality. */
export function createSyntheticSemanticEvaluationBackend(): SemanticEvaluationBackend {
  const feature = (text: string) => {
    const output = Array.from({ length: 64 }, () => 0)
    const normalized = text.normalize('NFKC').toLowerCase()
    for (const token of normalized.match(/[a-z0-9]+|[\u3400-\u9fff]/gu) ?? []) {
      const hash = createHash('sha256').update(token).digest()
      output[hash[0]! % output.length]! += hash[1]! % 2 ? 1 : -1
    }
    if (!output.some(value => value !== 0)) output[0] = 1
    return output
  }
  return { id: digest('synthetic-hashed-lexical-v2'),
    async embed(texts, context) { await context.ensureCurrent(); return texts.map(feature) },
    async rerank(query, documents, context) {
      await context.ensureCurrent()
      const terms = new Set(query.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/gu) ?? [])
      return new Map(documents.map(document => [document.id, [...terms].filter(term => document.text.toLowerCase().includes(term)).length / Math.max(1, terms.size)]))
    },
  }
}
