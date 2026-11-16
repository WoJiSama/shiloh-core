import type { SemanticMemoryStore, MemoryChunk, MemoryChunkSource } from './SemanticMemoryStore.js'
import type { EmbeddingGateway } from './EmbeddingGateway.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
export interface ArchiveRecord {archive_kind?:string;sender?:{user_id?:unknown;card?:string;nickname?:string};user_id?:unknown;timestamp?:number;message_id?:unknown;group_id?:unknown;[key:string]:unknown}
export interface ArchivePort {formatRecord(record:ArchiveRecord,options:{compact:boolean}):string;readAllGroupMessages(groupId:string):Promise<ArchiveRecord[]>;readRecentGroupMessages(groupId:string,count:number):Promise<ArchiveRecord[]>;listArchiveGroupIds():Promise<string[]>;addWriteListener?(callback:(record:ArchiveRecord)=>void):()=>void}
export interface IndexConfig {windowSize?:number;stride?:number;includeGroups?:string[];excludeGroups?:string[];botIds?:string[];indexOnWrite?:boolean}
interface Options {store:SemanticMemoryStore;gateway:EmbeddingGateway;archiveManager:ArchivePort;config?:IndexConfig;logger?:{info?(message:string):void;warn?(message:string):void}}
interface Line {userId:string;name:string;text:string;timestamp:number;messageId:string;source?:MemoryChunkSource}
// 语义记忆索引器:把聊天归档切成带说话人的滑动窗口分块并建立向量索引。
// 全量回填(重建命令)+ 增量尾部重切(归档写入钩子触发,防抖合并),
// 分块 id = 群:最后一条消息id,天然幂等,重放不产生重复。
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"

const DEFAULT_CHUNK_TEXT_LIMIT = 1600
const FLUSH_DEBOUNCE_MS = 30000

function object(value:unknown):Record<string,unknown> {return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}

/** Never use rendered forward context as the sender's own historical statement. */
export function archivePersonalText(record:ArchiveRecord):string {
  if (record.recalled || ['forward','quote','send','bot','assistant','system','tool'].includes(String(record.source || ''))) return ''
  if (Array.isArray(record.message) && record.message.length) {
    if (record.message.some(value=>['forward','forward_context','node'].includes(String(object(value).type)))) return ''
    return safeTruncateUnicode(record.message.filter(value=>object(value).type==='text').map(value=>{
      const segment=object(value)
      return String(segment.text ?? object(segment.data).text ?? '')
    }).join('').trim(),400)
  }
  const raw=String(record.raw_message || '')
  if (/\[CQ:(?:forward|node|json|xml)(?:,|\])/.test(raw)) return ''
  return safeTruncateUnicode(raw.replace(/\[CQ:[^\]]*\]/g,'').trim(),400)
}

export function archiveMemorySource(record:ArchiveRecord,format:(record:ArchiveRecord)=>string):MemoryChunkSource|null {
  if (!record || record.archive_kind==='notice') return null
  const userId=String(record.sender?.user_id || record.user_id || '')
  const messageId=String(record.message_id ?? '')
  const timestamp=Number(record.timestamp)
  if (!/^\d+$/.test(userId) || !messageId || !Number.isFinite(timestamp) || timestamp<=0) return null
  const botId=String(record.source_bot_id || record.self_id || '')
  const personaId=String(record.source_persona_id || '')
  const personalText=archivePersonalText(record)
  return {
    user_id:userId,message_id:messageId,timestamp,
    name:safeTruncateUnicode(String(record.sender?.card || record.sender?.nickname || userId),24),
    text:safeTruncateUnicode(format(record),400),
    ...(personalText?{personal_text:personalText}:{}),
    ...(botId?{bot_id:botId}:{}),...(personaId?{persona_id:personaId}:{}),
    ...(record.recalled?{recalled:true}:{})
  }
}

export class SemanticMemoryIndexer {
 private disposed=false
 private lifecycle=new AbortController()
 private groupWork=new Map<string,Promise<unknown>>()
 store:SemanticMemoryStore;gateway:EmbeddingGateway;archiveManager:ArchivePort;config:IndexConfig;logger:Options["logger"];dirtyGroups:Set<string>;flushTimer:ReturnType<typeof setTimeout>|null;flushing:boolean;stats:{backfilledGroups:number;chunksIndexed:number;embedTexts:number;flushes:number}
  constructor({ store, gateway, archiveManager, config = {}, logger }:Options) {
    this.store = store
    this.gateway = gateway
    this.archiveManager = archiveManager
    this.config = config
    this.logger = logger
    this.dirtyGroups = new Set()
    this.flushTimer = null
    this.flushing = false
    this.stats = { backfilledGroups: 0, chunksIndexed: 0, embedTexts: 0, flushes: 0 }
  }

  get windowSize() {
    return Math.max(2, Number(this.config.windowSize) || 8)
  }

  get stride() {
    return Math.max(1, Number(this.config.stride) || 4)
  }

  dispose() {
    this.disposed=true
    this.lifecycle.abort()
    if(this.flushTimer)clearTimeout(this.flushTimer)
    this.flushTimer=null
    this.dirtyGroups.clear()
  }

  async start() {
    const groups=await this.archiveManager.listArchiveGroupIds()
    if(this.disposed||this.config.indexOnWrite===false)return
    for(const group of groups)if(this.groupAllowed(group))this.dirtyGroups.add(group)
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if(this.disposed||this.flushTimer||!this.dirtyGroups.size)return
    this.flushTimer=setTimeout(()=>{
      this.flushTimer=null
      void this.flushDirtyGroups().catch(error=>this.logger?.warn?.(`[SemanticMemory] 增量索引失败: ${String(error)}`))
    },FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  private progressFile(groupId:string) {
    return path.join(this.store.baseDir,'index-progress',`${encodeURIComponent(groupId)}.json`)
  }

  private progressRevision(){
    return JSON.stringify(['message-provenance-v3',this.gateway.model,this.gateway.providerKey||'',this.windowSize,this.stride,this.config.botIds||[]])
  }

  private async readProgress(groupId:string):Promise<Set<string>> {
    try {
      const parsed:unknown=JSON.parse(await fs.readFile(this.progressFile(groupId),'utf8'))
      if(!parsed||typeof parsed!=='object'||!('processed'in parsed)||!Array.isArray(parsed.processed)||!('revision'in parsed)||parsed.revision!==this.progressRevision())return new Set()
      return new Set(parsed.processed.filter((id):id is string=>typeof id==='string'))
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')this.logger?.warn?.(`[SemanticMemory] 索引进度不可读，按归档幂等恢复 group=${groupId}`)
      return new Set()
    }
  }

  private async saveProgress(groupId:string,ids:string[]) {
    if(this.disposed)return
    const file=this.progressFile(groupId),temporary=`${file}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(file),{recursive:true})
    try {
      if(this.disposed)return
      await fs.writeFile(temporary,JSON.stringify({version:1,revision:this.progressRevision(),processed:ids}),'utf8')
      if(!this.disposed)await fs.rename(temporary,file)
    } finally {await fs.rm(temporary,{force:true})}
  }

  groupAllowed(groupId:string) {
    const id = String(groupId || "")
    if (!id) return false
    const include = this.config.includeGroups || []
    const exclude = this.config.excludeGroups || []
    if (include.length && !include.includes(id)) return false
    return !exclude.includes(id)
  }

  recordToLine(record:ArchiveRecord, nameResolver:((userId:string)=>string)|null = null) {
    if (!record || record.archive_kind === "notice" || record.recalled) return null
    const userId = String(record.sender?.user_id || record.user_id || "")
    if (this.config.botIds?.includes(userId)) return null
    const text = this.archiveManager.formatRecord(record, { compact: true })
    if (!text || text.length < 2) return null
    const name = nameResolver?.(userId) || record.sender?.card || record.sender?.nickname || userId
    const messageId=String(record.message_id??'')||`anonymous-${createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0,24)}`
    const source=archiveMemorySource(record,value=>this.archiveManager.formatRecord(value,{compact:true}))
    return { userId, name: String(name).slice(0, 24), text: safeTruncateUnicode(text, 400), timestamp: Number(record.timestamp || 0), messageId,...(source?{source}:{}) }
  }

  // 滑动窗口分块:窗口 windowSize、步长 stride,尾窗兜底保证最后几条消息总被覆盖。
  buildChunks(groupId:string, lines:(Line|null)[] = []) {
    const usable = lines.filter((line):line is Line=>Boolean(line))
    if (!usable.length) return []
    const chunks = []
    const windowSize = Math.min(this.windowSize, usable.length)
    const stride = Math.min(this.stride, windowSize)
    for (let start = 0; start + windowSize <= usable.length; start += stride) {
      const slice = usable.slice(start, start + windowSize)
      chunks.push(...this.buildWindowChunks(groupId, slice))
    }
    const lastStart = usable.length - windowSize
    if (lastStart < 0) {
      chunks.push(...this.buildWindowChunks(groupId, usable))
    } else if (lastStart % stride !== 0) {
      chunks.push(...this.buildWindowChunks(groupId, usable.slice(lastStart)))
    }
    const unique = new Map<string,MemoryChunk>()
    for(const chunk of chunks){
      const prior=unique.get(chunk.id)
      // Windows sharing an ending message have nested contiguous prefixes.
      // Keep the wider one so deduplication cannot remove unique coverage.
      if(!prior||(chunk.message_ids?.length||0)>(prior.message_ids?.length||0))unique.set(chunk.id,chunk)
    }
    return [...unique.values()]
  }

  private buildWindowChunks(groupId:string,lines:Line[]) {
    const chunks:MemoryChunk[]=[]
    let slice:Line[]=[],length=0
    for(const original of lines){
      const line={...original,name:safeTruncateUnicode(original.name,24),text:safeTruncateUnicode(original.text,400)}
      const lineLength=`${line.name}: ${line.text}`.length
      if(slice.length&&length+1+lineLength>DEFAULT_CHUNK_TEXT_LIMIT){
        chunks.push(this.buildChunk(groupId,slice));slice=[];length=0
      }
      length+=(slice.length?1:0)+lineLength
      slice.push(line)
    }
    if(slice.length)chunks.push(this.buildChunk(groupId,slice))
    return chunks
  }

  private buildChunk(groupId:string, slice:Line[]):MemoryChunk {
    const last = slice[slice.length - 1]!
    const text = slice.map(line => `${line.name}: ${line.text}`).join("\n")
    return {
      id: `${groupId}:${last.messageId}`,
      group_id: String(groupId),
      start_ts: slice[0]!.timestamp,
      end_ts: last.timestamp,
      message_ids: slice.map(line => line.messageId).filter(Boolean),
      user_ids: [...new Set(slice.map(line => line.userId).filter(Boolean))],
      sources: slice.flatMap(line=>line.source?[line.source]:[]),
      source_bot_ids: [...new Set(slice.flatMap(line=>line.source?.bot_id?[line.source.bot_id]:[]))],
      speakers: [...new Set(slice.map(line => line.name))].slice(0, 8),
      text,
      model: this.gateway.model
    }
  }

  async embedAndStore(groupId:string, drafts:MemoryChunk[] = []) {
    if (this.disposed||!drafts.length) return 0
    const state = this.store.loadGroup(groupId)
    const fresh = drafts.filter(draft => {if(this.store.isChunkForgotten(groupId,draft))return false;const prior=state.chunks.get(draft.id);return !prior||prior.text!==draft.text||prior.model!==draft.model||JSON.stringify(prior.message_ids)!==JSON.stringify(draft.message_ids)||JSON.stringify(prior.sources)!==JSON.stringify(draft.sources)})
    if (!fresh.length) return 0
    const vectors = await this.gateway.embedBatch(fresh.map(draft => draft.text),{signal:this.lifecycle.signal})
    if(this.disposed)return 0
    this.stats.embedTexts += fresh.length
    const firstVector = vectors.find(vector => vector)
    if (firstVector && firstVector.length !== this.store.dimension) {
      const previousDimension = this.store.dimension
      this.store.setDimension(firstVector.length)
      this.logger?.info?.(`[SemanticMemory] 向量维度自适应 ${firstVector.length}(原 ${previousDimension})`)
    }
    const ready = fresh
      .map((draft, index) => ({ ...draft, vector: vectors[index] }))
      .filter((chunk):chunk is MemoryChunk & {vector:Float32Array} => chunk.vector instanceof Float32Array)
    if (ready.length!==fresh.length)throw new Error('embedding 未完整返回，保留索引进度供重试')
    const appended = await this.store.appendChunks(groupId, ready,{signal:this.lifecycle.signal})
    if(!this.disposed&&appended!==ready.length)throw new Error('embedding 分块未完整写入，保留索引进度供重试')
    this.stats.chunksIndexed += appended
    return appended
  }

  async backfillGroup(groupId:string) {
    return this.processGroup(groupId,true)
  }

  private async processGroup(groupId:string,full=false) {
    const previous=this.groupWork.get(groupId)
    const work=(async()=>{
      await previous?.catch(()=>{})
      if(this.disposed||!this.groupAllowed(groupId))return {group:String(groupId),skipped:'group not allowed',chunks:0}
      // readRecentGroupMessages already scans the retained archive. Consume its
      // complete snapshot and persist message identities, not a timestamp-only
      // high-water mark: equal timestamps and late/replayed records are valid.
      const records=await this.archiveManager.readAllGroupMessages(groupId)
      const cutoff=Date.now()-this.store.retentionDays*24*3600*1000
      const lines=records.map(record=>this.recordToLine(record)).filter((line):line is Line=>Boolean(line)&&line!.timestamp>=cutoff)
      const processed=full?new Set<string>():await this.readProgress(groupId)
      if(this.disposed)return {group:groupId,skipped:'disposed',chunks:0}
      const drafts=this.buildChunks(groupId,lines).filter(draft=>full||draft.message_ids?.some(id=>!processed.has(id)))
      const retainedIds=new Set(lines.map(line=>line.messageId))
      const completed=new Set([...processed].filter(id=>retainedIds.has(id)))
      // Bound both gateway input and stored vectors. Commit covered identities
      // after each successful batch so a later failure/restart resumes safely.
      const batchSize=Math.min(16,Math.max(1,Math.floor(Number(this.gateway.batchSize)||16)))
      let stored=0
      for(let start=0;start<drafts.length;start+=batchSize){
        if(this.disposed)break
        const batch=drafts.slice(start,start+batchSize)
        stored+=await this.embedAndStore(groupId,batch)
        if(this.disposed)break
        for(const draft of batch)for(const id of draft.message_ids||[])completed.add(id)
        await this.saveProgress(groupId,[...completed])
      }
      if(!drafts.length&&!this.disposed)await this.saveProgress(groupId,[...completed])
      if(full)this.stats.backfilledGroups++
      return {group:String(groupId),messages:lines.length,chunks:drafts.length,indexed:stored}
    })()
    this.groupWork.set(groupId,work)
    try{return await work}finally{if(this.groupWork.get(groupId)===work)this.groupWork.delete(groupId)}
  }

  async backfillAll() {
    const groupIds = await this.archiveManager.listArchiveGroupIds()
    const results = []
    for (const groupId of groupIds) {
      try {
        results.push(await this.backfillGroup(groupId))
      } catch (error) {
        this.logger?.warn?.(`[SemanticMemory] 回填群 ${groupId} 失败: ${error instanceof Error ? error.message : String(error)}`)
        results.push({ group: String(groupId), error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  // 防抖合并归档写入；读取完整保留归档，只消费检查点尚未覆盖的消息。
  onArchivedRecord(record:ArchiveRecord = {}) {
    if (this.disposed||this.config.indexOnWrite === false) return
    const groupId = String(record.group_id || "")
    if (!groupId || record.archive_kind === "notice") return
    if (!this.groupAllowed(groupId)) return
    this.dirtyGroups.add(groupId)
    this.scheduleFlush()
  }

  async flushDirtyGroups() {
    if (this.disposed||this.flushing) return
    this.flushing = true
    try {
      const groups = [...this.dirtyGroups]
      this.dirtyGroups.clear()
      for (const groupId of groups) {
        if(this.disposed)break
        try {
          const result=await this.processGroup(groupId)
          const indexed=result.indexed||0
          if (indexed > 0) {
            this.stats.flushes++
            this.logger?.info?.(`[SemanticMemory] 增量索引 group=${groupId} chunks=+${indexed}`)
          }
        } catch(error) {
          if(!this.disposed)this.dirtyGroups.add(groupId)
          this.logger?.warn?.(`[SemanticMemory] 保留失败索引待重试 group=${groupId}: ${String(error)}`)
        }
      }
    } finally {
      this.flushing = false
      this.scheduleFlush()
    }
  }
}
