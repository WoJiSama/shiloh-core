// 承诺账本 redis 存储:pending:list(按 next_run_at 排序)+ detail:{id},锁模式对齐 ReminderTool。
import {createHash,randomUUID} from 'node:crypto'
import type {CommitmentData,CommitmentRedisLike} from '../../../contracts/commitments.js'
import type {AgentDeferredActionData} from '../../../contracts/agentDeferredAction.js'
import {agentConversationKey,decodeAgentConversationKey,isPlatformIdentifier} from '../../runtime/domain/agentBindings.js'
import {reportAgentFailure,type AgentDiagnostics} from '../../runtime/infrastructure/agentDiagnostics.js'
import {assertDeferredGrant,decodeAgentDeferredAction} from './agentDeferredActionData.js'
import type {AgentSourceMemoryCleanupGuard,AgentSourceMemoryPurgeSubject} from '../../../contracts/sourceMemoryCleanup.js'
import {conversationCleanupAllows,parseConversationCleanup,type ConversationCleanupSelector} from '../../memory/infrastructure/conversationMemoryCleanup.js'
import {cleanupExpected,createSubjectMemoryCleanup} from '../../memory/infrastructure/subjectMemoryCleanup.js'

const REDIS_KEY_PREFIX='bl-chat:commitment:'
export const COMMITMENT_PENDING_KEY=`${REDIS_KEY_PREFIX}pending:list`
const FAILLOG_KEY=`${REDIS_KEY_PREFIX}faillog`
const FAILLOG_LIMIT=20
export const COMMITMENT_LOCK_KEY=`${REDIS_KEY_PREFIX}lock`
export const COMMITMENT_CLEANUP_KEY=`${REDIS_KEY_PREFIX}cleanup:v1`
const cleanupIdKey=(id:string)=>`${REDIS_KEY_PREFIX}cleanup:id:${createHash('sha256').update(id).digest('hex')}`
const LOCK_TIMEOUT=15000
const LOCK_ACQUIRE_TIMEOUT=1500

interface PendingEntry{id:string;next_run_at:number}
const invalidationListeners=new WeakMap<CommitmentRedisLike,Map<string,Set<()=>void>>>()

function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}

export function commitmentDetailKey(id:string):string {return `${REDIS_KEY_PREFIX}detail:${id}`}

export function decodeCommitmentPendingList(data:string|null):PendingEntry[]{
  if(!data)return []
  const parsed:unknown=JSON.parse(data)
  if(!Array.isArray(parsed))throw new Error('承诺索引损坏，停止修改')
  return parsed.map(value=>{
    const r=record(value)
    if(typeof r.id!=='string'||!Number.isFinite(Number(r.next_run_at)))throw new Error('承诺索引损坏')
    return {id:r.id,next_run_at:Number(r.next_run_at)}
  })
}

export function decodeCommitment(data:string):CommitmentData {
  const r=record(JSON.parse(data))
  if(typeof r.id!=='string'||typeof r.group_id!=='string'||typeof r.creator_id!=='string'||typeof r.intent!=='string')throw new Error('承诺详情损坏')
  const schedule=record(r.schedule)
  const normalizedSchedule=schedule.kind==='daily'
    ?{kind:'daily' as const,time:String(schedule.time||'')}
    :{kind:'once' as const,time:Number(schedule.time)||0}
  const status=r.status
  if(!['active','completed','failed','expired','cancelled','unknown'].includes(String(status)))throw new Error('承诺状态无效')
  const deliver=r.deliver==='static'?'static':'agent'
  const scope=typeof r.scopeKey==='string'?decodeAgentConversationKey(r.scopeKey):null
  const bindingIdentity=r.bindingIdentity
  const importedReminder=r.importedReminder===true
  const origin=record(r.privateRequest)
  const privateRequest=r.privateRequest===undefined?undefined:(()=>{
    if(typeof origin.messageId!=='string'||!origin.messageId||origin.messageId.length>128||
      (origin.groupId===undefined)!==(origin.destinationBindingIdentity===undefined)||
      origin.groupId!==undefined&&(typeof origin.groupId!=='string'||!/^\d{5,12}$/u.test(origin.groupId)||
        typeof origin.destinationBindingIdentity!=='string'||!origin.destinationBindingIdentity||origin.destinationBindingIdentity.length>8192))
      throw new Error('私聊承诺来源损坏')
    return { messageId:origin.messageId, ...(typeof origin.groupId==='string'?{
      groupId:origin.groupId,destinationBindingIdentity:String(origin.destinationBindingIdentity)}:{}) }
  })()
  const ownedReservation=r.ownedReservation===undefined?undefined:(()=>{
    const value=record(r.ownedReservation), source=record(value.source)
    if(typeof value.goalId!=='string'||!value.goalId||value.goalId.length>64||
      typeof source.messageId!=='string'||!source.messageId||source.messageId.length>128||
      !isPlatformIdentifier(source.authorId)||typeof source.at!=='number'||!Number.isSafeInteger(source.at)||source.at<0||
      value.attemptedAt!==undefined&&(typeof value.attemptedAt!=='number'||!Number.isSafeInteger(value.attemptedAt)||value.attemptedAt<0)||
      value.verifiedMessageId!==undefined&&(typeof value.verifiedMessageId!=='string'||!value.verifiedMessageId||value.verifiedMessageId.length>128)||
      scope?.target.kind!=='group'||r.creator_id!==r.bot_id||source.authorId===r.bot_id||
      deliver!=='static'||normalizedSchedule.kind!=='once'||typeof r.static_message!=='string'||!r.static_message.trim()||
      r.mentionCreator!==false||r.expiry_at!==0||importedReminder||privateRequest||r.deferredAction!==undefined) {
      throw new Error('自主预约来源损坏')
    }
    return {goalId:value.goalId,source:{messageId:source.messageId,authorId:source.authorId,at:source.at},
      ...(typeof value.attemptedAt==='number'?{attemptedAt:value.attemptedAt}:{}),
      ...(typeof value.verifiedMessageId==='string'?{verifiedMessageId:value.verifiedMessageId}:{})}
  })()
  if(r.sourceAt!==undefined&&(!Number.isSafeInteger(r.sourceAt)||Number(r.sourceAt)<0))throw new Error('承诺来源时间损坏')
  if(r.mentionCreator!==undefined&&typeof r.mentionCreator!=='boolean')throw new Error('承诺提醒方式损坏')
  const deferredAction=r.deferredAction===undefined?undefined:decodeAgentDeferredAction(r.deferredAction)
  const scopeMatches=scope?.target.account.id===r.bot_id && (scope?.target.kind==='group' ? scope.target.id===r.group_id :
    (importedReminder||privateRequest)&&scope?.target.kind==='private'&&scope.target.id===r.creator_id&&r.group_id==='')
  if((r.scopeKey!==undefined&&(!scope||!scopeMatches))||
    (bindingIdentity!==undefined&&(typeof bindingIdentity!=='string'||!bindingIdentity||bindingIdentity.length>8192))||
    (scope&&!bindingIdentity)||
    ((importedReminder||privateRequest)&&(!scope||deliver!=='static'||normalizedSchedule.kind!=='once'||typeof r.static_message!=='string'||!r.static_message.trim())) ||
    (privateRequest&&(scope?.target.kind!=='private'||!Number.isSafeInteger(r.sourceAt)||importedReminder||deferredAction))) {
    throw new Error('承诺会话分区损坏')
  }
  if(deferredAction){
    if(!scope||typeof bindingIdentity!=='string'||deliver!=='static'||normalizedSchedule.kind!=='once'||typeof r.static_message!=='string'||!r.static_message.trim())throw new Error('延期提醒会话分区损坏')
    assertDeferredGrant(deferredAction.grant,deferredAction.action,bindingIdentity,{...scope.target.account,id:r.creator_id},agentConversationKey(scope))
    if(deferredAction.grant.dueAt!==normalizedSchedule.time)throw new Error('延期委托授权与排期不符')
    if(deferredAction.state==='unknown'&&status==='active')throw new Error('未知延期动作不能处于待执行状态')
  }
  return {
    id:r.id,group_id:r.group_id,creator_id:r.creator_id,creator_name:String(r.creator_name||''),
    intent:r.intent,schedule:normalizedSchedule,deliver,
    static_message:typeof r.static_message==='string'?r.static_message:null,
    ...(typeof r.mentionCreator==='boolean'?{mentionCreator:r.mentionCreator}:{}),
    ...(importedReminder?{importedReminder:true as const}:{}),
    ...(privateRequest?{privateRequest}:{}),
    ...(ownedReservation?{ownedReservation}:{}),
    ...(deferredAction?{deferredAction}:{}),
    expiry_at:Number(r.expiry_at)||0,renewal_asked_at:Number(r.renewal_asked_at)||0,
    next_run_at:Number(r.next_run_at)||0,status:status as CommitmentData['status'],
    last_run_at:Number(r.last_run_at)||0,last_result:String(r.last_result||''),retry_count:Number(r.retry_count)||0,
    created_at:Number(r.created_at)||0,bot_id:String(r.bot_id||''),revision:Number(r.revision)||0,
    ...(r.sourceAt===undefined?{}:{sourceAt:Number(r.sourceAt)}),
    ...(scope?{scope}:{}),
    ...(typeof bindingIdentity==='string'?{bindingIdentity}:{}),
    ...(typeof r.run_id==='string'&&r.run_id?{run_id:r.run_id,lease_until:Number(r.lease_until)||0,execution_state:r.execution_state==='executing'?'executing' as const:'claimed' as const}:{})
  }
}

export function encodeCommitment(commitment:CommitmentData):string {
  const {scope,...detail}=commitment
  return JSON.stringify(scope?{...detail,scopeKey:agentConversationKey(scope)}:detail)
}

/** A claim remains indexed until completion. Executing claims never replay after lease expiry. */
export const COMMITMENT_LEASE_MS=120_000
const WRITE_STATE=`-- commitment-state-v2
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
if (redis.call('GET',KEYS[4]) or false)~=(ARGV[5]=='1' and ARGV[6] or false) then return 0 end
if redis.call('EXISTS',KEYS[5])==1 then return -1 end
if (redis.call('GET',KEYS[2]) or false)~=(ARGV[7]=='1' and ARGV[8] or false) then return 0 end
redis.call("SET", KEYS[2], ARGV[2])
if tonumber(ARGV[4]) > 0 then redis.call("EXPIRE", KEYS[2], ARGV[4]) end
redis.call("SET", KEYS[3], ARGV[3])
return 1`
const WRITE_FAILURES=`-- commitment-failures-cas-v1
if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
if (redis.call('GET',KEYS[2]) or '')~=ARGV[2] then return 0 end
if #KEYS>2 and (redis.call('GET',KEYS[3]) or false)~=(ARGV[4]=='1' and ARGV[5] or false) then return 0 end
if #KEYS>3 and redis.call('EXISTS',KEYS[4])==1 then return -2 end
redis.call('SET',KEYS[2],ARGV[3]); return 1`
const READ_STATE=`-- commitment-cleanup-read-v1
return {redis.call('GET',KEYS[1]) or false,redis.call('GET',KEYS[2]) or false,redis.call('GET',KEYS[3]) or false}`
const PURGE_STATE=`-- commitment-cleanup-purge-v1
if redis.call('GET',KEYS[1])~=ARGV[1] then return -1 end
for i=1,4 do if (redis.call('GET',KEYS[i+1]) or false)~=(ARGV[2*i]=='1' and ARGV[2*i+1] or false) then return 0 end end
redis.call('SET',KEYS[6],'1')
redis.call('DEL',KEYS[2])
redis.call('SET',KEYS[3],ARGV[10])
if ARGV[11]=='1' then redis.call('SET',KEYS[4],ARGV[12]) end
return 1`

export interface CommitmentFailure {
  id?:string;intent?:string;group_id?:string;reason?:string;at?:number
}

export function createCommitmentStore(ports:{redis:CommitmentRedisLike;logger:{warn(message:string):void};diagnostics?:Pick<AgentDiagnostics,'emit'>}) {
  const {redis,logger}=ports
  async function withLock<T>(operation:(token:string)=>Promise<T>,ensureCurrent?:()=>Promise<void>):Promise<T> {
    const token=randomUUID(),end=Date.now()+LOCK_ACQUIRE_TIMEOUT
    for (;;) {
      await ensureCurrent?.()
      const result=await redis.set(COMMITMENT_LOCK_KEY,token,{PX:LOCK_TIMEOUT,NX:true})
      if(result==='OK'||result===true)break
      await ensureCurrent?.()
      if(Date.now()>=end)throw new Error('获取承诺锁超时')
      await new Promise(resolve=>setTimeout(resolve,25))
    }
    try{await ensureCurrent?.();return await operation(token)}finally{
      await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[COMMITMENT_LOCK_KEY],arguments:[token]})
    }
  }
  async function getPendingList(ensureCurrent?:()=>Promise<void>):Promise<PendingEntry[]> {
    await ensureCurrent?.()
    const raw=await redis.get(COMMITMENT_PENDING_KEY)
    await ensureCurrent?.()
    return decodeCommitmentPendingList(raw)
  }
  async function snapshot(id:string,ensureCurrent?:()=>Promise<void>){
    await ensureCurrent?.()
    const result=await redis.eval(READ_STATE,{keys:[commitmentDetailKey(id),COMMITMENT_CLEANUP_KEY,cleanupIdKey(id)],arguments:[]})
    await ensureCurrent?.()
    if(!Array.isArray(result)||result.length!==3||result.some(value=>value!==null&&typeof value!=='string'))throw new Error('承诺清理屏障不可用')
    return {raw:result[0] as string|null,fenceRaw:result[1] as string|null,retired:result[2]!==null,fences:parseConversationCleanup(result[1] as string|null)}
  }
  const sourceAt=(c:CommitmentData)=>c.deferredAction?.grant.source.at??c.sourceAt??c.created_at
  const permitted=(c:CommitmentData,fences:ReturnType<typeof parseConversationCleanup>)=>!c.scope||(
    conversationCleanupAllows(c.scope,{authorId:c.creator_id,at:sourceAt(c)},fences)&&
    (!c.ownedReservation||conversationCleanupAllows(c.scope,c.ownedReservation.source,fences)))
  function sameSource(left:CommitmentData,right:CommitmentData):boolean{
    return left.creator_id===right.creator_id&&left.created_at===right.created_at&&sourceAt(left)===sourceAt(right)&&left.bot_id===right.bot_id&&
      (left.scope?agentConversationKey(left.scope):'')===(right.scope?agentConversationKey(right.scope):'')&&left.bindingIdentity===right.bindingIdentity
  }
  async function getCommitment(id:string,ensureCurrent?:()=>Promise<void>):Promise<CommitmentData|null>{
    const saved=await snapshot(id,ensureCurrent)
    if(!saved.raw||saved.retired)return null
    // A corrupt record must not become an apparently missing task that gets overwritten.
    const c=decodeCommitment(saved.raw)
    return permitted(c,saved.fences)?c:null
  }
  async function persist(c:CommitmentData,token:string,isCurrent?:()=>boolean,ensureCurrent?:()=>Promise<void>):Promise<boolean>{
    for(let attempt=0;attempt<16;attempt++){
      const snapshotValue=await snapshot(c.id,ensureCurrent)
      if(snapshotValue.retired||!permitted(c,snapshotValue.fences))return false
      if(snapshotValue.raw&&!sameSource(decodeCommitment(snapshotValue.raw),c))throw new Error('承诺来源不可改变')
      const list=(await getPendingList(ensureCurrent)).filter(item=>item.id!==c.id)
      if(c.status==='active')list.push({id:c.id,next_run_at:c.run_id?c.lease_until||0:c.next_run_at})
      list.sort((a,b)=>a.next_run_at-b.next_run_at)
      const data=encodeCommitment(c)
      decodeCommitment(data)
      await ensureCurrent?.()
      if(isCurrent?.()===false)return false
      const saved=await redis.eval(WRITE_STATE,{keys:[COMMITMENT_LOCK_KEY,commitmentDetailKey(c.id),COMMITMENT_PENDING_KEY,COMMITMENT_CLEANUP_KEY,cleanupIdKey(c.id)],
        arguments:[token,data,JSON.stringify(list),c.status==='active'||c.deferredAction?'0':'86400',...cleanupExpected(snapshotValue.fenceRaw),...cleanupExpected(snapshotValue.raw)]})
      if(Number(saved)===1)return true
      if(Number(saved)===-1)return false
      await ensureCurrent?.()
      if(await redis.get(COMMITMENT_LOCK_KEY)!==token)throw new Error('承诺锁已失效，拒绝旧执行写入')
    }
    throw new Error('承诺清理屏障正在更新')
  }
  const withoutRun=(c:CommitmentData):CommitmentData=>{
    const {run_id:_run,lease_until:_lease,execution_state:_state,...rest}=c
    return rest
  }
  async function listActiveCommitments(ensureCurrent?:()=>Promise<void>):Promise<CommitmentData[]>{
    const out:CommitmentData[]=[]
    for(const item of await getPendingList(ensureCurrent)){
      const c=await getCommitment(item.id,ensureCurrent)
      if(c?.status==='active')out.push(c)
    }
    return out
  }
  async function createCommitment(c:CommitmentData,validate?:(active:CommitmentData[])=>void|Promise<void>,isCurrent?:()=>boolean,ensureCurrent?:()=>Promise<void>){
    await withLock(async token=>{
      if(await getCommitment(c.id,ensureCurrent))throw new Error('承诺 id 已存在')
      await validate?.(await listActiveCommitments(ensureCurrent))
      await ensureCurrent?.()
      if(!await persist({...c,revision:1},token,isCurrent,ensureCurrent))throw new Error('角色绑定已改变，承诺未创建')
    },ensureCurrent)
  }
  async function cancelCommitment(id:string,isCurrent?:()=>boolean,ensureCurrent?:()=>Promise<void>,validate?:(current:CommitmentData)=>void|Promise<void>):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(id,ensureCurrent)
      if(!current)return false
      await validate?.(current)
      await ensureCurrent?.()
      if(current.status!=='active'&&!(current.status==='unknown'&&current.deferredAction))return false
      const saved=await persist({...withoutRun(current),status:'cancelled',next_run_at:0,revision:(current.revision||0)+1,last_result:'已取消；在途动作不能撤回，后续不再执行'},token,isCurrent,ensureCurrent)
      if(saved)for(const listener of invalidationListeners.get(redis)?.get(id)||[])listener()
      await ensureCurrent?.()
      return saved
    },ensureCurrent)
  }
  async function updateActive(id:string,change:(current:CommitmentData)=>CommitmentData|null|Promise<CommitmentData|null>,isCurrent?:()=>boolean,ensureCurrent?:()=>Promise<void>):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(id,ensureCurrent)
      if(!current||current.status!=='active')return false
      const next=await change(current)
      await ensureCurrent?.()
      if(!next)return false
      return await persist({...next,revision:(current.revision||0)+1},token,isCurrent,ensureCurrent)
    },ensureCurrent)
  }
  async function takeDueCommitments(at:number,canClaim?:(c:CommitmentData)=>boolean,limit=Infinity):Promise<CommitmentData[]>{
    if(!(await getPendingList()).some(item=>item.next_run_at<=at))return []
    return withLock(async token=>{
      const out:CommitmentData[]=[]
      for(const item of await getPendingList()){
        if(item.next_run_at>at)continue
        const c=await getCommitment(item.id)
        if(!c||c.status!=='active'||canClaim?.(c)===false)continue
        if(c.run_id&&(c.lease_until||0)>at)continue
        if(c.run_id&&c.execution_state==='executing'){
          const reason='上次执行中断且结果未知，已停止自动重发'
          await persist({...withoutRun(c),status:'unknown',last_result:reason,next_run_at:0,revision:(c.revision||0)+1,
            ...(c.deferredAction?.state==='executing'?{deferredAction:{...c.deferredAction,state:'unknown',settledAt:at,resultCode:'interrupted'}}:{})},token)
          await appendFailLogUnlocked({id:c.id,intent:c.intent,group_id:c.group_id,reason,at},token)
          continue
        }
        const claimed:CommitmentData={...c,run_id:randomUUID(),lease_until:at+COMMITMENT_LEASE_MS,execution_state:'claimed',revision:(c.revision||0)+1}
        if(await persist(claimed,token))out.push(claimed)
        if(out.length>=limit)break
      }
      return out
    })
  }
  async function refreshClaim(c:CommitmentData,at:number,begin=false,isCurrent?:()=>boolean):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id||(current.lease_until||0)<=at)return false
      return await persist({...current,lease_until:at+COMMITMENT_LEASE_MS,...(begin?{execution_state:'executing' as const,
        ...(current.ownedReservation?{ownedReservation:{...current.ownedReservation,attemptedAt:at}}:{})}:{})},token,isCurrent)
    })
  }
  async function expireClaim(c:CommitmentData,at:number):Promise<'expired'|'current'|'cancelled'>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id)return 'cancelled'
      if(current.expiry_at<=0||at<current.expiry_at)return 'current'
      await persist({...withoutRun(current),status:'expired',next_run_at:0,last_result:'已到期',revision:(current.revision||0)+1},token)
      return 'expired'
    })
  }
  async function releaseUnstartedClaim(c:CommitmentData):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id||current.execution_state!=='claimed')return false
      return await persist({...withoutRun(current),revision:(current.revision||0)+1},token)
    })
  }
  async function commitRunOutcome(c:CommitmentData):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id)return false
      // Preserve concurrent renewal fields. Only the owner of this run may settle it.
      return await persist({...withoutRun(c),...(current.deferredAction?{deferredAction:current.deferredAction}:{}),
        ...(current.ownedReservation?{ownedReservation:current.ownedReservation}:{}),
        expiry_at:current.expiry_at,renewal_asked_at:current.renewal_asked_at||0,revision:(current.revision||0)+1},token)
    })
  }
  async function confirmOwnedReservation(c:CommitmentData,messageId:string,isCurrent:()=>boolean):Promise<CommitmentData|undefined>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current?.ownedReservation||current.status!=='unknown'||current.revision!==c.revision||!isCurrent())return undefined
      const verified:CommitmentData={...current,status:'completed',last_result:'sent',revision:(current.revision||0)+1,
        ownedReservation:{...current.ownedReservation,verifiedMessageId:messageId}}
      return await persist(verified,token,isCurrent)?verified:undefined
    })
  }
  /** A cancellation fence shared by local workers using this same storage port. */
  function onInvalidated(id:string,listener:()=>void):()=>void {
    let records=invalidationListeners.get(redis)
    if(!records){records=new Map();invalidationListeners.set(redis,records)}
    let listeners=records.get(id)
    if(!listeners){listeners=new Set();records.set(id,listeners)}
    listeners.add(listener)
    return ()=>{listeners!.delete(listener);if(!listeners!.size)records!.delete(id)}
  }
  async function isClaimCurrent(c:CommitmentData,at:number):Promise<boolean>{
    const current=await getCommitment(c.id)
    return current?.status==='active'&&!!c.run_id&&current.run_id===c.run_id&&(current.lease_until||0)>at
  }
  /** Persist the one-shot marker before dispatch, and preserve it through reminder retries. */
  async function updateDeferredActionClaim(c:CommitmentData,expected:AgentDeferredActionData['state'],next:AgentDeferredActionData,at:number,isCurrent?:()=>boolean):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id||(current.lease_until||0)<=at||
        !current.deferredAction||current.deferredAction.state!==expected||current.deferredAction.grant.id!==next.grant.id||current.deferredAction.grant.actionHash!==next.grant.actionHash)return false
      const valid=expected==='pending'?next.state==='executing':expected==='executing'&&['succeeded','failed','unknown'].includes(next.state)
      if(!valid)throw new Error('延期动作状态不能回退或重放')
      const decoded=decodeAgentDeferredAction(next)
      if(next.state==='unknown')return await persist({...withoutRun(current),deferredAction:decoded,status:'unknown',next_run_at:0,last_run_at:at,last_result:decoded.resultCode,revision:(current.revision||0)+1},token,isCurrent)
      return await persist({...current,deferredAction:decoded,execution_state:next.state==='executing'?'executing':'claimed'},token,isCurrent)
    })
  }
  /** Terminal deferred records remain available to inspect/cancel an unresolved delegation. */
  async function listDeferredActions(ensureCurrent?:()=>Promise<void>):Promise<CommitmentData[]>{
    if(!redis.scanIterator)throw new Error('延期提醒列表需要存储扫描端口')
    const out:CommitmentData[]=[]
    await ensureCurrent?.()
    const iterator=await redis.scanIterator({MATCH:commitmentDetailKey('*'),COUNT:100})
    await ensureCurrent?.()
    for await(const batch of iterator){
      await ensureCurrent?.()
      for(const key of Array.isArray(batch)?batch:[batch]){
        const c=await getCommitment(key.slice(commitmentDetailKey('').length),ensureCurrent)
        if(c?.deferredAction)out.push(c)
      }
    }
    return out.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id))
  }
  /** Read unresolved records without repairing indexes or recreating claims. */
  async function listManagementCommitments(ensureCurrent:()=>Promise<void>):Promise<CommitmentData[]>{
    if(!redis.scanIterator)throw new Error('承诺管理列表需要存储扫描端口')
    await ensureCurrent()
    const source=await redis.scanIterator({MATCH:commitmentDetailKey('*'),COUNT:100})
    await ensureCurrent()
    const iterator=source[Symbol.asyncIterator](),seen=new Set<string>(),out:CommitmentData[]=[]
    for(;;){
      await ensureCurrent()
      const batch=await iterator.next()
      await ensureCurrent()
      if(batch.done)break
      for(const key of Array.isArray(batch.value)?batch.value:[batch.value]){
        if(seen.has(key))continue
        seen.add(key)
        const id=key.slice(commitmentDetailKey('').length),c=await getCommitment(id,ensureCurrent)
        if(c&&c.id!==id)throw new Error('承诺详情身份不符')
        if(c&&(c.status==='active'||c.status==='unknown'))out.push(c)
      }
    }
    return out.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id))
  }
  async function requeueForRetry(c:CommitmentData,at:number):Promise<'retrying'|'failed'|'cancelled'>{
    const retry=c.retry_count+1,failed=retry>=3
    const saved=await commitRunOutcome({...c,retry_count:retry,status:failed?'failed':'active',next_run_at:failed?0:at+10000,last_result:c.last_result||'重试超限'})
    return !saved?'cancelled':failed?'failed':'retrying'
  }
  async function readFailLog():Promise<CommitmentFailure[]>{
    const raw=await redis.get(FAILLOG_KEY)
    if(!raw)return []
    try {
      const parsed:unknown=JSON.parse(raw)
      return Array.isArray(parsed)?parsed.filter(v=>v!==null&&typeof v==='object'):[]
    } catch (error) {
      reportAgentFailure(ports.diagnostics, { stage: 'runtime', operation: 'commitment_failure_log', code: 'commitment_failure_log_invalid', error },
        () => logger.warn('[承诺] 失败日志损坏，按空处理'))
      return []
    }
  }
  async function readManagementFailLog(ensureCurrent?:()=>Promise<void>):Promise<unknown[]>{
    return (await readFailureDocument(ensureCurrent)).entries
  }
  async function readFailureDocument(ensureCurrent?:()=>Promise<void>):Promise<{raw:string|null;entries:unknown[]}>{
    await ensureCurrent?.()
    const raw=await redis.get(FAILLOG_KEY)
    await ensureCurrent?.()
    const entries:unknown=raw===null?[]:JSON.parse(raw)
    if(!Array.isArray(entries))throw new Error('承诺失败日志损坏，停止修改')
    return {raw,entries}
  }
  async function appendFailLogUnlocked(entry:CommitmentFailure,token:string){
    for(let attempt=0;attempt<16;attempt++){
      const saved=entry.id?await snapshot(entry.id):{raw:null,fenceRaw:await redis.get(COMMITMENT_CLEANUP_KEY),retired:false,fences:parseConversationCleanup(null)}
      const task=saved.raw?decodeCommitment(saved.raw):null
      if(saved.retired||task&&!permitted(task,saved.fences))return
      const {id,intent,group_id,reason,at}=entry
      const proven=task?.scope&&task.bindingIdentity&&task.id===id&&task.group_id===group_id&&(intent===undefined||task.intent===intent)
      const next={id,intent,group_id,reason,at,failureId:randomUUID(),
        ...(proven?{scopeKey:agentConversationKey(task.scope!),bindingIdentity:task.bindingIdentity,creator_id:task.creator_id,sourceAt:sourceAt(task)}:{})}
      const current=await readFailureDocument()
      const result=await redis.eval(WRITE_FAILURES,{keys:[COMMITMENT_LOCK_KEY,FAILLOG_KEY,COMMITMENT_CLEANUP_KEY,...(id?[cleanupIdKey(id)]:[])],
        arguments:[token,current.raw??'',JSON.stringify([next,...current.entries].slice(0,FAILLOG_LIMIT)),...cleanupExpected(saved.fenceRaw)]})
      if(Number(result)===1||Number(result)===-2)return
      if(Number(result)===-1)throw new Error('承诺锁已失效，失败日志未写入')
    }
    throw new Error('承诺失败日志正在更新')
  }
  async function appendFailLog(entry:CommitmentFailure){await withLock(token=>appendFailLogUnlocked(entry,token))}
  /** Delete only exact rows captured by an authorized request, preserving new rows. */
  async function clearManagementFailLog(selected:readonly unknown[],ensureCurrent:()=>Promise<void>):Promise<boolean>{
    if(!selected.length)return false
    const expected=selected.map(entry=>JSON.stringify(entry))
    return withLock(async token=>{
      for(let attempt=0;attempt<16;attempt++){
        const current=await readFailureDocument(ensureCurrent),counts=new Map<string,number>()
        for(const entry of expected)counts.set(entry,(counts.get(entry)||0)+1)
        const retained=current.entries.filter(entry=>{
          const key=JSON.stringify(entry),remaining=counts.get(key)||0
          if(!remaining)return true
          counts.set(key,remaining-1);return false
        })
        await ensureCurrent()
        if(retained.length===current.entries.length)return false
        const saved=await redis.eval(WRITE_FAILURES,{keys:[COMMITMENT_LOCK_KEY,FAILLOG_KEY],arguments:[token,current.raw??'',JSON.stringify(retained)]})
        await ensureCurrent()
        if(Number(saved)===1)return true
        if(Number(saved)===-1)throw new Error('承诺锁已失效，失败日志未清理')
      }
      throw new Error('承诺失败日志正在更新')
    },ensureCurrent)
  }
  async function clearFailLog(){await withLock(async()=>{await redis.del(FAILLOG_KEY)})}
  async function purgeSubject(input:AgentSourceMemoryPurgeSubject,guard:AgentSourceMemoryCleanupGuard){
    const cleanup=createSubjectMemoryCleanup(redis,COMMITMENT_CLEANUP_KEY,'commitments')
    return cleanup.purge(input,guard,async(selector,authorize,counts)=>{
      const selected=(c:CommitmentData)=>!permitted(c,{version:1,entries:[selector]})
      const selectedFailure=(value:unknown)=>{
        const row=record(value),scope=typeof row.scopeKey==='string'?decodeAgentConversationKey(row.scopeKey):null
        return !!scope&&typeof row.bindingIdentity==='string'&&typeof row.creator_id==='string'&&Number.isSafeInteger(row.sourceAt)&&Number(row.sourceAt)>=0&&
          !conversationCleanupAllows(scope,{authorId:row.creator_id,at:Number(row.sourceAt)},{version:1,entries:[selector]})
      }
      async function keys(){
        if(!redis.scanIterator)throw new Error('承诺历史分区目录不可用')
        await authorize()
        const seen=new Set<string>()
        for await(const batch of await redis.scanIterator({MATCH:commitmentDetailKey('*'),COUNT:100})){
          await authorize()
          for(const key of Array.isArray(batch)?batch:[batch])if(key.startsWith(commitmentDetailKey('')))seen.add(key)
          if(seen.size>100_000)throw new Error('承诺历史分区超过清理上限')
        }
        return [...seen]
      }
      for(const key of await keys()){
        const id=key.slice(commitmentDetailKey('').length)
        await withLock(async token=>{
          for(let attempt=0;attempt<16;attempt++){
            const saved=await snapshot(id,authorize)
            if(!saved.raw)return
            const current=decodeCommitment(saved.raw)
            if(current.id!==id)throw new Error('承诺详情身份不符')
            if(!selected(current))return
            const pendingRaw=await redis.get(COMMITMENT_PENDING_KEY),pending=decodeCommitmentPendingList(pendingRaw).filter(item=>item.id!==id)
            const failures=await readFailureDocument(authorize),retained=failures.entries.filter(value=>record(value).id!==id&&!selectedFailure(value))
            await authorize()
            const result=await redis.eval(PURGE_STATE,{keys:[COMMITMENT_LOCK_KEY,key,COMMITMENT_PENDING_KEY,FAILLOG_KEY,COMMITMENT_CLEANUP_KEY,cleanupIdKey(id)],
              arguments:[token,...cleanupExpected(saved.raw),...cleanupExpected(pendingRaw),...cleanupExpected(failures.raw),...cleanupExpected(saved.fenceRaw),JSON.stringify(pending),failures.raw===null?'0':'1',JSON.stringify(retained)]})
            if(Number(result)===-1)throw new Error('承诺锁已失效，来源未清理')
            if(Number(result)!==1)continue
            counts.removedRecords+=1+failures.entries.length-retained.length;counts.removedPartitions++
            for(const listener of invalidationListeners.get(redis)?.get(id)||[])listener()
            await authorize()
            return
          }
          throw new Error('承诺来源清理冲突')
        },authorize)
      }
      // A completed task's detail can expire before its provenance-bearing failure row.
      await withLock(async token=>{
        for(let attempt=0;attempt<16;attempt++){
          const failures=await readFailureDocument(authorize),retained=failures.entries.filter(value=>!selectedFailure(value))
          if(retained.length===failures.entries.length)return
          const fenceRaw=await redis.get(COMMITMENT_CLEANUP_KEY)
          await authorize()
          const result=await redis.eval(WRITE_FAILURES,{keys:[COMMITMENT_LOCK_KEY,FAILLOG_KEY,COMMITMENT_CLEANUP_KEY],
            arguments:[token,failures.raw??'',JSON.stringify(retained),...cleanupExpected(fenceRaw)]})
          if(Number(result)===-1)throw new Error('承诺锁已失效，失败来源未清理')
          if(Number(result)!==1)continue
          counts.removedRecords+=failures.entries.length-retained.length
          await authorize();return
        }
        throw new Error('承诺失败来源清理冲突')
      },authorize)
      for(const key of await keys()){
        const saved=await snapshot(key.slice(commitmentDetailKey('').length),authorize)
        if(saved.raw&&selected(decodeCommitment(saved.raw)))throw new Error('承诺原始存储未清理')
      }
      const failures=await readFailureDocument(authorize)
      if(failures.entries.some(selectedFailure))throw new Error('承诺失败日志原始存储未清理')
    })
  }
  // One-time legacy repair: old versions could remove a due ID before executing it.
  async function recoverLegacyIndex(){
    if(!redis.scanIterator)return
    for await(const batch of await redis.scanIterator({MATCH:commitmentDetailKey('*'),COUNT:100})){
      for(const key of Array.isArray(batch)?batch:[batch]){
       const id=key.slice(commitmentDetailKey('').length)
       await withLock(async token=>{
        if((await getPendingList()).some(item=>item.id===id))return
        const c=await getCommitment(id)
        if(c?.status==='active'){
          // Its old side effect cannot be established: expose uncertainty rather than silently replay.
          await persist({...withoutRun(c),status:'unknown',next_run_at:0,last_result:'旧版本任务离开队列且执行结果未知，需核实后重新托付'},token)
          await appendFailLogUnlocked({id:c.id,intent:c.intent,group_id:c.group_id,reason:'旧版本任务执行结果未知，禁止自动重发',at:Date.now()},token)
        }
       })
      }
    }
  }
  return {createCommitment,getCommitment,cancelCommitment,takeDueCommitments,commitRunOutcome,confirmOwnedReservation,requeueForRetry,listActiveCommitments,appendFailLog,readFailLog,clearFailLog,updateActive,refreshClaim,releaseUnstartedClaim,expireClaim,recoverLegacyIndex,onInvalidated,isClaimCurrent,updateDeferredActionClaim,listDeferredActions,listManagementCommitments,readManagementFailLog,clearManagementFailLog,purgeSubject}
}
