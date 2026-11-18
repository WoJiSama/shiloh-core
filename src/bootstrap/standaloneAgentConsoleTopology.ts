import {types} from 'node:util'
import YAML from 'yaml'
import {AgentConsoleError} from '../contracts/agentConsole.js'
import type {AgentConsoleJson} from '../contracts/agentConsole.js'
import type {ConversationAddress,PlatformAccountRef} from '../contracts/agentBinding.js'
import type {ConfigSources} from './standaloneAgentConfigSources.js'
import {parseOneBotReverseUrl,parseOneBotUrl} from '../adapters/oneBotConnection.js'
import {qqId,validateQqBindingAddress} from '../adapters/qqIdentity.js'
import {agentConversationKey,createAgentBindingDirectory} from '../modules/runtime/domain/agentBindings.js'
import {normalizePersonaEntry,PERSONA_ENTRY_FIELDS} from '../modules/conversation/infrastructure/personaLibrary.js'
import {normalizeSimToolPolicy,resolveSimToolSurface} from '../modules/simulation/domain/toolPolicy.js'
import {groupTextToolNames} from '../modules/conversation/infrastructure/groupTextTools.js'

type Data=Record<string,unknown>
type Transport='forward-websocket'|'reverse-websocket'
interface Connection {id:string;account:PlatformAccountRef;transport:Transport}
interface Conversation {agentId:string;connectionId:string;target:ConversationAddress}
export interface StandaloneAgentTopologyCatalog {
  agents:readonly {agentId:string;personaId:string}[]
  personas:readonly {id:string;name:string}[]
  connections:readonly Connection[]
}
export interface StandaloneAgentTopologyChange {
  sources:ConfigSources
  changes:readonly {file:'host'|'personas'|'bindings';path:string;action:'add'|'change';before:AgentConsoleJson;after:AgentConsoleJson}[]
  affected:{agents:readonly string[];connections:readonly {id:string;account:PlatformAccountRef}[];conversations:readonly Conversation[]}
  permissions:readonly {scopeKey:string;mode:'text'|'simulation'|'private-disabled'|'private';tools:readonly string[];note:string}[]
}
const fail=():never=>{throw new AgentConsoleError('invalid_request')}
function record(value:unknown):Data {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail()
  return value as Data
}
function fields(value:Data,allowed:readonly string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))fail()}
function text(value:unknown,max=32768,empty=true):string {
  if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))return fail()
  return value
}
function internalId(value:unknown):string {
  const id=text(value,64,false)
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id))return fail()
  return id
}
function personaId(value:unknown):string {
  const id=text(value,128,false)
  if(id!==id.trim()||/[\r\n\t]/u.test(id))return fail()
  return id
}
function qq(value:unknown):string {
  const id=text(value,128,false)
  if(qqId(id)!==id)return fail()
  return id
}
function list(value:unknown,maximum=10000):unknown[]{if(!Array.isArray(value)||value.length>maximum)return fail();return value}
function json(value:unknown):AgentConsoleJson {return JSON.parse(JSON.stringify(value)) as AgentConsoleJson}
/** Inspect descriptors rather than executing getters, proxies or toJSON on a request. */
function inputCopy(value:unknown,depth=0,seen=new Set<unknown>()):unknown {
  if(depth>12)return fail()
  if(value===null||typeof value==='boolean'||typeof value==='string')return value
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(!value||typeof value!=='object'||types.isProxy(value)||seen.has(value))return fail()
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value)
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)return fail()
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors)
  if(keys.some(key=>typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))||keys.length>1000)return fail()
  seen.add(value)
  try{
    if(array){
      if(keys.length!==value.length+1)return fail()
      return Array.from({length:value.length},(_,index)=>{
        const descriptor=descriptors[String(index)]
        if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)return fail()
        return inputCopy(descriptor.value,depth+1,seen)
      })
    }
    return Object.fromEntries((keys as string[]).map(key=>{
      const descriptor=descriptors[key]!
      if(!('value' in descriptor)||!descriptor.enumerable)return fail()
      return [key,inputCopy(descriptor.value,depth+1,seen)]
    }))
  }finally{seen.delete(value)}
}
function document(source:string|undefined,optional=false){
  if(source===undefined&&!optional)return fail()
  if(source!==undefined&&(typeof source!=='string'||Buffer.byteLength(source)>2*1024*1024))return fail()
  const doc:YAML.Document=YAML.parseDocument(source??'')
  if(doc.errors.length)return fail()
  if(source===undefined)doc.contents=doc.createNode({})
  record(doc.toJS({maxAliasCount:100}))
  return doc
}
function persona(value:unknown,input=false):Data {
  const raw=record(value)
  if(input)fields(raw,['id',...PERSONA_ENTRY_FIELDS])
  const id=personaId(raw.id),name=text(raw.name,200,false).trim()
  if(id==='default')return fail()
  const clean:Data={id,name}
  for(const key of PERSONA_ENTRY_FIELDS){
    if(key==='name'||!Object.hasOwn(raw,key))continue
    const value=raw[key]
    if(['speechStyle','preferences','boundaries'].includes(key))clean[key]=list(value,256).map(item=>text(item,1000))
    else if(key==='moods')clean[key]=list(value,100).map(item=>{
      const mood=record(item)
      if(input)fields(mood,['name','hint','probability'])
      const result:Data={name:text(mood.name,200,false),hint:text(mood.hint,2000)}
      if(mood.probability!==undefined){
        if(typeof mood.probability!=='number'||!Number.isFinite(mood.probability)||mood.probability<0||mood.probability>1)return fail()
        result.probability=mood.probability
      }
      return result
    })
    else clean[key]=text(value)
  }
  return {id,...normalizePersonaEntry(clean)}
}
function parse(sources:ConfigSources){
  const host=document(sources.host),library=document(sources.personas,true),bindings=document(sources.bindings)
  const rawHost=record(host.toJS()),rawLibrary=record(library.toJS()),rawBindings=record(bindings.toJS())
  const directory=createAgentBindingDirectory(rawBindings,'topology-candidate',validateQqBindingAddress)
  for(const value of list(rawBindings.connections)){
    const connection=record(value)
    if(connection.platform==='qq'){
      if(connection.namespace!=='global')return fail()
      qq(connection.accountId)
    }
  }
  const agents=list(rawBindings.agents).map(value=>{const agent=record(value);return {agentId:internalId(agent.id),personaId:personaId(agent.personaId)}})
  const templates=list(rawLibrary.personas??[],500).map(value=>persona(value)),names=new Set<string>(),ids=new Set<string>()
  for(const entry of templates){
    const id=String(entry.id),name=String(entry.name).toLowerCase()
    if(ids.has(id)||names.has(name))return fail()
    ids.add(id);names.add(name)
  }
  for(const agent of agents)if(agent.personaId!=='default'&&!ids.has(agent.personaId)||ids.has('agent:'+agent.agentId))return fail()
  for(const key of ['groupBindings','accountBindings'])if(rawLibrary[key]!==undefined){
    for(const [id,value] of Object.entries(record(rawLibrary[key]))){
      if(!id||id!==id.trim()||/[\u0000-\u001f\u007f]/u.test(id)||value!=='default'&&!ids.has(personaId(value)))return fail()
    }
  }
  if(rawLibrary.privateBinding!==undefined&&rawLibrary.privateBinding!==''&&rawLibrary.privateBinding!=='default'&&!ids.has(personaId(rawLibrary.privateBinding)))return fail()
  const hostIds=new Set<string>(),connections=list(rawHost.connections).map(value=>{
    const entry=record(value),id=internalId(entry.id),configured=directory.connectionById(id)
    if(hostIds.has(id)||!configured||configured.account.platform!=='qq'||configured.account.namespace!=='global')return fail()
    qq(configured.account.id);hostIds.add(id)
    const transport:Transport=entry.transport===undefined?'forward-websocket':entry.transport==='forward-websocket'||entry.transport==='reverse-websocket'?entry.transport:fail()
    // Validate endpoints locally, but never put existing ones in a public projection.
    const parseUrl=transport==='reverse-websocket'?parseOneBotReverseUrl:parseOneBotUrl
    parseUrl(text(entry.url,8192,false))
    return {id,account:{...configured.account},transport}
  })
  if(!connections.length)return fail()
  return {host,library,bindings,rawHost,rawLibrary,rawBindings,directory,agents,templates,ids,names,connections}
}
function append(doc:ReturnType<typeof document>,key:string,value:unknown){
  let sequence=doc.get(key,true)
  if(sequence===undefined){sequence=doc.createNode([]);doc.set(key,sequence)}
  // Mutating an anchored sequence could also change an unrelated alias consumer.
  if(!YAML.isSeq(sequence)||sequence.anchor)return fail()
  sequence.add(doc.createNode(value))
}
function names(value:unknown):string[]|undefined {
  if(value===undefined)return []
  if(!Array.isArray(value)||value.length>256||value.some(name=>typeof name!=='string'||!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(name))||new Set(value).size!==value.length)return undefined
  return value as string[]
}
function permissions(host:Data,conversations:readonly Conversation[]):StandaloneAgentTopologyChange['permissions'] {
  return conversations.map(({agentId,connectionId,target})=>{
    const scopeKey=agentConversationKey({agentId,target})
    if(target.kind==='private'){
      const privateChat=host.privateChat===undefined?{}:record(host.privateChat),tools=names(privateChat.allowTools)
      if(Object.keys(privateChat).some(key=>!['enabled','allowTools'].includes(key))||privateChat.enabled!==undefined&&typeof privateChat.enabled!=='boolean'||!tools||tools.some(name=>name!=='likeTool'&&name!=='recallTool'))return fail()
      return {scopeKey,mode:privateChat.enabled===true?'private' as const:'private-disabled' as const,tools:privateChat.enabled===true?tools:[],
        note:privateChat.enabled===true?'继承现有 privateChat 配置；列出已声明的私聊工具，执行仍受运行时权限检查；本次不新增工具授权。':'现有 privateChat 未启用；新增好友绑定不会开启私聊，也不新增工具授权。'}
    }
    const textGroup=host.textGroups===undefined?undefined:list(host.textGroups).find(value=>{
      const entry=record(value);return entry.connectionId===connectionId&&entry.conversationId===target.id
    })
    if(textGroup){
      const entry=record(textGroup),tools=names(entry.tools)
      if(Object.keys(entry).some(key=>!['connectionId','conversationId','tools'].includes(key))||!tools||tools.some(tool=>!groupTextToolNames.some(name=>name===tool)))return fail()
      return {scopeKey,mode:'text' as const,tools,note:'继承此完整账号及会话的 textGroups 工具清单；执行仍受运行时权限检查；本次不新增工具授权。'}
    }
    const simulation=host.simulation===undefined?{}:record(host.simulation),policy=simulation.toolPolicy===undefined?{}:record(simulation.toolPolicy)
    const extra=names(simulation.extraTools),allow=names(policy.allowTools),deny=names(policy.denyTools)
    let understood=Object.keys(policy).every(key=>['mode','allowTools','denyTools','groups'].includes(key))&&
      (policy.mode===undefined||policy.mode==='open'||policy.mode==='legacy')&&
      (simulation.enabled===undefined||typeof simulation.enabled==='boolean')&&!!extra&&!!allow&&!!deny
    if(policy.groups!==undefined){
      if(!policy.groups||typeof policy.groups!=='object'||Array.isArray(policy.groups))understood=false
      else for(const [key,value] of Object.entries(policy.groups))if(!/^\d{5,12}$/u.test(key)||!names(value))understood=false
    }
    const enabled=simulation.enabled!==false
    const tools=enabled&&understood?resolveSimToolSurface({policy:normalizeSimToolPolicy(policy),builtInNames:[],extraTools:extra!,groupId:target.id}):[]
    return {scopeKey,mode:'simulation' as const,tools,
      note:!enabled?'现有 simulation.enabled 为 false；此绑定不会开启仿真，也不新增工具授权。':!understood
        ?'继承现有仿真配置；工具策略含未识别规则，无法列出有效工具，须核对运行时策略；本次不新增工具授权。'
        :'继承现有仿真配置；仅列显式声明且未被策略排除的工具名，默认内置工具面、工具实例可用性及群开关仍以运行时为准；本次不新增工具授权。'}
  })
}
function safe<T>(operation:()=>T):T {try{return operation()}catch{return fail()}}

export function describeStandaloneAgentTopology(sources:ConfigSources):StandaloneAgentTopologyCatalog {
  return safe(()=>{
    const data=parse(sources),base=data.rawHost.persona===undefined?{}:record(data.rawHost.persona)
    return {agents:data.agents,personas:[{id:'default',name:base.name===undefined?'默认人设':text(base.name,200).trim()||'默认人设'},
      ...data.templates.map(entry=>({id:String(entry.id),name:String(entry.name)}))],connections:data.connections}
  })
}

/** Pure candidate planning. Full host compilation and transactional persistence belong to the caller. */
export function prepareStandaloneAgentTopologyChange(sources:ConfigSources,change:unknown):StandaloneAgentTopologyChange {
  return safe(()=>{
    const input=record(inputCopy(change)),data=parse(sources),changes:StandaloneAgentTopologyChange['changes'][number][]=[]
    // Every candidate retires the host, and editing bindings changes every binding revision.
    // Project the complete captured read set, including declarations with no live conversation.
    const affected:StandaloneAgentTopologyChange['affected']={agents:data.agents.map(agent=>agent.agentId),
      connections:list(data.rawBindings.connections).map(value=>{
        const connection=data.directory.connectionById(String(record(value).id))!
        return {id:connection.id,account:{...connection.account}}
      }),conversations:data.directory.listBindings().map(binding=>({agentId:binding.agentId,connectionId:binding.connectionId,
        target:{kind:binding.target.kind,id:binding.target.id,account:{...binding.target.account}}}))}
    let addedConversations:Conversation[]=[]
    let hostChanged=false,personasChanged=false
    if(input.kind==='connection.add'){
      fields(input,['kind','agentId','connection','conversations'])
      const agentId=internalId(input.agentId)
      if(!data.agents.some(agent=>agent.agentId===agentId))return fail()
      const raw=record(input.connection);fields(raw,['id','accountId','transport','url','accessTokenEnv'])
      const id=internalId(raw.id),accountId=qq(raw.accountId)
      if(data.directory.connectionById(id)||list(data.rawBindings.connections).some(value=>{
        const connection=record(value)
        return connection.platform==='qq'&&connection.namespace==='global'&&connection.accountId===accountId
      })||data.connections.some(entry=>entry.id===id))return fail()
      if(raw.transport!=='forward-websocket'&&raw.transport!=='reverse-websocket')return fail()
      const transport=raw.transport,endpoint=text(raw.url,8192,false)
      if(/[\s?#]/u.test(endpoint))return fail()
      const url=(transport==='reverse-websocket'?parseOneBotReverseUrl:parseOneBotUrl)(endpoint).href
      const connection:Data={id,transport,url}
      if(raw.accessTokenEnv!==undefined){
        const name=text(raw.accessTokenEnv,128,false)
        if(!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name))return fail()
        connection.accessTokenEnv=name
      }else if(transport==='reverse-websocket')return fail()
      const account={platform:'qq',namespace:'global',id:accountId},seen=new Set<string>()
      const requested=list(input.conversations,64)
      if(!requested.length)return fail()
      const conversations=requested.map(value=>{
        const entry=record(value);fields(entry,['kind','conversationId'])
        if(entry.kind!=='group'&&entry.kind!=='private')return fail()
        const target:ConversationAddress={account:{...account},kind:entry.kind,id:qq(entry.conversationId)},key=agentConversationKey({agentId,target})
        if(seen.has(key))return fail()
        seen.add(key);return {agentId,connectionId:id,target}
      })
      append(data.host,'connections',connection)
      changes.push({file:'host',path:`connections[${list(data.rawHost.connections).length}]`,action:'add',before:null,after:json(connection)})
      const declaration={id,platform:'qq',namespace:'global',accountId}
      append(data.bindings,'connections',declaration)
      changes.push({file:'bindings',path:`connections[${list(data.rawBindings.connections).length}]`,action:'add',before:null,after:json(declaration)})
      for(const [index,conversation] of conversations.entries()){
        const binding={connectionId:id,kind:conversation.target.kind,conversationId:conversation.target.id,agentId}
        append(data.bindings,'bindings',binding)
        changes.push({file:'bindings',path:`bindings[${list(data.rawBindings.bindings).length+index}]`,action:'add',before:null,after:json(binding)})
      }
      Object.assign(affected,{connections:[...affected.connections,{id,account}],conversations:[...affected.conversations,...conversations]})
      addedConversations=conversations;hostChanged=true
    }else if(input.kind==='agent.create'){
      fields(input,['kind','agentId','personaId','newPersona'])
      const agentId=internalId(input.agentId),selected=personaId(input.personaId)
      if(data.agents.some(agent=>agent.agentId===agentId)||data.ids.has('agent:'+agentId))return fail()
      if(input.newPersona!==undefined){
        const entry=persona(input.newPersona,true)
        if(entry.id!==selected||data.ids.has(selected)||selected==='agent:'+agentId||data.agents.some(agent=>selected==='agent:'+agent.agentId)||data.names.has(String(entry.name).toLowerCase()))return fail()
        if(data.templates.length>=500)return fail()
        append(data.library,'personas',entry);personasChanged=true
        changes.push({file:'personas',path:`personas[${data.templates.length}]`,action:'add',before:null,after:json(entry)})
      }else if(selected!=='default'&&!data.ids.has(selected))return fail()
      const agent={id:agentId,personaId:selected};append(data.bindings,'agents',agent)
      changes.push({file:'bindings',path:`agents[${data.agents.length}]`,action:'add',before:null,after:json(agent)})
      Object.assign(affected,{agents:[...affected.agents,agentId]})
    }else return fail()
    const next:ConfigSources={host:hostChanged?data.host.toString():sources.host,
      personas:personasChanged?data.library.toString():sources.personas,bindings:data.bindings.toString()}
    parse(next)
    const restartNote='提交后整个宿主的全部执行等待重启；bindings 版本变化，旧版本 grant 须重新核验，不自动重签。'
    return {sources:next,changes,affected,permissions:permissions(data.rawHost,addedConversations).map(row=>({...row,note:row.note+restartNote}))}
  })
}
