import type {AgentBindingSnapshot,ConversationAddress,PlatformAccountRef,PlatformUserRef} from '../../../contracts/agentBinding.js'
import type {AgentDicePrivateRelayRequest,AgentDiceRelayGuard} from '../../../contracts/agentDice.js'
import type {ConversationMembersSnapshot} from '../../../contracts/platformConnection.js'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'
import {agentBindingToken,conversationAddressKey,isConversationAddress,isPlatformIdentifier,isPlatformAccount} from '../../runtime/domain/agentBindings.js'
import {agentDiceSourceFingerprint} from './agentDiceSource.js'
import {resolveAgentDiceAuthorization,type AgentDiceAuthorizationGrant} from './agentDiceAuthorization.js'
import {createAgentDiceEngine,type AgentDiceEngineAuthorization,type AgentDiceEngineConfig,type AgentDiceEngineContext,type AgentDiceEnginePorts} from './agentDiceEngine.js'
import {toAgentDiceScriptJson} from './agentDiceScriptProcess.js'
import type {AgentDiceEffectReceipt,AgentDiceStateGuard} from './agentDiceState.js'
import type {createAgentDiceLedger} from './agentDiceLedger.js'

export type {AgentDicePrivateRelayRequest,AgentDiceRelayGuard} from '../../../contracts/agentDice.js'
type Origin=AgentDicePrivateRelayRequest['origin']
type State=AgentDiceEnginePorts['state']
interface PurgeSubject {readonly account:PlatformAccountRef;readonly agentId:string;readonly subjectId:string;readonly target?:ConversationAddress}
interface SourceRequest {readonly binding:AgentBindingSnapshot;readonly source:IncomingMessage}
interface EffectRequest extends SourceRequest {readonly operationId:string;readonly index:number}
export interface AgentDiceHostBridgePorts {
  readonly state:State
  readonly legacyLedger:AgentDiceEnginePorts['legacyLedger'] & Pick<ReturnType<typeof createAgentDiceLedger>,'revokeSource'|'purgeSubject'>
  readGrant(request:SourceRequest,guard:AgentDiceStateGuard):Promise<AgentDiceAuthorizationGrant|undefined>
  readMessage(request:{readonly binding:AgentBindingSnapshot;readonly messageId:string},guard:AgentDiceStateGuard):Promise<IncomingMessage|undefined>
  readMembers(request:{readonly binding:AgentBindingSnapshot},guard:AgentDiceStateGuard):Promise<ConversationMembersSnapshot|undefined>
  sourceAllowed(request:SourceRequest,guard:AgentDiceStateGuard):boolean|Promise<boolean>
  sendPublic(request:EffectRequest & {readonly text:string},guard:AgentDiceStateGuard):Promise<AgentDiceEffectReceipt>
  relayPrivate?(request:AgentDicePrivateRelayRequest,guard:AgentDiceRelayGuard):Promise<AgentDiceEffectReceipt>
  setGroupCard?(request:EffectRequest & {readonly subject:PlatformUserRef;readonly name:string},guard:AgentDiceStateGuard):Promise<AgentDiceEffectReceipt>
  controlLog?(request:EffectRequest & {readonly operation:'start'|'stop';readonly ownershipId:string;readonly title?:string},guard:AgentDiceStateGuard):Promise<AgentDiceEffectReceipt>
  allowsText(text:string):boolean
  readonly now?:()=>number
  readonly maxEvidenceAgeMs?:number
  readonly diagnostics?:AgentDiceEnginePorts['diagnostics']
}
const invalid=()=>new Error('骰子宿主来源或授权证据不可用')
const safeId=(value:unknown):value is string=>isPlatformIdentifier(value)&&value!=='0'
const copy=<T>(value:T):T=>toAgentDiceScriptJson(value) as unknown as T
const sameBinding=(left:AgentBindingSnapshot,right:AgentBindingSnapshot)=>agentBindingToken(left)===agentBindingToken(right)&&conversationAddressKey(left.target)===conversationAddressKey(right.target)
const sameUser=(left:PlatformUserRef,right:PlatformUserRef)=>left.id===right.id&&left.platform===right.platform&&left.namespace===right.namespace
async function ensure(guard?:AgentDiceStateGuard):Promise<void> {
  if(!guard)return
  if(guard.signal.aborted||!guard.isCurrent())throw invalid()
  await guard.ensureCurrent?.()
  if(guard.signal.aborted||!guard.isCurrent())throw invalid()
}
function messageInBinding(message:IncomingMessage,binding:AgentBindingSnapshot,messageId:string):void {
  if(binding.source!=='configured'||binding.target.kind!=='group'||message.version!==1||message.messageId!==messageId||!safeId(messageId)||
    conversationAddressKey(message.conversation)!==conversationAddressKey(binding.target)||!safeId(message.sender.id)||
    message.sender.platform!==binding.target.account.platform||message.sender.namespace!==binding.target.account.namespace||
    message.binding!==undefined&&!sameBinding(message.binding,binding))throw invalid()
  agentDiceSourceFingerprint(message)
}
function permission(auth:AgentDiceEngineAuthorization,name:'hidden'|'delegate'|'card',id:string):boolean {
  const member=auth.members.find(member=>member.id===id)
  return !!member&&auth.permissions.includes(name)&&(id===auth.actor.id||(member.permissions??[]).includes(name))
}
function recipientPermission(auth:AgentDiceEngineAuthorization,required:'player'|'gm',id:string):boolean {
  const permissions=id===auth.actor.id?auth.permissions:auth.members.find(member=>member.id===id)?.permissions??[]
  return required==='player'?permissions.includes('player'):permissions.some(value=>['gm','admin','master'].includes(value))
}

/** Host evidence and explicit transports around the deterministic Engine. */
export function createAgentDiceHostBridge(config:AgentDiceEngineConfig,ports:AgentDiceHostBridgePorts) {
  const maxAge=ports.maxEvidenceAgeMs??30_000,now=ports.now??Date.now
  if(!Number.isSafeInteger(maxAge)||maxAge<1||maxAge>300_000)throw invalid()
  async function authorize(request:SourceRequest,guard:AgentDiceStateGuard):Promise<AgentDiceEngineAuthorization|undefined> {
    try {
      const {binding,source}=request
      await ensure(guard)
      if(!safeId(source.messageId))throw invalid()
      messageInBinding(source,binding,source.messageId)
      const observed=copy(await ports.readMessage({binding,messageId:source.messageId},guard))
      if(!observed)throw invalid()
      messageInBinding(observed,binding,source.messageId)
      if(agentDiceSourceFingerprint(observed)!==agentDiceSourceFingerprint(source)||!await ports.sourceAllowed({binding,source:observed},guard))throw invalid()
      const [snapshotValue,grantValue]=await Promise.all([ports.readMembers({binding},guard),ports.readGrant(request,guard)])
      await ensure(guard)
      if(!snapshotValue||!grantValue)throw invalid()
      const snapshot=copy(snapshotValue),grant=copy(grantValue),clock=now()
      if(snapshot.complete!==true||conversationAddressKey(snapshot.target)!==conversationAddressKey(binding.target)||!Number.isSafeInteger(clock)||
        !Number.isSafeInteger(snapshot.observedAt)||snapshot.observedAt<=0||snapshot.observedAt>clock||clock-snapshot.observedAt>maxAge||
        !Array.isArray(snapshot.members)||snapshot.members.length>4096)throw invalid()
      const members=snapshot.members.map(member=>{
        if(!safeId(member.user.id)||member.user.platform!==binding.target.account.platform||member.user.namespace!==binding.target.account.namespace||
          typeof member.displayName!=='string'||!member.displayName.trim()||member.displayName.length>256)throw invalid()
        return {id:member.user.id,name:member.displayName}
      })
      const actor=members.find(member=>member.id===source.sender.id)
      if(!actor)throw invalid()
      let verifiedReplyAuthorId:string|undefined
      let verifiedSource=source
      if(source.quote!==undefined){
        const quoteId=source.quote.messageId
        if(!safeId(quoteId))throw invalid()
        const quoted=copy(await ports.readMessage({binding,messageId:quoteId},guard))
        if(!quoted)throw invalid()
        messageInBinding(quoted,binding,quoteId)
        if(!await ports.sourceAllowed({binding,source:quoted},guard))throw invalid()
        verifiedReplyAuthorId=quoted.sender.id
        verifiedSource={...source,quote:{messageId:quoteId,author:{...quoted.sender},parts:[]}}
      }
      await ensure(guard)
      return resolveAgentDiceAuthorization({binding,source:verifiedSource,grant,evidence:{binding,sourceMessageId:source.messageId,actor,members,
        botUserId:binding.target.account.id,...(verifiedReplyAuthorId===undefined?{}:{verifiedReplyAuthorId})}})
    }catch{return undefined}
  }
  async function originAuthorization(origin:Origin,current:SourceRequest,guard:AgentDiceStateGuard):Promise<AgentDiceEngineAuthorization> {
    if(!sameBinding(origin.binding,current.binding)||!safeId(origin.source.messageId)||!safeId(origin.authorityRevision)||
      !/^[a-f0-9]{64}$/u.test(origin.operationId)||!/^[a-f0-9]{64}$/u.test(origin.source.fingerprint))throw invalid()
    const original=copy(await ports.readMessage({binding:origin.binding,messageId:origin.source.messageId},guard))
    if(!original)throw invalid()
    messageInBinding(original,origin.binding,origin.source.messageId)
    if(!sameUser(original.sender,origin.source.author)||original.occurredAt!==origin.source.occurredAt||agentDiceSourceFingerprint(original)!==origin.source.fingerprint)throw invalid()
    const auth=await authorize({binding:origin.binding,source:original},guard)
    if(!auth||auth.revision!==origin.authorityRevision)throw invalid()
    return auth
  }
  async function authorizePrivateOrigin(request:SourceRequest & {readonly origin:Origin;readonly recipientId:string;readonly requiredPermission?:'player'|'gm'},guard:AgentDiceStateGuard):Promise<boolean> {
    try{
      const [current,original]=await Promise.all([authorize(request,guard),originAuthorization(request.origin,request,guard)])
      const required=request.requiredPermission??'player'
      return !!current&&permission(current,'hidden',request.recipientId)&&permission(original,'hidden',request.recipientId)&&
        recipientPermission(current,required,request.recipientId)&&recipientPermission(original,required,request.recipientId)
    }catch{return false}
  }
  const engine=createAgentDiceEngine(config,{
    state:ports.state,legacyLedger:ports.legacyLedger,allowsText:ports.allowsText,...(ports.diagnostics?{diagnostics:ports.diagnostics}:{}),authorize,authorizePrivateOrigin,
    async deliver(request,guard){
      await ensure(guard)
      const auth=await authorize(request,guard)
      if(!auth)throw invalid()
      const {binding,source,effect,operationId,index}=request
      if(effect.kind==='public'){
        if(!ports.allowsText(effect.text))throw invalid()
        await ensure(guard)
        return ports.sendPublic({binding,source,text:effect.text,operationId,index},guard)
      }
      if(effect.kind==='card'){
        if(!ports.setGroupCard||!ports.allowsText(effect.name)||!permission(auth,'card',effect.subjectId)||effect.subjectId!==auth.actor.id&&!permission(auth,'delegate',effect.subjectId))return {state:'failed'}
        await ensure(guard)
        return ports.setGroupCard({binding,source,subject:{platform:binding.target.account.platform,namespace:binding.target.account.namespace,id:effect.subjectId},name:effect.name,operationId,index},guard)
      }
      if(effect.kind==='log'){
        if(!ports.controlLog)return {state:'failed'}
        if(!/^[a-f0-9]{64}$/u.test(effect.ownershipId)||effect.title!==undefined&&!ports.allowsText(effect.title))return {state:'failed'}
        await ensure(guard)
        const auth=await authorize(request,guard)
        if(!auth)return {state:'failed'}
        return ports.controlLog({binding,source,operation:effect.operation,ownershipId:effect.ownershipId,...(effect.title===undefined?{}:{title:effect.title}),operationId,index},guard)
      }
      if(!ports.relayPrivate)return {state:'failed'}
      const origin=effect.origin
      if(!origin)throw invalid()
      const relay:AgentDicePrivateRelayRequest=copy({binding,source,origin,recipient:{platform:binding.target.account.platform,namespace:binding.target.account.namespace,id:effect.recipientId},
        text:effect.text,operationId,index,...(effect.packId===undefined?{}:{packId:effect.packId}),...(effect.deliveryId===undefined?{}:{deliveryId:effect.deliveryId})})
      const verify=async()=>{
        await ensure(guard)
        if(!await authorizePrivateOrigin({binding,source,origin:relay.origin,recipientId:effect.recipientId,...(effect.requiredPermission===undefined?{}:{requiredPermission:effect.requiredPermission})},guard)||!ports.allowsText(relay.text))throw invalid()
        if((effect.packId===undefined)!==(effect.deliveryId===undefined))throw invalid()
        if(effect.packId!==undefined&&effect.deliveryId!==undefined){
          const row=await ports.state.readDelivery(binding,{packId:effect.packId,deliveryId:effect.deliveryId},guard)
          if(!row||row.packId!==effect.packId||row.deliveryId!==effect.deliveryId||row.operationId!==operationId||row.index!==index||row.state!=='unknown'||row.originId!==relay.origin.operationId)throw invalid()
        }
        await ensure(guard)
      }
      const relayGuard:AgentDiceRelayGuard={signal:guard.signal,isCurrent:()=>{try{return !guard.signal.aborted&&guard.isCurrent()}catch{return false}},ensureCurrent:verify}
      await verify()
      return ports.relayPrivate(relay,relayGuard)
    },
  })
  return Object.freeze({
    definitionId:engine.definitionId,
    isCandidate(message:IncomingMessage){try{return engine.isCandidate(copy(message))}catch{return false}},
    async handle(message:IncomingMessage,binding:AgentBindingSnapshot,context:AgentDiceEngineContext):Promise<boolean> {
      try{return await engine.handle(copy(message),copy(binding),context)}catch{return false}
    },
    async revokeSource(target:ConversationAddress,id:string,guard?:AgentDiceStateGuard):Promise<number> {
      await ensure(guard)
      const checked=copy(target)
      if(!safeId(id)||!isConversationAddress(checked)||checked.kind!=='group')throw invalid()
      const [current,legacy]=await Promise.allSettled([ports.state.revokeSourceByTarget(checked,id,guard),ports.legacyLedger.revokeSource(checked,id)])
      if(current.status!=='fulfilled'||legacy.status!=='fulfilled')throw invalid()
      await ensure(guard)
      return current.value
    },
    async purgeSubject(input:PurgeSubject,guard?:AgentDiceStateGuard):Promise<number> {
      await ensure(guard)
      const checked=copy(input)
      if(!isPlatformAccount(checked.account)||!safeId(checked.agentId)||!safeId(checked.subjectId)||checked.target!==undefined&&
        (!isConversationAddress(checked.target)||checked.target.kind!=='group'||!sameUser(checked.target.account,checked.account)))throw invalid()
      const [current,legacy]=await Promise.allSettled([ports.state.purgeSubject(checked,guard),ports.legacyLedger.purgeSubject(checked)])
      if(current.status!=='fulfilled'||legacy.status!=='fulfilled')throw invalid()
      await ensure(guard)
      return current.value
    },
  })
}
