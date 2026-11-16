import {normalizeDeliveryReceipt} from '../../messaging/domain/deliveryReceipt.js'
interface CorrectionOptions {text?:string;groupId?:string;botId?:string;quotedReplyMessageId?:string;quotesBot?:boolean;senderUserId?:string|number;lastBotReplyToUserId?:string|number;runtime?:{store?:{penalizeChunks(groupId:string,ids:string[],options:{penalty:number}):number}}|null;patterns?:RegExp[];ttlMs?:number;penalty?:number;now?:number;logger?:{mark?(message:string):void;warn?(message:string):void}}
// 记忆自纠错:群友在对话里指出"你记错了"时,系统自动降权她刚刚用到的那条记忆——
// 纠错发生在对话里,不靠主人手动查删。
// 语义:降权(penalize)而非直接删除——被纠错的记忆基准强度下调且不重置衰减时钟,
// 重复纠错会把它打到冻结线以下,由每日清扫自然淡忘;单次误伤只降权,不丢数据。
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_PENALTY = 0.5

// 纠错话术(指向 bot 的"你记错了"类表达;命中任一即视为纠错信号)
export const DEFAULT_CORRECTION_PATTERNS = [
  /你记错/,
  /记错了吧/,
  /记岔/,
  /你搞错/,
  /不是这样的/,
  /不是吧,?根本没有/,
  /根本没有这(件|个)(事|说法)/,
  /没有这回事/,
  /哪有这(件|个)(事|说法)/,
  /你(是不是)?(记|想)岔/,
  /瞎(说|讲),?没(有|这事)/
]

export interface MemoryReplyEvent {
  group_id?:string|number;self_id?:string|number;bot?:{uin?:string|number};user_id?:string|number;
  _turnId?:string;_semanticMemoryChunkIds?:string[]
}
interface ConfirmedMemoryReply {ids:string[];at:number;botId:string;groupId:string;turnId:string;replyMessageId:string;userId:string}
const replies=new Map<string,ConfirmedMemoryReply>()
const latestReply=new Map<string,string>()
const MAX_REPLIES=512
const scopeKey=(botId:string,groupId:string)=>JSON.stringify([botId,groupId])
const replyKey=(botId:string,groupId:string,messageId:string)=>JSON.stringify([botId,groupId,messageId])

// Prompt preparation only stages provenance on this event. It is not evidence
// that the model used the memory or that anyone received a reply.
export function noteInjectedChunks(event:MemoryReplyEvent,items:{chunk?:{id?:string}}[]=[]){
  event._semanticMemoryChunkIds=[...new Set(items.map(item=>item?.chunk?.id||'').filter(Boolean))]
}

export function confirmMemoryReply(event:MemoryReplyEvent,receipt:unknown,now=Date.now()){
  const delivery=normalizeDeliveryReceipt(receipt)
  const botId=String(event.self_id||event.bot?.uin||''),groupId=String(event.group_id||''),turnId=String(event._turnId||'')
  if(delivery.state!=='sent'||!botId||!groupId||!turnId)return false
  const key=replyKey(botId,groupId,delivery.messageId)
  const record={ids:[...(event._semanticMemoryChunkIds||[])],at:now,botId,groupId,turnId,replyMessageId:delivery.messageId,userId:String(event.user_id||'')}
  replies.set(key,record)
  latestReply.set(scopeKey(botId,groupId),key)
  for(const [oldKey,old]of replies)if(now-old.at>DEFAULT_TTL_MS||replies.size>MAX_REPLIES){
    replies.delete(oldKey)
    if(latestReply.get(scopeKey(old.botId,old.groupId))===oldKey)latestReply.delete(scopeKey(old.botId,old.groupId))
  }
  return true
}

export function getInjectedChunks(groupId:unknown,{botId='',replyMessageId='',ttlMs=DEFAULT_TTL_MS,now=Date.now()}={}){
  const key=replyMessageId?replyKey(botId,String(groupId||''),replyMessageId):latestReply.get(scopeKey(botId,String(groupId||'')))
  const record=key?replies.get(key):undefined
  if(!record||now-record.at>ttlMs)return null
  return record
}

export function isCorrectionText(text = "", patterns = DEFAULT_CORRECTION_PATTERNS) {
  const content = String(text || "")
  if (!content) return false
  return patterns.some(pattern => pattern.test(content))
}

/**
 * 纠错检测与执行。返回被降权的分块 id 数组(空数组=未触发),不抛错。
 * 触发条件(全部满足):
 * 1) 消息文本命中纠错话术;
 * 2) 与 bot 相关:引用了 bot 的消息,或发送者正是 bot 上一轮回复的人;
 * 3) 同 bot、同群在 TTL 内有可关联的已确认发送回复及其记忆分块来源。
 */
export function detectAndPenalize({
  text = "",
  groupId = "",
  botId = "",
  quotedReplyMessageId = "",
  quotesBot = false,
  senderUserId = "",
  lastBotReplyToUserId = "",
  runtime = null,
  patterns = DEFAULT_CORRECTION_PATTERNS,
  ttlMs = DEFAULT_TTL_MS,
  penalty = DEFAULT_PENALTY,
  now = Date.now(),
  logger
}:CorrectionOptions = {}) {
  const store = runtime?.store
  if (!store || typeof store.penalizeChunks !== "function") return []
  if(!botId)return []
  // An explicit quote must resolve exactly. Never fall back to a newer reply.
  if(quotesBot&&!quotedReplyMessageId)return []
  const record = getInjectedChunks(groupId, {botId,replyMessageId:quotedReplyMessageId, ttlMs, now })
  if (!record) return []
  if (!isCorrectionText(text, patterns)) return []
  const related = Boolean(quotedReplyMessageId || String(senderUserId || "") && String(senderUserId) === record.userId && (!lastBotReplyToUserId || String(senderUserId) === String(lastBotReplyToUserId)))
  if (!related) return []
  try {
    const penalized = store.penalizeChunks(groupId, record.ids, { penalty })
    if (penalized > 0) {
      logger?.mark?.(`[记忆自纠错] group=${groupId} 群友指出记错,已降权 ${penalized} 条相关记忆(降 ${penalty},继续衰减将自然淡忘)`)
    }
    return record.ids.slice(0, penalized)
  } catch (error) {
    logger?.warn?.(`[记忆自纠错] 降权失败 group=${groupId}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export function __resetMemorySelfCorrectionForTest() {
  replies.clear()
  latestReply.clear()
}
