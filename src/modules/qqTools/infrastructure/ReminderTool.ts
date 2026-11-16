import {randomUUID} from 'node:crypto'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'
import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
import type {ReminderPorts,ReminderData,ReminderEvent,ReminderPending,ReminderTools,ReminderAction} from '../../../contracts/reminder.js'
import type {ActionFactsEvent,ActionFactsQuery,TurnActionFacts,TurnTaskFact} from '../../../contracts/turnActionFacts.js'
import {actionFactScope,matchesActionFactScope,unknownTurnActionFacts} from '../../conversation/domain/turnActionFacts.js'
import {isAgentBindingCurrent} from '../../../contracts/agentBinding.js'
import {agentBindingIdentity} from '../../runtime/domain/agentBindings.js'
import {withDeliveryGuard} from '../../messaging/infrastructure/deliveryScope.js'
import {sanitizeFinalReplyText} from '../../conversation/domain/replySanitizer.js'
import {REMINDER_KEY_PREFIX,REMINDER_LOCK_KEY,REMINDER_PENDING_KEY,decodeReminder,decodeReminderAction,decodeReminderPendingList,reminderDetailKey,reminderText} from './reminderLedger.js'
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function errorText(error:unknown){return error instanceof Error?error.message:String(error)}
function decodeEvent(value:unknown):ReminderEvent {const r=record(value);if(typeof r.user_id!=='string'&&typeof r.user_id!=='number')throw new Error('提醒缺少用户身份');return r as unknown as ReminderEvent}
const bindingChanged = '角色绑定已改变，提醒未执行'
function reminderBindingIdentity(e:ActionFactsEvent) {
  const binding=e._agentBinding
  return binding?.source==='configured'?agentBindingIdentity(binding):undefined
}
export function createReminderRuntime(ports:ReminderPorts){
const {redis,logger,mcpManager}=ports
// 内存缓存原始 e 对象，重启后丢失则降级用 fakeEvent
const eventCache = new Map<string,ReminderEvent>()

const scopeIndexKey=(e:ActionFactsEvent)=>{
  const {botId,conversationId,userId}=actionFactScope(e)
  const bindingIdentity=reminderBindingIdentity(e)
  return `${REMINDER_KEY_PREFIX}facts:${encodeURIComponent(JSON.stringify({botId,conversationId,userId,...(bindingIdentity?{bindingIdentity}:{})}))}`
}

function reminderMatchesScope(reminder:ReminderData,e:ActionFactsEvent) {
  const {bindingToken: _bindingToken,...scope}=actionFactScope(e)
  return reminder.bindingIdentity===reminderBindingIdentity(e)&&matchesActionFactScope(actionFactScope({
    self_id:reminder.bot_id||'',group_id:reminder.group_id,user_id:reminder.user_id,
  }),scope)
}

async function indexReminder(e:ActionFactsEvent,id:string) {
  try {
    const key=scopeIndexKey(e),raw=await redis.get(key)
    const parsed:unknown=raw?JSON.parse(raw):[]
    const ids=Array.isArray(parsed)?parsed.filter((value):value is string=>typeof value==='string'):[]
    await redis.set(key,JSON.stringify([id,...ids.filter(value=>value!==id)].slice(0,12)),{EX:86400})
  } catch { logger.warn('[ReminderTool] 提醒事实索引不可用，后续查询将保持未确认') }
}

const LOCK_TIMEOUT=15000
const LOCK_ACQUIRE_TIMEOUT=1500
async function acquireLock(timeout=LOCK_ACQUIRE_TIMEOUT){
 const token=randomUUID(),end=Date.now()+timeout
 while(Date.now()<end){
  const result=await redis.set(REMINDER_LOCK_KEY,token,{PX:LOCK_TIMEOUT,NX:true})
  if(result==='OK'||result===true)return token
  await new Promise(resolve=>setTimeout(resolve,50))
 }
 return null
}
async function releaseLock(token:string){
 await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[REMINDER_LOCK_KEY],arguments:[token]})
}

/**
 * 获取待触发提醒列表
 */
async function getPendingList():Promise<ReminderPending[]>{
 return decodeReminderPendingList(await redis.get(REMINDER_PENDING_KEY))
}

/**
 * 保存待触发提醒列表
 */
async function savePendingList(list:ReminderPending[]) {
  await redis.set(REMINDER_PENDING_KEY, JSON.stringify(list))
}

/**
 * 带锁的列表操作
 */
async function withLock<T>(operation:()=>Promise<T>) {
  const lockValue = await acquireLock()
  if (!lockValue) {
    throw new Error('获取锁超时')
  }
  try {
    return await operation()
  } finally {
    await releaseLock(lockValue)
  }
}

/**
 * 定时提醒工具类
 * 支持相对时间（如"15分钟后"）和绝对时间（如"1月27号下午5点"）
 */
class ReminderTool extends AbstractTool {
  constructor() {
    super()
    this.name = 'reminderTool'
    this.description = `创建定时提醒。用户说"X秒后提醒我..."、"X分钟后提醒我..."、"X点提醒我..."时调用此工具。
支持精确到秒的时间（如10秒后、30秒后）、相对时间(如15分钟后、1小时后)和绝对时间(如下午5点、1月27号17:00)。
你需要将用户描述的时间转换为ISO 8601格式，当前北京时间会在系统提示中提供。
如果用户要求提醒时执行额外操作（如发歌、戳一戳），可以在extra_action中指定当前可用的任何工具。`
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'cancel'],
          description: '操作类型：create创建提醒，list查看提醒列表，cancel取消提醒'
        },
        reminder_time: {
          type: 'string',
          description: '提醒时间，ISO 8601格式（如"2026-01-27T17:00:00+08:00"）。相对时间需根据当前北京时间计算后转换。注意要包含时区信息（+08:00表示北京时间）。创建提醒时必填。'
        },
        content: {
          type: 'string',
          description: '提醒事项的简短描述，用于记录和列表显示。创建提醒时必填。'
        },
        reminder_message: {
          type: 'string',
          description: '提醒时发送的消息内容。请用自然、口语化的方式写，不要太正式，要非常像人类的口吻。'
        },
        extra_action: {
          type: 'object',
          description: '额外操作，提醒时同时执行的工具。可使用当前会话中任何可用的工具（本地工具或MCP工具）',
          properties: {
            tool: {
              type: 'string',
              description: '要调用的工具名'
            },
            params: {
              type: 'object',
              description: '工具参数，根据目标工具的参数定义填写'
            }
          }
        },
        reminder_id: {
          type: 'string',
          description: '提醒ID，取消提醒时需要提供'
        }
      },
      required: ['action']
    }
  }

  /**
   * 生成提醒ID
   */
  generateId(userId:string|number) {
    return `rem_${Date.now()}_${userId}_${randomUUID()}`
  }

  /**
   * 获取 Redis key
   */
  getRedisKey(type:string, id:string) {
    return type === 'detail' ? reminderDetailKey(id) : `${REMINDER_KEY_PREFIX}${type}:${id}`
  }

  /**
   * 解析时间字符串为时间戳
   */
  parseTime(timeStr:string) {
    try {
      // 如果没有时区信息，假定为北京时间
      let normalizedTimeStr = timeStr
      if (!timeStr.includes('+') && !timeStr.includes('Z') && !timeStr.includes('-', 10)) {
        normalizedTimeStr = timeStr + '+08:00'
      }

      const date = new Date(normalizedTimeStr)
      if (isNaN(date.getTime())) {
        return null
      }
      return date.getTime()
    } catch {
      return null
    }
  }

  /**
   * 格式化时间显示（北京时间）
   */
  formatTime(timestamp:number){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(timestamp)
    const get=(type:string)=>parts.find(part=>part.type===type)?.value||''
    return `${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}:${get('second')}`
  }

  /**
   * 创建提醒
   */
  async createReminder(e:ReminderEvent, timeStr:string, content:string, reminderMessage:string, extraAction:ReminderAction|null = null) {
    if (!timeStr) {
      return '创建提醒失败：未提供提醒时间'
    }
    if (!content) {
      return '创建提醒失败：未提供提醒内容'
    }

    const triggerTime = this.parseTime(timeStr)
    if (!triggerTime) {
      return `创建提醒失败：无法解析时间 "${timeStr}"`
    }

    const now = Date.now()
    if (triggerTime <= now) {
      return '创建提醒失败：提醒时间必须是将来的时间'
    }

    if (!isAgentBindingCurrent(e)) return `创建提醒失败：${bindingChanged}`
    const botId = e._agentBinding?.target.account.id || String(e.self_id || e.bot?.uin || ports.getBot()?.uin || '')
    const scopeEvent:ReminderEvent={user_id:e.user_id,self_id:botId,group_id:e.group_id??null,
      ...(e._agentBinding?{_agentBinding:e._agentBinding}:{})}
    const identity = reminderBindingIdentity(e)
    const reminderId = this.generateId(e.user_id)
    eventCache.set(reminderId, e)
    const reminderData:ReminderData = {
      bot_id:botId,
      ...(identity?{bindingIdentity:identity}:{}),
      id: reminderId,
      user_id: String(e.user_id),
      group_id: e._agentBinding?.target.kind==='group' ? e._agentBinding.target.id : e.group_id ? String(e.group_id) : null,
      message_id: e.message_id || null,
      content: content,
      reminder_message: reminderMessage || null,  // 保存自定义提醒消息
      trigger_time: triggerTime,
      created_at: now,
      status: 'pending',
      extra_action: extraAction || null,
      retry_count: 0
    }

    try {
      // 带锁添加到待触发列表
      await withLock(async () => {
        const pendingList = await getPendingList()
        if (!isAgentBindingCurrent(e)) throw new Error(bindingChanged)
        const key=this.getRedisKey('detail',reminderId)
        await redis.set(key,JSON.stringify(reminderData))
        if (!isAgentBindingCurrent(e)) {
          await redis.del(key)
          throw new Error(bindingChanged)
        }
        pendingList.push({
          id: reminderId,
          trigger_time: triggerTime
        })
        // 按时间排序
        pendingList.sort((a, b) => a.trigger_time - b.trigger_time)
        await savePendingList(pendingList)
        await indexReminder(scopeEvent,reminderId)
      })

      const formattedTime = this.formatTime(triggerTime)
      let response = `提醒已创建！我会在 ${formattedTime} 提醒你：${content}`
      if (extraAction?.tool) {
        const toolNames:Record<string,string> = {
          searchMusicTool: '发送音乐',
          pokeTool: '戳一戳',
          voiceTool: '发送语音'
        }
        response += `（届时还会${toolNames[extraAction.tool] || '执行额外操作'}）`
      }
      response += `\n提醒ID: ${reminderId}`

      return response
    } catch (error) {
      eventCache.delete(reminderId)
      logger.error('[ReminderTool] 创建提醒失败:', error)
      return `创建提醒失败：${errorText(error)}`
    }
  }

  /**
   * 查看提醒列表
   */
  async getActionFacts(e:ActionFactsEvent,query:ActionFactsQuery={}):Promise<TurnActionFacts> {
    const now=Date.now(),scope=actionFactScope(e)
    if(!scope.botId||!scope.userId||!isAgentBindingCurrent(e))return unknownTurnActionFacts(e,now)
    try {
      // A slow or corrupt unrelated reminder must not block chat or erase a
      // separately verified receipt. All reads share one bounded query budget.
      const deadline=now+2000
      async function read<T>(operation:()=>Promise<T>):Promise<T> {
        let timer:ReturnType<typeof setTimeout>|undefined
        try {
          return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('提醒事实查询超时')),Math.max(0,deadline-Date.now()))
          })])
        } finally {if(timer!==undefined)clearTimeout(timer)}
      }
      let incomplete=false
      const [pendingRead,indexRead]=await Promise.allSettled([read(getPendingList),read(async()=>{
        const raw=await redis.get(scopeIndexKey(e)),parsed:unknown=raw?JSON.parse(raw):[]
        if(!Array.isArray(parsed)||parsed.some(value=>typeof value!=='string'))throw new Error('提醒事实索引损坏')
        return parsed as string[]
      })])
      const pending=pendingRead.status==='fulfilled'?pendingRead.value:[]
      const index=indexRead.status==='fulfilled'?indexRead.value:[]
      incomplete=pendingRead.status==='rejected'||indexRead.status==='rejected'
      const ids=[...new Set([...index,...pending.slice(0,128).map(item=>item.id)])].slice(0,140)
      const records=await Promise.allSettled(ids.map(id=>read(async()=>{
        const raw=await redis.get(reminderDetailKey(id))
        return raw?decodeReminder(raw):null
      })))
      if(!isAgentBindingCurrent(e))return unknownTurnActionFacts(e,now)
      const tasks:TurnTaskFact[]=[]
      for(const result of records) {
        if(result.status==='rejected'){incomplete=true;continue}
        const reminder=result.value
        if(!reminder||!reminderMatchesScope(reminder,e))continue
        if(query.referenceMessageId&&String(reminder.message_id)!==query.referenceMessageId&&reminder.id!==query.referenceMessageId
          &&!(reminder.delivery?.state==='sent'&&reminder.delivery.messageId===query.referenceMessageId))continue
        const scheduledAt=pending.find(item=>item.id===reminder.id)?.trigger_time
        const registered=reminder.status==='pending'&&!reminder.waitingForBinding&&scheduledAt===reminder.trigger_time&&scheduledAt>now
        const delivery=reminder.delivery?.state==='sent'?{state:'sent' as const,messageId:reminder.delivery.messageId}:reminder.delivery?.state==='failed'?{state:'failed' as const}:reminder.status==='pending'?{state:'not_attempted' as const}:{state:'unknown' as const}
        tasks.push({taskId:reminder.id,requestMessageId:String(reminder.message_id||reminder.id),toolName:'reminderTool',source:'reminder',observedAt:registered?now:(reminder.updated_at||reminder.created_at),execution:registered?'queued':reminder.status==='completed'?'completed':reminder.status==='failed'?'failed':'unknown',result:'unknown',delivery,followUp:registered?{state:'registered',kind:'reminder',id:reminder.id,dueAt:scheduledAt}:{state:'none'}})
      }
      return {scope,observedAt:now,lookup:incomplete?'unavailable':'ok',tasks:tasks.slice(0,8)}
    } catch {return unknownTurnActionFacts(e,now)}
  }

  async listReminders(e:ReminderEvent) {
    try {
      const scopeEvent:ReminderEvent={user_id:e.user_id,self_id:e.self_id||e.bot?.uin||ports.getBot()?.uin||'',group_id:e.group_id??null,
        ...(e._agentBinding?{_agentBinding:e._agentBinding}:{})}
      const pendingList = await getPendingList()
      const userReminders = []

      for (const item of pendingList) {
        const data = await redis.get(this.getRedisKey('detail', item.id))
        if (data) {
          const reminder = decodeReminder(data)
          if (reminderMatchesScope(reminder,scopeEvent) && ['pending','unknown','sending'].includes(reminder.status)) {
            userReminders.push(reminder)
          }
        }
      }

      if (!isAgentBindingCurrent(e)) return `查看提醒失败：${bindingChanged}`
      if (userReminders.length === 0) {
        return '你没有待执行的提醒'
      }

      // 按触发时间排序
      userReminders.sort((a, b) => a.trigger_time - b.trigger_time)

      let response = `你有 ${userReminders.length} 个待执行的提醒：\n`
      userReminders.forEach((r, i) => {
        const time = this.formatTime(r.trigger_time)
        const status = r.waitingForBinding ? '（等待账号和角色绑定恢复）' : r.status === 'pending' ? '' : '（发送结果待核实，禁止自动重试）'
        response += `\n${i + 1}. [${time}] ${r.content}${status}`
        if (r.extra_action?.tool) {
          const toolNames:Record<string,string> = {
            searchMusicTool: '发送音乐',
            pokeTool: '戳一戳',
            voiceTool: '发送语音'
          }
          response += ` (附带${toolNames[r.extra_action.tool] || '额外操作'})`
        }
        response += `\n   ID: ${r.id}`
      })

      return response
    } catch (error) {
      logger.error('[ReminderTool] 查看提醒列表失败:', error)
      return `查看提醒失败：${errorText(error)}`
    }
  }

  /**
   * 取消提醒
   */
  async cancelReminder(e:ReminderEvent, reminderId:string) {
    if (!reminderId) {
      return '取消提醒失败：未提供提醒ID'
    }

    try {
      const data = await redis.get(this.getRedisKey('detail', reminderId))
      if (!data) {
        return `取消提醒失败：未找到ID为 ${reminderId} 的提醒`
      }

      const reminder = decodeReminder(data)

      // 验证是否是该用户的提醒（管理员可以取消任何提醒）
      if (reminder.user_id !== String(e.user_id) && !e.isMaster) {
        return '取消提醒失败：你只能取消自己的提醒'
      }
      const scopeEvent:ReminderEvent={user_id:e.group_id&&e.isMaster?reminder.user_id:e.user_id,
        self_id:e.self_id||e.bot?.uin||ports.getBot()?.uin||'',group_id:e.group_id??null,
        ...(e._agentBinding?{_agentBinding:e._agentBinding}:{})}
      if ((reminder.bindingIdentity || reminderBindingIdentity(e) || !e.isMaster) && !reminderMatchesScope(reminder,scopeEvent)) {
        return '取消提醒失败：该提醒不属于当前角色和会话'
      }

      // 带锁从待触发列表移除
      await withLock(async () => {
        const pendingList = await getPendingList()
        if (!isAgentBindingCurrent(e)) throw new Error(bindingChanged)
        const newList = pendingList.filter(item => item.id !== reminderId)
        await savePendingList(newList)
      })

      // 删除 detail 数据（清理垃圾）
      await redis.del(this.getRedisKey('detail', reminderId))
      eventCache.delete(reminderId)

      return `已取消提醒：${reminder.content}`
    } catch (error) {
      logger.error('[ReminderTool] 取消提醒失败:', error)
      return `取消提醒失败：${errorText(error)}`
    }
  }

  /**
   * 执行工具
   */
  async func(input:unknown, event:unknown) {
    const opts=record(input),e=decodeEvent(event)
    const action=String(opts.action||""),reminder_time=String(opts.reminder_time||""),content=String(opts.content||""),reminder_message=String(opts.reminder_message||""),reminder_id=String(opts.reminder_id||"")
    const extra_action=decodeReminderAction(opts.extra_action)

    switch (action) {
      case 'create':
        return await this.createReminder(e, reminder_time, content, reminder_message, extra_action)
      case 'list':
        return await this.listReminders(e)
      case 'cancel':
        return await this.cancelReminder(e, reminder_id)
      default:
        return `未知操作：${action}`
    }
  }
}

/**
 * 检查并触发到期的提醒
 * 此函数由 test.js 的定时任务调用
 */
async function checkPendingReminders(toolInstances:ReminderTools) {
  try {
    const now = Date.now()

    // 先无锁 peek：90% 时间池子为空或全是未到期项，根本不用进锁
    const peekList = await getPendingList()
    if (!peekList || peekList.length === 0) return
    const hasDue = peekList.some(item => item.trigger_time <= now)
    if (!hasDue) return

    // 确认有到期项才进锁，二次过滤（防止并发已被其他实例取走）
    const dueReminders = await withLock(async () => {
      const pendingList = await getPendingList()
      if (!pendingList || pendingList.length === 0) return []

      const due = pendingList.filter(item => item.trigger_time <= now)
      if (due.length === 0) return []

      // 立即从列表中移除（先移除再处理，防止下一秒 cron 重复触发）
      const remaining = pendingList.filter(item => item.trigger_time > now)
      await savePendingList(remaining)

      return due
    })

    if (dueReminders.length === 0) {
      return
    }

    logger.info(`[ReminderTool] 发现 ${dueReminders.length} 个到期提醒`)

    // 逐个处理提醒
    for (const item of dueReminders) {
      try {
        const result = await triggerReminder(item.id, toolInstances)
        if (result !== true) {
          // 失败的重新添加回列表，延迟10秒重试
          await addBackToListForRetry(item.id, result==='unavailable')
        }
      } catch (error) {
        logger.error(`[ReminderTool] 触发提醒 ${item.id} 失败:`, error)
        await addBackToListForRetry(item.id)
      }
    }

  } catch (error) {
    // 锁超时是预期可恢复事件（下次 cron 再试），降级为 debug 避免每秒刷红
    if (String(error instanceof Error ? errorText(error) : String(error)).includes('获取锁超时')) {
      logger.debug(`[ReminderTool] 本轮跳过：${errorText(error)}`)
      return
    }
    logger.error('[ReminderTool] 检查待触发提醒失败:', error)
  }
}

/**
 * 将失败的提醒重新添加到列表等待重试
 */
async function addBackToListForRetry(reminderId:string, waitingForBinding=false) {
  const MAX_RETRY = 3

  try {
    await withLock(async () => {
      const pendingList = await getPendingList()

      // 检查是否已存在（避免重复添加）
      if (pendingList.some(item => item.id === reminderId)) {
        return
      }

      // 检查重试次数
      const detailData = await redis.get(reminderDetailKey(reminderId))
      if (!detailData) {
        return
      }

      const detail = decodeReminder(detailData)
      if(detail.status !== "pending")return
      detail.waitingForBinding=waitingForBinding
      if(!waitingForBinding)detail.retry_count = (detail.retry_count || 0) + 1

      if (!waitingForBinding && detail.retry_count >= MAX_RETRY) {
        logger.error(`[ReminderTool] 提醒 ${reminderId} 重试 ${MAX_RETRY} 次后仍失败，已放弃`)
        detail.status = 'failed'
        await redis.set(reminderDetailKey(reminderId), JSON.stringify(detail))
        return
      }

      // 延迟10秒重试
      detail.trigger_time=Date.now()+10_000
      await redis.set(reminderDetailKey(reminderId), JSON.stringify(detail))
      pendingList.push({
        id: reminderId,
        trigger_time: detail.trigger_time
      })
      pendingList.sort((a, b) => a.trigger_time - b.trigger_time)
      await savePendingList(pendingList)

      logger.info(`[ReminderTool] 提醒 ${reminderId} 将在 10 秒后重试（第 ${detail.retry_count} 次）`)
    })
  } catch (error) {
    logger.error(`[ReminderTool] 重新添加提醒到列表失败:`, error)
  }
}

/**
 * 触发单个提醒
 * @returns {boolean} 是否成功
 */
async function triggerReminder(reminderId:string, toolInstances:ReminderTools):Promise<boolean|'unavailable'> {
  const key=reminderDetailKey(reminderId)
  const data = await redis.get(key)
  if (!data) {
    return true // 数据不存在，视为已处理
  }

  const reminder = decodeReminder(data)
  if (reminder.status !== 'pending') {
    return true // 已处理过
  }

  const bot=ports.getBot(reminder.bot_id)
  const groupId=reminder.group_id?Number(reminder.group_id):null
  const userId=Number(reminder.user_id)
  const event:ReminderEvent={
    user_id:userId,group_id:groupId,message_type:groupId?'group':'private',
    ...(reminder.bot_id||bot?.uin ? {self_id:reminder.bot_id||bot!.uin!} : {}),
    ...(bot ? {bot} : {}),
    ...(reminder.message_id!==null ? {message_id:reminder.message_id} : {}),
  }
  const finishCancelled=async()=>{
    reminder.status='cancelled'
    reminder.updated_at=Date.now()
    await redis.set(key,JSON.stringify(reminder),{EX:86400})
    eventCache.delete(reminderId)
    logger.info(`[ReminderTool] ${bindingChanged} id=${reminderId}`)
    return true
  }
  const expected=reminder.bindingIdentity?{identity:reminder.bindingIdentity}:undefined
  const restored=ports.restoreBinding ? ports.restoreBinding(event,expected) : expected ? 'unavailable' : 'current'
  if (restored==='changed') return await finishCancelled()
  if (restored==='unavailable') return 'unavailable'
  const isCurrent=()=>isAgentBindingCurrent(event)

  let attempted=false
  try {
    if(!bot||(reminder.bot_id&&String(bot.uin)!==reminder.bot_id))return 'unavailable'
    delete reminder.waitingForBinding
    if (reminder.extra_action?.tool && !reminder.extra_attempted) {
      const { tool, params } = reminder.extra_action
      reminder.extra_attempted=true
      await redis.set(key,JSON.stringify(reminder))
      if(!isCurrent())return await finishCancelled()

      try {
        // 合并用户 QQ 到 params（如 pokeTool 需要 target）
        const mergedParams = { ...(params || {}) }
        if (tool === 'pokeTool' && !mergedParams.target) {
          mergedParams.target = [reminder.user_id]
        }

        // 判断是 MCP 工具还是本地工具
        if (mcpManager?.isMCPTool?.(tool)) {
          // MCP 工具
          await withDeliveryGuard(isCurrent,()=>mcpManager.executeToolByAlias(tool,mergedParams))
          logger.info(`[ReminderTool] 已执行 MCP 工具: ${tool}`)
        } else if (toolInstances?.[tool]) {
          const cached=eventCache.get(reminderId)
          const sender=record(cached?.sender)
          const peer=groupId?bot.pickGroup?.(groupId):bot.pickFriend?.(userId)
          Object.assign(event,{
            sender:{...sender,user_id:userId,nickname:sender.nickname||'定时提醒用户'},
            group:groupId?peer||null:null,
            friend:groupId?null:peer||null,
            isGroup:Boolean(groupId),
            isMaster:cached?.isMaster===true,
            reply:async(message:unknown)=>{
              if(!peer)return {state:'failed',code:'conversation_unavailable'}
              if(!isCurrent())return {state:'failed',code:'binding_changed'}
              return await withDeliveryGuard(isCurrent,()=>peer.sendMsg(message))
            },
          })
          if(!isCurrent())return await finishCancelled()
          await withDeliveryGuard(isCurrent,()=>toolInstances[tool]!.execute(mergedParams,event))
          logger.info(`[ReminderTool] 已执行本地工具: ${tool}`)
        } else {
          logger.warn(`[ReminderTool] 未找到工具: ${tool}`)
        }
      } catch (error) {
        logger.error(`[ReminderTool] 执行额外操作 ${tool} 失败:`, error)
        // 额外操作失败不影响提醒消息发送
      }

      // 延迟一秒后发送提醒消息
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // 再发送提醒消息（引用回复）
    // 优先使用自定义消息，否则使用默认格式
    if(!isCurrent())return await finishCancelled()
    const messageText = sanitizeFinalReplyText(reminderText(reminder))
    if(!messageText){
      reminder.status='failed'
      reminder.updated_at=Date.now()
      await redis.set(key,JSON.stringify(reminder),{EX:86400})
      eventCache.delete(reminderId)
      return true
    }

    reminder.status="sending"
    await redis.set(key,JSON.stringify(reminder))
    if(!isCurrent())return await finishCancelled()
    attempted=true
    const message:{type:string;data:Record<string,string>}[]=[]
    if (reminder.message_id) message.push({type:'reply',data:{id:String(reminder.message_id)}})
    if (groupId) message.push({type:'at',data:{qq:reminder.user_id}})
    message.push({type:'text',data:{text:groupId?` ${messageText}`:messageText}})
    const receipt=await withDeliveryGuard(isCurrent,()=>bot.sendApi(groupId?'send_group_msg':'send_private_msg',{
      ...(groupId?{group_id:groupId}:{user_id:userId}),message,
    }))
    const outcome=normalizeDeliveryReceipt(receipt)
    if(outcome.state==='failed'&&outcome.code==='binding_changed'){
      reminder.delivery=outcome
      return await finishCancelled()
    }
    reminder.delivery=outcome
    reminder.updated_at=Date.now()
    if(outcome.state!=="sent"){
      reminder.status=outcome.state==="failed"?"pending":"unknown"
      await redis.set(key,JSON.stringify(reminder),outcome.state==='unknown'?{EX:86400}:undefined)
      eventCache.delete(reminderId)
      return outcome.state!=="failed"
    }
    logger.info(`[ReminderTool] 已发送提醒给用户 ${reminder.user_id}: ${reminder.content}`)

    // 更新状态为已完成
    reminder.status = 'completed'
    // Keep the confirmed receipt for bounded follow-up queries; no pending index remains.
    await redis.set(key,JSON.stringify(reminder),{EX:86400})

    eventCache.delete(reminderId)

    return true

  } catch (error) {
    logger.error(`[ReminderTool] 发送提醒消息失败:`, error)
    if(attempted){reminder.status='unknown';reminder.delivery={state:'unknown'};reminder.updated_at=Date.now();await redis.set(key,JSON.stringify(reminder),{EX:86400});eventCache.delete(reminderId);return true}
    return false
  }
}

return {ReminderTool,checkPendingReminders}
}
