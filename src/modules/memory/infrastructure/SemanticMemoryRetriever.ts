import type { SemanticMemoryStore, MemoryChunk, MemoryChunkSource } from './SemanticMemoryStore.js'
import type { PersonMemorySource } from '../../../contracts/personMemory.js'
import type { ArchivePort } from './SemanticMemoryIndexer.js'
import { archiveMemorySource } from './SemanticMemoryIndexer.js'
import { BM25Index, tokenizeForBM25 } from './SemanticMemoryStore.js'
import type { EmbeddingGateway } from './EmbeddingGateway.js'
import type { RerankGateway } from './RerankGateway.js'
interface Hit {chunk:MemoryChunk;score:number}
interface Fused {chunk:MemoryChunk;rrf:number;vector:number;bm25Rank:number;vectorRank:number;effectiveStrength?:number;memoryFactor?:number}
export interface RetrieveConfig { retrieveTimeoutMs?:number;topK?:number;minScore?:number;rerankTopN?:number;contextMaxChars?:number;includeGroups?:string[];excludeGroups?:string[];memoryEvolution?:{enabled?:boolean;freezeThreshold?:number;halfLifeDays?:number} }
export type PersonSearchSource = PersonMemorySource
export type MemorySourceFilter = ((source:PersonSearchSource,text:string)=>boolean|Promise<boolean>) & {refresh?():void|Promise<void>}
export interface MemorySearchOptions {topK?:number;minScore?:number;timeoutMs?:number;candidatePool?:number;rerank?:boolean;filterSource?:MemorySourceFilter;botId?:string;personaId?:string;allowLegacySourceIdentity?:boolean}
export interface PersonSearchOptions extends MemorySearchOptions {
  viewerUserId:string
  botId:string
  personaId:string
  /** Host-authorized groups for this bot/persona, never taken from model arguments. */
  allowedGroupIds:string[]
  /** Explicit host authorization to rehydrate older records without receiver metadata. */
  legacyGroupIds?:string[]
}
export interface PersonHistoryOptions extends PersonSearchOptions {
  keywords?:string[]
  startTime?:number
  endTime?:number
  offset?:number
  limit?:number
}
interface Options {store:SemanticMemoryStore;gateway:EmbeddingGateway;reranker?:RerankGateway|null;archiveManager?:ArchivePort;config?:RetrieveConfig;logger?:{warn?(message:string):void}}
// 语义记忆检索:向量(归一化余弦)+ BM25 混合召回 → RRF 融合(k=60)
// → 相邻窗口重叠去重 → 余弦阈值门控。可选 LLM 重排(评估/调试用,不进热路径)。
// 记忆演化(借鉴 A-Memorix):排序混入强度因子(近期/被反复想起的记忆上浮,
// 长期无人提起的衰减下沉),低于冻结阈值的直接不注入;被注入的分块即强化并重置衰减时钟。
import { effectiveStrength } from "./SemanticMemoryStore.js"

const RRF_K = 60
const CANDIDATE_POOL = 30

function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted)return Promise.reject(signal.reason)
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{signal.removeEventListener('abort',onAbort);reject(signal.reason)}
    signal.addEventListener('abort',onAbort,{once:true})
    work.then(value=>{signal.removeEventListener('abort',onAbort);resolve(value)},error=>{signal.removeEventListener('abort',onAbort);reject(error)})
  })
}

function validSource(value:unknown):value is MemoryChunkSource {
  if(!value||typeof value!=='object')return false
  const row=value as Record<string,unknown>
  return typeof row.user_id==='string'&&/^\d+$/.test(row.user_id)&&typeof row.message_id==='string'&&Boolean(row.message_id)
    &&typeof row.timestamp==='number'&&Number.isFinite(row.timestamp)&&row.timestamp>0&&typeof row.text==='string'&&typeof row.name==='string'
    &&(row.personal_text===undefined||typeof row.personal_text==='string')&&(row.bot_id===undefined||typeof row.bot_id==='string')
    &&(row.persona_id===undefined||typeof row.persona_id==='string')&&(row.recalled===undefined||typeof row.recalled==='boolean')
}

function filterSourceValue(groupId:string,row:MemoryChunkSource,text=row.text):PersonSearchSource {
  return {scene:{kind:'group',id:groupId},authorId:row.user_id,messageId:row.message_id,at:row.timestamp,excerpt:text}
}

function cosine(left:Float32Array|number[]|null|undefined,right:Float32Array|number[]|null|undefined) {
  if(!left||!right||left.length!==right.length)return 0
  let dot=0,a=0,b=0
  for(let i=0;i<left.length;i++){dot+=left[i]!*right[i]!;a+=left[i]!*left[i]!;b+=right[i]!*right[i]!}
  return a&&b?dot/Math.sqrt(a*b):0
}

async function readSourceRows(groupId:string,signal:AbortSignal,store?:SemanticMemoryStore,archiveManager?:ArchivePort):Promise<Map<string,MemoryChunkSource>> {
  signal.throwIfAborted()
  const rows=new Map<string,MemoryChunkSource>()
  const cutoff=store?Date.now()-store.retentionDays*86400000:0
  const redactions=store?.sourceRedactions(groupId)
  if(redactions?.invalid)return rows
  for(const chunk of store?.loadGroup(groupId).chunks.values()||[]) {
    for(const row of Array.isArray(chunk.sources)?chunk.sources:[]) {
      if(validSource(row)&&row.timestamp>=cutoff&&!redactions?.messages.has(row.message_id))rows.set(row.message_id,row)
    }
  }
  if(archiveManager) {
    const records=await abortable(archiveManager.readAllGroupMessages(groupId),signal)
    for(const record of records) {
      signal.throwIfAborted()
      if(record.group_id!==undefined&&String(record.group_id)!==groupId)continue
      const id=String(record.message_id??'')
      if(!id)continue
      rows.delete(id)
      if(record.recalled||redactions?.messages.has(id))continue
      const row=archiveMemorySource(record,value=>archiveManager.formatRecord(value,{compact:true}))
      // The archive owns its retention policy. RAG vector retention must not
      // silently shorten the original history available to a self reader.
      if(row)rows.set(id,row)
    }
  }
  return rows
}

function authorizedPersonGroups(subjectId:string,options:PersonSearchOptions,config:RetrieveConfig={}) {
  if(!options||!/^\d+$/.test(subjectId)||String(options.viewerUserId)!==subjectId||!options.botId||!options.personaId)return null
  return [...new Set((options.allowedGroupIds||[]).map(String))].filter(id=>/^[a-zA-Z0-9_-]+$/.test(id)
    &&(!config.includeGroups?.length||config.includeGroups.includes(id))&&!config.excludeGroups?.includes(id))
}

function personalSourceAllowed(row:MemoryChunkSource,subjectId:string,groupId:string,options:PersonSearchOptions) {
  return row.user_id===subjectId&&!row.recalled&&Boolean(row.personal_text)
    &&(!row.bot_id||row.bot_id===options.botId)&&(!row.persona_id||row.persona_id===options.personaId)
    &&(Boolean(row.bot_id&&row.persona_id)||Boolean(options.legacyGroupIds?.includes(groupId)))
}

/** Local, paged evidence lookup also works when embedding/RAG is disabled. */
export async function readPersonArchiveHistory(subjectId:string,query:string,options:PersonHistoryOptions,ports:{archiveManager?:ArchivePort;store?:SemanticMemoryStore;config?:RetrieveConfig;signal?:AbortSignal}={}) {
  const startedAt=Date.now()
  const empty=(reason:string)=>({items:[],totalMatches:0,hasMore:false,elapsedMs:Date.now()-startedAt,reason})
  const groups=authorizedPersonGroups(String(subjectId),options,ports.config)
  if(!groups)return empty('unauthorized person view')
  if(!ports.archiveManager&&!ports.store)return empty('archive unavailable')
  const deadline=new AbortController()
  const timer=setTimeout(()=>deadline.abort(new Error('timeout')),Math.max(200,Math.min(10000,Number(options.timeoutMs)||2500)))
  const signal=AbortSignal.any([deadline.signal,...(ports.signal?[ports.signal]:[])])
  const limit=Math.min(50,Math.max(1,Math.floor(options.limit||20))),offset=Math.max(0,Math.floor(options.offset||0))
  const terms=(options.keywords??tokenizeForBM25(query)).map(value=>value.trim().toLowerCase()).filter(Boolean).slice(0,12)
  try {
    const candidates:{source:PersonSearchSource;content:string;sender:string;score:number}[]=[]
    for(const groupId of groups) {
      const rows=await readSourceRows(groupId,signal,ports.store,ports.archiveManager)
      for(const row of rows.values()) {
        signal.throwIfAborted()
        if(!personalSourceAllowed(row,subjectId,groupId,options))continue
        if(options.startTime!==undefined&&row.timestamp<options.startTime||options.endTime!==undefined&&row.timestamp>options.endTime)continue
        const content=row.personal_text!,source=filterSourceValue(groupId,row,content)
        if(options.filterSource&&!await abortable(Promise.resolve(options.filterSource(source,content)),signal))continue
        const score=terms.reduce((sum,term)=>sum+Number(content.toLowerCase().includes(term)),0)
        if(terms.length&&!score)continue
        candidates.push({source,content,sender:row.name,score})
      }
    }
    candidates.sort((a,b)=>b.score-a.score||b.source.at-a.source.at||a.source.scene.id.localeCompare(b.source.scene.id)||a.source.messageId.localeCompare(b.source.messageId))
    if(options.filterSource?.refresh)await abortable(Promise.resolve(options.filterSource.refresh()),signal)
    const items=[]
    for(const item of candidates.slice(offset,offset+limit)) {
      if(ports.store?.isSourceForgotten(item.source.scene.id,item.source.messageId))continue
      if(options.filterSource&&!await abortable(Promise.resolve(options.filterSource(item.source,item.content)),signal))continue
      items.push(item)
    }
    const hasMore=offset+limit<candidates.length
    return {items,totalMatches:candidates.length,hasMore,...(hasMore?{nextOffset:offset+limit}:{}),elapsedMs:Date.now()-startedAt}
  } catch(error) {return empty(signal.aborted?'timeout':error instanceof Error?error.message:'archive unavailable')}
  finally {clearTimeout(timer)}
}

export function rrfFuse(vectorHits:Hit[] = [], bm25Hits:Hit[] = [], { pool = CANDIDATE_POOL } = {}) {
  const scores = new Map<string,Fused>()
  const add = (chunk:MemoryChunk, source:string, rank:number, vectorScore = 0) => {
    const entry = scores.get(chunk.id) || { chunk, rrf: 0, vector: 0, bm25Rank: 0, vectorRank: 0 }
    entry.rrf += 1 / (RRF_K + rank + 1)
    if (source === "vector") {
      entry.vector = Math.max(entry.vector, vectorScore)
      entry.vectorRank = rank + 1
    } else {
      entry.bm25Rank = rank + 1
    }
    scores.set(chunk.id, entry)
  }
  vectorHits.slice(0, pool).forEach((hit, rank) => add(hit.chunk, "vector", rank, hit.score))
  bm25Hits.slice(0, pool).forEach((hit, rank) => add(hit.chunk, "bm25", rank))
  return [...scores.values()].sort((a, b) => b.rrf - a.rrf)
}

function messageIdOverlap(a:string[] = [], b:string[] = []) {
  if (!a.length || !b.length) return 0
  const set = new Set(a.map(String))
  const shared = b.filter(id => set.has(String(id)))
  return shared.length / Math.min(a.length, b.length)
}

export class SemanticMemoryRetriever {
 private lifecycle=new AbortController()
 dispose(){this.lifecycle.abort()}
 store:SemanticMemoryStore;gateway:EmbeddingGateway;reranker:RerankGateway|null;archiveManager:ArchivePort|undefined;config:RetrieveConfig;logger:Options["logger"];stats:{queries:number;hits:number;timeouts:number;failures:number;rerankQueries:number;rerankApplied:number}
  constructor({ store, gateway, reranker = null, archiveManager, config = {}, logger }:Options) {
    this.store = store
    this.gateway = gateway
    this.reranker = reranker
    this.archiveManager = archiveManager
    this.config = config
    this.logger = logger
    this.stats = { queries: 0, hits: 0, timeouts: 0, failures: 0, rerankQueries: 0, rerankApplied: 0 }
  }

  private async sourceRows(groupId:string,signal:AbortSignal):Promise<Map<string,MemoryChunkSource>> {
    return readSourceRows(groupId,signal,this.store,this.archiveManager)
  }

  async readPersonHistory(subjectId:string,query:string,options:PersonHistoryOptions) {
    return readPersonArchiveHistory(subjectId,query,options,{store:this.store,...(this.archiveManager?{archiveManager:this.archiveManager}:{}),config:this.config,signal:this.lifecycle.signal})
  }

  private async permittedChunks(groupId:string,rows:Map<string,MemoryChunkSource>,filter:MemorySourceFilter,only?:Set<string>,signal=this.lifecycle.signal) {
    const allowed=new Set<string>()
    const checks=new Map<string,Promise<boolean>>()
    for(const chunk of this.store.loadGroup(groupId).chunks.values()) {
      if(only&&!only.has(chunk.id))continue
      if(!chunk.message_ids?.length)continue
      let permitted=true
      for(const id of chunk.message_ids) {
        const row=rows.get(id)
        if(!row||row.recalled){permitted=false;break}
        let result=checks.get(id)
        if(!result){result=Promise.resolve(filter(filterSourceValue(groupId,row),row.text));checks.set(id,result)}
        if(!await abortable(result,signal)){permitted=false;break}
      }
      if(permitted)allowed.add(chunk.id)
    }
    return allowed
  }

  /** Private self-recall. Mixed group windows never enter its embedding/rerank input. */
  async searchPerson(subjectId:string,query:string,options:PersonSearchOptions) {
    const startedAt=Date.now()
    const empty=(reason:string)=>({items:[],elapsedMs:Date.now()-startedAt,reason})
    const subject=String(subjectId||'')
    if(!options||!/^\d+$/.test(subject)||String(options.viewerUserId)!==subject||!options.botId||!options.personaId)return empty('unauthorized person view')
    if(this.lifecycle.signal.aborted)return empty('disposed')
    const text=String(query||'').trim()
    if(!text)return empty('empty query')
    const groups=authorizedPersonGroups(subject,options,this.config)!
    if(!groups.length)return empty('no authorized groups')
    const budget=Math.max(200,Math.min(10000,Number(options.timeoutMs||this.config.retrieveTimeoutMs)||900))
    const deadline=new AbortController()
    const timer=setTimeout(()=>deadline.abort(new Error('timeout')),budget)
    const signal=AbortSignal.any([this.lifecycle.signal,deadline.signal])
    const k=Math.min(20,Math.max(1,Number(options.topK||this.config.topK)||5))
    const pool=Math.min(60,Math.max(k,Number(options.candidatePool)||CANDIDATE_POOL))
    try {
      const documents=new Map<string,{chunk:MemoryChunk;source:PersonSearchSource}>()
      const lexical=new BM25Index()
      for(const groupId of groups) {
        const rows=await this.sourceRows(groupId,signal)
        for(const row of rows.values()) {
          signal.throwIfAborted()
          if(!personalSourceAllowed(row,subject,groupId,options))continue
          const source=filterSourceValue(groupId,row,row.personal_text!)
          if(options.filterSource&&!await abortable(Promise.resolve(options.filterSource(source,row.personal_text!)),signal))continue
          const id=`${groupId}:${row.message_id}:person:${subject}`
          const chunk:MemoryChunk={id,group_id:groupId,source_group_id:groupId,message_ids:[row.message_id],user_ids:[subject],
            source_bot_ids:[options.botId],start_ts:row.timestamp,end_ts:row.timestamp,
            text:`${row.name}（本人发言）：${row.personal_text}`,
            sources:[{...row,text:row.personal_text!}],person_projection:true}
          documents.set(id,{chunk,source})
          lexical.add(id,tokenizeForBM25(row.personal_text!))
        }
      }
      signal.throwIfAborted()
      if(!documents.size)return empty('no attributable self history')
      // Rank only the projected self statements. The lexical index covers all
      // retained authorized history; network candidates have a strict budget.
      const lexicalHits=lexical.search(tokenizeForBM25(text),pool)
      const latest=[...documents.values()].sort((a,b)=>b.chunk.end_ts-a.chunk.end_ts).slice(0,pool)
      const candidateIds=[...new Set([...lexicalHits.map(hit=>hit.id),...latest.map(item=>item.chunk.id)])].slice(0,pool)
      let candidates=candidateIds.map(id=>documents.get(id)!)
      if(options.filterSource) {
        if(options.filterSource.refresh)await abortable(Promise.resolve(options.filterSource.refresh()),signal)
        const permitted=[]
        for(const item of candidates)if(await abortable(Promise.resolve(options.filterSource(item.source,item.source.excerpt)),signal))permitted.push(item)
        candidates=permitted
      }
      const permittedIds=new Set(candidates.map(item=>item.chunk.id))
      let queryVector:Float32Array|number[]|null=null
      let vectors:(Float32Array|number[]|null)[]=[]
      const networkBudget=Math.max(0,budget-(Date.now()-startedAt)-40)
      if(networkBudget>0) {
        const embeddingDeadline=new AbortController()
        const embeddingTimer=setTimeout(()=>embeddingDeadline.abort(new Error('embedding timeout')),Math.min(networkBudget,Math.max(100,Math.floor(budget*0.6))))
        const embeddingSignal=AbortSignal.any([signal,embeddingDeadline.signal])
        try {
          const values=await abortable(Promise.all([
            this.gateway.embed(text,{signal:embeddingSignal}),
            this.gateway.embedBatch(candidates.map(item=>item.chunk.text),{signal:embeddingSignal})
          ]),embeddingSignal)
          queryVector=values[0];vectors=values[1]
        } catch { signal.throwIfAborted() } finally {clearTimeout(embeddingTimer)}
      }
      const bm25Hits=lexicalHits.filter(hit=>permittedIds.has(hit.id)).map(hit=>({chunk:documents.get(hit.id)!.chunk,score:hit.score}))
      const vectorHits=candidates.map((item,index)=>({chunk:item.chunk,score:cosine(queryVector,vectors[index])})).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score)
      const threshold=Number(options.minScore??this.config.minScore??0.35)
      let fused=rrfFuse(vectorHits,bm25Hits,{pool}).filter(entry=>entry.vector>=threshold||entry.bm25Rank>0)
      let rerankScores:Map<string,number>|null=null
      if(options.rerank&&this.reranker&&fused.length>1) {
        this.stats.rerankQueries++
        rerankScores=await abortable(this.reranker.rerank(text,fused.slice(0,pool).map(item=>item.chunk),{signal}),signal)
        if(rerankScores){this.stats.rerankApplied++;fused=fused.sort((a,b)=>(rerankScores!.get(b.chunk.id)??-1)-(rerankScores!.get(a.chunk.id)??-1))}
      }
      const visible=[]
      if(options.filterSource?.refresh)await abortable(Promise.resolve(options.filterSource.refresh()),signal)
      for(const entry of fused) {
        signal.throwIfAborted()
        const item=documents.get(entry.chunk.id)!
        if(this.store.isSourceForgotten(item.source.scene.id,item.source.messageId))continue
        if(options.filterSource&&!await abortable(Promise.resolve(options.filterSource(item.source,item.source.excerpt)),signal))continue
        visible.push({chunk:entry.chunk,rrfScore:entry.rrf,vectorScore:entry.vector,vectorRank:entry.vectorRank,bm25Rank:entry.bm25Rank,
          effectiveStrength:null,memoryFactor:null,recallCount:0,rerankScore:rerankScores?.get(entry.chunk.id)??null})
        if(visible.length>=k)break
      }
      this.stats.queries++;if(visible.length)this.stats.hits++
      return {items:visible,elapsedMs:Date.now()-startedAt,reranked:Boolean(rerankScores),candidates:documents.size,personal:true}
    } catch(error) {
      if(deadline.signal.aborted){this.stats.timeouts++;return empty('timeout')}
      if(this.lifecycle.signal.aborted)return empty('disposed')
      this.stats.failures++
      this.logger?.warn?.('[SemanticMemory] 本人历史检索失败，未提供跨群片段')
      return empty(error instanceof Error?error.message:'person recall failed')
    } finally {clearTimeout(timer)}
  }

  async search(groupId:string, query:string, { topK, minScore, timeoutMs, candidatePool, rerank = false, filterSource, botId, personaId, allowLegacySourceIdentity = false }:MemorySearchOptions = {}) {
    const startedAt = Date.now()
    const budget = Math.max(200, Number(timeoutMs || this.config.retrieveTimeoutMs) || 900)
    const k = Math.max(1, Number(topK || this.config.topK) || 5)
    const threshold = Number(minScore ?? this.config.minScore ?? 0.35)
    const pool = candidatePool || CANDIDATE_POOL
    const text = String(query || "").trim()
    if(this.lifecycle.signal.aborted)return {items:[],elapsedMs:0,reason:'disposed'}
    if (!text) return { items: [], elapsedMs: 0, reason: "empty query" }
    const deadline=new AbortController()
    const deadlineTimer=setTimeout(()=>deadline.abort(new Error('timeout')),budget)
    const requestSignal=AbortSignal.any([this.lifecycle.signal,deadline.signal])
    try {
      // The whole chunk must be attributable and allowed before any ranking or
      // reranking. A deleted line cannot survive through its surrounding window.
      const identityFilter:MemorySourceFilter|undefined=botId||personaId?async(source,text)=>{
        const row=sourceRows?.get(source.messageId)
        if(!botId||!personaId||!row||row.bot_id&&row.bot_id!==botId||row.persona_id&&row.persona_id!==personaId)return false
        if((!row.bot_id||!row.persona_id)&&!allowLegacySourceIdentity)return false
        return filterSource?filterSource(source,text):true
      }:filterSource
      if(identityFilter&&identityFilter!==filterSource&&filterSource?.refresh)identityFilter.refresh=()=>filterSource.refresh!()
      const sourceRows=identityFilter?await this.sourceRows(String(groupId),requestSignal):null
      const permitted=identityFilter&&sourceRows?await this.permittedChunks(groupId,sourceRows,identityFilter,undefined,requestSignal):null
      if (Date.now()-startedAt>=budget) return {items:[],elapsedMs:Date.now()-startedAt,reason:'timeout'}
      const accept=permitted?(chunk:MemoryChunk)=>permitted.has(chunk.id):undefined
      const queryVector = await abortable(this.gateway.embed(text,{signal:requestSignal}),requestSignal)
      if(this.lifecycle.signal.aborted)return {items:[],elapsedMs:Date.now()-startedAt,reason:'disposed'}
      if (Date.now() - startedAt > budget) {
        this.stats.timeouts++
        return { items: [], elapsedMs: Date.now() - startedAt, reason: "timeout" }
      }
      const vectorStart = Date.now()
      const vectorHits = queryVector ? this.store.searchVector(groupId, queryVector, pool,accept) : []
      const vectorMs = Date.now() - vectorStart
      const bm25Start = Date.now()
      const bm25Hits = this.store.searchBM25(groupId, text, pool,accept)
      const bm25Ms = Date.now() - bm25Start

      const fused = rrfFuse(vectorHits, bm25Hits)
      // 阈值门控:向量分数是唯一可比的绝对量;纯 BM25 命中需排前 3 才保留(关键词强信号)
      const gated = fused.filter(entry => entry.vector >= threshold || (entry.bm25Rank >= 1 && entry.bm25Rank <= 3))

      // 记忆演化:强度因子混入排序(0.5~1.0,不翻转相似度主序,只做近期/强化加权),
      // 低于冻结阈值的视为"已淡忘",不再注入
      const evolution = this.config.memoryEvolution || {}
      const evolutionOn = evolution.enabled !== false && Number(evolution.freezeThreshold) > 0
      let ranked = gated
      if (evolutionOn) {
        const now = Date.now()
        const halfLifeDays = Number(evolution.halfLifeDays) || 7
        const freezeThreshold = Number(evolution.freezeThreshold) || 0.06
        ranked = []
        for (const entry of gated) {
          entry.effectiveStrength = effectiveStrength(entry.chunk, now, halfLifeDays)
          if (entry.effectiveStrength < freezeThreshold) continue
          entry.memoryFactor = 0.5 + 0.5 * entry.effectiveStrength
          ranked.push(entry)
        }
        ranked.sort((a, b) => (b.rrf * (b.memoryFactor ?? 1)) - (a.rrf * (a.memoryFactor ?? 1)))
      }

      // 可选重排:对门控后的候选池取前 rerankTopN 交给交叉编码器,失败/超时回落 RRF 顺序
      let candidates = ranked
      let rerankScores:Map<string,number>|null = null
      let rerankMs = 0
      if (rerank && this.reranker && ranked.length > 1) {
        this.stats.rerankQueries++
        const rerankTopN = Math.max(k, Number(this.config.rerankTopN) || 20)
        candidates = ranked.slice(0, rerankTopN)
        if(identityFilter&&sourceRows) {
          if(identityFilter.refresh)await abortable(Promise.resolve(identityFilter.refresh()),requestSignal)
          const permittedNow=await this.permittedChunks(groupId,sourceRows,identityFilter,new Set(candidates.map(entry=>entry.chunk.id)),requestSignal)
          candidates=candidates.filter(entry=>permittedNow.has(entry.chunk.id))
        }
        rerankMs = Date.now()
        rerankScores = await abortable(this.reranker.rerank(text, candidates.map(entry => entry.chunk),{signal:requestSignal}),requestSignal)
        if(this.lifecycle.signal.aborted)return {items:[],elapsedMs:Date.now()-startedAt,reason:'disposed'}
        rerankMs = Date.now() - rerankMs
        if (rerankScores) {
          this.stats.rerankApplied++
          candidates = [...candidates].sort((a, b) =>
            (rerankScores!.get(String(b.chunk.id)) ?? -1) - (rerankScores!.get(String(a.chunk.id)) ?? -1))
        }
      }

      // 相邻窗口去重:与已保留分块消息重叠 >50% 的丢弃
      const kept:Fused[] = []
      for (const entry of candidates) {
        const overlaps = kept.some(item => messageIdOverlap(item.chunk.message_ids, entry.chunk.message_ids) > 0.5)
        if (!overlaps) kept.push(entry)
        if (kept.length >= k) break
      }
      if(identityFilter&&sourceRows) {
        if(identityFilter.refresh)await abortable(Promise.resolve(identityFilter.refresh()),requestSignal)
        // Recheck at use time; an in-flight request must observe a fresh deletion.
        const stillPermitted=await this.permittedChunks(groupId,sourceRows,identityFilter,new Set(kept.map(entry=>entry.chunk.id)),requestSignal)
        for(let index=kept.length-1;index>=0;index--)if(!stillPermitted.has(kept[index]!.chunk.id))kept.splice(index,1)
      }
      if(typeof this.store.isChunkForgotten==='function') {
        for(let index=kept.length-1;index>=0;index--)if(this.store.isChunkForgotten(groupId,kept[index]!.chunk))kept.splice(index,1)
      }
      this.stats.queries++
      if (kept.length) this.stats.hits++
      // 召回即强化:被注入的分块重置衰减时钟(内存生效,批量落盘在 store 侧)
      if (evolutionOn && kept.length) {
        try {
          this.store.reinforceChunks(groupId, kept.map(entry => entry.chunk.id))
        } catch {}
      }
      return {
        items: kept.map(entry => ({
          chunk: entry.chunk,
          rrfScore: entry.rrf,
          vectorScore: entry.vector,
          vectorRank: entry.vectorRank,
          bm25Rank: entry.bm25Rank,
          effectiveStrength: entry.effectiveStrength ?? null,
          memoryFactor: entry.memoryFactor ?? null,
          recallCount: Number(entry.chunk.recallCount) || 0,
          rerankScore: rerankScores ? (rerankScores.get(String(entry.chunk.id)) ?? null) : null
        })),
        elapsedMs: Date.now() - startedAt,
        vectorMs,
        bm25Ms,
        rerankMs,
        reranked: Boolean(rerankScores),
        candidates: fused.length
      }
    } catch (error) {
      if(deadline.signal.aborted){this.stats.timeouts++;return {items:[],elapsedMs:Date.now()-startedAt,reason:'timeout'}}
      if(this.lifecycle.signal.aborted)return {items:[],elapsedMs:Date.now()-startedAt,reason:'disposed'}
      this.stats.failures++
      this.logger?.warn?.(`[SemanticMemory] 检索失败 group=${groupId}: ${error instanceof Error ? error.message : String(error)}`)
      return { items: [], elapsedMs: Date.now() - startedAt, reason: error instanceof Error ? error.message : String(error) }
    } finally {clearTimeout(deadlineTimer)}
  }

  formatClock(ts:unknown) {
    const date = new Date(Number(ts) || 0)
    if (Number.isNaN(date.getTime())) return "??:??"
    const pad = (n:number) => String(n).padStart(2, "0")
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  // 注入主模型上下文的文本块
  renderContext(result:{items:{chunk:MemoryChunk}[]}, { maxChars }:{maxChars?:number} = {}) {
    if (!result?.items?.length) return ""
    const limit = Math.max(200, Number(maxChars || this.config.contextMaxChars) || 900)
    const lines = []
    for (const item of result.items) {
      const head = item.chunk.person_projection
        ? `[群 ${item.chunk.group_id}；${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(item.chunk.end_ts))}；本人原始发言，转述仍按转述理解]`
        : `[${this.formatClock(item.chunk.start_ts)}~${this.formatClock(item.chunk.end_ts)}]`
      lines.push(`${head} ${item.chunk.text}`)
    }
    const joined = lines.join("\n")
    return joined.length > limit ? joined.slice(0, limit) : joined
  }
}
