// 承诺账本——群友托付给机器人的定时/循环事务("每天中午12点发三角洲今日密码")。
// 与 reminderTool 的分工:reminder 是一次性静态提醒;承诺存自然语言意图,到期唤醒
// agent 用工具面自主兑现(仿真群)或直发固定文案(任意群),daily 自动顺延。
import type {AgentBindingSnapshot,AgentBindingTurn,AgentConversationScope,ConversationAddress} from './agentBinding.js'
import type {MessageActionPort} from './platformMessage.js'
import type {AgentDeferredActionData} from './agentDeferredAction.js'
export interface CommitmentScheduleOnce { kind:'once'; time:number }
export interface CommitmentScheduleDaily { kind:'daily'; time:string }
export type CommitmentSchedule = CommitmentScheduleOnce | CommitmentScheduleDaily
export type CommitmentStatus = 'active'|'completed'|'failed'|'expired'|'cancelled'|'unknown'
export interface CommitmentData {
  id:string
  group_id:string
  creator_id:string
  creator_name:string
  intent:string                    // 用户原话(含时间语境),不预编译参数——30天后 API 变了 agent 仍能重新规划
  schedule:CommitmentSchedule
  deliver:'agent'|'static'         // agent=到点唤醒仿真 agent 用工具完成;static=直发固定文案
  static_message:string|null
  /** An existing one-time reminder transferred from the QQ reminder ledger. */
  importedReminder?:true
  /** Frozen extra_action delegation; executed by the dedicated worker, never by wakeSim. */
  deferredAction?:AgentDeferredActionData
  expiry_at:number                 // 到期不再执行(默认30天,防遗忘永动机)
  renewal_asked_at?:number         // 到期前问询续约的时间(0/缺省=未问过;只问一次,不追问)
  next_run_at:number
  status:CommitmentStatus
  last_run_at:number
  last_result:string
  retry_count:number
  created_at:number
  bot_id:string
  /** Captured ownership for new tasks. Records without scope use the legacy QQ route. */
  scope?:AgentConversationScope
  /** Stable identity of the creating binding across unrelated config saves. */
  bindingIdentity?:string
  revision?:number
  run_id?:string
  lease_until?:number
  execution_state?:'claimed'|'executing'
}
export interface CommitmentConfigSection { maxActivePerGroup?:number; maxPerCreator?:number; defaultExpiryDays?:number }
export interface CommitmentRedisLike {
  get(key:string):Promise<string|null>
  set(key:string,value:string,options?:{EX?:number;PX?:number;NX?:boolean}):Promise<unknown>
  del(key:string):Promise<unknown>
  eval(script:string,options:{keys:string[];arguments:string[]}):Promise<unknown>
  scanIterator?(options:{MATCH:string;COUNT:number}):AsyncIterable<string|string[]>|Promise<AsyncIterable<string|string[]>>
}
export interface CommitmentBotLike { uin?:string|number; sendApi?:(action:string,params:Record<string,unknown>)=>Promise<unknown> }
export interface CommitmentEvent extends AgentBindingTurn {
  group_id?:string|number|undefined
  user_id?:string|number|undefined
  isMaster?:boolean|undefined
  self_id?:string|number|undefined
  bot?:{uin?:string|number}|undefined
  sender?:{nickname?:string|undefined;card?:string|undefined}|undefined
}
export interface CommitmentRunOptions {
  taskId:string
  botId?:string
  isCurrent():Promise<boolean>
  beforeExecution?():Promise<boolean>
}
export interface CommitmentRunResult {
  /** Deferred work has not started execution and keeps its existing schedule. */
  status:'succeeded'|'failed'|'unknown'|'cancelled'|'deferred'
  sent:number
  actions?:number
  error?:string
}
export interface CommitmentPorts {
  redis:CommitmentRedisLike
  logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void}
  getBot(id?:string):CommitmentBotLike|null
  resolveBinding?(target:ConversationAddress):AgentBindingSnapshot | undefined
  /** Verified private recipient ID. Undefined while the adapter cannot verify it. */
  resolvePrivatePeer?(target:ConversationAddress):string | undefined
  handlesTarget?(target:ConversationAddress | undefined):boolean
  messageActions?:MessageActionPort
  isSimulationGroup(groupId:string,target?:ConversationAddress):Promise<boolean>|boolean
  /** A host with switchable simulation can keep valid agent tasks pending while the mode is inactive. */
  waitForSimulation?:boolean
  wakeSim(groupId:string,card:string,options:CommitmentRunOptions,target?:ConversationAddress):Promise<CommitmentRunResult>
  loadConfig():CommitmentConfigSection
  now?():number
}
