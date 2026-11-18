import {createHash} from 'node:crypto'
import type {AgentBindingSnapshot} from '../../../contracts/agentBinding.js'
import type {
  AgentDeferredActionGrant,AgentDeferredActionLegacySource,AgentDeferredExecutorKind,
} from '../../../contracts/agentDeferredAction.js'
import type {CommitmentData,CommitmentRedisLike} from '../../../contracts/commitments.js'
import {sanitizeFinalReplyText} from '../../conversation/domain/replySanitizer.js'
import {assertDeferredGrant,decodeAgentDeferredAction,freezeDeferredAction} from '../../commitments/infrastructure/agentDeferredActionData.js'
import {encodeCommitment} from '../../commitments/infrastructure/commitmentStore.js'
import {agentBindingIdentity,agentConversationKey,isConversationAddress} from '../domain/agentBindings.js'

export interface LegacyDeferredToolMapping {
  readonly from:string
  readonly to:string
  readonly definitionId:string
  readonly executor:AgentDeferredExecutorKind
}
export type LegacyDeferredReminderRetainedReason = 'invalid'|'unscoped'|'binding'|'conversation'|'unsupported'|'in-flight'|'authorization'
export interface LegacyDeferredReminderMigrationOptions {
  readonly raw:string
  readonly detailKey:string
  readonly pending?:{readonly id:string;readonly trigger_time:number}
  readonly sourceBinding:AgentBindingSnapshot
  readonly binding:AgentBindingSnapshot
  readonly destinationMode:'simulation'|'text'|'private'
  /** Explicit per-record mapping; the legacy name never authorizes an arbitrary current tool. */
  readonly mapping?:LegacyDeferredToolMapping
  /** Issued by the host's current delegation policy for this exact source hash and action. */
  readonly grant?:AgentDeferredActionGrant
  readonly now:number
  readonly freezeUncertain?:boolean
}
export type LegacyDeferredReminderConversion = {readonly kind:'retained';readonly reason:LegacyDeferredReminderRetainedReason} |
  {readonly kind:'moved';readonly task:CommitmentData;readonly pending:boolean}

function record(value:unknown):Record<string,unknown>|undefined {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined
}
function timestamp(value:unknown):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&Number.isFinite(new Date(value).getTime())
}
function identifier(value:unknown,max=4096):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)
}
function qqIdentifier(value:unknown):value is string {return typeof value==='string'&&/^[1-9][0-9]*$/u.test(value)}
function completeBinding(binding:AgentBindingSnapshot):boolean {
  return isConversationAddress(binding.target)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.agentId)&&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(binding.connectionId)&&identifier(binding.personaId,128)&&
    identifier(binding.id)&&identifier(binding.revision)
}
function retained(reason:LegacyDeferredReminderRetainedReason):LegacyDeferredReminderConversion {return {kind:'retained',reason}}

/**
 * Offline format conversion only. No current-user event, cached master permission, model,
 * tool discovery or MCP call is reconstructed from the old reminder. The caller must
 * explicitly obtain a revocable migration grant before invoking this converter.
 */
export function convertLegacyDeferredReminder(options:LegacyDeferredReminderMigrationOptions):LegacyDeferredReminderConversion {
  const {raw,binding,sourceBinding,pending,mapping,grant,now}=options
  let old:Record<string,unknown>|undefined
  try {if(raw.length>1_048_576)return retained('invalid');old=record(JSON.parse(raw))} catch {return retained('invalid')}
  if(!old||!timestamp(now)||!identifier(options.detailKey,1024)||!identifier(old.id,256)||!qqIdentifier(old.user_id)||
    typeof old.content!=='string'||!old.content.trim()||!timestamp(old.trigger_time)||!timestamp(old.created_at)||
    old.created_at>now||!Number.isSafeInteger(old.retry_count)||Number(old.retry_count)<0||
    (old.updated_at!==undefined&&(!timestamp(old.updated_at)||old.updated_at<old.created_at||old.updated_at>now))||
    (old.reminder_message!==undefined&&old.reminder_message!==null&&typeof old.reminder_message!=='string')||
    (old.extra_attempted!==undefined&&typeof old.extra_attempted!=='boolean')||
    (old.message_id!==undefined&&old.message_id!==null&&
      !(identifier(old.message_id,256)||(typeof old.message_id==='number'&&Number.isSafeInteger(old.message_id)&&old.message_id>0))))return retained('invalid')
  const originalStatus=old.status
  if(originalStatus!=='pending'&&originalStatus!=='sending'&&originalStatus!=='unknown'&&originalStatus!=='failed'&&
    originalStatus!=='completed'&&originalStatus!=='cancelled')return retained('invalid')
  if(!old.bot_id||!old.bindingIdentity||sourceBinding.source!=='configured'||binding.source!=='configured')return retained('unscoped')
  if(!completeBinding(sourceBinding)||!completeBinding(binding)||
    binding.target.account.platform!=='qq'||binding.target.account.namespace!=='global'||
    (binding.target.kind!=='group'&&binding.target.kind!=='private')||
    !qqIdentifier(binding.target.account.id)||!qqIdentifier(binding.target.id))return retained('binding')
  if(old.bot_id!==sourceBinding.target.account.id||old.bindingIdentity!==agentBindingIdentity(sourceBinding)||
    agentBindingIdentity(sourceBinding)!==agentBindingIdentity(binding)||
    agentConversationKey(sourceBinding)!==agentConversationKey(binding))return retained('binding')
  const groupId=binding.target.kind==='group'?binding.target.id:null
  if(old.group_id!==groupId||(groupId===null&&old.user_id!==binding.target.id))return retained('conversation')
  if(pending&&(pending.id!==old.id||pending.trigger_time!==old.trigger_time||!timestamp(pending.trigger_time)))return retained('invalid')
  const extra=record(old.extra_action)
  if(!extra||!identifier(extra.tool,128)||!mapping||mapping.from!==extra.tool)return retained('unsupported')
  if(extra.params!==undefined&&!record(extra.params))return retained('invalid')
  const params={...record(extra.params)}
  // This is the original reminder's documented default, fixed now rather than guessed at execution time.
  if(extra.tool==='pokeTool'&&!params.target)params.target=[old.user_id]
  let action
  try {action=freezeDeferredAction({tool:mapping.to,executor:mapping.executor,definitionId:mapping.definitionId,params})}
  catch {return retained('invalid')}
  const sourceHash=createHash('sha256').update(raw).digest('hex')
  if(!grant)return retained('authorization')
  const creator={platform:'qq',namespace:'global',id:old.user_id}
  try {
    assertDeferredGrant(grant,action,agentBindingIdentity(binding),creator,agentConversationKey(binding))
    if(grant.source.kind!=='migration'||grant.source.id!==old.id||grant.source.sourceHash!==sourceHash||
      !identifier(grant.source.authorizedBy,256)||!timestamp(grant.source.at)||grant.source.at>now||grant.dueAt!==old.trigger_time||
      !timestamp(grant.issuedAt)||grant.issuedAt>now||!timestamp(grant.expiresAt)||grant.expiresAt<=Math.max(now,old.trigger_time))return retained('authorization')
  }catch {return retained('authorization')}
  let uncertain=originalStatus==='sending'||originalStatus==='unknown'||old.extra_attempted===true||
    (originalStatus==='pending'&&!pending)
  if(old.delivery!==undefined&&old.delivery!==null){
    const delivery=record(old.delivery)
    if(!delivery||(delivery.state!=='sent'&&delivery.state!=='failed'&&delivery.state!=='unknown'))return retained('invalid')
    if(delivery.state==='sent'&&!identifier(delivery.messageId))return retained('invalid')
    if(delivery.state!=='failed'&&originalStatus==='pending')uncertain=true
  }
  const terminal=originalStatus==='completed'||originalStatus==='failed'||originalStatus==='cancelled'
  if(uncertain&&!terminal&&options.freezeUncertain!==true)return retained('in-flight')
  const active=!uncertain&&!terminal
  if(active&&(binding.target.kind!=='group'||options.destinationMode!=='simulation'))return retained('unsupported')
  if(active&&Number(old.retry_count)>=3)return retained('invalid')
  const text=typeof old.reminder_message==='string'&&old.reminder_message?old.reminder_message:`提醒你：${old.content}`
  if(!sanitizeFinalReplyText(text))return retained('unsupported')
  const legacy:AgentDeferredActionLegacySource={kind:'legacy-qq-reminder',detailKey:options.detailKey,rawSha256:sourceHash,
    originalStatus,originalCreatedAt:old.created_at,originalUpdatedAt:timestamp(old.updated_at)?old.updated_at:old.created_at,
    originalTriggerTime:old.trigger_time,originalMessageId:typeof old.message_id==='string'||typeof old.message_id==='number'?old.message_id:null,
    originalExtraAttempted:old.extra_attempted===true,
    explicitToolMapping:{from:mapping.from,to:mapping.to,definitionId:mapping.definitionId,executor:mapping.executor}}
  const resultCode=active?'':terminal?`legacy_${originalStatus}`:'legacy_result_unknown'
  return {kind:'moved',pending:active,task:{
    id:old.id,group_id:groupId??'',creator_id:old.user_id,creator_name:old.user_id,intent:old.content,
    schedule:{kind:'once',time:old.trigger_time},deliver:'static',static_message:text,importedReminder:true,
    expiry_at:0,next_run_at:active?old.trigger_time:0,status:active?'active':terminal?originalStatus:'unknown',
    last_run_at:0,last_result:resultCode,retry_count:Number(old.retry_count),created_at:old.created_at,
    bot_id:binding.target.account.id,scope:binding,bindingIdentity:agentBindingIdentity(binding),revision:1,
    deferredAction:decodeAgentDeferredAction({version:1,action,grant,state:active?'pending':uncertain||originalStatus==='completed'?'unknown':'pending',
      // The old ledger does not contain an actual extra-action attempt timestamp or outcome.
      attemptedAt:0,settledAt:active||(!uncertain&&originalStatus!=='completed')?0:now,resultCode,legacy}),
  }}
}

export interface LegacyDeferredReminderTransferCheck {readonly key:string;readonly value:string|null;readonly write?:string|null}
export interface LegacyDeferredReminderSelection {
  readonly id:string
  readonly mapping?:LegacyDeferredToolMapping
  readonly grant?:AgentDeferredActionGrant
  readonly freezeUncertain?:boolean
}
export interface LegacyDeferredReminderStageOptions {
  read(key:string):Promise<string|null>
  readonly sourceIndexKey:string
  readonly destinationIndexKey:string
  sourceDetailKey(id:string):string
  destinationDetailKey(id:string):string
  readonly sourceBinding:AgentBindingSnapshot
  readonly binding:AgentBindingSnapshot
  readonly destinationMode:'simulation'|'text'|'private'
  readonly selections:readonly LegacyDeferredReminderSelection[]
  /** Source reminder lock, destination commitment lock and stopped-host lease keys. */
  readonly idleKeys:readonly string[]
  readonly now:number
  isCurrent():boolean
}
const transferChanged='迁移期间账本或配置有变更，延期提醒未写入'

/** Creates reviewable CAS writes. Source writers and the destination host must already be stopped. */
export async function stageLegacyDeferredReminders(options:LegacyDeferredReminderStageOptions) {
  if(!options.isCurrent())throw new Error(transferChanged)
  const checks=new Map<string,LegacyDeferredReminderTransferCheck>()
  function uniqueKey(key:string){if(!identifier(key)||checks.has(key))throw new Error('延期提醒迁移键重复或无效')}
  async function snapshot(key:string){uniqueKey(key);const value=await options.read(key);checks.set(key,{key,value});return value}
  if(!options.idleKeys.length||options.idleKeys.length>32)throw new Error('延期提醒迁移缺少停机账本检查')
  for(const key of options.idleKeys)if(await snapshot(key)!==null)throw new Error('延期提醒迁移要求停止宿主并等待账本解锁')
  const sourceRaw=await snapshot(options.sourceIndexKey),destinationRaw=await snapshot(options.destinationIndexKey)
  let source: {id:string;trigger_time:number}[]
  let destination:{id:string;next_run_at:number}[]
  try {
    const parsed:unknown=sourceRaw===null?[]:JSON.parse(sourceRaw)
    if(!Array.isArray(parsed))throw new Error('source index')
    source=parsed.map(value=>{
      const item=record(value)
      if(!item||!identifier(item.id)||!timestamp(item.trigger_time))throw new Error('source entry')
      return {...item,id:item.id,trigger_time:item.trigger_time}
    })
    const destinationParsed:unknown=destinationRaw===null?[]:JSON.parse(destinationRaw)
    if(!Array.isArray(destinationParsed))throw new Error('destination index')
    destination=destinationParsed.map(value=>{
      const item=record(value)
      if(!item||!identifier(item.id)||!timestamp(item.next_run_at))throw new Error('destination entry')
      return {...item,id:item.id,next_run_at:item.next_run_at}
    })
  }catch{throw new Error('延期提醒迁移索引损坏')}
  if(new Set(source.map(item=>item.id)).size!==source.length||new Set(destination.map(item=>item.id)).size!==destination.length)throw new Error('延期提醒迁移索引重复')
  if(options.selections.length>1000||new Set(options.selections.map(item=>item.id)).size!==options.selections.length)throw new Error('延期提醒迁移选择重复或过多')
  const report={moved:0,active:0,frozen:0,terminal:0,retained:0,reasons:{} as Partial<Record<LegacyDeferredReminderRetainedReason,number>>}
  const removed=new Set<string>(),destinationIds=new Set(destination.map(item=>item.id))
  for(const selection of options.selections){
    if(!identifier(selection.id))throw new Error('延期提醒迁移编号无效')
    const detailKey=options.sourceDetailKey(selection.id),raw=await snapshot(detailKey)
    const pending=source.find(item=>item.id===selection.id)
    const result=raw===null?retained('invalid'):convertLegacyDeferredReminder({raw,detailKey,
      ...(pending?{pending}:{}),sourceBinding:options.sourceBinding,binding:options.binding,destinationMode:options.destinationMode,
      ...(selection.mapping?{mapping:selection.mapping}:{}),...(selection.grant?{grant:selection.grant}:{}),
      now:options.now,...(selection.freezeUncertain!==undefined?{freezeUncertain:selection.freezeUncertain}:{})})
    if(result.kind==='retained'){
      report.retained++;report.reasons[result.reason]=(report.reasons[result.reason]??0)+1;continue
    }
    if(result.task.id!==selection.id)throw new Error('延期提醒迁移编号与详情不一致')
    const destinationKey=options.destinationDetailKey(selection.id)
    if(await snapshot(destinationKey)!==null||destinationIds.has(selection.id))throw new Error('目标已有相同延期提醒编号，迁移未覆盖')
    checks.set(destinationKey,{key:destinationKey,value:null,write:encodeCommitment(result.task)})
    checks.set(detailKey,{key:detailKey,value:raw,write:null})
    removed.add(selection.id);destinationIds.add(selection.id);report.moved++
    if(result.pending){destination.push({id:selection.id,next_run_at:result.task.next_run_at});report.active++}
    else if(result.task.status==='unknown')report.frozen++
    else report.terminal++
  }
  if(removed.size){
    checks.set(options.sourceIndexKey,{key:options.sourceIndexKey,value:sourceRaw,write:JSON.stringify(source.filter(item=>!removed.has(item.id)))})
    if(report.active){destination.sort((a,b)=>a.next_run_at-b.next_run_at);checks.set(options.destinationIndexKey,{key:options.destinationIndexKey,value:destinationRaw,write:JSON.stringify(destination)})}
  }
  if(!options.isCurrent())throw new Error(transferChanged)
  return {report,checks:[...checks.values()]}
}

const compareTransfer=`-- agent-deferred-reminder-transfer-v1
if redis.acl_check_cmd then
  for i, key in ipairs(KEYS) do
    local j = (i - 1) * 4
    if ARGV[j+3] == 'delete' and not redis.acl_check_cmd('DEL', key) then return -1 end
    if ARGV[j+3] == 'set' and not redis.acl_check_cmd('SET', key, ARGV[j+4]) then return -1 end
  end
end
for i, key in ipairs(KEYS) do
  local j = (i - 1) * 4
  if ARGV[j+1] == 'missing' then
    if redis.call('EXISTS', key) ~= 0 then return 0 end
  elseif redis.call('GET', key) ~= ARGV[j+2] then return 0 end
end
for i, key in ipairs(KEYS) do
  local j = (i - 1) * 4
  if ARGV[j+3] == 'delete' then redis.call('DEL', key)
  elseif ARGV[j+3] == 'set' then redis.call('SET', key, ARGV[j+4]) end
end
return 1`

/** Local/offline application; the coordinator may instead merge these checks into its existing CAS. */
export async function applyLegacyDeferredReminderTransfer(options:{
  readonly redis:Pick<CommitmentRedisLike,'eval'>
  readonly checks:readonly LegacyDeferredReminderTransferCheck[]
  isCurrent():boolean
}):Promise<void> {
  if(!options.isCurrent())throw new Error(transferChanged)
  if(new Set(options.checks.map(item=>item.key)).size!==options.checks.length)throw new Error('延期提醒迁移键重复')
  if(!options.checks.some(check=>check.write!==undefined))return
  const result=Number(await options.redis.eval(compareTransfer,{keys:options.checks.map(check=>check.key),
    arguments:options.checks.flatMap(({value,write})=>[value===null?'missing':'value',value??'',write===undefined?'keep':write===null?'delete':'set',write??''])}))
  if(result===-1)throw new Error('Redis 账号缺少延期提醒迁移所需的写入权限')
  if(result!==1)throw new Error(transferChanged)
}
