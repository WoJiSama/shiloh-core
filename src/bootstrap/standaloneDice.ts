import {createHash} from 'node:crypto'
import {types} from 'node:util'
import YAML from 'yaml'
import type {AgentBindingSnapshot,ConversationAddress,ConversationKind,PlatformIdentityRef} from '../contracts/agentBinding.js'
import type {IncomingMessage} from '../contracts/platformMessage.js'
import {conversationAddressKey,isConversationAddress,isPlatformIdentifier} from '../modules/runtime/domain/agentBindings.js'
import {createAgentDiceBuiltin,type AgentDiceBuiltinConfig} from '../modules/dice/infrastructure/agentDiceBuiltin.js'
import {resolveAgentDiceAuthorization,type AgentDiceAuthorizationGrant,type AgentDiceAuthorizationPermission} from '../modules/dice/infrastructure/agentDiceAuthorization.js'
import type {AgentDiceEngineConfig} from '../modules/dice/infrastructure/agentDiceEngine.js'
import {createAgentDiceRulePackages} from '../modules/dice/infrastructure/agentDiceRulePackages.js'
import {DICE_RULE_MAX_PACKAGE_BYTES,validateDiceRulePack} from '../modules/dice/infrastructure/DiceRuleSchema.js'
import type {AgentDiceStateGuard} from '../modules/dice/infrastructure/agentDiceState.js'

export interface StandaloneDiceRulePackage {
  readonly kind:'yaml'
  readonly source:string
  readonly revision:string
  readonly sourceHash:string
}
export interface StandaloneDiceEngineConfig {
  readonly enabled:boolean
  readonly revision?:string
  readonly deliveryTimeoutMs?:number
  readonly builtin:AgentDiceBuiltinConfig
  readonly rulePackages:readonly StandaloneDiceRulePackage[]
  readonly grants:readonly AgentDiceAuthorizationGrant[]
}
export interface StandaloneDiceRuntime {
  readonly diceEngine:AgentDiceEngineConfig|undefined
  readDiceGrant(request:{readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage},guard:AgentDiceStateGuard):Promise<AgentDiceAuthorizationGrant|undefined>
}

type Plain=Record<string,unknown>
const ownedConfigs=new WeakSet<StandaloneDiceEngineConfig>()
const permissionNames=new Set<AgentDiceAuthorizationPermission>(['player','gm','admin','master','delegate','hidden','card'])
const invalid=()=>new Error('独立骰子引擎配置、授权或来源无效')
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
function own(value:unknown,allowed?:readonly string[]):Plain {
  if(!value||typeof value!=='object'||types.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid()
  const output:Plain=Object.create(null)
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||allowed&&!allowed.includes(key))throw invalid()
    const descriptor=Object.getOwnPropertyDescriptor(value,key)
    if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
    output[key]=descriptor.value
  }
  return output
}
function list(value:unknown,max=4096):readonly unknown[] {
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)throw invalid()
  const keys=Reflect.ownKeys(value)
  if(keys.length!==value.length+1||keys.some(key=>key!=='length'&&(typeof key!=='string'||!/^(0|[1-9][0-9]*)$/u.test(key))))throw invalid()
  return Array.from({length:value.length},(_,index)=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index))
    if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
    return descriptor.value
  })
}
function copy(value:unknown,seen=new Set<object>(),depth=0):unknown {
  if(depth>32)throw invalid()
  if(value===undefined||value===null||typeof value==='string'||typeof value==='boolean')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))throw invalid()
  seen.add(value)
  try {
    if(Array.isArray(value))return list(value).map(item=>copy(item,seen,depth+1))
    const raw=own(value),result:Plain={}
    if(Object.keys(raw).length>4096)throw invalid()
    for(const [key,item]of Object.entries(raw))result[key]=copy(item,seen,depth+1)
    return result
  } finally {seen.delete(value)}
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value)}
  return value
}
function id(value:unknown):string {if(!isPlatformIdentifier(value)||value==='0')throw invalid();return value}
function label(value:unknown):string {
  if(typeof value!=='string'||!value||value==='0'||value.length>4096||value!==value.trim()||/[\u0000-\u001f\u007f]/u.test(value))throw invalid()
  return value
}
function account(value:unknown):PlatformIdentityRef {
  const raw=own(value,['platform','namespace','id']),platform=id(raw.platform)
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(platform))throw invalid()
  return freeze({platform,namespace:id(raw.namespace),id:id(raw.id)})
}
function binding(value:unknown,groupOnly=false):AgentBindingSnapshot {
  const raw=own(value,['source','id','revision','agentId','personaId','connectionId','target'])
  const target=own(raw.target,['account','kind','id'])
  if(raw.source!=='configured'||typeof target.kind!=='string'||!['group','private','channel','thread'].includes(target.kind)||groupOnly&&target.kind!=='group')throw invalid()
  const address:ConversationAddress={account:account(target.account),kind:target.kind as ConversationKind,id:id(target.id)}
  if(!isConversationAddress(address))throw invalid()
  return freeze({source:'configured',id:label(raw.id),revision:label(raw.revision),agentId:id(raw.agentId),personaId:id(raw.personaId),connectionId:id(raw.connectionId),target:address})
}
function bindingKey(value:AgentBindingSnapshot):string {
  return JSON.stringify([value.source,value.id,value.revision,value.agentId,value.personaId,value.connectionId,conversationAddressKey(value.target)])
}
function permissions(value:unknown):readonly AgentDiceAuthorizationPermission[] {
  const values=list(value,permissionNames.size)
  if(values.some(item=>typeof item!=='string'||!permissionNames.has(item as AgentDiceAuthorizationPermission))||new Set(values).size!==values.length)throw invalid()
  return freeze([...values] as AgentDiceAuthorizationPermission[])
}
function proofMembers(grant:AgentDiceAuthorizationGrant):readonly {id:string;name:string}[] {
  return [{id:grant.actorId,name:grant.actorId},...(grant.subjects??[]).map(subject=>({id:subject.id,name:subject.id}))]
}
/** This checks grant/source syntax only. The Core host bridge still requires fresh membership. */
function validSource(grant:AgentDiceAuthorizationGrant,source:IncomingMessage):boolean {
  const members=proofMembers(grant)
  return !!resolveAgentDiceAuthorization({binding:grant.binding,source,grant,evidence:{binding:grant.binding,sourceMessageId:source.messageId!,actor:members[0]!,members,botUserId:grant.binding.target.account.id}})
}
function grant(value:unknown,configured:ReadonlySet<string>):AgentDiceAuthorizationGrant {
  const raw=own(value,['binding','revision','actorId','permissions','subjects'])
  const owner=binding(raw.binding,true)
  if(!configured.has(bindingKey(owner)))throw invalid()
  const subjects=raw.subjects===undefined?undefined:list(raw.subjects).map(value=>{
    const subject=own(value,['id','permissions'])
    return {id:id(subject.id),permissions:permissions(subject.permissions)}
  })
  const result:AgentDiceAuthorizationGrant=freeze({binding:owner,revision:id(raw.revision),actorId:id(raw.actorId),permissions:permissions(raw.permissions),...(subjects===undefined?{}:{subjects})})
  const source:IncomingMessage={version:1,conversation:owner.target,sender:{...owner.target.account,id:result.actorId},messageId:'standalone-dice-config-validation',occurredAt:1,text:'',parts:[{kind:'text',text:''}],mentions:[],directedToAccount:false,binding:owner}
  if(!validSource(result,source))throw invalid()
  return result
}
function rulePackage(value:unknown):{input:StandaloneDiceRulePackage;id:string;aliases:readonly string[]} {
  const raw=own(value,['kind','source','revision','sourceHash'])
  if(raw.kind!=='yaml'||typeof raw.source!=='string'||!raw.source||Buffer.byteLength(raw.source)>DICE_RULE_MAX_PACKAGE_BYTES||typeof raw.revision!=='string'||!raw.revision.trim()||raw.revision.length>256||typeof raw.sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(raw.sourceHash)||sha(raw.source)!==raw.sourceHash)throw invalid()
  const result=validateDiceRulePack(YAML.parse(raw.source,{maxAliasCount:50}))
  if(!result.ok)throw invalid()
  return {input:freeze({kind:'yaml',source:raw.source,revision:raw.revision,sourceHash:raw.sourceHash}),id:result.pack.id,aliases:[result.pack.id,...(result.pack.aliases??[])]}
}

/** Pure configuration capture: inline YAML and explicit grants only; no I/O or compilation. */
export function readStandaloneDiceEngine(value:unknown,bindings:readonly AgentBindingSnapshot[]):StandaloneDiceEngineConfig|undefined {
  if(value===undefined)return undefined
  const dice=own(value,['enabled','maxDiceCount','maxDiceSides','maxRounds','engine'])
  if(dice.enabled!==undefined&&typeof dice.enabled!=='boolean')throw invalid()
  if(dice.engine===undefined)return undefined
  const raw=own(dice.engine,['enabled','revision','deliveryTimeoutMs','builtin','rulePackages','grants'])
  if(typeof raw.enabled!=='boolean')throw invalid()
  const enabled=dice.enabled===true&&raw.enabled
  const revision=raw.revision===undefined?undefined:id(raw.revision)
  const deliveryTimeoutMs=raw.deliveryTimeoutMs
  if(deliveryTimeoutMs!==undefined&&(typeof deliveryTimeoutMs!=='number'||!Number.isSafeInteger(deliveryTimeoutMs)||deliveryTimeoutMs<100||deliveryTimeoutMs>120_000))throw invalid()
  const limits:Plain={}
  for(const name of ['maxDiceCount','maxDiceSides','maxRounds'] as const)if(dice[name]!==undefined)limits[name]=dice[name]
  const builtin=freeze({...limits,...(raw.builtin===undefined?{}:own(copy(raw.builtin)))}) as AgentDiceBuiltinConfig
  createAgentDiceBuiltin(builtin)
  const packages=(raw.rulePackages===undefined?[]:list(raw.rulePackages,128)).map(rulePackage),ids=new Set<string>(),aliases=new Set<string>()
  for(const pack of packages){
    if(ids.has(pack.id))throw invalid()
    ids.add(pack.id)
    for(const alias of new Set(pack.aliases)){
      const key=alias.toLowerCase()
      if(aliases.has(key))throw invalid()
      aliases.add(key)
    }
  }
  const configured=new Set(list(bindings).map(value=>bindingKey(binding(value))))
  const grants=(raw.grants===undefined?[]:list(raw.grants)).map(value=>grant(value,configured)),grantKeys=new Set<string>()
  for(const item of grants){
    const key=JSON.stringify([bindingKey(item.binding),item.actorId])
    if(grantKeys.has(key))throw invalid()
    grantKeys.add(key)
  }
  if(enabled&&!grants.length)throw invalid()
  const result:StandaloneDiceEngineConfig=freeze({enabled,...(revision===undefined?{}:{revision}),...(deliveryTimeoutMs===undefined?{}:{deliveryTimeoutMs}),builtin,rulePackages:packages.map(pack=>pack.input),grants})
  ownedConfigs.add(result)
  return result
}

/** Startup repeats the YAML compiler's hash/schema/set checks before exposing the engine. */
export async function createStandaloneDiceRuntime(config:StandaloneDiceEngineConfig|undefined,isCurrent:()=>boolean):Promise<StandaloneDiceRuntime> {
  if(typeof isCurrent!=='function'||config!==undefined&&!ownedConfigs.has(config))throw invalid()
  const current=()=>{try{return isCurrent()===true}catch{return false}}
  if(!current())throw invalid()
  const packages=config===undefined?undefined:await createAgentDiceRulePackages(config.rulePackages)
  if(!current())throw invalid()
  const diceEngine:AgentDiceEngineConfig|undefined=config===undefined?undefined:freeze({enabled:config.enabled,...(config.revision===undefined?{}:{revision:config.revision}),...(config.deliveryTimeoutMs===undefined?{}:{deliveryTimeoutMs:config.deliveryTimeoutMs}),builtin:config.builtin,rulePackages:packages!.packages})
  const grants=new Map(config?.grants.map(grant=>[JSON.stringify([bindingKey(grant.binding),grant.actorId]),grant])??[])
  return Object.freeze({diceEngine,async readDiceGrant(request:{readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage},guard:AgentDiceStateGuard):Promise<AgentDiceAuthorizationGrant|undefined>{
    if(!config?.enabled)return undefined
    const allowed=()=>{try{return current()&&!guard.signal.aborted&&guard.isCurrent()===true}catch{return false}}
    try {
      if(!allowed())return undefined
      const raw=own(request,['binding','source']),owner=binding(raw.binding,true),source=freeze(copy(raw.source)) as IncomingMessage
      const sender=account(own(source,['version','conversation','sender','senderName','messageId','occurredAt','text','parts','mentions','directedToAccount','quote','binding']).sender)
      const captured=grants.get(JSON.stringify([bindingKey(owner),sender.id]))
      if(!captured||bindingKey(captured.binding)!==bindingKey(owner)||!validSource(captured,source))return undefined
      await guard.ensureCurrent?.()
      return allowed()&&validSource(captured,source)?captured:undefined
    } catch {return undefined}
  }})
}
