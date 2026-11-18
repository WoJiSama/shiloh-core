import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {PlatformUserRef} from '../../../contracts/agentBinding.js'
import type {AgentDeferredActionData,AgentDeferredActionGrant,AgentDeferredFrozenAction,AgentDeferredJson,AgentDeferredParams} from '../../../contracts/agentDeferredAction.js'

function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('延期动作数据无效')
  return value as Record<string,unknown>
}
function text(value:unknown,max=8192):value is string{return typeof value==='string'&&value.length>0&&value.length<=max}
function time(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0}

/** Do not run getters/toJSON, accept prototypes, discard fields or coerce invalid numbers. */
function jsonCopy(value:unknown,seen=new Set<unknown>(),depth=0):AgentDeferredJson {
  if(depth>16)throw new Error('延期动作参数过深')
  if(value===null||typeof value==='boolean'||typeof value==='string')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||seen.has(value))throw new Error('延期动作参数必须是闭合JSON')
  if(types.isProxy(value))throw new Error('延期动作参数不能含Proxy')
  const proto=Object.getPrototypeOf(value)
  if(Array.isArray(value)?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw new Error('延期动作参数原型无效')
  seen.add(value)
  try{
    const fields=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(fields)
    if(keys.some(key=>typeof key!=='string'||key==='__proto__'||key==='constructor'||key==='prototype'))throw new Error('延期动作参数字段无效')
    if(Array.isArray(value)){
      if(value.length>1000||keys.length!==value.length+1)throw new Error('延期动作参数数组无效')
      const out:AgentDeferredJson[]=[]
      for(let i=0;i<value.length;i++){
        const field=fields[String(i)]
        if(!field||!('value'in field)||!field.enumerable)throw new Error('延期动作参数数组无效')
        out.push(jsonCopy(field.value,seen,depth+1))
      }
      return Object.freeze(out)
    }
    if(keys.length>256)throw new Error('延期动作参数字段过多')
    const out:Record<string,AgentDeferredJson>={}
    for(const key of (keys as string[]).sort()){
      const field=fields[key]!
      if(!('value'in field)||!field.enumerable)throw new Error('延期动作参数不能含访问器')
      out[key]=jsonCopy(field.value,seen,depth+1)
    }
    return Object.freeze(out)
  }finally{seen.delete(value)}
}

export function freezeDeferredAction(input:{tool:string;executor:string;definitionId:string;params:unknown}):AgentDeferredFrozenAction {
  if(!text(input.tool,128)||!['builtin','custom','mcp'].includes(input.executor)||!text(input.definitionId,512))throw new Error('延期工具定义无效')
  object(input.params)
  const params=jsonCopy(input.params) as AgentDeferredParams
  if(Buffer.byteLength(JSON.stringify(params),'utf8')>16_000)throw new Error('延期动作参数超过16KB')
  return Object.freeze({tool:input.tool,executor:input.executor as AgentDeferredFrozenAction['executor'],definitionId:input.definitionId,params})
}

export function deferredActionHash(action:AgentDeferredFrozenAction):string {
  const normalized=freezeDeferredAction(action)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function decodeGrant(value:unknown):AgentDeferredActionGrant {
  const grant=object(jsonCopy(value)),creator=object(grant.creator),source=object(grant.source)
  if(grant.version!==1||!text(grant.id,256)||!text(grant.ruleId,128)||!text(grant.ruleRevision,256)||
    !text(grant.bindingIdentity)||!text(grant.scopeKey)||!text(creator.platform,128)||!text(creator.namespace,128)||!text(creator.id,256)||
    typeof grant.actionHash!=='string'||!/^[a-f0-9]{64}$/u.test(grant.actionHash)||!time(grant.dueAt)||grant.dueAt<=0||!time(grant.issuedAt)||!time(grant.expiresAt)||grant.expiresAt<=grant.issuedAt||
    !time(source.at)||(source.kind==='message'? !text(source.messageId,256):
      source.kind!=='migration'||!text(source.id,256)||!text(source.authorizedBy,256)||typeof source.sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(source.sourceHash)))throw new Error('延期委托授权数据无效')
  return grant as unknown as AgentDeferredActionGrant
}

export function assertDeferredGrant(value:AgentDeferredActionGrant,action:AgentDeferredFrozenAction,bindingIdentity:string,creator:PlatformUserRef,scopeKey?:string):void {
  const grant=decodeGrant(value)
  if(grant.bindingIdentity!==bindingIdentity||grant.creator.id!==creator.id||grant.creator.platform!==creator.platform||grant.creator.namespace!==creator.namespace||
    (scopeKey!==undefined&&grant.scopeKey!==scopeKey)||grant.actionHash!==deferredActionHash(action))throw new Error('延期委托授权与动作或归属不符')
}

export function decodeAgentDeferredAction(value:unknown):AgentDeferredActionData {
  const data=object(jsonCopy(value)),rawAction=object(data.action)
  const action=freezeDeferredAction({tool:rawAction.tool as string,executor:rawAction.executor as string,definitionId:rawAction.definitionId as string,params:rawAction.params})
  const grant=decodeGrant(data.grant)
  assertDeferredGrant(grant,action,grant.bindingIdentity,grant.creator)
  if(data.version!==1||!['pending','executing','succeeded','failed','unknown'].includes(String(data.state))||!time(data.attemptedAt)||!time(data.settledAt)||
    typeof data.resultCode!=='string'||data.resultCode.length>128||
    (data.state==='pending'&&(data.attemptedAt!==0||data.settledAt!==0))||
    (data.state!=='pending'&&data.attemptedAt<=0&&!(data.state==='unknown'&&data.legacy!==undefined))||
    (['succeeded','failed'].includes(String(data.state))&&data.settledAt<data.attemptedAt))throw new Error('延期动作执行状态无效')
  if(data.legacy!==undefined){
    const legacy=object(data.legacy),mapping=object(legacy.explicitToolMapping)
    if(legacy.kind!=='legacy-qq-reminder'||!text(legacy.detailKey,1024)||typeof legacy.rawSha256!=='string'||!/^[a-f0-9]{64}$/u.test(legacy.rawSha256)||
      !['pending','sending','unknown','failed','completed','cancelled'].includes(String(legacy.originalStatus))||
      !time(legacy.originalCreatedAt)||!time(legacy.originalUpdatedAt)||!time(legacy.originalTriggerTime)||typeof legacy.originalExtraAttempted!=='boolean'||
      !(legacy.originalMessageId===null||text(legacy.originalMessageId,256)||typeof legacy.originalMessageId==='number'&&Number.isSafeInteger(legacy.originalMessageId))||
      !text(mapping.from,128)||mapping.to!==action.tool||mapping.definitionId!==action.definitionId||mapping.executor!==action.executor)throw new Error('延期动作迁移来源无效')
  }
  return {...data,action,grant} as unknown as AgentDeferredActionData
}
