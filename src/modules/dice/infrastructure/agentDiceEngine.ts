import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {AgentBindingSnapshot} from '../../../contracts/agentBinding.js'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'
import type {AgentDiagnostics} from '../../runtime/infrastructure/agentDiagnostics.js'
import {agentBindingToken,agentConversationKey,conversationAddressKey,isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import {KeyedSerialQueue} from '../../messaging/infrastructure/keyedSerialQueue.js'
import {createAgentDiceBuiltin,type AgentDiceBuiltinConfig,type AgentDiceBuiltinState} from './agentDiceBuiltin.js'
import {createAgentDiceRules,type AgentDiceRulesState,type AgentDiceRuleCards} from './agentDiceRules.js'
import type {AgentDiceCompiledRulePackage} from './agentDiceRulePackages.js'
import type {createAgentDiceLedger} from './agentDiceLedger.js'
import type {createAgentDiceState,AgentDiceStateJson,AgentDiceStateOperation,AgentDiceStateGuard,AgentDiceEffectReceipt} from './agentDiceState.js'
import {createAgentDicePrivateOrigin,prepareAgentDicePrivateDeliveries,readAgentDicePrivateOrigin,settleAgentDicePrivateDelivery,type AgentDicePrivateOrigin,type AgentDicePrivateEffect} from './agentDicePrivateDelivery.js'

export type AgentDiceEnginePermission='player'|'gm'|'admin'|'master'|'delegate'|'hidden'|'card'
export interface AgentDiceEngineMember {
  readonly id:string
  readonly name:string
  readonly permissions?:readonly AgentDiceEnginePermission[]
}
/** An explicit host grant intersected with freshly observed membership; never a native event. */
export interface AgentDiceEngineAuthorization {
  readonly revision:string
  readonly actor:{readonly id:string;readonly name:string}
  readonly permissions:readonly AgentDiceEnginePermission[]
  readonly members:readonly AgentDiceEngineMember[]
  readonly botUserId?:string
  /** Set only after verifying the original quoted message, independently of its displayed text. */
  readonly replyAuthorId?:string
}
export type AgentDiceEngineEffect={readonly kind:'public';readonly text:string;readonly eventIndex?:number}|
  AgentDicePrivateEffect|
  {readonly kind:'card';readonly subjectId:string;readonly name:string}|
  {readonly kind:'log';readonly operation:'start'|'stop';readonly ownershipId:string;readonly title?:string}
export interface AgentDiceEngineEvent {
  readonly producer:'agent-dice-engine'
  readonly eventId:string
  readonly kind:'dice_result'|'card_change'|'rule_event'
  readonly source:{readonly messageId:string;readonly authorId:string;readonly at:number}
  readonly facts:AgentDiceStateJson
}
export interface AgentDiceEngineContext extends AgentDiceStateGuard {
  ensureCurrent():Promise<void>
  readonly logActive?:boolean
  /** Non-message facts already committed with business state. No message ID is invented. */
  record?(event:AgentDiceEngineEvent):Promise<void>
  /** Only a confirmed public result can enter the result archive. */
  archive?(event:AgentDiceEngineEvent & {readonly text:string;readonly deliveryMessageId:string}):Promise<void>
}
export interface AgentDiceEngineConfig {
  readonly enabled:boolean
  readonly revision?:string
  readonly builtin?:AgentDiceBuiltinConfig
  readonly rulePackages?:readonly AgentDiceCompiledRulePackage[]
  readonly deliveryTimeoutMs?:number
}
export interface AgentDiceEnginePorts {
  readonly state:ReturnType<typeof createAgentDiceState>
  /** Existing ready/pending/unknown/confirmed fences remain authoritative during replacement. */
  readonly legacyLedger:Pick<ReturnType<typeof createAgentDiceLedger>,'capture'|'read'>
  authorize(request:{readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage},guard:AgentDiceStateGuard):Promise<AgentDiceEngineAuthorization|undefined>
  /** Retry requires fresh proof for its original source and current recipient grants. */
  authorizePrivateOrigin?(request:{readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage;readonly origin:AgentDicePrivateOrigin;readonly recipientId:string;readonly requiredPermission?:'player'|'gm'},guard:AgentDiceStateGuard):Promise<boolean>
  deliver(request:{readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage;readonly effect:AgentDiceEngineEffect;readonly operationId:string;readonly index:number},guard:AgentDiceStateGuard):Promise<AgentDiceEffectReceipt>
  allowsText(text:string):boolean
  readonly diagnostics?:Pick<AgentDiagnostics,'emit'>
}
interface BusinessState {version:1;builtin:AgentDiceBuiltinState|null;rules:AgentDiceRulesState|null}
type StoredEffect=AgentDiceEngineEffect|{readonly kind:'event';readonly event:AgentDiceEngineEvent}
const permissionNames=new Set(['player','gm','admin','master','delegate','hidden','card'])
const invalid=()=>new Error('骰子来源、授权或冻结结果不可用')
const safeId=(input:unknown):input is string=>isPlatformIdentifier(input)&&input!=='0'
function json(input:unknown,seen=new Set<object>(),depth=0):AgentDiceStateJson {
  if(depth>32)throw invalid()
  if(input===null||typeof input==='string'||typeof input==='boolean')return input
  if(typeof input==='number'&&Number.isFinite(input))return input
  if(!input||typeof input!=='object'||types.isProxy(input)||seen.has(input))throw invalid()
  const array=Array.isArray(input),proto=Object.getPrototypeOf(input),keys=Reflect.ownKeys(input)
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)throw invalid()
  if(keys.length>8192||keys.some(key=>typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)))throw invalid()
  seen.add(input)
  try {
    const data:Record<string,AgentDiceStateJson>={}
    if(array){
      if(input.length>4096||keys.length!==input.length+1)throw invalid()
      const values:AgentDiceStateJson[]=[]
      for(let index=0;index<input.length;index++){
        const field=Object.getOwnPropertyDescriptor(input,String(index))
        if(!field||!('value'in field)||!field.enumerable)throw invalid()
        values.push(json(field.value,seen,depth+1))
      }
      return Object.freeze(values)
    }
    for(const key of (keys as string[]).sort()){
      const field=Object.getOwnPropertyDescriptor(input,key)
      if(!field||!('value'in field)||!field.enumerable)throw invalid()
      data[key]=json(field.value,seen,depth+1)
    }
    return Object.freeze(data)
  } finally {seen.delete(input)}
}
const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(json(input))).digest('hex')
function object(input:unknown):Record<string,unknown> {
  const value=json(input)
  if(value===null||typeof value!=='object'||Array.isArray(value))throw invalid()
  return value as Record<string,unknown>
}
function permissions(value:unknown):readonly AgentDiceEnginePermission[] {
  if(!Array.isArray(value)||value.length>permissionNames.size||new Set(value).size!==value.length||value.some(item=>!permissionNames.has(item)))throw invalid()
  return Object.freeze([...value].sort()) as AgentDiceEnginePermission[]
}
function authorization(input:unknown,message:IncomingMessage):AgentDiceEngineAuthorization {
  const value=object(input),actor=object(value.actor)
  if(Object.keys(value).some(key=>!['revision','actor','permissions','members','botUserId','replyAuthorId'].includes(key))||
    !isPlatformIdentifier(value.revision)||Object.keys(actor).some(key=>!['id','name'].includes(key))||actor.id!==message.sender.id||
    typeof actor.name!=='string'||!actor.name.trim()||actor.name.length>256||!Array.isArray(value.members)||value.members.length>4096)throw invalid()
  const members=value.members.map(input=>{
    const member=object(input)
    if(Object.keys(member).some(key=>!['id','name','permissions'].includes(key))||!isPlatformIdentifier(member.id)||
      typeof member.name!=='string'||!member.name.trim()||member.name.length>256)throw invalid()
    return Object.freeze({id:member.id,name:member.name,...(member.permissions===undefined?{}:{permissions:permissions(member.permissions)})})
  }).sort((a,b)=>a.id.localeCompare(b.id))
  if(new Set(members.map(member=>member.id)).size!==members.length||!members.some(member=>member.id===actor.id))throw invalid()
  for(const key of ['botUserId','replyAuthorId'] as const)if(value[key]!==undefined&&!isPlatformIdentifier(value[key]))throw invalid()
  if(value.replyAuthorId!==undefined&&(!message.quote||!members.some(member=>member.id===value.replyAuthorId)))throw invalid()
  return Object.freeze({revision:value.revision,actor:Object.freeze({id:actor.id as string,name:actor.name}),permissions:permissions(value.permissions),members:Object.freeze(members),
    ...(value.botUserId===undefined?{}:{botUserId:value.botUserId as string}),...(value.replyAuthorId===undefined?{}:{replyAuthorId:value.replyAuthorId as string})})
}
function business(input:unknown):BusinessState {
  if(input===null||input===undefined)return {version:1,builtin:null,rules:null}
  const value=object(input)
  if(value.version!==1||Object.keys(value).some(key=>!['version','builtin','rules'].includes(key))||!Object.hasOwn(value,'builtin')||!Object.hasOwn(value,'rules'))throw invalid()
  return value as unknown as BusinessState
}
function frozenRandom(seed:string) {
  let counter=0
  return ()=>{
    if(++counter>100_000)throw invalid()
    return createHash('sha256').update(`${seed}:${counter-1}`).digest().readUInt32BE(0)/0x1_0000_0000
  }
}
async function bounded<T>(operation:Promise<T>,guard:AgentDiceStateGuard,timeout=15_000):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined
  try {
    return await Promise.race([operation,new Promise<never>((_,reject)=>{
      abort=()=>reject(invalid());timer=setTimeout(abort,timeout)
      guard.signal.addEventListener('abort',abort,{once:true})
      if(guard.signal.aborted)abort()
    })])
  } finally {if(timer)clearTimeout(timer);if(abort)guard.signal.removeEventListener('abort',abort)}
}
function sourceShape(message:IncomingMessage,binding:AgentBindingSnapshot):boolean {
  return binding.source==='configured'&&message.version===1&&message.conversation.kind==='group'&&
    conversationAddressKey(message.conversation)===conversationAddressKey(binding.target)&&
    message.sender.platform===binding.target.account.platform&&message.sender.namespace===binding.target.account.namespace&&
    isPlatformIdentifier(message.sender.id)&&safeId(message.messageId)&&Number.isSafeInteger(message.occurredAt)&&message.occurredAt>0&&
    Number.isFinite(new Date(message.occurredAt).getTime())&&message.text.length<=16_384&&message.parts.length>0&&
    message.parts.every(part=>part.kind==='text'||part.kind==='mention'&&part.user!=='everyone')&&
    message.parts.filter(part=>part.kind==='text').map(part=>part.text).join('')===message.text&&
    message.mentions.length<=128&&message.mentions.every(user=>isPlatformIdentifier(user.id)&&user.platform===message.sender.platform&&user.namespace===message.sender.namespace)&&
    message.parts.filter(part=>part.kind==='mention').every(part=>{
      const mentioned=part.user
      return mentioned!=='everyone'&&message.mentions.some(user=>user.id===mentioned.id&&user.platform===mentioned.platform&&user.namespace===mentioned.namespace)
    })
}
function cardsOf(state:AgentDiceBuiltinState|null,auth:AgentDiceEngineAuthorization):AgentDiceRuleCards {
  const cards:AgentDiceRuleCards={}
  for(const [id,user] of Object.entries(state?.users??{})){
    if(!auth.members.some(member=>member.id===id))continue
    const card=user.cards[user.activeCard]
    if(card)cards[id]={key:user.activeCard,name:card.name,attrs:{...card.attrs},skills:{...card.skills}}
  }
  cards[auth.actor.id]??={key:'默认',name:auth.actor.name,attrs:{},skills:{}}
  return cards
}
function mergeCards(state:AgentDiceBuiltinState|null,cards:AgentDiceRuleCards,auth:AgentDiceEngineAuthorization):AgentDiceBuiltinState {
  const draft=structuredClone(state??{version:1 as const,users:{},scene:{}}),before=cardsOf(state,auth)
  for(const [id,card] of Object.entries(cards)){
    if(before[id]&&hash(before[id])===hash(card))continue
    if(!auth.members.some(member=>member.id===id)){
      if(before[id]&&hash(before[id])===hash(card))continue
      throw invalid()
    }
    if(id!==auth.actor.id&&(!auth.permissions.includes('delegate')||!auth.members.some(member=>member.id===id&&member.permissions?.includes('delegate'))))throw invalid()
    if(card.key!==(before[id]?.key??'默认'))throw invalid()
    const user=draft.users[id]??={activeCard:card.key,cards:{}}
    const original=user.cards[card.key]
    user.cards[card.key]={...original,name:card.name,attrs:{...card.attrs},skills:{...card.skills}}
  }
  return draft
}
function actualSubjects(sourceId:string,state:BusinessState,effects:readonly AgentDiceEngineEffect[],events:readonly AgentDiceEngineEvent[],auth:AgentDiceEngineAuthorization):readonly string[] {
  const ids=new Set([auth.actor.id]),verified=new Set(auth.members.map(member=>member.id))
  const add=(value:unknown)=>{if(typeof value==='string'&&verified.has(value))ids.add(value)}
  const visit=(value:unknown)=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return}
    if(!value||typeof value!=='object')return
    const entry=value as Record<string,unknown>
    for(const key of ['subjectId','recipientId','actorId','authorId','userId','targetId'])add(entry[key])
    if(Array.isArray(entry.subjectIds))for(const id of entry.subjectIds)add(id)
    for(const key of ['actor','invoker','target']){
      const actor=entry[key]
      if(actor&&typeof actor==='object'&&!Array.isArray(actor)){
        const row=actor as Record<string,unknown>
        if(row.kind!=='npc')add(row.id)
      }
    }
    if(Array.isArray(entry.targets))for(const target of entry.targets){
      if(target&&typeof target==='object'&&!Array.isArray(target)&&(target as Record<string,unknown>).kind!=='npc')add((target as Record<string,unknown>).id)
    }
    for(const child of Object.values(entry))visit(child)
  }
  for(const effect of effects)visit(effect)
  for(const event of events)visit(event.facts)
  for(const pack of Object.values(state.rules?.packs??{}))for(const audit of pack.group.audit??[]){
    if((audit as unknown as {source?:{messageId?:string}}).source?.messageId===sourceId)visit(audit)
  }
  return [...ids].sort()
}

/** One real source owns one seed, atomic business mutation and one-shot effects. */
export function createAgentDiceEngine(config:AgentDiceEngineConfig,ports:AgentDiceEnginePorts) {
  if(!config||typeof config.enabled!=='boolean'||config.revision!==undefined&&!isPlatformIdentifier(config.revision))throw invalid()
  const timeout=config.deliveryTimeoutMs??15_000
  const enabled=config.enabled
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120_000)throw invalid()
  const builtin=createAgentDiceBuiltin(config.builtin),rules=createAgentDiceRules({packages:config.rulePackages??[]})
  const definitionId='dice:engine:v1:'+hash([config.enabled,config.revision??'',timeout,builtin.definitionId,rules.definitionId])
  const queue=new KeyedSerialQueue()
  const candidate=(text:string)=>builtin.isCandidate(text)||rules.isCandidate(text)
  function commands(text:string):readonly string[] {
    const values=text.trim().split(/(?=[.。])/u).filter(value=>value.trim())
    return values.length>1&&values.length<=5&&values.every(candidate)?values:[text.trim()]
  }
  return Object.freeze({
    definitionId,
    isCandidate:(message:IncomingMessage)=>enabled&&message.conversation.kind==='group'&&commands(message.text).some(candidate),
    async handle(message:IncomingMessage,binding:AgentBindingSnapshot,context:AgentDiceEngineContext):Promise<boolean> {
      if(!enabled||message.conversation.kind!=='group'||!commands(message.text).some(candidate))return false
      const emit=(outcome:'succeeded'|'failed'|'unknown'|'cancelled',code:string)=>{
        try {ports.diagnostics?.emit({stage:'runtime',operation:'dice_command',outcome,code})}catch{/* Observation cannot authorize effects. */}
      }
      if(!sourceShape(message,binding)){emit('cancelled','source_unavailable');return true}
      const immutableSource=JSON.parse(JSON.stringify(message)) as IncomingMessage
      const immutableBinding=JSON.parse(JSON.stringify(binding)) as AgentBindingSnapshot
      return queue.run(agentConversationKey(binding),async()=>{
        const controller=new AbortController(),signal=AbortSignal.any([context.signal,controller.signal])
        const current=()=>{try{return !signal.aborted&&context.isCurrent()}catch{return false}}
        const basic:AgentDiceStateGuard={signal,isCurrent:current,async ensureCurrent(){if(!current())throw invalid();await bounded(context.ensureCurrent(),{signal,isCurrent:current},5000);if(!current())throw invalid()}}
        const legacySource={target:immutableBinding.target,agentId:immutableBinding.agentId,authorId:immutableSource.sender.id,messageId:immutableSource.messageId!}
        let operation:AgentDiceStateOperation|undefined,source:{messageId:string;authorId:string;sourceHash:string;occurredAt:number}|undefined,dispatched=false
        try {
          await basic.ensureCurrent!()
          const auth=authorization(await bounded(ports.authorize({binding:immutableBinding,source:immutableSource},basic),basic,5000),immutableSource)
          if(!auth.permissions.includes('player'))throw invalid()
          const authorityHash=hash(auth),epochs=await ports.legacyLedger.capture(legacySource)
          if(epochs.recalled||await ports.legacyLedger.read(legacySource)){emit('cancelled','legacy_source_fenced');return true}
          const ensure=async()=>{
            await basic.ensureCurrent!()
            const fresh=authorization(await bounded(ports.authorize({binding:immutableBinding,source:immutableSource},basic),basic,5000),immutableSource)
            const captured=await ports.legacyLedger.capture(legacySource)
            if(hash(fresh)!==authorityHash||captured.recalled||captured.global!==epochs.global||captured.scene!==epochs.scene||
              await ports.legacyLedger.read(legacySource))throw invalid()
            if(!current())throw invalid()
          }
          const guard:AgentDiceStateGuard={signal,isCurrent:current,ensureCurrent:ensure}
          const allows=(permission:AgentDiceEnginePermission,id=auth.actor.id)=>{
            if(id===auth.actor.id)return auth.permissions.includes(permission)
            const member=auth.members.find(member=>member.id===id)
            return !!member&&(member.permissions??[]).includes(permission)&&
              (!['delegate','hidden','card'].includes(permission)||auth.permissions.includes(permission))
          }
          source={messageId:immutableSource.messageId!,authorId:immutableSource.sender.id,occurredAt:immutableSource.occurredAt,
            sourceHash:hash([immutableSource,agentBindingToken(immutableBinding),definitionId,authorityHash])}
          const begun=await ports.state.begin(immutableBinding,source,guard)
          const operationId=begun.kind==='started'?begun.claim.id:begun.operation.id
          const origin=createAgentDicePrivateOrigin(immutableBinding,immutableSource,operationId,auth.revision)
          const privateAuthority=async(effect:AgentDicePrivateEffect,dispatchIndex?:number)=>{
            const saved=readAgentDicePrivateOrigin(effect.origin)
            if(agentBindingToken(saved.binding)!==agentBindingToken(immutableBinding)||conversationAddressKey(saved.binding.target)!==conversationAddressKey(immutableBinding.target)||
              !allows('player',effect.recipientId)||!allows('hidden',effect.recipientId)||
              effect.requiredPermission==='gm'&&!['gm','admin','master'].some(permission=>allows(permission as AgentDiceEnginePermission,effect.recipientId)))throw invalid()
            const retry=saved.operationId!==operationId
            if(retry&&(!ports.authorizePrivateOrigin||!await bounded(ports.authorizePrivateOrigin({binding:immutableBinding,source:immutableSource,origin:saved,recipientId:effect.recipientId,
              ...(effect.requiredPermission===undefined?{}:{requiredPermission:effect.requiredPermission})},guard),guard,5000)))throw invalid()
            if((effect.packId===undefined)!==(effect.deliveryId===undefined))throw invalid()
            if(effect.packId!==undefined&&effect.deliveryId!==undefined){
              const lease=await ports.state.readDelivery(immutableBinding,{packId:effect.packId,deliveryId:effect.deliveryId},guard)
              if(dispatchIndex!==undefined){
                if(!lease||lease.state!=='unknown'||lease.operationId!==operationId||lease.originId!==saved.operationId||lease.index!==dispatchIndex)throw invalid()
              }else if(retry&&(!lease||lease.state!=='failed'||lease.originId!==saved.operationId))throw invalid()
            }else if(retry)throw invalid()
          }
          if(begun.kind==='existing'){
            operation=begun.operation
            if(operation.state!=='ready'){
              if(operation.state==='preparing'||operation.state==='pending')await ports.state.recoverOperation(immutableBinding,source)
              emit(operation.state==='confirmed'?'succeeded':'unknown','source_already_owned');return true
            }
          }else{
            let draft=business(begun.snapshot?.state),effects:AgentDiceEngineEffect[]=[],events:AgentDiceEngineEvent[]=[],subjects=new Set([auth.actor.id])
            const original=structuredClone(draft),random=frozenRandom(begun.claim.seed)
            const ctx={source:{messageId:source.messageId,authorId:source.authorId,at:source.occurredAt},actor:auth.actor,members:auth.members,
              privateOrigin:origin,
              groupId:immutableBinding.target.id,...(auth.botUserId===undefined?{}:{botUserId:auth.botUserId}),
              ...(auth.replyAuthorId===undefined?{}:{replyAuthorId:auth.replyAuthorId}),...(context.logActive===undefined?{}:{logActive:context.logActive}),allows}
            try {
              for(const command of commands(immutableSource.text)){
                const isBuiltin=builtin.isCandidate(command)
                const result=isBuiltin?await builtin.evaluate({state:draft.builtin,command,context:{...ctx,mentions:immutableSource.mentions.map(user=>user.id)},random}):
                  await rules.evaluate({state:draft.rules,command,context:{...ctx,mentions:immutableSource.mentions.map(user=>({id:user.id}))},cards:cardsOf(draft.builtin,auth),random})
                if(!result.matched)throw invalid()
                if('subjectIds'in result&&Array.isArray(result.subjectIds))for(const id of result.subjectIds){
                  if(typeof id!=='string'||!auth.members.some(member=>member.id===id))throw invalid()
                  subjects.add(id)
                }
                const offset=events.length
                for(const value of result.events){
                  let facts={...object(value)}
                  if(!['dice_result','card_change','rule_event'].includes(String(facts.kind)))throw invalid()
                  // Facts come only from the deterministic producers. Rebind provenance to this exact real source.
                  delete facts.source
                  if(facts.visibility==='private')facts={kind:facts.kind,visibility:'private',command:String(facts.command??''),actorId:auth.actor.id}
                  events.push({producer:'agent-dice-engine',kind:facts.kind as AgentDiceEngineEvent['kind'],eventId:hash([begun.claim.id,events.length,facts.kind]),source:ctx.source,facts:json(facts)})
                }
                effects.push(...result.effects.map(effect=>effect.kind==='public'&&effect.eventIndex!==undefined?{...effect,eventIndex:effect.eventIndex+offset}:effect))
                if(isBuiltin)draft={...draft,builtin:result.state as AgentDiceBuiltinState}
                else{
                  const changed=result as Awaited<ReturnType<typeof rules.evaluate>>
                  draft={...draft,rules:changed.state,...(changed.cards?{builtin:mergeCards(draft.builtin,changed.cards,auth)}:{})}
                }
              }
              for(const effect of effects){
                if(effect.kind==='public'||effect.kind==='private'){
                  if(!effect.text.trim()||effect.text.length>32_000||!ports.allowsText(effect.text))throw invalid()
                  if(effect.kind==='private')await privateAuthority({...effect,origin:effect.origin??origin})
                }else if(effect.kind==='card'&&(!allows('card',effect.subjectId)||effect.subjectId!==auth.actor.id&&!allows('delegate',effect.subjectId)||!auth.members.some(member=>member.id===effect.subjectId)))throw invalid()
              }
            }catch{
              draft=original;events=[];subjects=new Set([auth.actor.id]);effects=[{kind:'public',text:'骰子命令未能通过格式、权限或规则校验，未修改人物卡。'}]
              if(!ports.allowsText(effects[0]!.kind==='public'?effects[0]!.text:''))throw invalid()
            }
            const stored:StoredEffect[]=[...events.filter(event=>event.kind!=='dice_result').map(event=>({kind:'event' as const,event})),...effects]
            if(stored.length>128)throw invalid()
            const prepared=prepareAgentDicePrivateDeliveries(draft,stored,origin,begun.claim.id)
            operation=await ports.state.commit(immutableBinding,begun.claim,{state:prepared.state,effects:prepared.effects,event:events,privateDeliveries:prepared.privateDeliveries,
              subjectIds:[...new Set([...subjects,...actualSubjects(source.messageId,draft,effects,events,auth)])]},guard)
            if(!operation){emit('unknown','state_commit_unconfirmed');return true}
          }
          while(operation.state==='ready'){
            await ensure()
            const index=operation.completed,claimed=await ports.state.claimEffect(immutableBinding,source,index,guard)
            if(!claimed)return true
            operation=claimed.operation
            dispatched=true
            const effect=claimed.effect as unknown as StoredEffect
            let receipt:AgentDiceEffectReceipt={state:'unknown'}
            let continuation=true
            try {
              await ensure()
              if(effect.kind==='event'){
                if(context.record)await bounded(context.record(effect.event),guard,timeout)
                receipt={state:'confirmed'}
              }else{
                if(effect.kind==='public'||effect.kind==='private'){
                  if(typeof effect.text!=='string'||!ports.allowsText(effect.text))throw invalid()
                  if(effect.kind==='private')await privateAuthority(effect,index)
                }else if(effect.kind==='card'&&(!allows('card',effect.subjectId)||effect.subjectId!==auth.actor.id&&!allows('delegate',effect.subjectId)))throw invalid()
                const raw=object(await bounded(ports.deliver({binding:immutableBinding,source:immutableSource,effect,operationId:operation.id,index},guard),guard,timeout))
                if(effect.kind==='public'||effect.kind==='private'){
                  receipt=raw.state==='sent'&&safeId(raw.messageId)?{state:'sent',messageId:raw.messageId}:raw.state==='failed'?{state:'failed'}:{state:'unknown'}
                }else receipt=raw.state==='confirmed'?{state:'confirmed'}:raw.state==='failed'?{state:'failed'}:{state:'unknown'}
                if(receipt.state==='sent'&&effect.kind==='public'&&effect.eventIndex!==undefined&&context.archive){
                  const event=(operation.event as unknown as readonly AgentDiceEngineEvent[])[effect.eventIndex]
                  if(!event||object(event.facts).visibility==='private')throw invalid()
                  if(event.kind==='dice_result'){
                    await ensure()
                    await bounded(context.archive({...event,text:effect.text,deliveryMessageId:receipt.messageId}),guard,timeout)
                  }
                }
              }
              await ensure()
            }catch{continuation=false;if(receipt.state!=='sent'&&receipt.state!=='failed')receipt={state:'unknown'}}
            let settled:AgentDiceStateOperation|undefined
            try{
              if(effect.kind==='private'){
                const snapshot=await ports.state.read(immutableBinding)
                if(!snapshot)throw invalid()
                const nextState=settleAgentDicePrivateDelivery(snapshot.state,effect,receipt,{operationId:operation.id,index})
                settled=await ports.state.settleEffectAndState(immutableBinding,source,index,receipt,{snapshot,nextState})
              }else settled=await ports.state.settleEffect(immutableBinding,source,index,receipt)
            }catch{
              try{await ports.state.abandonOperation(immutableBinding,source)}catch{/* A durable pending fence still blocks replay. */}
            }
            if(!settled){
              try{await ports.state.abandonOperation(immutableBinding,source)}catch{/* An unconfirmed write never authorizes continuation. */}
              emit('unknown','effect_settlement_unconfirmed');return true
            }
            operation=settled
            if(!continuation){
              if(operation.state==='ready')try{await ports.state.abandonOperation(immutableBinding,source)}catch{/* Confirmed transport never authorizes later effects after lost authority. */}
              emit('unknown','effect_continuation_unconfirmed');return true
            }
          }
          emit(operation.state==='confirmed'?'succeeded':operation.state==='failed'?'failed':'unknown','command_'+operation.state)
        }catch{
          // A durable preparing/pending fence blocks another roll even when cancellation prevents settlement.
          if(source)try{
            if(dispatched)await ports.state.abandonOperation(immutableBinding,source)
            else await ports.state.recoverOperation(immutableBinding,source)
          }catch{/* Retained fence remains authoritative. */}
          emit(current()?'unknown':'cancelled',current()?'state_or_authority_unconfirmed':'source_unavailable')
        }finally{controller.abort()}
        return true
      })
    },
  })
}
