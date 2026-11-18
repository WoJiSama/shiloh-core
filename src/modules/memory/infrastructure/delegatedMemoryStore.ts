// 委托记忆 Redis 存储，通过 CAS 原子修改当前分区的最新文档。
import type {DelegatedMemoryEntry,DelegatedMemoryPorts} from '../../../contracts/delegatedMemory.js'
import type {AgentConversationScope} from '../../../contracts/agentBinding.js'
import {agentConversationKey,decodeAgentConversationKey} from '../../runtime/domain/agentBindings.js'
import {normalizeDelegatedEntries} from '../domain/delegatedMemory.js'

const KEY_PREFIX='bl-chat:delegated:'
const SCOPED_KEY_PREFIX=`${KEY_PREFIX}v2:`
const COMPARE_AND_SET=`local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`

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
      !['dueAt','createdAt','updatedAt'].every(key=>typeof entry[key]==='number'&&Number.isFinite(entry[key])&&Number(entry[key])>=0)){
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

export function createDelegatedMemoryStore(ports:DelegatedMemoryPorts) {
  const now=ports.now ?? Date.now

  async function load(scope:MemoryScope,ensureCurrent?:()=>Promise<void>):Promise<DelegatedMemoryEntry[]>{
    await ensureCurrent?.()
    const raw=await ports.redis.get(delegatedMemoryStorageKey(scope))
    await ensureCurrent?.()
    if(!raw)return []
    try{
      const parsed:unknown=JSON.parse(raw)
      return normalizeDelegatedEntries(Array.isArray(parsed)?parsed:[],now())
    }catch{
      ports.logger.warn(`[委托记忆] 群 ${typeof scope === 'string' ? scope : scope.target.id} 数据损坏，按空处理`)
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
      const raw=await ports.redis.get(storageKey)
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      const parsed:unknown=strict?managementEntries(raw):raw?JSON.parse(raw):[]
      if(!Array.isArray(parsed))throw new Error('托付记忆数据损坏，停止修改')
      const entries=strict?parsed as DelegatedMemoryEntry[]:normalizeDelegatedEntries(parsed,now())
      if(entries.length!==parsed.length)throw new Error('托付记忆数据损坏，停止修改')
      const next=await operation(entries)
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      if(strict&&next.entries===entries)return next.result
      const saved=await ports.redis.eval(COMPARE_AND_SET,{keys:[storageKey],arguments:[raw||'',JSON.stringify(next.entries)]})
      await ensureCurrent?.()
      if(isCurrent?.()===false)throw new Error('角色绑定已改变，委托记忆未写入')
      if(Number(saved)===1)return next.result
    }
    throw new Error('托付记忆正在被其他操作更新，请重试')
  }

  async function remove(scope:MemoryScope,id:string):Promise<boolean>{
    return update(scope,entries=>({entries:entries.filter(entry=>entry.id!==id),result:entries.some(entry=>entry.id===id)}))
  }

  async function loadForManagement(scope:AgentConversationScope,ensureCurrent:()=>Promise<void>):Promise<DelegatedMemoryEntry[]>{
    await ensureCurrent()
    if(scope.target.kind!=='group')throw new Error('托付记忆管理仅支持完整群会话分区')
    const raw=await ports.redis.get(delegatedMemoryStorageKey(scope))
    await ensureCurrent()
    return managementEntries(raw)
  }

  async function removeForManagement(scope:AgentConversationScope,id:string,isCurrent:()=>boolean,ensureCurrent:()=>Promise<void>):Promise<boolean>{
    if(scope.target.kind!=='group')throw new Error('托付记忆管理仅支持完整群会话分区')
    return update(scope,entries=>entries.some(entry=>entry.id===id)
      ?{entries:entries.filter(entry=>entry.id!==id),result:true}
      :{entries,result:false},isCurrent,ensureCurrent,true)
  }

  return {load,update,remove,loadForManagement,removeForManagement}
}
