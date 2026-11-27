import type { Document } from 'yaml'
import { agentFeatures, type AgentFeatureSwitches } from '../modules/tools/domain/agentFeatureSwitches.js'

// Include built-ins that require a provider or are currently unavailable for every binding.
// Live registry names supplement this list with configured extensions, including MCP aliases.
const toolLabels = new Map(Object.entries({
  searchInformationTool: '联网搜索',
  webParserTool: '网页解析',
  searchVideoTool: '搜索视频',
  videoShareTool: '分享视频卡片',
  videoDownloadTool: '下载视频附件',
  videoAnalysisTool: '视频分析',
  searchMusicTool: '搜索与分享音乐',
  searchMagnetTool: '磁力搜索（含群聊与私聊指令）',
  pixivSearchTool: 'Pixiv 搜索',
  pixivDownloadTool: 'Pixiv 下载',
  emojiSearchTool: '搜索表情包',
  bingImageSearchTool: 'Bing 图片搜索',
  sendLocalEmojiTool: '发送本地表情',
  bananaTool: '生成图片',
  googleImageEditTool: '编辑图片',
  textImageTool: '文字转图',
  aiMindMapTool: '生成思维导图',
  voiceTool: '语音合成',
  fileTextTool: '文档读取',
  excelWorkbookTool: 'Excel 工作簿',
  githubRepoTool: 'GitHub 仓库查询',
  modrinthTool: 'Modrinth 项目查询',
  deltaForceTool: '三角洲行动数据查询',
  memberInfoTool: '查看群成员',
  mentionMembersTool: '点名群成员',
  mentionAdminsTool: '通知群管理',
  chatHistoryTool: '查询聊天记录',
  commitmentTool: '定时提醒与承诺',
  reminderTool: '延期执行工具',
  delegateMemoryTool: '委托记忆',
  groupKnowledgeTool: '群资料与工作流',
  pokeTool: '戳一戳',
  likeTool: '点赞',
  reactionTool: '给消息贴表情',
  recallTool: '撤回消息',
  jinyanTool: '禁言',
  changeCardTool: '改群名片',
  sendGiftTool: '发送礼物效果',
  grabRedBagTool: '按请求领取红包',
  qqZoneTool: 'QQ 空间互动',
  simSendMessage: '仿真发言',
  simFinishTurn: '仿真回合收尾',
  simDecide: '仿真参与决定',
  simGetUnreadMessages: '仿真查看未读消息',
  simGetRecentMessages: '仿真查看近期消息',
  simGetMessageDetail: '仿真读取消息详情',
  simMarkRead: '仿真标读',
  simWaitForMessages: '仿真等待新消息',
  simGetState: '仿真查询状态',
  simSetWakeConfig: '仿真调整唤醒条件',
  simRemember: '仿真记住群内信息',
  simUpdateAffinity: '仿真调整好感',
  simSetMood: '仿真设置情绪',
  simGetMessageImages: '仿真查看附图',
  simGetForward: '仿真读取合并转发',
  simSendPoke: '仿真戳一戳',
  simGetGroupMembers: '仿真查询群成员',
  simSetRhythm: '仿真设置作息',
  simLifeThread: '生活线与追番动态',
  simQzoneInteract: '仿真 QQ 空间互动',
  simCollectSticker: '仿真收藏表情',
  simShareVideoCard: '仿真分享视频卡片',
  simCharacterMemory: '角色记忆',
  simGoal: '角色自主目标',
  simWorkspace: '角色作品空间',
  simSubscription: '角色公开订阅',
  simSharedSelf: '跨群共享偏好',
  simWorkerTask: '外部工作器',
}))

export function describeFeatureSwitches(policy: Required<AgentFeatureSwitches>, names: readonly string[]) {
  const tools = new Set([...toolLabels.keys(), ...names, ...Object.keys(policy.tools)])
  return [
    ...Object.entries(agentFeatures).map(([name, label]) => ({ kind: 'features', name, label })),
    ...[...tools].map(name => ({ kind: 'tools', name, label: toolLabels.get(name) ?? name })),
  ]
}

export function writeFeatureSwitches(doc: Document, previous: Required<AgentFeatureSwitches>, next: Required<AgentFeatureSwitches>): number {
  let changed = 0
  if (next.default !== previous.default) {
    doc.setIn(['featureSwitches', 'default'], next.default)
    changed++
  }
  for (const section of ['features', 'tools'] as const) {
    const oldRules = new Map(Object.entries(previous[section])), newRules = next[section]
    for (const name of oldRules.keys()) if (!Object.hasOwn(newRules, name)) {
      doc.deleteIn(['featureSwitches', section, name])
      changed++
    }
    for (const [name, rule] of Object.entries(newRules)) {
      if (!rule || JSON.stringify(rule) === JSON.stringify(oldRules.get(name))) continue
      const path = ['featureSwitches', section, name]
      doc.setIn([...path, 'mode'], rule.mode)
      if (rule.mode === 'groups') doc.setIn([...path, 'groups'], [...rule.groups])
      else doc.deleteIn([...path, 'groups'])
      changed++
    }
  }
  return changed
}
