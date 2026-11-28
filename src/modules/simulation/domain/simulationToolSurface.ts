import type { SimMessage } from '../../../contracts/simulation.js'
import { isExplicitSearchRequest, isExplicitToolIntent, isRealtimeInfoRequest, normalizeIntentText } from '../../conversation/domain/messageIntent.js'
import { isExplicitNoToolAction } from '../../conversation/domain/toolActionPolicy.js'
import { CHAT_HISTORY_PATTERNS, MEMBER_INFO_PATTERNS } from '../../tools/domain/memberMemoryIntent.js'

export type DirectedToolSurface = { mode: 'conversation' } | { mode: 'lookup'; reads: ReadonlySet<string> }

const recentReads = ['simGetRecentMessages', 'simGetMessageDetail']
const historyReads = ['chatHistoryTool', 'simGetUnreadMessages', 'simGetForward', ...recentReads]
const memberReads = ['memberInfoTool', 'simGetGroupMembers']
const webReads = ['searchInformationTool', 'webParserTool']
const fileReads = ['fileTextTool', 'excelWorkbookTool']
const actionSignals = [
  /提醒|闹钟|(?:喊|叫)(?:我|我们|大家|群友|他们|她们|成员)|通知|转告|艾特|到点|托付|帮我记住|存(?:到|入|成|一份)|保存|记录下来|预约|订阅|下单|购买|发送|发(?:给|到|来|出去|过来|群|一张|一份|一下|个|图|视频|文件)|转发|分享|上传|下载|撤回|收回|禁言|踢人|改名片|点赞|戳|红包|礼物/u,
  /点歌|播放|朗读|语音|表情包|绘制|生成|画(?:图|一|个|张)|修图|改图|运行命令|执行|写入|编辑|修改|删除|清空|部署|仓库|github|codeup|mcp|b站|哔哩哔哩|磁链|magnet:/iu,
]
const opinion = /^(?:你(?:觉得|怎么看|喜欢|更喜欢|会喜欢|会玩|会看|会选|想聊)|说说你(?:觉得|怎么看)).{1,56}[?？么吗呢。！!]?$/u
const attachedRead = /(?:查|读|打开|看|列出|提取|分析|总结|整理|比较|对比|哪些|有什么|内容|讲了什么)/u
const namedFileRead = /(?:查|读|打开|看|列出|提取|分析|总结|整理|比较|对比).{0,25}(?:附件|文件|群文件|Excel|工作簿|工作表|单元格|表格|\.xlsx)/iu
const compareSources = /^(?:(?:请|麻烦|帮我|给我|先)\s*)*(?:比较|对比).{0,32}(?:公告|资料|入口|来源|报道)/u
const unspecifiedLookup = /^(?:(?:请|麻烦|帮我|给我|先|再)\s*)*(?:查|搜|看)(?:一下|一眼|查|搜|看|下|询|索)?\s*(?:这|那)(?:个|件事|条|一条|事)(?:吧|呢)?[。！？.!?]*$/u

/** A positive match may reduce the prompt. Permissions still come from the runtime. */
export function selectDirectedToolSurface(message: SimMessage, available: ReadonlySet<string>): DirectedToolSurface | undefined {
  if (message.kind !== 'text' || message.textTruncated || message.atOther || message.imageCount || message.videoCount ||
      message.quoteSource?.image || message.quoteSource?.video || message.forwardId || message.quoteImageUrls?.length) return
  const text = normalizeIntentText(message.text)
  if (!text || text.length > 260 || actionSignals.some(pattern => pattern.test(text))) return

  const hasFile = Boolean(message.files?.length || message.quoteSource?.file?.files?.length)
  const file = hasFile ? attachedRead.test(text) : namedFileRead.test(text)
  if (hasFile && !file) return
  if (!file && unspecifiedLookup.test(text)) return
  const group = CHAT_HISTORY_PATTERNS.some(pattern => pattern.test(text))
  const member = MEMBER_INFO_PATTERNS.some(pattern => pattern.test(text))
  const web = (!file && !group && !member && isExplicitSearchRequest(text)) ||
    /https?:\/\/|联网|网上|公网/u.test(text) || isRealtimeInfoRequest(text) || compareSources.test(text)
  const reads = [...(file ? fileReads : []), ...(group ? historyReads : []), ...(member ? memberReads : []), ...(web ? webReads : [])]
  if (reads.length) {
    if (!isExplicitNoToolAction(text) && reads.some(name => available.has(name))) return { mode: 'lookup', reads: new Set([...reads, ...recentReads]) }
    return
  }
  if (!message.quoteSource && !message.replyMessageId && !message.quoteText && !isExplicitToolIntent(text) &&
      !/这张|那张|截图|你刚才|上条|前一条/u.test(text) && opinion.test(text)) return { mode: 'conversation' }
}
