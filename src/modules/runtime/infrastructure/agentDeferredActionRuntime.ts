import {createHash} from 'node:crypto'
import type {AgentBindingSnapshot,PlatformAccountRef,PlatformUserRef} from '../../../contracts/agentBinding.js'
import type {AgentDeferredActionAuthorizationRequest,AgentDeferredActionCreate,AgentDeferredActionData,AgentDeferredActionExecutionContext,AgentDeferredActionRuntimePorts,AgentDeferredAuthorizationGuard} from '../../../contracts/agentDeferredAction.js'
import type {CommitmentData} from '../../../contracts/commitments.js'
import type {MessageActionPort,OutgoingPart} from '../../../contracts/platformMessage.js'
import {agentBindingIdentity,agentBindingToken,agentConversationKey,isPlatformAccount,platformAccountKey} from '../domain/agentBindings.js'
import {assertDeferredGrant,deferredActionHash,freezeDeferredAction} from '../../commitments/infrastructure/agentDeferredActionData.js'
import {createCommitmentStore} from '../../commitments/infrastructure/commitmentStore.js'
import {checkCommitmentCaps,resolvedCommitmentConfig} from '../../commitments/domain/commitments.js'
import {sanitizeFinalReplyText} from '../../conversation/domain/replySanitizer.js'
import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'

class Stopped extends Error {
  constructor(readonly code:'cancelled'|'unavailable'){super(code)}
}
const sameUser=(a:PlatformUserRef,b:PlatformUserRef)=>a.platform===b.platform&&a.namespace===b.namespace&&a.id===b.id
const snapshotBinding=(binding:AgentBindingSnapshot):AgentBindingSnapshot=>Object.freeze({...binding,
  target:Object.freeze({...binding.target,account:Object.freeze({...binding.target.account})})})

/** Concrete fixed-text delivery, without borrowing a native event or a historical quote. */
export function createAgentDeferredReminderSender(actions:MessageActionPort):AgentDeferredActionRuntimePorts['sendReminder'] {
  return async(task,context)=>{
    await context.ensureCurrent()
    if(!context.isCurrent())return {state:'failed',code:'delegation_revoked'}
    const target=context.binding.target,text=sanitizeFinalReplyText(task.static_message||'')
    if(!text)return {state:'failed',code:'invalid_reminder_text'}
    const parts:OutgoingPart[]=target.kind==='private'?[{kind:'text',text}]:[
      {kind:'mention',user:context.creator},{kind:'text',text:` ${text}`},
    ]
    return await actions.send({version:1,kind:'message.send',target,binding:context.binding,parts},
      {isCurrent:context.isCurrent,ensureCurrent:context.ensureCurrent})
  }
}

export function createAgentDeferredActionRuntime(ports:AgentDeferredActionRuntimePorts) {
  const store=createCommitmentStore({redis:ports.redis,logger:ports.logger})
  const now=()=>ports.now?.()??Date.now(),ticks=new Map<string,Promise<void>>(),controllers=new Set<AbortController>()
  let stopped=false,recovery:Promise<void>|undefined

  function sameBinding(binding:AgentBindingSnapshot):boolean {
    const current=ports.resolveBinding(binding.target)
    return current?.source==='configured'&&agentConversationKey(current)===agentConversationKey(binding)&&agentBindingToken(current)===agentBindingToken(binding)
  }
  function visible(task:CommitmentData,binding:AgentBindingSnapshot,creator:PlatformUserRef):boolean {
    return !!task.deferredAction&&binding.source==='configured'&&!!task.scope&&
      agentConversationKey(task.scope)===agentConversationKey(binding)&&task.bindingIdentity===agentBindingIdentity(binding)&&
      sameUser(task.deferredAction.grant.creator,creator)&&
      (binding.target.kind==='group'||binding.target.kind==='private'&&task.importedReminder===true)
  }
  async function create(input:AgentDeferredActionCreate):Promise<{status:'succeeded'|'failed';id?:string;code:string}> {
    input={...input,binding:snapshotBinding(input.binding),creator:Object.freeze({...input.creator}),source:Object.freeze({...input.source})}
    const current=()=>!stopped&&!input.signal.aborted&&input.isCurrent()&&sameBinding(input.binding)
    if(input.binding.source!=='configured'||input.binding.target.kind!=='group'||!current())return {status:'failed',code:'binding_unavailable'}
    if(ports.mode(input.binding.target)!=='simulation')return {status:'failed',code:'extra_requires_simulation'}
    if(input.source.kind!=='message'||!input.source.messageId||!input.requestText.trim()||input.source.at>now()||input.source.at<=0)return {status:'failed',code:'current_human_source_required'}
    if(input.creator.platform!==input.binding.target.account.platform||input.creator.namespace!==input.binding.target.account.namespace||!input.creator.id)return {status:'failed',code:'creator_mismatch'}
    if(!Number.isSafeInteger(input.dueAt)||input.dueAt<=0||!input.content.trim()||!sanitizeFinalReplyText(input.message))return {status:'failed',code:'invalid_reminder'}
    const definition=ports.executor.resolve(input.tool)
    if(!definition?.isCurrent())return {status:'failed',code:'tool_unavailable'}
    let action
    try{
      const frozen=freezeDeferredAction({tool:definition.name,executor:definition.executor,definitionId:definition.definitionId,params:input.params})
      const params=input.tool==='pokeTool'&&!frozen.params.target?{...frozen.params,target:[input.creator.id]}:frozen.params
      action=freezeDeferredAction({...frozen,params})
      if(!definition.validate(action.params))return {status:'failed',code:'invalid_tool_params'}
    }catch{return {status:'failed',code:'invalid_tool_params'}}
    const request:AgentDeferredActionAuthorizationRequest={binding:input.binding,creator:input.creator,source:input.source,action,dueAt:input.dueAt,requestText:input.requestText}
    const id=`dfr_${createHash('sha256').update(JSON.stringify([agentConversationKey(input.binding),agentBindingIdentity(input.binding),input.creator.platform,input.creator.namespace,input.creator.id,input.source.messageId])).digest('hex')}`
    const existingResult=(previous:CommitmentData):{status:'succeeded'|'failed';id?:string;code:string}=>{
      if(previous.deferredAction?.grant.actionHash!==deferredActionHash(action)||previous.schedule.kind!=='once'||previous.schedule.time!==input.dueAt||
        previous.static_message!==input.message||previous.intent!==input.content)return {status:'failed',code:'source_already_used'}
      return previous.status==='active'?{status:'succeeded',id,code:'already_registered'}:{status:'failed',id,code:`existing_${previous.status}`}
    }
    const previous=await store.getCommitment(id)
    if(previous)return existingResult(previous)
    if(input.dueAt<=now())return {status:'failed',code:'invalid_reminder'}
    const grant=await guardedAuthorization(guard=>ports.authorization.issue(request,guard),input.signal,current)
    if(!grant)return {status:'failed',code:'delegation_not_granted'}
    try{
      assertDeferredGrant(grant,action,agentBindingIdentity(input.binding),input.creator,agentConversationKey(input.binding))
      if(grant.dueAt!==input.dueAt||JSON.stringify(grant.source)!==JSON.stringify(input.source))return {status:'failed',code:'delegation_mismatch'}
      if(!current()||!ports.authorization.isCurrent(grant,request)||await guardedAuthorization(guard=>ports.authorization.check(grant,request,guard),input.signal,current)!=='allowed')return {status:'failed',code:'delegation_revoked'}
    }catch{return {status:'failed',code:'delegation_revoked'}}
    if(!current())return {status:'failed',code:'binding_unavailable'}
    const at=now(),task:CommitmentData={id,group_id:input.binding.target.id,creator_id:input.creator.id,creator_name:input.creatorName.slice(0,128),
      intent:input.content,static_message:input.message,deliver:'static',schedule:{kind:'once',time:input.dueAt},next_run_at:input.dueAt,
      expiry_at:0,status:'active',last_run_at:0,last_result:'',retry_count:0,created_at:at,bot_id:input.binding.target.account.id,
      scope:{agentId:input.binding.agentId,target:input.binding.target},bindingIdentity:agentBindingIdentity(input.binding),
      deferredAction:{version:1,action,grant,state:'pending',attemptedAt:0,settledAt:0,resultCode:''}}
    const cfg=resolvedCommitmentConfig(ports.limits?.())
    try{
      await store.createCommitment(task,active=>{
        const error=checkCommitmentCaps(active.filter(c=>c.scope&&agentConversationKey(c.scope)===agentConversationKey(input.binding)),task.group_id,task.creator_id,cfg)
        if(error)throw new Error('deferred_limit')
      },()=>current()&&ports.authorization.isCurrent(grant,request))
    }catch(error){
      const existing=await store.getCommitment(id)
      if(existing)return existingResult(existing)
      if(error instanceof Error&&error.message==='deferred_limit')return {status:'failed',code:'reminder_limit'}
      throw error
    }
    return {status:'succeeded',id,code:'registered'}
  }
  async function list(binding:AgentBindingSnapshot,creator:PlatformUserRef):Promise<CommitmentData[]>{
    if(!sameBinding(binding))return []
    const records=(await store.listDeferredActions()).filter(c=>visible(c,binding,creator))
    return sameBinding(binding)?records:[]
  }
  async function cancel(id:string,binding:AgentBindingSnapshot,creator:PlatformUserRef,isCurrent:()=>boolean=()=>true):Promise<boolean>{
    if(!isCurrent()||!sameBinding(binding))return false
    const task=await store.getCommitment(id)
    if(!task||!visible(task,binding,creator))return false
    return await store.cancelCommitment(id,()=>isCurrent()&&sameBinding(binding))
  }

  async function executeClaim(task:CommitmentData):Promise<void>{
    let deferred=task.deferredAction!,binding:AgentBindingSnapshot|undefined,context:AgentDeferredActionExecutionContext|undefined
    let deliveryStarted=false,heartbeat:ReturnType<typeof setInterval>|undefined,polling=false,lastHeartbeat=now()
    let unsubscribe:()=>void=()=>{},captured:ReturnType<NonNullable<AgentDeferredActionRuntimePorts['capture']>>|undefined
    const controller=new AbortController();controllers.add(controller)
    const finish=async(status:CommitmentData['status'],code:string)=>{
      if(status==='unknown'&&deferred.state==='executing'){
        const next:AgentDeferredActionData={...deferred,state:'unknown',settledAt:now(),resultCode:code}
        if(await store.updateDeferredActionClaim(task,'executing',next,now())){
          deferred=next
          await store.appendFailLog({id:task.id,group_id:task.group_id,reason:code,at:now()})
          return
        }
      }
      const saved=await store.commitRunOutcome({...task,status,next_run_at:0,last_run_at:now(),last_result:code})
      if(saved&&(status==='unknown'||status==='failed'))await store.appendFailLog({id:task.id,group_id:task.group_id,reason:code,at:now()})
    }
    try{
      if(!task.scope||!await store.refreshClaim(task,now()))return
      binding=ports.resolveBinding(task.scope.target)
      if(!binding||binding.source!=='configured'||agentConversationKey(binding)!==agentConversationKey(task.scope)||agentBindingIdentity(binding)!==task.bindingIdentity){
        await finish('cancelled','binding_changed');return
      }
      if(ports.mode(binding.target)===undefined||!ports.ready(binding.target.account)){await store.releaseUnstartedClaim(task);return}
      const fixedBinding=snapshotBinding(binding),creator=deferred.grant.creator
      const request:AgentDeferredActionAuthorizationRequest={binding:fixedBinding,creator,action:deferred.action,source:deferred.grant.source,dueAt:task.schedule.kind==='once'?task.schedule.time:0}
      captured=ports.capture?.(fixedBinding)
      const signal=captured?AbortSignal.any([controller.signal,captured.signal]):controller.signal
      unsubscribe=store.onInvalidated(task.id,()=>controller.abort())
      const isCurrent=()=>{
        try{
          const definition=ports.executor.resolve(deferred.action.tool)
          return !signal.aborted&&sameBinding(fixedBinding)&&ports.ready(fixedBinding.target.account)&&ports.mode(fixedBinding.target)==='simulation'&&
            captured?.isCurrent()!==false&&ports.authorization.isCurrent(deferred.grant,request)&&
            !!definition&&definition.executor===deferred.action.executor&&definition.definitionId===deferred.action.definitionId&&definition.isCurrent()
        }catch{return false}
      }
      const ensureCurrent=async()=>{
        if(signal.aborted||!await store.isClaimCurrent(task,now()))throw new Stopped('cancelled')
        if(!ports.ready(fixedBinding.target.account)||ports.mode(fixedBinding.target)===undefined)throw new Stopped('unavailable')
        if(!isCurrent())throw new Stopped('cancelled')
        const authorization=await guardedAuthorization(guard=>ports.authorization.check(deferred.grant,request,guard),signal,isCurrent)
        if(signal.aborted)throw new Stopped('cancelled')
        if(authorization===undefined||authorization==='unavailable')throw new Stopped('unavailable')
        if(authorization!=='allowed'||!isCurrent()||!await store.isClaimCurrent(task,now()))throw new Stopped('cancelled')
      }
      context={kind:'deferred',taskId:task.id,binding:fixedBinding,creator,delegation:deferred.grant,signal,isCurrent,ensureCurrent}
      heartbeat=setInterval(()=>{
        if(polling)return
        polling=true
        Promise.resolve().then(async()=>{
          if(!isCurrent()||!await store.isClaimCurrent(task,now())){controller.abort();return}
          if(now()-lastHeartbeat>=30_000){if(!await store.refreshClaim(task,now()))controller.abort();lastHeartbeat=now()}
        }).catch(()=>controller.abort()).finally(()=>{polling=false})
      },50);heartbeat.unref()
      await ensureCurrent()
      if(deferred.state==='unknown'||deferred.state==='executing'){await finish('unknown','previous_extra_unresolved');return}
      if(deferred.state==='pending'){
        const attempted:AgentDeferredActionData={...deferred,state:'executing',attemptedAt:now(),resultCode:'attempted'}
        if(!await store.updateDeferredActionClaim(task,'pending',attempted,now(),isCurrent))return
        deferred=attempted
        const result=await bounded(()=>ports.executor.execute(deferred.action,context!),signal,240_500)
        if(!result||!['succeeded','failed'].includes(result.status)){await finish('unknown','extra_result_unknown');return}
        // A confirmed/explicitly failed tool may settle, but cancellation still prevents all later steps.
        const settled:AgentDeferredActionData={...deferred,state:result.status==='succeeded'?'succeeded':'failed',settledAt:now(),resultCode:result.status==='succeeded'?'extra_succeeded':'extra_failed'}
        if(!await store.updateDeferredActionClaim(task,'executing',settled,now()))return
        deferred=settled
      }
      await ensureCurrent()
      if(!sanitizeFinalReplyText(task.static_message||'')){await finish('failed','invalid_reminder_text');return}
      if(!await store.refreshClaim(task,now(),true,isCurrent))return
      await ensureCurrent()
      deliveryStarted=true
      const receipt=normalizeDeliveryReceipt(await bounded(()=>ports.sendReminder(task,context!),signal,60_000))
      if(receipt.state==='unknown'){await finish('unknown','reminder_result_unknown');return}
      if(receipt.state==='failed'){
        await ensureCurrent()
        const result=await store.requeueForRetry({...task,last_result:'reminder_rejected'},now())
        if(result==='failed')await store.appendFailLog({id:task.id,group_id:task.group_id,reason:'reminder_rejected',at:now()})
        return
      }
      await finish('completed',deferred.state==='failed'?'sent_extra_failed':'sent')
    }catch(error){
      if(deferred.state!=='executing'&&!deliveryStarted){
        if(stopped||!(error instanceof Stopped)||error.code==='unavailable')await store.releaseUnstartedClaim(task)
        else await finish('cancelled','delegation_revoked')
      }else await finish('unknown',deliveryStarted?'reminder_result_unknown':'extra_result_unknown')
    }finally{
      if(heartbeat)clearInterval(heartbeat)
      controller.abort();controllers.delete(controller);unsubscribe();captured?.release()
    }
  }
  async function runTick(account:PlatformAccountRef):Promise<void>{
    if(!ports.ready(account))return
    recovery??=store.recoverLegacyIndex().catch(error=>{recovery=undefined;throw error})
    await recovery
    const handles=(c:CommitmentData)=>!!c.deferredAction&&!!c.scope&&platformAccountKey(c.scope.target.account)===platformAccountKey(account)
    // Claim just one at a time so other queued work never loses a lease behind a slow invocation.
    const due=await store.takeDueCommitments(now(),handles,1)
    for(const task of due){
      if(stopped){await store.releaseUnstartedClaim(task);continue}
      await executeClaim(task)
    }
  }
  function tick(account:PlatformAccountRef):Promise<void>{
    if(!isPlatformAccount(account))return Promise.reject(new Error('延期调度需要有效平台账号'))
    if(stopped)return Promise.resolve()
    const key=platformAccountKey(account),active=ticks.get(key)
    if(active)return active
    const promise=runTick(account).finally(()=>ticks.delete(key));ticks.set(key,promise);return promise
  }
  async function drain():Promise<void>{stopped=true;for(const controller of controllers)controller.abort();await Promise.allSettled(ticks.values())}
  return {create,list,cancel,tick,drain,store}
}

async function guardedAuthorization<T>(run:(guard:AgentDeferredAuthorizationGuard)=>Promise<T>,signal:AbortSignal,isCurrent:()=>boolean):Promise<T|undefined>{
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal])
  try{return await bounded(()=>run({signal:combined,isCurrent:()=>!combined.aborted&&isCurrent()}),combined,30_000)}
  finally{controller.abort()}
}

async function bounded<T>(run:()=>Promise<T>,signal:AbortSignal,timeoutMs:number):Promise<T|undefined>{
  if(signal.aborted)return undefined
  let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{}
  try{
    return await Promise.race([Promise.resolve().then(()=>signal.aborted?undefined:run()),new Promise<undefined>(resolve=>{
      abort=()=>resolve(undefined);signal.addEventListener('abort',abort,{once:true})
      timer=setTimeout(()=>resolve(undefined),timeoutMs);if(signal.aborted)abort()
    })])
  }finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort)}
}
