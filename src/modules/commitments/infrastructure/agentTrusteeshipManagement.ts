import type {AgentBindingSnapshot,AgentConversationScope} from '../../../contracts/agentBinding.js'
import type {AgentManagementBindings,AgentManagementContext,AgentManagementGuard} from '../../../contracts/agentManagement.js'
import {AgentManagementError} from '../../../contracts/agentManagement.js'
import type {CommitmentData,CommitmentRedisLike} from '../../../contracts/commitments.js'
import type {DelegatedMemoryEntry} from '../../../contracts/delegatedMemory.js'
import {agentBindingIdentity,agentBindingToken,agentConversationKey,decodeAgentConversationKey} from '../../runtime/domain/agentBindings.js'
import {resolvedDelegatedConfig} from '../../memory/domain/delegatedMemory.js'
import {createDelegatedMemoryStore} from '../../memory/infrastructure/delegatedMemoryStore.js'
import {formatScheduleText,resolvedCommitmentConfig} from '../domain/commitments.js'
import type {createCommitmentStore} from './commitmentStore.js'
import {captureSynchronousGuardCheck,createSynchronousGuard} from '../../runtime/domain/synchronousGuard.js'
import {captureAgentBindingDirectoryCheck} from '../../runtime/infrastructure/agentManagementBindings.js'

interface ScopeRow {
  binding:AgentBindingSnapshot
  scopeKey:string
  groupId:string
  agentId:string
  account:AgentBindingSnapshot['target']['account']
  conversation:AgentBindingSnapshot['target']
}
export interface AgentTrusteeshipCommitment extends ScopeRow {
  id:string;creatorId:string;creatorName:string;intent:string;schedule:string;deliver:string
  nextRunAt:number;expiryAt:number;status:string;lastResult:string;retryCount:number
}
export interface AgentTrusteeshipFailure extends ScopeRow {
  id?:string;intent?:string;group_id?:string;reason?:string;at?:number
}
export type AgentTrusteeshipOverview = {
  commitments:AgentTrusteeshipCommitment[]
  delegated:(ScopeRow&{entries:DelegatedMemoryEntry[]})[]
  failures:AgentTrusteeshipFailure[]
  config:{maxActivePerGroup:number;maxPerCreator:number;defaultExpiryDays:number;maxPerGroupDelegated:number;maxPerOwnerDelegated:number}
}

function copyBinding(binding:AgentBindingSnapshot):AgentBindingSnapshot {
  return {source:binding.source,id:binding.id,revision:binding.revision,agentId:binding.agentId,personaId:binding.personaId,
    connectionId:binding.connectionId,target:{kind:binding.target.kind,id:binding.target.id,account:{
      platform:binding.target.account.platform,namespace:binding.target.account.namespace,id:binding.target.account.id}}}
}
const bindingKey=(binding:AgentBindingSnapshot)=>JSON.stringify([agentConversationKey(binding),agentBindingToken(binding)])
const directoryKey=(bindings:readonly AgentBindingSnapshot[])=>JSON.stringify(bindings.map(bindingKey).sort())

/** Local console data ports. The supplied store must be the running Core's store. */
export function createAgentTrusteeshipManagement(ports:{
  store:ReturnType<typeof createCommitmentStore>
  redis:CommitmentRedisLike
  bindings:AgentManagementBindings
  now?:()=>number
}) {
  const memory=createDelegatedMemoryStore({redis:ports.redis,logger:{info(){},warn(){},error(){}},loadConfig:()=>({}),
    ...(ports.now?{now:ports.now}:{})})

  function request(context:AgentManagementContext){
    const parentCheck=captureSynchronousGuardCheck(context,()=>{throw new AgentManagementError('conflict')})
    function checkContext(){
      try{if(parentCheck)parentCheck();else{context.ensureCurrent();if(context.signal.aborted||!context.isCurrent())throw new Error('stale')}}
      catch{throw new AgentManagementError('conflict')}
    }
    checkContext()
    const initialBindings=ports.bindings
    const captured=initialBindings.list().map(copyBinding),directory=directoryKey(captured)
    const directoryCurrent=captureAgentBindingDirectoryCheck(initialBindings,captured,ports)
    const selected=context.binding?bindingKey(context.binding):undefined
    const byScope=new Map(captured.map(binding=>[agentConversationKey(binding),binding]))
    if(byScope.size!==captured.length)throw new AgentManagementError('unavailable')
    function validate(){
      checkContext()
      if((context.binding?bindingKey(context.binding):undefined)!==selected||
        (directoryCurrent?!directoryCurrent():directoryKey(ports.bindings.list())!==directory)){
        throw new AgentManagementError('conflict')
      }
      if(!directoryCurrent)for(const binding of captured){
        const current=ports.bindings.resolve(binding.target)
        if(!current||bindingKey(current)!==bindingKey(binding))throw new AgentManagementError('conflict')
      }
      if(selected&&!captured.some(binding=>bindingKey(binding)===selected))throw new AgentManagementError('conflict')
    }
    const guard:AgentManagementGuard=parentCheck?createSynchronousGuard(context.signal,validate,()=>{throw new AgentManagementError('conflict')}):
      {signal:context.signal,isCurrent:()=>{try{validate();return true}catch{return false}},ensureCurrent:validate}
    const {isCurrent,ensureCurrent:check}=guard
    check()
    async function permission(operation:string,binding:AgentBindingSnapshot,filter=false):Promise<boolean>{
      check()
      if(selected&&bindingKey(binding)!==selected){if(filter)return false;throw new AgentManagementError('forbidden')}
      const result=await context.authorize(operation,copyBinding(binding),guard)
      check()
      if(result==='allowed')return true
      if(result==='denied'&&filter)return false
      throw new AgentManagementError(result==='denied'?'forbidden':'unavailable')
    }
    function resolve(scopeKey:string){
      check()
      if(typeof scopeKey!=='string'||!decodeAgentConversationKey(scopeKey))throw new AgentManagementError('invalid_request')
      const binding=byScope.get(scopeKey)
      if(!binding)throw new AgentManagementError('not_found')
      if(selected&&bindingKey(binding)!==selected)throw new AgentManagementError('forbidden')
      return binding
    }
    async function listing(operation:string){
      const allowed=new Map<string,AgentBindingSnapshot>()
      for(const binding of captured){
        if(selected&&bindingKey(binding)!==selected)continue
        if(await permission(operation,binding,!selected))allowed.set(agentConversationKey(binding),binding)
      }
      const ensure=async()=>{
        check()
        for(const binding of allowed.values())await permission(operation,binding)
        check()
      }
      return {allowed,ensure}
    }
    return {check,isCurrent,permission,resolve,listing}
  }

  function scopeRow(binding:AgentBindingSnapshot):ScopeRow {
    const safe=copyBinding(binding)
    return {binding:safe,scopeKey:agentConversationKey(safe),groupId:safe.target.kind==='group'?safe.target.id:'',
      agentId:safe.agentId,account:{...safe.target.account},conversation:{...safe.target,account:{...safe.target.account}}}
  }
  function originalBinding(scope:AgentConversationScope|undefined,identity:string|undefined,allowed:Map<string,AgentBindingSnapshot>){
    if(!scope||!identity)return undefined
    const binding=allowed.get(agentConversationKey(scope))
    return binding&&agentBindingIdentity(binding)===identity?binding:undefined
  }
  function failureBinding(value:unknown,allowed:Map<string,AgentBindingSnapshot>){
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined
    const row=value as Record<string,unknown>
    if(typeof row.failureId!=='string'||!row.failureId||typeof row.id!=='string'||!row.id||
      typeof row.scopeKey!=='string'||typeof row.bindingIdentity!=='string')return undefined
    const scope=decodeAgentConversationKey(row.scopeKey)
    if(!scope||row.group_id!==(scope.target.kind==='group'?scope.target.id:''))return undefined
    const binding=originalBinding(scope,row.bindingIdentity,allowed)
    return binding?{binding,row}:undefined
  }
  async function run<T>(operation:()=>Promise<T>):Promise<T>{
    try{return await operation()}catch(error){
      if(error instanceof AgentManagementError)throw error
      throw new AgentManagementError('unavailable')
    }
  }
  async function overview(context:AgentManagementContext):Promise<AgentTrusteeshipOverview>{
    return run(async()=>{
      const req=request(context),{allowed,ensure}=await req.listing('trusteeship.read')
      const check=async()=>{req.check()}
      const commitments:AgentTrusteeshipCommitment[]=[],delegated:AgentTrusteeshipOverview['delegated']=[],failures:AgentTrusteeshipFailure[]=[]
      if(allowed.size){
        for(const task of await ports.store.listManagementCommitments(check)){
          const binding=originalBinding(task.scope,task.bindingIdentity,allowed)
          if(!binding)continue
          await req.permission('trusteeship.read',binding)
          commitments.push({...scopeRow(binding),id:task.id,creatorId:task.creator_id,creatorName:task.creator_name,intent:task.intent,
            schedule:formatScheduleText(task.schedule),deliver:task.deliver,nextRunAt:task.next_run_at,expiryAt:task.expiry_at,
            status:task.status,lastResult:task.last_result,retryCount:task.retry_count})
        }
        for(const binding of allowed.values()){
          if(binding.target.kind!=='group')continue
          const entries=await memory.loadForManagement(binding,check)
          if(entries.length)delegated.push({...scopeRow(binding),entries:entries.map(({id,owner,ownerName,content,dueAt,status,createdAt,updatedAt})=>
            ({id,owner,ownerName,content,dueAt,status,createdAt,updatedAt}))})
        }
        for(const value of await ports.store.readManagementFailLog(check)){
          const proven=failureBinding(value,allowed)
          if(!proven)continue
          await req.permission('trusteeship.read',proven.binding)
          const {id,intent,group_id,reason,at}=proven.row
          failures.push({...scopeRow(proven.binding),...(typeof id==='string'?{id}:{}),...(typeof intent==='string'?{intent}:{}),
            ...(typeof group_id==='string'?{group_id}:{}),...(typeof reason==='string'?{reason}:{}),...(typeof at==='number'&&Number.isFinite(at)?{at}:{})})
        }
      }
      await ensure()
      for(const row of [...commitments,...delegated,...failures])await req.permission('trusteeship.read',row.binding)
      req.check()
      // Core currently supplies empty config sections to both runtimes.
      const cfg=resolvedCommitmentConfig({}),delegatedCfg=resolvedDelegatedConfig({})
      return {commitments,delegated,failures,config:{...cfg,maxPerGroupDelegated:delegatedCfg.maxPerGroup,maxPerOwnerDelegated:delegatedCfg.maxPerOwner}}
    })
  }
  async function cancelCommitment(scopeKey:string,id:string,context:AgentManagementContext):Promise<boolean>{
    return run(async()=>{
      if(typeof id!=='string'||!id.trim())throw new AgentManagementError('invalid_request')
      const req=request(context),binding=req.resolve(scopeKey),ensure=async()=>{await req.permission('commitments.cancel',binding)}
      const validate=async(task:CommitmentData)=>{
        await ensure()
        if(task.id!==id)throw new AgentManagementError('unavailable')
        if(!task.scope||agentConversationKey(task.scope)!==scopeKey||task.bindingIdentity!==agentBindingIdentity(binding))throw new AgentManagementError('forbidden')
      }
      await ensure()
      const changed=await ports.store.cancelCommitment(id,req.isCurrent,ensure,validate)
      await ensure()
      return changed
    })
  }
  async function deleteDelegated(scopeKey:string,id:string,context:AgentManagementContext):Promise<boolean>{
    return run(async()=>{
      if(typeof id!=='string'||!id.trim())throw new AgentManagementError('invalid_request')
      const req=request(context),binding=req.resolve(scopeKey),ensure=async()=>{await req.permission('delegated.delete',binding)}
      if(binding.target.kind!=='group')throw new AgentManagementError('invalid_request')
      await ensure()
      const changed=await memory.removeForManagement(binding,id,req.isCurrent,ensure)
      await ensure()
      return changed
    })
  }
  async function clearFailLog(context:AgentManagementContext):Promise<boolean>{
    return run(async()=>{
      const req=request(context),{allowed,ensure}=await req.listing('commitments.clear-failures')
      if(!allowed.size){req.check();return false}
      const selected:unknown[]=[]
      for(const value of await ports.store.readManagementFailLog(ensure)){
        const proven=failureBinding(value,allowed)
        if(proven){await req.permission('commitments.clear-failures',proven.binding);selected.push(value)}
      }
      await ensure()
      const changed=await ports.store.clearManagementFailLog(selected,ensure)
      await ensure()
      return changed
    })
  }
  return {overview,cancelCommitment,deleteDelegated,clearFailLog}
}
