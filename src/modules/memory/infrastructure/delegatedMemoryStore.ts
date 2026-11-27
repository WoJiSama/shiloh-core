// 委托记忆 Redis 存储，通过 CAS 原子修改当前分区的最新文档。
import type {DelegatedMemoryEntry,DelegatedMemoryPorts} from '../../../contracts/delegatedMemory.js'
import type {AgentConversationScope} from '../../../contracts/agentBinding.js'
import {agentConversationKey,decodeAgentConversationKey} from '../../runtime/domain/agentBindings.js'
import {reportAgentFailure,type AgentDiagnostics} from '../../runtime/infrastructure/agentDiagnostics.js'
import {normalizeDelegatedEntries} from '../domain/delegatedMemory.js'
import type {AgentSourceMemoryCleanupGuard,AgentSourceMemoryPurgeSubject} from '../../../contracts/sourceMemoryCleanup.js'
import {conversationCleanupMatchesScope,filterConversationCleanupRows,parseConversationCleanup} from './conversationMemoryCleanup.js'
import {cleanupExpected,createSubjectMemoryCleanup} from './subjectMemoryCleanup.js'

const KEY_PREFIX='bl-chat:delegated:'
const SCOPED_KEY_PREFIX=`${KEY_PREFIX}v2:`
const CLEANUP_KEY=`${KEY_PREFIX}v2:cleanup`
const COMPARE_AND_SET=`local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`
const READ_SCOPED=`return {redis.call('GET',KEYS[1]) or false,redis.call('GET',KEYS[2]) or false}`
const CAS_SCOPED=`local current=redis.call('GET',KEYS[1]);local fence=redis.call('GET',KEYS[2])
if (current or false)~=(ARGV[1]=='1' and ARGV[2] or false) or (fence or false)~=(ARGV[3]=='1' and ARGV[4] or false) then return 0 end
if ARGV[5]=='1' then redis.call('SET',KEYS[1],ARGV[6]) else redis.call('DEL',KEYS[1]) end;return 1`

type MemoryScope = string | AgentConversationScope

function managementEntries(raw:string|null):DelegatedMemoryEntry[]{
  const parsed:unknown=raw===null?[]:JSON.parse(raw)
  if(!Array.isArray(parsed))throw new Error('托付记忆数据损坏，停止管理')
  const ids=new Set<string>()
  for(const value of parsed){
    if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('托付记忆数据损坏，停止管理')
    const entry=value as Record<string,unknown>
    if(typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||typeof entry.owner!=='string'||!entry.owner||
      typeof entry.ownerName!=='string'||typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>300||
      (entry.status!=='active'&&entry.status!=='done')||
      !['dueAt','createdAt','updatedAt'].every(key=>typeof entry[key]==='number'&&Number.isFinite(entry[key])&&Number(entry[key])>=0)||
      entry.sourceAt!==undefined&&(typeof entry.sourceAt!=='number'||!Number.isSafeInteger(entry.sourceAt)||entry.sourceAt<=0)){
      throw new Error('托付记忆数据损坏，停止管理')
    }
    ids.add(entry.id)
  }
  return parsed as DelegatedMemoryEntry[]
}

export function delegatedMemoryStorageKey(scope:MemoryScope):string {
  return typeof scope === 'string' ? KEY_PREFIX + scope : SCOPED_KEY_PREFIX + encodeURIComponent(agentConversationKey(scope))
}

export function delegatedMemoryScopeFromKey(key:string):MemoryScope | null {
  if (!key.startsWith(KEY_PREFIX)) return null
  if (!key.startsWith(SCOPED_KEY_PREFIX)) {
    const groupId = key.slice(KEY_PREFIX.length)
    return /^\d{5,12}$/.test(groupId) ? groupId : null
  }
  try {
    const scope = decodeAgentConversationKey(decodeURIComponent(key.slice(SCOPED_KEY_PREFIX.length)))
    return scope?.target.kind === 'group' && delegatedMemoryStorageKey(scope) === key ? scope : null
  } catch {
    return null
  }
}

export function createDelegatedMemoryStore(ports:DelegatedMemoryPorts & { diagnostics?: Pick<AgentDiagnostics, 'emit'> }) {
  const now=ports.now ?? Date.now
  async function snapshot(scope:MemoryScope){
    if(typeof scope==='string')return {raw:await ports.redis.get(delegatedMemoryStorageKey(scope)),fenceRaw:null,fences:parseConversationCleanup(null)}
    if(!ports.redis.eval)throw new Error('托付记忆存储不支持清理屏障')
    const result=await ports.redis.eval(READ_SCOPED,{keys:[delegatedMemoryStorageKey(scope),CLEANUP_KEY],arguments:[]})
    if(!Array.isArray(result)||result.length!==2||result.some(value=>value!==null&&typeof value!=='string'))throw new Error('托付记忆清理状态无效')
    return {raw:result[0] as string|null,fenceRaw:result[1] as string|null,fences:parseConversationCleanup(result[1] as string|null)}
  }
  function filtered(scope:MemoryScope,entries:DelegatedMemoryEntry[],fences:ReturnType<typeof parseConversationCleanup>){
    if(typeof scope==='string')return entries
    const rows=entries.map(entry=>({...entry,authorId:entry.owner,at:entry.sourceAt??entry.createdAt}))
    const ids=new Set(filterConversationCleanupRows(scope,rows,fences).map(entry=>entry.id))
    return entries.filter(entry=>ids.has(entry.id))
  }
  async function scopedCommit(scope:AgentConversationScope,saved:Awaited<ReturnType<typeof snapshot>>,entries:DelegatedMemoryEntry[]){
    if(!ports.redis.eval)throw new Error('托付记忆存储不支持清理屏障')
    const result=await ports.redis.eval(CAS_SCOPED,{keys:[delegatedMemoryStorageKey(scope),CLEANUP_KEY],arguments:[...cleanupExpected(saved.raw),...cleanupExpected(saved.fenceRaw),...cleanupExpected(entries.length?JSON.stringify(entries):null)]})
    if(result!==0&&result!==1)throw new Error('托付记忆清理结果无效')
    return result===1
  }

  async function load(scope:MemoryScope,ensureCurrent?:()=>Promise<void>):Promise<DelegatedMemoryEntry[]>{
    await ensureCurrent?.()
    const saved=await snapshot(scope),raw=saved.raw
    await ensureCurrent?.()
    if(!raw)return []
    try{
      const parsed:unknown=JSON.parse(raw)
      return filtered(scope,normalizeDelegatedEntries(Array.isArray(parsed)?parsed:[],now()),saved.fences)
    }catch(error){
      reportAgentFailure(ports.diagnostics, { stage: 'memory', operation: 'delegated_memory_load', code: 'delegated_memory_decode_failed', error },
        () => ports.logger.warn(`[委托记忆] 群 ${typeof scope === 'string' ? scope : scope.target.id} 数据损坏，按空处理`))
      return []
    }
  }

  // The console and bot are different processes: an in-process queue cannot
  // protect this document. Re-evaluate caps, ownership and deletion on every CAS.
  async function update<T>(scope:MemoryScope,operation:(entries:DelegatedMemoryEntry[])=>{entries:DelegatedMemoryEntry[];result:T}|Promise<{entries:DelegatedMemoryEntry[];result:T}>,isCurrent?:()=>boolean,ensureCurrent?:()=>Promise<void>,strict=false):Promise<T>{
    if(!scope)throw new Error('缺少群身份')
    if(!ports.redis.eval)throw new Error('托付记忆存储不支持原子更新')
    const storageKey=delegatedMemoryStorageKey(scope)
    for(let attempt=0;attempt<16;attempt++){
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      const saved=await snapshot(scope),raw=saved.raw
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      const parsed:unknown=strict?managementEntries(raw):raw?JSON.parse(raw):[]
      if(!Array.isArray(parsed))throw new Error('托付记忆数据损坏，停止修改')
      const original=strict?parsed as DelegatedMemoryEntry[]:normalizeDelegatedEntries(parsed,now())
      if(original.length!==parsed.length)throw new Error('托付记忆数据损坏，停止修改')
      const entries=filtered(scope,original,saved.fences)
      const next=await operation(entries)
      for(const entry of next.entries){
        const prior=original.find(value=>value.id===entry.id)
        if(prior&&(prior.owner!==entry.owner||prior.createdAt!==entry.createdAt||prior.sourceAt!==entry.sourceAt))throw new Error('托付记忆来源不可改变')
      }
      const retained=filtered(scope,managementEntries(JSON.stringify(next.entries)),saved.fences)
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      if(strict&&next.entries===entries&&entries.length===original.length)return next.result
      const committed=typeof scope==='string'?await ports.redis.eval(COMPARE_AND_SET,{keys:[storageKey],arguments:[raw||'',JSON.stringify(retained)]}):await scopedCommit(scope,saved,retained)?1:0
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      if(Number(committed)===1)return next.result
    }
    throw new Error('托付记忆正在被其他操作更新，请重试')
  }

  async function remove(scope:MemoryScope,id:string):Promise<boolean>{
    return update(scope,entries=>({entries:entries.filter(entry=>entry.id!==id),result:entries.some(entry=>entry.id===id)}))
  }

  async function loadForManagement(scope:AgentConversationScope,ensureCurrent:()=>Promise<void>):Promise<DelegatedMemoryEntry[]>{
    await ensureCurrent()
    if(scope.target.kind!=='group')throw new Error('托付记忆管理仅支持完整群会话分区')
    const saved=await snapshot(scope)
    await ensureCurrent()
    return filtered(scope,managementEntries(saved.raw),saved.fences)
  }

  async function removeForManagement(scope:AgentConversationScope,id:string,isCurrent:()=>boolean,ensureCurrent:()=>Promise<void>):Promise<boolean>{
    if(scope.target.kind!=='group')throw new Error('托付记忆管理仅支持完整群会话分区')
    return update(scope,entries=>entries.some(entry=>entry.id===id)
      ?{entries:entries.filter(entry=>entry.id!==id),result:true}
      :{entries,result:false},isCurrent,ensureCurrent,true)
  }

  async function purgeSubject(input:AgentSourceMemoryPurgeSubject,guard:AgentSourceMemoryCleanupGuard){
    if(!ports.redis.eval)throw new Error('托付记忆存储不支持清理屏障')
    const cleanup=createSubjectMemoryCleanup({get:ports.redis.get.bind(ports.redis),eval:ports.redis.eval.bind(ports.redis)},CLEANUP_KEY,'delegated-memory')
    return cleanup.purge(input,guard,async(selector,authorize,counts)=>{
      async function scopes(){
        if(input.target)return input.target.kind==='group'?[{agentId:input.agentId,target:input.target}]:[]
        if(!ports.redis.scanIterator)throw new Error('托付记忆历史分区目录不可用')
        const all=new Map<string,AgentConversationScope>()
        for await(const keys of await ports.redis.scanIterator({MATCH:SCOPED_KEY_PREFIX+'*',COUNT:100})){
          await authorize()
          for(const key of Array.isArray(keys)?keys:[keys]){const scope=delegatedMemoryScopeFromKey(key);if(scope&&typeof scope!=='string'&&conversationCleanupMatchesScope(scope,selector))all.set(key,scope)}
          if(all.size>4096)throw new Error('托付记忆历史分区超过清理上限')
        }
        return [...all.values()]
      }
      for(const scope of await scopes()){
        let settled=false
        for(let attempt=0;attempt<20;attempt++){
          const saved=await snapshot(scope);await authorize()
          const entries=managementEntries(saved.raw),next=filtered(scope,entries,saved.fences)
          if(next.length===entries.length){settled=true;break}
          await authorize()
          if(!await scopedCommit(scope,saved,next))continue
          counts.removedRecords+=entries.length-next.length;if(!next.length)counts.removedPartitions++
          settled=true;break
        }
        if(!settled)throw new Error('托付记忆清理冲突')
      }
      for(const scope of await scopes()){
        const saved=await snapshot(scope);await authorize()
        const entries=managementEntries(saved.raw)
        if(filtered(scope,entries,saved.fences).length!==entries.length)throw new Error('托付记忆原始存储未清理')
      }
    })
  }
  return {load,update,remove,loadForManagement,removeForManagement,purgeSubject}
}
