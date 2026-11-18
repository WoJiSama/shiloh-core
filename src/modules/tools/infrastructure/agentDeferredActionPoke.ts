import {types} from 'node:util'
import type {AgentDeferredActionDefinition,AgentDeferredActionExecutionContext,AgentDeferredParams} from '../../../contracts/agentDeferredAction.js'
import type {AgentInteractionPlan,AgentInteractionResult} from '../../../contracts/agentInteraction.js'
import type {AgentToolResult} from '../../../contracts/agentTool.js'
import type {ConversationMemberSnapshot} from '../../../contracts/platformConnection.js'
import {assertDeferredGrant,freezeDeferredAction} from '../../commitments/infrastructure/agentDeferredActionData.js'
import {agentBindingIdentity,agentBindingToken,agentConversationKey,conversationAddressKey,isConversationAddress,
  isPlatformAccount,isPlatformIdentifier,platformAccountKey,samePlatformNamespace} from '../../runtime/domain/agentBindings.js'
import {normalizeAgentInteractionResult,validateAgentInteractionPlan} from './agentInteractions.js'

export interface AgentDeferredPokePorts {
  readonly definitionId:string
  isCurrent():boolean
  readMember(userId:string,context:AgentDeferredActionExecutionContext):Promise<ConversationMemberSnapshot|undefined>
  perform(plan:AgentInteractionPlan,context:AgentDeferredActionExecutionContext):Promise<AgentInteractionResult>
}
const invalid=()=>new Error('延期戳一戳参数无效')
function parameters(input:AgentDeferredParams,definitionId:string) {
  const params=freezeDeferredAction({tool:'pokeTool',executor:'builtin',definitionId,params:input}).params
  if(Object.keys(params).some(key=>key!=='target'&&key!=='times'&&key!=='random')||
    params.random!==undefined&&params.random!==false)throw invalid()
  const targets=typeof params.target==='string'?[params.target]:params.target
  if(!Array.isArray(targets)||!targets.length||targets.length>20||targets.some(id=>!isPlatformIdentifier(id)))throw invalid()
  const ids=targets as string[],times=params.times===undefined?1:params.times
  if(new Set(ids).size!==ids.length||typeof times!=='number'||!Number.isSafeInteger(times)||times<1||times>10||ids.length*times>100)throw invalid()
  return {params,ids,times}
}
function result(status:AgentToolResult['status'],requested:number,completed:number,code:string):AgentToolResult {
  return {status,content:JSON.stringify({action:'poke',state:status==='succeeded'?'confirmed':status,requested,completed,code})}
}
/** Extract only data properties; no malformed receipt can run a getter or retain tool-returned content. */
function outcome(value:unknown,requested:number):AgentInteractionResult {
  try {
    if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value)||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid()
    const row:Record<string,unknown>={}
    for(const key of Reflect.ownKeys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key)
      if(typeof key!=='string'||!['state','completed','requested','code'].includes(key)||!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
      row[key]=descriptor.value
    }
    if(row.code!==undefined&&(typeof row.code!=='string'||row.code.length>128))throw invalid()
    return normalizeAgentInteractionResult({state:row.state,completed:row.completed,requested:row.requested},requested)
  }catch{return {state:'unknown',requested,completed:0}}
}

/** A delegated builtin using neutral effects. It never synthesizes a human request or native user/master event. */
export function createAgentDeferredPokeDefinition(ports:AgentDeferredPokePorts):AgentDeferredActionDefinition {
  const {definitionId}=ports
  freezeDeferredAction({tool:'pokeTool',executor:'builtin',definitionId,params:{}})
  const available=()=>{try{return ports.isCurrent?.()===true}catch{return false}}
  return Object.freeze({
    name:'pokeTool',executor:'builtin' as const,definitionId,isCurrent:available,
    validate(params:AgentDeferredParams){try{parameters(params,definitionId);return true}catch{return false}},
    async execute(params:AgentDeferredParams,context:AgentDeferredActionExecutionContext):Promise<AgentToolResult>{
      let selected:ReturnType<typeof parameters>
      try {selected=parameters(params,definitionId)}catch{return result('failed',0,0,'deferred_poke_invalid')}
      const requested=selected.ids.length*selected.times
      let token:string,targetKey:string,creatorKey:string
      try {
        if(!context||context.kind!=='deferred'||!isPlatformIdentifier(context.taskId)||context.binding.source!=='configured'||
          !isConversationAddress(context.binding.target)||context.binding.target.kind!=='group'||
          !isPlatformAccount(context.creator)||!samePlatformNamespace(context.creator,context.binding.target.account)||
          typeof context.ensureCurrent!=='function'||!context.signal||typeof context.signal.aborted!=='boolean')throw invalid()
        assertDeferredGrant(context.delegation,freezeDeferredAction({tool:'pokeTool',executor:'builtin',definitionId,params:selected.params}),
          agentBindingIdentity(context.binding),context.creator,agentConversationKey(context.binding))
        token=agentBindingToken(context.binding);targetKey=conversationAddressKey(context.binding.target);creatorKey=platformAccountKey(context.creator)
      }catch{return result('failed',requested,0,'deferred_poke_context_invalid')}
      function current(){
        try{return available()&&!context.signal.aborted&&context.isCurrent()===true&&agentBindingToken(context.binding)===token&&
          conversationAddressKey(context.binding.target)===targetKey&&platformAccountKey(context.creator)===creatorKey}catch{return false}
      }
      const stopped=()=>Object.assign(new Error('延期戳一戳授权已撤销'),{deferredPokeStopped:true})
      async function ensure(){if(!current())throw stopped();await context.ensureCurrent();if(!current())throw stopped()}
      async function member(id:string){
        await ensure()
        const startedAt=Date.now(),snapshot=await ports.readMember(id,context)
        await ensure()
        const observedNow=Date.now()
        if(!snapshot||conversationAddressKey(snapshot.target)!==targetKey||!isPlatformAccount(snapshot.member.user)||
          !samePlatformNamespace(snapshot.member.user,context.binding.target.account)||snapshot.member.user.id!==id||
          !Number.isSafeInteger(snapshot.observedAt)||snapshot.observedAt<startedAt-5_000||snapshot.observedAt>observedNow+5_000||
          observedNow-snapshot.observedAt>5_000||typeof snapshot.member.displayName!=='string'||
          !['owner','admin','member','unknown'].includes(snapshot.member.role))return undefined
        return Object.freeze({...snapshot.member.user})
      }
      let dispatched=false
      try {
        if(!await member(context.creator.id))return result('failed',requested,0,'deferred_poke_creator_unavailable')
        const operations=[]
        for(const id of selected.ids){
          const user=await member(id)
          if(!user)return result('failed',requested,0,'deferred_poke_target_unavailable')
          for(let index=0;index<selected.times;index++)operations.push({kind:'poke' as const,user})
        }
        const plan=validateAgentInteractionPlan({version:1,kind:'poke',operations},context.binding.target.account)
        await ensure();dispatched=true
        const received=await ports.perform(plan,context)
        await ensure()
        const normalized=outcome(received,requested)
        if(normalized.state==='confirmed'&&normalized.completed===requested)return result('succeeded',requested,requested,'deferred_poke_confirmed')
        if(normalized.state==='failed'&&normalized.completed===0)return result('failed',requested,0,'deferred_poke_rejected')
        return result('unknown',requested,normalized.completed,'deferred_poke_outcome_unknown')
      }catch(error){
        const stoppedBeforeDispatch=!dispatched&&error!==null&&typeof error==='object'&&'deferredPokeStopped'in error
        return result(stoppedBeforeDispatch?'failed':'unknown',requested,0,stoppedBeforeDispatch?'deferred_poke_cancelled':'deferred_poke_outcome_unknown')
      }
    },
  })
}
