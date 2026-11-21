import type { AgentSemanticMemoryRow } from './agentSemanticMemoryStore.js'
import { BM25Index, tokenizeForBM25 } from './SemanticMemoryStore.js'
import { rrfFuse } from './SemanticMemoryRetriever.js'

/** Internal experiment controls. They are never model arguments or host configuration. */
export type AgentSemanticRetrievalMode = 'production' | 'vector' | 'bm25' | 'hybrid' | 'hybrid-rerank'

export interface AgentSemanticRetrievalSource {
  readonly scopeId: string
  readonly messageId: string
}

/** Source identities describe the actual read, including its final character budget. */
export interface AgentSemanticRetrievalTrace {
  readonly mode: AgentSemanticRetrievalMode
  readonly authorized: readonly AgentSemanticRetrievalSource[]
  readonly ranked: readonly AgentSemanticRetrievalSource[]
  readonly selected: readonly AgentSemanticRetrievalSource[]
  readonly projected: readonly { readonly source: AgentSemanticRetrievalSource; readonly complete: boolean }[]
  readonly remoteQuery: boolean
  readonly embedding: 'applied' | 'local-only' | 'invalid' | 'not-used'
  readonly rerank: 'disabled' | 'unavailable' | 'not-needed' | 'applied' | 'fallback'
  readonly reason?: 'no-authorized-evidence' | 'query-source-rejected' | 'no-match'
}

export interface AgentSemanticRetrievalOptions {
  readonly mode?: AgentSemanticRetrievalMode
  observe?(trace: AgentSemanticRetrievalTrace): void
}

export interface AgentSemanticRankedHit {
  chunk: { id: string; text: string; end_ts: number }
  rrf: number
  vector: number
  bm25Rank: number
  vectorRank: number
}

export class AgentSemanticMemoryTimeoutError extends Error {
  readonly code = 'semantic_memory_timeout'
  constructor(readonly phase?: 'authorization' | 'embedding' | 'rerank' | 'source_check') {
    super('语义记忆操作超时')
    this.name = 'AgentSemanticMemoryTimeoutError'
  }
}

/** Prepare keyword scores once so the local fallback and hybrid ranking share the same evidence. */
export function prepareAgentSemanticRanking(
  evidence: readonly { readonly id: string; readonly row: AgentSemanticMemoryRow }[],
  query: string,
  providerId: string,
  threshold: number,
  mode: AgentSemanticRetrievalMode,
): (queryVector?: readonly number[]) => AgentSemanticRankedHit[] {
  const chunks = new Map(evidence.map(item => [item.id, { id: item.id, text: item.row.text, end_ts: item.row.at }]))
  const bm25 = new BM25Index()
  if (mode !== 'vector') for (const item of evidence) bm25.add(item.id, tokenizeForBM25(item.row.text))
  const bm25Hits = mode === 'vector' ? [] : bm25.search(tokenizeForBM25(query), 30)
    .map(hit => ({ chunk: chunks.get(hit.id)!, score: hit.score }))
  return (queryVector?: readonly number[]): AgentSemanticRankedHit[] => {
    const vectorHits = mode !== 'bm25' && queryVector ? evidence.filter(({ row }) =>
      row.providerId === providerId && row.vector?.length === queryVector.length)
      .map(item => ({ chunk: chunks.get(item.id)!, score: item.row.vector!.reduce((sum, value, position) => sum + value * queryVector[position]!, 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 30) : []
    if (mode === 'vector') return rrfFuse(vectorHits.filter(hit => hit.score >= threshold), []).slice(0, 20)
    const hits = rrfFuse(vectorHits, bm25Hits)
    return (mode === 'bm25' ? hits : hits.filter(hit => hit.vector >= threshold ||
      hit.bm25Rank >= 1 && hit.bm25Rank <= 3)).slice(0, 20)
  }
}

export function rankAgentSemanticEvidence(
  evidence: Parameters<typeof prepareAgentSemanticRanking>[0],
  query: string,
  queryVector: readonly number[] | undefined,
  providerId: string,
  threshold: number,
  mode: AgentSemanticRetrievalMode,
): AgentSemanticRankedHit[] {
  return prepareAgentSemanticRanking(evidence, query, providerId, threshold, mode)(queryVector)
}
