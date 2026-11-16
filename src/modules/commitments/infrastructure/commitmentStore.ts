// 承诺账本 redis 存储:pending:list(按 next_run_at 排序)+ detail:{id},锁模式对齐 ReminderTool。
import {randomUUID} from 'node:crypto'
import type {CommitmentData,CommitmentRedisLike} from '../../../contracts/commitments.js'
import {agentConversationKey,decodeAgentConversationKey} from '../../runtime/domain/agentBindings.js'

const REDIS_KEY_PREFIX='bl-chat:commitment:'
export const COMMITMENT_PENDING_KEY=`${REDIS_KEY_PREFIX}pending:list`
const FAILLOG_KEY=`${REDIS_KEY_PREFIX}faillog`
const FAILLOG_LIMIT=20
export const COMMITMENT_LOCK_KEY=`${REDIS_KEY_PREFIX}lock`
const LOCK_TIMEOUT=15000
const LOCK_ACQUIRE_TIMEOUT=1500

interface PendingEntry{id:string;next_run_at:number}

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
  const scopeMatches=scope?.target.account.id===r.bot_id && (scope?.target.kind==='group' ? scope.target.id===r.group_id :
    importedReminder&&scope?.target.kind==='private'&&scope.target.id===r.creator_id&&r.group_id==='')
  if((r.scopeKey!==undefined&&(!scope||!scopeMatches))||
    (bindingIdentity!==undefined&&(typeof bindingIdentity!=='string'||!bindingIdentity||bindingIdentity.length>8192))||
    (scope&&!bindingIdentity)||
    (importedReminder&&(!scope||deliver!=='static'||normalizedSchedule.kind!=='once'||typeof r.static_message!=='string'||!r.static_message.trim()))) {
    throw new Error('承诺会话分区损坏')
  }
  return {
    id:r.id,group_id:r.group_id,creator_id:r.creator_id,creator_name:String(r.creator_name||''),
    intent:r.intent,schedule:normalizedSchedule,deliver,
    static_message:typeof r.static_message==='string'?r.static_message:null,
    ...(importedReminder?{importedReminder:true as const}:{}),
    expiry_at:Number(r.expiry_at)||0,renewal_asked_at:Number(r.renewal_asked_at)||0,
    next_run_at:Number(r.next_run_at)||0,status:status as CommitmentData['status'],
    last_run_at:Number(r.last_run_at)||0,last_result:String(r.last_result||''),retry_count:Number(r.retry_count)||0,
    created_at:Number(r.created_at)||0,bot_id:String(r.bot_id||''),revision:Number(r.revision)||0,
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
redis.call("SET", KEYS[2], ARGV[2])
if tonumber(ARGV[4]) > 0 then redis.call("EXPIRE", KEYS[2], ARGV[4]) end
redis.call("SET", KEYS[3], ARGV[3])
return 1`

export function createCommitmentStore(ports:{redis:CommitmentRedisLike;logger:{warn(message:string):void}}) {
  const {redis,logger}=ports
  async function withLock<T>(operation:(token:string)=>Promise<T>):Promise<T> {
    const token=randomUUID(),end=Date.now()+LOCK_ACQUIRE_TIMEOUT
    for (;;) {
      const result=await redis.set(COMMITMENT_LOCK_KEY,token,{PX:LOCK_TIMEOUT,NX:true})
      if(result==='OK'||result===true)break
      if(Date.now()>=end)throw new Error('获取承诺锁超时')
      await new Promise(resolve=>setTimeout(resolve,25))
    }
    try{return await operation(token)}finally{
      await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[COMMITMENT_LOCK_KEY],arguments:[token]})
    }
  }
  async function getPendingList():Promise<PendingEntry[]> {
    return decodeCommitmentPendingList(await redis.get(COMMITMENT_PENDING_KEY))
  }
  async function getCommitment(id:string):Promise<CommitmentData|null>{
    const data=await redis.get(commitmentDetailKey(id))
    if(!data)return null
    // A corrupt record must not become an apparently missing task that gets overwritten.
    return decodeCommitment(data)
  }
  async function persist(c:CommitmentData,token:string,isCurrent?:()=>boolean):Promise<boolean>{
    const list=(await getPendingList()).filter(item=>item.id!==c.id)
    if(c.status==='active')list.push({id:c.id,next_run_at:c.run_id?c.lease_until||0:c.next_run_at})
    list.sort((a,b)=>a.next_run_at-b.next_run_at)
    const data=encodeCommitment(c)
    if(isCurrent?.()===false)return false
    const saved=await redis.eval(WRITE_STATE,{keys:[COMMITMENT_LOCK_KEY,commitmentDetailKey(c.id),COMMITMENT_PENDING_KEY],arguments:[token,data,JSON.stringify(list),c.status==='active'?'0':'86400']})
    if(Number(saved)!==1)throw new Error('承诺锁已失效，拒绝旧执行写入')
    return true
  }
  const withoutRun=(c:CommitmentData):CommitmentData=>{
    const {run_id:_run,lease_until:_lease,execution_state:_state,...rest}=c
    return rest
  }
  async function listActiveCommitments():Promise<CommitmentData[]>{
    const out:CommitmentData[]=[]
    for(const item of await getPendingList()){
      const c=await getCommitment(item.id)
      if(c?.status==='active')out.push(c)
    }
    return out
  }
  async function createCommitment(c:CommitmentData,validate?:(active:CommitmentData[])=>void,isCurrent?:()=>boolean){
    await withLock(async token=>{
      if(await getCommitment(c.id))throw new Error('承诺 id 已存在')
      validate?.(await listActiveCommitments())
      if(!await persist({...c,revision:1},token,isCurrent))throw new Error('角色绑定已改变，承诺未创建')
    })
  }
  async function cancelCommitment(id:string,isCurrent?:()=>boolean):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(id)
      if(!current||current.status!=='active')return false
      return await persist({...withoutRun(current),status:'cancelled',next_run_at:0,revision:(current.revision||0)+1,last_result:'已取消；在途动作不能撤回，后续不再执行'},token,isCurrent)
    })
  }
  async function updateActive(id:string,change:(current:CommitmentData)=>CommitmentData|null,isCurrent?:()=>boolean):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(id)
      if(!current||current.status!=='active')return false
      const next=change(current)
      if(!next)return false
      return await persist({...next,revision:(current.revision||0)+1},token,isCurrent)
    })
  }
  async function takeDueCommitments(at:number,canClaim?:(c:CommitmentData)=>boolean):Promise<CommitmentData[]>{
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
          await persist({...withoutRun(c),status:'unknown',last_result:reason,next_run_at:0,revision:(c.revision||0)+1},token)
          await appendFailLogUnlocked({id:c.id,intent:c.intent,group_id:c.group_id,reason,at})
          continue
        }
        const claimed:CommitmentData={...c,run_id:randomUUID(),lease_until:at+COMMITMENT_LEASE_MS,execution_state:'claimed',revision:(c.revision||0)+1}
        await persist(claimed,token)
        out.push(claimed)
      }
      return out
    })
  }
  async function refreshClaim(c:CommitmentData,at:number,begin=false,isCurrent?:()=>boolean):Promise<boolean>{
    return withLock(async token=>{
      const current=await getCommitment(c.id)
      if(!current||current.status!=='active'||!c.run_id||current.run_id!==c.run_id||(current.lease_until||0)<=at)return false
      return await persist({...current,lease_until:at+COMMITMENT_LEASE_MS,...(begin?{execution_state:'executing' as const}:{})},token,isCurrent)
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
      await persist({...withoutRun(c),expiry_at:current.expiry_at,renewal_asked_at:current.renewal_asked_at||0,revision:(current.revision||0)+1},token)
      return true
    })
  }
  async function requeueForRetry(c:CommitmentData,at:number):Promise<'retrying'|'failed'|'cancelled'>{
    const retry=c.retry_count+1,failed=retry>=3
    const saved=await commitRunOutcome({...c,retry_count:retry,status:failed?'failed':'active',next_run_at:failed?0:at+10000,last_result:c.last_result||'重试超限'})
    return !saved?'cancelled':failed?'failed':'retrying'
  }
  type Failure={id?:string;intent?:string;group_id?:string;reason?:string;at?:number}
  async function readFailLog():Promise<Failure[]>{
    const raw=await redis.get(FAILLOG_KEY)
    if(!raw)return []
    try{const parsed:unknown=JSON.parse(raw);return Array.isArray(parsed)?parsed.filter(v=>v!==null&&typeof v==='object'):[]}catch{logger.warn('[承诺] 失败日志损坏，按空处理');return []}
  }
  async function appendFailLogUnlocked(entry:Failure){await redis.set(FAILLOG_KEY,JSON.stringify([entry,...await readFailLog()].slice(0,FAILLOG_LIMIT)))}
  async function appendFailLog(entry:Failure){await withLock(()=>appendFailLogUnlocked(entry))}
  async function clearFailLog(){await withLock(async()=>{await redis.del(FAILLOG_KEY)})}
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
          await appendFailLogUnlocked({id:c.id,intent:c.intent,group_id:c.group_id,reason:'旧版本任务执行结果未知，禁止自动重发',at:Date.now()})
        }
       })
      }
    }
  }
  return {createCommitment,getCommitment,cancelCommitment,takeDueCommitments,commitRunOutcome,requeueForRetry,listActiveCommitments,appendFailLog,readFailLog,clearFailLog,updateActive,refreshClaim,releaseUnstartedClaim,expireClaim,recoverLegacyIndex}
}
