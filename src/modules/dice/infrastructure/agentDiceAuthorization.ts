import {types} from 'node:util'
import type {AgentBindingSnapshot,ConversationAddress,PlatformIdentityRef} from '../../../contracts/agentBinding.js'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'
import {conversationAddressKey,isConversationAddress,isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import type {AgentDiceEngineAuthorization,AgentDiceEngineMember,AgentDiceEnginePermission} from './agentDiceEngine.js'

export type AgentDiceAuthorizationPermission=AgentDiceEnginePermission
export interface AgentDiceAuthorizationGrant {
  readonly binding:AgentBindingSnapshot
  readonly revision:string
  readonly actorId:string
  readonly permissions:readonly AgentDiceAuthorizationPermission[]
  readonly subjects?:readonly {readonly id:string;readonly permissions:readonly AgentDiceAuthorizationPermission[]}[]
}
export interface AgentDiceAuthorizationEvidence {
  /** The complete binding captured with the fresh host membership observation. */
  readonly binding:AgentBindingSnapshot
  readonly sourceMessageId:string
  readonly actor:{readonly id:string;readonly name:string}
  readonly members:readonly {readonly id:string;readonly name:string}[]
  readonly botUserId?:string
  /** This is retained only when the source quote independently proves the author. */
  readonly verifiedReplyAuthorId?:string
}
export interface AgentDiceAuthorizationInput {
  readonly binding:AgentBindingSnapshot
  readonly source:IncomingMessage
  readonly grant:AgentDiceAuthorizationGrant
  readonly evidence:AgentDiceAuthorizationEvidence
}

const permissions=new Set<AgentDiceAuthorizationPermission>(['player','gm','admin','master','delegate','hidden','card'])
const invalid=()=>new Error('骰子授权、绑定或来源证据无效')
type Plain=Record<string,unknown>

function plain(value:unknown,allowed:readonly string[]):Plain {
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))throw invalid()
  const prototype=Object.getPrototypeOf(value)
  if(prototype!==Object.prototype&&prototype!==null)throw invalid()
  const result:Plain=Object.create(null)
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!allowed.includes(key))throw invalid()
    const descriptor=Object.getOwnPropertyDescriptor(value,key)
    if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
    result[key]=descriptor.value
  }
  return result
}
function list(value:unknown):readonly unknown[] {
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype)throw invalid()
  if(value.length>4096)throw invalid()
  const keys=Reflect.ownKeys(value)
  if(keys.length!==value.length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/u.test(key))))throw invalid()
  const output:unknown[]=[]
  for(let index=0;index<value.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index))
    if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
    output.push(descriptor.value)
  }
  return output
}
function id(value:unknown):string {if(!isPlatformIdentifier(value)||value==='0')throw invalid();return value}
function account(value:unknown):PlatformIdentityRef {
  const raw=plain(value,['platform','namespace','id'])
  const platform=id(raw.platform),namespace=id(raw.namespace),accountId=id(raw.id)
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(platform))throw invalid()
  return Object.freeze({platform,namespace,id:accountId})
}
function address(value:unknown):ConversationAddress {
  const raw=plain(value,['account','kind','id']),kind=raw.kind
  if(kind!=='group')throw invalid()
  const result={account:account(raw.account),kind:'group' as const,id:id(raw.id)}
  if(!isConversationAddress(result))throw invalid()
  return Object.freeze(result)
}
function binding(value:unknown):AgentBindingSnapshot {
  const raw=plain(value,['source','id','revision','agentId','personaId','connectionId','target'])
  if(raw.source!=='configured')throw invalid()
  const label=(value:unknown):string=>{
    if(typeof value!=='string'||value.length===0||value.length>4096||value!==value.trim()||/[\u0000-\u001f\u007f]/u.test(value))throw invalid()
    return value
  }
  const result={source:'configured' as const,id:label(raw.id),revision:label(raw.revision),agentId:id(raw.agentId),personaId:id(raw.personaId),connectionId:id(raw.connectionId),target:address(raw.target)}
  return Object.freeze(result)
}
function sameBinding(left:AgentBindingSnapshot,right:AgentBindingSnapshot):boolean {
  return left.source===right.source&&left.id===right.id&&left.revision===right.revision&&left.agentId===right.agentId&&left.personaId===right.personaId&&left.connectionId===right.connectionId&&conversationAddressKey(left.target)===conversationAddressKey(right.target)
}
function permissionList(value:unknown):readonly AgentDiceAuthorizationPermission[] {
  const values=list(value)
  if(values.length>permissions.size||values.some(item=>typeof item!=='string'||!permissions.has(item as AgentDiceAuthorizationPermission))||new Set(values).size!==values.length)throw invalid()
  return Object.freeze([...values] as AgentDiceAuthorizationPermission[])
}
function identity(value:unknown):{id:string;name:string} {
  const raw=plain(value,['id','name'])
  if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>256)throw invalid()
  return Object.freeze({id:id(raw.id),name:raw.name})
}
function memberList(value:unknown):readonly {id:string;name:string}[] {
  const values=list(value)
  if(values.length>4096)throw invalid()
  const members=values.map(identity)
  if(new Set(members.map(member=>member.id)).size!==members.length)throw invalid()
  return Object.freeze(members)
}
function text(value:unknown,max=16_384):string {if(typeof value!=='string'||value.length>max)throw invalid();return value}
function part(value:unknown,onlyText=false):{kind:string;text?:string;user?:PlatformIdentityRef} {
  const kind=plain(value,['kind','text','user','resource','name','id','platform','type']).kind
  if(kind==='text'){
    const raw=plain(value,['kind','text'])
    return {kind,text:text(raw.text)}
  }
  if(kind==='mention'){
    const raw=plain(value,['kind','user'])
    if(raw.user==='everyone')throw invalid()
    return {kind,user:account(raw.user)}
  }
  if(onlyText)throw invalid()
  if(kind==='image'||kind==='audio'||kind==='video'||kind==='file'){
    const raw=plain(value,['kind','resource','name'])
    if(raw.resource!==undefined){
      const resource=plain(raw.resource,['kind','value'])
      if(resource.kind!=='url'&&resource.kind!=='reference')throw invalid()
      text(resource.value)
    }
    if(raw.name!==undefined)text(raw.name,1024)
    return {kind}
  }
  if(kind==='forward'){const raw=plain(value,['kind','id']);id(raw.id);return {kind}}
  if(kind==='extension'){const raw=plain(value,['kind','platform','type']);id(raw.platform);id(raw.type);return {kind}}
  throw invalid()
}
function parts(value:unknown,onlyText=false):readonly ReturnType<typeof part>[] {
  const values=list(value)
  if(values.length>256)throw invalid()
  return values.map(value=>part(value,onlyText))
}
function sourceCheck(source:IncomingMessage,configured:AgentBindingSnapshot,actorId:string,messageId:string):Plain {
  const target=configured.target
  const raw=plain(source,['version','conversation','sender','senderName','messageId','occurredAt','text','parts','mentions','directedToAccount','quote','binding'])
  if(raw.version!==1||raw.messageId!==messageId||raw.messageId!==id(raw.messageId)||typeof raw.occurredAt!=='number'||!Number.isSafeInteger(raw.occurredAt)||raw.occurredAt<=0||!Number.isFinite(new Date(raw.occurredAt).getTime())||typeof raw.text!=='string'||raw.text.length>16_384)throw invalid()
  const sender=account(raw.sender)
  const conversation=address(raw.conversation)
  if(conversationAddressKey(conversation)!==conversationAddressKey(target)||sender.platform!==target.account.platform||sender.namespace!==target.account.namespace)throw invalid()
  if(actorId!==sender.id)throw invalid()
  if(raw.binding!==undefined&&!sameBinding(configured,binding(raw.binding)))throw invalid()
  if(typeof raw.directedToAccount!=='boolean')throw invalid()
  if(raw.senderName!==undefined)text(raw.senderName,256)
  const messageParts=parts(raw.parts,true)
  if(!messageParts.length||messageParts.filter(item=>item.kind==='text').map(item=>item.text).join('')!==raw.text)throw invalid()
  const mentionInputs=list(raw.mentions)
  if(mentionInputs.length>128)throw invalid()
  const mentions=mentionInputs.map(account)
  if(mentions.some(user=>user.platform!==sender.platform||user.namespace!==sender.namespace)||new Set(mentions.map(user=>user.id)).size!==mentions.length)throw invalid()
  for(const item of messageParts)if(item.user&&!mentions.some(user=>user.id===item.user!.id&&user.platform===item.user!.platform&&user.namespace===item.user!.namespace))throw invalid()
  if(raw.quote!==undefined){
    const quote=plain(raw.quote,['messageId','author','authorName','text','parts'])
    if(quote.messageId!==undefined)id(quote.messageId)
    if(quote.author!==undefined)account(quote.author)
    if(quote.authorName!==undefined)text(quote.authorName,256)
    if(quote.text!==undefined)text(quote.text)
    parts(quote.parts)
  }
  return raw
}

/**
 * Resolves one captured host grant against the exact source and fresh membership.
 * It never discovers roles, reads native events, or derives stronger permissions.
 */
export function resolveAgentDiceAuthorization(input:AgentDiceAuthorizationInput):AgentDiceEngineAuthorization|undefined {
  try {
    const root=plain(input,['binding','source','grant','evidence'])
    const configured=binding(root.binding),grantRaw=plain(root.grant,['binding','revision','actorId','permissions','subjects'])
    const grantBinding=binding(grantRaw.binding),evidenceRaw=plain(root.evidence,['binding','sourceMessageId','actor','members','botUserId','verifiedReplyAuthorId'])
    const evidenceBinding=binding(evidenceRaw.binding)
    if(!sameBinding(configured,grantBinding)||!sameBinding(configured,evidenceBinding))throw invalid()
    const revision=id(grantRaw.revision)
    const grantPermissions=permissionList(grantRaw.permissions)
    if(!grantPermissions.includes('player'))throw invalid()
    const actorId=id(grantRaw.actorId),actor=identity(evidenceRaw.actor)
    if(actor.id!==actorId)throw invalid()
    const members=memberList(evidenceRaw.members)
    const freshActor=members.find(member=>member.id===actor.id)
    if(!freshActor||freshActor.name!==actor.name)throw invalid()
    if(evidenceRaw.sourceMessageId!==id(evidenceRaw.sourceMessageId))throw invalid()
    const source=sourceCheck(root.source as IncomingMessage,configured,actor.id,evidenceRaw.sourceMessageId)
    const subjectEntries=evidenceRawMembers(grantRaw.subjects)
    for(const subject of subjectEntries)if(!members.some(member=>member.id===subject.id)||subject.id===actor.id)throw invalid()
    const memberPermissions=new Map(subjectEntries.map(subject=>[subject.id,new Set(subject.permissions)]))
    const actorSet=new Set(grantPermissions)
    const outputMembers:AgentDiceEngineMember[]=members.map(member=>{
      const candidate=member.id===actor.id?grantPermissions:[...(memberPermissions.get(member.id)??new Set())].filter(permission=>actorSet.has(permission))
      return candidate.length?Object.freeze({id:member.id,name:member.name,permissions:Object.freeze(candidate) as AgentDiceEnginePermission[]}):Object.freeze({id:member.id,name:member.name})
    })
    const output:AgentDiceEngineAuthorization={revision,actor:Object.freeze({id:actor.id,name:actor.name}),permissions:Object.freeze([...grantPermissions]),members:Object.freeze(outputMembers),...(evidenceRaw.botUserId===undefined?{}:{botUserId:id(evidenceRaw.botUserId)}),...(evidenceRaw.verifiedReplyAuthorId===undefined?{}:{replyAuthorId:id(evidenceRaw.verifiedReplyAuthorId)})}
    if(output.replyAuthorId!==undefined){
      const quote=plain(source.quote,['messageId','author','authorName','text','parts']),author=account(quote.author)
      id(quote.messageId)
      if(author.id!==output.replyAuthorId||author.platform!==configured.target.account.platform||author.namespace!==configured.target.account.namespace||!members.some(member=>member.id===output.replyAuthorId))throw invalid()
    }
    if(output.botUserId!==undefined&&output.botUserId===actor.id)throw invalid()
    return Object.freeze(output)
  } catch { return undefined }
}

function evidenceRawMembers(value:unknown):readonly {id:string;permissions:readonly AgentDiceAuthorizationPermission[]}[] {
  if(value===undefined)return Object.freeze([])
  const values=list(value)
  if(values.length>4096)throw invalid()
  const entries=values.map(value=>{
    const raw=plain(value,['id','permissions']),entry={id:id(raw.id),permissions:permissionList(raw.permissions)}
    return Object.freeze(entry)
  })
  if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw invalid()
  return Object.freeze(entries)
}
