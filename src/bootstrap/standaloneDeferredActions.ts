import {types} from 'node:util'
import type {AgentDeferredActionSource} from '../contracts/agentDeferredAction.js'
import type {AgentDeferredActionPolicyConfig,AgentDeferredActionRule} from '../modules/tools/infrastructure/agentDeferredActionPolicy.js'
import {decodeAgentConversationKey,isPlatformIdentifier} from '../modules/runtime/domain/agentBindings.js'

export type StandaloneDeferredMigrationApproval=Readonly<Omit<Extract<AgentDeferredActionSource,{kind:'migration'}>,'kind'>>
export type StandaloneDeferredActionsConfig=Readonly<AgentDeferredActionPolicyConfig & {
  enabled:boolean
  rules:readonly AgentDeferredActionRule[]
  migrationApprovals:readonly StandaloneDeferredMigrationApproval[]
}>
const root='tools.deferredActions'
const ruleFields=['id','revision','bindingIdentity','scopeKey','creatorIds','tool','executor','definitionId','maxDelayMs','executionWindowMs'] as const
function invalid(path:string):never {throw new Error(`${path} 配置无效`)}
function object(input:unknown,path:string,allowed:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||types.isProxy(input)||Array.isArray(input)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(input)))invalid(path)
  const value:Record<string,unknown>=Object.create(null)
  for(const key of Reflect.ownKeys(input)){
    const field=Object.getOwnPropertyDescriptor(input,key)
    if(typeof key!=='string'||!allowed.includes(key)||!field||!('value'in field)||!field.enumerable)invalid(path)
    value[key]=field.value
  }
  return value
}
function array(input:unknown,path:string,maximum:number,minimum=0):unknown[] {
  if(types.isProxy(input)||!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||
    input.length<minimum||input.length>maximum||Reflect.ownKeys(input).length!==input.length+1)invalid(path)
  const values:unknown[]=[]
  for(let index=0;index<input.length;index++){
    const field=Object.getOwnPropertyDescriptor(input,String(index))
    if(!field||!('value'in field)||!field.enumerable)invalid(path)
    values.push(field.value)
  }
  return values
}
function text(input:unknown,path:string,maximum:number):string {
  if(typeof input!=='string'||!input.trim()||input.length>maximum)invalid(path)
  return input
}
function integer(input:unknown,path:string,maximum:number):number {
  if(typeof input!=='number'||!Number.isSafeInteger(input)||input<1000||input>maximum)invalid(path)
  return input
}
function identity(input:unknown,path:string):{value:string;agentId:string} {
  const value=text(input,path,8192)
  let entries:unknown
  try {entries=JSON.parse(value)}catch{invalid(path)}
  if(!Array.isArray(entries)||entries.length!==5||JSON.stringify(entries)!==value)invalid(path)
  const [source,id,agentId,personaId,connectionId]=entries
  const internal=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
  if(source!=='configured'||typeof id!=='string'||!id||id.length>4096||id!==id.trim()||/[\u0000-\u001f\u007f]/u.test(id)||
    !internal(agentId)||!isPlatformIdentifier(personaId)||!internal(connectionId))invalid(path)
  return {value,agentId}
}
function rule(input:unknown,index:number):AgentDeferredActionRule {
  const path=`${root}.rules[${index}]`,value=object(input,path,ruleFields)
  const id=text(value.id,`${path}.id`,128)
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(id))invalid(`${path}.id`)
  const revision=text(value.revision,`${path}.revision`,256)
  const binding=identity(value.bindingIdentity,`${path}.bindingIdentity`)
  const scopeKey=text(value.scopeKey,`${path}.scopeKey`,8192),scope=decodeAgentConversationKey(scopeKey)
  if(!scope||scope.target.kind!=='group'||scope.agentId!==binding.agentId)invalid(`${path}.scopeKey`)
  const creatorIds=array(value.creatorIds,`${path}.creatorIds`,128,1)
  if(!creatorIds.every(isPlatformIdentifier)||new Set(creatorIds).size!==creatorIds.length)invalid(`${path}.creatorIds`)
  const tool=text(value.tool,`${path}.tool`,128)
  if(!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(tool))invalid(`${path}.tool`)
  const executor=value.executor
  if(executor!=='builtin'&&executor!=='custom'&&executor!=='mcp')invalid(`${path}.executor`)
  const definitionId=text(value.definitionId,`${path}.definitionId`,512)
  const maxDelayMs=integer(value.maxDelayMs,`${path}.maxDelayMs`,365*86_400_000)
  const executionWindowMs=Object.hasOwn(value,'executionWindowMs')?
    integer(value.executionWindowMs,`${path}.executionWindowMs`,86_400_000):300_000
  return Object.freeze({id,revision,bindingIdentity:binding.value,scopeKey,creatorIds:Object.freeze(creatorIds as string[]),
    tool,executor,definitionId,maxDelayMs,executionWindowMs})
}
function migrationApproval(input:unknown,index:number):StandaloneDeferredMigrationApproval {
  const path=`${root}.migrationApprovals[${index}]`,value=object(input,path,['id','sourceHash','authorizedBy','at'])
  const {id,sourceHash,authorizedBy,at}=value
  if(!isPlatformIdentifier(id))invalid(`${path}.id`)
  if(typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(sourceHash))invalid(`${path}.sourceHash`)
  if(!isPlatformIdentifier(authorizedBy))invalid(`${path}.authorizedBy`)
  if(typeof at!=='number'||!Number.isSafeInteger(at)||at<=0||!Number.isFinite(new Date(at).getTime()))invalid(`${path}.at`)
  return Object.freeze({id,sourceHash,authorizedBy,at})
}

/** Parse this tools section only. It does not contact tools, accounts or credential providers. */
export function readStandaloneDeferredActionsConfig(input:unknown):StandaloneDeferredActionsConfig {
  if(input===undefined)return Object.freeze({enabled:false,rules:Object.freeze([]),migrationApprovals:Object.freeze([])})
  const value=object(input,root,['enabled','rules','migrationApprovals'])
  if(Object.hasOwn(value,'enabled')&&typeof value.enabled!=='boolean')invalid(`${root}.enabled`)
  const enabled=value.enabled===true
  const values=Object.hasOwn(value,'rules')?array(value.rules,`${root}.rules`,128):[]
  const rules=values.map(rule),seenIds=new Set<string>(),seenPermissions=new Set<string>()
  for(let index=0;index<rules.length;index++){
    const rule=rules[index]!
    if(seenIds.has(rule.id))invalid(`${root}.rules[${index}].id`)
    seenIds.add(rule.id)
    for(const creator of rule.creatorIds){
      const permission=JSON.stringify([rule.bindingIdentity,rule.scopeKey,creator,rule.tool,rule.executor,rule.definitionId])
      if(seenPermissions.has(permission))invalid(`${root}.rules[${index}]`)
      seenPermissions.add(permission)
    }
  }
  const approvals=Object.hasOwn(value,'migrationApprovals')?array(value.migrationApprovals,`${root}.migrationApprovals`,128):[]
  const migrationApprovals=approvals.map(migrationApproval),seenApprovalIds=new Set<string>()
  for(let index=0;index<migrationApprovals.length;index++){
    const approval=migrationApprovals[index]!
    if(seenApprovalIds.has(approval.id))invalid(`${root}.migrationApprovals[${index}].id`)
    seenApprovalIds.add(approval.id)
  }
  return Object.freeze({enabled,rules:Object.freeze(rules),migrationApprovals:Object.freeze(migrationApprovals)})
}
