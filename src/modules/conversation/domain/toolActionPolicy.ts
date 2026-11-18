// Candidates favor recall. A denied action stays denied when another clause
// asks for a different capability; a positive clause is not blanket consent.
type Scope = 'reminder' | 'delta' | 'github' | 'search' | 'member' | 'history' | 'web' | 'music' | 'emoji' | 'mention' | 'moderation' | 'card' | 'poke' | 'like' | 'recall' | 'voice' | 'image' | 'download' | 'memory' | 'gift' | 'redPacket' | 'qzone'
const TOOL_SCOPES: Record<string, Scope> = {
  reminderTool: 'reminder', deltaForceTool: 'delta', githubRepoTool: 'github', searchInformationTool: 'search',
  memberInfoTool: 'member', chatHistoryTool: 'history', webParserTool: 'web', searchMusicTool: 'music',
  sendLocalEmojiTool: 'emoji', emojiSearchTool: 'emoji', mentionMembersTool: 'mention', mentionAdminsTool: 'mention',
  jinyanTool: 'moderation', changeCardTool: 'card', pokeTool: 'poke', likeTool: 'like', recallTool: 'recall', voiceTool: 'voice',
  bananaTool: 'image', googleImageEditTool: 'image', googleImageAnalysisTool: 'image',
  torrentDownloadTool: 'download', pixivDownloadTool: 'download', forgetGroupKnowledgeTool: 'memory',
  sendGiftTool: 'gift', grabRedBagTool: 'redPacket', qqZoneTool: 'qzone',
}
const SCOPE_PATTERNS: [Scope, RegExp][] = [
  ['reminder', /提醒|闹钟|叫我|喊我|通知我|到点|别让我忘记/u],
  ['delta', /三角洲|改枪码|改枪方案|特勤处|制造利润|今日密码|每日密码/u],
  ['github', /github|(?:这个|代码|项目|开源)仓库|仓库(?:地址|链接)/iu],
  ['search', /天气|气温|新闻|热搜|汇率|股价|行情|联网|百度|谷歌|网上/u],
  ['member', /成员(?:资料|信息)?|群名片|谁来着|是谁|是哪位|入群|群身份|(?:他|她|这人|那人|这个人|那个人).{0,8}(?:资料|名片|身份)/u],
  ['history', /聊天记录|群聊记录|历史消息|发言记录|(?:刚才|刚刚|之前|上次|昨天|前天|那天|上周|最近).{0,20}(?:说|聊|发言|讨论|提过|讲)/u],
  ['web', /网页|官网|页面|链接|https?:\/\//iu],
  ['music', /点歌|放首|来首|播放|音乐|唱一首|想听|周杰伦|的歌/u],
  ['emoji', /表情包|表情图/u], ['mention', /艾特|@全体|喊(?:他们|群友)|通知(?:全体|群友)/u],
  ['moderation', /禁言|解禁|踢人|踢出/u], ['card', /(?:改|修改|设置|清空|清除|删除).{0,40}(?:名片|昵称|名字|名称)|(?:名片|昵称|名字|名称).{0,12}(?:改成|改为|修改|换成|换为|设为|设置为|清空|清除|删除)/u],
  ['poke', /戳|拍一拍/u], ['like', /点赞|点个赞/u], ['recall', /撤回|收回/u], ['voice', /语音|朗读/u],
  ['image', /画图|生图|修图|改图|图片分析|识图|画一张|生成.{0,8}(?:图|照片)/u],
  ['download', /下载|磁链|磁力链接|magnet:/iu], ['memory', /删除记忆|清除记忆/u],
  ['gift', /礼物|香槟|风暴战锤|遨游太空|蹦迪派对|露营|龙腾万里|超级跑车|直升机|(?:送|赠).{0,40}(?:给|我|你|他|她)/u],
  ['redPacket', /红包/u], ['qzone', /QQ空间|空间.{0,20}(?:说说|动态)|说说|(?:发布|发表|删除|删掉).{0,20}动态/iu],
]
const DENIAL = /(?:不要|不用|不必|无需|别|甭|先不)(?:再|真的|实际|帮我|替我|给我|去|来|做)?\s*(?:查|搜|翻|看|解析|检索|获取|调用|执行|操作|提醒|叫我|喊我|通知|艾特|@|设(?:置|个)?|用工具|做什么|画|生成|放歌|点歌|播放|下载|禁言|踢|改|戳|点赞)|(?:没(?:有)?|并未)(?:让|叫|要求)你.{0,5}(?:查|搜|解析|执行|提醒|操作)/u
const EXAMPLE = /(?:只是|仅仅是|只是在).{0,6}(?:讨论|举例|示例|转述|引用)|^(?:例如|比如|示例|例子)[：:\s]/u
const REQUEST_START = /^(?:(?:不过|但是|还是|改为|现在|然后|另外|请|麻烦|你|帮我|替我|给我|先|再)\s*)*(?:查|搜|解析|检索|获取|看看|看下|看一下|提醒|叫我|喊我|通知我|设置|设个|定个|加个提醒|取消提醒|删除提醒|删掉提醒|放首|来首|点歌|播放|唱一首|生成|画|制作|修改|禁言|踢|戳|点赞|下载|订|预定|预约|执行|照做)/u
const REMINDER_TIME_REQUEST = /(?:过?\s*(?:\d+|[一二三四五六七八九十两半]+)(?:秒|分钟|小时|天)(?:后)?|今天|明天|后天|今晚|明早|早上|下午|晚上|到点|到\s*[\d一二三四五六七八九十两]+点).{0,20}(?:提醒|叫我|喊我|别让我忘记)/u
const REPORTED = /^(?:他|她|他们|她们|朋友|同事).{0,6}(?:说|会|让|要)/u
const RECALL_DENIAL = /(?:不要|不用|不必|无需|别|甭|先不).{0,80}(?:撤回|收回)|(?:没(?:有)?|并未)(?:让|叫|要求)你.{0,80}(?:撤回|收回)/u
const RECALL_REQUEST = /^(?:(?:不过|但是|还是|改为|现在|然后|另外|请|麻烦|你|帮我|替我|给我|先|再)\s*)*(?:(?:撤回|收回)|把.{1,120}(?:撤回|收回))/u
const MODERATION_DENIAL = /(?:不要|不用|不必|无需|别|甭|先不).{0,80}(?:禁言|解禁)|(?:没(?:有)?|并未)(?:让|叫|要求)你.{0,80}(?:禁言|解禁)/u
const CARD_DENIAL = /(?:不要|不用|不必|无需|别|甭|先不).{0,80}(?:(?:改|修改|设置|清空|清除|删除).{0,40}(?:名片|昵称|名字|名称)|(?:名片|昵称|名字|名称).{0,12}(?:改|修改|设|清空|清除|删除))|(?:没(?:有)?|并未)(?:让|叫|要求)你.{0,80}(?:名片|昵称|名字|名称)/u
const MODERATION_REQUEST = /^(?:(?:不过|但是|还是|现在|然后|另外|请|麻烦|你|帮我|替我|给我|帮忙|确认|先|再|随机|随便|任意)\s*)*(?:(?:(?:给|对).{1,80}?)?(?:禁言|解禁|解除.{0,80}禁言|开启.{0,12}禁言|打开.{0,12}禁言|关闭.{0,12}禁言|取消.{0,12}禁言|全体禁言)|(?:把|将).{1,100}(?:禁言|解禁))/u
const CARD_REQUEST = /^(?:(?:不过|但是|还是|现在|然后|另外|请|麻烦|你|帮我|替我|给我|帮忙|确认|先|再)\s*)*(?:(?:把|将).{1,100}(?:名片|昵称|名字|名称).{0,12}(?:改|修改|换|设|清空|清除|删除)|(?:改|修改|设置|清空|清除|删除).{0,100}(?:名片|昵称|名字|名称)|(?:给|替).{1,80}(?:改|修改|设置|清空|清除|删除).{0,30}(?:名片|昵称|名字|名称))/u
const QQ_REQUESTS: Partial<Record<Scope, RegExp>> = {
  gift: /^(?:(?:现在|另外|请|麻烦|你|帮我|替我|给我|帮忙|确认|先|再)\s*)*(?:(?:给|向).{1,100}?(?:送|赠)|送|赠|赠送)/u,
  redPacket: /^(?:(?:现在|另外|请|麻烦|你|帮我|替我|给我|帮忙|确认|先|再)\s*)*(?:抢|领取|领).{0,50}红包/u,
  qzone: /^(?:(?:现在|另外|请|麻烦|你|帮我|替我|帮忙|确认|先|再|用你自己的身份|以你自己的身份)\s*)*(?:发布|发表|发|删除|删掉|删了|删).{0,80}(?:QQ空间|空间|说说|动态)/iu,
}
const QQ_DENIAL = /(?:不要|不用|不必|无需|别|甭|先不|取消).{0,80}(?:送|赠|礼物|抢.{0,30}红包|领.{0,30}红包|发.{0,30}(?:空间|说说|动态)|删.{0,30}(?:空间|说说|动态))|(?:没(?:有)?|并未)(?:让|叫|要求)你.{0,80}(?:送|赠|红包|空间|说说|动态)/u
const QUERY_SCOPES = new Set<Scope>(['search', 'member', 'history', 'github', 'web', 'delta'])
const QUERY = /是谁|是哪位|谁来着|什么身份|啥身份|说(?:了|的)?(?:啥|什么)|有哪些提醒|(?:还记得|记不记得).{0,20}(?:说|聊|提|约定)|(?:今天|现在|目前).{0,20}(?:多少|怎么样|如何)/u

function scopesIn(text: string): Set<Scope> {
  const scopes = new Set(SCOPE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([scope]) => scope))
  // A GitHub URL identifies the repository capability, not an independent web
  // task. General query verbs acquire a scope only when no subject is known.
  if (scopes.has('github')) scopes.delete('web')
  if (!scopes.size && /查|搜|检索|联网/u.test(text)) scopes.add('search')
  return scopes
}

function requestsAction(clause: string, scopes: Set<Scope>) {
  if (REPORTED.test(clause)) return false
  if ([...scopes].some(scope => QQ_REQUESTS[scope]?.test(clause))) return true
  if (scopes.has('moderation') && MODERATION_REQUEST.test(clause) || scopes.has('card') && CARD_REQUEST.test(clause)) return true
  if (REQUEST_START.test(clause)) return true
  if (scopes.has('recall') && RECALL_REQUEST.test(clause)) return true
  if (scopes.has('reminder') && (REMINDER_TIME_REQUEST.test(clause) || /别忘了.{0,6}提醒我|记得叫我|^(?:查看|看看|列出|取消|删除|删掉).{0,4}提醒|^我的提醒/u.test(clause))) return true
  if (/^(?:我)?想听/u.test(clause)) return true
  return [...scopes].some(scope => QUERY_SCOPES.has(scope)) && QUERY.test(clause)
}

interface ActionScope {hasRestriction:boolean;denyAll:boolean;denied:Set<Scope>;requested:Set<Scope>;unknownRequest:boolean}
function inspectActionScopes(text: string): ActionScope {
  const result:ActionScope = {hasRestriction:false,denyAll:false,denied:new Set(),requested:new Set(),unknownRequest:false}
  const deny = (scopes:Set<Scope>) => {
    result.hasRestriction = true
    if (!scopes.size) result.denyAll = true
    for (const scope of scopes) result.denied.add(scope)
  }
  for (const raw of String(text).split(/[，,。；;！？!?\n]+/u)) {
    const clause = raw.trim()
    if (!clause) continue
    if (DENIAL.test(clause) || RECALL_DENIAL.test(clause) || MODERATION_DENIAL.test(clause) || CARD_DENIAL.test(clause) || QQ_DENIAL.test(clause) || EXAMPLE.test(clause)) {
      deny(scopesIn(clause))
      continue
    }
    const quotes = [...clause.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu)]
    const adoptsQuote = /^(?:(?:请|帮我|麻烦|你)\s*)*(?:执行|照做)/u.test(clause)
    let command = clause
    if (!adoptsQuote) {
      for (const quote of quotes) {
        const scopes = scopesIn(quote[0])
        if (scopes.size) deny(scopes)
        command = command.replace(quote[0], '')
      }
    }
    const scopes = scopesIn(command)
    if (!requestsAction(command, scopes)) continue
    if (!scopes.size) result.unknownRequest = true
    for (const scope of scopes) if (!QQ_REQUESTS[scope] || QQ_REQUESTS[scope]!.test(command)) result.requested.add(scope)
  }
  return result
}

export function isExplicitNoToolAction(text = ''): boolean {
  const scope = inspectActionScopes(text)
  return scope.hasRestriction && !scope.requested.size && !scope.unknownRequest
}

/** A mixed message may reach the planner while keeping its denied capabilities
 * unavailable. Same-tool positive/negative clauses need target-level reasoning;
 * this boolean guard conservatively declines to authorize that tool. */
export function isToolActionDenied(text = '', toolName = ''): boolean {
  const scope = inspectActionScopes(text)
  const toolScope = TOOL_SCOPES[toolName]
  if (toolScope && QQ_REQUESTS[toolScope] && !scope.requested.has(toolScope)) return true
  if (!scope.hasRestriction) return false
  if (scope.denyAll || !scope.requested.size && !scope.unknownRequest) return true
  if (!toolScope) return false
  if (scope.denied.has(toolScope)) return true
  // Generic retrieval must not become a substitute for a denied specialized
  // query. A separate explicit web/search request still has its own scope.
  if (toolScope === 'search' && !scope.requested.has('search') && [...scope.denied].some(denied => QUERY_SCOPES.has(denied))) return true
  if (toolScope === 'web' && scope.denied.has('github') && !scope.requested.has('web')) return true
  return false
}

export function hasReminderActionIntent(text = ''): boolean {
  const scope = inspectActionScopes(text)
  return scope.requested.has('reminder') && !isToolActionDenied(text, 'reminderTool')
}

export function hasRecallActionIntent(text = ''): boolean {
  const scope = inspectActionScopes(text)
  return scope.requested.has('recall') && !isToolActionDenied(text, 'recallTool')
}

/** Positive clauses retain their original wording for target and payload grounding. */
export function groupManagementActionClauses(text: string, kind: 'moderation' | 'card'): readonly string[] {
  if (isToolActionDenied(text, kind === 'moderation' ? 'jinyanTool' : 'changeCardTool')) return []
  const request = kind === 'moderation' ? MODERATION_REQUEST : CARD_REQUEST
  return text.split(/[，,。；;！？!?\n]+/u).map(clause => clause.trim()).filter(clause =>
    !REPORTED.test(clause) && !EXAMPLE.test(clause) && request.test(clause))
}
