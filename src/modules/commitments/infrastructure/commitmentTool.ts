// 承诺账本运行时:CommitmentTool(create/list/cancel,主链路与仿真共用)+ commitmentTick(每秒到期兑现)。
// 设计原则见 contracts/commitments.ts 头注。静态直发出站必经 sanitizeFinalReplyText(RULES.md 红线)。
import {createHash,randomUUID} from 'node:crypto'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {sanitizeFinalReplyText} from '../../conversation/domain/replySanitizer.js'
import {createCommitmentStore} from './commitmentStore.js'
import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
import {withDeliveryGuard} from '../../messaging/infrastructure/deliveryScope.js'
import {agentBindingIdentity,agentBindingToken,agentConversationKey,isPlatformAccount,platformAccountKey} from '../../runtime/domain/agentBindings.js'
import {ensureAgentBindingCurrent,isAgentBindingCurrent,type AgentBindingSnapshot,type AgentConversationScope,type ConversationAddress,type PlatformAccountRef} from '../../../contracts/agentBinding.js'
import {
  advanceCommitmentAfterRun,buildMissAdmissionText,buildRenewalAskText,checkCommitmentCaps,formatCommitmentLine,formatScheduleText,
  normalizeSchedule,renderCommitmentCard,renderRenewalCard,resolvedCommitmentConfig,shouldAskRenewal
} from '../domain/commitments.js'
import type {CommitmentData,CommitmentEvent,CommitmentPorts,CommitmentSourceMessage} from '../../../contracts/commitments.js'
import type {OutgoingPart} from '../../../contracts/platformMessage.js'
import type {AgentConversationActivityCapture} from '../../runtime/infrastructure/agentConversationActivity.js'
import {reportAgentFailure,type AgentDiagnostics} from '../../runtime/infrastructure/agentDiagnostics.js'

export interface CommitmentExecutionPorts {
  diagnostics?:Pick<AgentDiagnostics,'emit'>
  allowsExecution?(target:ConversationAddress):boolean
  captureExecution?(target:ConversationAddress):AgentConversationActivityCapture
  authorizePrivateSchedule?(origin:AgentBindingSnapshot, request:{messageId:string; sourceAt:number; text:string; groupId?:string},
    guard:()=>boolean):Promise<{ destinationBindingIdentity?:string } | undefined>
  authorizeOwnedSource?(origin:AgentBindingSnapshot,source:CommitmentSourceMessage,guard:()=>boolean):Promise<boolean>
  verifyOwnedDelivery?(binding:AgentBindingSnapshot, proof:{sha256:string;from:number;until:number}):Promise<string|undefined>
}
type TaskGuard = (()=>boolean) & { signal:AbortSignal; executionCurrent():boolean; release():void }

function event(value:unknown):CommitmentEvent {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as CommitmentEvent:{}
}

function taskVisible(c:CommitmentData,groupId:string,binding?:AgentBindingSnapshot):boolean {
  if(c.scope) {
    if(binding?.source!=='configured'||agentConversationKey(c.scope)!==agentConversationKey(binding))return false
    return !(c.importedReminder||c.deferredAction||c.privateRequest)||c.bindingIdentity===agentBindingIdentity(binding)
  }
  return binding?.source!=='configured'&&c.group_id===groupId
}

const BINDING_CHANGED = '角色绑定已改变，原承诺已停止'

export function createCommitmentRuntime(ports:CommitmentPorts & CommitmentExecutionPorts) {
  const store=createCommitmentStore(ports)
  const now=()=>ports.now?ports.now():Date.now()
  const privatePeerFor=(target:ConversationAddress)=>ports.resolvePrivatePeer ? ports.resolvePrivatePeer(target) : target.id
  const allowsExecution=(target:ConversationAddress|undefined)=>{
    try { return !target ? !ports.allowsExecution && !ports.captureExecution : ports.allowsExecution?.(target)!==false }
    catch { return false }
  }
  function captureExecution(target:ConversationAddress|undefined):AgentConversationActivityCapture {
    const inherited=target&&ports.captureExecution?.(target),controller=new AbortController()
    const signal=inherited?AbortSignal.any([controller.signal,inherited.signal]):controller.signal
    const isCurrent=()=>!signal.aborted&&allowsExecution(target)&&inherited?.isCurrent()!==false
    const timer=setInterval(()=>{if(!isCurrent())controller.abort()},25);timer.unref()
    if(!isCurrent())controller.abort()
    return {signal,isCurrent,release(){clearInterval(timer);controller.abort();inherited?.release()}}
  }
  const pausedError=()=>Object.assign(new Error('本会话 AI 活动已暂停，承诺等待恢复'),{executionPaused:true})

  class CommitmentTool extends AbstractTool {
    constructor(){
      super()
      this.name='commitmentTool'
      this.description=[
        '把群友托付的定时/循环事务记进承诺账本，到期由机器人兑现。',
        '用户说"每天X点做Y""定时Z""每隔…发…"或要我按时间执行动作时调用；一次性提醒（"10分钟后提醒我"）也走本工具。',
        'intent 必须保留用户原话（含时间语境），不要改写；时间信息缺失时先追问，不要编。'
      ].join('')
      this.skill={
        name:'commitmentTool',
        purpose:'把群友托付的定时/循环事务记进承诺账本，到期兑现。',
        whenToUse:'用户表达"到某个时间点/每天某时要做某事"且执行者是我（发消息、查东西、提醒、每日定点任务）时。',
        boundaries:'只接时间明确的托付，时间缺失先追问。deliver=static 仅限固定文字；要查数据/调工具的活必须 deliver=agent（需该群开仿真）。非定时请求、纯提醒类一次性闹钟也走本工具（once）。群成员都可创建，创建人和群管理可取消/续期。',
        instructions:[
          'schedule_kind: 循环=daily（schedule_time 填 HH:mm 24小时制）；一次性=once（schedule_time 填 ISO 8601 带 +08:00，按当前北京时间换算）。',
          'intent 保留用户原话，如"每天中午12点在群里发三角洲今日密码"。',
          'deliver: 默认 agent（到点我自己完成）；只有用户要发的就是一句固定文字时才 static 并把原文放 static_message。',
          '创建成功后向用户轻确认一句（什么时候会做什么），不要念参数。',
          '续期：承诺到期前几天系统会提醒你问创建人还续不续；对方说"续/继续/还要"就调 renew（commitment_id 用 list 查），回一句"好，继续给你记着"即可。'
        ].join('\n')
      }
      this.parameters={
        type:'object',
        properties:{
          action:{type:'string',enum:['create','list','cancel','renew'],description:'create 创建承诺；list 查看当前群承诺；cancel 取消（commitment_id 填 list 里的完整 id）；renew 续期（创建人说"续"时用）'},
          intent:{type:'string',description:'用户托付的原话（含时间语境），如"每天中午12点在群里发三角洲今日密码"。create 必填'},
          schedule_kind:{type:'string',enum:['once','daily'],description:'once=一次性；daily=每天循环'},
          schedule_time:{type:'string',description:'once 填 ISO 8601 带 +08:00（如 2026-11-10T12:00:00+08:00）；daily 填 HH:mm（如 12:00）'},
          deliver:{type:'string',enum:['agent','static'],description:'agent=到点我自己动手完成（默认）；static=到点直接发固定文字'},
          static_message:{type:'string',description:'deliver=static 时必填：到点要发的原文'},
          mention_creator:{type:'boolean',description:'定时群消息若只是普通发言，填 false；明确提醒委托人填 true'},
          commitment_id:{type:'string',description:'cancel/renew 时填 list 结果里的完整 id'}
        },
        required:['action'],
        additionalProperties:false
      }
    }

    async func(opts:Record<string,unknown>,e:unknown){
      const outcome = await this.executeWithReceipt(opts, e)
      return typeof outcome === 'string' ? outcome : outcome.content
    }

    async executeWithReceipt(opts:Record<string,unknown>,e:unknown){
      const ev=event(e)
      const action=String(opts.action||'').trim()
      if(!['create','list','cancel','renew'].includes(action))return `未知操作：${action||'(空)'}（可用 create/list/cancel/renew）`
      if(!isAgentBindingCurrent(ev))return 'error: 角色绑定已改变，承诺未操作'
      await ensureAgentBindingCurrent(ev)
      const binding=ev._agentBinding
      const groupId=binding ? (binding.target.kind==='group' ? binding.target.id : '') : String(ev.group_id||'')
      const scope=binding?.source==='configured'&&groupId?{agentId:binding.agentId,target:binding.target}:undefined
      if(action==='create')return await create(opts,ev,groupId,scope)
      if(action==='list')return groupId?await list(ev,groupId):'承诺是群维度的，请在群里查'
      if(binding?.source==='configured'&&!groupId)return '承诺是群维度的，请在群里查'
      if(action==='cancel')return await cancel(opts,ev,groupId)
      return await renew(opts,ev,groupId)
    }

    async managePrivateReminder(opts:Record<string,unknown>,ev:CommitmentEvent, requestMessageId?:string){
      const binding=ev._agentBinding
      if(binding?.source!=='configured'||binding.target.kind!=='private'||privatePeerFor(binding.target)!==String(ev.user_id||'')||!isAgentBindingCurrent(ev)) {
        return '这条私聊提醒当前不可操作。'
      }
      const owner={...ev,isMaster:false}
      await ensureAgentBindingCurrent(owner)
      if(opts.action==='list')return await list(owner,'')
      if(opts.action==='cancel')return await cancel(opts,owner,'')
      if(opts.action==='create'&&ports.authorizePrivateSchedule&&requestMessageId){
        const text=String(opts.static_message||'').trim()
        const sourceAt=owner._agentToolRequest?.occurredAt
        const groupId=typeof opts.target_group_id==='string'&&opts.target_group_id?opts.target_group_id:undefined
        if(!text||text.length>300||!Number.isSafeInteger(sourceAt)||sourceAt===undefined||opts.schedule_kind!=='once'||
            groupId&&!/^\d{5,12}$/u.test(groupId))return '请给出一次性时间和要发送的文字。指定群时需给出群号。'
        const grant=await ports.authorizePrivateSchedule(binding,{ messageId:requestMessageId,sourceAt,text,...(groupId?{groupId}:{})},
          ()=>isAgentBindingCurrent(owner))
        await ensureAgentBindingCurrent(owner)
        if(!grant||groupId&&!grant.destinationBindingIdentity)return '私聊来源或目标群权限未核实，请确认要发的原文和共同所在的群。'
        const privateRequest:NonNullable<CommitmentData['privateRequest']>={ messageId:requestMessageId,
          ...(groupId&&grant.destinationBindingIdentity?{groupId,destinationBindingIdentity:grant.destinationBindingIdentity}:{}) }
        return create({ ...opts, intent:text, deliver:'static' },owner,'',{ agentId:binding.agentId,target:binding.target },privateRequest)
      }
      return '此私聊可查看、取消本人提醒。'
    }
  }

  async function create(opts:Record<string,unknown>,ev:CommitmentEvent,groupId:string,scope?:AgentConversationScope,privateRequest?:CommitmentData['privateRequest']){
    const creatorId=String(ev.user_id||'')
    if(!groupId&&!privateRequest)return '承诺只能在群里创建（私聊没有群的上下文）'
    if(!creatorId)return 'error: 缺少创建人身份'
    const intent=String(opts.intent||'').trim()
    if(!intent)return '托付内容是空的——要记什么事？请把用户原话放 intent'

    const cfg=resolvedCommitmentConfig(ports.loadConfig())
    const active=await store.listActiveCommitments(()=>ensureAgentBindingCurrent(ev))
    await ensureAgentBindingCurrent(ev)
    const capError=checkCommitmentCaps(active.filter(c=>taskVisible(c,groupId,ev._agentBinding)),groupId,creatorId,cfg)
    if(capError)return capError

    const deliver=opts.deliver==='static'?'static':'agent'
    if(deliver==='agent'){
      const simGroup=await ports.isSimulationGroup(groupId,scope?.target)
      await ensureAgentBindingCurrent(ev)
      if(!simGroup)return '这个群没开仿真模式，到点需要我自己动手的活干不了；固定文字的定时发送可以（deliver=static 并给 static_message）'
    }
    const staticMessage=deliver==='static'?String(opts.static_message||'').trim():''
    if(deliver==='static'&&!staticMessage)return 'deliver=static 需要 static_message（到点要发的固定文字）'

    const at=now()
    const sourceAt=ev.sourceAt??ev._agentToolRequest?.occurredAt??at
    if(!Number.isSafeInteger(sourceAt)||sourceAt<0)return 'error: 承诺来源时间无效'
    const normalized=normalizeSchedule(opts.schedule_kind,opts.schedule_time,at)
    if('error'in normalized)return normalized.error

    const botId=ev._agentBinding?.target.account.id || String(ev.self_id||ev.bot?.uin||ports.getBot()?.uin||'')
    const uuid=randomUUID().replaceAll('-','')
    const commitment:CommitmentData={
      id:scope?`cmt_${at}_${uuid}`:`cmt_${at}_${creatorId}_${uuid.slice(0,6)}`,
      group_id:groupId,creator_id:creatorId,
      creator_name:String(ev.sender?.card||ev.sender?.nickname||creatorId),
      intent:intent.slice(0,200),
      schedule:normalized.schedule,deliver,
      static_message:staticMessage||null,
      ...(typeof opts.mention_creator==='boolean'?{mentionCreator:opts.mention_creator}:{}),
      expiry_at:at+cfg.defaultExpiryDays*86400_000,
      next_run_at:normalized.nextRunAt,status:'active',
      last_run_at:0,last_result:'',retry_count:0,created_at:at,sourceAt,bot_id:botId,
      ...(scope?{scope}:{}),
      ...(privateRequest?{privateRequest}:{}),
      ...(ev._agentBinding?{bindingIdentity:agentBindingIdentity(ev._agentBinding)}:{}),
    }
    await store.createCommitment(commitment, active=>{
      const error=checkCommitmentCaps(active.filter(c=>taskVisible(c,groupId,ev._agentBinding)),groupId,creatorId,cfg)
      if(error)throw new Error(error)
    },()=>isAgentBindingCurrent(ev),()=>ensureAgentBindingCurrent(ev))
    await ensureAgentBindingCurrent(ev)
    ports.logger.info(`[承诺] 创建 ${commitment.schedule.kind} 下次 ${formatScheduleText(commitment.schedule)}`)
    const deliverNote=deliver==='agent'?'到点我来办':'到点会原样发出来'
    return {
      content: `已记下：「${intent}」——${formatScheduleText(commitment.schedule)}，${deliverNote}（${cfg.defaultExpiryDays} 天后到期会再确认要不要续）。跟用户轻确认一句就行，别念参数。`,
      confirmation: `已登记${formatScheduleText(commitment.schedule)}的定时${deliver === 'static' ? '文字提醒' : '任务'}，编号 ${commitment.id}。`,
    }
  }

  async function manageableCommitments(ev:CommitmentEvent):Promise<CommitmentData[]>{
    const ensureCurrent=()=>ensureAgentBindingCurrent(ev)
    const active=await store.listActiveCommitments(ensureCurrent)
    await ensureCurrent()
    const unresolved=ports.redis.scanIterator?(await store.listDeferredActions(ensureCurrent)).filter(c=>c.status==='unknown'):[]
    await ensureCurrent()
    return [...active,...unresolved]
  }
  async function list(ev:CommitmentEvent,groupId:string){
    const userId=String(ev.user_id||'')
    const active=(await manageableCommitments(ev)).filter(c=>taskVisible(c,groupId,ev._agentBinding))
    if(!isAgentBindingCurrent(ev))return 'error: 角色绑定已改变，承诺未读取'
    const visible=ev.isMaster===true?active:active.filter(c=>c.creator_id===userId)
    if(!groupId){
      if(!visible.length)return '你目前没有待发的一次性提醒。'
      const at=now()
      return ['你的提醒（含待核实状态，取消用 commitment_id）',...visible.map(c=>formatCommitmentLine(c,at))].join('\n')
    }
    if(!visible.length)return ev.isMaster===true?'这个群目前没有任何定时托付':'你名下目前没有定时托付（群主/管理可看全部）'
    const at=now()
    return [`当前群的定时托付（取消用 commitment_id）：`,...visible.map(c=>formatCommitmentLine(c,at))].join('\n')
  }

  async function cancel(opts:Record<string,unknown>,ev:CommitmentEvent,groupId:string){
    const shortId=String(opts.commitment_id||'').trim()
    if(!shortId)return '要取消哪个？先 list 看完整 id'
    const active=(await manageableCommitments(ev)).filter(c=>taskVisible(c,groupId,ev._agentBinding))
    if(!isAgentBindingCurrent(ev))return 'error: 角色绑定已改变，承诺未取消'
    const matches=active.filter(c=>c.id.includes(shortId))
    if(!matches.length)return `没找到 id 含「${shortId}」的托付，先 list 确认`
    if(matches.length>1)return `「${shortId}」匹配到 ${matches.length} 条，把 id 抄全一点`
    const target=matches[0]!
    const userId=String(ev.user_id||'')
    if(target.creator_id!==userId&&ev.isMaster!==true)return '只能取消自己创建的托付（群主/管理可取消任何人的）'
    if(!await store.cancelCommitment(target.id,()=>isAgentBindingCurrent(ev),()=>ensureAgentBindingCurrent(ev)))return '托付已经结束、已取消或角色绑定已改变'
    await ensureAgentBindingCurrent(ev)
    if(groupId)ports.logger.info(`[承诺] 群 ${groupId} 取消 ${target.id}「${target.intent.slice(0,40)}」`)
    return `已取消：「${target.intent.slice(0,60)}」（${formatScheduleText(target.schedule)}）`
  }

  /** 续期:到期前问询后创建人说"续"→ 顺延一个默认周期,重置问询标记 */
  async function renew(opts:Record<string,unknown>,ev:CommitmentEvent,groupId:string){
    const shortId=String(opts.commitment_id||'').trim()
    if(!shortId)return '要续哪个？先 list 看完整 id'
    const active=(await store.listActiveCommitments(()=>ensureAgentBindingCurrent(ev))).filter(c=>taskVisible(c,groupId,ev._agentBinding))
    if(!isAgentBindingCurrent(ev))return 'error: 角色绑定已改变，承诺未续期'
    const matches=active.filter(c=>c.id.includes(shortId))
    if(!matches.length)return `没找到 id 含「${shortId}」的托付（可能已结束或已到期），先 list 确认`
    if(matches.length>1)return `「${shortId}」匹配到 ${matches.length} 条，把 id 抄全一点`
    const target=matches[0]!
    const userId=String(ev.user_id||'')
    if(target.creator_id!==userId&&ev.isMaster!==true)return '只能续自己创建的托付（群主/管理可续任何人的）'
    if(target.importedReminder||target.deferredAction)return '这是一条一次性提醒，不能续期。需要另一个时间的话可以新建提醒。'
    const cfg=resolvedCommitmentConfig(ports.loadConfig())
    const at=now()
    if(!await store.updateActive(target.id,current=>({...current,expiry_at:at+cfg.defaultExpiryDays*86400_000,renewal_asked_at:0}),()=>isAgentBindingCurrent(ev),()=>ensureAgentBindingCurrent(ev)))return '托付已结束、已取消或角色绑定已改变，未续期'
    await ensureAgentBindingCurrent(ev)
    ports.logger.info(`[承诺] 群 ${groupId} 续期 ${target.id}「${target.intent.slice(0,40)}」至 ${cfg.defaultExpiryDays} 天后`)
    return `已续期：「${target.intent.slice(0,60)}」再跑 ${cfg.defaultExpiryDays} 天（到期前会再问一次）。轻确认一句就行，别念参数。`
  }

  function targetFor(c:CommitmentData):ConversationAddress | undefined {
    if(c.scope&&c.privateRequest?.groupId)return { account:c.scope.target.account,kind:'group',id:c.privateRequest.groupId }
    if(c.scope)return c.scope.target
    const accountId=c.bot_id || String(ports.getBot()?.uin||'')
    if(accountId)return {account:{platform:'qq',namespace:'global',id:accountId},kind:'group',id:c.group_id}
    return undefined
  }

  function captureTaskGuard(c:CommitmentData,target:ConversationAddress | undefined): TaskGuard | null | undefined {
    const resolve=ports.resolveBinding
    const owner=c.scope?.target??target
    const snapshot=owner&&resolve?.(owner)
    if(c.scope){
      if(snapshot?.source!=='configured'||agentConversationKey(snapshot)!==agentConversationKey(c.scope))return null
    }else if(resolve&&target&&snapshot?.source!=='legacy'){
      return null
    }
    const token=snapshot?agentBindingToken(snapshot):undefined
    if(c.bindingIdentity&&(!snapshot||c.bindingIdentity!==agentBindingIdentity(snapshot)))return null
    if(owner?.kind==='private'){
      const recipient=privatePeerFor(owner)
      if(recipient===undefined)return undefined
      if(recipient!==c.creator_id)return null
    }
    const destination=c.privateRequest?.groupId&&target?.kind==='group'?resolve?.(target):undefined
    if(c.privateRequest?.groupId&&target?.kind==='group'&&(!destination||destination.agentId!==snapshot?.agentId||
        agentBindingIdentity(destination)!==c.privateRequest.destinationBindingIdentity))return null
    const destinationToken=destination?agentBindingToken(destination):undefined
    const execution=captureExecution(target)
    let valid=true
    const guard = () => {
      if(!execution.isCurrent())return false
      if(!valid)return false
      valid=false
      try {
        const live=owner&&resolve?.(owner)
        const liveDestination=destination&&target?resolve?.(target):undefined
        valid=(live?agentBindingToken(live):undefined)===token&&
          (owner?.kind!=='private'||privatePeerFor(owner)===c.creator_id)&&
          (liveDestination?agentBindingToken(liveDestination):undefined)===destinationToken
      } catch { /* The binding could not be revalidated. */ }
      return valid
    }
    return Object.assign(guard,{signal:execution.signal,executionCurrent:execution.isCurrent,release:execution.release})
  }

  function bindingChangedError() {
    return Object.assign(new Error(BINDING_CHANGED),{bindingChanged:true})
  }

  async function sendTaskText(c:CommitmentData,text:string,target:ConversationAddress | undefined,isCurrent:TaskGuard,ensureCurrent?:()=>Promise<void>) {
    if(!isCurrent()){if(!isCurrent.executionCurrent())throw pausedError();throw bindingChangedError()}
    const safe=sanitizeFinalReplyText(text)
    if(!safe&&c.importedReminder)throw new Error('提醒文字无法发送')
    const body=` ${safe}`
    if(c.scope){
      if(!target||!ports.messageActions)throw new Error('承诺会话的消息适配器不可用')
      const {platform,namespace}=target.account
      const parts:OutgoingPart[]=target.kind==='private'||c.privateRequest||c.mentionCreator===false? [{kind:'text',text:safe}]
        : [{kind:'mention',user:{platform,namespace,id:c.creator_id}},{kind:'text',text:body}]
      const result=await sendWithDeadline(()=>ports.messageActions!.send({
        version:1,kind:'message.send',target,parts,
      },{isCurrent,...(ensureCurrent?{ensureCurrent}:{})}),isCurrent.signal)
      if(result&&typeof result==='object'&&'state' in result&&result.state==='failed'&&!isCurrent.executionCurrent())throw pausedError()
      assertSent(result)
    }else{
      const bot=ports.getBot(target?.account.id||c.bot_id||undefined)
      if(!bot?.sendApi)throw new Error('绑定的机器人未连接')
      if(!isCurrent()){if(!isCurrent.executionCurrent())throw pausedError();throw bindingChangedError()}
      const result=await sendWithDeadline(()=>withDeliveryGuard(isCurrent,()=>bot.sendApi!('send_group_msg',{
        group_id:Number(c.group_id),
        message:c.mentionCreator===false?[{type:'text',data:{text:safe}}]:[{type:'at',data:{qq:c.creator_id}},{type:'text',data:{text:body}}],
      })),isCurrent.signal)
      assertSent(result)
    }
  }

  async function ensurePrivateGrant(c:CommitmentData,guard:TaskGuard):Promise<void>{
    if(!c.privateRequest||!c.scope)return
    const origin=ports.resolveBinding?.(c.scope.target)
    const {messageId,groupId,destinationBindingIdentity}=c.privateRequest
    const grant=origin&&await ports.authorizePrivateSchedule?.(origin,{
      messageId,sourceAt:c.sourceAt!,text:String(c.static_message),...(groupId?{groupId}:{})
    },guard)
    if(!grant||grant.destinationBindingIdentity!==destinationBindingIdentity||!guard())throw bindingChangedError()
  }

  function ownedReservationId(binding:AgentBindingSnapshot,goalId:string) {
    return 'cmt_own_'+createHash('sha256').update(JSON.stringify([agentBindingIdentity(binding),goalId])).digest('hex')
  }
  async function ownedReservation(binding:AgentBindingSnapshot,goalId:string) {
    let item=await store.getCommitment(ownedReservationId(binding,goalId))
    if(!item||item.ownedReservation?.goalId!==goalId||item.bindingIdentity!==agentBindingIdentity(binding))return undefined
    if(item.status==='unknown'&&item.ownedReservation.attemptedAt!==undefined&&item.static_message&&ports.verifyOwnedDelivery) {
      const from=Math.floor(item.ownedReservation.attemptedAt/1000)*1000
      const messageId=await ports.verifyOwnedDelivery(binding,{
        sha256:createHash('sha256').update(item.static_message).digest('hex'),from,until:from+60_000,
      })
      if(messageId){
        const token=agentBindingToken(binding)
        const current=()=>{
          const live=ports.resolveBinding?.(binding.target)
          return !!live&&agentBindingToken(live)===token
        }
        item=await store.confirmOwnedReservation(item,messageId,current)??item
      }
    }
    return { id:item.id, status:item.status, at:item.schedule.kind==='once'?item.schedule.time:item.next_run_at }
  }
  async function reserveOwned(binding:AgentBindingSnapshot,goalId:string,source:CommitmentSourceMessage,
    scheduledTime:string,message:string,guard:()=>boolean) {
    const target=binding.target, token=agentBindingToken(binding)
    const current=()=>{
      const live=ports.resolveBinding?.(target)
      return guard()&&!!live&&agentBindingToken(live)===token
    }
    const ensureCurrent=async()=>{if(!current())throw bindingChangedError()}
    if(binding.source!=='configured'||target.kind!=='group'||!current()||!ports.authorizeOwnedSource)throw bindingChangedError()
    const existing=await ownedReservation(binding,goalId)
    if(existing)return existing
    const at=now(), schedule=normalizeSchedule('once',scheduledTime,at), safe=sanitizeFinalReplyText(message)
    if('error'in schedule||!safe||safe!==message||safe.length>300||schedule.nextRunAt>at+30*86400_000)return undefined
    if(!await ports.authorizeOwnedSource(binding,source,current)||!current())return undefined
    const item:CommitmentData={
      id:ownedReservationId(binding,goalId), group_id:target.id, creator_id:target.account.id,
      creator_name:target.account.id, intent:safe.slice(0,200), schedule:schedule.schedule, deliver:'static',
      static_message:safe, mentionCreator:false, ownedReservation:{goalId,source}, expiry_at:0,
      next_run_at:schedule.nextRunAt, status:'active', last_run_at:0, last_result:'', retry_count:0, created_at:at,
      bot_id:target.account.id, scope:{agentId:binding.agentId,target}, bindingIdentity:agentBindingIdentity(binding),
    }
    try {
      await store.createCommitment(item,active=>{
        const error=checkCommitmentCaps(active.filter(task=>taskVisible(task,target.id,binding)),target.id,target.account.id,resolvedCommitmentConfig(ports.loadConfig()))
        if(error)throw new Error(error)
      },current,ensureCurrent)
    } catch(error) {
      // If a concurrent or interrupted registration committed first, use its receipt.
      if(!current()||!await ownedReservation(binding,goalId))throw error
    }
    await ensureCurrent()
    return ownedReservation(binding,goalId)
  }

  async function ensureDeliverySource(c:CommitmentData,guard:TaskGuard) {
    await ensurePrivateGrant(c,guard)
    if(!c.ownedReservation||!c.scope)return
    const origin=ports.resolveBinding?.(c.scope.target)
    if(!origin||!await ports.authorizeOwnedSource?.(origin,c.ownedReservation.source,guard)||!guard())throw bindingChangedError()
  }

  /** 群内通知(失约明说/续约问询)，发送失败只记日志。 */
  async function sendGroupNotice(c:CommitmentData,text:string,isCurrent?:()=>Promise<boolean>){
    let guard:TaskGuard|null|undefined
    try{
      if(isCurrent&&!await isCurrent())return
      const target=c.privateRequest?c.scope?.target:targetFor(c)
      guard=captureTaskGuard(c,target)
      if(guard)await sendTaskText(c,text,target,guard)
    }catch(error){
      reportAgentFailure(ports.diagnostics, { stage: 'delivery', operation: 'commitment_notice', code: 'commitment_notice_not_confirmed', error },
        () => ports.logger.warn(`[承诺] 群 ${c.group_id} 通知发送失败(明说/续约)`))
    }finally{guard?.release()}
  }

  /** 终态失败收口:记 faillog(哨兵告警)+ 失约明说(失败可见比失约本身伤信任得多) */
  async function finalizeFailure(c:CommitmentData,reason:string,at:number){
    await store.appendFailLog({id:c.id,intent:c.intent,group_id:c.group_id,reason:reason.slice(0,80),at}).catch(()=>{})
    if(!c.importedReminder)await sendGroupNotice(c,buildMissAdmissionText(c,reason))
  }

  /** 续约问询扫描(10 分钟一拍,闭内冷却):到期前 3 天问一次,只问一次 */
  const nextRenewalScanAt=new Map<string,number>()
  async function maybeAskRenewals(key:string,handles:(c:CommitmentData)=>boolean){
    const at=now()
    if(at<(nextRenewalScanAt.get(key)??0))return
    nextRenewalScanAt.set(key,at+10*60_000)
    const active=await store.listActiveCommitments()
    for(const c of active){
      if(!shouldAskRenewal(c,at))continue
      let guard:TaskGuard|null|undefined
      try{
        if(!handles(c))continue
        const target=targetFor(c)
        guard=captureTaskGuard(c,target)
        if(!guard)continue
        const currentGuard=guard
        if(!await store.updateActive(c.id,current=>shouldAskRenewal(current,at)?{...current,renewal_asked_at:at}:null,guard))continue
        const isCurrent=async()=>{const current=await store.getCommitment(c.id);return current?.status==='active'&&current.renewal_asked_at===at&&currentGuard()}
        if(c.deliver==='agent'&&await ports.isSimulationGroup(c.group_id,target)){
          const runOptions={taskId:`renewal:${c.id}:${at}`,botId:c.bot_id,isCurrent,signal:guard.signal}
          await waitForExecution(()=>ports.wakeSim(c.group_id,renderRenewalCard(c,at),runOptions,target),guard,()=>false)
        }else{
          await sendGroupNotice(c,buildRenewalAskText(c,at),isCurrent)
        }
        ports.logger.info(`[承诺] ${c.id}「${c.intent.slice(0,40)}」续约问询已尝试（不自动重复）`)
      }catch(error){
        reportAgentFailure(ports.diagnostics, { stage: 'runtime', operation: 'commitment_renewal', code: 'commitment_renewal_failed', error },
          () => ports.logger.warn(`[承诺] ${c.id} 续约问询失败(不自动重复)`))
      }finally{guard?.release()}
    }
  }

  function uncertainError(message:string){return Object.assign(new Error(message),{uncertain:true})}
  function assertSent(result:unknown){
    const receipt=normalizeDeliveryReceipt(result)
    if(receipt.state==='sent')return
    if(receipt.state==='unknown')throw uncertainError('发送回执缺失或无法确认，停止自动重发')
    if(receipt.code==='binding_changed')throw bindingChangedError()
    throw Object.assign(new Error(`发送被明确拒绝${receipt.code?` (${receipt.code})`:''}`),{safeToRetry:true})
  }
  async function sendWithDeadline(send:()=>Promise<unknown>,signal?:AbortSignal):Promise<unknown>{
    if(signal?.aborted)throw pausedError()
    let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined
    try{
      return await Promise.race([send().catch(error=>{throw uncertainError(error instanceof Error?error.message:String(error))}),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(uncertainError('发送超时，结果未知')),60_000)
        abort=()=>reject(uncertainError('发送期间会话活动已暂停，结果未知'))
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
      })])
    }finally{if(timer)clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort)}
  }
  async function waitForExecution<T>(run:()=>Promise<T>,guard:TaskGuard,started:()=>boolean):Promise<T>{
    if(!guard.executionCurrent())throw pausedError()
    let abort:(()=>void)|undefined
    try{
      return await Promise.race([Promise.resolve().then(()=>{if(!guard.executionCurrent())throw pausedError();return run()}),new Promise<never>((_,reject)=>{
        abort=()=>reject(started()?uncertainError('执行期间会话活动已暂停，结果未知'):pausedError())
        guard.signal.addEventListener('abort',abort,{once:true});if(guard.signal.aborted)abort()
      })])
    }finally{if(abort)guard.signal.removeEventListener('abort',abort)}
  }
  const ticks=new Map<string,Promise<void>>()
  let accountScoped=false
  let recovery:Promise<void>|undefined
  async function runTick(accountKey?:string){
    recovery??=store.recoverLegacyIndex().catch(error=>{recovery=undefined;throw error})
    await recovery
    const handles=(c:CommitmentData)=>{
      if(c.deferredAction)return false
      if(accountKey!==undefined&&(!c.scope||platformAccountKey(c.scope.target.account)!==accountKey))return false
      const target=targetFor(c)
      return allowsExecution(target)&&ports.handlesTarget?.(target)!==false
    }
    await maybeAskRenewals(accountKey??'',handles).catch(error => {
      reportAgentFailure(ports.diagnostics, { stage: 'runtime', operation: 'commitment_renewal', code: 'commitment_renewal_scan_failed', error },
        () => ports.logger.warn('[承诺] 续约扫描失败'))
    })
    const due=await store.takeDueCommitments(now(),handles)
    if(!due.length)return
    // Keep every claim alive while another group/task is executing. Different claims retain identity.
    const pending=new Map(due.map(c=>[c.id,c]))
    let heartbeatRun:Promise<unknown>|undefined
    const heartbeat=setInterval(()=>{
      if(heartbeatRun)return
      heartbeatRun=Promise.allSettled([...pending.values()].map(c=>store.refreshClaim(c,now())))
        .finally(()=>{heartbeatRun=undefined})
    },30_000)
    heartbeat.unref?.()
    try{
      for(const c of due){
        let externalStarted=false
        let executionGuard:TaskGuard|null|undefined
        try{
          if(!await store.refreshClaim(c,now()))continue
          if(await store.expireClaim(c,now())!=='current')continue
          if(!handles(c)){
            await store.releaseUnstartedClaim(c)
            continue
          }
          const target=targetFor(c)
          let guard:TaskGuard|null|undefined
          try { guard=captureTaskGuard(c,target) } catch (error) {
            // An invalid config is recoverable. Leave this claim unstarted so
            // the same task can be considered after the lease and config recover.
            reportAgentFailure(ports.diagnostics, { stage: 'runtime', operation: 'commitment_tick', code: 'commitment_execution_guard_failed', error },
              () => ports.logger.warn(`[承诺] ${c.id} 暂停领取`))
            continue
          }
          if(guard===undefined){
            await store.releaseUnstartedClaim(c)
            continue
          }
          if(guard===null)throw bindingChangedError()
          executionGuard=guard
          if(!guard.executionCurrent()){await store.releaseUnstartedClaim(c);continue}
          await ensureDeliverySource(c,guard)
          if(c.deliver==='agent'){
            if(!await ports.isSimulationGroup(c.group_id,target)){
              if(!ports.waitForSimulation)throw new Error('群未开仿真，无法兑现')
              await store.releaseUnstartedClaim(c)
              continue
            }
            const runOptions={
              taskId:c.run_id!,botId:c.bot_id,
              signal:guard.signal,
              isCurrent:()=>store.refreshClaim(c,now(),false,guard),
              beforeExecution:async()=>{const allowed=await store.refreshClaim(c,now(),true,guard);if(allowed)externalStarted=true;return allowed},
            }
            const result=await waitForExecution(()=>ports.wakeSim(c.group_id,renderCommitmentCard(c),runOptions,target),guard,()=>externalStarted)
            if(!result||result.status==='unknown')throw uncertainError(result?.error||'仿真执行没有返回可确认的回执')
            if(result.status==='deferred'){
              if(externalStarted||result.sent>0||(result.actions||0)>0)throw uncertainError('承诺已开始执行，无法安全延期')
              await store.releaseUnstartedClaim(c)
              continue
            }
            if(result.status==='cancelled'){
              await store.commitRunOutcome({...c,status:'cancelled',next_run_at:0,last_result:result.error||'执行前已停止'})
              continue
            }
            if(result.status!=='succeeded'||!(result.sent>0||(result.actions||0)>0)){
              if(result.sent>0||(result.actions||0)>0)throw uncertainError(result.error||'部分动作已执行，不能自动重试整个任务')
              throw Object.assign(new Error(result.error||'仿真回合没有确认执行动作'),{safeToRetry:true})
            }
            externalStarted=true
          }else{
            if(!await store.refreshClaim(c,now(),true,guard)){
              if(!guard.executionCurrent())throw pausedError()
              if(!guard())throw bindingChangedError()
              continue
            }
            await sendTaskText(c,String(c.static_message||c.intent),target,guard,c.privateRequest||c.ownedReservation?()=>ensureDeliverySource(c,guard):undefined)
            externalStarted=true
          }
          const advanced=advanceCommitmentAfterRun(c,now())
          await store.commitRunOutcome({...c,last_run_at:now(),retry_count:0,last_result:c.deliver==='agent'?'执行回合已确认动作':'sent',next_run_at:advanced.nextRunAt??0,status:advanced.status})
        }catch(error){
          const reason=String(error instanceof Error?error.message:error).slice(0,160)
          ports.logger.error(`[承诺] 兑现 ${c.id} 失败:`,error)
          const metadata=typeof error==='object'&&error!==null?error as {uncertain?:boolean;safeToRetry?:boolean;bindingChanged?:boolean;executionPaused?:boolean}:{}
          const executionPaused=metadata.executionPaused===true||executionGuard?.executionCurrent()===false
          if(executionPaused&&!externalStarted&&metadata.uncertain!==true){
            if(!await store.releaseUnstartedClaim(c))await store.commitRunOutcome({...c,status:'active',last_result:'会话活动已暂停，尚未执行，等待恢复'})
            continue
          }
          if(metadata.bindingChanged===true&&!executionPaused){
            const cancelled=await store.commitRunOutcome({...c,status:'cancelled',next_run_at:0,last_result:BINDING_CHANGED})
            if(cancelled&&c.privateRequest?.groupId)await sendGroupNotice(c,'你托付的定时群消息未发送，原消息或目标群权限已失效。')
            continue
          }
          const unknown=metadata.uncertain===true||(externalStarted&&metadata.safeToRetry!==true)
          if(unknown){
            if(await store.commitRunOutcome({...c,status:'unknown',next_run_at:0,last_run_at:now(),last_result:reason})){
              await store.appendFailLog({id:c.id,intent:c.intent,group_id:c.group_id,reason:`结果未知，不自动重试：${reason}`,at:now()})
              if(c.privateRequest?.groupId)await sendGroupNotice(c,'你托付的定时群消息结果未确认。我会保留记录，避免重复发送。')
            }
          }else{
            const outcome=await store.requeueForRetry({...c,last_result:reason},now())
            if(outcome==='failed')await finalizeFailure(c,reason,now())
          }
        }finally{executionGuard?.release();pending.delete(c.id)}
      }
    }finally{
      clearInterval(heartbeat)
      await heartbeatRun
    }
  }
  /** Standalone schedules each verified account independently. The no-arg worker keeps the legacy serial order. */
  function commitmentTick(account?:PlatformAccountRef):Promise<void>{
    if(account!==undefined&&!isPlatformAccount(account))return Promise.reject(new Error('承诺调度缺少有效的平台账号'))
    if(account===undefined&&accountScoped)return Promise.reject(new Error('承诺调度需要指定接收账号'))
    if(account!==undefined&&ticks.has(''))return Promise.reject(new Error('全局承诺调度尚未完成'))
    accountScoped||=account!==undefined
    const accountKey=account&&platformAccountKey(account)
    const key=accountKey??''
    const active=ticks.get(key)
    if(active)return active
    const tick=runTick(accountKey).finally(()=>{ticks.delete(key)})
    ticks.set(key,tick)
    return tick
  }
  /** Call after the host has stopped accepting new ticks. */
  async function drainCommitmentTicks():Promise<void>{await Promise.allSettled(ticks.values())}
  return {CommitmentTool,commitmentTick,drainCommitmentTicks,store,reserveOwned,ownedReservation}
}
