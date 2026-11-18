import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {AgentBindingSnapshot} from '../../../contracts/agentBinding.js'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'
import type {AgentDicePrivateRelayRequest} from '../../../contracts/agentDice.js'
import {agentDiceSourceFingerprint} from './agentDiceSource.js'
import {conversationAddressKey,isConversationAddress,isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import type {AgentDiceEffectReceipt} from './agentDiceState.js'

export type {AgentDicePrivateRelayRequest,AgentDiceRelayGuard} from '../../../contracts/agentDice.js'
export type AgentDicePrivateOrigin=AgentDicePrivateRelayRequest['origin']
export interface AgentDicePrivateAttempt {readonly operationId:string;readonly index:number}
export interface AgentDicePrivateDeliveryRef {readonly packId:string;readonly deliveryId:string;readonly originMessageId:string;readonly index:number}
export interface AgentDicePrivateEffect {
  readonly kind:'private'
  readonly recipientId:string
  readonly text:string
  readonly packId?:string
  readonly deliveryId?:string
  readonly origin?:AgentDicePrivateOrigin
  readonly requiredPermission?:'player'|'gm'
}
const invalid=()=>new Error('骰子私密投递来源或结算无效')
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)
function data(value:unknown,seen=new Set<object>(),depth=0):unknown {
  if(depth>32)throw invalid()
  if(value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))throw invalid()
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value)
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw invalid()
  if(keys.length>10000||keys.some(key=>typeof key!=='string'||['__proto__','constructor','prototype'].includes(key)))throw invalid()
  seen.add(value)
  try{
    if(array){
      if(keys.length!==value.length+1)throw invalid()
      const result:unknown[]=[]
      for(let index=0;index<value.length;index++){
        const field=Object.getOwnPropertyDescriptor(value,String(index))
        if(!field||!('value'in field)||!field.enumerable)throw invalid()
        result.push(data(field.value,seen,depth+1))
      }
      return result
    }
    const result:Record<string,unknown>={}
    for(const key of keys as string[]){
      const field=Object.getOwnPropertyDescriptor(value,key)
      if(!field||!('value'in field)||!field.enumerable)throw invalid()
      result[key]=data(field.value,seen,depth+1)
    }
    return result
  }finally{seen.delete(value)}
}
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
function checkedId(value:unknown):string {if(!isPlatformIdentifier(value)||value==='0')throw invalid();return value}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical)
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]))
  return value
}
function same(left:unknown,right:unknown):boolean {return JSON.stringify(canonical(left))===JSON.stringify(canonical(right))}
function label(value:unknown):boolean {return typeof value==='string'&&value.length>0&&value.length<=4096&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)}
export function readAgentDicePrivateOrigin(value:unknown):AgentDicePrivateOrigin {
  const root=record(data(value)),binding=record(root.binding),target=record(binding.target),account=record(target.account),source=record(root.source),author=record(source.author)
  if(Object.keys(root).some(key=>!['binding','source','operationId','authorityRevision'].includes(key))||!digest(root.operationId)||!isPlatformIdentifier(root.authorityRevision)||
    Object.keys(binding).some(key=>!['source','id','revision','agentId','personaId','connectionId','target'].includes(key))||binding.source!=='configured'||!label(binding.id)||!label(binding.revision)||
    !isPlatformIdentifier(binding.agentId)||!isPlatformIdentifier(binding.personaId)||!isPlatformIdentifier(binding.connectionId)||target.kind!=='group'||!isConversationAddress(target as unknown as AgentBindingSnapshot['target'])||
    Object.keys(target).some(key=>!['account','kind','id'].includes(key))||Object.keys(account).some(key=>!['platform','namespace','id'].includes(key))||
    Object.keys(source).some(key=>!['messageId','author','occurredAt','fingerprint'].includes(key))||!isPlatformIdentifier(source.messageId)||source.messageId==='0'||!digest(source.fingerprint)||typeof source.occurredAt!=='number'||!Number.isSafeInteger(source.occurredAt)||source.occurredAt<=0||!Number.isFinite(new Date(source.occurredAt).getTime())||
    Object.keys(author).some(key=>!['platform','namespace','id'].includes(key))||!isPlatformIdentifier(author.id)||author.platform!==account.platform||author.namespace!==account.namespace)throw invalid()
  if(createHash('sha256').update(JSON.stringify([conversationAddressKey(target as unknown as AgentBindingSnapshot['target']),source.messageId])).digest('hex')!==root.operationId)throw invalid()
  return root as unknown as AgentDicePrivateOrigin
}
export function createAgentDicePrivateOrigin(binding:AgentBindingSnapshot,source:IncomingMessage,operationId:string,authorityRevision:string):AgentDicePrivateOrigin {
  const copied=data(source) as IncomingMessage
  return readAgentDicePrivateOrigin({binding,source:{messageId:checkedId(copied.messageId),author:copied.sender,occurredAt:copied.occurredAt,fingerprint:agentDiceSourceFingerprint(copied)},operationId,authorityRevision})
}
function queues(state:unknown):{packId:string;group:Record<string,unknown>;items:Record<string,unknown>[]}[] {
  const rules=record(record(state).rules),packs=record(rules.packs),result:{packId:string;group:Record<string,unknown>;items:Record<string,unknown>[]}[]=[]
  for(const [packId,pack]of Object.entries(packs)){
    const group=record(record(pack).group)
    if(group.privateDeliveries===undefined){result.push({packId,group,items:[]});continue}
    if(!Array.isArray(group.privateDeliveries))throw invalid()
    if(group.privateDeliveries.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw invalid()
    result.push({packId,group,items:group.privateDeliveries as Record<string,unknown>[]})
  }
  return result
}
/** Binds queue intents to their exact durable attempt before the business commit. */
export function prepareAgentDicePrivateDeliveries(input:unknown,effects:readonly unknown[],originInput:AgentDicePrivateOrigin,operationId:string):{state:unknown;effects:readonly unknown[];privateDeliveries:readonly AgentDicePrivateDeliveryRef[]} {
  if(!digest(operationId))throw invalid()
  const state=data(input),copied=data(effects) as Record<string,unknown>[],origin=readAgentDicePrivateOrigin(originInput),entries=queues(state),refs:AgentDicePrivateDeliveryRef[]=[],seen=new Set<string>()
  for(let index=0;index<copied.length;index++){
    const effect=copied[index]!
    if(effect.kind!=='private')continue
    const id=checkedId(effect.recipientId)
    if(typeof effect.text!=='string'||!effect.text.trim())throw invalid()
    if(effect.packId===undefined&&effect.deliveryId===undefined){effect.origin=origin;continue}
    const packId=checkedId(effect.packId),deliveryId=checkedId(effect.deliveryId),key=JSON.stringify([packId,deliveryId])
    if(seen.has(key))throw invalid();seen.add(key)
    const queue=entries.find(entry=>entry.packId===packId),matches=queue?.items.filter(item=>item.deliveryId===deliveryId)??[]
    if(matches.length!==1)throw invalid()
    const item=matches[0]!
    if(item.userId!==id||item.text!==effect.text||item.state!=='unknown')throw invalid()
    const saved=readAgentDicePrivateOrigin(item.origin??origin)
    if(effect.origin!==undefined&&!same(readAgentDicePrivateOrigin(effect.origin),saved))throw invalid()
    if(!same(saved.binding,origin.binding))throw invalid()
    item.origin=saved;item.attempt={operationId,index};effect.origin=saved
    effect.requiredPermission=item.requiredPermission==='player'?'player':'gm'
    refs.push({packId,deliveryId,originMessageId:saved.source.messageId,index})
  }
  return {state,effects:copied,privateDeliveries:refs}
}
/** Pure full-state projection. The store CAS validates the actual effect and both raw records. */
export function settleAgentDicePrivateDelivery(input:unknown,effectInput:AgentDicePrivateEffect,receiptInput:AgentDiceEffectReceipt,attempt:AgentDicePrivateAttempt):unknown {
  const state=data(input),effect=record(data(effectInput)),owner=record(data(attempt)),receipt=record(data(receiptInput))
  if(!digest(owner.operationId)||typeof owner.index!=='number'||!Number.isInteger(owner.index)||owner.index<0)throw invalid()
  if(effect.kind!=='private')throw invalid()
  if(effect.packId===undefined&&effect.deliveryId===undefined)return state
  const packId=checkedId(effect.packId),deliveryId=checkedId(effect.deliveryId),queue=queues(state).find(entry=>entry.packId===packId)
  const matches=queue?.items.filter(item=>item.deliveryId===deliveryId)??[]
  if(matches.length!==1)throw invalid()
  const item=matches[0]!,savedAttempt=record(item.attempt)
  if(savedAttempt.operationId!==owner.operationId||savedAttempt.index!==owner.index||item.userId!==effect.recipientId||item.state!=='unknown'||!same(readAgentDicePrivateOrigin(item.origin),readAgentDicePrivateOrigin(effect.origin)))throw invalid()
  if(receipt.state==='sent'){
    checkedId(receipt.messageId)
    queue!.group.privateDeliveries=queue!.items.filter(value=>value!==item)
  }else{
    item.state=receipt.state==='failed'?'failed':'unknown';item.attempts=(typeof item.attempts==='number'&&Number.isSafeInteger(item.attempts)?item.attempts:0)+1
    item.lastError=item.state
    if(item.state==='unknown')item.text=''
  }
  return state
}
/** Recalled output is scrubbed while all committed card and game values remain. */
export function scrubAgentDicePrivateSource(input:unknown,source:{messageId:string;operationId:string}):unknown {
  const state=data(input),copied=record(data(source))
  const messageId=checkedId(copied.messageId),operationId=copied.operationId
  if(!digest(operationId))throw invalid()
  for(const entry of queues(state)){
    const audit=Array.isArray(entry.group.audit)?entry.group.audit as Record<string,unknown>[]:[],ids=new Set<string>()
    for(const item of audit){
      if(record(item.source).messageId!==messageId)continue
      if(typeof item.id==='string')ids.add(item.id)
      scrubAudit(item)
    }
    if(Array.isArray(entry.group.privateDeliveries))entry.group.privateDeliveries=entry.items.filter(item=>{
      const origin=record(item.origin),originalSource=record(origin.source),attempt=record(item.attempt)
      return originalSource.messageId!==messageId&&origin.operationId!==operationId&&attempt.operationId!==operationId&&
        ![...ids].some(id=>typeof item.deliveryId==='string'&&item.deliveryId.startsWith(id+':'))
    })
  }
  return state
}

function scrubAudit(item:Record<string,unknown>):void {
  const safe=new Set(['id','at','packId','packageVersion','command','visibility','source','invoker','targets'])
  for(const key of Object.keys(item)){
    if(['output','content','text','result','seed'].includes(key))item[key]='[revoked]'
    else if(['args','rolls','tables'].includes(key))item[key]={}
    else if(['actions','tags'].includes(key))item[key]=[]
    else if(key==='opposed')item[key]=null
    else if(!safe.has(key))delete item[key]
  }
  const source=record(item.source)
  if(item.source!==undefined)item.source=Object.fromEntries(['messageId','authorId','at'].filter(key=>typeof source[key]==='string'||typeof source[key]==='number').map(key=>[key,source[key]]))
  const invoker=record(item.invoker)
  if(item.invoker!==undefined)item.invoker=typeof invoker.id==='string'?{id:invoker.id}:{}
  if(Array.isArray(item.targets))item.targets=item.targets.map(target=>{
    const value=record(target)
    return Object.fromEntries(['id','kind'].filter(key=>typeof value[key]==='string').map(key=>[key,value[key]]))
  })
  item.output='[revoked]'
}

/** Physical privacy cleanup uses durable provenance, without rolling back game values. */
export function scrubAgentDicePrivateSubject(input:unknown,scope:{readonly subjectId:string;readonly originMessageIds?:readonly string[];readonly operationIds?:readonly string[]}):unknown {
  const state=data(input),query=record(data(scope)),subjectId=checkedId(query.subjectId)
  if(query.originMessageIds!==undefined&&!Array.isArray(query.originMessageIds)||query.operationIds!==undefined&&!Array.isArray(query.operationIds))throw invalid()
  const messages=new Set(((query.originMessageIds??[]) as unknown[]).map(checkedId)),operations=new Set<string>()
  for(const value of (query.operationIds??[]) as unknown[]){if(!digest(value))throw invalid();operations.add(value)}
  const entries=queues(state),auditIds=new Map<string,Set<string>>()
  const relatedAudit=(item:Record<string,unknown>)=>{
    const source=record(item.source),invoker=record(item.invoker)
    return source.authorId===subjectId||invoker.id===subjectId||item.actorId===subjectId||item.subjectId===subjectId||
      typeof source.messageId==='string'&&messages.has(source.messageId)||
      Array.isArray(item.targets)&&item.targets.some(target=>{const actor=record(target);return actor.id===subjectId&&actor.kind!=='npc'})
  }
  // A recipient belongs to the same private origin as its siblings and audit.
  // Close that lineage before deleting any body so no sibling can recreate it.
  let changed=true
  while(changed){
    const size=messages.size+operations.size+[...auditIds.values()].reduce((sum,set)=>sum+set.size,0)
    for(const entry of entries){
      const ids=auditIds.get(entry.packId)??new Set<string>();auditIds.set(entry.packId,ids)
      for(const item of Array.isArray(entry.group.audit)?entry.group.audit as Record<string,unknown>[]:[]){
        if(!relatedAudit(item)&&!(typeof item.id==='string'&&ids.has(item.id)))continue
        if(typeof item.id==='string')ids.add(item.id)
        const source=record(item.source);if(typeof source.messageId==='string')messages.add(source.messageId)
      }
      for(const item of entry.items){
        const origin=record(item.origin),source=record(origin.source),author=record(source.author),attempt=record(item.attempt)
        if(item.userId!==subjectId&&author.id!==subjectId&&!(typeof source.messageId==='string'&&messages.has(source.messageId))&&
          !(typeof origin.operationId==='string'&&operations.has(origin.operationId))&&!(typeof attempt.operationId==='string'&&operations.has(attempt.operationId))&&
          ![...ids].some(id=>typeof item.deliveryId==='string'&&item.deliveryId.startsWith(id+':')))continue
        if(typeof source.messageId==='string')messages.add(source.messageId)
        if(typeof origin.operationId==='string')operations.add(origin.operationId)
        if(typeof attempt.operationId==='string')operations.add(attempt.operationId)
        for(const audit of Array.isArray(entry.group.audit)?entry.group.audit as Record<string,unknown>[]:[]){
          if(typeof audit.id==='string'&&typeof item.deliveryId==='string'&&item.deliveryId.startsWith(audit.id+':'))ids.add(audit.id)
        }
      }
    }
    changed=size!==messages.size+operations.size+[...auditIds.values()].reduce((sum,set)=>sum+set.size,0)
  }
  for(const entry of entries){
    const ids=auditIds.get(entry.packId)??new Set<string>()
    for(const item of Array.isArray(entry.group.audit)?entry.group.audit as Record<string,unknown>[]:[]){
      if(relatedAudit(item)||typeof item.id==='string'&&ids.has(item.id))scrubAudit(item)
    }
    if(Array.isArray(entry.group.privateDeliveries))entry.group.privateDeliveries=entry.items.filter(item=>{
      const origin=record(item.origin),source=record(origin.source),attempt=record(item.attempt)
      return item.userId!==subjectId&&record(source.author).id!==subjectId&&!(typeof source.messageId==='string'&&messages.has(source.messageId))&&
        !(typeof origin.operationId==='string'&&operations.has(origin.operationId))&&!(typeof attempt.operationId==='string'&&operations.has(attempt.operationId))&&
        ![...ids].some(id=>typeof item.deliveryId==='string'&&item.deliveryId.startsWith(id+':'))
    })
  }
  return state
}
